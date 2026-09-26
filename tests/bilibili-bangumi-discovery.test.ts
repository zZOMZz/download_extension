import { describe, expect, it, vi } from 'vitest';
import {
  bilibiliDiscoveryAdapter,
  parseBilibiliSeasonItems,
} from '../src/core/discovery/adapters/bilibili';
import { resolveDiscoveredMedia, supportsSiteDiscovery } from '../src/core/discovery/registry';

function seasonResponse() {
  return {
    code: 0,
    result: {
      season_id: 28747,
      title: 'Example series',
      episodes: [
        { id: 101, cid: 1001, title: '1', long_title: 'Beginning', section_type: 0 },
        { id: 201, cid: 2001, title: '2', long_title: 'Trailer', section_type: 1 },
        { id: 102, cid: 1002, title: '2', show_title: '第2话 Next', section_type: 0 },
        { id: 102, cid: 1002, title: '2', section_type: 0 },
        { id: 103, cid: 1003, title: '3', section_type: 0, is_view_hide: true },
        { id: 104, cid: 0, title: '4', section_type: 0 },
      ],
      section: [{
        title: '预告',
        episodes: [{ id: 201, cid: 2001, title: '2', long_title: 'Trailer', section_type: 1 }],
      }],
    },
  };
}

function discoveredEpisode() {
  return parseBilibiliSeasonItems(JSON.stringify(seasonResponse()), { episodeId: 102 })[1]!;
}

function playbackPage(options: {
  cid?: number;
  episodeId?: number;
  preview?: boolean;
  drm?: boolean;
  progressive?: boolean;
} = {}) {
  const track = (kind: 'video' | 'audio') => ({
    id: kind === 'video' ? 80 : 30216,
    baseUrl: `https://cdn.example/${kind}.m4s?token=fresh`,
    mimeType: `${kind}/mp4`,
    codecs: kind === 'video' ? 'avc1.640028' : 'mp4a.40.2',
    SegmentBase: { Initialization: '0-99', indexRange: '100-149' },
  });
  const videoInfo = {
    timelength: 1_710_122,
    is_drm: options.drm ?? null,
    ...(options.progressive ? {
      format: 'mp4',
      durl: [{ url: 'https://cdn.example/full.mp4?token=fresh', length: 1_710_122 }],
    } : { dash: { video: [track('video')], audio: [track('audio')] } }),
  };
  return `<!doctype html><script>const playurlSSRData = ${JSON.stringify({
    status: 200,
    data: { result: {
      arc: { cid: options.cid ?? 1002 },
      ...(options.episodeId === undefined ? {} : { ep_id: options.episodeId }),
      play_video_type: options.preview ? 'preview' : 'whole',
      video_info: videoInfo,
    } },
  })}; window.__playinfo__ = playurlSSRData.data;</script>`;
}

describe('Bilibili bangumi discovery', () => {
  it('matches only exact Bilibili HTTPS episode and season pages', () => {
    expect(supportsSiteDiscovery('https://www.bilibili.com/bangumi/play/ep3854817?from=test')).toBe(true);
    expect(supportsSiteDiscovery('https://www.bilibili.com/bangumi/play/ss28747/')).toBe(true);
    for (const url of [
      'https://www.bilibili.com.evil.test/bangumi/play/ep1',
      'https://www.bilibili.com:8443/bangumi/play/ep1',
      'https://user:password@www.bilibili.com/bangumi/play/ep1',
      'http://www.bilibili.com/bangumi/play/ep1',
      'https://www.bilibili.com/bangumi/play/ep0',
      'https://www.bilibili.com/bangumi/media/md1',
    ]) expect(supportsSiteDiscovery(url)).toBe(false);
  });

  it.each([
    ['ep102', 'ep_id', '102'],
    ['ss28747', 'season_id', '28747'],
  ])('discovers the complete main episode list for %s', async (path, parameter, value) => {
    const fetchText = vi.fn(async () => JSON.stringify(seasonResponse()));
    const items = await bilibiliDiscoveryAdapter.discover(
      {} as Document,
      new URL(`https://www.bilibili.com/bangumi/play/${path}`),
      { fetchText },
    );
    expect(fetchText).toHaveBeenCalledOnce();
    expect(fetchText.mock.calls[0]).toEqual([
      `https://api.bilibili.com/pgc/view/web/season?${parameter}=${value}`,
      undefined,
    ]);
    expect(items).toEqual([
      {
        id: 'bilibili:ep101:1001', adapterId: 'bilibili',
        pageUrl: 'https://www.bilibili.com/bangumi/play/ep101', title: '第1集 - Beginning',
        seriesTitle: 'Example series', sequence: 1,
      },
      {
        id: 'bilibili:ep102:1002', adapterId: 'bilibili',
        pageUrl: 'https://www.bilibili.com/bangumi/play/ep102', title: '第2话 Next',
        seriesTitle: 'Example series', sequence: 2,
      },
    ]);
    expect(JSON.stringify(items)).not.toContain('token=');
  });

  it('discovers only the selected bonus section when viewing an extra', () => {
    const items = parseBilibiliSeasonItems(JSON.stringify(seasonResponse()), { episodeId: 201 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'bilibili:ep201:2001', title: '预告 - 第2集 - Trailer' });
  });

  it('rejects a detail response for a different episode or season', () => {
    expect(() => parseBilibiliSeasonItems(JSON.stringify(seasonResponse()), { episodeId: 999 }))
      .toThrow(/requested episode/i);
    expect(() => parseBilibiliSeasonItems(JSON.stringify(seasonResponse()), { seasonId: 999 }))
      .toThrow(/invalid season identity/i);
  });

  it('resolves fresh DASH media from authenticated page SSR at task start', async () => {
    const fetchText = vi.fn(async () => playbackPage());
    const controller = new AbortController();
    await expect(resolveDiscoveredMedia(discoveredEpisode(), { fetchText, signal: controller.signal }))
      .resolves.toMatchObject({
        kind: 'dash',
        url: 'https://www.bilibili.com/bangumi/play/ep102',
        dash: {
          durationSeconds: 1710.122,
          hasContentProtection: false,
          tracks: [{ kind: 'video' }, { kind: 'audio' }],
        },
      });
    expect(fetchText).toHaveBeenCalledWith('https://www.bilibili.com/bangumi/play/ep102', controller.signal);
  });

  it('resolves a full single-file MP4 without misclassifying it as DASH', async () => {
    await expect(resolveDiscoveredMedia(discoveredEpisode(), {
      fetchText: async () => playbackPage({ progressive: true }),
    })).resolves.toEqual({
      kind: 'progressive', url: 'https://cdn.example/full.mp4?token=fresh', title: '第2话 Next',
    });
  });

  it.each([
    [{ preview: true }, /only a preview/i],
    [{ progressive: true, preview: true }, /only a preview/i],
    [{ drm: true }, /DRM-protected/i],
    [{ cid: 2002 }, /does not match.*identity/i],
    [{ episodeId: 999 }, /does not match.*identity/i],
  ])('rejects a preview, DRM, or mismatched playback identity (%s)', async (options, error) => {
    await expect(resolveDiscoveredMedia(discoveredEpisode(), {
      fetchText: async () => playbackPage(options),
    })).rejects.toThrow(error);
  });

  it.each([
    'https://www.bilibili.com/bangumi/play/ep101',
    'https://www.bilibili.com/bangumi/play/ss28747',
    'https://evil.test/bangumi/play/ep102',
  ])('rejects a tampered queued page without fetching %s', async (pageUrl) => {
    const fetchText = vi.fn();
    await expect(resolveDiscoveredMedia({ ...discoveredEpisode(), pageUrl }, { fetchText }))
      .rejects.toThrow(/invalid media identity/i);
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('does not execute page scripts or accept media without its cid binding', async () => {
    const html = playbackPage().replace('"cid":1002', '"other":1002');
    await expect(resolveDiscoveredMedia(discoveredEpisode(), { fetchText: async () => html }))
      .rejects.toThrow(/does not match.*identity/i);
    await expect(resolveDiscoveredMedia(discoveredEpisode(), {
      fetchText: async () => '<script>window.__playinfo__ = getMediaWithSideEffects();</script>',
    })).rejects.toThrow(/does not provide playable media/i);
  });
});
