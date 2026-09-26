import { browser } from 'wxt/browser';
import type { RandomAccessBinaryWriter } from '../core/hls/download-hls';
import { blobMediaReader } from '../core/media/output-validator';
import type { DirectOutputTarget } from '../runtime/direct-download';
import {
  createRandomAccessFileWriter,
  type PositionalWritableFileStream,
} from './random-access-file-writer';

interface MinimalFileHandle {
  createWritable(options?: { keepExistingData?: boolean }): Promise<PositionalWritableFileStream>;
  getFile(): Promise<File>;
}

interface SavePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<MinimalFileHandle>;
}

class MemoryWriter implements RandomAccessBinaryWriter {
  readonly #chunks: ArrayBuffer[] = [];
  #aborted = false;
  #closed = false;

  #checkWritable() {
    if (this.#aborted) throw new Error('The output was cancelled.');
    if (this.#closed) throw new Error('The output file is already closed.');
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.#checkWritable();
    this.#chunks.push(chunk.slice().buffer as ArrayBuffer);
  }

  async writeAt(position: number, data: Uint8Array): Promise<void> {
    this.#checkWritable();
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
    if (this.#aborted) throw new Error('The output was cancelled.');
    this.#closed = true;
  }

  blob(mimeType: string): Blob {
    if (!this.#closed || this.#aborted) throw new Error('The output is not ready for validation.');
    return new Blob(this.#chunks, { type: mimeType });
  }

  async abort(): Promise<void> {
    this.#aborted = true;
    this.#chunks.length = 0;
  }
}

type DownloadChange = { id: number; state?: { current?: string | undefined } | undefined; error?: { current?: string | undefined } | undefined };

/** Returning a download ID only acknowledges scheduling; completion requires terminal host state. */
async function publishBlob(blob: Blob, filename: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  return new Promise<void>((resolve, reject) => {
    let id: number | undefined;
    let settled = false;
    const cleanup = () => {
      browser.downloads.onChanged.removeListener(onChanged);
      browser.downloads.onErased.removeListener(onErased);
      signal.removeEventListener('abort', onAbort);
      URL.revokeObjectURL(url);
    };
    const finish = (cause?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cause === undefined) resolve();
      else reject(cause);
    };
    const onAbort = () => {
      if (id !== undefined) void browser.downloads.cancel(id).catch(() => {});
      finish(signal.reason ?? new DOMException('The download was cancelled.', 'AbortError'));
    };
    const terminalState = (state?: string, error?: string) => {
      if (state === 'complete') finish();
      else if (state === 'interrupted' || error) finish(new Error(`The browser download was interrupted${error ? `: ${error}` : '.'}`));
    };
    const onChanged = (change: DownloadChange) => {
      if (change.id === id) terminalState(change.state?.current, change.error?.current);
    };
    const onErased = (erasedId: number) => {
      if (erasedId === id) finish(new Error('The browser download was removed before completion.'));
    };
    browser.downloads.onChanged.addListener(onChanged);
    browser.downloads.onErased.addListener(onErased);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    void browser.downloads.download({ url, filename, saveAs: true }).then(async (downloadId) => {
      id = downloadId;
      if (settled) {
        if (signal.aborted) await browser.downloads.cancel(downloadId).catch(() => {});
        return;
      }
      // Completion can arrive before download() returns the ID. Query after listener registration.
      const [item] = await browser.downloads.search({ id: downloadId });
      if (settled) return;
      if (!item) throw new Error('The browser download disappeared before completion.');
      terminalState(item.state, item.error);
    }).catch(finish);
  });
}

function memoryTarget(filename: string, mimeType: string): DirectOutputTarget {
  const writer = new MemoryWriter();
  const controller = new AbortController();
  let finishPromise: Promise<void> | undefined;
  return {
    resumable: false,
    writer,
    read: async () => blobMediaReader(writer.blob(mimeType)),
    finish(signal) {
      if (finishPromise) return finishPromise;
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      finishPromise = publishBlob(writer.blob(mimeType), filename, controller.signal)
        .finally(() => signal?.removeEventListener('abort', onAbort));
      return finishPromise;
    },
    async abort(reason) {
      controller.abort(reason);
      await writer.abort();
      await finishPromise?.catch(() => {});
    },
  };
}

/** Invoke this before any await in the host's user-action handler. */
export async function openOutputTarget(
  filename: string,
  mimeType: string,
  extension: string,
  options: { allowMemoryFallback?: boolean } = {},
): Promise<DirectOutputTarget> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (!picker) {
    if (options.allowMemoryFallback === false) {
      throw new Error('This download requires a browser with streaming file save support.');
    }
    return memoryTarget(filename, mimeType);
  }
  const handle = await picker({
    suggestedName: filename,
    types: [{ description: 'Video file', accept: { [mimeType]: [`.${extension}`] } }],
  });
  const writer = createRandomAccessFileWriter(await handle.createWritable());
  return {
    resumable: false,
    writer,
    read: async () => blobMediaReader(await handle.getFile()),
    finish: async (signal) => { signal?.throwIfAborted(); },
    abort: (reason) => writer.abort(reason),
  };
}

/** @deprecated New runtime callers use openOutputTarget for validation before publication. */
export async function openOutputWriter(
  filename: string,
  mimeType: string,
  extension: string,
  options: { allowMemoryFallback?: boolean } = {},
): Promise<RandomAccessBinaryWriter> {
  const target = await openOutputTarget(filename, mimeType, extension, options);
  return {
    write: (chunk) => target.writer.write(chunk),
    writeAt: (position, chunk) => target.writer.writeAt(position, chunk),
    close: async () => { await target.writer.close(); await target.finish(); },
    abort: (reason) => target.abort(reason),
  };
}
