import { readFileSync } from 'node:fs';
import muxjs from 'mux.js';
import { describe, expect, it, vi } from 'vitest';
import { describeDirectOutput, executeDirectDownload, type DirectOutputTarget } from '../src/runtime/direct-download';
import { inspectHlsUrl } from '../src/core/hls/inspect-hls';
import type { HlsDownloadProgress } from '../src/core/hls/download-hls';
import type { TransformBackend } from '../src/runtime/transform-backend';
import { SeparateTrackFmp4Writer } from '../src/runtime/media/separate-track-fmp4-writer';
import type { DashMediaSource } from '../src/shared/media';

const segment = new Uint8Array(188 * 3);
segment[0] = segment[188] = segment[376] = 0x47;
const transforms: TransformBackend = {
  createHlsWriter: (writer) => writer,
  createDashWriter: () => { throw new Error('DASH is not used by this fixture'); },
};
const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST';

function output() {
  let bytes = new Uint8Array();
  let closed = false;
  const target: DirectOutputTarget = {
    resumable: false,
    writer: {
      write: async (chunk) => { const next = new Uint8Array(bytes.length + chunk.length); next.set(bytes); next.set(chunk, bytes.length); bytes = next; },
      writeAt: async (position, chunk) => { bytes.set(chunk, position); },
      close: vi.fn(async () => { closed = true; }),
      abort: vi.fn(async () => {}),
    },
    read: vi.fn(async () => {
      if (!closed) throw new Error('Read occurred before close');
      return { size: bytes.byteLength, read: async (offset: number, length: number) => bytes.slice(offset, offset + length) };
    }),
    finish: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  return target;
}

async function hlsRequest() {
  return { kind: 'hls' as const, hls: await inspectHlsUrl('https://fixture.test/media.m3u8', async () => manifest), outputFormat: 'original' as const };
}
const network = () => ({ fetch: vi.fn(async () => new Response(segment.slice().buffer as ArrayBuffer)) });

describe('one-shot direct download runtime', () => {
  it('awaits close, output validation, and host publication before reporting completed', async () => {
    const target = output();
    const progress: HlsDownloadProgress[] = [];
    let publish!: () => void;
    target.finish = vi.fn(() => new Promise<void>((resolve) => { publish = resolve; }));
    const transport = network();
    const pending = executeDirectDownload(await hlsRequest(), target, {
      transforms, transport, onProgress: (event) => progress.push(event),
    });
    await vi.waitFor(() => expect(target.finish).toHaveBeenCalledOnce());
    expect(target.writer.close).toHaveBeenCalledOnce();
    expect(target.read).toHaveBeenCalledOnce();
    expect(progress.some(({ phase }) => phase === 'completed')).toBe(false);
    expect(progress.at(-1)?.phase).toBe('finalizing');
    publish();
    await expect(pending).resolves.toMatchObject({ format: 'ts', size: segment.byteLength });
    expect(progress.filter(({ phase }) => phase === 'completed')).toHaveLength(1);
    expect(transport.fetch).toHaveBeenCalledWith('https://fixture.test/segment.ts', expect.anything());
  });

  it('rejects a fully transferred but invalid MP4 before publication or success', async () => {
    const target = output();
    const progress: HlsDownloadProgress[] = [];
    await expect(executeDirectDownload({ kind: 'progressive', url: 'https://fixture.test/video.mp4' }, target, {
      transforms, transport: { fetch: async () => new Response('<html>session expired</html>') },
      onProgress: (event) => progress.push(event),
    })).rejects.toMatchObject({ name: 'OutputValidationError' });
    expect(target.writer.close).toHaveBeenCalledOnce();
    expect(target.abort).toHaveBeenCalledOnce();
    expect(target.finish).not.toHaveBeenCalled();
    expect(progress.some(({ phase }) => phase === 'completed')).toBe(false);
  });

  it('does not report completion when host publication fails after valid media was written', async () => {
    const target = output();
    const progress: HlsDownloadProgress[] = [];
    target.finish = vi.fn(async () => { throw new Error('Save interrupted'); });
    await expect(executeDirectDownload(await hlsRequest(), target, {
      transforms, transport: network(), onProgress: (event) => progress.push(event),
    })).rejects.toThrow('Save interrupted');
    expect(target.abort).toHaveBeenCalledOnce();
    expect(progress.some(({ phase }) => phase === 'completed')).toBe(false);
  });

  it('honors selected DASH tracks and validates their merged MP4 using the injected host backend', async () => {
    const resources = new Map<string, Uint8Array>();
    const muxer = new muxjs.mp4.Transmuxer({ remux: false, keepOriginalTimestamps: true });
    muxer.on('data', (chunk) => {
      if (chunk.type === 'video' || chunk.type === 'audio') {
        resources.set(`https://fixture.test/${chunk.type}-init`, chunk.initSegment);
        resources.set(`https://fixture.test/${chunk.type}-data`, chunk.data);
      }
    });
    const done = new Promise<void>((resolve) => muxer.on('done', resolve));
    muxer.push(new Uint8Array(readFileSync('node_modules/mux.js/test/segments/test-segment.ts')));
    muxer.flush();
    await done;
    const source: DashMediaSource = {
      type: 'static', hasContentProtection: false,
      tracks: [
        { id: 'low', kind: 'video', height: 360, codecs: 'avc1.64001f',
          initialization: { url: 'https://fixture.test/unused-init' }, segments: [{ url: 'https://fixture.test/unused-data' }] },
        { id: 'high', kind: 'video', height: 1080, codecs: 'avc1.64001f',
          initialization: { url: 'https://fixture.test/video-init' }, segments: [{ url: 'https://fixture.test/video-data' }] },
        { id: 'audio', kind: 'audio', codecs: 'mp4a.40.2',
          initialization: { url: 'https://fixture.test/audio-init' }, segments: [{ url: 'https://fixture.test/audio-data' }] },
      ],
    };
    const request = { kind: 'dash' as const, source, videoTrackId: 'high', audioTrackId: 'audio' };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const bytes = resources.get(String(input));
      if (!bytes) throw new Error(`An unselected resource was fetched: ${input}`);
      return new Response(bytes.slice().buffer as ArrayBuffer);
    });
    const validation = await executeDirectDownload(request, output(), {
      transforms: { ...transforms, createDashWriter: (writer, video, audio) => new SeparateTrackFmp4Writer(writer, video, audio) },
      transport: { fetch }, networkPolicy: { maxAttempts: 1 },
    });
    expect(validation).toMatchObject({ videoTracks: 1, audioTracks: 1, fragmented: false });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://fixture.test/video-init', 'https://fixture.test/video-data',
      'https://fixture.test/audio-init', 'https://fixture.test/audio-data',
    ]);
    expect(describeDirectOutput(request, 'Selected')).toMatchObject({ filename: 'Selected-1080p.mp4' });
  });

  it('checks cancellation after validation and prevents publication', async () => {
    const target = output();
    const controller = new AbortController();
    const read = target.read;
    target.read = async () => { const result = await read(); controller.abort(); return result; };
    await expect(executeDirectDownload(await hlsRequest(), target, {
      transforms, transport: network(), signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(target.finish).not.toHaveBeenCalled();
    expect(target.abort).toHaveBeenCalledOnce();
  });
});
