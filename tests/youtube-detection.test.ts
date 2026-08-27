import { describe, expect, it } from 'vitest';
import {
  isYouTubeWatchPage,
  isYouTubeUiAudioResource,
  youtubeDetectionAdapter,
  youtubeVideoId,
} from '../src/core/detection/adapters/youtube';
import {
  detectionAdapterClaimsResource,
  detectionAdapterOwnsResource,
} from '../src/core/detection/adapters/registry';
import {
  isGoogleVideoUrl,
  parseYouTubePlayerResponse,
} from '../src/core/site-adapters/youtube/player-response';

const videoBase = 'https://rr1---sn-test.googlevideo.com/videoplayback' +
  '?expire=2000000000&id=video-resource&itag=137&n=untransformed' +
  '&sparams=expire,id,itag,n';
const audioBase = 'https://rr2---sn-test.googlevideo.com/videoplayback' +
  '?expire=2000000000&id=audio-resource&itag=140&n=untransformed' +
  '&sparams=expire,id,itag,n';
const observedVideo = videoBase.replace('n=untransformed', 'n=video-token') +
  '&sig=video-signature&range=0-999&rn=1';
const observedAudio = audioBase.replace('n=untransformed', 'n=audio-token') +
  '&sig=audio-signature&range=0-799&rn=2';

function reusableObservedUrl(rawUrl: string): string {
  return rawUrl.replace(/&range=[^&]*/, '');
}

function playerScript(): string {
  return `var ytInitialPlayerResponse = ${JSON.stringify({
    playabilityStatus: { status: 'OK' },
    videoDetails: {
      videoId: 'GwUwyWGHmGY',
      title: 'Example video',
      lengthSeconds: '125',
      isLiveContent: false,
    },
    streamingData: {
      adaptiveFormats: [
        {
          itag: 137,
          mimeType: 'video/mp4; codecs="avc1.640028"',
          bitrate: 4_000_000,
          width: 1920,
          height: 1080,
          fps: 30,
          initRange: { start: '0', end: '999' },
          indexRange: { start: '1000', end: '1199' },
          url: videoBase,
        },
        {
          itag: 140,
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: 128_000,
          initRange: { start: '0', end: '799' },
          indexRange: { start: '800', end: '999' },
          signatureCipher: new URLSearchParams({
            url: audioBase,
            s: 'ciphered-signature',
            sp: 'sig',
          }).toString(),
        },
        {
          itag: 248,
          mimeType: 'video/webm; codecs="vp9"',
          initRange: { start: '0', end: '99' },
          indexRange: { start: '100', end: '199' },
          url: videoBase.replace('itag=137', 'itag=248'),
        },
      ],
    },
  })};`;
}

function fakeDocument(script: string, observedMediaUrls: string[] = []): Document {
  return {
    querySelectorAll(selector: string) {
      return selector === 'script' ? [{ textContent: script }] : [];
    },
    defaultView: {
      performance: {
        getEntriesByType: () => observedMediaUrls.map((name) => ({ name })),
      },
    },
  } as unknown as Document;
}

function fakeBridgeDocument(responseJson: string, observedMediaUrls: string[]): Document {
  return {
    querySelectorAll(selector: string) {
      return selector === 'script' ? [{
        textContent: responseJson,
        dataset: { openMediaDownloaderYoutubePlayer: '' },
      }] : [];
    },
    defaultView: {
      performance: {
        getEntriesByType: () => observedMediaUrls.map((name) => ({ name })),
      },
    },
  } as unknown as Document;
}

describe('YouTube DASH detection adapter', () => {
  it('combines player metadata with the signed URLs observed during playback', () => {
    const player = parseYouTubePlayerResponse(playerScript(), {
      expectedVideoId: 'GwUwyWGHmGY',
      observedMediaUrls: [observedVideo, observedAudio],
    });

    expect(player).toMatchObject({
      videoId: 'GwUwyWGHmGY',
      title: 'Example video',
      status: 'OK',
      cipheredFormats: 1,
      dash: { type: 'static', durationSeconds: 125, hasContentProtection: false },
    });
    expect(player?.dash?.tracks).toEqual([
      {
        id: '137',
        kind: 'video',
        bandwidth: 4_000_000,
        mimeType: 'video/mp4',
        codecs: 'avc1.640028',
        width: 1920,
        height: 1080,
        frameRate: 30,
        initialization: {
          url: reusableObservedUrl(observedVideo),
          byteRange: { offset: 0, length: 1000 },
        },
        index: {
          url: reusableObservedUrl(observedVideo),
          byteRange: { offset: 1000, length: 200 },
        },
      },
      {
        id: '140',
        kind: 'audio',
        bandwidth: 128_000,
        mimeType: 'audio/mp4',
        codecs: 'mp4a.40.2',
        initialization: {
          url: reusableObservedUrl(observedAudio),
          byteRange: { offset: 0, length: 800 },
        },
        index: {
          url: reusableObservedUrl(observedAudio),
          byteRange: { offset: 800, length: 200 },
        },
      },
    ]);
  });

  it('waits for runtime URLs instead of using ciphered or throttled values directly', () => {
    const player = parseYouTubePlayerResponse(playerScript(), {
      expectedVideoId: 'GwUwyWGHmGY',
    });

    expect(player?.status).toBe('OK');
    expect(player?.cipheredFormats).toBe(1);
    expect(player?.dash).toBeUndefined();
  });

  it('emits one DASH candidate after both MP4 tracks have been observed', () => {
    const pageUrl = new URL('https://www.youtube.com/watch?v=GwUwyWGHmGY');
    expect(youtubeDetectionAdapter.detect(
      fakeDocument(playerScript()),
      pageUrl,
      { observedResourceUrls: [observedVideo, observedAudio] },
    )).toEqual([expect.objectContaining({
      kind: 'dash',
      source: 'dom',
      url: pageUrl.href,
      title: 'Example video',
      siteAdapterId: 'youtube',
      dash: expect.objectContaining({ tracks: expect.arrayContaining([
        expect.objectContaining({ id: '137', kind: 'video' }),
        expect.objectContaining({ id: '140', kind: 'audio' }),
      ]) }),
    })]);
  });

  it('reads the current player response published by the main-world bridge', () => {
    const script = playerScript();
    const responseJson = script.slice(script.indexOf('{'), script.lastIndexOf('}') + 1);
    const candidates = youtubeDetectionAdapter.detect(
      fakeBridgeDocument(responseJson, [observedVideo, observedAudio]),
      new URL('https://www.youtube.com/watch?v=GwUwyWGHmGY'),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ title: 'Example video', siteAdapterId: 'youtube' });
  });

  it('does not remove a byte range covered by the signed parameter list', () => {
    const signedRangeVideo = observedVideo.replace(
      'sparams=expire,id,itag,n',
      'sparams=expire,id,itag,n,range',
    );
    const player = parseYouTubePlayerResponse(playerScript(), {
      expectedVideoId: 'GwUwyWGHmGY',
      observedMediaUrls: [signedRangeVideo, observedAudio],
    });

    expect(player?.dash).toBeUndefined();
  });

  it('matches only exact YouTube watch pages and Google Video resources', () => {
    expect(youtubeVideoId(new URL('https://www.youtube.com/watch?v=GwUwyWGHmGY'))).toBe('GwUwyWGHmGY');
    expect(isYouTubeWatchPage(new URL('https://m.youtube.com/watch?v=GwUwyWGHmGY'))).toBe(true);
    expect(isYouTubeWatchPage(new URL('https://evil-youtube.com/watch?v=GwUwyWGHmGY'))).toBe(false);
    expect(isYouTubeWatchPage(new URL('https://www.youtube.com/results?v=GwUwyWGHmGY'))).toBe(false);
    expect(isGoogleVideoUrl(observedVideo)).toBe(true);
    expect(isGoogleVideoUrl('https://googlevideo.com.evil.example/videoplayback?itag=137')).toBe(false);
    expect(isYouTubeUiAudioResource(
      new URL('https://www.youtube.com/s/search/audio/no_input.mp3'),
    )).toBe(true);
    expect(isYouTubeUiAudioResource(
      new URL('https://www.youtube.com/watch/audio/video.mp3'),
    )).toBe(false);
    expect(detectionAdapterClaimsResource(new URL(observedVideo))).toBe(true);
    expect(detectionAdapterClaimsResource(
      new URL('https://www.youtube.com/s/search/audio/open.mp3'),
    )).toBe(true);
    expect(detectionAdapterClaimsResource(
      new URL('https://youtube.com.evil.example/s/search/audio/open.mp3'),
    )).toBe(false);
    expect(detectionAdapterOwnsResource(
      new URL(observedVideo),
      new URL('https://www.youtube.com/watch?v=GwUwyWGHmGY'),
    )).toBe(true);
    expect(detectionAdapterOwnsResource(
      new URL('https://www.youtube.com/s/search/audio/failure.mp3'),
      new URL('https://www.youtube.com/watch?v=GwUwyWGHmGY'),
    )).toBe(true);
    expect(detectionAdapterOwnsResource(
      new URL('https://cdn.example/video.mp4'),
      new URL('https://www.youtube.com/watch?v=GwUwyWGHmGY'),
    )).toBe(false);
  });

  it('rejects player data for a different video identity', () => {
    expect(parseYouTubePlayerResponse(playerScript(), {
      expectedVideoId: 'AAAAAAAAAAA',
      observedMediaUrls: [observedVideo, observedAudio],
    })).toBeUndefined();
  });
});
