import { describe, expect, it } from 'vitest';
import { createBilibiliSessionRule } from '../src/browser/request-adapters/bilibili';
import type { MediaCandidate } from '../src/shared/media';

function candidate(overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return {
    id: 'candidate',
    tabId: 10,
    frameId: 0,
    kind: 'dash',
    source: 'dom',
    url: 'https://www.bilibili.com/video/BV1test?p=2',
    detectedAt: 1,
    siteAdapterId: 'bilibili',
    ...overrides,
  };
}

describe('Bilibili request adapter', () => {
  it('limits header changes to Bilibili CDN requests in one downloader tab', () => {
    const rule = createBilibiliSessionRule(candidate(), 42, 'extension-id', 10_000_042);
    expect(rule).toEqual({
      id: 10_000_042,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.bilibili.com/video/BV1test?p=2' },
          { header: 'Origin', operation: 'set', value: 'https://www.bilibili.com' },
        ],
      },
      condition: {
        tabIds: [42],
        initiatorDomains: ['extension-id'],
        requestDomains: ['bilivideo.com', 'bilivideo.cn'],
        resourceTypes: ['xmlhttprequest', 'media', 'other'],
      },
    });
  });

  it('rejects unrelated sites even if they claim the adapter id', () => {
    expect(() => createBilibiliSessionRule(candidate({
      url: 'https://example.com/video/BV1test',
    }), 42, 'extension-id', 10_000_042)).toThrow(/unrelated/i);
    expect(() => createBilibiliSessionRule(candidate({
      siteAdapterId: 'other-site',
    }), 42, 'extension-id', 10_000_042)).toThrow(/unrelated/i);
  });
});
