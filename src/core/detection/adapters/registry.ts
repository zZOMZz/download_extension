import { bilibiliDetectionAdapter } from './bilibili';
import { youtubeDetectionAdapter } from './youtube';
import type { MediaDetectionAdapter, MediaDetectionContext } from './types';

const ADAPTERS: MediaDetectionAdapter[] = [bilibiliDetectionAdapter, youtubeDetectionAdapter];

export function detectAdapterMedia(
  document: Document,
  pageUrl: URL,
  context?: MediaDetectionContext,
) {
  return ADAPTERS
    .filter((adapter) => adapter.matches(pageUrl))
    .flatMap((adapter) => adapter.detect(document, pageUrl, context));
}

export function detectionAdapterOwnsResource(resourceUrl: URL, pageUrl: URL): boolean {
  return ADAPTERS.some((adapter) =>
    adapter.matches(pageUrl) && adapter.ownsResource?.(resourceUrl, pageUrl));
}

export function detectionAdapterClaimsResource(resourceUrl: URL): boolean {
  return ADAPTERS.some((adapter) => adapter.claimsResource?.(resourceUrl));
}
