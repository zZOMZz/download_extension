import { bilibiliDetectionAdapter } from './bilibili';
import { youtubeDetectionAdapter } from './youtube';
import { koalaDetectionAdapter } from './koala';
import type { MediaDetectionAdapter, MediaDetectionContext } from './types';

const ADAPTERS: MediaDetectionAdapter[] = [bilibiliDetectionAdapter, youtubeDetectionAdapter, koalaDetectionAdapter];

export function suppressesGenericMedia(rawPageUrl: string): boolean {
  try { const url = new URL(rawPageUrl); return ADAPTERS.some(adapter => adapter.suppressesGenericMedia?.(url)); }
  catch { return false; }
}

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
