import { VideoPlaybackAbrRequest, type ClientInfo } from 'googlevideo/protos';
import { browser } from 'wxt/browser';

export interface YoutubeSabrRuntimeContext {
  serverAbrStreamingUrl: string;
  videoPlaybackUstreamerConfig: string;
  poToken?: string;
  clientInfo?: ClientInfo;
}

interface CapturedContext {
  tabId: number;
  mediaId: string;
  capturedAt: number;
  context: YoutubeSabrRuntimeContext;
}

interface ObservedRequest {
  tabId: number;
  method: string;
  url: string;
  initiator?: string | undefined;
  requestBody?: {
    error?: string | undefined;
    raw?: Array<{ bytes?: ArrayBuffer | undefined; file?: string | undefined }> | undefined;
  } | null | undefined;
}

interface ObservedPlaybackRequest {
  tabId: number;
  mediaId: string;
  url: string;
  at: number;
}

const STORAGE_KEY = 'youtube-sabr-contexts';
const OBSERVED_REQUESTS_KEY = 'youtube-sabr-observed-requests';
const MAX_CONTEXTS = 32;
const MAX_AGE_MS = 5 * 60 * 1_000;
const MAX_BODY_BYTES = 256 * 1_024;
const MAX_CONFIG_BYTES = 64 * 1_024;
const MAX_TOKEN_BYTES = 16 * 1_024;
const MAX_URL_LENGTH = 16 * 1_024;
const MAX_CLIENT_INFO_LENGTH = 16 * 1_024;
let pending: Promise<void> = Promise.resolve();

function mediaIdFromUrl(value: string): string | null {
  if (value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com') ||
        url.pathname !== '/videoplayback' || url.username || url.password ||
        (url.port && url.port !== '443') || url.searchParams.getAll('id').length !== 1) return null;
    const id = url.searchParams.get('id');
    return id && id.length <= 256 ? id : null;
  } catch {
    return null;
  }
}

function isYoutubeInitiator(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (!url.port || url.port === '443') &&
      (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'));
  } catch {
    return false;
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < value.length; offset += 8_192) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function isBoundedClientInfo(value: unknown): value is ClientInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    return JSON.stringify(value).length <= MAX_CLIENT_INFO_LENGTH;
  } catch {
    return false;
  }
}

/** Decode only the fields needed to reuse playback already authorized in the source tab. */
export function decodeYoutubeSabrRequest(
  details: ObservedRequest,
  now = Date.now(),
): CapturedContext | null {
  if (!Number.isInteger(details.tabId) || details.tabId < 0 || details.method !== 'POST' ||
      !isYoutubeInitiator(details.initiator) || details.requestBody?.error) return null;
  const mediaId = mediaIdFromUrl(details.url);
  const raw = details.requestBody?.raw;
  if (!mediaId || !raw?.length || raw.length > 256) return null;

  let size = 0;
  for (const part of raw) {
    if (part.file !== undefined || !(part.bytes instanceof ArrayBuffer)) return null;
    size += part.bytes.byteLength;
    if (size > MAX_BODY_BYTES) return null;
  }
  if (!size) return null;
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of raw) {
    body.set(new Uint8Array(part.bytes!), offset);
    offset += part.bytes!.byteLength;
  }

  try {
    const request = VideoPlaybackAbrRequest.decode(body);
    const config = request.videoPlaybackUstreamerConfig;
    const poToken = request.streamerContext?.poToken;
    const clientInfo = request.streamerContext?.clientInfo;
    if (!config?.length || config.length > MAX_CONFIG_BYTES ||
        (poToken && poToken.length > MAX_TOKEN_BYTES) ||
        (clientInfo && !isBoundedClientInfo(clientInfo))) return null;
    return {
      tabId: details.tabId,
      mediaId,
      capturedAt: now,
      context: {
        serverAbrStreamingUrl: details.url,
        videoPlaybackUstreamerConfig: encodeBase64(config),
        ...(poToken?.length ? { poToken: encodeBase64(poToken) } : {}),
        ...(clientInfo ? { clientInfo } : {}),
      },
    };
  } catch {
    // Malformed or unrelated request bodies must not interrupt normal playback.
    return null;
  }
}

function isStoredContext(value: unknown, now: number): value is CapturedContext {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CapturedContext>;
  const context = entry.context;
  if (!Number.isInteger(entry.tabId) || entry.tabId! < 0 ||
      typeof entry.mediaId !== 'string' || typeof entry.capturedAt !== 'number' ||
      !Number.isFinite(entry.capturedAt) || entry.capturedAt > now ||
      now - entry.capturedAt >= MAX_AGE_MS || !context || typeof context !== 'object' ||
      typeof context.serverAbrStreamingUrl !== 'string' ||
      mediaIdFromUrl(context.serverAbrStreamingUrl) !== entry.mediaId ||
      typeof context.videoPlaybackUstreamerConfig !== 'string' ||
      !context.videoPlaybackUstreamerConfig.length ||
      context.videoPlaybackUstreamerConfig.length > Math.ceil(MAX_CONFIG_BYTES / 3) * 4 ||
      (context.poToken !== undefined && (typeof context.poToken !== 'string' ||
        context.poToken.length > Math.ceil(MAX_TOKEN_BYTES / 3) * 4)) ||
      (context.clientInfo !== undefined && !isBoundedClientInfo(context.clientInfo))) {
    return false;
  }
  return true;
}

async function readContexts(): Promise<CapturedContext[]> {
  const stored = (await browser.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
  if (!Array.isArray(stored)) return [];
  const now = Date.now();
  return stored.filter((value) => isStoredContext(value, now))
    .sort((left, right) => right.capturedAt - left.capturedAt).slice(0, MAX_CONTEXTS);
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation, operation);
  pending = result.then(() => {}, () => {});
  return result;
}

async function readObservedRequests(): Promise<ObservedPlaybackRequest[]> {
  const stored = (await browser.storage.session.get(OBSERVED_REQUESTS_KEY))[OBSERVED_REQUESTS_KEY];
  if (!Array.isArray(stored)) return [];
  const now = Date.now();
  return stored.filter((entry): entry is ObservedPlaybackRequest =>
    !!entry && typeof entry === 'object' && Number.isInteger(entry.tabId) && entry.tabId >= 0 &&
    typeof entry.url === 'string' && typeof entry.mediaId === 'string' &&
    mediaIdFromUrl(entry.url) === entry.mediaId &&
    typeof entry.at === 'number' && entry.at <= now && now - entry.at < MAX_AGE_MS)
    .slice(0, MAX_CONTEXTS);
}

async function storeCapturedContext(captured: CapturedContext): Promise<void> {
  const contexts = await readContexts();
  const previous = contexts.find(({ tabId, mediaId }) =>
    tabId === captured.tabId && mediaId === captured.mediaId);
  if (previous) captured.context = { ...previous.context, ...captured.context };
  const remaining = contexts.filter(({ tabId, mediaId }) =>
    tabId !== captured.tabId || mediaId !== captured.mediaId);
  // Session storage survives MV3 worker restarts; its default access is TRUSTED_CONTEXTS.
  // Keep authorization context out of candidates, content scripts, and persistent storage.
  await browser.storage.session.set({
    [STORAGE_KEY]: [captured, ...remaining].slice(0, MAX_CONTEXTS),
  });
}

export function captureYoutubeSabrContext(details: ObservedRequest): Promise<void> {
  const mediaId = mediaIdFromUrl(details.url);
  if (!Number.isInteger(details.tabId) || details.tabId < 0 || details.method !== 'POST' ||
      !isYoutubeInitiator(details.initiator) || !mediaId) return Promise.resolve();
  const at = Date.now();
  const captured = decodeYoutubeSabrRequest(details, at);
  return enqueue(async () => {
    // Chrome may withhold upload bytes; retain independently observed routing data
    // so the page bridge can supply those bytes without choosing the destination.
    const previousRequests = await readObservedRequests();
    await browser.storage.session.set({ [OBSERVED_REQUESTS_KEY]: [{
      tabId: details.tabId, mediaId, url: details.url, at,
    }, ...previousRequests.filter((entry) => entry.tabId !== details.tabId || entry.mediaId !== mediaId)]
      .slice(0, MAX_CONTEXTS) });
    if (captured) await storeCapturedContext(captured);
  });
}

export function clearYoutubeSabrContexts(tabId: number): Promise<void> {
  return enqueue(async () => {
    const observed = (await readObservedRequests()).filter((entry) => entry.tabId !== tabId);
    if (observed.length) await browser.storage.session.set({ [OBSERVED_REQUESTS_KEY]: observed });
    else await browser.storage.session.remove(OBSERVED_REQUESTS_KEY);
    const contexts = (await readContexts()).filter((entry) => entry.tabId !== tabId);
    if (contexts.length) {
      await browser.storage.session.set({ [STORAGE_KEY]: contexts });
    } else {
      await browser.storage.session.remove(STORAGE_KEY);
    }
  });
}

/** Accept page-world bytes only after independent network observation for this source tab. */
export async function acceptYoutubeSabrBridgeRequest(
  request: { url: string; videoId: string; bodyBase64: string },
  sender: {
    id?: string | undefined;
    url?: string | undefined;
    frameId?: number | undefined;
    tab?: { id?: number | undefined } | undefined;
  },
  extensionId: string,
): Promise<boolean> {
  const tabId = sender.tab?.id;
  if (sender.id !== extensionId || sender.frameId !== 0 || tabId === undefined || tabId < 0 ||
      !sender.url || !/^[\w-]{11}$/.test(request.videoId) ||
      !request.bodyBase64.length || request.bodyBase64.length > Math.ceil(MAX_BODY_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.bodyBase64)) return false;
  let sourcePage: URL;
  try {
    sourcePage = new URL(sender.url);
    if (!isYoutubeInitiator(sourcePage.origin) || sourcePage.pathname !== '/watch' ||
        sourcePage.searchParams.getAll('v').length !== 1 ||
        sourcePage.searchParams.get('v') !== request.videoId) return false;
  } catch { return false; }
  const mediaId = mediaIdFromUrl(request.url);
  if (!mediaId) return false;
  let observed: ObservedPlaybackRequest | undefined;
  // The page bridge can deliver its message just before Chrome's network event.
  for (let attempt = 0; attempt < 11; attempt++) {
    observed = await enqueue(async () => (await readObservedRequests()).find((entry) =>
      entry.tabId === tabId && entry.mediaId === mediaId));
    if (observed) break;
    if (attempt < 10) await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  if (!observed) return false;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(request.bodyBase64);
    if (binary.length > MAX_BODY_BYTES) return false;
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch { return false; }
  const observation: ObservedRequest = {
    tabId, method: 'POST', url: observed.url, initiator: sourcePage.origin,
    requestBody: { raw: [{ bytes: bytes.buffer }] },
  };
  const parsed = decodeYoutubeSabrRequest(observation);
  if (!parsed) return false;
  return enqueue(async () => {
    // Recheck after asynchronous parsing/navigation; bridge messages never extend
    // the lifetime of the independent network observation used for authorization.
    const stillObserved = (await readObservedRequests()).some((entry) =>
      entry.tabId === tabId && entry.mediaId === mediaId);
    if (!stillObserved) return false;
    await storeCapturedContext(parsed);
    return true;
  });
}

export function findYoutubeSabrContext(
  tabId: number,
  sourceServerAbrStreamingUrl: string,
): Promise<YoutubeSabrRuntimeContext | null> {
  const mediaId = mediaIdFromUrl(sourceServerAbrStreamingUrl);
  if (!mediaId || !Number.isInteger(tabId) || tabId < 0) return Promise.resolve(null);
  return enqueue(async () => {
    const contexts = await readContexts();
    // Also prune stale secrets when a download is requested after playback stopped.
    if (contexts.length) {
      await browser.storage.session.set({ [STORAGE_KEY]: contexts });
    } else {
      await browser.storage.session.remove(STORAGE_KEY);
    }
    return contexts.find((entry) => entry.tabId === tabId && entry.mediaId === mediaId)?.context ?? null;
  });
}

export function isYoutubeSabrContextSender(
  sender: { id?: string | undefined; url?: string | undefined },
  extensionId: string,
  downloaderUrl: string,
): boolean {
  if (sender.id !== extensionId || !sender.url) return false;
  try {
    const actual = new URL(sender.url);
    const expected = new URL(downloaderUrl);
    return actual.protocol === expected.protocol && actual.host === expected.host &&
      actual.pathname === expected.pathname && !actual.username && !actual.password;
  } catch {
    return false;
  }
}
