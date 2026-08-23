import type { BinaryWriter, RandomAccessBinaryWriter } from '~/src/core/hls/download-hls';
import { FlatMp4Muxer } from '../core/mp4/flat-mp4-muxer';

interface WorkerResult {
  type: 'result';
  id: number;
  initializationSegment?: ArrayBuffer;
  chunks: ArrayBuffer[];
}

interface WorkerFailure {
  type: 'error';
  id: number;
  message: string;
}

type WorkerResponse = WorkerResult | WorkerFailure;

interface PendingRequest {
  resolve: (response: WorkerResult) => void;
  reject: (error: Error) => void;
}

export class TsToMp4Writer implements BinaryWriter {
  readonly #destination: RandomAccessBinaryWriter;
  readonly #muxer: FlatMp4Muxer;
  readonly #worker: Worker;
  readonly #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #closed = false;

  constructor(destination: RandomAccessBinaryWriter) {
    this.#destination = destination;
    this.#muxer = new FlatMp4Muxer(destination);
    this.#worker = new Worker(new URL('../workers/transmux.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.#worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      if (event.data.type === 'error') pending.reject(new Error(event.data.message));
      else pending.resolve(event.data);
    });
    this.#worker.addEventListener('error', () => {
      this.#rejectAll(new Error('The MP4 remuxing worker stopped unexpectedly.'));
    });
    this.#worker.addEventListener('messageerror', () => {
      this.#rejectAll(new Error('The MP4 remuxing worker returned invalid data.'));
    });
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error('The MP4 output is already closed.');
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const data = chunk.slice().buffer as ArrayBuffer;
    const response = await new Promise<WorkerResult>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ type: 'transmux', id, data }, [data]);
    });
    if (response.initializationSegment) {
      await this.#muxer.initialize(new Uint8Array(response.initializationSegment));
    }
    if (response.chunks.length === 0) {
      throw new Error('No H.264/AAC media was found in this MPEG-TS segment. Try the original format instead.');
    }
    for (const output of response.chunks) await this.#muxer.appendFragment(new Uint8Array(output));
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
    this.#rejectAll(new Error('The MP4 output was cancelled.'));
    await this.#destination.abort(reason);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
