import type { BinaryWriter, RandomAccessBinaryWriter } from '../core/hls/download-hls';
import type { HlsOutputPlan } from '../core/hls/output-plan';
import { SeparateTrackFmp4Writer } from './separate-track-fmp4-writer';
import { SeparateTrackTsToMp4Writer, TsToMp4Writer } from './transmuxing-writer';

export function createHlsOutputWriter(
  destination: RandomAccessBinaryWriter,
  plan: HlsOutputPlan,
): BinaryWriter {
  if (plan.separateAudio) {
    return plan.fragmentedMp4
      ? new SeparateTrackFmp4Writer(destination, plan.videoSegmentCount, plan.audioSegmentCount)
      : new SeparateTrackTsToMp4Writer(destination, plan.videoSegmentCount, plan.audioSegmentCount);
  }
  return plan.remuxTs ? new TsToMp4Writer(destination) : destination;
}
