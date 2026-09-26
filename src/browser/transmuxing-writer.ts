import type { RandomAccessBinaryWriter } from '../core/hls/download-hls';
import {
  TsToMp4Writer as RuntimeTsToMp4Writer,
  SeparateTrackTsToMp4Writer as RuntimeSeparateTrackTsToMp4Writer,
} from '../runtime/media/ts-to-mp4-writer';

interface WorkerOutput {
  mediaType: 'combined' | 'audio' | 'video';
  initializationSegment?: ArrayBuffer;
  data: ArrayBuffer;
}

interface WorkerResult {
  type: 'result';
  id: number;
  outputs: WorkerOutput[];
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

class TransmuxWorkerClient {
  readonly #worker: Worker;
  readonly #separateTimeline: boolean;
  readonly #pending = new Map<number, PendingRequest>();
  #nextRequestId = 1;
  #terminated = false;

  constructor(separateTimeline = false) {
    this.#separateTimeline = separateTimeline;
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

  async transmux(chunk: Uint8Array): Promise<WorkerOutput[]> {
    if (this.#terminated) throw new Error('The MP4 remuxing worker is already closed.');
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const data = chunk.slice().buffer as ArrayBuffer;
    const response = await new Promise<WorkerResult>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({
        type: 'transmux',
        id,
        data,
        separateTimeline: this.#separateTimeline,
      }, [data]);
    });
    return response.outputs;
  }

  terminate(reason = new Error('The MP4 output was cancelled.')): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#worker.terminate();
    this.#rejectAll(reason);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export class TsToMp4Writer extends RuntimeTsToMp4Writer {
  constructor(destination: RandomAccessBinaryWriter) {
    super(destination, (separateTimeline) => new TransmuxWorkerClient(separateTimeline));
  }
}

export class SeparateTrackTsToMp4Writer extends RuntimeSeparateTrackTsToMp4Writer {
  constructor(destination: RandomAccessBinaryWriter, videoSegmentCount: number, audioSegmentCount: number) {
    super(destination, videoSegmentCount, audioSegmentCount,
      (separateTimeline) => new TransmuxWorkerClient(separateTimeline));
  }
}
