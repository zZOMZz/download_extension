export const YOUTUBE_SABR_REQUEST_MESSAGE = 'open-media-downloader:youtube-sabr-request';
export const MAX_YOUTUBE_SABR_REQUEST_BYTES = 256 * 1_024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_YOUTUBE_SABR_REQUEST_BYTES / 3) * 4;

interface RequestObservation {
  url: string;
  videoId: string;
  bodyBase64: string;
}

function watchVideoId(pageUrl: string): string | undefined {
  try {
    const url = new URL(pageUrl);
    const id = url.searchParams.get('v') ?? '';
    return url.protocol === 'https:' && ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) &&
      url.pathname === '/watch' && /^[\w-]{11}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

function mediaRequestUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && url.hostname.endsWith('.googlevideo.com') &&
      url.pathname === '/videoplayback' && Boolean(url.searchParams.get('id')) && rawUrl.length <= 32_768
      ? url.href : undefined;
  } catch { return undefined; }
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

async function readRequestClone(request: Request): Promise<Uint8Array | undefined> {
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_YOUTUBE_SABR_REQUEST_BYTES) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(result.value);
    }
    if (!size) return undefined;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { reader.releaseLock(); }
}

function copyBody(body: unknown): Promise<Uint8Array | undefined> | undefined {
  if (body instanceof ArrayBuffer) {
    return Promise.resolve(body.byteLength > 0 && body.byteLength <= MAX_YOUTUBE_SABR_REQUEST_BYTES
      ? new Uint8Array(body.slice(0)) : undefined);
  }
  if (ArrayBuffer.isView(body)) {
    return Promise.resolve(body.byteLength > 0 && body.byteLength <= MAX_YOUTUBE_SABR_REQUEST_BYTES
      ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice() : undefined);
  }
  if (body instanceof Blob && body.size > 0 && body.size <= MAX_YOUTUBE_SABR_REQUEST_BYTES) {
    return body.arrayBuffer().then((bytes) => new Uint8Array(bytes));
  }
  return undefined;
}

/** Observe only already dispatched playback requests without changing their body or response. */
export function installYouTubeSabrRequestObserver(): void {
  let generation = 0;
  const invalidate = () => { generation += 1; };
  for (const event of ['yt-navigate-start', 'popstate', 'pagehide']) window.addEventListener(event, invalidate);

  const context = (rawUrl: string, method: string) => {
    if (method.toUpperCase() !== 'POST') return undefined;
    const videoId = watchVideoId(location.href);
    const url = mediaRequestUrl(rawUrl);
    return videoId && url ? { videoId, url, generation, origin: location.origin } : undefined;
  };
  const publish = (snapshot: NonNullable<ReturnType<typeof context>>, bytes: Uint8Array | undefined) => {
    if (!bytes?.length || bytes.length > MAX_YOUTUBE_SABR_REQUEST_BYTES || generation !== snapshot.generation || watchVideoId(location.href) !== snapshot.videoId ||
        location.origin !== snapshot.origin) return;
    window.postMessage({ type: YOUTUBE_SABR_REQUEST_MESSAGE, url: snapshot.url, videoId: snapshot.videoId,
      bodyBase64: encodeBytes(bytes) }, snapshot.origin);
  };

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (this: typeof window, input: RequestInfo | URL, init?: RequestInit) {
      let snapshot: ReturnType<typeof context>;
      let copied: Promise<Uint8Array | undefined> | undefined;
      try {
        const request = input instanceof Request ? input : undefined;
        snapshot = context(request?.url ?? String(input), init?.method ?? request?.method ?? 'GET');
        if (snapshot) {
          copied = init?.body != null ? copyBody(init.body) : request
            ? readRequestClone(request.clone()) : undefined;
          // A failed clone or unsupported body must never affect the player's request.
          copied = copied?.catch(() => undefined);
        }
      } catch { /* Observation is best-effort. */ }
      const response = Reflect.apply(nativeFetch, this, [input, init]) as Promise<Response>;
      if (snapshot && copied) {
        const captured = snapshot;
        void Promise.all([response, copied]).then(([, bytes]) => publish(captured, bytes)).catch(() => {});
      }
      return response;
    };
  }

  const prototype = window.XMLHttpRequest?.prototype;
  if (!prototype) return;
  const nativeOpen = prototype.open;
  const nativeSend = prototype.send;
  const requests = new WeakMap<XMLHttpRequest, { url: string; method: string }>();
  prototype.open = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
    const result = Reflect.apply(nativeOpen, this, args);
    try { requests.set(this, { method: args[0], url: String(args[1]) }); } catch { requests.delete(this); }
    return result;
  } as XMLHttpRequest['open'];
  prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    let snapshot: ReturnType<typeof context>;
    let copied: Promise<Uint8Array | undefined> | undefined;
    try {
      const request = requests.get(this);
      snapshot = request ? context(request.url, request.method) : undefined;
      if (snapshot) copied = copyBody(body)?.catch(() => undefined);
    } catch { /* Observation is best-effort. */ }
    const result = Reflect.apply(nativeSend, this, [body]);
    if (snapshot && copied) {
      const captured = snapshot;
      void copied.then((bytes) => publish(captured, bytes)).catch(() => {});
    }
    return result;
  };
}

/** Validate the page-to-isolated-world envelope; the background independently verifies the real request. */
export function readYouTubeSabrRequestMessage(
  event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  pageWindow: Window,
  pageUrl: string,
): RequestObservation | undefined {
  const videoId = watchVideoId(pageUrl);
  if (!videoId || event.source !== pageWindow || event.origin !== new URL(pageUrl).origin) return undefined;
  const data = event.data as Record<string, unknown> | null;
  if (!data || data.type !== YOUTUBE_SABR_REQUEST_MESSAGE || data.videoId !== videoId ||
      typeof data.url !== 'string' || typeof data.bodyBase64 !== 'string' ||
      !data.bodyBase64.length || data.bodyBase64.length > MAX_BASE64_LENGTH) return undefined;
  const url = mediaRequestUrl(data.url);
  if (!url || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.bodyBase64)) return undefined;
  try {
    const size = atob(data.bodyBase64).length;
    if (!size || size > MAX_YOUTUBE_SABR_REQUEST_BYTES) return undefined;
  } catch { return undefined; }
  return { url, videoId, bodyBase64: data.bodyBase64 };
}
