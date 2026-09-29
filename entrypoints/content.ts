import { browser } from 'wxt/browser';
import { isBackgroundRuntimeSender } from '~/src/background/runtime-access';
import { requestPageSource } from '~/src/browser/page-source-bridge';
import { browserSourceRpcSchema, BROWSER_SOURCE_STATE_SELECTOR } from '~/src/shared/browser-source';
import { koalaVideoId } from '~/src/core/site-adapters/koala/identity';
import { classifyMediaResource } from '~/src/core/detection/classify-media';
import { createAdapterObservationReporter } from '~/src/core/detection/adapter-observations';
import { readYouTubeSabrRequestMessage } from '~/src/core/site-adapters/youtube/sabr-request-observer';
import {
  detectAdapterMedia,
  detectionAdapterClaimsResource,
  detectionAdapterOwnsResource,
  suppressesGenericMedia,
} from '~/src/core/detection/adapters/registry';
import { discoverMediaItems } from '~/src/core/discovery/registry';
import { pageDiscoveryRequestSchema } from '~/src/shared/discovery';
import {
  adapterResourceObservationSchema,
  type CandidateObservation,
} from '~/src/shared/media';

const observed = new Set<string>();
const reportAdapterObservations = createAdapterObservationReporter((candidate) =>
  browser.runtime.sendMessage({ type: 'candidate:observe', candidate }));
const adapterObservedResources = new Set<string>();
const MAX_ADAPTER_RESOURCE_URLS = 256;
const ADAPTER_STATE_SELECTOR = `script, [data-open-media-downloader-youtube-player], [data-open-media-downloader-bilibili-player], ${BROWSER_SOURCE_STATE_SELECTOR}`;
let adapterResourcePage = location.href;

function refreshAdapterResourcePage(): void {
  if (adapterResourcePage === location.href) return;
  adapterResourcePage = location.href;
  adapterObservedResources.clear();
}

function rememberAdapterResource(rawUrl: string): void {
  refreshAdapterResourcePage();
  adapterObservedResources.delete(rawUrl);
  adapterObservedResources.add(rawUrl);
  while (adapterObservedResources.size > MAX_ADAPTER_RESOURCE_URLS) {
    const oldest = adapterObservedResources.values().next().value as string | undefined;
    if (oldest === undefined) break;
    adapterObservedResources.delete(oldest);
  }
}

function reportObservation(candidate: CandidateObservation): void {
  const identity = `${candidate.kind}\u0000${candidate.url}`;
  if (observed.has(identity)) return;
  observed.add(identity);
  void browser.runtime.sendMessage({ type: 'candidate:observe', candidate }).catch(() => {
    observed.delete(identity);
  });
}

function report(rawUrl: string, source: CandidateObservation['source'], mimeType?: string): void {
  if (suppressesGenericMedia(location.href)) return;
  const url = rawUrl.trim();
  if (!url) return;

  try {
    const resourceUrl = new URL(url);
    if (detectionAdapterClaimsResource(resourceUrl)) {
      if (detectionAdapterOwnsResource(resourceUrl, new URL(location.href))) {
        rememberAdapterResource(url);
      }
      return;
    }
  } catch {
    // Invalid resources are ignored by the generic classifier below as well.
  }

  const kind = classifyMediaResource(url, mimeType, { includeSegments: source === 'dom' });
  if (!kind) return;

  const candidate: CandidateObservation = {
    kind,
    source,
    url,
    ...(document.title ? { title: document.title } : {}),
    ...(mimeType ? { mimeType } : {}),
  };

  reportObservation(candidate);
}

function scanDetectionAdapters(): void {
  refreshAdapterResourcePage();
  let pageUrl: URL;
  try {
    pageUrl = new URL(location.href);
  } catch {
    return;
  }
  const candidates = detectAdapterMedia(document, pageUrl, {
    observedResourceUrls: [...adapterObservedResources],
  });
  reportAdapterObservations(pageUrl.href, candidates);
}

function scanMediaElements(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLMediaElement>('video, audio')) {
    if (element.currentSrc) report(element.currentSrc, 'dom', element.getAttribute('type') ?? undefined);
    if (element.src) report(element.src, 'dom', element.getAttribute('type') ?? undefined);
    for (const source of element.querySelectorAll<HTMLSourceElement>('source[src]')) {
      report(source.src, 'dom', source.type || undefined);
    }
  }
}

function scanPerformanceEntries(): void {
  for (const entry of performance.getEntriesByType('resource')) {
    report(entry.name, 'performance');
  }
}

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_start',
  main() {
    window.addEventListener('message', (event) => {
      const observation = readYouTubeSabrRequestMessage(event, window, location.href);
      if (observation) {
        void browser.runtime.sendMessage({ type: 'youtube-sabr:observe', ...observation }).catch(() => {});
      }
    });
    browser.runtime.onMessage.addListener(async (message: unknown, sender) => {
      const sourceRequest = browserSourceRpcSchema.safeParse(message);
      if (sourceRequest.success) {
        if (!koalaVideoId(location.href) || !isBackgroundRuntimeSender(sender, browser.runtime.id, browser.runtime.getURL('/background.js'))) {
          return { ok: false, error: 'browserSourceUnavailable' };
        }
        try { return await requestPageSource(sourceRequest.data.command, sourceRequest.data.owner); }
        catch { return { ok: false, error: 'browserSourceUnavailable' }; }
      }
      const resourceObservation = adapterResourceObservationSchema.safeParse(message);
      if (resourceObservation.success) {
        rememberAdapterResource(resourceObservation.data.url);
        scanDetectionAdapters();
        return undefined;
      }
      const parsed = pageDiscoveryRequestSchema.safeParse(message);
      if (!parsed.success) return undefined;

      if (document.readyState === 'loading') {
        await new Promise<void>((resolve) => {
          document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
        });
      }
      try {
        return {
          ok: true,
          items: await discoverMediaItems(document, new URL(location.href), {
            fetchText: async (url, signal) => {
              const response = await fetch(url, {
                credentials: 'include',
                ...(signal ? { signal } : {}),
              });
              if (!response.ok) throw new Error(`Discovery request failed with HTTP ${response.status}.`);
              return response.text();
            },
          }),
        };
      } catch (cause) {
        return {
          ok: false,
          error: cause instanceof Error ? cause.message : 'Unable to discover media on this page.',
        };
      }
    });

    const start = () => {
      scanMediaElements();
      scanPerformanceEntries();
      scanDetectionAdapters();

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scanDetectionAdapters, { once: true });
      }
      document.addEventListener('yt-navigate-finish', scanDetectionAdapters);
      window.addEventListener('popstate', scanDetectionAdapters);

      new MutationObserver((mutations) => {
        let adapterStateChanged = false;
        for (const mutation of mutations) {
          if (mutation.target instanceof Element && mutation.target.matches(ADAPTER_STATE_SELECTOR)) {
            adapterStateChanged = true;
          }
          if (mutation.type === 'attributes' && mutation.target instanceof HTMLMediaElement) {
            scanMediaElements(mutation.target.parentNode ?? document);
          }
          for (const node of mutation.addedNodes) {
            if (node instanceof Element) {
              if (node.matches('video, audio, source')) scanMediaElements(node.parentNode ?? document);
              else scanMediaElements(node);
              if (node.matches(ADAPTER_STATE_SELECTOR) || node.querySelector(ADAPTER_STATE_SELECTOR)) {
                adapterStateChanged = true;
              }
            }
          }
        }
        if (adapterStateChanged) scanDetectionAdapters();
      }).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['src'],
        childList: true,
        subtree: true,
      });

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) report(entry.name, 'performance');
        scanDetectionAdapters();
      }).observe({ type: 'resource', buffered: true });
    };

    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  },
});
