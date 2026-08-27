interface YouTubePlayerWindow extends Window {
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
let publishGeneration = 0;

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
      },
      streamingData: {
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

function publishPlayerResponse(): boolean {
  if (!isYouTubeWatchPage() || !document.documentElement) return false;
  const response = playerSnapshot(currentPlayerResponse());
  if (!response) return false;
  const script = document.createElement('script');
  script.type = 'application/json';
  script.setAttribute(BRIDGE_ATTRIBUTE, '');
  try {
    script.textContent = JSON.stringify(response.value);
  } catch {
    return false;
  }
  document.querySelector(`script[${BRIDGE_ATTRIBUTE}]`)?.remove();
  document.documentElement.append(script);
  return response.hasFormats;
}

function publishAfterNavigation(): void {
  const generation = ++publishGeneration;
  let attempts = 0;
  const publish = () => {
    if (generation !== publishGeneration) return;
    attempts += 1;
    const complete = publishPlayerResponse();
    if (!complete && attempts < MAX_PUBLISH_ATTEMPTS) {
      window.setTimeout(publish, PUBLISH_INTERVAL_MS);
    }
  };
  publish();
}

export default defineContentScript({
  matches: ['https://youtube.com/*', 'https://www.youtube.com/*', 'https://m.youtube.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    publishAfterNavigation();
    document.addEventListener('DOMContentLoaded', publishAfterNavigation);
    window.addEventListener('yt-navigate-finish', publishAfterNavigation);
    window.addEventListener('yt-player-updated', publishAfterNavigation);
  },
});
