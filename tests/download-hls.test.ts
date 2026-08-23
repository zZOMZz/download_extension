import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadHlsPlaylist,
  fetchTextResource,
  isRecoverableNetworkError,
  NetworkResourceError,
  type BinaryWriter,
  type HlsDownloadProgress,
} from '../src/core/hls/download-hls';
import { parseHlsPlaylist, type HlsMediaPlaylist } from '../src/core/protocols/hls';
import type { NetworkRequestCoordinator } from '../src/core/network/host-health';

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

  result(): Uint8Array {
    const length = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}

function mediaPlaylist(text: string): HlsMediaPlaylist {
  const parsed = parseHlsPlaylist(text, 'https://cdn.example/vod/index.m3u8');
  if (parsed.type !== 'media') throw new Error('Expected a media playlist.');
  return parsed;
}

function response(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HLS download engine', () => {
  it('writes initialization data and segments in playlist order', async () => {
    const playlist = mediaPlaylist(`#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4,
one.m4s
#EXTINF:4,
two.m4s
#EXT-X-ENDLIST`);
    const resources = new Map([
      ['https://cdn.example/vod/init.mp4', new Uint8Array([0])],
      ['https://cdn.example/vod/one.m4s', new Uint8Array([1, 2])],
      ['https://cdn.example/vod/two.m4s', new Uint8Array([3, 4])],
    ]);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const bytes = resources.get(String(input));
      return bytes ? response(bytes) : new Response(null, { status: 404 });
    }));

    const writer = new TestWriter();
    const progress: number[] = [];
    await downloadHlsPlaylist(playlist, writer, {
      onProgress: (value) => progress.push(value.completedSegments),
    });

    expect(writer.result()).toEqual(new Uint8Array([0, 1, 2, 3, 4]));
    expect(writer.closed).toBe(true);
    expect(progress.filter((value, index) => value > 0 && value !== progress[index - 1])).toEqual([1, 2]);
  });

  it('reports streamed network bytes, speed, and completion telemetry', async () => {
    const playlist = mediaPlaylist(`#EXTM3U
#EXTINF:4,
streamed.ts
#EXT-X-ENDLIST`);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Length': '4' },
    })));

    const writer = new TestWriter();
    const progress: HlsDownloadProgress[] = [];
    await downloadHlsPlaylist(playlist, writer, {
      onProgress: (value) => progress.push(value),
    });

    expect(writer.result()).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(progress.at(-1)).toMatchObject({
      phase: 'completed',
      completedSegments: 1,
      networkBytesReceived: 4,
      currentSegmentBytesReceived: 4,
      currentSegmentBytesTotal: 4,
      currentSpeedBytesPerSecond: 0,
    });
    expect(progress.some(({ currentSpeedBytesPerSecond }) => (currentSpeedBytesPerSecond ?? 0) > 0)).toBe(true);
  });

  it('runs segment requests through the configured host coordinator', async () => {
    const playlist = mediaPlaylist(`#EXTM3U
#EXTINF:4,
coordinated.ts
#EXT-X-ENDLIST`);
    vi.stubGlobal('fetch', vi.fn(async () => response(new Uint8Array([1, 2]))));
    const requestedUrls: string[] = [];
    const coordinator: NetworkRequestCoordinator = {
      run: async <T,>(url: string, operation: () => Promise<T>) => {
        requestedUrls.push(url);
        return operation();
      },
    };

    await downloadHlsPlaylist(playlist, new TestWriter(), {
      networkPolicy: { requestCoordinator: coordinator },
    });
    expect(requestedUrls).toEqual(['https://cdn.example/vod/coordinated.ts']);
  });

  it('resumes from a completed segment boundary without requesting earlier segments', async () => {
    const playlist = mediaPlaylist(`#EXTM3U
#EXTINF:4,
one.ts
#EXTINF:4,
two.ts
#EXTINF:4,
three.ts
#EXT-X-ENDLIST`);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/three.ts')) return response(new Uint8Array([5, 6]));
      return new Response(null, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const writer = new TestWriter();
    const checkpoints: HlsDownloadProgress[] = [];
    await downloadHlsPlaylist(playlist, writer, {
      startSegmentIndex: 2,
      initialBytesWritten: 4,
      onSegmentComplete: (progress) => { checkpoints.push(progress); },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('three.ts');
    expect(writer.result()).toEqual(new Uint8Array([5, 6]));
    expect(checkpoints).toContainEqual(expect.objectContaining({
      completedSegments: 3,
      bytesWritten: 6,
    }));
  });

  it('retries retryable HTTP failures and exposes the backoff state', async () => {
    const playlist = mediaPlaylist(`#EXTM3U
#EXTINF:4,
retry.ts
#EXT-X-ENDLIST`);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(response(new Uint8Array([7, 8])));
    vi.stubGlobal('fetch', fetchMock);

    const writer = new TestWriter();
    const progress: HlsDownloadProgress[] = [];
    const requestRetries: Array<{ resourceKind: string; resourceUrl: string; segment?: number }> = [];
    await downloadHlsPlaylist(playlist, writer, {
      onProgress: (value) => progress.push(value),
      onRequestRetry: ({ resourceKind, resourceUrl, segment }) => {
        requestRetries.push({ resourceKind, resourceUrl, ...(segment ? { segment } : {}) });
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(progress).toContainEqual(expect.objectContaining({
      phase: 'retrying',
      retryAttempt: 2,
      maxAttempts: 4,
      retryDelayMs: 0,
      retryReason: 'HTTP 503',
    }));
    expect(requestRetries).toEqual([{
      resourceKind: 'media-segment',
      resourceUrl: 'https://cdn.example/vod/retry.ts',
      segment: 1,
    }]);
    expect(writer.result()).toEqual(new Uint8Array([7, 8]));
  });

  it('does not retry a permanent HTTP 404 response', async () => {
    const playlist = mediaPlaylist(`#EXTM3U
#EXTINF:4,
missing.ts
#EXT-X-ENDLIST`);
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const writer = new TestWriter();
    await expect(downloadHlsPlaylist(playlist, writer)).rejects.toThrow(
      'after 1 attempt: HTTP 404',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(writer.aborted).toBe(true);
  });

  it('classifies exhausted network failures for task-level recovery', async () => {
    const playlist = mediaPlaylist(`#EXTM3U
#EXTINF:4,
forbidden.ts
#EXT-X-ENDLIST`);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })));

    const writer = new TestWriter();
    let caught: unknown;
    try {
      await downloadHlsPlaylist(playlist, writer, {
        networkPolicy: { maxAttempts: 1, firstByteTimeoutMs: 5, idleTimeoutMs: 5 },
      });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(NetworkResourceError);
    expect(caught).toMatchObject({ resourceKind: 'media-segment', recoverable: true });
    expect(isRecoverableNetworkError(caught)).toBe(true);
  });

  it('fails a request that never returns response headers', async () => {
    const playlist = mediaPlaylist(`#EXTM3U
#EXTINF:4,
stalled.ts
#EXT-X-ENDLIST`);
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));

    const writer = new TestWriter();
    await expect(downloadHlsPlaylist(playlist, writer, {
      networkPolicy: { maxAttempts: 1, firstByteTimeoutMs: 5, idleTimeoutMs: 5 },
    })).rejects.toThrow('The server did not respond');
    expect(writer.aborted).toBe(true);
  });

  it('fails when a response body stops producing data', async () => {
    const playlist = mediaPlaylist(`#EXTM3U
#EXTINF:4,
idle.ts
#EXT-X-ENDLIST`);
    const body = new ReadableStream<Uint8Array>({
      start() {
        // Deliberately leave the stream open without producing a chunk.
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    const writer = new TestWriter();
    await expect(downloadHlsPlaylist(playlist, writer, {
      networkPolicy: { maxAttempts: 1, firstByteTimeoutMs: 5, idleTimeoutMs: 5 },
    })).rejects.toThrow('No response data was received');
    expect(writer.aborted).toBe(true);
  });

  it('applies timeout and retry handling to text resources', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response('#EXTM3U', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const retries: Array<{ attempt: number; reason: string }> = [];
    await expect(fetchTextResource(
      'https://cdn.example/index.m3u8',
      undefined,
      undefined,
      { onRetry: ({ attempt, reason }) => retries.push({ attempt, reason }) },
    )).resolves.toBe('#EXTM3U');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([{ attempt: 2, reason: 'HTTP 503' }]);
  });

  it('decrypts standard AES-128 segments with the media-sequence IV', async () => {
    const playlist = mediaPlaylist(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4,
encrypted.ts
#EXT-X-ENDLIST`);
    const keyBytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    const iv = new Uint8Array(16);
    iv[15] = 7;
    const cleartext = new TextEncoder().encode('authorized test segment');
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, cleartext));

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('key.bin')) return response(keyBytes);
      if (String(input).endsWith('encrypted.ts')) return response(encrypted);
      return new Response(null, { status: 404 });
    }));

    const writer = new TestWriter();
    await downloadHlsPlaylist(playlist, writer);
    expect(writer.result()).toEqual(cleartext);
  });

  it('resolves the player-embedded key used by 2rk.cc decoy key responses', async () => {
    const parsed = parseHlsPlaylist(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://www.2rk.cc/saber",IV=0x00000000000000000000000000000000
#EXTINF:4,
encrypted.ts
#EXT-X-ENDLIST`, 'https://www.2rk.cc/video/example/index.m3u8');
    if (parsed.type !== 'media') throw new Error('Expected a media playlist.');

    const keyBytes = Uint8Array.from({ length: 16 }, (_, index) => (index * 13 + 7) % 256);
    const cleartext = new TextEncoder().encode('site adapter test segment');
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, cryptoKey, cleartext),
    );
    const assignments = [...keyBytes]
      .map((value, index) => `view[method(${index})](${index},${value})`)
      .join(',');
    const playerSource = `var buffer=new ArrayBuffer(16),view=new DataView(buffer);${assignments},this[prop()]=view[value()]`;

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://www.2rk.cc/saber') return response(new Uint8Array(31));
      if (url === 'https://www.2rk.cc/h.js') {
        return new Response(playerSource, { status: 200, headers: { 'Content-Type': 'application/javascript' } });
      }
      if (url.endsWith('/encrypted.ts')) return response(encrypted);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const writer = new TestWriter();
    await downloadHlsPlaylist(parsed, writer);

    expect(writer.result()).toEqual(cleartext);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.2rk.cc/h.js',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});
