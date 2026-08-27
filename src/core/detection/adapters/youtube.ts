import type { CandidateObservation } from '../../../shared/media';
import {
  isGoogleVideoUrl,
  parseYouTubePlayerResponseDocument,
} from '../../site-adapters/youtube/player-response';
import type { MediaDetectionAdapter } from './types';

const VIDEO_ID = /^[0-9A-Za-z_-]{11}$/;

export function youtubeVideoId(pageUrl: URL): string | undefined {
  if (
    pageUrl.protocol !== 'https:' ||
    !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(pageUrl.hostname) ||
    pageUrl.pathname !== '/watch'
  ) {
    return undefined;
  }
  const videoId = pageUrl.searchParams.get('v') ?? '';
  return VIDEO_ID.test(videoId) ? videoId : undefined;
}

export function isYouTubeWatchPage(pageUrl: URL): boolean {
  return youtubeVideoId(pageUrl) !== undefined;
}

export function isYouTubeUiAudioResource(resourceUrl: URL): boolean {
  return resourceUrl.protocol === 'https:' &&
    ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(resourceUrl.hostname) &&
    resourceUrl.pathname.startsWith('/s/search/audio/') &&
    resourceUrl.pathname.endsWith('.mp3');
}

export function isYouTubeClaimedResource(resourceUrl: URL): boolean {
  return isGoogleVideoUrl(resourceUrl.href) || isYouTubeUiAudioResource(resourceUrl);
}

export const youtubeDetectionAdapter: MediaDetectionAdapter = {
  id: 'youtube',
  matches: isYouTubeWatchPage,
  claimsResource: isYouTubeClaimedResource,
  ownsResource(resourceUrl, pageUrl) {
    return isYouTubeWatchPage(pageUrl) && isYouTubeClaimedResource(resourceUrl);
  },
  detect(document, pageUrl, context): CandidateObservation[] {
    const videoId = youtubeVideoId(pageUrl);
    if (!videoId) return [];
    const player = parseYouTubePlayerResponseDocument(document, {
      expectedVideoId: videoId,
      ...(context?.observedResourceUrls
        ? { observedMediaUrls: context.observedResourceUrls }
        : {}),
    });
    if (!player) return [];
    if (player.dash) {
      return [{
        kind: 'dash',
        source: 'dom',
        url: pageUrl.href,
        title: player.title,
        siteAdapterId: 'youtube',
        dash: player.dash,
      }];
    }
    if (!player.progressive) return [];
    return [{
      kind: 'progressive',
      source: 'dom',
      url: player.progressive.url,
      title: player.title,
      mimeType: player.progressive.mimeType,
      ...(player.progressive.contentLength === undefined
        ? {}
        : { contentLength: player.progressive.contentLength }),
    }];
  },
};
