import type { SiteDiscoveryAdapter } from '../types';

const ADAPTER_ID = '2rk-series';
const DETAIL_PATH = /^\/detail\/([^/]+)$/;

function matchesTwoRkDetailPage(pageUrl: URL): boolean {
  return (
    (pageUrl.hostname === '2rk.cc' || pageUrl.hostname === 'www.2rk.cc') &&
    DETAIL_PATH.test(pageUrl.pathname)
  );
}

function seriesTitle(document: Document): string | undefined {
  const heading = [...document.querySelectorAll('h2')]
    .map((element) => element.textContent?.trim())
    .find((value): value is string => Boolean(value));
  if (heading) return heading;

  const title = document.title.split(' - ', 1)[0]?.trim();
  return title || undefined;
}

export function extractTwoRkMediaUrl(pageSource: string, pageUrl: string): string | undefined {
  const match = /\.loadSource\(\s*(["'`])([^"'`]+?\.m3u8(?:\?[^"'`]*)?)\1\s*\)/i.exec(pageSource);
  if (!match?.[2]) return undefined;
  try {
    return new URL(match[2], pageUrl).href;
  } catch {
    return undefined;
  }
}

export const twoRkDiscoveryAdapter: SiteDiscoveryAdapter = {
  id: ADAPTER_ID,
  matches: matchesTwoRkDetailPage,
  discover(document, pageUrl) {
    if (!matchesTwoRkDetailPage(pageUrl)) return [];
    const animeId = DETAIL_PATH.exec(pageUrl.pathname)?.[1];
    if (!animeId) return [];

    const groupTitle = seriesTitle(document);
    const items = new Map<number, { pageUrl: string; title: string }>();
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      let episodeUrl: URL;
      try {
        episodeUrl = new URL(anchor.href, pageUrl);
      } catch {
        continue;
      }
      if (episodeUrl.hostname !== pageUrl.hostname || episodeUrl.pathname !== pageUrl.pathname) continue;
      const sequence = Number.parseInt(episodeUrl.searchParams.get('id') ?? '', 10);
      if (!Number.isInteger(sequence) || sequence < 0) continue;
      const title = anchor.textContent?.trim() || `Episode ${sequence}`;
      items.set(sequence, { pageUrl: episodeUrl.href, title });
    }

    return [...items.entries()]
      .sort(([left], [right]) => left - right)
      .map(([sequence, item]) => ({
        id: `${ADAPTER_ID}:${animeId}:${sequence}`,
        adapterId: ADAPTER_ID,
        pageUrl: item.pageUrl,
        title: item.title,
        sequence,
        ...(groupTitle ? { seriesTitle: groupTitle } : {}),
      }));
  },
  async resolve(item, { fetchText, signal }) {
    const pageUrl = new URL(item.pageUrl);
    if (!matchesTwoRkDetailPage(pageUrl)) {
      throw new Error('The queued 2rk item no longer points to a supported detail page.');
    }
    const source = await fetchText(item.pageUrl, signal);
    const mediaUrl = extractTwoRkMediaUrl(source, item.pageUrl);
    if (!mediaUrl) throw new Error('The 2rk episode page does not expose an HLS media URL.');
    return { kind: 'hls', url: mediaUrl, title: item.title };
  },
};
