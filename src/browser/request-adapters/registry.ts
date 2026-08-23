import { browser } from 'wxt/browser';
import type { MediaCandidate } from '../../shared/media';
import { bilibiliRequestAdapter } from './bilibili';
import type { SiteRequestAdapter } from './types';

const RULE_ID_OFFSET = 10_000_000;

export const SITE_REQUEST_ADAPTERS: readonly SiteRequestAdapter[] = Object.freeze([
  bilibiliRequestAdapter,
]);

function ruleIdForTab(tabId: number): number {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid downloader tab id.');
  return RULE_ID_OFFSET + tabId;
}

function findAdapter(id: string): SiteRequestAdapter {
  const matches = SITE_REQUEST_ADAPTERS.filter((adapter) => adapter.id === id);
  if (matches.length !== 1) throw new Error(`No unique site request adapter is registered for ${id}.`);
  return matches[0]!;
}

export async function configureSiteRequestAdapterForTab(
  candidate: MediaCandidate,
  downloaderTabId: number,
): Promise<void> {
  if (!candidate.siteAdapterId) return;
  const ruleId = ruleIdForTab(downloaderTabId);
  const rules = findAdapter(candidate.siteAdapterId).createSessionRules(
    candidate,
    downloaderTabId,
    browser.runtime.id,
    ruleId,
  );
  await browser.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: rules,
  });
}

export async function removeSiteRequestAdapterForTab(tabId: number): Promise<void> {
  await browser.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleIdForTab(tabId)],
  });
}
