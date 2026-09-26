import type { MediaCandidate } from '../../shared/media';
import type { SiteRequestAdapter, SiteRequestRule } from './types';

export function createBilibiliSessionRule(
  candidate: MediaCandidate,
  downloaderTabId: number,
  extensionId: string,
  ruleId: number,
): SiteRequestRule {
  const pageUrl = new URL(candidate.sourcePageUrl ?? candidate.url);
  if (candidate.siteAdapterId !== 'bilibili' ||
      !['http:', 'https:'].includes(pageUrl.protocol) ||
      (pageUrl.hostname !== 'www.bilibili.com' && pageUrl.hostname !== 'm.bilibili.com')) {
    throw new Error('The Bilibili request adapter received an unrelated media candidate.');
  }
  if (candidate.kind === 'progressive') {
    const mediaUrl = new URL(candidate.url);
    if (!['http:', 'https:'].includes(mediaUrl.protocol) ||
        !['bilivideo.com', 'bilivideo.cn'].some((domain) =>
          mediaUrl.hostname === domain || mediaUrl.hostname.endsWith(`.${domain}`))) {
      throw new Error('The Bilibili request adapter received an unrelated media URL.');
    }
  }
  return {
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Referer', operation: 'set', value: pageUrl.href },
        { header: 'Origin', operation: 'set', value: 'https://www.bilibili.com' },
      ],
    },
    condition: {
      tabIds: [downloaderTabId],
      initiatorDomains: [extensionId],
      requestDomains: ['bilivideo.com', 'bilivideo.cn'],
      resourceTypes: ['xmlhttprequest', 'media', 'other'],
    },
  };
}

export function createBilibiliManagerSessionRule(
  managerTabId: number,
  extensionId: string,
  ruleId: number,
): SiteRequestRule {
  return {
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Referer', operation: 'set', value: 'https://www.bilibili.com/' },
        { header: 'Origin', operation: 'set', value: 'https://www.bilibili.com' },
      ],
    },
    condition: {
      tabIds: [managerTabId],
      initiatorDomains: [extensionId],
      requestDomains: ['api.bilibili.com', 'bilivideo.com', 'bilivideo.cn'],
      resourceTypes: ['xmlhttprequest', 'media', 'other'],
    },
  };
}

export const bilibiliRequestAdapter: SiteRequestAdapter = {
  id: 'bilibili',
  createSessionRules(candidate, downloaderTabId, extensionId, ruleId) {
    return [createBilibiliSessionRule(candidate, downloaderTabId, extensionId, ruleId)];
  },
  createManagerSessionRules(managerTabId, extensionId, ruleId) {
    return [createBilibiliManagerSessionRule(managerTabId, extensionId, ruleId)];
  },
};
