import {
  parseHlsPlaylist,
  type HlsMasterPlaylist,
  type HlsMediaPlaylist,
  type HlsVariant,
} from '../protocols/hls';

export interface InspectedHls {
  master?: HlsMasterPlaylist;
  media: HlsMediaPlaylist;
  selectedVariant?: HlsVariant;
}

export type HlsTextLoader = (url: string, signal?: AbortSignal) => Promise<string>;

export function preferredHlsVariant(master: HlsMasterPlaylist): HlsVariant {
  return [...master.variants].sort((left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0))[0]!;
}

export async function inspectHlsUrl(
  url: string,
  loadText: HlsTextLoader,
  signal?: AbortSignal,
): Promise<InspectedHls> {
  const parsed = parseHlsPlaylist(await loadText(url, signal), url);
  if (parsed.type === 'media') return { media: parsed };

  const selectedVariant = preferredHlsVariant(parsed);
  const media = parseHlsPlaylist(
    await loadText(selectedVariant.uri, signal),
    selectedVariant.uri,
  );
  if (media.type !== 'media') throw new Error('The selected HLS variant did not resolve to a media playlist.');
  return { master: parsed, media, selectedVariant };
}
