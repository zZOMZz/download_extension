import type { RandomAccessBinaryWriter } from '../core/hls/download-hls';

export interface PositionalWritableFileStream {
  write(command:
    | { type: 'write'; position: number; data: Uint8Array }
    | { type: 'truncate'; size: number }
  ): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface RandomAccessFileWriterOptions {
  initialPosition?: number;
  preserveOnAbort?: boolean;
}

export function createRandomAccessFileWriter(
  writable: PositionalWritableFileStream,
  options: RandomAccessFileWriterOptions = {},
): RandomAccessBinaryWriter {
  let appendPosition = options.initialPosition ?? 0;
  let finished = false;

  return {
    async write(chunk): Promise<void> {
      if (finished) throw new Error('The output file is already closed.');
      const position = appendPosition;
      await writable.write({ type: 'write', position, data: chunk });
      appendPosition += chunk.byteLength;
    },
    async writeAt(position, chunk): Promise<void> {
      if (finished) throw new Error('The output file is already closed.');
      await writable.write({ type: 'write', position, data: chunk });
    },
    async close(): Promise<void> {
      if (finished) return;
      finished = true;
      await writable.close();
    },
    async abort(reason): Promise<void> {
      if (finished) return;
      finished = true;
      if (options.preserveOnAbort) await writable.close();
      else await writable.abort(reason);
    },
  };
}
