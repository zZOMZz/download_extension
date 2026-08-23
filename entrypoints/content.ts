import { browser } from 'wxt/browser';
import { classifyMediaResource } from '~/src/core/detection/classify-media';
import { detectAdapterMedia } from '~/src/core/detection/adapters/registry';
import { discoverMediaItems } from '~/src/core/discovery/registry';
import { pageDiscoveryRequestSchema } from '~/src/shared/discovery';
import type { CandidateObservation } from '~/src/shared/media';

const observed = new Set<string>();
const adapterDetectedPages = new Set<string>();

function reportObservation(candidate: CandidateObservation): void {
  const identity = `${candidate.kind}\u0000${candidate.url}`;
  if (observed.has(identity)) return;
  observed.add(identity);
  void browser.runtime.sendMessage({ type: 'candidate:observe', candidate }).catch(() => {
    observed.delete(identity);
  });
}

function report(rawUrl: string, source: CandidateObservation['source'], mimeType?: string): void {
  const url = rawUrl.trim();
  if (!url) return;

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
  let pageUrl: URL;
  try {
    pageUrl = new URL(location.href);
  } catch {
    return;
  }
  if (adapterDetectedPages.has(pageUrl.href)) return;
  const candidates = detectAdapterMedia(document, pageUrl);
  if (candidates.length) adapterDetectedPages.add(pageUrl.href);
  for (const candidate of candidates) reportObservation(candidate);
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
    browser.runtime.onMessage.addListener(async (message: unknown) => {
      const parsed = pageDiscoveryRequestSchema.safeParse(message);
      if (!parsed.success) return undefined;

      if (document.readyState === 'loading') {
        await new Promise<void>((resolve) => {
          document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
        });
      }
      try {
        return { ok: true, items: discoverMediaItems(document, new URL(location.href)) };
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

      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes' && mutation.target instanceof HTMLMediaElement) {
            scanMediaElements(mutation.target.parentNode ?? document);
          }
          for (const node of mutation.addedNodes) {
            if (node instanceof Element) {
              if (node.matches('video, audio, source')) scanMediaElements(node.parentNode ?? document);
              else scanMediaElements(node);
              if (node.matches('script') || node.querySelector('script')) scanDetectionAdapters();
            }
          }
        }
      }).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['src'],
        childList: true,
        subtree: true,
      });

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) report(entry.name, 'performance');
      }).observe({ type: 'resource', buffered: true });
    };

    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  },
});
