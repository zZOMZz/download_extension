import { parseBilibiliPlaybackInfoResponse } from '../src/core/site-adapters/bilibili/play-info';
import {
  BILIBILI_PLAYER_ATTRIBUTE,
  BILIBILI_PLAYER_SELECTOR,
  bilibiliPageIdentity,
  bilibiliPlayerStateSchema,
  isBilibiliPlaybackRequest,
} from '../src/core/site-adapters/bilibili/player-state';

const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const POLL_INTERVAL_MS = 500;

interface BilibiliPlayerWindow extends Window {
  __playinfo__?: unknown;
}

/** This bridge observes the player's existing responses; it never requests playback or account data. */
export default defineContentScript({
  // Bilibili can navigate from its home page into a player without replacing the document.
  matches: ['https://www.bilibili.com/*', 'https://m.bilibili.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const playerWindow = window as BilibiliPlayerWindow;
    let active = true;
    let generation = 0;
    let identity = bilibiliPageIdentity(location.href);
    let observedGlobal: unknown;
    let staleGlobal: unknown;
    let timer: number | undefined;
    const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
    const clearPublished = () => document.querySelector(BILIBILI_PLAYER_SELECTOR)?.remove();
    const readGlobal = () => {
      try { return playerWindow.__playinfo__; }
      catch { return undefined; }
    };
    const cancelReaders = () => {
      for (const reader of readers) void reader.cancel().catch(() => {});
      readers.clear();
    };
    const syncNavigation = () => {
      const current = bilibiliPageIdentity(location.href);
      if (current !== identity) {
        generation += 1;
        identity = current;
        staleGlobal = observedGlobal;
        clearPublished();
        cancelReaders();
      }
    };
    const snapshot = () => {
      syncNavigation();
      return active && identity ? { identity, generation, pageUrl: location.href } : undefined;
    };
    type Snapshot = NonNullable<ReturnType<typeof snapshot>>;
    const isCurrent = (captured: Snapshot) => {
      syncNavigation();
      return active && identity === captured.identity && generation === captured.generation;
    };
    const publish = (text: string, captured: Snapshot) => {
      if (!isCurrent(captured) || !document.documentElement || !text ||
          text.length > MAX_RESPONSE_BYTES) return;
      const playback = parseBilibiliPlaybackInfoResponse(text);
      if (!playback || (playback.episodeId && captured.identity.startsWith('ep') &&
          captured.identity !== `ep${playback.episodeId}`)) return;
      const state = bilibiliPlayerStateSchema.safeParse({ pageUrl: captured.pageUrl, playback });
      if (!state.success) return;
      const payload = JSON.stringify(state.data);
      if (payload.length > MAX_RESPONSE_BYTES) return;
      let element = document.querySelector<HTMLElement>(BILIBILI_PLAYER_SELECTOR);
      if (!element) {
        element = document.createElement('div');
        element.hidden = true;
        element.setAttribute(BILIBILI_PLAYER_ATTRIBUTE, '');
        element.textContent = payload;
        document.documentElement.append(element);
      } else if (element.textContent !== payload) {
        element.textContent = payload;
      }
    };
    const boundedJson = (value: unknown): string | undefined => {
      try {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return text && text.length <= MAX_RESPONSE_BYTES &&
          new TextEncoder().encode(text).byteLength <= MAX_RESPONSE_BYTES ? text : undefined;
      } catch { return undefined; }
    };
    const pollGlobal = (force = false) => {
      const captured = snapshot();
      const value = readGlobal();
      const changed = value !== observedGlobal;
      observedGlobal = value;
      if (!captured || value === undefined || value === staleGlobal || (!changed && !force)) return;
      const text = boundedJson(value);
      if (text) publish(text, captured);
    };
    const schedule = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (!active) return;
      pollGlobal();
      timer = window.setTimeout(schedule, POLL_INTERVAL_MS);
    };
    const requestSnapshot = (rawUrl: string) => {
      const captured = snapshot();
      return captured && isBilibiliPlaybackRequest(rawUrl, captured.pageUrl) ? captured : undefined;
    };
    const observeResponse = async (response: Response, captured: Snapshot) => {
      if (!isCurrent(captured) || !response.ok || (response.url &&
          !isBilibiliPlaybackRequest(response.url, captured.pageUrl))) return;
      const length = Number(response.headers.get('Content-Length'));
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return;
      const clone = response.clone();
      const reader = clone.body?.getReader();
      if (!reader) return;
      readers.add(reader);
      const decoder = new TextDecoder();
      let text = '';
      let bytes = 0;
      try {
        while (isCurrent(captured)) {
          const chunk = await reader.read();
          if (chunk.done) {
            publish(text + decoder.decode(), captured);
            return;
          }
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) return;
          text += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        readers.delete(reader);
        // A tee's cancellation may wait for the player's branch; never await it here.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    };

    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = function (this: Window, ...args: Parameters<Window['fetch']>) {
        let captured: ReturnType<typeof snapshot>;
        try {
          const input = args[0];
          captured = requestSnapshot(input instanceof Request ? input.url : String(input));
        } catch { /* Observation must not affect the player's request. */ }
        const pending = Reflect.apply(nativeFetch, this, args) as Promise<Response>;
        if (captured) {
          const start = captured;
          void pending.then((response) => observeResponse(response, start)).catch(() => {});
        }
        return pending;
      };
    }
    const prototype = window.XMLHttpRequest?.prototype;
    if (prototype) {
      const nativeOpen = prototype.open;
      const nativeSend = prototype.send;
      const requests = new WeakMap<XMLHttpRequest, string>();
      prototype.open = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
        const result = Reflect.apply(nativeOpen, this, args);
        try { requests.set(this, String(args[1])); }
        catch { requests.delete(this); }
        return result;
      } as XMLHttpRequest['open'];
      prototype.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
        let captured: ReturnType<typeof snapshot>;
        try {
          const url = requests.get(this);
          captured = url ? requestSnapshot(url) : undefined;
        } catch { /* Observation is best-effort. */ }
        if (captured) {
          const start = captured;
          const loaded = () => {
            try {
              if (!isCurrent(start) || this.status < 200 || this.status >= 300 ||
                  (this.responseURL && !isBilibiliPlaybackRequest(this.responseURL, start.pageUrl))) return;
              const text = this.responseType === 'json' ? boundedJson(this.response) :
                this.responseType === '' || this.responseType === 'text' ? boundedJson(this.responseText) : undefined;
              if (text) publish(text, start);
            } catch { /* Unsupported response types and malformed player data are ignored. */ }
          };
          const cleanup = () => {
            this.removeEventListener('load', loaded);
            this.removeEventListener('loadend', cleanup);
          };
          this.addEventListener('load', loaded);
          this.addEventListener('loadend', cleanup);
          try { return Reflect.apply(nativeSend, this, args); }
          catch (cause) { cleanup(); throw cause; }
        }
        return Reflect.apply(nativeSend, this, args);
      };
    }
    for (const method of ['pushState', 'replaceState'] as const) {
      const native = window.history?.[method];
      if (!native) continue;
      window.history[method] = function (this: History, ...args: Parameters<History[typeof method]>) {
        const result = Reflect.apply(native, this, args);
        syncNavigation();
        return result;
      };
    }
    window.addEventListener('popstate', syncNavigation);
    document.addEventListener('DOMContentLoaded', () => pollGlobal(true));
    window.addEventListener('pagehide', () => {
      active = false;
      generation += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      cancelReaders();
      clearPublished();
    });
    window.addEventListener('pageshow', () => {
      active = true;
      pollGlobal(true);
      schedule();
    });
    schedule();
  },
});
