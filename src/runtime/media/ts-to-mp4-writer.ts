import type { BinaryWriter, RandomAccessBinaryWriter } from '../../core/hls/download-hls';
import { FlatMp4Muxer } from '../../core/mp4/flat-mp4-muxer';

export interface TransmuxOutput {
  mediaType: 'combined' | 'audio' | 'video';
  initializationSegment?: ArrayBuffer;
  data: ArrayBuffer;
}

export interface TransmuxSession {
  transmux(chunk: Uint8Array): Promise<TransmuxOutput[]>;
  terminate(reason?: Error): void;
}

export type TransmuxSessionFactory = (separateTimeline: boolean) => TransmuxSession;

export class TsToMp4Writer implements BinaryWriter {
  readonly #destination: RandomAccessBinaryWriter;
  readonly #muxer: FlatMp4Muxer;
  readonly #worker: TransmuxSession;
  #closed = false;

  constructor(destination: RandomAccessBinaryWriter, createSession: TransmuxSessionFactory) {
    this.#worker = createSession(false);
    this.#destination = destination;
    this.#muxer = new FlatMp4Muxer(destination);
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error('The MP4 output is already closed.');
    const outputs = await this.#worker.transmux(chunk);
    if (outputs.length === 0) {
      throw new Error('No H.264/AAC media was found in this MPEG-TS segment. Try the original format instead.');
    }
    for (const output of outputs) {
      if (output.initializationSegment) {
        await this.#muxer.initialize(new Uint8Array(output.initializationSegment));
      }
      await this.#muxer.appendFragment(new Uint8Array(output.data));
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#muxer.finalize();
      this.#worker.terminate();
      await this.#destination.close();
      this.#closed = true;
    } catch (error) {
      await this.abort(error);
      throw error;
    }
  }

  async abort(reason?: unknown): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
    await this.#destination.abort(reason);
  }
}

export class SeparateTrackTsToMp4Writer implements BinaryWriter {
  readonly #destination: RandomAccessBinaryWriter;
  readonly #muxer: FlatMp4Muxer;
  readonly #videoWorker: TransmuxSession;
  readonly #audioWorker: TransmuxSession;
  readonly #videoSegmentCount: number;
  readonly #totalSegmentCount: number;
  readonly #initializedSources = new Set<'video' | 'audio'>();
  #writtenSegments = 0;
  #closed = false;

  constructor(
    destination: RandomAccessBinaryWriter,
    videoSegmentCount: number,
    audioSegmentCount: number,
    createSession: TransmuxSessionFactory,
  ) {
    this.#videoWorker = createSession(true);
    this.#audioWorker = createSession(true);
    if (!Number.isInteger(videoSegmentCount) || videoSegmentCount <= 0) {
      throw new Error('The separate video playlist has no segments.');
    }
    if (!Number.isInteger(audioSegmentCount) || audioSegmentCount <= 0) {
      throw new Error('The separate audio playlist has no segments.');
    }
    this.#destination = destination;
    this.#muxer = new FlatMp4Muxer(destination);
    this.#videoSegmentCount = videoSegmentCount;
    this.#totalSegmentCount = videoSegmentCount + audioSegmentCount;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error('The MP4 output is already closed.');
    if (this.#writtenSegments >= this.#totalSegmentCount) {
      throw new Error('The separate-track MP4 writer received too many segments.');
    }
    const source = this.#writtenSegments < this.#videoSegmentCount ? 'video' : 'audio';
    const worker = source === 'video' ? this.#videoWorker : this.#audioWorker;
    const outputs = (await worker.transmux(chunk)).filter(({ mediaType }) => mediaType === source);
    if (outputs.length === 0) {
      throw new Error(`No ${source} media was found in the separate ${source} segment.`);
    }
    for (const output of outputs) {
      if (output.initializationSegment) {
        await this.#muxer.addSource(
          source,
          new Uint8Array(output.initializationSegment),
          source === 'video' ? 'vide' : 'soun',
        );
        this.#initializedSources.add(source);
      }
      if (!this.#initializedSources.has(source)) {
        throw new Error(`The separate ${source} stream did not provide MP4 initialization metadata.`);
      }
      await this.#muxer.appendFragment(new Uint8Array(output.data), source);
    }
    this.#writtenSegments += 1;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      if (this.#writtenSegments !== this.#totalSegmentCount) {
        throw new Error(
          `The separate-track MP4 writer received ${this.#writtenSegments} of ${this.#totalSegmentCount} segments.`,
        );
      }
      await this.#muxer.finalize();
      this.#videoWorker.terminate();
      this.#audioWorker.terminate();
      await this.#destination.close();
      this.#closed = true;
    } catch (cause) {
      await this.abort(cause);
      throw cause;
    }
  }

  async abort(reason?: unknown): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#videoWorker.terminate();
    this.#audioWorker.terminate();
    await this.#destination.abort(reason);
  }
}
