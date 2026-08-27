import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadDashPlan,
  downloadDashTrack,
  preferredDashTrack,
  type DashDownloadPlan,
} from '../src/core/dash/download-dash';
import { fetchBinaryResource, type BinaryWriter, type HlsDownloadProgress } from '../src/core/hls/download-hls';
import type { DashMediaSource } from '../src/shared/media';

class TestWriter implements BinaryWriter {
  readonly chunks: Uint8Array[] = [];
  closed = false;
  aborted = false;

  async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk.slice());
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}

class ResumableTestWriter implements BinaryWriter {
  bytes: number[];
  closed = false;
  aborted = false;

  constructor(initial: readonly number[] = []) {
    this.bytes = [...initial];
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.bytes.push(...chunk);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('DASH download engine', () => {
  it('prefers broadly compatible AVC and AAC representations', () => {
    const source: DashMediaSource = {
      type: 'static',
      hasContentProtection: false,
      tracks: [
        { id: 'av1', kind: 'video', codecs: 'av01.0.08M.08', height: 2160, initialization: { url: 'https://cdn.example/av1-init' }, segments: [{ url: 'https://cdn.example/av1' }] },
        { id: 'avc', kind: 'video', codecs: 'avc1.640028', height: 1080, initialization: { url: 'https://cdn.example/avc-init' }, segments: [{ url: 'https://cdn.example/avc' }] },
        { id: 'opus', kind: 'audio', codecs: 'opus', bandwidth: 192_000, initialization: { url: 'https://cdn.example/opus-init' }, segments: [{ url: 'https://cdn.example/opus' }] },
        { id: 'aac', kind: 'audio', codecs: 'mp4a.40.2', bandwidth: 128_000, initialization: { url: 'https://cdn.example/aac-init' }, segments: [{ url: 'https://cdn.example/aac' }] },
      ],
    };
    expect(preferredDashTrack(source, 'video')?.id).toBe('avc');
    expect(preferredDashTrack(source, 'audio')?.id).toBe('aac');
  });

  it('writes video initialization/fragments before audio and reports progress', async () => {
    const plan: DashDownloadPlan = {
      video: {
        id: 'video', kind: 'video', initialization: { url: 'https://cdn.example/video-init' },
        segments: [{ url: 'https://cdn.example/video-1' }, { url: 'https://cdn.example/video-2' }],
      },
      audio: {
        id: 'audio', kind: 'audio', initialization: { url: 'https://cdn.example/audio-init' },
        segments: [{ url: 'https://cdn.example/audio-1' }],
      },
      totalSegments: 3,
    };
    const resources = new Map([
      ['https://cdn.example/video-init', new Uint8Array([10])],
      ['https://cdn.example/video-1', new Uint8Array([11])],
      ['https://cdn.example/video-2', new Uint8Array([12])],
      ['https://cdn.example/audio-init', new Uint8Array([20])],
      ['https://cdn.example/audio-1', new Uint8Array([21])],
    ]);
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      const bytes = resources.get(url);
      return bytes
        ? new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 })
        : new Response(null, { status: 404 });
    }));
    const writer = new TestWriter();
    const progress: HlsDownloadProgress[] = [];
    await downloadDashPlan(plan, writer, { onProgress: (event) => progress.push(event) });

    expect(requests).toEqual([...resources.keys()]);
    expect(writer.chunks).toEqual([...resources.values()]);
    expect(writer.closed).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: 'completed', completedSegments: 3, totalSegments: 3 });
  });

  it('rejects ignored range requests before reading the full response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Length': '1000000000' },
    })));

    await expect(fetchBinaryResource(
      'https://cdn.example/large.m4s',
      { offset: 100, length: 20 },
      undefined,
      { maxAttempts: 1 },
      {},
      'media-segment',
      true,
    )).rejects.toThrow(/did not honor the requested byte range/i);
  });

  it('accepts an exact HTTP partial response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: { 'Content-Range': 'bytes 100-102/1000', 'Content-Length': '3' },
    })));

    await expect(fetchBinaryResource(
      'https://cdn.example/large.m4s',
      { offset: 100, length: 3 },
      undefined,
      { maxAttempts: 1 },
      {},
      'media-segment',
      true,
    )).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it('switches to a resource fallback after a permanent primary-host failure', async () => {
    const plan: DashDownloadPlan = {
      video: {
        id: 'video', kind: 'video',
        initialization: {
          url: 'https://primary.example/video-init',
          alternativeUrls: ['https://backup.example/video-init'],
        },
        segments: [{ url: 'https://cdn.example/video-1' }],
      },
      audio: {
        id: 'audio', kind: 'audio', initialization: { url: 'https://cdn.example/audio-init' },
        segments: [{ url: 'https://cdn.example/audio-1' }],
      },
      totalSegments: 2,
    };
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url === 'https://primary.example/video-init') return new Response(null, { status: 403 });
      return new Response(new Uint8Array([1]).buffer, { status: 200 });
    }));
    const fallbacks: Array<{ failedUrl: string; nextUrl: string }> = [];

    const writer = new TestWriter();
    await downloadDashPlan(plan, writer, {
      onResourceFallback: ({ failedUrl, nextUrl }) => fallbacks.push({ failedUrl, nextUrl }),
    });

    expect(requests.slice(0, 2)).toEqual([
      'https://primary.example/video-init',
      'https://backup.example/video-init',
    ]);
    expect(fallbacks).toEqual([{
      failedUrl: 'https://primary.example/video-init',
      nextUrl: 'https://backup.example/video-init',
    }]);
    expect(writer.closed).toBe(true);
  });

  it('resumes a track without requesting its committed initialization and segments again', async () => {
    const track: DashDownloadPlan['video'] = {
      id: 'video',
      kind: 'video',
      initialization: { url: 'https://cdn.example/init' },
      segments: [
        { url: 'https://cdn.example/one' },
        { url: 'https://cdn.example/two' },
        { url: 'https://cdn.example/three' },
      ],
    };
    const resources = new Map([
      ['https://cdn.example/init', Uint8Array.of(10, 11)],
      ['https://cdn.example/one', Uint8Array.of(20)],
      ['https://cdn.example/two', Uint8Array.of(30)],
      ['https://cdn.example/three', Uint8Array.of(40)],
    ]);
    const firstRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      firstRequests.push(url);
      if (url.endsWith('/two')) return new Response(null, { status: 503 });
      return new Response(resources.get(url)!.slice().buffer as ArrayBuffer, { status: 200 });
    }));
    const firstWriter = new ResumableTestWriter();
    let initializationBytes = 0;
    let completedSegments = 0;
    let bytesWritten = 0;
    await expect(downloadDashTrack(track, firstWriter, {
      networkPolicy: { maxAttempts: 1 },
      onInitializationComplete: (bytes) => { initializationBytes = bytes; },
      onSegmentComplete: (progress) => {
        completedSegments = progress.completedSegments;
        bytesWritten = progress.bytesWritten;
      },
    })).rejects.toThrow(/503/);

    expect(firstRequests).toEqual([
      'https://cdn.example/init',
      'https://cdn.example/one',
      'https://cdn.example/two',
    ]);
    expect(firstWriter.bytes).toEqual([10, 11, 20]);
    expect(firstWriter.aborted).toBe(true);
    expect({ initializationBytes, completedSegments, bytesWritten }).toEqual({
      initializationBytes: 2,
      completedSegments: 1,
      bytesWritten: 3,
    });

    const resumeRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      resumeRequests.push(url);
      return new Response(resources.get(url)!.slice().buffer as ArrayBuffer, { status: 200 });
    }));
    const resumedWriter = new ResumableTestWriter(firstWriter.bytes);
    await downloadDashTrack(track, resumedWriter, {
      networkPolicy: { maxAttempts: 1 },
      initializationWritten: true,
      startSegmentIndex: completedSegments,
      initialBytesWritten: bytesWritten,
    });

    expect(resumeRequests).toEqual([
      'https://cdn.example/two',
      'https://cdn.example/three',
    ]);
    expect(resumedWriter.bytes).toEqual([10, 11, 20, 30, 40]);
    expect(resumedWriter.closed).toBe(true);
  });
});
