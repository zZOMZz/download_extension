import type { OutputFormat } from '../../shared/settings';
import type { InspectedHls } from './inspect-hls';
import {
  combinedHlsMediaPlaylist,
  hasSeparateAudio,
  hlsPlaylistUsesFmp4,
} from './media-bundle';

export interface HlsOutputPlan {
  extension: 'mp4' | 'ts';
  mimeType: 'video/mp4' | 'video/mp2t';
  remuxTs: boolean;
  resumableTs: boolean;
  separateAudio: boolean;
  fragmentedMp4: boolean;
  videoSegmentCount: number;
  audioSegmentCount: number;
}

export function createHlsOutputPlan(
  hls: InspectedHls,
  outputFormat: OutputFormat,
): HlsOutputPlan {
  const fragmentedMp4 = hlsPlaylistUsesFmp4(combinedHlsMediaPlaylist(hls));
  const remuxTs = outputFormat === 'mp4' && !fragmentedMp4;
  const extension = fragmentedMp4 || remuxTs ? 'mp4' : 'ts';
  return {
    extension,
    mimeType: extension === 'mp4' ? 'video/mp4' : 'video/mp2t',
    remuxTs,
    resumableTs: !fragmentedMp4,
    separateAudio: hasSeparateAudio(hls),
    fragmentedMp4,
    videoSegmentCount: hls.media.segments.length,
    audioSegmentCount: hls.audioMedia?.segments.length ?? 0,
  };
}
