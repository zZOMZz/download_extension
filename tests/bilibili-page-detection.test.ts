import { describe, expect, it } from 'vitest';
import { bilibiliDetectionAdapter } from '../src/core/detection/adapters/bilibili';
import { BILIBILI_PLAYER_SELECTOR, isBilibiliPlaybackRequest } from '../src/core/site-adapters/bilibili/player-state';

const page = new URL('https://www.bilibili.com/bangumi/play/ep3854817');
const mp4 = 'https://upos-sz-mirrorcos.bilivideo.com/clip.mp4';
function documentWith(script: string, state?: unknown): Document {
  return {
    title: 'Episode 193',
    querySelectorAll: () => [{ textContent: script }],
    querySelector: (selector: string) => selector === BILIBILI_PLAYER_SELECTOR && state
      ? { textContent: JSON.stringify(state) } : null,
  } as unknown as Document;
}
function scriptFor(videoInfo: unknown) {
  return `const playurlSSRData = ${JSON.stringify({ data: { result: { video_info: videoInfo } } })}; window.__playinfo__ = playurlSSRData.data;`;
}

describe('Bilibili episode detection', () => {
  it('exposes a preview explicitly with its own source page and request adapter', () => {
    const observations = bilibiliDetectionAdapter.detect(documentWith(scriptFor({
      is_preview: true, format: 'mp4', durl: [{ url: mp4, length: 180_000 }],
    })), page);
    expect(observations).toMatchObject([{
      kind: 'progressive', url: mp4, sourcePageUrl: page.href, isPreview: true,
      siteAdapterId: 'bilibili', hasContentProtection: false,
    }]);
  });

  it('reports DRM as unavailable even when a URL exists', () => {
    expect(bilibiliDetectionAdapter.detect(documentWith(scriptFor({
      is_drm: true, durl: [{ url: mp4 }],
    })), page)).toMatchObject([{ kind: 'blob', hasContentProtection: true }]);
  });

  it('prefers live metadata and ignores a stale episode bridge', () => {
    const playback = { progressiveUrl: mp4, isPreview: false, hasContentProtection: false };
    expect(bilibiliDetectionAdapter.detect(documentWith('', { pageUrl: page.href, playback }), page))
      .toMatchObject([{ kind: 'progressive', isPreview: false }]);
    expect(bilibiliDetectionAdapter.detect(documentWith('', {
      pageUrl: 'https://www.bilibili.com/bangumi/play/ep1231581', playback,
    }), page)).toEqual([]);
  });

  it('refuses foreign media URLs and claims CDN segments for site assembly', () => {
    expect(bilibiliDetectionAdapter.detect(documentWith(scriptFor({
      durl: [{ url: 'https://bilivideo.com.attacker.example/video.mp4' }],
    })), page)).toEqual([]);
    expect(bilibiliDetectionAdapter.claimsResource?.(new URL(mp4))).toBe(true);
    expect(bilibiliDetectionAdapter.claimsResource?.(new URL('https://notbilivideo.com/clip.mp4'))).toBe(false);
  });

  it('observes only playback endpoints for the current episode', () => {
    expect(isBilibiliPlaybackRequest('https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=3854817', page.href)).toBe(true);
    expect(isBilibiliPlaybackRequest('https://api.bilibili.com/x/player/wbi/playurl?cid=10', page.href)).toBe(true);
    expect(isBilibiliPlaybackRequest('https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=1231581', page.href)).toBe(false);
    expect(isBilibiliPlaybackRequest('https://api.bilibili.com/x/web-interface/nav', page.href)).toBe(false);
    expect(isBilibiliPlaybackRequest('https://api.bilibili.com.attacker.example/x/player/playurl', page.href)).toBe(false);
  });
});
