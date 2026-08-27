import type { CandidateObservation } from '../../../shared/media';
import { parseBilibiliPlayInfoScript } from '../../site-adapters/bilibili/play-info';
import type { MediaDetectionAdapter } from './types';

export const parseBilibiliPlayInfo = parseBilibiliPlayInfoScript;

export function isBilibiliVideoPage(pageUrl: URL): boolean {
  return (pageUrl.hostname === 'www.bilibili.com' || pageUrl.hostname === 'm.bilibili.com') &&
    (/^\/video\//.test(pageUrl.pathname) || /^\/bangumi\/play\//.test(pageUrl.pathname));
}

export const bilibiliDetectionAdapter: MediaDetectionAdapter = {
  id: 'bilibili',
  matches: isBilibiliVideoPage,
  detect(document, pageUrl): CandidateObservation[] {
    for (const script of Array.from(document.querySelectorAll('script')).reverse()) {
      const text = script.textContent ?? '';
      if (!text.includes('__playinfo__')) continue;
      const dash = parseBilibiliPlayInfoScript(text);
      if (!dash) continue;
      return [{
        kind: 'dash',
        source: 'dom',
        url: pageUrl.href,
        siteAdapterId: 'bilibili',
        ...(document.title ? { title: document.title } : {}),
        dash,
      }];
    }
    return [];
  },
};
