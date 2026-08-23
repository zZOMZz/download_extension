import type { RandomAccessBinaryWriter } from '~/src/core/hls/download-hls';
import {
  createRandomAccessFileWriter,
  type PositionalWritableFileStream,
} from './random-access-file-writer';

export interface WritableDirectoryHandle {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WritableFileHandle>;
  removeEntry(name: string): Promise<void>;
}

export interface WritableFileHandle {
  createWritable(options?: { keepExistingData?: boolean }): Promise<PositionalWritableFileStream>;
  getFile(): Promise<File>;
}

export async function openDirectoryOutputWriter(
  directory: WritableDirectoryHandle,
  filename: string,
): Promise<RandomAccessBinaryWriter> {
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  return createRandomAccessFileWriter(writable);
}

export async function openResumableDirectoryOutputWriter(
  directory: WritableDirectoryHandle,
  filename: string,
  committedBytes: number,
): Promise<RandomAccessBinaryWriter> {
  const file = await directory.getFileHandle(filename, { create: true });
  const existing = await file.getFile();
  if (existing.size < committedBytes) {
    throw new Error(`The partial file is shorter than its saved checkpoint (${existing.size} < ${committedBytes}).`);
  }
  const writable = await file.createWritable({ keepExistingData: true });
  try {
    await writable.write({ type: 'truncate', size: committedBytes });
  } catch (cause) {
    await writable.abort(cause);
    throw cause;
  }
  return createRandomAccessFileWriter(writable, {
    initialPosition: committedBytes,
    preserveOnAbort: true,
  });
}

export async function readDirectoryFile(
  directory: WritableDirectoryHandle,
  filename: string,
): Promise<File | null> {
  try {
    return await (await directory.getFileHandle(filename)).getFile();
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return null;
    throw cause;
  }
}

export async function removeDirectoryFile(
  directory: WritableDirectoryHandle,
  filename: string,
): Promise<void> {
  try {
    await directory.removeEntry(filename);
  } catch (cause) {
    if (!(cause instanceof DOMException && cause.name === 'NotFoundError')) throw cause;
  }
}
