import { z } from 'zod';
import { dashMediaSourceSchema } from '../../../shared/media';

export const BILIBILI_PLAYER_ATTRIBUTE = 'data-open-media-downloader-bilibili-player';
export const BILIBILI_PLAYER_SELECTOR = `[${BILIBILI_PLAYER_ATTRIBUTE}]`;

const playbackSchema = z.object({
  dash: dashMediaSourceSchema.optional(),
  progressiveUrl: z.string().url().optional(),
  isPreview: z.boolean(),
  hasContentProtection: z.boolean(),
  episodeId: z.number().int().positive().optional(),
  cid: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
});

export const bilibiliPlayerStateSchema = z.object({
  pageUrl: z.string().url(),
  playback: playbackSchema,
});

export function bilibiliPageIdentity(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (!['https:', 'http:'].includes(url.protocol) ||
        !['www.bilibili.com', 'm.bilibili.com'].includes(url.hostname)) return undefined;
    const bangumi = /^\/bangumi\/play\/(ep\d+|ss\d+)\/?$/.exec(url.pathname);
    if (bangumi) return bangumi[1];
    const video = /^\/video\/(BV[0-9A-Za-z]+)\/?$/.exec(url.pathname);
    if (video) return `${video[1]}:p${url.searchParams.get('p') || '1'}`;
  } catch { /* Unrelated or malformed page. */ }
  return undefined;
}

export function isBilibiliMediaUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return ['https:', 'http:'].includes(url.protocol) &&
      ['bilivideo.com', 'bilivideo.cn'].some((domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

/** Playback responses only: never observe account APIs or unrelated JSON. */
export function isBilibiliPlaybackRequest(rawUrl: string, pageUrl: string): boolean {
  try {
    const url = new URL(rawUrl, pageUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'api.bilibili.com' ||
        !/^\/(?:pgc|x)\/player\/(?:[^/]+\/)*playurl(?:\/v\d+)?$/.test(url.pathname)) return false;
    const identity = bilibiliPageIdentity(pageUrl);
    if (!identity) return false;
    const episodeId = url.searchParams.get('ep_id');
    return !episodeId || !identity.startsWith('ep') || identity === `ep${episodeId}`;
  } catch { return false; }
}
