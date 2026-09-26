import type { DiscoveredMediaItem } from '../../../shared/discovery';
import {
  parseBilibiliPlaybackInfoResponse,
  parseBilibiliPlaybackInfoScript,
  type BilibiliPlaybackInfo,
} from '../../site-adapters/bilibili/play-info';
import type { SiteDiscoveryAdapter } from '../types';

type JsonRecord = Record<string, unknown>;

const ADAPTER_ID = 'bilibili';
const BVID = /^BV[0-9A-Za-z]+$/;
const VIDEO_PATH = /^\/video\/(BV[0-9A-Za-z]+)\/?$/;
const BANGUMI_PATH = /^\/bangumi\/play\/(ep|ss)([1-9]\d*)\/?$/;

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
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function matchesBilibiliVideoPage(pageUrl: URL): boolean {
  return isBilibiliPage(pageUrl) && VIDEO_PATH.test(pageUrl.pathname);
}

function isBilibiliPage(pageUrl: URL): boolean {
  return pageUrl.protocol === 'https:' && pageUrl.hostname === 'www.bilibili.com' &&
    !pageUrl.port && !pageUrl.username && !pageUrl.password;
}

function bangumiPageIdentity(pageUrl: URL): { episodeId?: number; seasonId?: number } | undefined {
  if (!isBilibiliPage(pageUrl)) return undefined;
  const match = BANGUMI_PATH.exec(pageUrl.pathname);
  const id = positiveInteger(match?.[2]);
  return id ? (match?.[1] === 'ep' ? { episodeId: id } : { seasonId: id }) : undefined;
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

/** The season response includes trailers interleaved with main episodes on current PGC pages. */
export function parseBilibiliSeasonItems(
  responseText: string,
  expected: { episodeId?: number; seasonId?: number } = {},
): DiscoveredMediaItem[] {
  let root: JsonRecord | undefined;
  try {
    root = asRecord(JSON.parse(responseText));
  } catch {
    throw new Error('The Bilibili season detail response is not valid JSON.');
  }
  if (root?.code !== 0) {
    throw new Error(text(root?.message) ?? 'Bilibili rejected the season detail request.');
  }
  const season = asRecord(root.result);
  const seasonId = positiveInteger(season?.season_id);
  const seriesTitle = text(season?.title) ?? text(season?.season_title);
  if (!season || !seasonId || !seriesTitle || (expected.seasonId && expected.seasonId !== seasonId)) {
    throw new Error('The Bilibili season detail response has an invalid season identity.');
  }

  const mainEpisodes = records(season.episodes).filter((episode) =>
    episode.section_type === undefined || episode.section_type === 0);
  const episodeId = (episode: JsonRecord) => positiveInteger(episode.ep_id ?? episode.id);
  let episodes = mainEpisodes;
  let sectionTitle: string | undefined;
  if (expected.episodeId && !mainEpisodes.some((episode) => episodeId(episode) === expected.episodeId)) {
    // Selecting a trailer or extra discovers that section, without mixing it into the full episodes.
    const section = records(season.section).find((entry) =>
      records(entry.episodes).some((episode) => episodeId(episode) === expected.episodeId));
    if (!section) throw new Error('The Bilibili season detail response does not contain the requested episode.');
    episodes = records(section.episodes);
    sectionTitle = text(section.title);
  }

  const items = new Map<string, DiscoveredMediaItem>();
  for (const episode of episodes) {
    const id = episodeId(episode);
    const cid = positiveInteger(episode.cid);
    if (!id || !cid || episode.is_view_hide === true) continue;
    const indexTitle = text(episode.title);
    const title = text(episode.show_title) ?? ([
      indexTitle && /^\d+(?:\.\d+)?$/.test(indexTitle) ? `第${indexTitle}集` : indexTitle,
      text(episode.long_title),
    ].filter(Boolean).join(' - ') || `ep${id}`);
    const itemId = `${ADAPTER_ID}:ep${id}:${cid}`;
    if (items.has(itemId)) continue;
    items.set(itemId, {
      id: itemId,
      adapterId: ADAPTER_ID,
      pageUrl: `https://www.bilibili.com/bangumi/play/ep${id}`,
      title: sectionTitle ? `${sectionTitle} - ${title}` : title,
      seriesTitle,
      sequence: items.size + 1,
    });
  }
  return [...items.values()];
}

function playbackFromPage(page: string): BilibiliPlaybackInfo | undefined {
  // Keep the JavaScript parser scoped to script bodies, so HTML comments/URLs cannot affect its lexer.
  for (const match of page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const info = parseBilibiliPlaybackInfoScript(match[1] ?? '');
    if (info) return info;
  }
  return undefined;
}

function assertFullPlayback(info: BilibiliPlaybackInfo): void {
  if (info.hasContentProtection) throw new Error('DRM-protected Bilibili media is not supported.');
  if (info.isPreview) {
    throw new Error('Bilibili returned only a preview. Sign in with full playback access and retry this episode.');
  }
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
  matches: (pageUrl) => matchesBilibiliVideoPage(pageUrl) || Boolean(bangumiPageIdentity(pageUrl)),
  async discover(_document, pageUrl, context) {
    const bangumi = bangumiPageIdentity(pageUrl);
    if (bangumi && context) {
      // The PGC season endpoint returns the whole season, including pages not currently visible in the UI.
      const url = new URL('https://api.bilibili.com/pgc/view/web/season');
      url.searchParams.set(bangumi.episodeId ? 'ep_id' : 'season_id', String(bangumi.episodeId ?? bangumi.seasonId));
      return parseBilibiliSeasonItems(await context.fetchText(url.href, context.signal), bangumi);
    }
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
    const bangumi = pageUrl && bangumiPageIdentity(pageUrl);
    const bangumiItem = /^bilibili:ep([1-9]\d*):([1-9]\d*)$/.exec(discovered.id);
    if (bangumi || bangumiItem) {
      const episodeId = positiveInteger(bangumiItem?.[1]);
      const cid = positiveInteger(bangumiItem?.[2]);
      if (!episodeId || !cid || discovered.adapterId !== ADAPTER_ID || bangumi?.episodeId !== episodeId) {
        throw new Error('The queued Bilibili item has an invalid media identity.');
      }
      const info = playbackFromPage(await context.fetchText(
        `https://www.bilibili.com/bangumi/play/ep${episodeId}`,
        context.signal,
      ));
      if (!info) throw new Error('The Bilibili episode page does not provide playable media. Check playback access and retry.');
      assertFullPlayback(info);
      if (info.cid !== cid || (info.episodeId !== undefined && info.episodeId !== episodeId)) {
        throw new Error('The Bilibili episode playback response does not match the queued media identity.');
      }
      if (info.dash) return { kind: 'dash', url: discovered.pageUrl, title: discovered.title, dash: info.dash };
      if (info.progressiveUrl) return { kind: 'progressive', url: info.progressiveUrl, title: discovered.title };
      throw new Error('The Bilibili episode page does not contain supported DASH or MP4 media.');
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
    const info = parseBilibiliPlaybackInfoResponse(response);
    if (info) assertFullPlayback(info);
    if (!info?.dash) throw new Error('The Bilibili play response does not contain supported DASH tracks.');
    return {
      kind: 'dash',
      url: discovered.pageUrl,
      title: discovered.title,
      dash: info.dash,
    };
  },
};
