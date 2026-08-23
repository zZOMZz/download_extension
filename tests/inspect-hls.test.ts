import { describe, expect, it, vi } from 'vitest';
import {
  inspectHlsUrl,
  preferredHlsAudioRendition,
} from '../src/core/hls/inspect-hls';
import { combinedHlsMediaPlaylist } from '../src/core/hls/media-bundle';
import { createHlsOutputPlan } from '../src/core/hls/output-plan';
import { parseHlsPlaylist } from '../src/core/protocols/hls';

const MASTER_URL = 'https://cdn.example/show/master.m3u8';

describe('HLS inspection with rendition groups', () => {
  it('loads the default external audio rendition alongside the preferred video variant', async () => {
    const resources = new Map([
      [MASTER_URL, `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="English",LANGUAGE="en",AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",NAME="简体中文",LANGUAGE="zh",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/zh.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,AUDIO="stereo"
video/480.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="stereo"
video/1080.m3u8`],
      ['https://cdn.example/show/video/1080.m3u8', `#EXTM3U
#EXTINF:4,
video-1.ts
#EXTINF:4,
video-2.ts
#EXT-X-ENDLIST`],
      ['https://cdn.example/show/audio/zh.m3u8', `#EXTM3U
#EXT-X-TARGETDURATION:5
#EXTINF:4,
audio-1.ts
#EXT-X-ENDLIST`],
    ]);
    const loadText = vi.fn(async (url: string) => {
      const value = resources.get(url);
      if (!value) throw new Error(`Unexpected URL: ${url}`);
      return value;
    });

    const inspected = await inspectHlsUrl(MASTER_URL, loadText);

    expect(inspected.selectedVariant?.resolution).toEqual({ width: 1920, height: 1080 });
    expect(inspected.selectedAudioRendition).toMatchObject({
      name: '简体中文',
      language: 'zh',
      channels: '2',
      isDefault: true,
      autoSelect: true,
    });
    expect(inspected.audioMedia?.segments).toHaveLength(1);
    expect(loadText).toHaveBeenCalledWith('https://cdn.example/show/audio/zh.m3u8', undefined);

    const combined = combinedHlsMediaPlaylist(inspected);
    expect(combined.segments.map(({ uri }) => uri)).toEqual([
      'https://cdn.example/show/video/video-1.ts',
      'https://cdn.example/show/video/video-2.ts',
      'https://cdn.example/show/audio/audio-1.ts',
    ]);
    expect(combined.targetDuration).toBe(5);
    expect(createHlsOutputPlan(inspected, 'mp4')).toMatchObject({
      extension: 'mp4',
      mimeType: 'video/mp4',
      remuxTs: true,
      resumableTs: true,
      separateAudio: true,
      fragmentedMp4: false,
      videoSegmentCount: 2,
      audioSegmentCount: 1,
    });
  });

  it('falls back to an autoselect audio track when no rendition is marked default', () => {
    const parsed = parseHlsPlaylist(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="First",URI="first.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Auto",AUTOSELECT=YES,URI="auto.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="audio"
video.m3u8`, MASTER_URL);
    if (parsed.type !== 'master') throw new Error('Expected a master playlist.');

    expect(preferredHlsAudioRendition(parsed, parsed.variants[0]!)?.name).toBe('Auto');
  });
});
