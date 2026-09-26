import type { MediaCandidate } from '../../shared/media';
import { isYouTubeWatchPage } from '../../core/detection/adapters/youtube';
import { isGoogleVideoUrl } from '../../core/site-adapters/youtube/player-response';
import type { SiteRequestAdapter, SiteRequestRule } from './types';

function validateCandidate(candidate: MediaCandidate): URL {
  let pageUrl: URL;
  try {
    pageUrl = new URL(candidate.sourcePageUrl ?? candidate.url);
  } catch {
    throw new Error('The YouTube request adapter received an invalid page URL.');
  }
  if (candidate.siteAdapterId !== 'youtube' || !isYouTubeWatchPage(pageUrl)) {
    throw new Error('The YouTube request adapter received an unrelated media candidate.');
  }
  if (candidate.kind === 'progressive' && !isGoogleVideoUrl(candidate.url)) {
    throw new Error('The YouTube request adapter received an unrelated media URL.');
  }
  return pageUrl;
}

export function createYouTubeSessionRule(
  candidate: MediaCandidate,
  downloaderTabId: number,
  extensionId: string,
  ruleId: number,
): SiteRequestRule {
  const pageUrl = validateCandidate(candidate);
  return {
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Referer', operation: 'set', value: pageUrl.href },
        { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' },
      ],
    },
    condition: {
      tabIds: [downloaderTabId],
      initiatorDomains: [extensionId],
      requestDomains: ['googlevideo.com'],
      resourceTypes: ['xmlhttprequest', 'media', 'other'],
    },
  };
}

export const youtubeRequestAdapter: SiteRequestAdapter = {
  id: 'youtube',
  createSessionRules(candidate, downloaderTabId, extensionId, ruleId) {
    return [createYouTubeSessionRule(candidate, downloaderTabId, extensionId, ruleId)];
  },
};
