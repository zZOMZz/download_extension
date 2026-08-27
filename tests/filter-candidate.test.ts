import { describe, expect, it } from 'vitest';
import {
  MIN_PASSIVE_AUDIO_BYTES,
  shouldIncludeMediaCandidate,
} from '../src/core/detection/filter-candidate';
import type { CandidateObservation } from '../src/shared/media';

function candidate(
  overrides: Partial<CandidateObservation> = {},
): CandidateObservation {
  return {
    kind: 'progressive',
    source: 'network',
    url: 'https://cdn.example/media/video.mp4',
    ...overrides,
  };
}

describe('shouldIncludeMediaCandidate', () => {
  it('filters tiny audio assets discovered passively from the network', () => {
    expect(shouldIncludeMediaCandidate(candidate({
      url: 'https://example.com/search/audio/success.mp3',
      mimeType: 'audio/mpeg; charset=binary',
      contentLength: 6 * 1024,
    }))).toBe(false);
  });

  it('filters audio-only performance entries and lets network evidence restore large files', () => {
    expect(shouldIncludeMediaCandidate(candidate({
      source: 'performance',
      url: 'https://cdn.example/podcast.mp3',
    }))).toBe(false);
    expect(shouldIncludeMediaCandidate(candidate({
      url: 'https://cdn.example/podcast.mp3',
      contentLength: MIN_PASSIVE_AUDIO_BYTES,
    }))).toBe(true);
  });

  it('keeps audio explicitly exposed by a media element even when it is short', () => {
    expect(shouldIncludeMediaCandidate(candidate({
      source: 'dom',
      url: 'https://cdn.example/preview.mp3',
      contentLength: 2 * 1024,
    }))).toBe(true);
  });

  it('keeps video and adaptive-stream candidates unchanged', () => {
    expect(shouldIncludeMediaCandidate(candidate({
      url: 'https://cdn.example/video.mp4',
      mimeType: 'video/mp4',
      contentLength: 5 * 1024,
    }))).toBe(true);
    expect(shouldIncludeMediaCandidate(candidate({
      kind: 'hls',
      url: 'https://cdn.example/master.m3u8',
      mimeType: 'audio/mpegurl',
      contentLength: 512,
    }))).toBe(true);
  });

  it('does not infer audio from an extension when MIME explicitly says video', () => {
    expect(shouldIncludeMediaCandidate(candidate({
      url: 'https://cdn.example/unusual.m4a',
      mimeType: 'video/mp4',
      contentLength: 5 * 1024,
    }))).toBe(true);
  });
});
