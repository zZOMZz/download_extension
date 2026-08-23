import { bilibiliDetectionAdapter } from './bilibili';
import type { MediaDetectionAdapter } from './types';

const ADAPTERS: MediaDetectionAdapter[] = [bilibiliDetectionAdapter];

export function detectAdapterMedia(document: Document, pageUrl: URL) {
  return ADAPTERS
    .filter((adapter) => adapter.matches(pageUrl))
    .flatMap((adapter) => adapter.detect(document, pageUrl));
}
