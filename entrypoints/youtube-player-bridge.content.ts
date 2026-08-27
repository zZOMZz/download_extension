interface YouTubePlayerWindow extends Window {
  ytInitialPlayerResponse?: unknown;
  ytplayer?: {
    bootstrapPlayerResponse?: unknown;
    config?: { args?: { raw_player_response?: unknown } };
  };
}

const BRIDGE_ATTRIBUTE = 'data-open-media-downloader-youtube-player';

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

function currentPlayerResponse(): unknown {
  const pageWindow = window as YouTubePlayerWindow;
  const candidates = [
    pageWindow.ytplayer?.config?.args?.raw_player_response,
    pageWindow.ytplayer?.bootstrapPlayerResponse,
    pageWindow.ytInitialPlayerResponse,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') return candidate;
    if (typeof candidate === 'string') {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        // Try the next player response source.
      }
    }
  }
  return undefined;
}

function playerSnapshot(value: unknown): JsonRecord | undefined {
  const response = asRecord(value);
  const playability = asRecord(response?.playabilityStatus);
  const details = asRecord(response?.videoDetails);
  const streamingData = asRecord(response?.streamingData);
  if (!response || !playability || !details) return undefined;
  const adaptiveFormats = Array.isArray(streamingData?.adaptiveFormats)
    ? streamingData.adaptiveFormats.map(asRecord).filter((format): format is JsonRecord => Boolean(format))
    : [];
  return {
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
  };
}

function publishPlayerResponse(): void {
  if (!isYouTubeWatchPage() || !document.documentElement) return;
  const response = playerSnapshot(currentPlayerResponse());
  if (!response) return;
  const script = document.createElement('script');
  script.type = 'application/json';
  script.setAttribute(BRIDGE_ATTRIBUTE, '');
  try {
    script.textContent = JSON.stringify(response);
  } catch {
    return;
  }
  document.querySelector(`script[${BRIDGE_ATTRIBUTE}]`)?.remove();
  document.documentElement.append(script);
}

function publishAfterNavigation(): void {
  window.setTimeout(publishPlayerResponse, 0);
  window.setTimeout(publishPlayerResponse, 500);
}

export default defineContentScript({
  matches: ['https://youtube.com/*', 'https://www.youtube.com/*', 'https://m.youtube.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    publishAfterNavigation();
    document.addEventListener('DOMContentLoaded', publishAfterNavigation);
    window.addEventListener('yt-navigate-finish', publishAfterNavigation);
  },
});
