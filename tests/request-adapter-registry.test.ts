import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateSessionRules = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { id: 'extension-id' },
    declarativeNetRequest: { updateSessionRules },
  },
}));

import {
  configureSiteRequestAdaptersForManager,
  removeSiteRequestAdapterForTab,
} from '../src/browser/request-adapters/registry';

beforeEach(() => updateSessionRules.mockClear());

describe('request adapter registry', () => {
  it('installs only the manager rules requested by queued task adapters', async () => {
    await configureSiteRequestAdaptersForManager(
      ['2rk-series', 'bilibili', 'bilibili'],
      42,
    );

    expect(updateSessionRules).toHaveBeenCalledOnce();
    expect(updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [10_000_042],
      addRules: [expect.objectContaining({
        id: 10_000_042,
        condition: expect.objectContaining({ tabIds: [42] }),
      })],
    });
  });

  it('clears tab-scoped rules when no queued adapter needs them or the tab closes', async () => {
    await configureSiteRequestAdaptersForManager(['2rk-series'], 42);
    await removeSiteRequestAdapterForTab(42);

    expect(updateSessionRules).toHaveBeenNthCalledWith(1, {
      removeRuleIds: [10_000_042],
      addRules: [],
    });
    expect(updateSessionRules).toHaveBeenNthCalledWith(2, {
      removeRuleIds: [10_000_042],
    });
  });
});
