import type { CandidateObservation } from '../../shared/media';

const AUDIO_EXTENSIONS = new Set([
  'aac',
  'flac',
  'm4a',
  'mp3',
  'oga',
  'opus',
  'wav',
]);

/**
 * Small sounds loaded by application code are usually interface feedback rather
 * than media the user opened the extension to download. Explicit media elements
 * remain eligible regardless of size.
 */
export const MIN_PASSIVE_AUDIO_BYTES = 128 * 1024;

function normalizedMimeType(contentType?: string): string {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function extensionOf(rawUrl: string): string {
  try {
    const filename = new URL(rawUrl).pathname.split('/').at(-1) ?? '';
    const dot = filename.lastIndexOf('.');
    return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
  } catch {
    return '';
  }
}

function isDefinitelyAudio(candidate: CandidateObservation): boolean {
  const mimeType = normalizedMimeType(candidate.mimeType);
  if (mimeType.startsWith('video/')) return false;
  if (mimeType.startsWith('audio/')) return true;
  return AUDIO_EXTENSIONS.has(extensionOf(candidate.url));
}

export function shouldIncludeMediaCandidate(candidate: CandidateObservation): boolean {
  if (candidate.kind !== 'progressive' || !isDefinitelyAudio(candidate)) return true;

  // A media element is an explicit signal from the page, so even a short clip is useful.
  if (candidate.source === 'dom') return true;

  // Performance entries have no reliable cross-origin size. The corresponding
  // network observation will restore genuine files that are large enough.
  if (candidate.source === 'performance') return false;

  return candidate.contentLength === undefined
    || candidate.contentLength >= MIN_PASSIVE_AUDIO_BYTES;
}
