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
  parseYouTubePlayerResponseDocument,
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
const progressiveBase = 'https://rr3---sn-test.googlevideo.com/videoplayback' +
  '?expire=2000000000&id=muxed-resource&itag=18&n=untransformed' +
  '&sparams=expire,id,itag,n&sig=muxed-signature';
const observedProgressive = progressiveBase.replace('n=untransformed', 'n=muxed-token') +
  '&range=0-999&rn=3';

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

function sabrPlayerScript(
  formatOverrides: Record<string, unknown> = {},
  { status = 'OK', isLive = false }: { status?: string; isLive?: boolean } = {},
): string {
  return `var ytInitialPlayerResponse = ${JSON.stringify({
    playabilityStatus: { status },
    videoDetails: {
      videoId: 'GwUwyWGHmGY',
      title: 'SABR example video',
      lengthSeconds: '125',
      isLiveContent: isLive,
    },
    streamingData: {
      serverAbrStreamingUrl: 'https://rr3---sn-test.googlevideo.com/videoplayback?sabr=1',
      formats: [{
        itag: 18,
        mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
        bitrate: 632_414,
        contentLength: '9876543',
        width: 640,
        height: 360,
        url: progressiveBase,
        ...formatOverrides,
      }],
      adaptiveFormats: [
        {
          itag: 137,
          mimeType: 'video/mp4; codecs="avc1.640028"',
          bitrate: 4_000_000,
          width: 1920,
          height: 1080,
          initRange: { start: '0', end: '741' },
          indexRange: { start: '742', end: '2717' },
        },
        {
          itag: 140,
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          bitrate: 128_000,
          initRange: { start: '0', end: '722' },
          indexRange: { start: '723', end: '1750' },
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
      return selector === '[data-open-media-downloader-youtube-player]' ? [{
        textContent: responseJson,
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

  it('falls back to the signed muxed MP4 when SABR hides adaptive track URLs', () => {
    const player = parseYouTubePlayerResponse(sabrPlayerScript(), {
      expectedVideoId: 'GwUwyWGHmGY',
      observedMediaUrls: [observedProgressive],
    });

    expect(player?.dash).toBeUndefined();
    expect(player?.progressive).toEqual({
      id: '18',
      url: reusableObservedUrl(observedProgressive),
      mimeType: 'video/mp4',
      codecs: 'avc1.42001E, mp4a.40.2',
      bandwidth: 632_414,
      contentLength: 9_876_543,
      width: 640,
      height: 360,
    });
    expect(youtubeDetectionAdapter.detect(
      fakeDocument(sabrPlayerScript(), [observedProgressive]),
      new URL('https://www.youtube.com/watch?v=GwUwyWGHmGY'),
    )).toEqual([{
      kind: 'progressive',
      source: 'dom',
      url: reusableObservedUrl(observedProgressive),
      title: 'SABR example video',
      siteAdapterId: 'youtube',
      sourcePageUrl: 'https://www.youtube.com/watch?v=GwUwyWGHmGY',
      mimeType: 'video/mp4',
      contentLength: 9_876_543,
    }]);
  });

  it('waits for the player to transform the muxed MP4 n value', () => {
    const player = parseYouTubePlayerResponse(sabrPlayerScript(), {
      expectedVideoId: 'GwUwyWGHmGY',
    });

    expect(player?.progressive).toBeUndefined();
    expect(youtubeDetectionAdapter.detect(
      fakeDocument(sabrPlayerScript()),
      new URL('https://www.youtube.com/watch?v=GwUwyWGHmGY'),
    )).toEqual([]);
  });

  it('accepts a direct muxed MP4 URL that needs no player transformation', () => {
    const url = progressiveBase.replace('&n=untransformed', '');
    expect(parseYouTubePlayerResponse(sabrPlayerScript({ url }))?.progressive?.url).toBe(url);
  });

  it('resolves a ciphered muxed MP4 only from its matching runtime request', () => {
    const script = sabrPlayerScript({
      url: undefined,
      signatureCipher: new URLSearchParams({
        url: progressiveBase,
        s: 'ciphered-signature',
        sp: 'sig',
      }).toString(),
    });

    expect(parseYouTubePlayerResponse(script)?.progressive).toBeUndefined();
    expect(parseYouTubePlayerResponse(script, {
      observedMediaUrls: [observedProgressive],
    })?.progressive?.url).toBe(reusableObservedUrl(observedProgressive));
  });

  it.each([
    observedProgressive.replace('id=muxed-resource', 'id=another-video'),
    observedProgressive.replace('itag=18', 'itag=22'),
  ])('does not reuse a runtime URL for a different playback identity: %s', (url) => {
    expect(parseYouTubePlayerResponse(sabrPlayerScript(), {
      observedMediaUrls: [url],
    })?.progressive).toBeUndefined();
  });

  it.each(['sparams', 'lsparams'])(
    'does not reuse a muxed MP4 byte range covered by %s',
    (parameter) => {
      const url = parameter === 'sparams'
        ? observedProgressive.replace('sparams=expire,id,itag,n', 'sparams=expire,id,itag,n,range')
        : `${observedProgressive}&lsparams=range`;
      expect(parseYouTubePlayerResponse(sabrPlayerScript(), {
        observedMediaUrls: [url],
      })?.progressive).toBeUndefined();
    },
  );

  it('does not publish a direct partial MP4 URL whose range cannot be removed', () => {
    const url = progressiveBase.replace('&n=untransformed', '') + '&range=0-999&lsparams=range';
    expect(parseYouTubePlayerResponse(sabrPlayerScript({ url }))?.progressive).toBeUndefined();
  });

  it.each([
    { status: 'LOGIN_REQUIRED', isLive: false },
    { status: 'UNPLAYABLE', isLive: false },
    { status: 'OK', isLive: true },
  ])('does not publish progressive media for unavailable or live players: %j', (state) => {
    const player = parseYouTubePlayerResponse(sabrPlayerScript({}, state), {
      observedMediaUrls: [observedProgressive],
    });
    expect(player?.progressive).toBeUndefined();
    expect(player?.dash).toBeUndefined();
  });

  it('continues past an incomplete bridge response to a playable page response', () => {
    const document = fakeDocument(sabrPlayerScript(), [observedProgressive]);
    const pageScripts = Array.from(document.querySelectorAll('script'));
    const bridge = {
      textContent: JSON.stringify({
        playabilityStatus: { status: 'OK' },
        videoDetails: { videoId: 'GwUwyWGHmGY', title: 'Incomplete metadata' },
        streamingData: { adaptiveFormats: [{ itag: 137 }] },
      }),
      dataset: { openMediaDownloaderYoutubePlayer: '' },
    };
    document.querySelectorAll = ((selector: string) =>
      selector === '[data-open-media-downloader-youtube-player]'
        ? [bridge]
        : selector === 'script' ? pageScripts : []) as unknown as Document['querySelectorAll'];

    const player = parseYouTubePlayerResponseDocument(document, { expectedVideoId: 'GwUwyWGHmGY' });
    expect(player?.title).toBe('SABR example video');
    expect(player?.progressive?.url).toBe(reusableObservedUrl(observedProgressive));
  });

  it('prefers complete DASH tracks over another response with only progressive media', () => {
    const document = fakeDocument(playerScript(), [observedVideo, observedAudio, observedProgressive]);
    const pageScripts = Array.from(document.querySelectorAll('script'));
    document.querySelectorAll = ((selector: string) => selector === 'script'
      ? [...pageScripts, { textContent: sabrPlayerScript() }]
      : []) as unknown as Document['querySelectorAll'];

    const player = parseYouTubePlayerResponseDocument(document, { expectedVideoId: 'GwUwyWGHmGY' });
    expect(player?.title).toBe('Example video');
    expect(player?.dash?.tracks).toHaveLength(2);
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

  describe('URLs resolved by the main-world bridge', () => {
    function payload(resolvedMediaUrls: unknown, script = sabrPlayerScript()): string {
      const response = JSON.parse(script.slice(script.indexOf('{'), script.lastIndexOf('}') + 1)) as Record<string, unknown>;
      return JSON.stringify({ ...response, resolvedMediaUrls });
    }

    it('uses a matching resolved URL before the player has requested that format', () => {
      const document = fakeBridgeDocument(payload([observedProgressive]), []);
      const player = parseYouTubePlayerResponseDocument(document, { expectedVideoId: 'GwUwyWGHmGY' });
      expect(player?.progressive?.url).toBe(reusableObservedUrl(observedProgressive));
    });

    it('prefers an actual playback request over a bridge result for the same format', () => {
      const latest = observedProgressive.replace('n=muxed-token', 'n=latest-playback-token');
      const document = fakeBridgeDocument(payload([observedProgressive]), [latest]);
      const player = parseYouTubePlayerResponseDocument(document, { expectedVideoId: 'GwUwyWGHmGY' });
      expect(player?.progressive?.url).toBe(reusableObservedUrl(latest));
    });

    it.each([
      { urls: [observedProgressive.replace('id=muxed-resource', 'id=another-video')] },
      { urls: [observedProgressive.replace('itag=18', 'itag=22')] },
      { urls: [observedProgressive.replace('googlevideo.com', 'googlevideo.com.evil.example')] },
      { urls: [observedProgressive.replace('sparams=expire,id,itag,n', 'sparams=expire,id,itag,n,range')] },
      { urls: [null, 42, { url: observedProgressive }] },
      { urls: observedProgressive },
    ])('rejects mismatched or malformed resolved URL data: %j', ({ urls }) => {
      const document = fakeBridgeDocument(payload(urls), []);
      expect(parseYouTubePlayerResponseDocument(document, {
        expectedVideoId: 'GwUwyWGHmGY',
      })?.progressive).toBeUndefined();
    });

    it('does not apply bridge URLs to another video', () => {
      const document = fakeBridgeDocument(payload([observedProgressive]), []);
      expect(parseYouTubePlayerResponseDocument(document, {
        expectedVideoId: 'AAAAAAAAAAA',
      })).toBeUndefined();
    });

    it.each([
      { status: 'LOGIN_REQUIRED', isLive: false },
      { status: 'OK', isLive: true },
    ])('keeps unavailable/live player guards with resolved URLs: %j', (state) => {
      const document = fakeBridgeDocument(payload([observedProgressive], sabrPlayerScript({}, state)), []);
      const player = parseYouTubePlayerResponseDocument(document, { expectedVideoId: 'GwUwyWGHmGY' });
      expect(player?.progressive).toBeUndefined();
      expect(player?.dash).toBeUndefined();
    });

    it('does not treat URL claims in ordinary page scripts as bridge resolutions', () => {
      const script = `var ytInitialPlayerResponse = ${payload([observedProgressive])};`;
      expect(parseYouTubePlayerResponseDocument(fakeDocument(script), {
        expectedVideoId: 'GwUwyWGHmGY',
      })?.progressive).toBeUndefined();
    });
  });
});
