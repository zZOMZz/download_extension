import type { MediaCandidate } from '../../shared/media';

/** A site's playable candidate replaces the same frame's otherwise unusable blob URL. */
export function visibleMediaCandidates(candidates: readonly MediaCandidate[]): MediaCandidate[] {
  const adaptedFrames = new Set(candidates
    .filter(({ kind, siteAdapterId }) => kind !== 'blob' && Boolean(siteAdapterId))
    .map(({ tabId, frameId }) => `${tabId}:${frameId}`));
  return candidates.filter((candidate) => candidate.kind !== 'blob' ||
    Boolean(candidate.siteAdapterId) || !adaptedFrames.has(`${candidate.tabId}:${candidate.frameId}`));
}
