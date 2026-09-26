import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ATTRIBUTE = 'data-open-media-downloader-bilibili-player';
const PLAY_URL = 'https://api.bilibili.com/pgc/player/web/playurl?ep_id=1';
const MEDIA_URL = 'https://video.bilivideo.com/episode.mp4';
const MAX_BYTES = 2 * 1_024 * 1_024;

class FakeElement {
  hidden = false;
  textContent = '';
  readonly attributes = new Map<string, string>();
  constructor(readonly remove: () => void) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
}

class FakeDocument extends EventTarget {
  readonly elements: FakeElement[] = [];
  readonly documentElement = {
    append: (element: FakeElement) => { this.elements.push(element); },
  };
  createElement(tag: string) {
    if (tag !== 'div') throw new Error('The bridge must publish inert JSON in a div.');
    const element = new FakeElement(() => {
      const index = this.elements.indexOf(element);
      if (index >= 0) this.elements.splice(index, 1);
    });
    return element;
  }
  querySelector(selector: string) {
    return selector === `[${ATTRIBUTE}]` ? this.bridge ?? null : null;
  }
  get bridge() { return this.elements.find((element) => element.attributes.has(ATTRIBUTE)); }
  get state() { return this.bridge ? JSON.parse(this.bridge.textContent) : undefined; }
}

function playback(episodeId?: number, url = MEDIA_URL) {
  return {
    code: 0,
    account: { cookie: 'private-cookie', user: 'private-user' },
    result: {
      ...(episodeId ? { ep_id: episodeId } : {}),
      video_info: {
        format: 'mp4', is_preview: 0, is_drm: 0,
        durl: [{ url, length: 1_200_000, account_token: 'private-account-token' }],
      },
    },
  };
}

function navigate(identity = 'ep1') {
  vi.stubGlobal('location', new URL(`https://www.bilibili.com/bangumi/play/${identity}`));
}

async function startBridge(initial?: unknown, nativeFetch = vi.fn(async () => new Response(JSON.stringify(playback(1))))) {
  const document = new FakeDocument();
  class FakeXhr extends EventTarget {
    status = 200;
    responseURL = PLAY_URL;
    responseType = '';
    response: unknown;
    responseText = '';
    opened: unknown[] = [];
    sent: unknown[] = [];
    open(...args: unknown[]) { this.opened = args; return 'opened'; }
    send(...args: unknown[]) { this.sent = args; return 'sent'; }
    complete(value: unknown, json = false) {
      this.responseType = json ? 'json' : '';
      this.response = value;
      this.responseText = json ? '' : typeof value === 'string' ? value : JSON.stringify(value);
      this.dispatchEvent(new Event('load'));
      this.dispatchEvent(new Event('loadend'));
    }
  }
  const window = Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    __playinfo__: initial,
    fetch: nativeFetch,
    XMLHttpRequest: FakeXhr,
    history: {
      pushState: vi.fn((_state: unknown, _unused: string, url?: string | URL | null) => {
        if (url) vi.stubGlobal('location', new URL(url, location.href));
        return 'pushed';
      }),
      replaceState: vi.fn((_state: unknown, _unused: string, url?: string | URL | null) => {
        if (url) vi.stubGlobal('location', new URL(url, location.href));
        return 'replaced';
      }),
    },
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  navigate();
  let definition: { main(): void; world: string; runAt: string } | undefined;
  vi.stubGlobal('defineContentScript', (value: typeof definition) => { definition = value; return value; });
  await import('../entrypoints/bilibili-player-bridge.content');
  if (!definition) throw new Error('The Bilibili bridge did not register.');
  definition.main();
  return { document, window, nativeFetch, definition };
}

beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Bilibili player bridge', () => {
  it('publishes only normalized playback fields from the current global player state', async () => {
    const { document, nativeFetch, definition } = await startBridge(playback(1));
    expect(definition).toMatchObject({ world: 'MAIN', runAt: 'document_start' });
    expect(document.bridge?.hidden).toBe(true);
    expect(document.state).toEqual({
      pageUrl: 'https://www.bilibili.com/bangumi/play/ep1',
      playback: {
        progressiveUrl: MEDIA_URL, durationSeconds: 1200,
        isPreview: false, hasContentProtection: false, episodeId: 1,
      },
    });
    expect(document.bridge!.textContent).not.toContain('private-');
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it('returns the original fetch promise and leaves its request and response usable', async () => {
    const response = new Response(JSON.stringify(playback(1)));
    const pending = Promise.resolve(response);
    const nativeFetch = vi.fn(() => pending);
    const { document, window } = await startBridge(undefined, nativeFetch);
    const input = new Request(PLAY_URL, { method: 'POST', body: 'player-request' });
    const init = { credentials: 'include' as const };
    const fetch = window.fetch as unknown as typeof globalThis.fetch;
    const result = fetch.call(window, input, init);
    expect(result).toBe(pending);
    expect(nativeFetch).toHaveBeenCalledExactlyOnceWith(input, init);
    expect(nativeFetch.mock.contexts[0]).toBe(window);
    expect(await (await result).json()).toEqual(playback(1));
    expect(await input.text()).toBe('player-request');
    await vi.waitFor(() => expect(document.state?.playback.episodeId).toBe(1));
  });

  it('observes XHR text and JSON responses without changing open/send arguments', async () => {
    const { document, window } = await startBridge();
    const xhr = new window.XMLHttpRequest();
    expect(xhr.open('POST', PLAY_URL, true)).toBe('opened');
    const body = new Uint8Array([1, 2]);
    expect(xhr.send(body)).toBe('sent');
    expect(xhr.opened).toEqual(['POST', PLAY_URL, true]);
    expect(xhr.sent).toEqual([body]);
    xhr.complete(playback(1));
    expect(document.state.playback.progressiveUrl).toBe(MEDIA_URL);
    xhr.open('GET', PLAY_URL);
    xhr.send();
    xhr.complete(playback(1, 'https://video.bilivideo.com/refreshed.mp4'), true);
    expect(document.state.playback.progressiveUrl).toContain('refreshed.mp4');
    expect(document.bridge!.textContent).not.toContain('private-');
  });

  it('rejects other API domains, account endpoints and mismatched episode requests', async () => {
    const { document, window, nativeFetch } = await startBridge();
    const fetch = window.fetch as unknown as typeof globalThis.fetch;
    for (const url of [
      'https://api.bilibili.com.evil.example/pgc/player/web/playurl?ep_id=1',
      'https://api.bilibili.com/x/web-interface/nav',
      'https://api.bilibili.com/pgc/player/web/playurl?ep_id=2',
    ]) {
      await (await fetch.call(window, url)).text();
      const xhr = new window.XMLHttpRequest();
      xhr.responseURL = url;
      xhr.open('GET', url);
      xhr.send();
      xhr.complete(playback(1));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeFetch).toHaveBeenCalledTimes(3);
    expect(document.bridge).toBeUndefined();
  });

  it('does not associate an unchanged global object or late response with the next episode', async () => {
    let finish!: (response: Response) => void;
    const nativeFetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const { document, window } = await startBridge(playback(), nativeFetch);
    const fetch = window.fetch as unknown as typeof globalThis.fetch;
    const pending = fetch.call(window, PLAY_URL);
    const xhr = new window.XMLHttpRequest();
    xhr.open('GET', PLAY_URL);
    xhr.send();
    expect(window.history.pushState({}, '', '/bangumi/play/ep2')).toBe('pushed');
    expect(document.bridge).toBeUndefined();
    finish(new Response(JSON.stringify(playback(1))));
    await (await pending).text();
    xhr.complete(playback(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(document.bridge).toBeUndefined();

    window.__playinfo__ = playback(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(document.bridge).toBeUndefined();
    window.__playinfo__ = playback(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(document.state.playback.episodeId).toBe(2);
    expect(document.state.pageUrl).toContain('/ep2');
  });

  it('invalidates requests even when navigation returns to the same episode before they finish', async () => {
    let finish!: (response: Response) => void;
    const nativeFetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const { document, window } = await startBridge(undefined, nativeFetch);
    const fetch = window.fetch as unknown as typeof globalThis.fetch;
    const pending = fetch.call(window, PLAY_URL);
    window.history.pushState({}, '', '/bangumi/play/ep2');
    window.history.replaceState({}, '', '/bangumi/play/ep1');
    finish(new Response(JSON.stringify(playback(1))));
    await (await pending).text();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.bridge).toBeUndefined();
  });

  it('limits cloned fetch bodies and XHR snapshots while leaving the original response readable', async () => {
    const oversized = `${JSON.stringify(playback(1)).slice(0, -1)},"padding":"${'x'.repeat(MAX_BYTES)}"}`;
    const response = new Response(oversized);
    const nativeFetch = vi.fn(async () => response);
    const { document, window } = await startBridge(undefined, nativeFetch);
    const fetch = window.fetch as unknown as typeof globalThis.fetch;
    expect(await (await fetch.call(window, PLAY_URL)).text()).toBe(oversized);
    await vi.advanceTimersByTimeAsync(50);
    expect(document.bridge).toBeUndefined();
    const xhr = new window.XMLHttpRequest();
    xhr.open('GET', PLAY_URL);
    xhr.send();
    xhr.complete(oversized);
    expect(document.bridge).toBeUndefined();
  });

  it('skips clones whose declared content length exceeds the cap', async () => {
    const response = new Response(JSON.stringify(playback(1)), {
      headers: { 'Content-Length': String(MAX_BYTES + 1) },
    });
    const clone = vi.spyOn(response, 'clone');
    const { document, window } = await startBridge(undefined, vi.fn(async () => response));
    const fetch = window.fetch as unknown as typeof globalThis.fetch;
    await fetch.call(window, PLAY_URL);
    await vi.advanceTimersByTimeAsync(0);
    expect(clone).not.toHaveBeenCalled();
    expect(document.bridge).toBeUndefined();
  });

  it('clears publication and polling on pagehide and restores a single timer on pageshow', async () => {
    const { document, window } = await startBridge(playback(1));
    window.dispatchEvent(new Event('pagehide'));
    expect(document.bridge).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    window.dispatchEvent(new Event('pageshow'));
    window.dispatchEvent(new Event('pageshow'));
    expect(document.state.playback.episodeId).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    window.history.pushState({}, '', '/');
    await vi.advanceTimersByTimeAsync(500);
    expect(document.bridge).toBeUndefined();
    window.history.pushState({}, '', '/bangumi/play/ep2');
    window.__playinfo__ = playback(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(document.state.playback.episodeId).toBe(2);
  });
});
