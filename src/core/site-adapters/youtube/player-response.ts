import {
  dashMediaSourceSchema,
  youtubeSabrFormatSchema,
  youtubeSabrSourceSchema,
  type DashByteRange,
  type DashMediaSource,
  type DashTrack,
  type YouTubeSabrFormat,
  type YouTubeSabrSource,
} from '../../../shared/media';

type JsonRecord = Record<string, unknown>;

export interface YouTubePlayerData {
  videoId: string;
  title: string;
  thumbnailUrl?: string;
  status: string;
  reason?: string;
  cipheredFormats: number;
  progressive?: YouTubeProgressiveMedia;
  dash?: DashMediaSource;
  youtubeSabr?: YouTubeSabrSource;
}

export interface YouTubeProgressiveMedia {
  id: string;
  url: string;
  mimeType: string;
  codecs?: string;
  bandwidth?: number;
  contentLength?: number;
  width?: number;
  height?: number;
}

export interface YouTubePlayerParseOptions {
  expectedVideoId?: string;
  observedMediaUrls?: readonly string[];
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = numberValue(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function playerThumbnail(details: JsonRecord | undefined): string | undefined {
  return asArray(asRecord(details?.thumbnail)?.thumbnails).map(asRecord)
    .filter((item): item is JsonRecord => Boolean(item))
    .sort((left, right) =>
      (positiveInteger(right.width) ?? 0) * (positiveInteger(right.height) ?? 0) -
      (positiveInteger(left.width) ?? 0) * (positiveInteger(left.height) ?? 0))
    .map((thumbnail) => text(thumbnail.url))
    .find((url) => {
      if (!url) return false;
      try { return new URL(url).protocol === 'https:'; } catch { return false; }
    });
}

export function isGoogleVideoUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' &&
      (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'));
  } catch {
    return false;
  }
}

function googleVideoUrl(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate || !isGoogleVideoUrl(candidate)) return undefined;
  return new URL(candidate).href;
}

function byteRange(value: unknown): DashByteRange | undefined {
  const range = asRecord(value);
  const start = numberValue(range?.start);
  const end = numberValue(range?.end);
  if (
    start === undefined ||
    end === undefined ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  ) {
    return undefined;
  }
  return { offset: start, length: end - start + 1 };
}

function formatBaseUrl(format: JsonRecord): { url?: string; ciphered: boolean } {
  const direct = googleVideoUrl(format.url);
  const cipher = text(format.signatureCipher ?? format.cipher);
  if (!cipher) return { ...(direct ? { url: direct } : {}), ciphered: false };
  const cipherUrl = googleVideoUrl(new URLSearchParams(cipher).get('url'));
  const resolvedUrl = direct ?? cipherUrl;
  return resolvedUrl ? { url: resolvedUrl, ciphered: true } : { ciphered: true };
}

function playbackIdentity(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (!isGoogleVideoUrl(url.href)) return undefined;
    const id = url.searchParams.get('id');
    const itag = url.searchParams.get('itag');
    return id && itag ? `${id}\u0000${itag}` : undefined;
  } catch {
    return undefined;
  }
}

function removeRawQueryParameter(rawUrl: string, parameter: string): string {
  const hashIndex = rawUrl.indexOf('#');
  const hash = hashIndex >= 0 ? rawUrl.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex < 0) return rawUrl;
  const prefix = withoutHash.slice(0, queryIndex);
  const parts = withoutHash.slice(queryIndex + 1).split('&').filter((part) => {
    const rawName = part.split('=', 1)[0] ?? '';
    try {
      return decodeURIComponent(rawName.replace(/\+/g, ' ')) !== parameter;
    } catch {
      return rawName !== parameter;
    }
  });
  return `${prefix}${parts.length ? `?${parts.join('&')}` : ''}${hash}`;
}

function reusableMediaUrl(rawUrl: string): string | undefined {
  if (!isGoogleVideoUrl(rawUrl)) return undefined;
  const url = new URL(rawUrl);
  const signedParameters = new Set([
    ...(url.searchParams.get('sparams') ?? '').split(','),
    ...(url.searchParams.get('lsparams') ?? '').split(','),
  ]);
  if (url.searchParams.has('range')) {
    if (signedParameters.has('range')) return undefined;
    return removeRawQueryParameter(url.href, 'range');
  }
  return url.href;
}

function observedUrlsByIdentity(rawUrls: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawUrl of rawUrls) {
    const reusable = reusableMediaUrl(rawUrl);
    const identity = reusable ? playbackIdentity(reusable) : undefined;
    if (identity && reusable) result.set(identity, reusable);
  }
  return result;
}

function playableFormatUrl(
  format: JsonRecord,
  observedUrls: ReadonlyMap<string, string>,
): { url?: string; ciphered: boolean } {
  const base = formatBaseUrl(format);
  if (!base.url) return base;
  const observed = observedUrls.get(playbackIdentity(base.url) ?? '');
  if (observed) return { url: observed, ciphered: base.ciphered };
  // The player must resolve signature ciphers and transform n before a URL is reusable.
  if (base.ciphered || new URL(base.url).searchParams.has('n')) {
    return { ciphered: base.ciphered };
  }
  const url = reusableMediaUrl(base.url);
  return { ...(url ? { url } : {}), ciphered: base.ciphered };
}

function mimeDetails(value: unknown): { kind: DashTrack['kind']; mimeType: string; codecs?: string } | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const match = /^(video|audio)\/mp4(?:\s*;\s*codecs="([^"]+)")?/i.exec(raw);
  if (!match?.[1]) return undefined;
  return {
    kind: match[1].toLowerCase() as DashTrack['kind'],
    mimeType: `${match[1].toLowerCase()}/mp4`,
    ...(match[2] ? { codecs: match[2] } : {}),
  };
}

function progressiveFormat(
  value: unknown,
  observedUrls: ReadonlyMap<string, string>,
): YouTubeProgressiveMedia | undefined {
  const format = asRecord(value);
  if (!format || asArray(format.drmFamilies).length || asArray(format.licenseInfos).length) {
    return undefined;
  }
  const id = stringValue(format.itag);
  const rawMimeType = text(format.mimeType);
  const mime = rawMimeType
    ? /^video\/mp4(?:\s*;\s*codecs="([^"]+)")?/i.exec(rawMimeType)
    : undefined;
  const codecs = mime?.[1];
  const codecNames = codecs?.toLowerCase() ?? '';
  const { url } = playableFormatUrl(format, observedUrls);
  if (!id || !mime || !url || !codecNames.includes('avc1') || !codecNames.includes('mp4a')) {
    return undefined;
  }
  const bandwidth = positiveInteger(format.bitrate ?? format.averageBitrate);
  const contentLength = positiveInteger(format.contentLength);
  const width = positiveInteger(format.width);
  const height = positiveInteger(format.height);
  return {
    id,
    url,
    mimeType: 'video/mp4',
    ...(codecs ? { codecs } : {}),
    ...(bandwidth === undefined ? {} : { bandwidth }),
    ...(contentLength === undefined ? {} : { contentLength }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

function parseTrack(
  value: unknown,
  observedUrls: ReadonlyMap<string, string>,
): { track?: DashTrack; ciphered: boolean } {
  const format = asRecord(value);
  if (!format || asArray(format.drmFamilies).length || asArray(format.licenseInfos).length) {
    return { ciphered: false };
  }
  const id = stringValue(format.itag);
  const mime = mimeDetails(format.mimeType);
  const initializationRange = byteRange(format.initRange);
  const indexRange = byteRange(format.indexRange);
  const base = playableFormatUrl(format, observedUrls);
  if (!id || !mime || !initializationRange || !indexRange || !base.url) {
    return { ciphered: base.ciphered };
  }
  const baseUrl = base.url;

  const bandwidth = positiveInteger(format.bitrate ?? format.averageBitrate);
  const width = positiveInteger(format.width);
  const height = positiveInteger(format.height);
  const frameRate = numberValue(format.fps);
  try {
    return {
      ciphered: base.ciphered,
      track: {
        id,
        kind: mime.kind,
        initialization: { url: baseUrl, byteRange: initializationRange },
        index: { url: baseUrl, byteRange: indexRange },
        ...(bandwidth === undefined ? {} : { bandwidth }),
        mimeType: mime.mimeType,
        ...(mime.codecs ? { codecs: mime.codecs } : {}),
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        ...(frameRate === undefined || frameRate <= 0 ? {} : { frameRate }),
      },
    };
  } catch {
    return { ciphered: base.ciphered };
  }
}

function sabrFormat(value: unknown, durationSeconds: number): YouTubeSabrFormat | undefined {
  const format = asRecord(value);
  if (!format || asArray(format.drmFamilies).length || asArray(format.licenseInfos).length) {
    return undefined;
  }
  const audioTrack = asRecord(format.audioTrack);
  const result = youtubeSabrFormatSchema.safeParse({
    itag: positiveInteger(format.itag),
    mimeType: text(format.mimeType),
    lastModified: stringValue(format.lastModified),
    bitrate: positiveInteger(format.bitrate ?? format.averageBitrate),
    approxDurationMs: positiveInteger(format.approxDurationMs) ?? durationSeconds * 1_000,
    width: positiveInteger(format.width),
    height: positiveInteger(format.height),
    fps: positiveInteger(format.fps),
    averageBitrate: positiveInteger(format.averageBitrate),
    contentLength: positiveInteger(format.contentLength),
    xtags: text(format.xtags),
    ...(text(audioTrack?.id) ? {
      audioTrack: {
        id: text(audioTrack?.id),
        displayName: text(audioTrack?.displayName),
        ...(typeof audioTrack?.audioIsDefault === 'boolean'
          ? { audioIsDefault: audioTrack.audioIsDefault }
          : {}),
      },
    } : {}),
  });
  return result.success ? result.data : undefined;
}

function sabrSource(
  streamingData: JsonRecord | undefined,
  videoId: string,
  durationSeconds: number | undefined,
): YouTubeSabrSource | undefined {
  if (!streamingData || !durationSeconds || durationSeconds <= 0) return undefined;
  const formats = asArray(streamingData.adaptiveFormats)
    .map((format) => sabrFormat(format, durationSeconds))
    .filter((format): format is YouTubeSabrFormat => Boolean(format));
  if (!formats.some(({ mimeType }) => mimeType.startsWith('video/')) ||
      !formats.some(({ mimeType }) => mimeType.startsWith('audio/'))) return undefined;
  const result = youtubeSabrSourceSchema.safeParse({
    videoId,
    durationSeconds,
    serverAbrStreamingUrl: text(streamingData.serverAbrStreamingUrl),
    formats,
  });
  return result.success ? result.data : undefined;
}

function jsonObjectAfterMarker(source: string, marker: string): JsonRecord | undefined {
  let markerIndex = source.indexOf(marker);
  while (markerIndex >= 0) {
    const start = source.indexOf('{', markerIndex + marker.length);
    if (start < 0) return undefined;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return asRecord(JSON.parse(source.slice(start, index + 1)));
          } catch {
            break;
          }
        }
      }
    }
    markerIndex = source.indexOf(marker, markerIndex + marker.length);
  }
  return undefined;
}

function playerResponseRecord(source: string): JsonRecord | undefined {
  const markers = [
    'var ytInitialPlayerResponse =',
    'window["ytInitialPlayerResponse"] =',
    "window['ytInitialPlayerResponse'] =",
    'ytInitialPlayerResponse =',
  ];
  for (const marker of markers) {
    const parsed = jsonObjectAfterMarker(source, marker);
    if (parsed && asRecord(parsed.playabilityStatus)) return parsed;
  }
  return undefined;
}

function parsePlayerResponse(
  response: JsonRecord,
  options: YouTubePlayerParseOptions,
): YouTubePlayerData | undefined {
  const details = asRecord(response.videoDetails);
  const playability = asRecord(response.playabilityStatus);
  const videoId = text(details?.videoId);
  const title = text(details?.title);
  const thumbnailUrl = playerThumbnail(details);
  const status = text(playability?.status);
  if (!videoId || !title || !status || (options.expectedVideoId && videoId !== options.expectedVideoId)) {
    return undefined;
  }
  const streamingData = asRecord(response.streamingData);
  const observed = observedUrlsByIdentity(options.observedMediaUrls ?? []);
  const duration = numberValue(details?.lengthSeconds);
  const isLive = details?.isLiveContent === true;
  const canDownload = status === 'OK' && !isLive;
  const progressive = asArray(canDownload ? streamingData?.formats : undefined)
    .map((format) => progressiveFormat(format, observed))
    .filter((format): format is YouTubeProgressiveMedia => Boolean(format))
    .sort((left, right) =>
      (right.height ?? 0) - (left.height ?? 0) ||
      (right.bandwidth ?? 0) - (left.bandwidth ?? 0))[0];
  const parsedTracks = asArray(streamingData?.adaptiveFormats).map((format) => parseTrack(format, observed));
  const tracks = parsedTracks.flatMap(({ track }) => track ? [track] : []);
  const cipheredFormats = parsedTracks.filter(({ ciphered }) => ciphered).length;
  const hasVideo = tracks.some(({ kind }) => kind === 'video');
  const hasAudio = tracks.some(({ kind }) => kind === 'audio');
  const dash = canDownload && hasVideo && hasAudio
    ? dashMediaSourceSchema.parse({
        type: 'static',
        ...(duration === undefined || duration < 0 ? {} : { durationSeconds: duration }),
        hasContentProtection: false,
        tracks,
      })
    : undefined;
  const youtubeSabr = canDownload ? sabrSource(streamingData, videoId, duration) : undefined;
  const reason = text(playability?.reason);
  return {
    videoId,
    title,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    status,
    ...(reason ? { reason } : {}),
    cipheredFormats,
    ...(progressive ? { progressive } : {}),
    ...(dash ? { dash } : {}),
    ...(youtubeSabr ? { youtubeSabr } : {}),
  };
}

export function parseYouTubePlayerResponse(
  source: string,
  options: YouTubePlayerParseOptions = {},
): YouTubePlayerData | undefined {
  const response = playerResponseRecord(source);
  return response ? parsePlayerResponse(response, options) : undefined;
}

export function parseYouTubePlayerResponseDocument(
  document: Document,
  options: YouTubePlayerParseOptions = {},
): YouTubePlayerData | undefined {
  const observedMediaUrls = options.observedMediaUrls ?? document.defaultView?.performance
    .getEntriesByType('resource')
    .map(({ name }) => name) ?? [];
  let fallback: YouTubePlayerData | undefined;
  let progressive: YouTubePlayerData | undefined;
  let sabr: YouTubePlayerData | undefined;
  const bridgeElements = new Set(Array.from(document.querySelectorAll(
    '[data-open-media-downloader-youtube-player]',
  )).reverse());
  const sources = new Set([
    ...bridgeElements,
    ...Array.from(document.querySelectorAll('script')).reverse(),
  ]);
  for (const element of sources) {
    let parsed: YouTubePlayerData | undefined;
    if (bridgeElements.has(element)) {
      try {
        const response = asRecord(JSON.parse(element.textContent ?? ''));
        parsed = response ? parsePlayerResponse(response, {
          ...options,
          observedMediaUrls: [
            ...asArray(response.resolvedMediaUrls).filter((url): url is string => typeof url === 'string'),
            ...observedMediaUrls,
          ],
        }) : undefined;
      } catch {
        // Fall through to regular page scripts when the bridge payload is incomplete.
      }
    }
    parsed ??= parseYouTubePlayerResponse(element.textContent ?? '', {
      ...options,
      observedMediaUrls,
    });
    if (parsed?.dash) return parsed;
    if (parsed?.youtubeSabr) sabr ??= parsed;
    if (parsed?.progressive) progressive ??= parsed;
    fallback ??= parsed;
  }
  return sabr ?? progressive ?? fallback;
}
