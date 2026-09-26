import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import muxjs from 'mux.js';
import { validateDirectoryOutput } from '../src/browser/validated-output';
import type {
  WritableDirectoryHandle,
  WritableFileHandle,
} from '../src/browser/directory-output-writer';
import type { RandomAccessBinaryWriter } from '../src/core/hls/download-hls';
import {
  OutputValidationError,
  validateMediaOutput,
} from '../src/core/media/output-validator';
import { FlatMp4Muxer } from '../src/core/mp4/flat-mp4-muxer';

class MemoryDestination implements RandomAccessBinaryWriter {
  readonly chunks: Uint8Array[] = [];

  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk.slice());
  }

  async writeAt(position: number, data: Uint8Array): Promise<void> {
    let chunkStart = 0;
    let sourceOffset = 0;
    for (const chunk of this.chunks) {
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
    if (sourceOffset !== data.byteLength) throw new Error('The test patch exceeds its output.');
  }

  async close(): Promise<void> {}
  async abort(): Promise<void> {}

  result(): Uint8Array {
    const bytes = new Uint8Array(this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}

function asBlob(bytes: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type });
}

async function transmuxFixture(): Promise<{ initialization: Uint8Array; media: Uint8Array }> {
  const transmuxer = new muxjs.mp4.Transmuxer();
  let initialization: Uint8Array | undefined;
  let media: Uint8Array | undefined;
  transmuxer.on('data', (segment) => {
    initialization = segment.initSegment;
    media = segment.data;
  });
  const done = new Promise<void>((resolve) => transmuxer.on('done', resolve));
  transmuxer.push(new Uint8Array(readFileSync('node_modules/mux.js/test/segments/test-segment.ts')));
  transmuxer.flush();
  await done;

  return { initialization: initialization!, media: media! };
}

async function createMp4Fixtures(): Promise<{ flat: Blob; fragmented: Blob }> {
  const { initialization, media } = await transmuxFixture();

  const destination = new MemoryDestination();
  const muxer = new FlatMp4Muxer(destination);
  await muxer.initialize(initialization);
  await muxer.appendFragment(media);
  await muxer.finalize();
  const fragmented = new Uint8Array(initialization.byteLength + media.byteLength);
  fragmented.set(initialization);
  fragmented.set(media, initialization.byteLength);
  return {
    flat: asBlob(destination.result(), 'video/mp4'),
    fragmented: asBlob(fragmented, 'video/mp4'),
  };
}

function fakeDirectory(initialFiles: Record<string, Blob>): {
  directory: WritableDirectoryHandle;
  files: Map<string, Blob>;
  removed: string[];
} {
  const files = new Map(Object.entries(initialFiles));
  const removed: string[] = [];
  const directory: WritableDirectoryHandle = {
    name: 'Downloads',
    async getFileHandle(name: string): Promise<WritableFileHandle> {
      const blob = files.get(name);
      if (!blob) throw new DOMException('Not found', 'NotFoundError');
      return {
        async getFile() {
          return blob as File;
        },
        async createWritable() {
          throw new Error('Writing is not used by this test.');
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw new DOMException('Not found', 'NotFoundError');
      removed.push(name);
    },
  };
  return { directory, files, removed };
}

describe('media output validation', () => {
  let validMp4: Blob;
  let fragmentedMp4: Blob;

  beforeAll(async () => {
    const fixtures = await createMp4Fixtures();
    validMp4 = fixtures.flat;
    fragmentedMp4 = fixtures.fragmented;
  });

  it('accepts an indexed MP4 with playable video and audio tracks', async () => {
    const result = await validateMediaOutput(validMp4, { format: 'mp4' });

    expect(result).toMatchObject({
      format: 'mp4',
      size: validMp4.size,
      videoTracks: 1,
      audioTracks: 1,
      fragmented: false,
    });
    expect(result.durationSeconds).toBeGreaterThan(0);
  });

  it('accepts a fragmented MP4 produced by an HLS initialization map', async () => {
    await expect(validateMediaOutput(fragmentedMp4, { format: 'mp4' })).resolves.toMatchObject({
      format: 'mp4',
      videoTracks: 1,
      audioTracks: 1,
      fragmented: true,
    });
  });

  it('rejects a truncated MP4 instead of treating the write as completed', async () => {
    const truncated = validMp4.slice(0, validMp4.size - 20);

    await expect(validateMediaOutput(truncated, { format: 'mp4' })).rejects.toBeInstanceOf(
      OutputValidationError,
    );
  });

  it('recognizes MPEG-TS packet sync and rejects unrelated bytes', async () => {
    const transportStream = asBlob(
      new Uint8Array(readFileSync('node_modules/mux.js/test/segments/test-segment.ts')),
      'video/mp2t',
    );

    await expect(validateMediaOutput(transportStream, {
      format: 'ts',
      expectedBytes: transportStream.size,
    })).resolves.toMatchObject({ format: 'ts', size: transportStream.size });
    await expect(validateMediaOutput(new Blob([new Uint8Array(2_000)]), {
      format: 'ts',
    })).rejects.toMatchObject({ code: 'invalid-transport-stream' });
  });

  it('rejects an output whose committed byte count does not match', async () => {
    await expect(validateMediaOutput(new Blob([new Uint8Array(1_000)]), {
      format: 'ts',
      expectedBytes: 999,
    })).rejects.toMatchObject({ code: 'size-mismatch' });
  });

  it('validates through bounded reads without loading the complete media output', async () => {
    const reads: Array<{ offset: number; length: number }> = [];
    const result = await validateMediaOutput({
      size: validMp4.size,
      read: async (offset, length) => {
        reads.push({ offset, length });
        return new Uint8Array(await validMp4.slice(offset, offset + length).arrayBuffer());
      },
    }, { format: 'mp4' });
    expect(result.videoTracks).toBe(1);
    expect(reads.length).toBeGreaterThan(1);
    expect(Math.max(...reads.map(({ length }) => length))).toBeLessThan(validMp4.size);
    expect(reads.every(({ offset, length }) => offset >= 0 && offset + length <= validMp4.size)).toBe(true);
  });

  it('rejects a short host read even when reported size is valid', async () => {
    await expect(validateMediaOutput({
      size: validMp4.size,
      read: async () => new Uint8Array(1),
    }, { format: 'mp4' })).rejects.toMatchObject({ code: 'size-mismatch' });
  });

  it('leaves recovery artifacts intact regardless of the validation result', async () => {
    const invalid = fakeDirectory({
      'episode.mp4': new Blob([new Uint8Array(2_000)]),
      'episode.part.ts': new Blob([new Uint8Array(2_000)]),
    });
    await expect(validateDirectoryOutput(
      invalid.directory,
      'episode.mp4',
      { format: 'mp4' },
    )).rejects.toBeInstanceOf(OutputValidationError);
    expect(invalid.files.has('episode.part.ts')).toBe(true);
    expect(invalid.removed).toEqual([]);

    const valid = fakeDirectory({
      'episode.mp4': validMp4,
      'episode.part.ts': new Blob([new Uint8Array(2_000)]),
      'episode.audio.part.m4s': new Blob([new Uint8Array(1_000)]),
    });
    await validateDirectoryOutput(
      valid.directory,
      'episode.mp4',
      { format: 'mp4' },
    );
    expect(valid.files.has('episode.part.ts')).toBe(true);
    expect(valid.files.has('episode.audio.part.m4s')).toBe(true);
    expect(valid.removed).toEqual([]);
  });
});
