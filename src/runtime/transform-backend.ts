import type { BinaryWriter, RandomAccessBinaryWriter } from '../core/hls/download-hls';
import type { HlsOutputPlan } from '../core/hls/output-plan';

/** The host chooses in-process, worker, or native transforms behind the same writer contract. */
export interface TransformBackend {
  createHlsWriter(destination: RandomAccessBinaryWriter, plan: HlsOutputPlan): BinaryWriter;
  createDashWriter(
    destination: RandomAccessBinaryWriter,
    videoSegmentCount: number,
    audioSegmentCount: number,
  ): BinaryWriter;
}
