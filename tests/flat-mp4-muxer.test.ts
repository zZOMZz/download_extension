// @ts-expect-error Vitest runs in Node; the browser extension intentionally does not include Node typings.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import muxjs from 'mux.js';
import { FlatMp4Muxer } from '../src/core/mp4/flat-mp4-muxer';
import type { RandomAccessBinaryWriter } from '../src/core/hls/download-hls';

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

interface TestBox {
  type: string;
  start: number;
  contentStart: number;
  end: number;
}

function boxes(bytes: Uint8Array, start = 0, end = bytes.byteLength): TestBox[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: TestBox[] = [];
  let offset = start;
  while (offset < end) {
    const compactSize = view.getUint32(offset);
    const headerSize = compactSize === 1 ? 16 : 8;
    const size = compactSize === 1 ? Number(view.getBigUint64(offset + 8)) : compactSize;
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    result.push({ type, start: offset, contentStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return result;
}

describe('flat MP4 muxer', () => {
  it('turns real mux.js fragments into an indexed, non-fragmented MP4', async () => {
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

    const destination = new MemoryDestination();
    const muxer = new FlatMp4Muxer(destination);
    await muxer.initialize(initialization!);
    await muxer.appendFragment(media!);
    await muxer.finalize();
    const output = destination.result();

    const topLevel = boxes(output);
    expect(topLevel.map(({ type }) => type)).toEqual(['ftyp', 'mdat', 'moov']);
    expect(topLevel[1]?.end).toBe(topLevel[2]?.start);
    const movieChildren = boxes(output, topLevel[2]!.contentStart, topLevel[2]!.end);
    expect(movieChildren.some(({ type }) => type === 'mvex')).toBe(false);
    expect(movieChildren.filter(({ type }) => type === 'trak')).toHaveLength(2);

    for (const track of movieChildren.filter(({ type }) => type === 'trak')) {
      const trackChildren = boxes(output, track.contentStart, track.end);
      const mediaBox = trackChildren.find(({ type }) => type === 'mdia')!;
      const mediaChildren = boxes(output, mediaBox.contentStart, mediaBox.end);
      const mediaInfo = mediaChildren.find(({ type }) => type === 'minf')!;
      const mediaInfoChildren = boxes(output, mediaInfo.contentStart, mediaInfo.end);
      const sampleTable = mediaInfoChildren.find(({ type }) => type === 'stbl')!;
      expect(boxes(output, sampleTable.contentStart, sampleTable.end).map(({ type }) => type)).toEqual(
        expect.arrayContaining(['stsd', 'stts', 'stsc', 'stsz', 'co64']),
      );
    }
  });
});
