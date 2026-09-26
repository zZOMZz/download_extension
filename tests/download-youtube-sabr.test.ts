// @ts-expect-error Vitest has Node available; the extension intentionally excludes Node typings.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import muxjs from 'mux.js';
import { CompositeBuffer, UmpWriter } from 'googlevideo/ump';
import { FormatInitializationMetadata, MediaHeader, NextRequestPolicy, SabrRedirect, StreamProtectionStatus, UMPPartId, VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { concatenateChunks } from 'googlevideo/utils';
import { downloadYouTubeSabr } from '../src/core/site-adapters/youtube/download-sabr';
import type { YouTubeSabrSource } from '../src/shared/media';
import type { HlsDownloadProgress, RandomAccessBinaryWriter } from '../src/core/hls/download-hls';

const source: YouTubeSabrSource = {
  videoId: 'jUNz-uTF--E', durationSeconds: 1,
  serverAbrStreamingUrl: 'https://rr1.googlevideo.com/videoplayback?id=fixture&sabr=1',
  formats: [
    { itag: 401, mimeType: 'video/mp4; codecs="av01.0.12M.08"', lastModified: '1', bitrate: 8_000_000, approxDurationMs: 1_000, height: 2160, width: 3840 },
    { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', lastModified: '1', bitrate: 128_000, approxDurationMs: 1_000 },
  ],
};
const context = {
  serverAbrStreamingUrl: source.serverAbrStreamingUrl,
  videoPlaybackUstreamerConfig: 'AQID', poToken: 'BAUG',
  clientInfo: { clientName: 1, clientVersion: '2.20260926.01.00' },
};
const selection = { videoItag: 401, audioItag: 140 };
type Fixture = { type: 'audio' | 'video'; init: Uint8Array; data: Uint8Array };
let fixtures: Fixture[] = [];

class Destination implements RandomAccessBinaryWriter {
  data = new Uint8Array(0);
  busy = false;
  write = vi.fn(async (chunk: Uint8Array) => {
    if (this.busy) throw new Error('Concurrent writes are not permitted.');
    this.busy = true;
    await Promise.resolve();
    const combined = new Uint8Array(this.data.byteLength + chunk.byteLength);
    combined.set(this.data); combined.set(chunk, this.data.byteLength); this.data = combined;
    this.busy = false;
  });
  writeAt = vi.fn(async (position: number, chunk: Uint8Array) => { this.data.set(chunk, position); });
  close = vi.fn(async () => {});
  abort = vi.fn(async () => {});
}
function ump(parts: Array<[number, Uint8Array]>): Uint8Array {
  const buffer = new CompositeBuffer();
  const writer = new UmpWriter(buffer);
  for (const [id, bytes] of parts) writer.write(id, bytes);
  return concatenateChunks(buffer.chunks);
}
function metadata(itag = 401): Uint8Array {
  const format = source.formats.find((entry) => entry.itag === itag) ?? source.formats[0]!;
  return FormatInitializationMetadata.encode({
    videoId: source.videoId, formatId: { itag, lastModified: '1' },
    mimeType: format.mimeType, durationUnits: '1000', durationTimescale: '1000', endSegmentNumber: '1',
  }).finish();
}
function mediaResponse(truncate = false): Uint8Array {
  const parts: Array<[number, Uint8Array]> = [];
  for (const [index, fixture] of fixtures.entries()) {
    const itag = fixture.type === 'video' ? 401 : 140;
    parts.push([UMPPartId.FORMAT_INITIALIZATION_METADATA, metadata(itag)]);
    for (const [segmentIndex, segment] of [fixture.init, fixture.data].entries()) {
      const payload = truncate && fixture.type === 'video' && segmentIndex === 1 ? segment.slice(0, -1) : segment;
      const headerId = index * 2 + segmentIndex;
      parts.push([UMPPartId.MEDIA_HEADER, MediaHeader.encode({
        headerId, itag, lmt: '1', videoId: source.videoId, formatId: { itag, lastModified: '1' },
        isInitSeg: segmentIndex === 0, sequenceNumber: segmentIndex,
        durationMs: segmentIndex === 0 ? '0' : '1000', contentLength: String(payload.length),
      }).finish()]);
      // Deliberately split MP4 length/type fields as well as media payloads.
      let offset = 0;
      for (const requested of [1, 2, 4, 3, 7, 13, payload.length]) {
        const piece = payload.subarray(offset, Math.min(payload.length, offset + requested));
        if (piece.length) parts.push([UMPPartId.MEDIA, new Uint8Array([headerId, ...piece])]);
        offset += piece.length;
      }
      parts.push([UMPPartId.MEDIA_END, new Uint8Array([headerId])]);
    }
  }
  return ump(parts);
}
const terminalResponse = () => ump([[UMPPartId.NEXT_REQUEST_POLICY, NextRequestPolicy.encode({}).finish()]]);
function response(bytes: Uint8Array): Response {
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const next = bytes.slice(offset, offset + 16_381);
      offset += next.length;
      controller.enqueue(next);
    },
  }), { headers: { 'content-type': 'application/vnd.yt-ump' } });
}
function mockMedia(truncate = false) {
  let count = 0;
  const mock = vi.fn(async (_input: unknown, _init?: RequestInit) => {
    if (count > 4) throw new Error('The fixture should finish after its media response.');
    return response(count++ === 0 ? mediaResponse(truncate) : terminalResponse());
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}
function boxes(bytes: Uint8Array, start = 0, end = bytes.length): Array<{ type: string; start: number; body: number; end: number }> {
  const out = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = start; offset < end;) {
    const small = view.getUint32(offset);
    const size = small === 1 ? Number(view.getBigUint64(offset + 8)) : small;
    out.push({ type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), start: offset, body: offset + (small === 1 ? 16 : 8), end: offset + size });
    offset += size;
  }
  return out;
}

beforeAll(async () => {
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: false, keepOriginalTimestamps: true });
  transmuxer.on('data', (segment) => {
    if (segment.type === 'audio' || segment.type === 'video') fixtures.push({ type: segment.type, init: segment.initSegment, data: segment.data });
  });
  const done = new Promise<void>((resolve) => transmuxer.on('done', resolve));
  transmuxer.push(new Uint8Array(readFileSync('node_modules/mux.js/test/segments/test-segment.ts')));
  transmuxer.flush();
  await done;
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('YouTube SABR download', () => {
  it('uses the installed SABR protocol with explicit formats and merges arbitrary MP4 chunk boundaries', async () => {
    const fetch = mockMedia();
    const destination = new Destination();
    const progress: HlsDownloadProgress[] = [];
    await downloadYouTubeSabr(source, context, destination, { ...selection, onProgress: (value) => progress.push(value) });
    const body = fetch.mock.calls[0]![1]!.body as Uint8Array;
    const decoded = VideoPlaybackAbrRequest.decode(body);
    expect(decoded.preferredVideoFormatIds?.[0]?.itag).toBe(401);
    expect(decoded.preferredAudioFormatIds?.[0]?.itag).toBe(140);
    expect(decoded.streamerContext?.poToken).toEqual(new Uint8Array([4, 5, 6]));
    expect(fetch.mock.calls[0]![1]!.redirect).toBe('error');
    const top = boxes(destination.data);
    expect(top.map((box) => box.type)).toEqual(['ftyp', 'mdat', 'moov']);
    const movie = top[2]!;
    expect(boxes(destination.data, movie.body, movie.end).filter((box) => box.type === 'trak')).toHaveLength(2);
    expect(destination.close).toHaveBeenCalledOnce();
    expect(destination.abort).not.toHaveBeenCalled();
    expect(progress.at(-1)).toMatchObject({ completedSegments: 2, phase: 'completed', currentSpeedBytesPerSecond: 0 });
  });

  it('rejects an absent requested resolution instead of silently falling back', async () => {
    const fetch = mockMedia();
    const destination = new Destination();
    await expect(downloadYouTubeSabr(source, context, destination, { ...selection, videoItag: 18 })).rejects.toThrow('exact selected');
    expect(fetch).not.toHaveBeenCalled();
    expect(destination.abort).toHaveBeenCalledOnce();
  });

  it('aborts both streams and the file when the server changes the selected format', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(ump([[UMPPartId.FORMAT_INITIALIZATION_METADATA, metadata(399)]]))));
    const destination = new Destination();
    await expect(downloadYouTubeSabr(source, context, destination, selection)).rejects.toThrow('changed the selected');
    expect(destination.close).not.toHaveBeenCalled();
    expect(destination.abort).toHaveBeenCalledOnce();
  });

  it('rejects an incomplete MP4 box even when the UMP transfer completes', async () => {
    mockMedia(true);
    const destination = new Destination();
    await expect(downloadYouTubeSabr(source, context, destination, selection)).rejects.toThrow('incomplete segment');
    expect(destination.close).not.toHaveBeenCalled();
    expect(destination.abort).toHaveBeenCalledOnce();
  });

  it('never sends the playback token to a redirected foreign host', async () => {
    const fetch = vi.fn(async () => response(ump([[UMPPartId.SABR_REDIRECT, SabrRedirect.encode({ url: 'https://attacker.example/videoplayback' }).finish()]])));
    vi.stubGlobal('fetch', fetch);
    const destination = new Destination();
    await expect(downloadYouTubeSabr(source, context, destination, { ...selection, idleTimeoutMs: 50 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(destination.abort).toHaveBeenCalledOnce();
  });

  it('cancels a stalled request promptly and aborts its destination', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const destination = new Destination();
    await expect(downloadYouTubeSabr(source, context, destination, { ...selection, idleTimeoutMs: 5 })).rejects.toThrow('stopped receiving');
    expect(destination.abort).toHaveBeenCalledOnce();
  });

  it('honors cancellation before sending any request', async () => {
    const fetch = mockMedia();
    const controller = new AbortController(); controller.abort(new Error('User canceled'));
    const destination = new Destination();
    await expect(downloadYouTubeSabr(source, context, destination, { ...selection, signal: controller.signal })).rejects.toThrow('User canceled');
    expect(fetch).not.toHaveBeenCalled();
    expect(destination.abort).toHaveBeenCalledOnce();
  });

  it('aborts on write failure and never finalizes a partial file', async () => {
    mockMedia();
    const destination = new Destination();
    destination.write.mockRejectedValue(new Error('Disk is full'));
    await expect(downloadYouTubeSabr(source, context, destination, selection)).rejects.toThrow('Disk is full');
    expect(destination.close).not.toHaveBeenCalled();
    expect(destination.abort).toHaveBeenCalledOnce();
  });

  it('reports rejected playback attestation without silently downloading a lower quality', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(ump([[UMPPartId.STREAM_PROTECTION_STATUS, StreamProtectionStatus.encode({ status: 3 }).finish()]]))));
    const destination = new Destination();
    await expect(downloadYouTubeSabr(source, context, destination, selection)).rejects.toThrow('rejected the playback');
    expect(destination.close).not.toHaveBeenCalled();
    expect(destination.abort).toHaveBeenCalledOnce();
  });

  it('cancels the active response reader when the user stops a running download', async () => {
    const cancel = vi.fn();
    let fetched!: () => void;
    const ready = new Promise<void>((resolve) => { fetched = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetched();
      return new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-type': 'application/vnd.yt-ump' } });
    }));
    const destination = new Destination();
    const controller = new AbortController();
    const pending = downloadYouTubeSabr(source, context, destination, { ...selection, signal: controller.signal });
    const failed = expect(pending).rejects.toThrow('User stopped');
    await ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('User stopped'));
    await failed;
    expect(cancel).toHaveBeenCalledOnce();
    expect(destination.abort).toHaveBeenCalledOnce();
  });

  it('waits for file writes before pulling more streaming response data', async () => {
    const bytes = mediaResponse();
    let pulled = 0;
    let count = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (count++) return response(terminalResponse());
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          const part = bytes.slice(pulled, pulled + 512);
          pulled += part.length;
          if (part.length) controller.enqueue(part); else controller.close();
        },
      }), { headers: { 'content-type': 'application/vnd.yt-ump' } });
    }));
    const destination = new Destination();
    let unblock!: () => void;
    let writing!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const firstWrite = new Promise<void>((resolve) => { writing = resolve; });
    const original = destination.write.getMockImplementation()!;
    destination.write.mockImplementationOnce(async (chunk) => { writing(); await blocked; await original(chunk); });
    const pending = downloadYouTubeSabr(source, context, destination, selection);
    await firstWrite;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pulled).toBeLessThan(bytes.length);
    expect(count).toBe(1);
    unblock();
    await pending;
    expect(destination.close).toHaveBeenCalledOnce();
  });

  it('uses a refreshed PO token even when minting outlasts the library retry delay', async () => {
    vi.useFakeTimers();
    let resolveMint!: (bytes: Uint8Array) => void;
    const mint = vi.fn(() => new Promise<Uint8Array>((resolve) => { resolveMint = resolve; }));
    let count = 0;
    const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => {
      if (count++ === 0) return response(ump([[UMPPartId.STREAM_PROTECTION_STATUS, StreamProtectionStatus.encode({ status: 3 }).finish()]]));
      return response(count === 2 ? concatenateChunks([ump([[UMPPartId.STREAM_PROTECTION_STATUS, StreamProtectionStatus.encode({ status: 1 }).finish()]]), mediaResponse()]) : terminalResponse());
    });
    vi.stubGlobal('fetch', fetch);
    const destination = new Destination();
    const pending = downloadYouTubeSabr(source, context, destination, { ...selection, onMintPoToken: mint });
    const finished = expect(pending).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(750);
    expect(fetch).toHaveBeenCalledOnce();
    resolveMint(new Uint8Array([7, 8, 9]));
    await vi.advanceTimersByTimeAsync(2_000);
    await finished;
    const decoded = VideoPlaybackAbrRequest.decode(fetch.mock.calls[1]![1]!.body as Uint8Array);
    expect(decoded.streamerContext?.poToken).toEqual(new Uint8Array([7, 8, 9]));
    expect(destination.close).toHaveBeenCalledOnce();
  });

});
