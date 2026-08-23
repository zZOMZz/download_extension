import { describe, expect, it } from 'vitest';
import { isBilibiliVideoPage, parseBilibiliPlayInfo } from '../src/core/detection/adapters/bilibili';

describe('Bilibili DASH detection adapter', () => {
  it('parses camelCase and snake_case SegmentBase tracks', () => {
    const source = parseBilibiliPlayInfo(`window.__playinfo__={"code":0,"data":{
      "timelength":12500,
      "dash":{"duration":12.5,"video":[{
        "id":80,"baseUrl":"https://cdn.example/video.m4s",
        "backupUrl":["https://backup-1.example/video.m4s","https://backup-2.example/video.m4s"],
        "bandwidth":2000000,
        "mimeType":"video/mp4","codecs":"avc1.640028","width":1920,"height":1080,
        "frameRate":"30000/1001","SegmentBase":{"Initialization":"0-999","indexRange":"1000-1199"}
      }],"audio":[{
        "id":30216,"base_url":"https://cdn.example/audio.m4s","bandwidth":128000,
        "mime_type":"audio/mp4","codecs":"mp4a.40.2",
        "segment_base":{"initialization":"0-799","index_range":"800-999"}
      }]}
    }};`);

    expect(source).toMatchObject({ type: 'static', durationSeconds: 12.5, hasContentProtection: false });
    expect(source?.tracks).toEqual([
      {
        id: '80', kind: 'video', bandwidth: 2_000_000, mimeType: 'video/mp4', codecs: 'avc1.640028',
        width: 1920, height: 1080, frameRate: 30000 / 1001,
        initialization: {
          url: 'https://cdn.example/video.m4s',
          alternativeUrls: ['https://backup-1.example/video.m4s', 'https://backup-2.example/video.m4s'],
          byteRange: { offset: 0, length: 1000 },
        },
        index: {
          url: 'https://cdn.example/video.m4s',
          alternativeUrls: ['https://backup-1.example/video.m4s', 'https://backup-2.example/video.m4s'],
          byteRange: { offset: 1000, length: 200 },
        },
      },
      {
        id: '30216', kind: 'audio', bandwidth: 128_000, mimeType: 'audio/mp4', codecs: 'mp4a.40.2',
        initialization: { url: 'https://cdn.example/audio.m4s', byteRange: { offset: 0, length: 800 } },
        index: { url: 'https://cdn.example/audio.m4s', byteRange: { offset: 800, length: 200 } },
      },
    ]);
  });

  it('does not match lookalike hosts or unrelated Bilibili pages', () => {
    expect(isBilibiliVideoPage(new URL('https://www.bilibili.com/video/BV1test'))).toBe(true);
    expect(isBilibiliVideoPage(new URL('https://www.bilibili.com/bangumi/play/ep1'))).toBe(true);
    expect(isBilibiliVideoPage(new URL('https://evil-bilibili.com/video/BV1test'))).toBe(false);
    expect(isBilibiliVideoPage(new URL('https://www.bilibili.com/v/popular/all'))).toBe(false);
  });

  it('ignores malformed or non-DASH play info', () => {
    expect(parseBilibiliPlayInfo('window.__playinfo__={"data":{}};')).toBeUndefined();
    expect(parseBilibiliPlayInfo('window.__playinfo__={bad json};')).toBeUndefined();
  });
});
