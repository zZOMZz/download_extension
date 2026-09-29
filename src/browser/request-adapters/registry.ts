import { browser } from 'wxt/browser';
import type { MediaCandidate } from '../../shared/media';
import { bilibiliRequestAdapter } from './bilibili';
import { youtubeRequestAdapter } from './youtube';
import type { SiteRequestAdapter, SiteRequestRule } from './types';

const RULE_ID_OFFSET = 10_000_000;
const MAX_RULE_ID = 0x7fffffff;
let pending = Promise.resolve();

export const SITE_REQUEST_ADAPTERS: readonly SiteRequestAdapter[] = Object.freeze([
  bilibiliRequestAdapter,
  youtubeRequestAdapter,
]);

function replaceTabRules(tabId: number, create: (allocate: () => number) => SiteRequestRule[]): Promise<void> {
  if (!Number.isInteger(tabId) || tabId < 0 || tabId > MAX_RULE_ID) return Promise.reject(new Error('Invalid downloader tab id.'));
  // These entry points run in the background worker. Serialize the read/allocate/write
  // sequence and read Chrome's rules each time so worker restarts do not lose ownership.
  const operation = pending.then(async () => {
    const existing = await browser.declarativeNetRequest.getSessionRules();
    const removeRuleIds = existing.filter(rule => rule.id >= RULE_ID_OFFSET && rule.action.type === 'modifyHeaders' &&
      rule.condition.tabIds?.length === 1 && rule.condition.tabIds[0] === tabId &&
      rule.condition.initiatorDomains?.length === 1 && rule.condition.initiatorDomains[0] === browser.runtime.id)
      .map(rule => rule.id);
    const removed = new Set(removeRuleIds);
    const occupied = new Set(existing.filter(rule => !removed.has(rule.id)).map(rule => rule.id));
    let next = RULE_ID_OFFSET;
    const rules = create(() => {
      while (occupied.has(next) && next <= MAX_RULE_ID) next++;
      if (next > MAX_RULE_ID) throw new Error('No available request rule id.');
      occupied.add(next); return next++;
    });
    if (removeRuleIds.length || rules.length) await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: rules });
  });
  pending = operation.catch(() => {});
  return operation;
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
  const adapter = findAdapter(candidate.siteAdapterId);
  await replaceTabRules(downloaderTabId, allocate => adapter.createSessionRules(candidate, downloaderTabId, browser.runtime.id, allocate()));
}

export async function configureSiteRequestAdaptersForManager(
  adapterIds: readonly string[],
  managerTabId: number,
): Promise<void> {
  const requested = new Set(adapterIds);
  await replaceTabRules(managerTabId, allocate => SITE_REQUEST_ADAPTERS.flatMap(adapter =>
    requested.has(adapter.id) && adapter.createManagerSessionRules
      ? adapter.createManagerSessionRules(managerTabId, browser.runtime.id, allocate()) : []));
}

export async function removeSiteRequestAdapterForTab(tabId: number): Promise<void> {
  await replaceTabRules(tabId, () => []);
}
