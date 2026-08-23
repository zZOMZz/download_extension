import { describe, expect, it } from 'vitest';
import { classifyMediaResource, isHttpUrl } from '../src/core/detection/classify-media';

describe('classifyMediaResource', () => {
  it('detects signed HLS and DASH URLs by pathname extension', () => {
    expect(classifyMediaResource('https://cdn.example/video/master.m3u8?token=secret')).toBe('hls');
    expect(classifyMediaResource('https://cdn.example/video/manifest.mpd?expires=1')).toBe('dash');
  });

  it('detects media from content types', () => {
    expect(classifyMediaResource('https://cdn.example/playback?id=1', 'application/vnd.apple.mpegurl')).toBe('hls');
    expect(classifyMediaResource('https://cdn.example/file?id=1', 'video/mp4; charset=binary')).toBe('progressive');
  });

  it('does not flood candidates with streaming segments', () => {
    expect(classifyMediaResource('https://cdn.example/chunk/1.ts', 'video/mp2t')).toBeNull();
    expect(classifyMediaResource('https://cdn.example/chunk/1.ts', 'video/mp2t', { includeSegments: true })).toBe('progressive');
  });

  it('recognizes blob media and rejects unsafe schemes', () => {
    expect(classifyMediaResource('blob:https://example.com/123')).toBe('blob');
    expect(classifyMediaResource('file:///tmp/video.mp4')).toBeNull();
    expect(isHttpUrl('https://example.com/video.mp4')).toBe(true);
    expect(isHttpUrl('blob:https://example.com/123')).toBe(false);
  });
});
