import type { MediaCandidate } from '../../shared/media';

/** A site's playable candidate replaces the same frame's otherwise unusable blob URL. */
export function visibleMediaCandidates(candidates: readonly MediaCandidate[]): MediaCandidate[] {
  const pageSourceFrames = new Set(candidates.filter(candidate => candidate.browserSource).map(candidate => `${candidate.tabId}:${candidate.frameId}`));
  const adaptedFrames = new Set(candidates
    .filter(({ kind, siteAdapterId, hasContentProtection }) =>
      Boolean(siteAdapterId) && (kind !== 'blob' || hasContentProtection))
    .map(({ tabId, frameId }) => `${tabId}:${frameId}`));
  return candidates.filter(candidate => (!pageSourceFrames.has(`${candidate.tabId}:${candidate.frameId}`) || candidate.browserSource) &&
    (candidate.kind !== 'blob' || Boolean(candidate.siteAdapterId) || !adaptedFrames.has(`${candidate.tabId}:${candidate.frameId}`)));
}
