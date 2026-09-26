import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidateObservation } from '../src/shared/media';

const storage = vi.hoisted(() => new Map<string, unknown>());

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        }),
        remove: vi.fn(async (key: string) => { storage.delete(key); }),
      },
    },
  },
}));

// Resolve WXT aliases to the real implementations used by the repository.
vi.mock('~/src/shared/media', () => import('../src/shared/media'));
vi.mock('~/src/core/detection/filter-candidate', () => import('../src/core/detection/filter-candidate'));

import { listCandidates, upsertCandidate } from '../src/background/candidate-repository';

const pageUrl = 'https://www.youtube.com/watch?v=GwUwyWGHmGY';

function youtubeProgressive(overrides: Partial<CandidateObservation> = {}): CandidateObservation {
  return {
    kind: 'progressive',
    source: 'dom',
    siteAdapterId: 'youtube',
    sourcePageUrl: pageUrl,
    url: 'https://rr1.googlevideo.com/videoplayback?itag=18&sig=first',
    title: 'Example video',
    ...overrides,
  };
}

beforeEach(() => {
  storage.clear();
});

describe('candidate repository adapter updates', () => {
  it('refreshes signed YouTube URLs while preserving one candidate and its stable ID', async () => {
    await upsertCandidate(1, 0, youtubeProgressive());
    const [first] = await listCandidates(1);
    const refreshed = youtubeProgressive({
      url: 'https://rr2.googlevideo.com/videoplayback?itag=18&sig=refreshed',
      title: 'Updated title',
    });
    await upsertCandidate(1, 0, refreshed);

    const stored = await listCandidates(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      ...refreshed,
      id: first!.id,
      detectedAt: first!.detectedAt,
    });
  });

  it('upgrades a progressive YouTube candidate to DASH without changing its ID', async () => {
    await upsertCandidate(1, 0, youtubeProgressive());
    const [first] = await listCandidates(1);
    const dash: CandidateObservation = {
      kind: 'dash',
      source: 'dom',
      siteAdapterId: 'youtube',
      url: pageUrl,
      title: 'Example video',
      dash: {
        type: 'static',
        hasContentProtection: false,
        tracks: [{
          id: '137',
          kind: 'video',
          initialization: { url: 'https://rr1.googlevideo.com/videoplayback?itag=137&sig=video' },
        }, {
          id: '140',
          kind: 'audio',
          initialization: { url: 'https://rr1.googlevideo.com/videoplayback?itag=140&sig=audio' },
        }],
      },
    };
    await upsertCandidate(1, 0, dash);

    const stored = await listCandidates(1);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ ...dash, id: first!.id, detectedAt: first!.detectedAt });
  });

  it('keeps different YouTube pages distinct even when an observed media URL matches', async () => {
    await upsertCandidate(1, 0, youtubeProgressive());
    await upsertCandidate(1, 0, youtubeProgressive({
      sourcePageUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      title: 'Another video',
    }));

    const stored = await listCandidates(1);
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map(({ id }) => id)).size).toBe(2);
    expect(stored.map(({ sourcePageUrl }) => sourcePageUrl)).toContain(pageUrl);
    expect(stored.map(({ sourcePageUrl }) => sourcePageUrl)).toContain('https://www.youtube.com/watch?v=jNQXAC9IVRw');
  });

  it('preserves generic and Bilibili deduplication by kind and resource URL', async () => {
    const url = 'https://cdn.example/video.mp4';
    const generic: CandidateObservation = { kind: 'progressive', source: 'dom', url };
    await upsertCandidate(1, 0, generic);
    await upsertCandidate(1, 0, { ...generic, title: 'Updated' });
    await upsertCandidate(1, 0, { ...generic, kind: 'dash', siteAdapterId: 'bilibili' });
    await upsertCandidate(1, 0, { ...generic, url: 'https://cdn.example/other.mp4' });

    const stored = await listCandidates(1);
    expect(stored).toHaveLength(3);
    expect(stored.find((item) => item.url === url && item.kind === 'progressive')?.title).toBe('Updated');
  });
});
