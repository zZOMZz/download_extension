import { browser } from 'wxt/browser';
import type { RandomAccessBinaryWriter } from '~/src/core/hls/download-hls';
import {
  createRandomAccessFileWriter,
  type PositionalWritableFileStream,
} from './random-access-file-writer';

interface MinimalFileHandle {
  createWritable(options?: { keepExistingData?: boolean }): Promise<PositionalWritableFileStream>;
}

interface SavePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<MinimalFileHandle>;
}

class MemoryWriter implements RandomAccessBinaryWriter {
  readonly #chunks: ArrayBuffer[] = [];
  readonly #filename: string;
  readonly #mimeType: string;
  #aborted = false;

  constructor(filename: string, mimeType: string) {
    this.#filename = filename;
    this.#mimeType = mimeType;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#aborted) throw new Error('The output was cancelled.');
    this.#chunks.push(chunk.slice().buffer as ArrayBuffer);
  }

  async writeAt(position: number, data: Uint8Array): Promise<void> {
    if (this.#aborted) throw new Error('The output was cancelled.');
    if (!Number.isInteger(position) || position < 0) throw new Error('Invalid output patch position.');
    let chunkStart = 0;
    let sourceOffset = 0;
    for (const buffer of this.#chunks) {
      const chunk = new Uint8Array(buffer);
      const chunkEnd = chunkStart + chunk.byteLength;
      if (position < chunkEnd && sourceOffset < data.byteLength) {
        const destinationOffset = Math.max(0, position - chunkStart);
        const length = Math.min(chunk.byteLength - destinationOffset, data.byteLength - sourceOffset);
        chunk.set(data.subarray(sourceOffset, sourceOffset + length), destinationOffset);
        sourceOffset += length;
        position += length;
      }
      chunkStart = chunkEnd;
    }
    if (sourceOffset !== data.byteLength) throw new Error('The output patch exceeds the written data.');
  }

  async close(): Promise<void> {
    if (this.#aborted) return;
    const url = URL.createObjectURL(new Blob(this.#chunks, { type: this.#mimeType }));
    try {
      await browser.downloads.download({ url, filename: this.#filename, saveAs: true });
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  async abort(): Promise<void> {
    this.#aborted = true;
    this.#chunks.length = 0;
  }
}

export async function openOutputWriter(
  filename: string,
  mimeType: string,
  extension: string,
): Promise<RandomAccessBinaryWriter> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (!picker) return new MemoryWriter(filename, mimeType);

  const handle = await picker({
    suggestedName: filename,
    types: [
      {
        description: 'Video file',
        accept: { [mimeType]: [`.${extension}`] },
      },
    ],
  });
  const writable = await handle.createWritable();
  return createRandomAccessFileWriter(writable);
}
