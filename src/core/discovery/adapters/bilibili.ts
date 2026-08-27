import type { DiscoveredMediaItem } from '../../../shared/discovery';
import { parseBilibiliPlayInfoResponse } from '../../site-adapters/bilibili/play-info';
import type { SiteDiscoveryAdapter } from '../types';

type JsonRecord = Record<string, unknown>;

const ADAPTER_ID = 'bilibili';
const BVID = /^BV[0-9A-Za-z]+$/;
const VIDEO_PATH = /^\/video\/(BV[0-9A-Za-z]+)\/?$/;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is JsonRecord => Boolean(item))
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function bvidValue(value: unknown): string | undefined {
  const parsed = text(value);
  return parsed && BVID.test(parsed) ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function matchesBilibiliVideoPage(pageUrl: URL): boolean {
  return pageUrl.hostname === 'www.bilibili.com' && VIDEO_PATH.test(pageUrl.pathname);
}

function videoPageUrl(bvid: string, page: number): string {
  const url = new URL(`/video/${bvid}/`, 'https://www.bilibili.com');
  url.searchParams.set('p', String(page));
  return url.href;
}

function item(
  bvid: string,
  cid: number,
  page: number,
  title: string,
  seriesTitle: string,
  sequence: number,
): DiscoveredMediaItem {
  return {
    id: `${ADAPTER_ID}:${bvid}:${cid}`,
    adapterId: ADAPTER_ID,
    pageUrl: videoPageUrl(bvid, page),
    title,
    mediaKind: 'dash',
    seriesTitle,
    sequence,
  };
}

function episodePages(episode: JsonRecord): JsonRecord[] {
  const pages = records(episode.pages);
  if (pages.length) return pages;
  const page = asRecord(episode.page);
  return page ? [page] : [];
}

export function parseBilibiliViewItems(responseText: string): DiscoveredMediaItem[] {
  let root: JsonRecord | undefined;
  try {
    root = asRecord(JSON.parse(responseText));
  } catch {
    throw new Error('The Bilibili video detail response is not valid JSON.');
  }
  if (root?.code !== 0) {
    throw new Error(text(root?.message) ?? 'Bilibili rejected the video detail request.');
  }
  const data = asRecord(root.data);
  const currentBvid = bvidValue(data?.bvid);
  const videoTitle = text(data?.title);
  if (!data || !currentBvid || !videoTitle) {
    throw new Error('The Bilibili video detail response is incomplete.');
  }

  const discovered: DiscoveredMediaItem[] = [];
  const season = asRecord(data.ugc_season);
  const seasonTitle = text(season?.title);
  if (season && seasonTitle) {
    for (const section of records(season.sections)) {
      for (const episode of records(section.episodes)) {
        const bvid = bvidValue(episode.bvid);
        const episodeTitle = text(episode.title) ?? text(asRecord(episode.arc)?.title);
        if (!bvid || !episodeTitle) continue;
        const pages = episodePages(episode);
        for (const [index, pageData] of pages.entries()) {
          const cid = positiveInteger(pageData.cid);
          const page = positiveInteger(pageData.page) ?? index + 1;
          if (!cid) continue;
          const part = text(pageData.part);
          const pageTitle = pages.length > 1
            ? [episodeTitle, `P${page}`, part && part !== episodeTitle ? part : undefined]
                .filter(Boolean)
                .join(' - ')
            : episodeTitle;
          discovered.push(item(bvid, cid, page, pageTitle, seasonTitle, discovered.length + 1));
        }
      }
    }
  }

  if (!discovered.length) {
    const pages = records(data.pages);
    for (const [index, pageData] of pages.entries()) {
      const cid = positiveInteger(pageData.cid);
      const page = positiveInteger(pageData.page) ?? index + 1;
      if (!cid) continue;
      const part = text(pageData.part);
      const pageTitle = pages.length > 1
        ? [`P${page}`, part].filter(Boolean).join(' - ')
        : part ?? videoTitle;
      discovered.push(item(currentBvid, cid, page, pageTitle, videoTitle, discovered.length + 1));
    }
  }

  return [...new Map(discovered.map((entry) => [entry.id, entry])).values()];
}

function itemIdentity(discovered: DiscoveredMediaItem): { bvid: string; cid: number } | undefined {
  const match = /^bilibili:(BV[0-9A-Za-z]+):(\d+)$/.exec(discovered.id);
  if (!match?.[1] || !match[2]) return undefined;
  const cid = positiveInteger(match[2]);
  return cid ? { bvid: match[1], cid } : undefined;
}

function viewApiUrl(bvid: string): string {
  const url = new URL('https://api.bilibili.com/x/web-interface/view');
  url.searchParams.set('bvid', bvid);
  return url.href;
}

function playApiUrl(bvid: string, cid: number): string {
  const url = new URL('https://api.bilibili.com/x/player/playurl');
  url.searchParams.set('bvid', bvid);
  url.searchParams.set('cid', String(cid));
  url.searchParams.set('qn', '127');
  url.searchParams.set('fnver', '0');
  url.searchParams.set('fnval', '4048');
  url.searchParams.set('fourk', '1');
  return url.href;
}

export const bilibiliDiscoveryAdapter: SiteDiscoveryAdapter = {
  id: ADAPTER_ID,
  matches: matchesBilibiliVideoPage,
  async discover(_document, pageUrl, context) {
    if (!matchesBilibiliVideoPage(pageUrl) || !context) return [];
    const bvid = VIDEO_PATH.exec(pageUrl.pathname)?.[1];
    if (!bvid) return [];
    return parseBilibiliViewItems(await context.fetchText(viewApiUrl(bvid), context.signal));
  },
  async resolve(discovered, context) {
    const identity = itemIdentity(discovered);
    let pageUrl: URL | undefined;
    try {
      pageUrl = new URL(discovered.pageUrl);
    } catch {
      // The shared schema normally rejects invalid URLs; keep the adapter fail-closed as well.
    }
    const pageBvid = pageUrl && matchesBilibiliVideoPage(pageUrl)
      ? VIDEO_PATH.exec(pageUrl.pathname)?.[1]
      : undefined;
    if (
      !identity ||
      discovered.adapterId !== ADAPTER_ID ||
      pageBvid !== identity.bvid
    ) {
      throw new Error('The queued Bilibili item has an invalid media identity.');
    }
    const response = await context.fetchText(
      playApiUrl(identity.bvid, identity.cid),
      context.signal,
    );
    const dash = parseBilibiliPlayInfoResponse(response);
    if (!dash) throw new Error('The Bilibili play response does not contain supported DASH tracks.');
    return {
      kind: 'dash',
      url: discovered.pageUrl,
      title: discovered.title,
      dash,
    };
  },
};
