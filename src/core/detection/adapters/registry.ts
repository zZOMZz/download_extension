import { bilibiliDetectionAdapter } from './bilibili';
import { youtubeDetectionAdapter } from './youtube';
import type { MediaDetectionAdapter } from './types';

const ADAPTERS: MediaDetectionAdapter[] = [bilibiliDetectionAdapter, youtubeDetectionAdapter];

export function detectAdapterMedia(document: Document, pageUrl: URL) {
  return ADAPTERS
    .filter((adapter) => adapter.matches(pageUrl))
    .flatMap((adapter) => adapter.detect(document, pageUrl));
}

export function detectionAdapterOwnsResource(resourceUrl: URL, pageUrl: URL): boolean {
  return ADAPTERS.some((adapter) =>
    adapter.matches(pageUrl) && adapter.ownsResource?.(resourceUrl, pageUrl));
}
