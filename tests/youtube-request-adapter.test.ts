import { describe, expect, it } from 'vitest';
import { createYouTubeSessionRule } from '../src/browser/request-adapters/youtube';
import type { MediaCandidate } from '../src/shared/media';

function candidate(overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return {
    id: 'candidate',
    tabId: 10,
    frameId: 0,
    kind: 'dash',
    source: 'dom',
    url: 'https://www.youtube.com/watch?v=GwUwyWGHmGY',
    detectedAt: 1,
    siteAdapterId: 'youtube',
    ...overrides,
  };
}

describe('YouTube request adapter', () => {
  it('limits header changes to Google Video requests in one downloader tab', () => {
    expect(createYouTubeSessionRule(candidate(), 42, 'extension-id', 10_000_042)).toEqual({
      id: 10_000_042,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          {
            header: 'Referer',
            operation: 'set',
            value: 'https://www.youtube.com/watch?v=GwUwyWGHmGY',
          },
          { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' },
        ],
      },
      condition: {
        tabIds: [42],
        initiatorDomains: ['extension-id'],
        requestDomains: ['googlevideo.com'],
        resourceTypes: ['xmlhttprequest', 'media', 'other'],
      },
    });
  });

  it('rejects lookalike hosts and unrelated adapter ids', () => {
    expect(() => createYouTubeSessionRule(candidate({
      url: 'https://youtube.com.evil.example/watch?v=GwUwyWGHmGY',
    }), 42, 'extension-id', 10_000_042)).toThrow(/unrelated/i);
    expect(() => createYouTubeSessionRule(candidate({
      siteAdapterId: 'other-site',
    }), 42, 'extension-id', 10_000_042)).toThrow(/unrelated/i);
  });
});
