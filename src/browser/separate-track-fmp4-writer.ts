import type { BinaryWriter, RandomAccessBinaryWriter } from '../core/hls/download-hls';
import { FlatMp4Muxer } from '../core/mp4/flat-mp4-muxer';

function boxType(bytes: Uint8Array): string {
  if (bytes.byteLength < 8) throw new Error('The fragmented MP4 chunk is too short.');
  return String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
}

export class SeparateTrackFmp4Writer implements BinaryWriter {
  readonly #destination: RandomAccessBinaryWriter;
  readonly #muxer: FlatMp4Muxer;
  readonly #videoSegmentCount: number;
  readonly #totalSegmentCount: number;
  readonly #initializedSources = new Set<'video' | 'audio'>();
  #writtenSegments = 0;
  #closed = false;

  constructor(
    destination: RandomAccessBinaryWriter,
    videoSegmentCount: number,
    audioSegmentCount: number,
  ) {
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
    const source = this.#writtenSegments < this.#videoSegmentCount ? 'video' : 'audio';
    const type = boxType(chunk);
    if (type === 'ftyp') {
      if (this.#initializedSources.has(source)) {
        throw new Error(`The separate ${source} stream changed its MP4 initialization segment.`);
      }
      await this.#muxer.addSource(source, chunk, source === 'video' ? 'vide' : 'soun');
      this.#initializedSources.add(source);
      return;
    }
    if (!this.#initializedSources.has(source)) {
      throw new Error(`The separate ${source} stream is missing its MP4 initialization segment.`);
    }
    if (this.#writtenSegments >= this.#totalSegmentCount) {
      throw new Error('The separate-track MP4 writer received too many segments.');
    }
    await this.#muxer.appendFragment(chunk, source);
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
    await this.#destination.abort(reason);
  }
}
