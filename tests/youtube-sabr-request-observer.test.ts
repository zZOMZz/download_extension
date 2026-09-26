import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installYouTubeSabrRequestObserver,
  MAX_YOUTUBE_SABR_REQUEST_BYTES,
  readYouTubeSabrRequestMessage,
  YOUTUBE_SABR_REQUEST_MESSAGE,
} from '../src/core/site-adapters/youtube/sabr-request-observer';

const videoId = 'jUNz-uTF--E';
const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
const mediaUrl = 'https://rr1.googlevideo.com/videoplayback?id=media-resource&sabr=1';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(nativeFetch = vi.fn<typeof fetch>(() => Promise.resolve(new Response('untouched')))) {
  class FakeXhr {
    readonly openCall = vi.fn();
    readonly sendCall = vi.fn();
    open(...args: unknown[]) { this.openCall(...args); }
    send(body: unknown) { this.sendCall(body); }
  }
  const page = Object.assign(new EventTarget(), {
    fetch: nativeFetch,
    XMLHttpRequest: FakeXhr,
    postMessage: vi.fn(),
  });
  vi.stubGlobal('window', page);
  vi.stubGlobal('location', new URL(pageUrl));
  installYouTubeSabrRequestObserver();
  return { page, nativeFetch, FakeXhr };
}

afterEach(() => vi.unstubAllGlobals());

describe('YouTube playback request observation', () => {
  it('preserves the fetch promise, response, arguments and typed-array byte range', async () => {
    let complete!: (response: Response) => void;
    const nativePromise = new Promise<Response>((resolve) => { complete = resolve; });
    const { page, nativeFetch } = setup(vi.fn<typeof fetch>(() => nativePromise));
    const buffer = new Uint8Array([99, 1, 2, 3, 88]);
    const body = new Uint8Array(buffer.buffer, 1, 3);
    const init = { method: 'POST', body };
    const returned = page.fetch(mediaUrl, init);
    expect(returned).toBe(nativePromise);
    expect(nativeFetch).toHaveBeenCalledWith(mediaUrl, init);
    expect(nativeFetch.mock.contexts[0]).toBe(page);
    body[0] = 42;
    expect(page.postMessage).not.toHaveBeenCalled();
    const response = new Response('original response');
    complete(response);
    expect(await returned).toBe(response);
    await flush();
    expect(await response.text()).toBe('original response');
    expect(page.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: YOUTUBE_SABR_REQUEST_MESSAGE, url: mediaUrl, videoId, bodyBase64: 'AQID',
    }, 'https://www.youtube.com');
  });

  it('reads a Request clone without consuming the original request body', async () => {
    const { page } = setup();
    const request = new Request(mediaUrl, { method: 'POST', body: new Uint8Array([4, 5, 6]) });
    await page.fetch(request);
    await flush();
    expect(request.bodyUsed).toBe(false);
    expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([4, 5, 6]);
    expect(page.postMessage.mock.calls[0]?.[0]).toMatchObject({ bodyBase64: 'BAUG' });
  });

  it('calls native XHR send immediately and ignores a Blob copy after same-video navigation', async () => {
    const { page, FakeXhr } = setup();
    let complete!: (buffer: ArrayBuffer) => void;
    const blob = new Blob([new Uint8Array([7, 8, 9])]);
    vi.spyOn(blob, 'arrayBuffer').mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const xhr = new FakeXhr();
    xhr.open('POST', mediaUrl, true);
    xhr.send(blob);
    expect(xhr.sendCall).toHaveBeenCalledExactlyOnceWith(blob);
    page.dispatchEvent(new Event('yt-navigate-start'));
    complete(new Uint8Array([7, 8, 9]).buffer);
    await flush();
    expect(page.postMessage).not.toHaveBeenCalled();
  });

  it('observes XHR ArrayBuffers while retaining native open/send arguments', async () => {
    const { page, FakeXhr } = setup();
    const xhr = new FakeXhr();
    const body = new Uint8Array([10, 11, 12]).buffer;
    xhr.open('POST', mediaUrl, false, 'user', 'pass');
    xhr.send(body);
    expect(xhr.openCall).toHaveBeenCalledExactlyOnceWith('POST', mediaUrl, false, 'user', 'pass');
    expect(xhr.sendCall).toHaveBeenCalledExactlyOnceWith(body);
    await flush();
    expect(page.postMessage.mock.calls[0]?.[0]).toMatchObject({ bodyBase64: 'CgsM' });
  });

  it('skips oversized and non-playback requests without preventing fetch', async () => {
    const { page, nativeFetch } = setup();
    await page.fetch(mediaUrl, { method: 'POST', body: new Uint8Array(MAX_YOUTUBE_SABR_REQUEST_BYTES + 1) });
    await page.fetch('https://example.com/videoplayback?id=media', { method: 'POST', body: new Uint8Array([1]) });
    await page.fetch(mediaUrl, { method: 'GET' });
    await flush();
    expect(nativeFetch).toHaveBeenCalledTimes(3);
    expect(page.postMessage).not.toHaveBeenCalled();
  });

  it('drops a copied fetch body when the active video changes before the response arrives', async () => {
    let complete!: (response: Response) => void;
    const { page } = setup(vi.fn<typeof fetch>(() => new Promise((resolve) => { complete = resolve; })));
    const request = page.fetch(mediaUrl, { method: 'POST', body: new Uint8Array([1]) });
    vi.stubGlobal('location', new URL('https://www.youtube.com/watch?v=GwUwyWGHmGY'));
    complete(new Response());
    await request;
    await flush();
    expect(page.postMessage).not.toHaveBeenCalled();
  });
});

describe('YouTube page message boundary', () => {
  const page = {} as Window;
  const valid = { source: page, origin: 'https://www.youtube.com', data: {
    type: YOUTUBE_SABR_REQUEST_MESSAGE, url: mediaUrl, videoId, bodyBase64: 'AQID',
  } };

  it('accepts the current page playback envelope', () => {
    expect(readYouTubeSabrRequestMessage(valid, page, pageUrl)).toEqual({ url: mediaUrl, videoId, bodyBase64: 'AQID' });
  });

  it.each([
    { ...valid, source: {} as Window },
    { ...valid, origin: 'https://evil.example' },
    { ...valid, data: { ...valid.data, videoId: 'GwUwyWGHmGY' } },
    { ...valid, data: { ...valid.data, url: 'https://rr1.googlevideo.com.evil.example/videoplayback?id=media' } },
    { ...valid, data: { ...valid.data, bodyBase64: 'not valid base64' } },
    { ...valid, data: { ...valid.data, bodyBase64: 'A'.repeat(349_532) } },
  ])('rejects mismatched sources, identities, endpoints or body sizes', (event) => {
    expect(readYouTubeSabrRequestMessage(event, page, pageUrl)).toBeUndefined();
  });

  it('does not forward requests from a non-watch page', () => {
    expect(readYouTubeSabrRequestMessage(valid, page, 'https://www.youtube.com/')).toBeUndefined();
  });
});
