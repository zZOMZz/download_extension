import { browser } from 'wxt/browser';
import { z } from 'zod';
import type { MediaSourceProvider, MediaSourceSession } from '../runtime/media-source';
import { RuntimeError, type RuntimeErrorCode } from '../runtime/errors';
import { koalaVideoId } from '../core/site-adapters/koala/identity';
import { browserSourcePlanSchema, browserSourcePollSchema, browserSourceReplySchema, browserSourceStatusSchema,
  SOURCE_CHUNK_BYTES, type BrowserSourceCommand, type BrowserSourceStatus } from '../shared/browser-source';

const sourceErrors = new Set<RuntimeErrorCode>(['browserSourceUnavailable', 'browserSourceBusy', 'browserSourceUnsupported',
  'browserSourceExpired', 'browserSourceNetwork', 'browserSourceIncomplete', 'browserSourceChanged']);
const sourceError = (value: string) => new RuntimeError(sourceErrors.has(value as RuntimeErrorCode) ? value as RuntimeErrorCode : 'browserSourceUnavailable');
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function rpc(tabId: number, command: BrowserSourceCommand): Promise<unknown> {
  let response: unknown;
  try { response = await browser.runtime.sendMessage({ type: 'browser-source:relay', sourceTabId: tabId, command }); }
  catch { throw sourceError('browserSourceUnavailable'); }
  const parsed = browserSourceReplySchema.safeParse(response);
  if (!parsed.success) throw sourceError('browserSourceUnavailable');
  if (!parsed.data.ok) throw sourceError(parsed.data.error);
  return parsed.data.value;
}

/** The extension host owns tab acquisition. The portable runtime never assumes browser APIs. */
export function createBrowserMediaSourceProvider(): MediaSourceProvider {
  return {
    async open(target, startIndex, signal, options): Promise<MediaSourceSession> {
      if (target.providerId !== 'aliplayer' || koalaVideoId(target.pageUrl) !== target.mediaId) throw sourceError('browserSourceUnsupported');
      signal.throwIfAborted();
      const existing = options?.fresh ? undefined : (await browser.tabs.query({ url: 'https://app.koala-oss.club/videos/*' }))
        .filter(tab => tab.id !== undefined && tab.url && koalaVideoId(tab.url) === target.mediaId)
        .sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
      // Establish ownership of a loaded extension tab before navigating it to a source.
      // This also avoids losing document_start observation during immediate tab creation/navigation.
      const bootstrapUrl = browser.runtime.getURL('/source-host.html');
      const tab = existing ?? await browser.tabs.create({ url: bootstrapUrl, active: false });
      const tabId = tab.id; if (tabId === undefined) throw sourceError('browserSourceUnavailable');
      const owned = !existing;
      let sessionId: string | undefined;
      let closed = false;
      const close = async () => {
        if (closed) return; closed = true;
        if (sessionId) await rpc(tabId, { method: 'close', sessionId }).catch(() => {});
        if (owned) await browser.tabs.remove(tabId).catch(() => {});
      };
      try {
        if (owned) {
          const deadline = Date.now() + 10_000;
          while (true) {
            signal.throwIfAborted();
            const state = await browser.tabs.get(tabId);
            if (state.status === 'complete' && state.url === bootstrapUrl) break;
            if (Date.now() > deadline) throw sourceError('browserSourceUnavailable');
            await delay(100, signal);
          }
          await browser.tabs.update(tabId, { url: target.pageUrl });
        }
        const deadline = Date.now() + 40_000;
        let lastStatus: BrowserSourceStatus | undefined;
        let bridgeError = 'bridge-unavailable';
        while (true) {
          signal.throwIfAborted();
          let ready = false;
          try {
            const status = browserSourceStatusSchema.parse(await rpc(tabId, { method: 'prepare', mediaId: target.mediaId }));
            lastStatus = status; bridgeError = '';
            if (status.mediaId === target.mediaId && status.state === 'protected') throw sourceError('browserSourceUnsupported');
            ready = status.mediaId === target.mediaId && status.state === 'ready';
          } catch (cause) {
            if (cause instanceof RuntimeError && cause.code === 'browserSourceUnsupported') throw cause;
            bridgeError = cause instanceof RuntimeError ? cause.code : 'invalid-status';
          }
          if (ready) break;
          if (Date.now() >= deadline) throw new RuntimeError('browserSourceUnavailable', {
            stage: 'prepare', reason: bridgeError || lastStatus?.reason || 'player-not-ready',
            observedInstances: lastStatus?.observedInstances ?? 0,
            attachedInstances: lastStatus?.attachedInstances ?? 0,
            mediaReadyState: lastStatus?.mediaReadyState ?? 0,
          });
          await delay(500, signal);
        }
        const plan = browserSourcePlanSchema.parse(await rpc(tabId, { method: 'open', mediaId: target.mediaId, startIndex }));
        sessionId = plan.sessionId;
        signal.throwIfAborted();
        return {
          plan,
          async process(index, onProgress, requestSignal) {
            requestSignal.throwIfAborted();
            await rpc(tabId, { method: 'process', sessionId: plan.sessionId, index });
            while (true) {
              requestSignal.throwIfAborted();
              const state = browserSourcePollSchema.parse(await rpc(tabId, { method: 'poll', sessionId: plan.sessionId }));
              if (state.state === 'failed') throw sourceError(state.error ?? 'browserSourceIncomplete');
              if (state.state === 'ready') {
                if (!state.result || state.result.index !== index) throw sourceError('browserSourceChanged');
                onProgress(state.networkBytes, 'processing'); return state.result;
              }
              onProgress(state.networkBytes, state.state === 'downloading' ? 'downloading' : state.state === 'processing' ? 'processing' : 'requesting');
              await delay(250, requestSignal);
            }
          },
          async read(track, part, offset, length, requestSignal) {
            requestSignal.throwIfAborted();
            if (length > SOURCE_CHUNK_BYTES) throw sourceError('browserSourceUnsupported');
            const data = z.object({ base64: z.string().max(SOURCE_CHUNK_BYTES * 2), length: z.number().int() })
              .parse(await rpc(tabId, { method: 'read', sessionId: plan.sessionId, track, part, offset, length }));
            const binary = atob(data.base64);
            if (binary.length !== length || data.length !== length) throw sourceError('browserSourceIncomplete');
            return Uint8Array.from(binary, value => value.charCodeAt(0));
          },
          async acknowledge(index, requestSignal) {
            requestSignal.throwIfAborted(); await rpc(tabId, { method: 'ack', sessionId: plan.sessionId, index });
          },
          close,
        };
      } catch (cause) {
        await close();
        if (!owned && !signal.aborted && cause instanceof RuntimeError && cause.code === 'browserSourceBusy') {
          return createBrowserMediaSourceProvider().open(target, startIndex, signal, { fresh: true });
        }
        throw cause;
      }
    },
  };
}
