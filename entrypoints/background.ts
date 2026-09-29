import { browser } from 'wxt/browser';
import { isManagerRuntimeSender } from '~/src/background/runtime-access';
import { koalaVideoId } from '~/src/core/site-adapters/koala/identity';
import { classifyMediaResource, isHttpUrl } from '~/src/core/detection/classify-media';
import { detectionAdapterClaimsResource, suppressesGenericMedia } from '~/src/core/detection/adapters/registry';
import {
  clearCandidates,
  findCandidate,
  listCandidates,
  upsertCandidate,
} from '~/src/background/candidate-repository';
import {
  addDownloadTasks,
  listDownloadTasks,
  removeDownloadTask,
  replaceDownloadTask,
} from '~/src/background/download-task-repository';
import {
  appendTaskDiagnosticEvent,
  listTaskDiagnosticEvents,
  removeTaskDiagnosticEvents,
} from '~/src/background/task-diagnostics-repository';
import {
  acceptYoutubeSabrBridgeRequest,
  captureYoutubeSabrContext,
  clearYoutubeSabrContexts,
  findYoutubeSabrContext,
  isYoutubeSabrContextSender,
} from '~/src/background/youtube-sabr-context';
import { pageDiscoveryResponseSchema } from '~/src/shared/discovery';
import {
  runtimeRequestSchema,
  type AdapterResourceObservation,
} from '~/src/shared/media';
import {
  configureSiteRequestAdapterForTab,
  configureSiteRequestAdaptersForManager,
  removeSiteRequestAdapterForTab,
} from '~/src/browser/request-adapters/registry';

function responseHeader(
  headers: Browser.webRequest.HttpHeader[] | undefined,
  name: string,
): string | undefined {
  return headers
    ?.find((header) => header.name.toLowerCase() === name.toLowerCase())
    ?.value;
}

export default defineBackground(() => {
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.type === 'main_frame' && details.tabId >= 0) {
        void clearCandidates(details.tabId);
        void clearYoutubeSabrContexts(details.tabId).catch(() => {});
      }
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
  );

  browser.webRequest.onBeforeRequest.addListener(
    (details) => { void captureYoutubeSabrContext(details).catch(() => {}); },
    { urls: ['https://*.googlevideo.com/videoplayback*'] },
    ['requestBody'],
  );

  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (details.initiator && suppressesGenericMedia(details.initiator)) return;

      try {
        if (detectionAdapterClaimsResource(new URL(details.url))) {
          void browser.tabs.sendMessage(details.tabId, {
            type: 'adapter:resource-observed',
            url: details.url,
          } satisfies AdapterResourceObservation).catch(() => {});
          return;
        }
      } catch {
        // Continue with generic detection when the resource URL is invalid.
      }

      const mimeType = responseHeader(details.responseHeaders, 'content-type');
      const kind = classifyMediaResource(details.url, mimeType, {
        includeSegments: details.type === 'media',
      });
      if (!kind) return;

      const rawLength = responseHeader(details.responseHeaders, 'content-length');
      const parsedLength = rawLength ? Number.parseInt(rawLength, 10) : Number.NaN;

      void upsertCandidate(details.tabId, details.frameId, {
        kind,
        source: 'network',
        url: details.url,
        ...(mimeType ? { mimeType } : {}),
        ...(Number.isFinite(parsedLength) ? { contentLength: parsedLength } : {}),
      });
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
    ['responseHeaders'],
  );

  browser.tabs.onRemoved.addListener((tabId) => {
    void clearCandidates(tabId);
    void clearYoutubeSabrContexts(tabId).catch(() => {});
    void removeSiteRequestAdapterForTab(tabId);
  });

  browser.runtime.onMessage.addListener(async (message: unknown, sender) => {
    const parsed = runtimeRequestSchema.safeParse(message);
    if (!parsed.success) return undefined;

    const request = parsed.data;
    if (request.type.startsWith('task:') && !isManagerRuntimeSender(
      sender, browser.runtime.id, browser.runtime.getURL('/manager.html'),
    )) return { ok: false, error: 'Task storage is only available to the trusted manager runtime.' };
    switch (request.type) {
      case 'browser-source:relay': {
        if (!isManagerRuntimeSender(sender, browser.runtime.id, browser.runtime.getURL('/manager.html'))) return { ok: false, error: 'browserSourceUnavailable' };
        try {
          const tab = await browser.tabs.get(request.sourceTabId);
          if (!tab.url || !koalaVideoId(tab.url)) return { ok: false, error: 'browserSourceUnavailable' };
          return await browser.tabs.sendMessage(request.sourceTabId, {
            type: 'browser-source:rpc', owner: sender.tab!.id!, command: request.command,
          }, { frameId: 0 });
        } catch { return { ok: false, error: 'browserSourceUnavailable' }; }
      }
      case 'youtube-sabr:observe':
        return { ok: await acceptYoutubeSabrBridgeRequest(request, sender, browser.runtime.id) };
      case 'candidate:observe': {
        const tabId = sender.tab?.id;
        if (tabId === undefined) return { ok: false, error: 'Missing sender tab.' };
        await upsertCandidate(tabId, sender.frameId ?? 0, request.candidate);
        return { ok: true };
      }
      case 'candidate:list':
        return { ok: true, candidates: await listCandidates(request.tabId) };
      case 'candidate:clear':
        await clearCandidates(request.tabId);
        return { ok: true };
      case 'download:direct': {
        const candidate = await findCandidate(request.tabId, request.candidateId);
        if (!candidate || candidate.kind !== 'progressive' || !isHttpUrl(candidate.url)) {
          return { ok: false, error: 'This media cannot be downloaded directly.' };
        }
        const downloadId = await browser.downloads.download({
          url: candidate.url,
          saveAs: true,
        });
        return { ok: true, downloadId };
      }
      case 'downloader:open': {
        const candidate = await findCandidate(request.tabId, request.candidateId);
        if (candidate?.browserSource) {
          const pageUrl = new URL(browser.runtime.getURL('/manager.html'));
          pageUrl.searchParams.set('tabId', String(request.tabId));
          pageUrl.searchParams.set('itemId', `koala:${candidate.browserSource.mediaId}`);
          await browser.tabs.create({ url: pageUrl.href });
          return { ok: true };
        }
        const pageUrl = new URL(browser.runtime.getURL('/downloader.html'));
        pageUrl.searchParams.set('tabId', String(request.tabId));
        pageUrl.searchParams.set('candidateId', request.candidateId);
        if (request.videoTrackId) pageUrl.searchParams.set('videoTrackId', request.videoTrackId);
        await browser.tabs.create({ url: pageUrl.href });
        return { ok: true };
      }
      case 'request-adapter:configure': {
        const downloaderTabId = sender.tab?.id;
        const downloaderUrl = browser.runtime.getURL('/downloader.html');
        if (downloaderTabId === undefined || !sender.url?.startsWith(downloaderUrl)) {
          return { ok: false, error: 'A request adapter can only be configured by the downloader page.' };
        }
        const candidate = await findCandidate(request.sourceTabId, request.candidateId);
        if (!candidate) return { ok: false, error: 'The media candidate has expired.' };
        await configureSiteRequestAdapterForTab(candidate, downloaderTabId);
        return { ok: true };
      }
      case 'youtube-sabr:context': {
        if (!isYoutubeSabrContextSender(
          sender,
          browser.runtime.id,
          browser.runtime.getURL('/downloader.html'),
        )) {
          return { ok: false, error: 'YouTube playback context is only available to the downloader page.' };
        }
        const candidate = await findCandidate(request.sourceTabId, request.candidateId);
        if (candidate?.siteAdapterId !== 'youtube' || !candidate.youtubeSabr) {
          return { ok: false, error: 'The YouTube media candidate has expired.' };
        }
        const context = await findYoutubeSabrContext(
          request.sourceTabId,
          candidate.youtubeSabr.serverAbrStreamingUrl,
        );
        if (!context) {
          return { ok: false, error: 'The YouTube playback session is unavailable or expired. Refresh the source video page, play the video briefly, then retry the download.' };
        }
        return { ok: true, context };
      }
      case 'request-adapter:configure-manager': {
        const managerTabId = sender.tab?.id;
        const managerUrl = browser.runtime.getURL('/manager.html');
        if (managerTabId === undefined || !sender.url?.startsWith(managerUrl)) {
          return { ok: false, error: 'Task request adapters can only be configured by the manager page.' };
        }
        await configureSiteRequestAdaptersForManager(request.adapterIds, managerTabId);
        return { ok: true };
      }
      case 'manager:open': {
        const pageUrl = new URL(browser.runtime.getURL('/manager.html'));
        if (request.tabId !== undefined) pageUrl.searchParams.set('tabId', String(request.tabId));
        await browser.tabs.create({ url: pageUrl.href });
        return { ok: true };
      }
      case 'discovery:scan': {
        try {
          const response: unknown = await browser.tabs.sendMessage(request.tabId, { type: 'page:discover' });
          return pageDiscoveryResponseSchema.parse(response);
        } catch (cause) {
          return {
            ok: false,
            error: cause instanceof Error ? cause.message : 'Unable to scan the source page.',
          };
        }
      }
      case 'task:list':
        return { ok: true, tasks: await listDownloadTasks() };
      case 'task:add':
        return { ok: true, tasks: await addDownloadTasks(request.items, request.outputFormat) };
      case 'task:replace':
        return { ok: true, task: await replaceDownloadTask(request.task) };
      case 'task:remove':
        await removeDownloadTask(request.taskId);
        await removeTaskDiagnosticEvents(request.taskId);
        return { ok: true };
      case 'task:diagnostic:add':
        await appendTaskDiagnosticEvent(request.event);
        return { ok: true };
      case 'task:diagnostic:list':
        return { ok: true, events: await listTaskDiagnosticEvents(request.taskId) };
    }
  });
});
