import { describe, expect, it } from 'vitest';
import {
  openResumableDirectoryOutputWriter,
  type WritableDirectoryHandle,
  type WritableFileHandle,
} from '../src/browser/directory-output-writer';
import type { PositionalWritableFileStream } from '../src/browser/random-access-file-writer';

class TransactionalFileHandle implements WritableFileHandle {
  committed = Uint8Array.of(1, 2, 3, 4, 5, 6, 90, 91);

  async getFile(): Promise<File> {
    return new File([this.committed], 'video.part.ts');
  }

  async createWritable(options?: { keepExistingData?: boolean }): Promise<PositionalWritableFileStream> {
    let staged = options?.keepExistingData ? this.committed.slice() : new Uint8Array();
    return {
      write: async (command) => {
        if (command.type === 'truncate') {
          staged = staged.slice(0, command.size);
          return;
        }
        const requiredLength = command.position + command.data.byteLength;
        if (requiredLength > staged.byteLength) {
          const expanded = new Uint8Array(requiredLength);
          expanded.set(staged);
          staged = expanded;
        }
        staged.set(command.data, command.position);
      },
      close: async () => { this.committed = staged; },
      abort: async () => {},
    };
  }
}

describe('resumable directory output', () => {
  it('truncates to the checkpoint, appends, and commits partial data after a failure', async () => {
    const handle = new TransactionalFileHandle();
    const directory: WritableDirectoryHandle = {
      name: 'Downloads',
      getFileHandle: async () => handle,
      removeEntry: async () => {},
    };

    const writer = await openResumableDirectoryOutputWriter(directory, 'video.part.ts', 6);
    await writer.write(Uint8Array.of(7, 8));
    await writer.abort(new Error('server unavailable'));

    expect([...handle.committed]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
