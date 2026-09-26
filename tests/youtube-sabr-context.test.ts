import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';

const storage = vi.hoisted(() => new Map<string, unknown>());

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: structuredClone(storage.get(key)) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value));
        }),
        remove: vi.fn(async (key: string) => { storage.delete(key); }),
      },
    },
  },
}));

import {
  acceptYoutubeSabrBridgeRequest,
  captureYoutubeSabrContext,
  clearYoutubeSabrContexts,
  decodeYoutubeSabrRequest,
  findYoutubeSabrContext,
  isYoutubeSabrContextSender,
} from '../src/background/youtube-sabr-context';

const observedUrl = 'https://rr1.googlevideo.com/videoplayback?id=media-one&sabr=1&sig=observed';
const sourceUrl = 'https://rr2.googlevideo.com/videoplayback?id=media-one&sabr=1&sig=source';
const config = new Uint8Array([0, 1, 128, 255]);
const token = new Uint8Array([3, 4, 5]);
const clientInfo = { clientName: 1, clientVersion: 'actual-player-version', osName: 'Macintosh' };

function encodedRequest(withToken = true): Uint8Array {
  return VideoPlaybackAbrRequest.encode({
    selectedFormatIds: [],
    bufferedRanges: [],
    preferredAudioFormatIds: [],
    preferredVideoFormatIds: [],
    preferredSubtitleFormatIds: [],
    field1000: [],
    videoPlaybackUstreamerConfig: config,
    streamerContext: {
      clientInfo,
      ...(withToken ? { poToken: token } : {}),
      playbackCookie: new Uint8Array([9, 9, 9]),
      sabrContexts: [{ type: 1, value: new Uint8Array([8, 8, 8]) }],
      unsentSabrContexts: [],
    },
  }).finish();
}

function request(overrides: Partial<Parameters<typeof decodeYoutubeSabrRequest>[0]> = {}) {
  return {
    tabId: 42,
    method: 'POST',
    url: observedUrl,
    initiator: 'https://www.youtube.com',
    requestBody: { raw: [{ bytes: encodedRequest().slice().buffer as ArrayBuffer }] },
    ...overrides,
  };
}

beforeEach(() => {
  storage.clear();
  vi.useRealTimers();
});

describe('YouTube SABR request context capture', () => {
  it('extracts real config, token, and client fields without retaining unrelated playback state', () => {
    const captured = decodeYoutubeSabrRequest(request(), 123);
    expect(captured).toMatchObject({
      tabId: 42,
      mediaId: 'media-one',
      capturedAt: 123,
      context: {
        serverAbrStreamingUrl: observedUrl,
        videoPlaybackUstreamerConfig: 'AAGA/w==',
        poToken: 'AwQF',
        clientInfo,
      },
    });
    expect(Object.keys(captured!.context).sort()).toEqual([
      'clientInfo', 'poToken', 'serverAbrStreamingUrl', 'videoPlaybackUstreamerConfig',
    ]);
    expect(JSON.stringify(captured)).not.toContain('playbackCookie');
    expect(JSON.stringify(captured)).not.toContain('sabrContexts');
  });

  it('combines raw upload chunks before decoding', () => {
    const bytes = encodedRequest();
    const captured = decodeYoutubeSabrRequest(request({ requestBody: { raw: [
      { bytes: bytes.slice(0, 3).buffer as ArrayBuffer },
      { bytes: bytes.slice(3).buffer as ArrayBuffer },
    ] } }));
    expect(captured?.context.poToken).toBe('AwQF');
  });

  it('does not fabricate client info or a token when the player omits them', () => {
    const body = VideoPlaybackAbrRequest.encode({
      selectedFormatIds: [], bufferedRanges: [], preferredAudioFormatIds: [],
      preferredVideoFormatIds: [], preferredSubtitleFormatIds: [], field1000: [],
      videoPlaybackUstreamerConfig: config,
    }).finish();
    const captured = decodeYoutubeSabrRequest(request({
      requestBody: { raw: [{ bytes: body.slice().buffer as ArrayBuffer }] },
    }));
    expect(captured?.context).toEqual({
      serverAbrStreamingUrl: observedUrl,
      videoPlaybackUstreamerConfig: 'AAGA/w==',
    });
  });

  it('bounds each retained field so the session cache stays within its storage budget', () => {
    for (const field of ['config', 'token', 'client'] as const) {
      const decoded = VideoPlaybackAbrRequest.decode(encodedRequest());
      if (field === 'config') decoded.videoPlaybackUstreamerConfig = new Uint8Array(64 * 1_024 + 1);
      if (field === 'token') decoded.streamerContext!.poToken = new Uint8Array(16 * 1_024 + 1);
      if (field === 'client') decoded.streamerContext!.clientInfo!.deviceModel = 'x'.repeat(16 * 1_024 + 1);
      const body = VideoPlaybackAbrRequest.encode(decoded).finish();
      expect(decodeYoutubeSabrRequest(request({
        requestBody: { raw: [{ bytes: body.slice().buffer as ArrayBuffer }] },
      }))).toBeNull();
    }
  });

  it.each([
    { tabId: -1 },
    { tabId: 1.5 },
    { method: 'GET' },
    { initiator: undefined },
    { initiator: 'https://youtube.com.evil.test' },
    { initiator: 'https://evil-youtube.com' },
    { initiator: 'http://www.youtube.com' },
    { initiator: 'https://user@www.youtube.com' },
    { url: 'https://googlevideo.com.evil.test/videoplayback?id=media-one' },
    { url: 'https://evilgooglevideo.com/videoplayback?id=media-one' },
    { url: 'https://rr1.googlevideo.com/other?id=media-one' },
    { url: 'http://rr1.googlevideo.com/videoplayback?id=media-one' },
    { url: 'https://user@rr1.googlevideo.com/videoplayback?id=media-one' },
    { url: 'https://rr1.googlevideo.com:123/videoplayback?id=media-one' },
    { url: 'https://rr1.googlevideo.com/videoplayback?id=one&id=two' },
    { url: 'https://rr1.googlevideo.com/videoplayback' },
    { requestBody: undefined },
    { requestBody: { error: 'Cannot read upload' } },
    { requestBody: { raw: [{ file: '/private/video-upload' }] } },
    { requestBody: { raw: [{ bytes: new ArrayBuffer(0) }] } },
    { requestBody: { raw: [{ bytes: new ArrayBuffer(256 * 1_024 + 1) }] } },
    { requestBody: { raw: [{ bytes: new Uint8Array([255]).buffer }] } },
    { requestBody: { raw: [{ bytes: new Uint8Array([8, 0]).buffer }] } },
  ])('ignores unsafe, unrelated, or malformed requests %#', (override) => {
    expect(decodeYoutubeSabrRequest(request(override))).toBeNull();
  });
});

describe('session-scoped SABR authorization context', () => {
  it('returns the observed URL only for the same source tab and media id', async () => {
    await captureYoutubeSabrContext(request());
    expect(await findYoutubeSabrContext(42, sourceUrl)).toMatchObject({
      serverAbrStreamingUrl: observedUrl,
      poToken: 'AwQF',
    });
    expect(await findYoutubeSabrContext(43, sourceUrl)).toBeNull();
    expect(await findYoutubeSabrContext(42, sourceUrl.replace('media-one', 'media-two'))).toBeNull();
    expect(await findYoutubeSabrContext(42, sourceUrl.replace('.googlevideo.com', '.evil.test'))).toBeNull();
  });

  it('retains a still-valid token when a later request omits it, and refreshes the observed URL', async () => {
    await captureYoutubeSabrContext(request());
    const laterUrl = observedUrl.replace('sig=observed', 'sig=refreshed');
    await captureYoutubeSabrContext(request({
      url: laterUrl,
      requestBody: { raw: [{ bytes: encodedRequest(false).slice().buffer as ArrayBuffer }] },
    }));
    expect(await findYoutubeSabrContext(42, sourceUrl)).toMatchObject({
      serverAbrStreamingUrl: laterUrl,
      poToken: 'AwQF',
    });
  });

  it('survives an MV3 worker module restart without local persistent storage', async () => {
    await captureYoutubeSabrContext(request());
    vi.resetModules();
    const restarted = await import('../src/background/youtube-sabr-context');
    expect(await restarted.findYoutubeSabrContext(42, sourceUrl)).toMatchObject({ poToken: 'AwQF' });
  });

  it('expires after five minutes and removes stale authorization data', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T00:00:00Z'));
    await captureYoutubeSabrContext(request());
    vi.advanceTimersByTime(299_999);
    expect(await findYoutubeSabrContext(42, sourceUrl)).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(await findYoutubeSabrContext(42, sourceUrl)).toBeNull();
    expect(storage.has('youtube-sabr-contexts')).toBe(false);
  });

  it('bounds the cache and evicts the oldest media context', async () => {
    vi.useFakeTimers();
    for (let index = 0; index < 33; index++) {
      vi.advanceTimersByTime(1);
      await captureYoutubeSabrContext(request({
        url: observedUrl.replace('media-one', `media-${index}`),
      }));
    }
    expect(await findYoutubeSabrContext(42, sourceUrl.replace('media-one', 'media-0'))).toBeNull();
    expect(await findYoutubeSabrContext(42, sourceUrl.replace('media-one', 'media-32'))).not.toBeNull();
    expect(storage.get('youtube-sabr-contexts')).toHaveLength(32);
  });

  it('serializes captures and navigation cleanup so a pending write cannot revive cleared context', async () => {
    const first = captureYoutubeSabrContext(request());
    const otherTab = captureYoutubeSabrContext(request({ tabId: 43 }));
    const clear = clearYoutubeSabrContexts(42);
    await Promise.all([first, otherTab, clear]);
    expect(await findYoutubeSabrContext(42, sourceUrl)).toBeNull();
    expect(await findYoutubeSabrContext(43, sourceUrl)).not.toBeNull();
    await captureYoutubeSabrContext(request({ url: observedUrl.replace('media-one', 'next-video') }));
    expect(await findYoutubeSabrContext(42, sourceUrl.replace('media-one', 'next-video'))).not.toBeNull();
  });

  it('discards corrupt cache entries without exposing them', async () => {
    storage.set('youtube-sabr-contexts', [null, {}, {
      tabId: 42, mediaId: 'media-one', capturedAt: Date.now(),
      context: { serverAbrStreamingUrl: 'https://evil.test', videoPlaybackUstreamerConfig: 'AA==' },
    }]);
    expect(await findYoutubeSabrContext(42, sourceUrl)).toBeNull();
    expect(storage.size).toBe(0);
  });
});

describe('SABR context message authorization', () => {
  const extensionId = 'test-extension-id';
  const downloaderUrl = `chrome-extension://${extensionId}/downloader.html`;

  it('permits only the extension downloader document, with its normal query parameters', () => {
    expect(isYoutubeSabrContextSender({
      id: extensionId,
      url: `${downloaderUrl}?tabId=42&candidateId=example`,
    }, extensionId, downloaderUrl)).toBe(true);
  });

  it.each([
    { id: 'other-extension', url: downloaderUrl },
    { url: downloaderUrl },
    { id: extensionId },
    { id: extensionId, url: 'https://www.youtube.com/watch?v=example' },
    { id: extensionId, url: `${downloaderUrl}.evil` },
    { id: extensionId, url: `${downloaderUrl}/child` },
    { id: extensionId, url: `chrome-extension://other-extension/downloader.html` },
    { id: extensionId, url: `https://${extensionId}/downloader.html` },
    { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` },
  ])('rejects another origin, document, or extension %#', (sender) => {
    expect(isYoutubeSabrContextSender(sender, extensionId, downloaderUrl)).toBe(false);
  });
});

describe('YouTube page-world upload fallback', () => {
  const sender = {
    id: 'test-extension', frameId: 0, tab: { id: 42 },
    url: 'https://www.youtube.com/watch?v=jUNz-uTF--E',
  };
  const bridge = () => ({
    url: sourceUrl, videoId: 'jUNz-uTF--E',
    bodyBase64: btoa(String.fromCharCode(...encodedRequest())),
  });

  it('accepts protobuf bytes only after an independent real POST observation in the same tab', async () => {
    await captureYoutubeSabrContext(request({ requestBody: { error: 'Body unavailable' } }));
    expect(await findYoutubeSabrContext(42, sourceUrl)).toBeNull();
    expect(await acceptYoutubeSabrBridgeRequest(bridge(), sender, 'test-extension')).toBe(true);
    expect(await findYoutubeSabrContext(42, sourceUrl)).toMatchObject({
      serverAbrStreamingUrl: observedUrl,
      poToken: 'AwQF',
    });
  });

  it.each([
    { ...sender, id: 'other-extension' },
    { ...sender, frameId: 1 },
    { ...sender, url: 'https://www.youtube.com/watch?v=different11' },
    { ...sender, url: 'https://www.youtube.com.evil.test/watch?v=jUNz-uTF--E' },
    { ...sender, url: 'https://www.youtube.com/embed/jUNz-uTF--E' },
  ])('rejects invalid sender origin, video, frame, or extension %#', async (invalidSender) => {
    await captureYoutubeSabrContext(request({ requestBody: { error: 'Body unavailable' } }));
    expect(await acceptYoutubeSabrBridgeRequest(bridge(), invalidSender, 'test-extension')).toBe(false);
    expect(await findYoutubeSabrContext(42, sourceUrl)).toBeNull();
  });

  it('waits briefly for the matching real network event instead of trusting the page claim', async () => {
    vi.useFakeTimers();
    const accepted = acceptYoutubeSabrBridgeRequest(bridge(), sender, 'test-extension');
    await vi.advanceTimersByTimeAsync(100);
    await captureYoutubeSabrContext(request({ requestBody: { error: 'Body unavailable' } }));
    await vi.advanceTimersByTimeAsync(100);
    expect(await accepted).toBe(true);
  });

  it('rejects an upload when only another tab observed its media id', async () => {
    vi.useFakeTimers();
    await captureYoutubeSabrContext(request({ tabId: 43, requestBody: { error: 'Body unavailable' } }));
    const accepted = acceptYoutubeSabrBridgeRequest(bridge(), sender, 'test-extension');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await accepted).toBe(false);
    expect(await findYoutubeSabrContext(42, sourceUrl)).toBeNull();
  });

  it('does not let page bridge messages renew the independent network observation', async () => {
    vi.useFakeTimers();
    await captureYoutubeSabrContext(request({ requestBody: { error: 'Body unavailable' } }));
    await vi.advanceTimersByTimeAsync(240_000);
    expect(await acceptYoutubeSabrBridgeRequest(bridge(), sender, 'test-extension')).toBe(true);
    await vi.advanceTimersByTimeAsync(60_001);
    const accepted = acceptYoutubeSabrBridgeRequest(bridge(), sender, 'test-extension');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await accepted).toBe(false);
  });

  it('rejects malformed or oversized base64 before reading the upload', async () => {
    expect(await acceptYoutubeSabrBridgeRequest({ ...bridge(), bodyBase64: 'bad!' }, sender, 'test-extension')).toBe(false);
    expect(await acceptYoutubeSabrBridgeRequest({ ...bridge(), bodyBase64: 'A'.repeat(349_532) }, sender, 'test-extension')).toBe(false);
  });
});
