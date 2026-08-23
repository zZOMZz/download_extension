import { findHlsAes128KeyAdapter } from './adapters/registry';
import type { HlsSiteAdapter, TextResourceLoader } from './adapters/types';

export type { TextResourceLoader } from './adapters/types';

export interface HlsAes128KeyResolution {
  downloadedBytes: Uint8Array;
  keyUri: string;
  loadText: TextResourceLoader;
  signal?: AbortSignal;
  adapters?: readonly HlsSiteAdapter[];
}

export async function resolveHlsAes128Key({
  downloadedBytes,
  keyUri,
  loadText,
  signal,
  adapters,
}: HlsAes128KeyResolution): Promise<Uint8Array> {
  if (downloadedBytes.byteLength === 16) return downloadedBytes;

  let parsedUri: URL;
  try {
    parsedUri = new URL(keyUri);
  } catch {
    return downloadedBytes;
  }

  const adapter = adapters
    ? findHlsAes128KeyAdapter({ resourceUrl: parsedUri }, adapters)
    : findHlsAes128KeyAdapter({ resourceUrl: parsedUri });
  if (!adapter) return downloadedBytes;

  return adapter.resolveAes128Key({
    downloadedBytes,
    keyUri: parsedUri,
    loadText,
    ...(signal ? { signal } : {}),
  });
}
