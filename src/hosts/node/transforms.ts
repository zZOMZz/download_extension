import muxjs from 'mux.js';
import type { TransformBackend } from '../../runtime/transform-backend';
import { SeparateTrackFmp4Writer } from '../../runtime/media/separate-track-fmp4-writer';
import {
  SeparateTrackTsToMp4Writer,
  TsToMp4Writer,
  type TransmuxOutput,
  type TransmuxSession,
} from '../../runtime/media/ts-to-mp4-writer';

/** The same mux.js state machine as the browser worker, hosted without DOM or Worker globals. */
class NodeTransmuxSession implements TransmuxSession {
  readonly #transmuxer: InstanceType<typeof muxjs.mp4.Transmuxer>;
  readonly #initialized = new Set<TransmuxOutput['mediaType']>();
  #outputs: TransmuxOutput[] = [];
  #pending: { resolve: (value: TransmuxOutput[]) => void; reject: (error: Error) => void } | undefined;
  #closed = false;

  constructor(separateTimeline: boolean) {
    this.#transmuxer = new muxjs.mp4.Transmuxer(separateTimeline
      ? { remux: false, keepOriginalTimestamps: true }
      : undefined);
    this.#transmuxer.on('data', (segment) => {
      const initializationSegment = this.#initialized.has(segment.type)
        ? undefined : segment.initSegment.slice().buffer as ArrayBuffer;
      this.#initialized.add(segment.type);
      this.#outputs.push({
        mediaType: segment.type,
        ...(initializationSegment ? { initializationSegment } : {}),
        data: segment.data.slice().buffer as ArrayBuffer,
      });
    });
    this.#transmuxer.on('done', () => {
      const pending = this.#pending;
      this.#pending = undefined;
      pending?.resolve(this.#outputs);
      this.#outputs = [];
    });
  }

  transmux(chunk: Uint8Array): Promise<TransmuxOutput[]> {
    if (this.#closed) return Promise.reject(new Error('The MP4 transform is already closed.'));
    if (this.#pending) return Promise.reject(new Error('MP4 transform requests must be sequential.'));
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      this.#outputs = [];
      try {
        this.#transmuxer.push(chunk);
        this.#transmuxer.flush();
      } catch (cause) {
        this.#pending = undefined;
        this.#outputs = [];
        this.#transmuxer.reset();
        reject(cause);
      }
    });
  }

  terminate(reason = new Error('The MP4 transform was cancelled.')): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending?.reject(reason);
    this.#pending = undefined;
    this.#outputs = [];
    this.#transmuxer.off('data');
    this.#transmuxer.off('done');
    this.#transmuxer.reset();
  }
}

export const nodeTransforms: TransformBackend = {
  createHlsWriter(destination, plan) {
    if (plan.separateAudio) {
      return plan.fragmentedMp4
        ? new SeparateTrackFmp4Writer(destination, plan.videoSegmentCount, plan.audioSegmentCount)
        : new SeparateTrackTsToMp4Writer(destination, plan.videoSegmentCount, plan.audioSegmentCount,
          (separate) => new NodeTransmuxSession(separate));
    }
    return plan.remuxTs
      ? new TsToMp4Writer(destination, (separate) => new NodeTransmuxSession(separate))
      : destination;
  },
  createDashWriter(destination, videoSegmentCount, audioSegmentCount) {
    return new SeparateTrackFmp4Writer(destination, videoSegmentCount, audioSegmentCount);
  },
};
