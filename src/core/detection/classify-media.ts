import type { MediaKind } from '../../shared/media';

const HLS_MIME_TYPES = new Set([
  'application/mpegurl',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
]);

const DASH_MIME_TYPES = new Set(['application/dash+xml']);
const PROGRESSIVE_EXTENSIONS = new Set([
  '3g2',
  '3gp',
  'avi',
  'flac',
  'm4a',
  'm4v',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'mpeg',
  'mpg',
  'oga',
  'ogg',
  'ogv',
  'opus',
  'wav',
  'webm',
]);
const SEGMENT_EXTENSIONS = new Set(['aac', 'cmfa', 'cmfv', 'm4s', 'ts']);

export interface ClassifyOptions {
  includeSegments?: boolean;
}

function normalizedMimeType(contentType?: string): string {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function extensionOf(url: URL): string {
  const filename = url.pathname.split('/').at(-1) ?? '';
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export function classifyMediaResource(
  rawUrl: string,
  contentType?: string,
  options: ClassifyOptions = {},
): MediaKind | null {
  if (rawUrl.startsWith('blob:')) return 'blob';

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const mimeType = normalizedMimeType(contentType);
  const extension = extensionOf(url);

  if (extension === 'm3u8' || HLS_MIME_TYPES.has(mimeType)) return 'hls';
  if (extension === 'mpd' || DASH_MIME_TYPES.has(mimeType)) return 'dash';

  if (!options.includeSegments && SEGMENT_EXTENSIONS.has(extension)) return null;
  if (PROGRESSIVE_EXTENSIONS.has(extension)) return 'progressive';
  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) return 'progressive';

  return null;
}

export function isHttpUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
