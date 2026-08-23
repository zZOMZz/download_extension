import { describe, expect, it } from 'vitest';
import { parseAttributeList, parseHlsPlaylist } from '../src/core/protocols/hls';
import { validateHlsDownload } from '../src/core/hls/download-hls';

describe('HLS parser', () => {
  it('parses quoted attribute values containing commas', () => {
    expect(parseAttributeList('BANDWIDTH=2000000,CODECS="avc1.4d401f,mp4a.40.2"')).toEqual({
      BANDWIDTH: '2000000',
      CODECS: 'avc1.4d401f,mp4a.40.2',
    });
  });

  it('parses a master playlist and resolves relative URLs', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="audio"
video/1080.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480
video/480.m3u8`,
      'https://cdn.example/path/master.m3u8',
    );

    expect(playlist.type).toBe('master');
    if (playlist.type !== 'master') return;
    expect(playlist.variants).toHaveLength(2);
    expect(playlist.variants[0]).toMatchObject({
      uri: 'https://cdn.example/path/video/1080.m3u8',
      bandwidth: 3_000_000,
      resolution: { width: 1920, height: 1080 },
      audioGroup: 'audio',
    });
    expect(playlist.renditions[0]?.uri).toBe('https://cdn.example/path/audio/en.m3u8');
  });

  it('parses AES-128, media sequence, maps, and byte ranges', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:42
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0000000000000000000000000000002A
#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"
#EXTINF:6.0,
#EXT-X-BYTERANGE:1000@100
media.mp4
#EXTINF:5.5,
#EXT-X-BYTERANGE:900
media.mp4
#EXT-X-ENDLIST`,
      'https://cdn.example/vod/index.m3u8',
    );

    expect(playlist.type).toBe('media');
    if (playlist.type !== 'media') return;
    expect(playlist.endList).toBe(true);
    expect(playlist.segments[0]).toMatchObject({
      sequence: 42,
      byteRange: { offset: 100, length: 1000 },
      key: { method: 'AES-128', uri: 'https://cdn.example/vod/key.bin', keyFormat: 'identity' },
      map: { uri: 'https://cdn.example/vod/init.mp4', byteRange: { offset: 0, length: 100 } },
    });
    expect(playlist.segments[1]?.byteRange).toEqual({ offset: 1100, length: 900 });
    expect(validateHlsDownload(playlist)).toEqual([]);
  });

  it('flags live and protected playlists before downloading', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="license"
#EXTINF:5,
segment.ts`,
      'https://cdn.example/live/index.m3u8',
    );
    expect(playlist.type).toBe('media');
    if (playlist.type !== 'media') return;
    expect(validateHlsDownload(playlist)).toEqual([
      'Live playlists are not supported yet.',
      'Unsupported or protected encryption: SAMPLE-AES/identity.',
    ]);
  });

  it('rejects non-HLS input', () => {
    expect(() => parseHlsPlaylist('<html></html>', 'https://example.com')).toThrow(/not an HLS/i);
  });
});
