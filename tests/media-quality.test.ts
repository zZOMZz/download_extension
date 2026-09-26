import { describe, expect, it } from 'vitest';
import { candidateVideoQualities, selectedVideoQuality, videoQualityLabel } from '../src/core/media-quality';
import { runtimeRequestSchema, type MediaCandidate, type YouTubeSabrFormat } from '../src/shared/media';

function format(itag: number, height: number, bitrate: number): YouTubeSabrFormat {
  return { itag, height, width: Math.round(height * 16 / 9), bitrate,
    mimeType: 'video/mp4; codecs="av01.0.08M.08"', lastModified: '1750000000000000', approxDurationMs: 120_000 };
}

function source(formats: YouTubeSabrFormat[]): Pick<MediaCandidate, 'kind' | 'youtubeSabr'> {
  return { kind: 'sabr', youtubeSabr: { videoId: 'jUNz-uTF--E', durationSeconds: 120,
    serverAbrStreamingUrl: 'https://rr1.googlevideo.com/videoplayback?id=resource&sabr=1', formats } };
}

describe('download resolution choices', () => {
  it('keeps every available resolution and starts with the highest one', () => {
    const heights = [144, 240, 360, 480, 720, 1080, 1440, 2160];
    const options = candidateVideoQualities(source(heights.map((height, index) => format(390 + index, height, height * 1_000))));
    expect(options.map(({ height }) => height)).toEqual([...heights].reverse());
    expect(selectedVideoQuality(options)).toBe('397');
    expect(videoQualityLabel(options[0]!)).toBe('2160p · 4K');
  });

  it('removes duplicate resolutions while retaining the highest actual bitrate', () => {
    const options = candidateVideoQualities(source([
      format(401, 2160, 14_000_000),
      format(701, 2160, 18_000_000),
      format(137, 1080, 4_000_000),
      { ...format(140, 0, 128_000), mimeType: 'audio/mp4; codecs="mp4a.40.2"' },
    ]));
    expect(options.map(({ id }) => id)).toEqual(['701', '137']);
  });

  it('preserves the chosen lower resolution across the popup-to-downloader action', () => {
    const options = candidateVideoQualities(source([format(401, 2160, 14_000_000), format(395, 480, 800_000)]));
    const request = runtimeRequestSchema.parse({
      type: 'downloader:open', tabId: 42, candidateId: 'current-video',
      videoTrackId: selectedVideoQuality(options, '395'),
    });
    expect(request).toMatchObject({ type: 'downloader:open', videoTrackId: '395' });
    expect(selectedVideoQuality(options, 'expired-track')).toBe('401');
  });

  it('selects the highest DASH resolution independently of the engine codec preference', () => {
    const options = candidateVideoQualities({ kind: 'dash', dash: { type: 'static', hasContentProtection: false, tracks: [
      { id: 'avc1080', kind: 'video', height: 1080, codecs: 'avc1', initialization: { url: 'https://example.com/1080' } },
      { id: 'av1-4k', kind: 'video', height: 2160, codecs: 'av01', initialization: { url: 'https://example.com/4k' } },
    ] } });
    expect(selectedVideoQuality(options)).toBe('av1-4k');
    expect(selectedVideoQuality(options, 'avc1080')).toBe('avc1080');
  });

  it('provides no resolution control for sites that do not expose resolution metadata', () => {
    expect(candidateVideoQualities({ kind: 'progressive' })).toEqual([]);
    expect(candidateVideoQualities({ kind: 'hls' })).toEqual([]);
    expect(candidateVideoQualities({ kind: 'dash', dash: { type: 'static', hasContentProtection: false, tracks: [
      { id: 'video', kind: 'video', initialization: { url: 'https://example.com/video' } },
    ] } })).toEqual([]);
  });
});
