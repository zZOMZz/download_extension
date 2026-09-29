import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteRequestRule } from '../src/browser/request-adapters/types';

const api = vi.hoisted(() => ({ rules: [] as SiteRequestRule[], getSessionRules: vi.fn(), updateSessionRules: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: { id: 'extension-id' },
  declarativeNetRequest: { getSessionRules: api.getSessionRules, updateSessionRules: api.updateSessionRules },
} }));
import { configureSiteRequestAdaptersForManager, removeSiteRequestAdapterForTab } from '../src/browser/request-adapters/registry';
import { createBilibiliManagerSessionRule } from '../src/browser/request-adapters/bilibili';

beforeEach(() => {
  api.rules = []; vi.clearAllMocks();
  api.getSessionRules.mockImplementation(async () => structuredClone(api.rules));
  api.updateSessionRules.mockImplementation(async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: SiteRequestRule[] }) => {
    for (const id of [...removeRuleIds, ...addRules.map(rule => rule.id)]) {
      if (!Number.isInteger(id) || id < 1 || id > 0x7fffffff) throw Error('Invalid Chrome rule integer.');
    }
    const retained = api.rules.filter(rule => !removeRuleIds.includes(rule.id));
    const ids = new Set(retained.map(rule => rule.id));
    for (const rule of addRules) { if (ids.has(rule.id)) throw Error('Duplicate rule id.'); ids.add(rule.id); }
    api.rules = [...retained, ...structuredClone(addRules)];
  });
});

describe('request adapter registry', () => {
  it('installs only the rules needed by the queued adapters', async () => {
    await configureSiteRequestAdaptersForManager(['2rk-series', 'bilibili', 'bilibili'], 42);
    expect(api.rules).toHaveLength(1);
    expect(api.rules[0]).toMatchObject({ id: 10_000_000, condition: { tabIds: [42] } });
  });
  it('supports large Chrome tab IDs without overflowing rule IDs', async () => {
    await configureSiteRequestAdaptersForManager(['bilibili'], 2_147_483_640);
    expect(api.rules[0]).toMatchObject({ id: 10_000_000, condition: { tabIds: [2_147_483_640] } });
    await removeSiteRequestAdapterForTab(2_147_483_640);
    expect(api.rules).toEqual([]);
  });
  it('does not send synthetic removal IDs for sources that need no header rules', async () => {
    await configureSiteRequestAdaptersForManager(['koala'], 2_147_483_640);
    expect(api.updateSessionRules).not.toHaveBeenCalled();
  });
  it('finds existing rules by tab ownership after a worker restart and preserves other rules', async () => {
    const foreign = createBilibiliManagerSessionRule(42, 'different-initiator', 10_000_000);
    const otherTab = createBilibiliManagerSessionRule(43, 'extension-id', 10_000_001);
    api.rules = [foreign, otherTab, createBilibiliManagerSessionRule(42, 'extension-id', 10_000_042)];
    await configureSiteRequestAdaptersForManager(['bilibili'], 42);
    expect(api.rules).toContainEqual(foreign); expect(api.rules).toContainEqual(otherTab);
    expect(api.rules.at(-1)?.id).toBe(10_000_002);
    expect(api.updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [10_000_042], addRules: [expect.objectContaining({ id: 10_000_002 })] });
    await configureSiteRequestAdaptersForManager(['koala'], 42);
    expect(api.rules).toEqual([foreign, otherTab]);
  });
  it('allocates different IDs for concurrent managers and cleans up only the closed tab', async () => {
    await Promise.all([configureSiteRequestAdaptersForManager(['bilibili'], 1), configureSiteRequestAdaptersForManager(['bilibili'], 2)]);
    expect(new Set(api.rules.map(rule => rule.id)).size).toBe(2);
    await removeSiteRequestAdapterForTab(1);
    expect(api.rules).toHaveLength(1); expect(api.rules[0]?.condition.tabIds).toEqual([2]);
  });
});
