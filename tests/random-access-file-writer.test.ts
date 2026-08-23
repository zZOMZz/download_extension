import { describe, expect, it } from 'vitest';
import {
  createRandomAccessFileWriter,
  type PositionalWritableFileStream,
} from '../src/browser/random-access-file-writer';

class CursorMovingFileStream implements PositionalWritableFileStream {
  readonly commands: Array<{ position: number; data: number[] }> = [];
  bytes = new Uint8Array();
  cursor = 0;
  closed = false;
  aborted = false;

  async write(command:
    | { type: 'write'; position: number; data: Uint8Array }
    | { type: 'truncate'; size: number }
  ): Promise<void> {
    if (command.type === 'truncate') {
      this.bytes = this.bytes.slice(0, command.size);
      this.cursor = Math.min(this.cursor, command.size);
      return;
    }
    this.cursor = command.position;
    const requiredLength = command.position + command.data.byteLength;
    if (requiredLength > this.bytes.byteLength) {
      const expanded = new Uint8Array(requiredLength);
      expanded.set(this.bytes);
      this.bytes = expanded;
    }
    this.bytes.set(command.data, command.position);
    this.cursor += command.data.byteLength;
    this.commands.push({ position: command.position, data: [...command.data] });
  }

  async close(): Promise<void> { this.closed = true; }
  async abort(): Promise<void> { this.aborted = true; }
}

describe('random-access file writer', () => {
  it('continues appending at the logical end after an earlier position is patched', async () => {
    const stream = new CursorMovingFileStream();
    const writer = createRandomAccessFileWriter(stream);

    await writer.write(Uint8Array.of(1, 2, 3, 4));
    await writer.write(Uint8Array.of(5, 6));
    await writer.writeAt(0, Uint8Array.of(9, 9));
    expect(stream.cursor).toBe(2);
    await writer.write(Uint8Array.of(7, 8));

    expect(stream.commands.map(({ position }) => position)).toEqual([0, 4, 0, 6]);
    expect([...stream.bytes]).toEqual([9, 9, 3, 4, 5, 6, 7, 8]);
  });

  it('starts at a resumed position and commits partial output on abort', async () => {
    const stream = new CursorMovingFileStream();
    const writer = createRandomAccessFileWriter(stream, { initialPosition: 6, preserveOnAbort: true });

    await writer.write(Uint8Array.of(7, 8));
    await writer.abort(new Error('network failure'));

    expect(stream.commands[0]?.position).toBe(6);
    expect(stream.closed).toBe(true);
    expect(stream.aborted).toBe(false);
  });
});
