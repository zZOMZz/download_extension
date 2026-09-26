import type { CandidateObservation } from '../../../shared/media';
import {
  parseBilibiliPlaybackInfoScript,
  parseBilibiliPlayInfoScript,
  type BilibiliPlaybackInfo,
} from '../../site-adapters/bilibili/play-info';
import {
  BILIBILI_PLAYER_SELECTOR,
  bilibiliPageIdentity,
  bilibiliPlayerStateSchema,
  isBilibiliMediaUrl,
} from '../../site-adapters/bilibili/player-state';
import type { MediaDetectionAdapter } from './types';

export const parseBilibiliPlayInfo = parseBilibiliPlayInfoScript;

export function isBilibiliVideoPage(pageUrl: URL): boolean {
  return Boolean(bilibiliPageIdentity(pageUrl.href));
}

function currentPlayback(document: Document, pageUrl: URL): BilibiliPlaybackInfo | undefined {
  const identity = bilibiliPageIdentity(pageUrl.href);
  const stateElement = document.querySelector(BILIBILI_PLAYER_SELECTOR);
  if (stateElement?.textContent) {
    try {
      const state = bilibiliPlayerStateSchema.parse(JSON.parse(stateElement.textContent));
      if (bilibiliPageIdentity(state.pageUrl) === identity) return state.playback;
    } catch { /* An incomplete bridge update can be retried on the next scan. */ }
  }
  for (const script of Array.from(document.querySelectorAll('script')).reverse()) {
    const text = script.textContent ?? '';
    if (!text.includes('__playinfo__') && !text.includes('playurlSSRData')) continue;
    const playback = parseBilibiliPlaybackInfoScript(text);
    if (!playback) continue;
    if (identity?.startsWith('ep') && playback.episodeId !== undefined &&
        identity !== `ep${playback.episodeId}`) continue;
    return playback;
  }
  return undefined;
}

export const bilibiliDetectionAdapter: MediaDetectionAdapter = {
  id: 'bilibili',
  matches: isBilibiliVideoPage,
  claimsResource: (url) => isBilibiliMediaUrl(url.href),
  ownsResource: (url, page) => isBilibiliVideoPage(page) && isBilibiliMediaUrl(url.href),
  detect(document, pageUrl): CandidateObservation[] {
    const playback = currentPlayback(document, pageUrl);
    if (!playback) return [];
    const thumbnailUrl = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
    const common = {
      source: 'dom' as const,
      siteAdapterId: 'bilibili',
      sourcePageUrl: pageUrl.href,
      ...(document.title ? { title: document.title } : {}),
      ...(thumbnailUrl && /^https?:\/\//.test(thumbnailUrl) ? { thumbnailUrl } : {}),
      isPreview: playback.isPreview,
      hasContentProtection: playback.hasContentProtection,
    };
    if (playback.hasContentProtection) {
      return [{ ...common, kind: 'blob', url: pageUrl.href }];
    }
    if (playback.dash) {
      if (!playback.dash.tracks.every((track) =>
        isBilibiliMediaUrl(track.initialization.url) &&
        (!track.index || isBilibiliMediaUrl(track.index.url)) &&
        (track.initialization.alternativeUrls ?? []).every(isBilibiliMediaUrl) &&
        (track.index?.alternativeUrls ?? []).every(isBilibiliMediaUrl))) return [];
      return [{ ...common, kind: 'dash', url: pageUrl.href, dash: playback.dash }];
    }
    if (playback.progressiveUrl && isBilibiliMediaUrl(playback.progressiveUrl)) {
      return [{ ...common, kind: 'progressive', url: playback.progressiveUrl, mimeType: 'video/mp4' }];
    }
    return [];
  },
};
