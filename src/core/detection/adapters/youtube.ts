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

export const youtubeDetectionAdapter: MediaDetectionAdapter = {
  id: 'youtube',
  matches: isYouTubeWatchPage,
  ownsResource(resourceUrl, pageUrl) {
    return isYouTubeWatchPage(pageUrl) && isGoogleVideoUrl(resourceUrl.href);
  },
  detect(document, pageUrl): CandidateObservation[] {
    const videoId = youtubeVideoId(pageUrl);
    if (!videoId) return [];
    const player = parseYouTubePlayerResponseDocument(document, { expectedVideoId: videoId });
    if (!player?.dash) return [];
    return [{
      kind: 'dash',
      source: 'dom',
      url: pageUrl.href,
      title: player.title,
      siteAdapterId: 'youtube',
      dash: player.dash,
    }];
  },
};
