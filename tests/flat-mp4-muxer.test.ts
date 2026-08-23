// @ts-expect-error Vitest runs in Node; the browser extension intentionally does not include Node typings.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import muxjs from 'mux.js';
import { SeparateTrackFmp4Writer } from '../src/browser/separate-track-fmp4-writer';
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

  it('combines independently initialized audio and video sources with colliding track IDs', async () => {
    const transmuxer = new muxjs.mp4.Transmuxer({ remux: false, keepOriginalTimestamps: true });
    const segments: Array<{ type: 'audio' | 'video'; init: Uint8Array; data: Uint8Array }> = [];
    transmuxer.on('data', (segment) => {
      if (segment.type === 'audio' || segment.type === 'video') {
        segments.push({ type: segment.type, init: segment.initSegment, data: segment.data });
      }
    });
    const done = new Promise<void>((resolve) => transmuxer.on('done', resolve));
    transmuxer.push(new Uint8Array(readFileSync('node_modules/mux.js/test/segments/test-segment.ts')));
    transmuxer.flush();
    await done;
    expect(segments.map(({ type }) => type).sort()).toEqual(['audio', 'video']);

    const destination = new MemoryDestination();
    const muxer = new FlatMp4Muxer(destination);
    for (const segment of segments) {
      await muxer.addSource(segment.type, segment.init);
      await muxer.appendFragment(segment.data, segment.type);
    }
    await muxer.finalize();

    const output = destination.result();
    const topLevel = boxes(output);
    const movie = topLevel.find(({ type }) => type === 'moov')!;
    const tracks = boxes(output, movie.contentStart, movie.end).filter(({ type }) => type === 'trak');
    expect(tracks).toHaveLength(2);
    const trackIds = tracks.map((track) => {
      const header = boxes(output, track.contentStart, track.end).find(({ type }) => type === 'tkhd')!;
      return new DataView(output.buffer, output.byteOffset, output.byteLength).getUint32(header.contentStart + 12);
    });
    expect(new Set(trackIds).size).toBe(2);
  });

  it('streams separate fragmented-MP4 playlists through the shared track writer', async () => {
    const transmuxer = new muxjs.mp4.Transmuxer({ remux: false, keepOriginalTimestamps: true });
    const segments: Array<{ type: 'audio' | 'video'; init: Uint8Array; data: Uint8Array }> = [];
    transmuxer.on('data', (segment) => {
      if (segment.type === 'audio' || segment.type === 'video') {
        segments.push({ type: segment.type, init: segment.initSegment, data: segment.data });
      }
    });
    const done = new Promise<void>((resolve) => transmuxer.on('done', resolve));
    transmuxer.push(new Uint8Array(readFileSync('node_modules/mux.js/test/segments/test-segment.ts')));
    transmuxer.flush();
    await done;
    const video = segments.find(({ type }) => type === 'video')!;
    const audio = segments.find(({ type }) => type === 'audio')!;

    const destination = new MemoryDestination();
    const writer = new SeparateTrackFmp4Writer(destination, 1, 1);
    await writer.write(video.init);
    await writer.write(video.data);
    await writer.write(audio.init);
    await writer.write(audio.data);
    await writer.close();

    const output = destination.result();
    const movie = boxes(output).find(({ type }) => type === 'moov')!;
    expect(boxes(output, movie.contentStart, movie.end).filter(({ type }) => type === 'trak')).toHaveLength(2);
  });

  it('filters a shared two-track initialization map for separate fMP4 playlists', async () => {
    const separateTransmuxer = new muxjs.mp4.Transmuxer({ remux: false, keepOriginalTimestamps: true });
    const separate: Array<{ type: 'audio' | 'video'; data: Uint8Array }> = [];
    separateTransmuxer.on('data', (segment) => {
      if (segment.type === 'audio' || segment.type === 'video') {
        separate.push({ type: segment.type, data: segment.data });
      }
    });
    const separateDone = new Promise<void>((resolve) => separateTransmuxer.on('done', resolve));
    const fixture = new Uint8Array(readFileSync('node_modules/mux.js/test/segments/test-segment.ts'));
    separateTransmuxer.push(fixture);
    separateTransmuxer.flush();
    await separateDone;

    const combinedTransmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
    let sharedInitialization: Uint8Array | undefined;
    combinedTransmuxer.on('data', (segment) => { sharedInitialization = segment.initSegment; });
    const combinedDone = new Promise<void>((resolve) => combinedTransmuxer.on('done', resolve));
    combinedTransmuxer.push(fixture);
    combinedTransmuxer.flush();
    await combinedDone;

    const destination = new MemoryDestination();
    const writer = new SeparateTrackFmp4Writer(destination, 1, 1);
    await writer.write(sharedInitialization!);
    await writer.write(separate.find(({ type }) => type === 'video')!.data);
    await writer.write(sharedInitialization!);
    await writer.write(separate.find(({ type }) => type === 'audio')!.data);
    await writer.close();

    const output = destination.result();
    const movie = boxes(output).find(({ type }) => type === 'moov')!;
    expect(boxes(output, movie.contentStart, movie.end).filter(({ type }) => type === 'trak')).toHaveLength(2);
  });

  it('combines a video-only transport stream with a packed-AAC audio rendition', async () => {
    const transmux = async (filename: string, expectedType: 'audio' | 'video') => {
      const transmuxer = new muxjs.mp4.Transmuxer({ remux: false, keepOriginalTimestamps: true });
      let result: { init: Uint8Array; data: Uint8Array } | undefined;
      transmuxer.on('data', (segment) => {
        if (segment.type === expectedType) result = { init: segment.initSegment, data: segment.data };
      });
      const done = new Promise<void>((resolve) => transmuxer.on('done', resolve));
      transmuxer.push(new Uint8Array(readFileSync(filename)));
      transmuxer.flush();
      await done;
      if (!result) throw new Error(`The ${expectedType} fixture produced no output.`);
      return result;
    };
    const video = await transmux('node_modules/mux.js/test/segments/test-no-audio-segment.ts', 'video');
    const audio = await transmux('node_modules/mux.js/test/segments/test-aac-segment.aac', 'audio');

    const destination = new MemoryDestination();
    const muxer = new FlatMp4Muxer(destination);
    await muxer.addSource('video', video.init, 'vide');
    await muxer.appendFragment(video.data, 'video');
    await muxer.addSource('audio', audio.init, 'soun');
    await muxer.appendFragment(audio.data, 'audio');
    await muxer.finalize();

    const output = destination.result();
    const movie = boxes(output).find(({ type }) => type === 'moov')!;
    expect(boxes(output, movie.contentStart, movie.end).filter(({ type }) => type === 'trak')).toHaveLength(2);
  });
});
