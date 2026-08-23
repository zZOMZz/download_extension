import { describe, expect, it, vi } from 'vitest';
import {
  extractTwoRkMediaUrl,
  twoRkDiscoveryAdapter,
} from '../src/core/discovery/adapters/two-rk';
import {
  resolveDiscoveredMedia,
  supportsSiteDiscovery,
} from '../src/core/discovery/registry';

function fakeTwoRkDocument(): Document {
  const anchors = [
    { href: 'https://www.2rk.cc/detail/series-id?id=2', textContent: '第02话' },
    { href: 'https://www.2rk.cc/detail/series-id?id=1', textContent: '第01话' },
    { href: 'https://www.2rk.cc/other?id=3', textContent: 'Ignore me' },
  ];
  return {
    title: 'Example Series 第01话 - 二矿动漫',
    querySelectorAll(selector: string) {
      if (selector === 'h2') return [{ textContent: 'Example Series' }];
      if (selector === 'a[href]') return anchors;
      return [];
    },
  } as unknown as Document;
}

describe('site discovery adapters', () => {
  it('limits 2rk discovery to exact detail-page hosts and paths', () => {
    expect(supportsSiteDiscovery('https://www.2rk.cc/detail/series-id?id=1')).toBe(true);
    expect(supportsSiteDiscovery('https://2rk.cc/detail/series-id?id=1')).toBe(true);
    expect(supportsSiteDiscovery('https://cdn.2rk.cc/detail/series-id?id=1')).toBe(false);
    expect(supportsSiteDiscovery('https://www.2rk.cc/search?w=test')).toBe(false);
  });

  it('discovers and sorts all episode links on a 2rk detail page', () => {
    const pageUrl = new URL('https://www.2rk.cc/detail/series-id?id=1');
    const items = twoRkDiscoveryAdapter.discover(fakeTwoRkDocument(), pageUrl);

    expect(items).toEqual([
      {
        id: '2rk-series:series-id:1',
        adapterId: '2rk-series',
        pageUrl: 'https://www.2rk.cc/detail/series-id?id=1',
        title: '第01话',
        seriesTitle: 'Example Series',
        sequence: 1,
      },
      {
        id: '2rk-series:series-id:2',
        adapterId: '2rk-series',
        pageUrl: 'https://www.2rk.cc/detail/series-id?id=2',
        title: '第02话',
        seriesTitle: 'Example Series',
        sequence: 2,
      },
    ]);
  });

  it('extracts and resolves a fresh HLS URL when the task starts', async () => {
    const item = twoRkDiscoveryAdapter.discover(
      fakeTwoRkDocument(),
      new URL('https://www.2rk.cc/detail/series-id?id=1'),
    )[0]!;
    const fetchText = vi.fn(async () => `h.loadSource('/video/series-id/1/index.m3u8?token=fresh');`);

    expect(extractTwoRkMediaUrl(await fetchText(), item.pageUrl)).toBe(
      'https://www.2rk.cc/video/series-id/1/index.m3u8?token=fresh',
    );
    await expect(resolveDiscoveredMedia(item, { fetchText })).resolves.toEqual({
      kind: 'hls',
      url: 'https://www.2rk.cc/video/series-id/1/index.m3u8?token=fresh',
      title: '第01话',
    });
  });
});
