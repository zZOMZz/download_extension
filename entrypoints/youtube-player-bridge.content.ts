import { resolveYouTubePlayerUrl } from '../src/core/site-adapters/youtube/player-url-resolver';
import { installYouTubeSabrRequestObserver } from '../src/core/site-adapters/youtube/sabr-request-observer';

interface YouTubePlayerWindow extends Window {
  _yt_player?: unknown;
  ytInitialPlayerResponse?: unknown;
  ytplayer?: {
    bootstrapPlayerResponse?: unknown;
    config?: { args?: { raw_player_response?: unknown } };
  };
}

interface YouTubePlayerElement extends HTMLElement {
  getPlayerResponse?: () => unknown;
}

const BRIDGE_ATTRIBUTE = 'data-open-media-downloader-youtube-player';
const PUBLISH_INTERVAL_MS = 250;
const MAX_PUBLISH_ATTEMPTS = 40;
const REFRESH_INTERVAL_MS = 5_000;
let publishGeneration = 0;
let publishTimer: number | undefined;
let playerSourceUrl: string | undefined;
let playerSource: string | undefined;
let loadingPlayerSource = false;
const resolvedUrls = new Map<string, string>();

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function isYouTubeWatchPage(): boolean {
  return location.protocol === 'https:' &&
    ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(location.hostname) &&
    location.pathname === '/watch' &&
    /^[0-9A-Za-z_-]{11}$/.test(new URLSearchParams(location.search).get('v') ?? '');
}

function currentVideoId(): string | undefined {
  const videoId = new URLSearchParams(location.search).get('v') ?? '';
  return /^[0-9A-Za-z_-]{11}$/.test(videoId) ? videoId : undefined;
}

function playerElementResponse(): unknown {
  const player = document.getElementById('movie_player') as YouTubePlayerElement | null;
  try {
    return player?.getPlayerResponse?.();
  } catch {
    return undefined;
  }
}

function currentPlayerResponse(): unknown {
  const pageWindow = window as YouTubePlayerWindow;
  const candidates = [
    playerElementResponse(),
    pageWindow.ytplayer?.config?.args?.raw_player_response,
    pageWindow.ytplayer?.bootstrapPlayerResponse,
    pageWindow.ytInitialPlayerResponse,
  ];
  const expectedVideoId = currentVideoId();
  let fallback: JsonRecord | undefined;
  for (const candidate of candidates) {
    let parsed = candidate;
    if (typeof candidate === 'string') {
      try {
        parsed = JSON.parse(candidate) as unknown;
      } catch {
        continue;
      }
    }
    const response = asRecord(parsed);
    const details = asRecord(response?.videoDetails);
    if (!response || (expectedVideoId && details?.videoId !== expectedVideoId)) continue;
    fallback ??= response;
    const streamingData = asRecord(response.streamingData);
    if (Array.isArray(streamingData?.adaptiveFormats) && streamingData.adaptiveFormats.length) {
      return response;
    }
  }
  return fallback;
}

function playerSnapshot(value: unknown): { value: JsonRecord; hasFormats: boolean } | undefined {
  const response = asRecord(value);
  const playability = asRecord(response?.playabilityStatus);
  const details = asRecord(response?.videoDetails);
  const streamingData = asRecord(response?.streamingData);
  if (!response || !playability || !details) return undefined;
  const formats = Array.isArray(streamingData?.formats)
    ? streamingData.formats.map(asRecord).filter((format): format is JsonRecord => Boolean(format))
    : [];
  const adaptiveFormats = Array.isArray(streamingData?.adaptiveFormats)
    ? streamingData.adaptiveFormats.map(asRecord).filter((format): format is JsonRecord => Boolean(format))
    : [];
  return {
    hasFormats: adaptiveFormats.length > 0 || formats.length > 0,
    value: {
      playabilityStatus: {
        status: playability.status,
        reason: playability.reason,
      },
      videoDetails: {
        videoId: details.videoId,
        title: details.title,
        lengthSeconds: details.lengthSeconds,
        isLiveContent: details.isLiveContent,
        thumbnail: {
          thumbnails: Array.isArray(asRecord(details.thumbnail)?.thumbnails)
            ? (asRecord(details.thumbnail)!.thumbnails as unknown[]).map(asRecord)
              .filter((thumbnail): thumbnail is JsonRecord => Boolean(thumbnail))
              .map(({ url, width, height }) => ({ url, width, height }))
            : [],
        },
      },
      streamingData: {
        serverAbrStreamingUrl: streamingData?.serverAbrStreamingUrl,
        formats: formats.map((format) => ({
          itag: format.itag,
          mimeType: format.mimeType,
          bitrate: format.bitrate,
          averageBitrate: format.averageBitrate,
          contentLength: format.contentLength,
          width: format.width,
          height: format.height,
          url: format.url,
          signatureCipher: format.signatureCipher,
          cipher: format.cipher,
          drmFamilies: format.drmFamilies,
          licenseInfos: format.licenseInfos,
        })),
        adaptiveFormats: adaptiveFormats.map((format) => ({
          itag: format.itag,
          mimeType: format.mimeType,
          bitrate: format.bitrate,
          averageBitrate: format.averageBitrate,
          width: format.width,
          height: format.height,
          fps: format.fps,
          contentLength: format.contentLength,
          lastModified: format.lastModified,
          approxDurationMs: format.approxDurationMs,
          xtags: format.xtags,
          ...(asRecord(format.audioTrack) ? {
            audioTrack: {
              id: asRecord(format.audioTrack)?.id,
              displayName: asRecord(format.audioTrack)?.displayName,
              audioIsDefault: asRecord(format.audioTrack)?.audioIsDefault,
            },
          } : {}),
          initRange: format.initRange,
          indexRange: format.indexRange,
          url: format.url,
          signatureCipher: format.signatureCipher,
          cipher: format.cipher,
          drmFamilies: format.drmFamilies,
          licenseInfos: format.licenseInfos,
        })),
      },
    },
  };
}

function resolvePlayerUrls(snapshot: JsonRecord): string[] {
  const streamingData = asRecord(snapshot.streamingData);
  const formats = [
    ...(Array.isArray(streamingData?.formats) ? streamingData.formats : []),
    ...(Array.isArray(streamingData?.adaptiveFormats) ? streamingData.adaptiveFormats : []),
  ].map(asRecord);
  const urls = formats.flatMap((format) => {
    if (typeof format?.url !== 'string' || format.signatureCipher || format.cipher) return [];
    try {
      const url = new URL(format.url);
      return url.protocol === 'https:' && url.hostname.endsWith('.googlevideo.com') &&
        url.pathname === '/videoplayback' && url.searchParams.has('n') ? [format.url] : [];
    } catch {
      return [];
    }
  });
  if (!urls.length) return [];

  // Read the already loaded player's source only to locate its exported URL class.
  // The source is never evaluated; the official in-page player performs the transform.
  const scriptUrl = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))
    .reverse()
    .map(({ src }) => src)
    .find((src) => {
      try {
        const url = new URL(src);
        return url.origin === location.origin &&
          /^\/s\/player\/[\w-]+\/[\w./-]+\/base\.js$/.test(url.pathname);
      } catch {
        return false;
      }
    });
  if (!scriptUrl) return [];
  if (scriptUrl !== playerSourceUrl) {
    playerSourceUrl = scriptUrl;
    playerSource = undefined;
    loadingPlayerSource = false;
    resolvedUrls.clear();
  }
  if (!playerSource) {
    if (!loadingPlayerSource) {
      loadingPlayerSource = true;
      const generation = publishGeneration;
      void fetch(scriptUrl, { credentials: 'omit', signal: AbortSignal.timeout(15_000) })
        .then(async (response) => {
          if (!response.ok) throw new Error('Unable to read the active YouTube player.');
          const source = await response.text();
          if (source.length > 8_000_000) throw new Error('The YouTube player source is too large.');
          if (playerSourceUrl !== scriptUrl) return;
          playerSource = source;
          if (publishGeneration === generation) publishPlayerResponse();
        })
        .catch(() => { /* Playback observations remain available when the player changes. */ })
        .finally(() => {
          if (playerSourceUrl === scriptUrl) loadingPlayerSource = false;
        });
    }
    return [];
  }
  return urls.flatMap((url) => {
    const resolved = resolvedUrls.get(url) ?? resolveYouTubePlayerUrl(
      url, (window as YouTubePlayerWindow)._yt_player, playerSource!,
    );
    if (!resolved) return [];
    resolvedUrls.set(url, resolved);
    return [resolved];
  });
}

function publishPlayerResponse(): boolean {
  if (!isYouTubeWatchPage() || !document.documentElement) return false;
  const response = playerSnapshot(currentPlayerResponse());
  if (!response) return false;
  const mediaUrls = resolvePlayerUrls(response.value);
  if (mediaUrls.length) response.value.resolvedMediaUrls = mediaUrls;
  let payload: string;
  try {
    payload = JSON.stringify(response.value);
  } catch {
    return false;
  }
  let element = document.querySelector<HTMLElement>(`div[${BRIDGE_ATTRIBUTE}]`);
  if (!element) {
    // A script textContent assignment is a Trusted Types sink even for JSON.
    element = document.createElement('div');
    element.hidden = true;
    element.setAttribute(BRIDGE_ATTRIBUTE, '');
    element.textContent = payload;
    document.documentElement.append(element);
  } else if (element.textContent !== payload) {
    element.textContent = payload;
  }
  return response.hasFormats;
}

function stopPublishing(): void {
  publishGeneration += 1;
  if (publishTimer !== undefined) window.clearTimeout(publishTimer);
  publishTimer = undefined;
}

function clearPlayerResponse(): void {
  stopPublishing();
  resolvedUrls.clear();
  document.querySelector(`[${BRIDGE_ATTRIBUTE}]`)?.remove();
}

function publishAfterNavigation(): void {
  stopPublishing();
  if (!isYouTubeWatchPage()) {
    document.querySelector(`[${BRIDGE_ATTRIBUTE}]`)?.remove();
    return;
  }
  const generation = publishGeneration;
  let attempts = 0;
  const publish = () => {
    if (generation !== publishGeneration) return;
    if (!isYouTubeWatchPage()) {
      clearPlayerResponse();
      return;
    }
    attempts += 1;
    const complete = publishPlayerResponse();
    // Metadata and signed URLs can change after the first formats appear.
    publishTimer = window.setTimeout(
      publish,
      complete || attempts >= MAX_PUBLISH_ATTEMPTS ? REFRESH_INTERVAL_MS : PUBLISH_INTERVAL_MS,
    );
  };
  publish();
}

export default defineContentScript({
  matches: ['https://youtube.com/*', 'https://www.youtube.com/*', 'https://m.youtube.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    installYouTubeSabrRequestObserver();
    publishAfterNavigation();
    document.addEventListener('DOMContentLoaded', publishAfterNavigation);
    window.addEventListener('yt-navigate-start', clearPlayerResponse);
    window.addEventListener('yt-navigate-finish', publishAfterNavigation);
    window.addEventListener('yt-player-updated', publishAfterNavigation);
    window.addEventListener('pagehide', clearPlayerResponse);
    window.addEventListener('pageshow', publishAfterNavigation);
  },
});
