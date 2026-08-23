import type { HlsMediaPlaylist } from '../protocols/hls';
import type { InspectedHls } from './inspect-hls';

export function hasSeparateAudio(hls: InspectedHls): boolean {
  return hls.audioMedia !== undefined;
}

export function combinedHlsMediaPlaylist(hls: InspectedHls): HlsMediaPlaylist {
  if (!hls.audioMedia) return hls.media;
  const targetDurations = [hls.media.targetDuration, hls.audioMedia.targetDuration]
    .filter((duration): duration is number => duration !== undefined);
  const targetDuration = targetDurations.length ? Math.max(...targetDurations) : undefined;
  return {
    type: 'media',
    mediaSequence: 0,
    endList: hls.media.endList && hls.audioMedia.endList,
    segments: [
      ...hls.media.segments.map((segment) => ({ ...segment, streamRole: 'video' as const })),
      ...hls.audioMedia.segments.map((segment) => ({ ...segment, streamRole: 'audio' as const })),
    ],
    ...(targetDuration === undefined ? {} : { targetDuration }),
    ...(hls.media.playlistType === 'VOD' && hls.audioMedia.playlistType === 'VOD'
      ? { playlistType: 'VOD' }
      : {}),
  };
}

export function hlsPlaylistUsesFmp4(playlist: HlsMediaPlaylist): boolean {
  return playlist.segments.some((segment) => Boolean(segment.map));
}
