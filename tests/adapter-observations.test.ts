import { describe, expect, it, vi } from 'vitest';
import { createAdapterObservationReporter } from '../src/core/detection/adapter-observations';
import type { CandidateObservation } from '../src/shared/media';

const pageUrl = 'https://www.youtube.com/watch?v=GwUwyWGHmGY';

function candidate(token = 'first', title = 'Example video'): CandidateObservation {
  return {
    kind: 'dash',
    source: 'dom',
    url: pageUrl,
    title,
    siteAdapterId: 'youtube',
    dash: {
      type: 'static',
      hasContentProtection: false,
      tracks: [{
        id: '137',
        kind: 'video',
        initialization: {
          url: `https://rr1.googlevideo.com/videoplayback?itag=137&sig=${token}`,
          byteRange: { offset: 0, length: 100 },
        },
      }],
    },
  };
}

describe('adapter observations', () => {
  it('suppresses repeated scans but reports changed signed URLs, metadata, and DASH tracks', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const report = createAdapterObservationReporter(send);

    for (let scan = 0; scan < 10; scan += 1) report(pageUrl, [candidate()]);
    expect(send).toHaveBeenCalledTimes(1);

    report(pageUrl, [candidate('refreshed')]);
    report(pageUrl, [candidate('refreshed', 'Updated title')]);
    const withAudio = candidate('refreshed', 'Updated title');
    withAudio.dash!.tracks.push({
      id: '140',
      kind: 'audio',
      initialization: { url: 'https://rr2.googlevideo.com/videoplayback?itag=140&sig=audio' },
    });
    report(pageUrl, [withAudio]);
    report(pageUrl, [withAudio]);

    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenLastCalledWith(withAudio);
  });

  it('reports a page again after navigating away, including a page without candidates', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const report = createAdapterObservationReporter(send);
    report(pageUrl, [candidate()]);
    report('https://www.youtube.com/', []);
    report(pageUrl, [candidate()]);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps progressive and Bilibili candidates supported', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const report = createAdapterObservationReporter(send);
    const progressive: CandidateObservation = {
      kind: 'progressive', source: 'dom', url: 'https://rr1.googlevideo.com/videoplayback?itag=18',
    };
    report(pageUrl, [progressive]);
    report(pageUrl, [{ ...progressive, contentLength: 1000 }]);
    const bilibili = { ...candidate(), url: 'https://www.bilibili.com/video/BV123', siteAdapterId: 'bilibili' };
    report(bilibili.url, [bilibili]);
    report(bilibili.url, [bilibili]);

    expect(send).toHaveBeenCalledTimes(3);
  });

  it('retries a failed send on the next scan', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('Background unavailable')).mockResolvedValue(undefined);
    const report = createAdapterObservationReporter(send);
    report(pageUrl, [candidate()]);
    await Promise.resolve();
    report(pageUrl, [candidate()]);
    report(pageUrl, [candidate()]);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not discard a newer observation when an older send rejects', async () => {
    let rejectOlder!: (reason: Error) => void;
    const send = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectOlder = reject; }))
      .mockResolvedValue(undefined);
    const report = createAdapterObservationReporter(send);
    report(pageUrl, [candidate()]);
    report(pageUrl, [candidate('refreshed')]);
    rejectOlder(new Error('Stale send failed'));
    await Promise.resolve();
    report(pageUrl, [candidate('refreshed')]);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps the new visit deduplicated when a previous visit send rejects', async () => {
    let rejectOlder!: (reason: Error) => void;
    const send = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectOlder = reject; }))
      .mockResolvedValue(undefined);
    const report = createAdapterObservationReporter(send);
    report(pageUrl, [candidate()]);
    report('https://www.youtube.com/', []);
    report(pageUrl, [candidate()]);
    rejectOlder(new Error('Previous page send failed'));
    await Promise.resolve();
    report(pageUrl, [candidate()]);

    expect(send).toHaveBeenCalledTimes(2);
  });
});
