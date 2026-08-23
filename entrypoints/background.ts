import { browser } from 'wxt/browser';
import { classifyMediaResource, isHttpUrl } from '~/src/core/detection/classify-media';
import {
  clearCandidates,
  findCandidate,
  listCandidates,
  upsertCandidate,
} from '~/src/background/candidate-repository';
import {
  addDownloadTasks,
  clearCompletedDownloadTasks,
  listDownloadTasks,
  removeDownloadTask,
  replaceDownloadTask,
} from '~/src/background/download-task-repository';
import {
  appendTaskDiagnosticEvent,
  listTaskDiagnosticEvents,
  removeTaskDiagnosticEvents,
} from '~/src/background/task-diagnostics-repository';
import { pageDiscoveryResponseSchema } from '~/src/shared/discovery';
import { runtimeRequestSchema } from '~/src/shared/media';

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
      }
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
  );

  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId < 0) return;

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
  });

  browser.runtime.onMessage.addListener(async (message: unknown, sender) => {
    const parsed = runtimeRequestSchema.safeParse(message);
    if (!parsed.success) return undefined;

    const request = parsed.data;
    switch (request.type) {
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
        const pageUrl = new URL(browser.runtime.getURL('/downloader.html'));
        pageUrl.searchParams.set('tabId', String(request.tabId));
        pageUrl.searchParams.set('candidateId', request.candidateId);
        await browser.tabs.create({ url: pageUrl.href });
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
      case 'task:clear-completed': {
        const completedTaskIds = (await listDownloadTasks())
          .filter(({ status }) => status === 'completed')
          .map(({ id }) => id);
        await clearCompletedDownloadTasks();
        await Promise.all(completedTaskIds.map((taskId) => removeTaskDiagnosticEvents(taskId)));
        return { ok: true };
      }
      case 'task:diagnostic:add':
        await appendTaskDiagnosticEvent(request.event);
        return { ok: true };
      case 'task:diagnostic:list':
        return { ok: true, events: await listTaskDiagnosticEvents(request.taskId) };
    }
  });
});
