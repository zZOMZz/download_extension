import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadDashPlan, downloadDashTrack, type ResolvedDashTrack } from '../src/core/dash/download-dash';
import { downloadHlsPlaylist, estimateRemainingSeconds, type HlsDownloadProgress } from '../src/core/hls/download-hls';
import { NetworkSpeedTracker } from '../src/core/network/speed-tracker';
import { parseHlsPlaylist } from '../src/core/protocols/hls';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('download telemetry across fast segments', () => {
  it('ages throughput out over the window and measures a fresh burst after a stall', () => {
    vi.useFakeTimers();
    const speed = new NetworkSpeedTracker();
    vi.advanceTimersByTime(500);
    speed.record(1_000);
    expect(speed.sample()).toEqual({ current: 2_000, average: 2_000 });
    vi.advanceTimersByTime(500);
    expect(speed.sample()).toEqual({ current: 1_000, average: 1_000 });
    vi.advanceTimersByTime(5_000);
    expect(speed.sample().current).toBe(0);
    vi.advanceTimersByTime(500);
    speed.record(500);
    expect(speed.sample().current).toBe(100);
  });

  it('does not amplify same-millisecond chunks into enormous startup rates', () => {
    vi.useFakeTimers();
    const speed = new NetworkSpeedTracker();
    speed.record(100);
    expect(speed.sample().current).toBe(400);
    speed.record(100);
    expect(speed.sample().current).toBe(800);
  });

  it('keeps ETA continuous when a received segment becomes committed', () => {
    const progress: HlsDownloadProgress = {
      completedSegments: 1, totalSegments: 10, bytesWritten: 1_000,
      currentSegment: 2, currentSegmentBytesReceived: 1_000,
      currentSpeedBytesPerSecond: 1_000,
    };
    expect(estimateRemainingSeconds(progress)).toBe(8);
    expect(estimateRemainingSeconds({ ...progress, completedSegments: 2, bytesWritten: 2_000 })).toBe(8);
    expect(estimateRemainingSeconds({ ...progress, phase: 'completed' })).toBeUndefined();
  });

  for (const engine of ['DASH plan', 'DASH track', 'HLS'] as const) {
    it(`${engine} keeps rates through segment boundaries, reaches zero during a stall, and stops its timer`, async () => {
      vi.useFakeTimers();
      const events: HlsDownloadProgress[] = [];
      let release: (() => void) | undefined;
      let segmentRequests = 0;
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes('segment')) {
          segmentRequests += 1;
          if (segmentRequests === 2) await new Promise<void>((resolve) => { release = resolve; });
        }
        return new Response(new Uint8Array(1_000), { headers: { 'Content-Length': '1000' } });
      }));
      const writer = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
      const options = { onProgress: (progress: HlsDownloadProgress) => events.push(progress) };
      const video: ResolvedDashTrack = {
        id: 'v', kind: 'video', initialization: { url: 'https://media.test/init-v' },
        segments: [{ url: 'https://media.test/segment-1' }, { url: 'https://media.test/segment-2' }],
      };
      const audio: ResolvedDashTrack = {
        id: 'a', kind: 'audio', initialization: { url: 'https://media.test/init-a' },
        segments: [{ url: 'https://media.test/segment-3' }],
      };
      const playlist = parseHlsPlaylist('#EXTM3U\n#EXTINF:1,\nsegment-1\n#EXTINF:1,\nsegment-2\n#EXT-X-ENDLIST', 'https://media.test/index.m3u8');
      if (playlist.type !== 'media') throw new Error('Expected media playlist');
      const pending = engine === 'DASH plan'
        ? downloadDashPlan({ video, audio, totalSegments: 3 }, writer, options)
        : engine === 'DASH track' ? downloadDashTrack(video, writer, options)
          : downloadHlsPlaylist(playlist, writer, options);
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toBeTypeOf('function');
      const receiving = events.filter((event) => (event.networkBytesReceived ?? 0) > 0);
      expect(receiving.some((event) => event.phase === 'requesting')).toBe(true);
      expect(receiving.some((event) => event.phase === 'processing')).toBe(true);
      expect(receiving.every((event) => (event.currentSpeedBytesPerSecond ?? 0) > 0)).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(events.at(-1)?.currentSpeedBytesPerSecond).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(events.at(-1)).toMatchObject({ phase: 'requesting', currentSpeedBytesPerSecond: 0 });
      release!();
      await pending;
      expect(events.at(-1)).toMatchObject({ phase: 'completed', currentSpeedBytesPerSecond: 0 });
      expect(events.at(-1)?.estimatedSecondsRemaining).toBeUndefined();
      expect(writer.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });
  }
});
