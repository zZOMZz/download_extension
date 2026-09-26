import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArtifactStore } from '../../runtime/artifact-store';
import type { RandomAccessBinaryWriter } from '../../core/hls/download-hls';

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function validateRange(offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new Error('Artifact reads require nonnegative safe integer ranges.');
  }
}

/** A local output namespace. Paths and browser directory handles never enter the runtime. */
export class NodeArtifactStore implements ArtifactStore {
  readonly id: string;
  readonly name: string;

  private constructor(readonly root: string) {
    this.id = `node-directory:${root}`;
    this.name = basename(root);
  }

  static async create(directory: string): Promise<NodeArtifactStore> {
    await mkdir(directory, { recursive: true });
    return new NodeArtifactStore(await realpath(directory));
  }

  #path(filename: string): string {
    if (!filename || filename === '.' || filename === '..' || /[/\\\0]/.test(filename)) {
      throw new Error('Artifacts must use a single filename inside the output directory.');
    }
    return join(this.root, filename);
  }

  async stat(filename: string): Promise<{ size: number } | null> {
    try {
      const stat = await lstat(this.#path(filename));
      if (!stat.isFile()) throw new Error('The output artifact is not a regular file.');
      return { size: stat.size };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async read(filename: string, offset: number, length: number): Promise<Uint8Array> {
    validateRange(offset, length);
    const handle = await open(this.#path(filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const result = new Uint8Array(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        const read = await handle.read(result, bytesRead, length - bytesRead, offset + bytesRead);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      return result.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async open(filename: string, options: { resumeFrom?: number } = {}): Promise<RandomAccessBinaryWriter> {
    const destination = this.#path(filename);
    const resume = options.resumeFrom !== undefined;
    const initialPosition = options.resumeFrom ?? 0;
    validateRange(initialPosition, 0);
    // Fresh writes are staged, so a cancelled replacement preserves the old final output.
    const writablePath = resume ? destination : this.#path(`.${filename}.${randomUUID()}.pending`);
    const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW |
      (resume ? 0 : constants.O_EXCL);
    const handle = await open(writablePath, flags, 0o600);
    try {
      if (resume) {
        const existing = await handle.stat();
        if (existing.size < initialPosition) {
          throw new Error(`The partial file is shorter than its saved checkpoint (${existing.size} < ${initialPosition}).`);
        }
        await handle.truncate(initialPosition);
      }
    } catch (error) {
      await handle.close();
      if (!resume) await unlink(writablePath).catch(() => {});
      throw error;
    }
    let position = initialPosition;
    let closed = false;
    const writeAt = async (offset: number, data: Uint8Array): Promise<void> => {
      if (closed) throw new Error('The output file is already closed.');
      validateRange(offset, data.byteLength);
      let written = 0;
      while (written < data.byteLength) {
        const result = await handle.write(data, written, data.byteLength - written, offset + written);
        if (result.bytesWritten === 0) throw new Error('The output file stopped accepting bytes.');
        written += result.bytesWritten;
      }
    };
    const finish = async (commit: boolean): Promise<void> => {
      if (closed) return;
      closed = true;
      let failure: { cause: unknown } | undefined;
      try {
        if (commit || resume) await handle.sync();
      } catch (cause) { failure = { cause }; }
      try { await handle.close(); }
      catch (cause) { failure ??= { cause }; }
      if (failure) {
        // Fresh staging data has no recovery owner. Preserve the original failure and old output.
        // Resumable writes belong to the checkpoint and must remain available after any failure.
        if (!resume) await unlink(writablePath).catch(() => {});
        throw failure.cause;
      }
      if (resume) return;
      try {
        if (commit) await rename(writablePath, destination);
        else await unlink(writablePath);
      } catch (cause) {
        await unlink(writablePath).catch(() => {});
        throw cause;
      }
    };
    return {
      write: async (chunk) => {
        await writeAt(position, chunk);
        position += chunk.byteLength;
      },
      writeAt,
      close: () => finish(true),
      abort: () => finish(false),
    };
  }

  async remove(filename: string): Promise<void> {
    try {
      await unlink(this.#path(filename));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}
