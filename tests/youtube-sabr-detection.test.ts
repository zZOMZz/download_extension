import { describe, expect, it } from 'vitest';
import { youtubeDetectionAdapter } from '../src/core/detection/adapters/youtube';
import {
  parseYouTubePlayerResponse,
  parseYouTubePlayerResponseDocument,
} from '../src/core/site-adapters/youtube/player-response';
import { candidateIdentity, mediaCandidateSchema } from '../src/shared/media';

const pageUrl = 'https://www.youtube.com/watch?v=jUNz-uTF--E';
const sabrUrl = 'https://rr1.googlevideo.com/videoplayback?id=resource-4k&sabr=1';

function response() {
  return {
    playabilityStatus: { status: 'OK' },
    videoDetails: { videoId: 'jUNz-uTF--E', title: '4K video', lengthSeconds: '120', isLiveContent: false },
    streamingData: {
      serverAbrStreamingUrl: sabrUrl,
      formats: [{
        itag: 18, mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
        url: 'https://rr1.googlevideo.com/videoplayback?id=resource-4k&itag=18', height: 360,
      }],
      adaptiveFormats: [{
        itag: 401, mimeType: 'video/mp4; codecs="av01.0.13M.08"',
        width: 3840, height: 2160, fps: 60, bitrate: 16_000_000,
        averageBitrate: 12_000_000, contentLength: '180000000',
        approxDurationMs: '120000', lastModified: '1750000000000000', xtags: 'v=1',
      }, {
        itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: 128_000, approxDurationMs: '120001', lastModified: '1750000000000001',
        audioTrack: { id: 'en.0', displayName: 'English', audioIsDefault: true },
      }] as Record<string, unknown>[],
    },
  };
}

function script(value = response()): string {
  return `var ytInitialPlayerResponse = ${JSON.stringify(value)};`;
}

function documentWithScripts(...scripts: string[]): Document {
  return {
    querySelectorAll: (selector: string) => selector === 'script'
      ? scripts.map((textContent) => ({ textContent })) : [],
  } as unknown as Document;
}

describe('YouTube SABR detection', () => {
  it('uses the largest real HTTPS thumbnail and leaves absent thumbnails unset', () => {
    const value = response();
    Object.assign(value.videoDetails, { thumbnail: { thumbnails: [
      { url: 'https://i.ytimg.com/vi/jUNz-uTF--E/default.jpg', width: 120, height: 90 },
      { url: 'https://i.ytimg.com/vi/jUNz-uTF--E/hqdefault.jpg', width: 480, height: 360 },
      { url: 'javascript:alert(1)', width: 8192, height: 8192 },
    ] } });
    const candidates = youtubeDetectionAdapter.detect(documentWithScripts(script(value)), new URL(pageUrl));
    expect(candidates[0]?.thumbnailUrl).toBe('https://i.ytimg.com/vi/jUNz-uTF--E/hqdefault.jpg');
    expect(parseYouTubePlayerResponse(script())?.thumbnailUrl).toBeUndefined();
  });

  it('offers URL-less 4K MP4 video and audio ahead of the 360p fallback', () => {
    const candidates = youtubeDetectionAdapter.detect(documentWithScripts(script()), new URL(pageUrl));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: 'sabr', url: pageUrl, sourcePageUrl: pageUrl, siteAdapterId: 'youtube',
      youtubeSabr: {
        videoId: 'jUNz-uTF--E', durationSeconds: 120, serverAbrStreamingUrl: sabrUrl,
        formats: [
          { itag: 401, height: 2160, width: 3840, fps: 60, contentLength: 180_000_000,
            lastModified: '1750000000000000', approxDurationMs: 120_000, xtags: 'v=1' },
          { itag: 140, audioTrack: { id: 'en.0', displayName: 'English', audioIsDefault: true } },
        ],
      },
    });
    expect(mediaCandidateSchema.safeParse({
      ...candidates[0], id: 'candidate', tabId: 1, frameId: 0, detectedAt: 1,
    }).success).toBe(true);
    expect(candidateIdentity(candidates[0]!)).toBe(`youtube\u0000${pageUrl}`);
  });

  it('preserves available resolutions without a 4K ceiling and strips unneeded fields', () => {
    const value = response();
    value.streamingData.adaptiveFormats[0] = {
      ...value.streamingData.adaptiveFormats[0], height: 4320, width: 7680,
      poToken: 'not-exported', unrelatedSessionState: 'not-exported',
    };
    expect(parseYouTubePlayerResponse(script(value))?.youtubeSabr?.formats[0]).toMatchObject({
      height: 4320, width: 7680,
    });
    expect(JSON.stringify(parseYouTubePlayerResponse(script(value))?.youtubeSabr)).not.toContain('not-exported');
  });

  it.each([
    'https://rr1.googlevideo.com.evil.example/videoplayback?id=resource-4k',
    'http://rr1.googlevideo.com/videoplayback?id=resource-4k',
    'https://rr1.googlevideo.com/other?id=resource-4k',
    'https://rr1.googlevideo.com/videoplayback?sabr=1',
  ])('rejects an invalid SABR endpoint while keeping the playable fallback: %s', (url) => {
    const value = response();
    value.streamingData.serverAbrStreamingUrl = url;
    const player = parseYouTubePlayerResponse(script(value));
    expect(player?.youtubeSabr).toBeUndefined();
    expect(player?.progressive).toBeDefined();
  });

  it.each(['UNPLAYABLE', 'LOGIN_REQUIRED'])('does not publish %s SABR media', (status) => {
    const value = response();
    value.playabilityStatus.status = status;
    expect(parseYouTubePlayerResponse(script(value))?.youtubeSabr).toBeUndefined();
  });

  it('does not publish live SABR media', () => {
    const value = response();
    value.videoDetails.isLiveContent = true;
    expect(parseYouTubePlayerResponse(script(value))?.youtubeSabr).toBeUndefined();
  });

  it.each([
    { mimeType: 'video/webm; codecs="vp9"' },
    { drmFamilies: ['WIDEVINE'] },
    { licenseInfos: [{ licenseUrl: 'https://example.com/license' }] },
    { lastModified: undefined },
    { bitrate: -1 },
  ])('requires a complete unprotected MP4 video track: %j', (overrides) => {
    const value = response();
    Object.assign(value.streamingData.adaptiveFormats[0]!, overrides);
    expect(parseYouTubePlayerResponse(script(value))?.youtubeSabr).toBeUndefined();
  });

  it('requires an audio track and uses the video duration when the format omits it', () => {
    const value = response();
    delete value.streamingData.adaptiveFormats[0]!.approxDurationMs;
    expect(parseYouTubePlayerResponse(script(value))?.youtubeSabr?.formats[0]?.approxDurationMs).toBe(120_000);
    value.streamingData.adaptiveFormats.pop();
    expect(parseYouTubePlayerResponse(script(value))?.youtubeSabr).toBeUndefined();
  });

  it('searches other page responses for SABR rather than stopping at a progressive fallback', () => {
    const fallback = response();
    fallback.streamingData.adaptiveFormats = [];
    expect(parseYouTubePlayerResponseDocument(documentWithScripts(script(), script(fallback)))?.youtubeSabr)
      .toBeDefined();
  });

  it('continues to prefer complete MP4 DASH tracks when both paths are available', () => {
    const value = response();
    for (const format of value.streamingData.adaptiveFormats) {
      Object.assign(format, {
        url: `https://rr1.googlevideo.com/videoplayback?id=resource-4k&itag=${format.itag}`,
        initRange: { start: '0', end: '999' }, indexRange: { start: '1000', end: '1199' },
      });
    }
    const candidates = youtubeDetectionAdapter.detect(documentWithScripts(script(value)), new URL(pageUrl));
    expect(candidates[0]?.kind).toBe('dash');
    expect(candidates[0]?.dash?.tracks[0]?.height).toBe(2160);
  });
});
