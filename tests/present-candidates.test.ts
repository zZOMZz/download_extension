import { describe, expect, it } from 'vitest';
import { visibleMediaCandidates } from '../src/core/detection/present-candidates';
import type { MediaCandidate } from '../src/shared/media';

function candidate(id: string, overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return { id, kind: 'blob', source: 'dom', url: `blob:https://www.youtube.com/${id}`,
    tabId: 10, frameId: 0, detectedAt: 1, ...overrides };
}

describe('media candidate presentation', () => {
  it('hides a generic blob when the same frame has a downloadable site candidate', () => {
    const blob = candidate('blob');
    const adapted = candidate('adapted', { kind: 'sabr', siteAdapterId: 'youtube' });
    expect(visibleMediaCandidates([blob, adapted])).toEqual([adapted]);
  });

  it('retains blob-only media and does not hide it for an unrelated generic candidate', () => {
    const blob = candidate('blob');
    const generic = candidate('generic', { kind: 'progressive', url: 'https://example.com/clip.mp4' });
    expect(visibleMediaCandidates([blob])).toEqual([blob]);
    expect(visibleMediaCandidates([blob, generic])).toEqual([blob, generic]);
  });

  it('keeps blobs from other frames or tabs visible', () => {
    const sameFrame = candidate('same');
    const otherFrame = candidate('frame', { frameId: 2 });
    const otherTab = candidate('tab', { tabId: 11 });
    const adapted = candidate('adapted', { kind: 'dash', siteAdapterId: 'bilibili' });
    expect(visibleMediaCandidates([sameFrame, otherFrame, otherTab, adapted]))
      .toEqual([otherFrame, otherTab, adapted]);
  });

  it('does not treat another unsupported blob as a downloadable replacement', () => {
    const blob = candidate('blob');
    const adaptedBlob = candidate('adapted-blob', { siteAdapterId: 'youtube' });
    expect(visibleMediaCandidates([blob, adaptedBlob])).toEqual([blob, adaptedBlob]);
  });
});
