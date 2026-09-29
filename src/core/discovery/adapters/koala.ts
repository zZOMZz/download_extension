import { isKoalaDiscoveryPage, koalaVideoId, koalaVideoUrl } from '../../site-adapters/koala/identity';
import type { SiteDiscoveryAdapter } from '../types';
import type { DiscoveredMediaItem } from '../../../shared/discovery';

export function koalaItem(pageUrl: string, title: string, sequence?: number): DiscoveredMediaItem {
  const id = koalaVideoId(pageUrl);
  if (!id) throw new Error('Unsupported Koala video page.');
  return { id: `koala:${id}`, adapterId: 'koala', pageUrl: koalaVideoUrl(id), title: title.trim() || 'Koala video',
    mediaKind: 'hls', executionMode: 'browser-session', ...(sequence === undefined ? {} : { sequence }) };
}

export const koalaDiscoveryAdapter: SiteDiscoveryAdapter = {
  id: 'koala', matches: isKoalaDiscoveryPage,
  discover(document, pageUrl) {
    if (!isKoalaDiscoveryPage(pageUrl)) return [];
    if (koalaVideoId(pageUrl.href)) {
      return [koalaItem(pageUrl.href, document.querySelector('h1')?.textContent || document.title)];
    }
    const items = new Map<string, DiscoveredMediaItem>();
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = anchor.getAttribute('href'); if (!href) continue;
      let url: URL; try { url = new URL(href, pageUrl); } catch { continue; }
      const id = koalaVideoId(url.href); if (!id || items.has(id)) continue;
      const title = anchor.querySelector('h3')?.textContent || anchor.textContent || '';
      if (title.trim()) items.set(id, koalaItem(url.href, title, items.size + 1));
    }
    return [...items.values()];
  },
  async resolve(item) {
    const id = koalaVideoId(item.pageUrl);
    if (!id) throw new Error('The Koala source page is unsupported.');
    return { kind: 'hls', url: koalaVideoUrl(id), title: item.title,
      browserSource: { providerId: 'aliplayer', mediaId: id, pageUrl: koalaVideoUrl(id) } };
  },
};
