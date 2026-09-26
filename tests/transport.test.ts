import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserTransport, type Transport } from '../src/core/network/transport';
import { downloadHlsPlaylist, fetchBinaryResource, fetchTextResource } from '../src/core/hls/download-hls';
import { inspectHlsUrl } from '../src/core/hls/inspect-hls';
import { downloadDashPlan, downloadDashTrack, prepareDashDownload } from '../src/core/dash/download-dash';
import { downloadProgressiveMedia } from '../src/core/progressive/download-progressive';
import type { DashMediaSource } from '../src/shared/media';

function output() {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    write: vi.fn(async (chunk: Uint8Array) => { chunks.push(chunk.slice()); }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
}

function rejectGlobalNetwork() {
  const fetch = vi.fn(async () => { throw new Error('The injected host must own every HTTP request.'); });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function singleSegmentIndex(): Uint8Array {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode('sidx'), 4);
  view.setUint32(12, 1);
  view.setUint32(16, 1_000);
  view.setUint16(30, 1);
  view.setUint32(32, 2);
  view.setUint32(36, 1_000);
  return bytes;
}

afterEach(() => vi.unstubAllGlobals());

describe('host transport boundary', () => {
  it('keeps browser credentials by default and allows an explicit host credential policy', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    await browserTransport.fetch('https://example.test/default');
    await browserTransport.fetch('https://example.test/anonymous', { credentials: 'omit' });
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://example.test/default', { credentials: 'include' });
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://example.test/anonymous', { credentials: 'omit' });
  });

  it('uses one host for HLS manifests, rendition, initialization, media, key and key-adapter script', async () => {
    const globalFetch = rejectGlobalNetwork();
    const keyBytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
    const media = Uint8Array.of(1, 2, 3);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, media);
    const playerScript = `var bytes = new ArrayBuffer(16), view = new DataView(bytes);${
      [...keyBytes].map((value, index) => `view.setUint8(${index},${value});`).join('')
    }this.key = view.buffer;`;
    const resources = new Map<string, string | ArrayBuffer | Uint8Array>([
      ['https://2rk.cc/master.m3u8', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="main",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="audio"\nvideo.m3u8'],
      ['https://2rk.cc/video.m3u8', '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="/saber",IV=0x00000000000000000000000000000000\n#EXTINF:1,\nsegment.m4s\n#EXT-X-ENDLIST'],
      ['https://2rk.cc/audio.m3u8', '#EXTM3U\n#EXTINF:1,\naudio.m4s\n#EXT-X-ENDLIST'],
      ['https://2rk.cc/init.mp4', Uint8Array.of(9)],
      ['https://2rk.cc/segment.m4s', encrypted],
      ['https://2rk.cc/audio.m4s', Uint8Array.of(4)],
      ['https://2rk.cc/saber', 'decoy'],
      ['https://2rk.cc/h.js', playerScript],
    ]);
    const requests: string[] = [];
    const transport: Transport = {
      async fetch(input, init) {
        const url = String(input);
        requests.push(url);
        expect(init?.credentials).toBeUndefined();
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const body = resources.get(url);
        if (body === undefined) throw new Error(`Unexpected fixture request: ${url}`);
        return new Response(body instanceof Uint8Array ? body.slice().buffer as ArrayBuffer : body);
      },
    };
    const loadText = (url: string, signal?: AbortSignal) =>
      fetchTextResource(url, signal, { maxAttempts: 1 }, {}, transport);
    const inspected = await inspectHlsUrl('https://2rk.cc/master.m3u8', loadText);
    const videoOutput = output();
    const audioOutput = output();
    await downloadHlsPlaylist(inspected.media, videoOutput, { transport, networkPolicy: { maxAttempts: 1 } });
    await downloadHlsPlaylist(inspected.audioMedia!, audioOutput, { transport, networkPolicy: { maxAttempts: 1 } });
    expect(videoOutput.chunks).toEqual([Uint8Array.of(9), media]);
    expect(audioOutput.chunks).toEqual([Uint8Array.of(4)]);
    expect(new Set(requests)).toEqual(new Set(resources.keys()));
    expect(videoOutput.close).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('carries the host through DASH index resolution, fallback, exact ranges, track and plan download', async () => {
    const globalFetch = rejectGlobalNetwork();
    const index = singleSegmentIndex();
    const source: DashMediaSource = {
      type: 'static', hasContentProtection: false,
      tracks: ['video', 'audio'].map((kind) => ({
        id: kind, kind: kind as 'video' | 'audio',
        initialization: { url: `https://cdn.test/${kind}`, byteRange: { offset: 0, length: 2 } },
        index: { url: `https://cdn.test/${kind}`, byteRange: { offset: 2, length: index.length } },
      })),
    };
    const requests: Array<{ url: string; range: string | null }> = [];
    const transport: Transport = {
      async fetch(input, init) {
        const url = String(input);
        const range = new Headers(init?.headers).get('Range');
        requests.push({ url, range });
        expect(init?.credentials).toBeUndefined();
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (url.startsWith('https://failed.test/')) return new Response(null, { status: 403 });
        const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
        if (!match) throw new Error('A DASH fixture requires a byte range.');
        const start = Number(match[1]);
        const end = Number(match[2]);
        const bytes = start === 2 ? index : Uint8Array.of(start, end);
        return new Response(bytes.slice().buffer as ArrayBuffer, {
          status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/100` },
        });
      },
    };
    const options = { transport, networkPolicy: { maxAttempts: 1 } };
    const plan = await prepareDashDownload(source, options);
    plan.video.segments[0] = {
      ...plan.video.segments[0]!, url: 'https://failed.test/video', alternativeUrls: ['https://cdn.test/video'],
    };
    const trackOutput = output();
    const planOutput = output();
    await downloadDashTrack(plan.video, trackOutput, options);
    await downloadDashPlan(plan, planOutput, options);
    expect(requests.slice(0, 2).map(({ range }) => range)).toEqual(['bytes=2-45', 'bytes=2-45']);
    expect(requests).toContainEqual({ url: 'https://failed.test/video', range: 'bytes=46-47' });
    expect(trackOutput.chunks).toEqual([Uint8Array.of(0, 1), Uint8Array.of(46, 47)]);
    expect(planOutput.chunks).toHaveLength(4);
    expect(trackOutput.close).toHaveBeenCalledOnce();
    expect(planOutput.close).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it.each(['text', 'binary'] as const)('keeps %s retries on the injected host', async (kind) => {
    const globalFetch = rejectGlobalNetwork();
    let attempts = 0;
    const transport: Transport = {
      async fetch() {
        attempts += 1;
        return attempts === 1
          ? new Response(null, { status: 503, headers: { 'Retry-After': '0' } })
          : new Response('ok');
      },
    };
    const retries = vi.fn();
    const result = kind === 'text'
      ? await fetchTextResource('https://cdn.test/retry', undefined, { maxAttempts: 2 }, { onRetry: retries }, transport)
      : await fetchBinaryResource('https://cdn.test/retry', undefined, undefined, { maxAttempts: 2 }, { onRetry: retries }, 'media-segment', false, transport);
    expect(typeof result === 'string' ? result : new TextDecoder().decode(result)).toBe('ok');
    expect(attempts).toBe(2);
    expect(retries).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('streams progressive output through the injected host without forcing browser credentials', async () => {
    const globalFetch = rejectGlobalNetwork();
    const transport: Transport = {
      async fetch(_input, init) {
        expect(init?.credentials).toBeUndefined();
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return new Response(Uint8Array.of(1, 2, 3), { headers: { 'Content-Length': '3' } });
      },
    };
    const writer = output();
    await downloadProgressiveMedia('https://cdn.test/video.mp4', writer, { transport });
    expect(writer.chunks).toEqual([Uint8Array.of(1, 2, 3)]);
    expect(writer.close).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
