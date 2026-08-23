import {
  parseHlsPlaylist,
  type HlsMasterPlaylist,
  type HlsMediaPlaylist,
  type HlsRendition,
  type HlsVariant,
} from '../protocols/hls';

export interface InspectedHls {
  master?: HlsMasterPlaylist;
  media: HlsMediaPlaylist;
  selectedVariant?: HlsVariant;
  audioMedia?: HlsMediaPlaylist;
  selectedAudioRendition?: HlsRendition;
}

export type HlsTextLoader = (url: string, signal?: AbortSignal) => Promise<string>;

export function preferredHlsVariant(master: HlsMasterPlaylist): HlsVariant {
  return [...master.variants].sort((left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0))[0]!;
}

export function preferredHlsAudioRendition(
  master: HlsMasterPlaylist,
  variant: HlsVariant,
): HlsRendition | undefined {
  if (!variant.audioGroup) return undefined;
  const candidates = master.renditions.filter((rendition) =>
    rendition.type === 'AUDIO' &&
    rendition.groupId === variant.audioGroup &&
    Boolean(rendition.uri));
  return candidates.find((rendition) => rendition.isDefault) ??
    candidates.find((rendition) => rendition.autoSelect) ??
    candidates[0];
}

function mediaPlaylist(text: string, url: string, label: string): HlsMediaPlaylist {
  const parsed = parseHlsPlaylist(text, url);
  if (parsed.type !== 'media') throw new Error(`The selected HLS ${label} did not resolve to a media playlist.`);
  return parsed;
}

export async function inspectHlsVariant(
  master: HlsMasterPlaylist,
  selectedVariant: HlsVariant,
  loadText: HlsTextLoader,
  signal?: AbortSignal,
  selectedAudioRendition = preferredHlsAudioRendition(master, selectedVariant),
): Promise<InspectedHls> {
  const [videoText, audioText] = await Promise.all([
    loadText(selectedVariant.uri, signal),
    selectedAudioRendition?.uri ? loadText(selectedAudioRendition.uri, signal) : undefined,
  ]);
  const media = mediaPlaylist(videoText, selectedVariant.uri, 'variant');
  const audioMedia = selectedAudioRendition?.uri && audioText !== undefined
    ? mediaPlaylist(audioText, selectedAudioRendition.uri, 'audio rendition')
    : undefined;
  return {
    master,
    media,
    selectedVariant,
    ...(audioMedia ? { audioMedia } : {}),
    ...(selectedAudioRendition ? { selectedAudioRendition } : {}),
  };
}

export async function inspectHlsUrl(
  url: string,
  loadText: HlsTextLoader,
  signal?: AbortSignal,
): Promise<InspectedHls> {
  const parsed = parseHlsPlaylist(await loadText(url, signal), url);
  if (parsed.type === 'media') return { media: parsed };

  const selectedVariant = preferredHlsVariant(parsed);
  return inspectHlsVariant(parsed, selectedVariant, loadText, signal);
}
