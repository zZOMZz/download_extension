import type { MediaCandidate } from '../shared/media';

export interface VideoQualityOption {
  id: string;
  height: number;
  width: number;
  frameRate: number;
  bandwidth: number;
}

/** One representation per resolution; retain the highest bitrate supplied by the site. */
export function candidateVideoQualities(candidate: Pick<MediaCandidate, 'kind' | 'dash' | 'youtubeSabr'>): VideoQualityOption[] {
  const options = candidate.kind === 'sabr'
    ? (candidate.youtubeSabr?.formats ?? []).filter(({ mimeType }) => /^video\/mp4/i.test(mimeType))
      .map((format) => ({
        id: String(format.itag), height: format.height ?? 0, width: format.width ?? 0,
        frameRate: format.fps ?? 0, bandwidth: format.averageBitrate ?? format.bitrate,
      }))
    : candidate.kind === 'dash'
      ? (candidate.dash?.tracks ?? []).filter(({ kind }) => kind === 'video')
        .map((track) => ({
          id: track.id, height: track.height ?? 0, width: track.width ?? 0,
          frameRate: track.frameRate ?? 0, bandwidth: track.bandwidth ?? 0,
        }))
      : [];
  const sorted = options.filter(({ height }) => height > 0)
    .sort((left, right) => right.height - left.height || right.bandwidth - left.bandwidth ||
      right.frameRate - left.frameRate || right.width - left.width);
  const resolutions = new Set<number>();
  return sorted.filter(({ height }) => {
    if (resolutions.has(height)) return false;
    resolutions.add(height);
    return true;
  });
}

export function selectedVideoQuality(options: readonly VideoQualityOption[], requested?: string | null): string {
  return options.find(({ id }) => id === requested)?.id ?? options[0]?.id ?? '';
}

export function videoQualityLabel(option: VideoQualityOption): string {
  return `${option.height}p${option.height === 2160 ? ' · 4K' : option.height === 4320 ? ' · 8K' : ''}`;
}
