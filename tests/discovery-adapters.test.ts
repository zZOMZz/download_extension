import { describe, expect, it, vi } from 'vitest';
import {
  extractTwoRkMediaUrl,
  twoRkDiscoveryAdapter,
} from '../src/core/discovery/adapters/two-rk';
import {
  bilibiliDiscoveryAdapter,
  parseBilibiliViewItems,
} from '../src/core/discovery/adapters/bilibili';
import {
  discoverMediaItems,
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

  it('discovers and sorts all episode links on a 2rk detail page', async () => {
    const pageUrl = new URL('https://www.2rk.cc/detail/series-id?id=1');
    const items = await twoRkDiscoveryAdapter.discover(fakeTwoRkDocument(), pageUrl);

    expect(items).toEqual([
      {
        id: '2rk-series:series-id:1',
        adapterId: '2rk-series',
        pageUrl: 'https://www.2rk.cc/detail/series-id?id=1',
        title: '第01话',
        mediaKind: 'hls',
        seriesTitle: 'Example Series',
        sequence: 1,
      },
      {
        id: '2rk-series:series-id:2',
        adapterId: '2rk-series',
        pageUrl: 'https://www.2rk.cc/detail/series-id?id=2',
        title: '第02话',
        mediaKind: 'hls',
        seriesTitle: 'Example Series',
        sequence: 2,
      },
    ]);
  });

  it('extracts and resolves a fresh HLS URL when the task starts', async () => {
    const item = (await twoRkDiscoveryAdapter.discover(
      fakeTwoRkDocument(),
      new URL('https://www.2rk.cc/detail/series-id?id=1'),
    ))[0]!;
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

  it('flattens every page in a Bilibili UGC collection', () => {
    const items = parseBilibiliViewItems(JSON.stringify({
      code: 0,
      message: 'OK',
      data: {
        bvid: 'BVCurrent',
        title: 'Current video',
        pages: [{ cid: 999, page: 1, part: 'Current video' }],
        ugc_season: {
          title: 'Creator collection',
          sections: [{
            episodes: [
              {
                bvid: 'BVFirst',
                title: 'First episode',
                pages: [
                  { cid: 101, page: 1, part: 'Opening' },
                  { cid: 102, page: 2, part: 'Follow-up' },
                ],
              },
              {
                bvid: 'BVSecond',
                title: 'Second episode',
                pages: [{ cid: 201, page: 1, part: 'Second episode' }],
              },
            ],
          }],
        },
      },
    }));

    expect(items).toEqual([
      {
        id: 'bilibili:BVFirst:101',
        adapterId: 'bilibili',
        pageUrl: 'https://www.bilibili.com/video/BVFirst/?p=1',
        title: 'First episode - P1 - Opening',
        mediaKind: 'dash',
        seriesTitle: 'Creator collection',
        sequence: 1,
      },
      {
        id: 'bilibili:BVFirst:102',
        adapterId: 'bilibili',
        pageUrl: 'https://www.bilibili.com/video/BVFirst/?p=2',
        title: 'First episode - P2 - Follow-up',
        mediaKind: 'dash',
        seriesTitle: 'Creator collection',
        sequence: 2,
      },
      {
        id: 'bilibili:BVSecond:201',
        adapterId: 'bilibili',
        pageUrl: 'https://www.bilibili.com/video/BVSecond/?p=1',
        title: 'Second episode',
        mediaKind: 'dash',
        seriesTitle: 'Creator collection',
        sequence: 3,
      },
    ]);
  });

  it('discovers Bilibili multi-P pages and resolves fresh DASH tracks by bvid and cid', async () => {
    const viewResponse = JSON.stringify({
      code: 0,
      data: {
        bvid: 'BV1Multi',
        title: 'Multi-part video',
        pages: [
          { cid: 301, page: 1, part: 'Part one' },
          { cid: 302, page: 2, part: 'Part two' },
        ],
      },
    });
    const playResponse = JSON.stringify({
      code: 0,
      data: {
        timelength: 12_000,
        dash: {
          video: [{
            id: 80,
            baseUrl: 'https://cdn.example/video.m4s?token=fresh',
            mimeType: 'video/mp4',
            codecs: 'avc1.640028',
            SegmentBase: { Initialization: '0-99', indexRange: '100-149' },
          }],
          audio: [{
            id: 30216,
            baseUrl: 'https://cdn.example/audio.m4s?token=fresh',
            mimeType: 'audio/mp4',
            codecs: 'mp4a.40.2',
            SegmentBase: { Initialization: '0-79', indexRange: '80-119' },
          }],
        },
      },
    });
    const fetchText = vi.fn(async (url: string) =>
      url.includes('/x/web-interface/view') ? viewResponse : playResponse);
    const pageUrl = new URL('https://www.bilibili.com/video/BV1Multi/?p=2');
    const items = await discoverMediaItems({} as Document, pageUrl, { fetchText });

    expect(items.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: 'bilibili:BV1Multi:301', title: 'P1 - Part one' },
      { id: 'bilibili:BV1Multi:302', title: 'P2 - Part two' },
    ]);
    await expect(resolveDiscoveredMedia(items[1]!, { fetchText })).resolves.toMatchObject({
      kind: 'dash',
      url: 'https://www.bilibili.com/video/BV1Multi/?p=2',
      dash: {
        type: 'static',
        durationSeconds: 12,
        tracks: [
          { id: '80', kind: 'video' },
          { id: '30216', kind: 'audio' },
        ],
      },
    });
    const viewUrl = new URL(fetchText.mock.calls[0]![0]);
    const playUrl = new URL(fetchText.mock.calls[1]![0]);
    expect(viewUrl).toMatchObject({ hostname: 'api.bilibili.com', pathname: '/x/web-interface/view' });
    expect(viewUrl.searchParams.get('bvid')).toBe('BV1Multi');
    expect(playUrl.pathname).toBe('/x/player/playurl');
    expect(Object.fromEntries(playUrl.searchParams)).toMatchObject({
      bvid: 'BV1Multi', cid: '302', qn: '127', fnval: '4048', fourk: '1',
    });
  });

  it('isolates Bilibili batch discovery from lookalike hosts and non-video pages', () => {
    expect(supportsSiteDiscovery('https://www.bilibili.com/video/BV1test')).toBe(true);
    expect(supportsSiteDiscovery('https://evil-bilibili.com/video/BV1test')).toBe(false);
    expect(supportsSiteDiscovery('https://www.bilibili.com/bangumi/play/ep1')).toBe(false);
    expect(bilibiliDiscoveryAdapter.matches(new URL('https://m.bilibili.com/video/BV1test'))).toBe(false);
  });

  it('refuses a persisted Bilibili task whose page belongs to another site', async () => {
    await expect(resolveDiscoveredMedia({
      id: 'bilibili:BV1Multi:302',
      adapterId: 'bilibili',
      pageUrl: 'https://evil-bilibili.com/video/BV1Multi/?p=2',
      title: 'Part two',
      seriesTitle: 'Multi-part video',
      sequence: 2,
    }, {
      fetchText: vi.fn(),
    })).rejects.toThrow(/invalid media identity/i);
  });
});
