import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BRIDGE_ATTRIBUTE = 'data-open-media-downloader-youtube-player';
const VIDEO_ID = 'GwUwyWGHmGY';
const NEXT_VIDEO_ID = 'BaW_jenozKc';

class FakeElement {
  hidden = false;
  readonly attributes = new Map<string, string>();
  textWrites = 0;
  #text = '';

  constructor(readonly tagName: string, readonly onRemove: () => void) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  get textContent(): string {
    return this.#text;
  }

  set textContent(value: string) {
    if (this.tagName === 'script') {
      throw new TypeError("This document requires 'TrustedScript' assignment.");
    }
    this.textWrites += 1;
    this.#text = value;
  }

  remove(): void {
    this.onRemove();
  }
}

class FakeDocument extends EventTarget {
  response: unknown;
  readonly playerScripts: { src: string }[] = [];
  readonly elements: FakeElement[] = [];
  readonly createdTags: string[] = [];
  readonly getPlayerResponse = vi.fn(() => this.response);
  readonly documentElement = {
    append: (element: FakeElement) => { this.elements.push(element); },
  };

  getElementById(id: string): unknown {
    return id === 'movie_player' ? { getPlayerResponse: this.getPlayerResponse } : null;
  }

  createElement(tagName: string): FakeElement {
    this.createdTags.push(tagName);
    const element = new FakeElement(tagName, () => {
      const index = this.elements.indexOf(element);
      if (index >= 0) this.elements.splice(index, 1);
    });
    return element;
  }

  querySelector(selector: string): FakeElement | null {
    return this.elements.find((element) =>
      element.attributes.has(BRIDGE_ATTRIBUTE) &&
      (selector === `[${BRIDGE_ATTRIBUTE}]` || selector === `${element.tagName}[${BRIDGE_ATTRIBUTE}]`),
    ) ?? null;
  }

  querySelectorAll(selector: string): { src: string }[] {
    return selector === 'script[src]' ? this.playerScripts : [];
  }

  get bridge(): FakeElement | undefined {
    return this.elements.find((element) => element.attributes.has(BRIDGE_ATTRIBUTE));
  }
}

function response(videoId = VIDEO_ID, mediaUrl = 'https://cdn.example/first.mp4') {
  return {
    playabilityStatus: { status: 'OK' },
    videoDetails: { videoId, title: `Video ${videoId}`, lengthSeconds: '12' },
    streamingData: {
      adaptiveFormats: [{ itag: 137, mimeType: 'video/mp4', url: mediaUrl }],
    },
  };
}

function navigate(videoId: string): void {
  vi.stubGlobal('location', new URL(`https://www.youtube.com/watch?v=${videoId}`));
}

async function startBridge(
  initialResponse: unknown = response(),
  player?: { sourceUrl: string; namespace: unknown },
) {
  const document = new FakeDocument();
  document.response = initialResponse;
  if (player) document.playerScripts.push({ src: player.sourceUrl });
  const window = Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    _yt_player: player?.namespace,
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  navigate(VIDEO_ID);
  let main: (() => void) | undefined;
  vi.stubGlobal('defineContentScript', (definition: { main(): void }) => {
    main = definition.main;
    return definition;
  });
  await import('../entrypoints/youtube-player-bridge.content');
  if (!main) throw new Error('The YouTube bridge did not register its content script.');
  main();
  return { document, window };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('YouTube player bridge', () => {
  it('publishes the MP4 SABR format metadata without exposing player session configuration', async () => {
    const original = response();
    const { document } = await startBridge({
      ...original,
      playerConfig: { mediaCommonConfig: { mediaUstreamerRequestConfig: { videoPlaybackUstreamerConfig: 'private-config' } } },
      streamingData: {
        serverAbrStreamingUrl: 'https://rr1.googlevideo.com/videoplayback?id=media&sabr=1',
        poToken: 'private-token',
        adaptiveFormats: [{
          itag: 401, mimeType: 'video/mp4; codecs="av01.0.13M.08"', width: 3840, height: 2160,
          fps: 60, bitrate: 16_000_000, lastModified: '1750000000000000',
          contentLength: '180000000', approxDurationMs: '120000', xtags: 'v=1',
          audioTrack: { id: 'en.0', displayName: 'English', audioIsDefault: true, privateState: 'private-state' },
        }],
      },
    });
    expect(JSON.parse(document.bridge!.textContent).streamingData).toMatchObject({
      serverAbrStreamingUrl: 'https://rr1.googlevideo.com/videoplayback?id=media&sabr=1',
      adaptiveFormats: [{ itag: 401, height: 2160, lastModified: '1750000000000000',
        contentLength: '180000000', approxDurationMs: '120000', xtags: 'v=1',
        audioTrack: { id: 'en.0', displayName: 'English', audioIsDefault: true } }],
    });
    expect(document.bridge!.textContent).not.toContain('private-');
  });

  it('publishes inert JSON when Trusted Types forbids all script text assignments', async () => {
    const { document } = await startBridge();

    expect(document.createdTags).toEqual(['div']);
    expect(document.bridge?.hidden).toBe(true);
    expect(JSON.parse(document.bridge!.textContent)).toMatchObject(response());
    expect(document.bridge?.textWrites).toBe(1);
  });

  it('picks up delayed metadata and later URL changes without rewriting unchanged snapshots', async () => {
    const { document } = await startBridge({
      ...response(),
      streamingData: { adaptiveFormats: [] },
    });
    const element = document.bridge!;
    document.response = response();
    await vi.advanceTimersByTimeAsync(250);
    expect(element.textWrites).toBe(2);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(element.textWrites).toBe(2);
    expect(document.createdTags).toEqual(['div']);

    document.response = response(VIDEO_ID, 'https://cdn.example/refreshed.mp4');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(element.textWrites).toBe(3);
    expect(JSON.parse(element.textContent).streamingData.adaptiveFormats[0].url)
      .toBe('https://cdn.example/refreshed.mp4');
  });

  it('keeps only one refresh timer after repeated player updates', async () => {
    const { document, window } = await startBridge();
    for (let index = 0; index < 3; index += 1) {
      window.dispatchEvent(new Event('yt-player-updated'));
    }
    expect(vi.getTimerCount()).toBe(1);
    expect(document.bridge?.textWrites).toBe(1);
    document.getPlayerResponse.mockClear();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(document.getPlayerResponse).toHaveBeenCalledTimes(1);
  });

  it('cancels the previous navigation and never publishes the old video on the new page', async () => {
    const { document, window } = await startBridge();
    window.dispatchEvent(new Event('yt-navigate-start'));
    expect(document.bridge).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    navigate(NEXT_VIDEO_ID);
    window.dispatchEvent(new Event('yt-navigate-finish'));
    await vi.advanceTimersByTimeAsync(500);
    expect(document.bridge).toBeUndefined();

    document.response = response(NEXT_VIDEO_ID);
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(document.bridge!.textContent).videoDetails.videoId).toBe(NEXT_VIDEO_ID);
    expect(vi.getTimerCount()).toBe(1);

    vi.stubGlobal('location', new URL('https://www.youtube.com/'));
    window.dispatchEvent(new Event('yt-navigate-finish'));
    expect(document.bridge).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops while the document is hidden by navigation and resumes on restoration', async () => {
    const { document, window } = await startBridge();
    window.dispatchEvent(new Event('pagehide'));
    expect(document.bridge).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);

    window.dispatchEvent(new Event('pageshow'));
    expect(document.bridge).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not publish a stale video when the player source fetch finishes after navigation', async () => {
    class PlayerUrl {
      constructor(readonly raw: string) {}
      get(name: string) {
        const value = new URL(this.raw).searchParams.get(name);
        return name === 'n' ? `resolved-${value}` : value;
      }
      set() {}
      clone() { return new PlayerUrl(this.raw); }
    }
    let finishFetch!: (value: { ok: boolean; text(): Promise<string> }) => void;
    const fetchSource = vi.fn(() => new Promise((resolve) => { finishFetch = resolve; }));
    vi.stubGlobal('fetch', fetchSource);
    const mediaUrl = (video: string) =>
      `https://rr1.googlevideo.com/videoplayback?id=${video}&itag=137&n=${video}`;
    const { document, window } = await startBridge(response(VIDEO_ID, mediaUrl('first')), {
      sourceUrl: 'https://www.youtube.com/s/player/test/player_ias.vflset/en_US/base.js',
      namespace: { Url: PlayerUrl },
    });
    expect(fetchSource).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('yt-navigate-start'));
    navigate(NEXT_VIDEO_ID);
    document.response = response(NEXT_VIDEO_ID, mediaUrl('next'));
    window.dispatchEvent(new Event('yt-navigate-finish'));
    const currentBridge = document.bridge!;
    expect(JSON.parse(currentBridge.textContent).videoDetails.videoId).toBe(NEXT_VIDEO_ID);

    finishFetch({ ok: true, text: async () => 'a=new g.Url(a,true);a.set("alr","yes");' });
    await vi.advanceTimersByTimeAsync(0);
    expect(currentBridge.textWrites).toBe(1);
    expect(JSON.parse(currentBridge.textContent).resolvedMediaUrls).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(JSON.parse(currentBridge.textContent)).toMatchObject({
      videoDetails: { videoId: NEXT_VIDEO_ID },
      resolvedMediaUrls: [mediaUrl('next').replace('n=next', 'n=resolved-next')],
    });
    expect(fetchSource).toHaveBeenCalledTimes(1);
    expect(currentBridge.textWrites).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(currentBridge.textWrites).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
  });
});
