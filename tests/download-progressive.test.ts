import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadProgressiveMedia } from '../src/core/progressive/download-progressive';
import { HttpStatusError, type HlsDownloadProgress } from '../src/core/hls/download-hls';
import { HostHealthController } from '../src/core/network/host-health';

const URL = 'https://rr1.googlevideo.com/videoplayback?itag=18';

function outputWriter() {
  return {
    write: vi.fn(async (_bytes: Uint8Array) => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async (_cause?: unknown) => {}),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('progressive downloads sharing queue host controls', () => {
  it('waits through another protocol\'s cooldown without starting a request timeout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const coordinator = new HostHealthController({ maxConcurrency: 2, circuitFailureThreshold: 2, cooldownMs: 5_000 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(coordinator.run(URL, async () => { throw new HttpStatusError(503, undefined); }))
        .rejects.toThrow('HTTP 503');
    }
    const fetchMock = vi.fn(async () => new Response(Uint8Array.of(1)));
    vi.stubGlobal('fetch', fetchMock);
    const writer = outputWriter();
    const pending = downloadProgressiveMedia(URL, writer, {
      networkPolicy: { requestCoordinator: coordinator, firstByteTimeoutMs: 50, idleTimeoutMs: 50 },
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writer.abort).not.toHaveBeenCalled();
    await expect(coordinator.run('https://other.example/video.m4s', async () => 'available'))
      .resolves.toBe('available');
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(writer.close).toHaveBeenCalledOnce();
  });

  it('holds the host slot through slow writes and all body reads, then releases it before local commit', async () => {
    const coordinator = new HostHealthController({ maxConcurrency: 1 });
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; controller.enqueue(Uint8Array.of(1)); },
    }, { highWaterMark: 0 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(body))
      .mockResolvedValueOnce(new Response(Uint8Array.of(3)));
    vi.stubGlobal('fetch', fetchMock);
    const firstWriter = outputWriter();
    let finishWrite: () => void;
    let finishClose: () => void;
    firstWriter.write.mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    firstWriter.close.mockImplementationOnce(() => new Promise<void>((resolve) => { finishClose = resolve; }));
    const first = downloadProgressiveMedia(URL, firstWriter, { networkPolicy: { requestCoordinator: coordinator } });
    await vi.waitFor(() => expect(firstWriter.write).toHaveBeenCalledOnce());
    const secondWriter = outputWriter();
    const second = downloadProgressiveMedia(URL, secondWriter, { networkPolicy: { requestCoordinator: coordinator } });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    finishWrite!();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledOnce();
    streamController!.enqueue(Uint8Array.of(2));
    streamController!.close();
    await vi.waitFor(() => expect(firstWriter.close).toHaveBeenCalledOnce());
    await second;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstWriter.write.mock.calls.map(([bytes]) => [...bytes])).toEqual([[1], [2]]);
    expect(secondWriter.close).toHaveBeenCalledOnce();
    finishClose!();
    await first;
  });

  it('cancels a request still waiting for a host slot and aborts only its staged output', async () => {
    const coordinator = new HostHealthController({ maxConcurrency: 1 });
    let release: () => void;
    const operation = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const holder = coordinator.run(URL, operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const writer = outputWriter();
    const controller = new AbortController();
    const pending = downloadProgressiveMedia(URL, writer, {
      signal: controller.signal, networkPolicy: { requestCoordinator: coordinator },
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await rejected;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
    expect(writer.close).not.toHaveBeenCalled();
    expect(writer.abort).toHaveBeenCalledExactlyOnceWith(controller.signal.reason);
    release!();
    await holder;
    expect(coordinator.snapshots()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['http', 'body'])('reports a %s failure to the shared host controller', async (failureKind) => {
    const coordinator = new HostHealthController({ maxConcurrency: 4 });
    const response = failureKind === 'http'
      ? new Response(null, { status: 503 })
      : new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('Connection lost')); } }));
    vi.stubGlobal('fetch', vi.fn(async () => response));
    const writer = outputWriter();
    await expect(downloadProgressiveMedia(URL, writer, { networkPolicy: { requestCoordinator: coordinator } }))
      .rejects.toThrow();
    expect(coordinator.snapshots()).toMatchObject([{ concurrencyLimit: 2, consecutiveFailures: 1 }]);
    expect(writer.abort).toHaveBeenCalledOnce();
    expect(writer.close).not.toHaveBeenCalled();
  });

  it.each(['write', 'close'] as const)('preserves a local %s failure without penalizing the CDN', async (method) => {
    const coordinator = new HostHealthController({ maxConcurrency: 4 });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1));
        if (method === 'close') controller.close();
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const writer = outputWriter();
    const failure = new TypeError('Local file failed');
    writer[method].mockRejectedValueOnce(failure);
    await expect(downloadProgressiveMedia(URL, writer, { networkPolicy: { requestCoordinator: coordinator } }))
      .rejects.toBe(failure);
    expect(coordinator.snapshots()).toEqual([]);
    expect(writer.abort).toHaveBeenCalledExactlyOnceWith(failure);
    if (method === 'write') {
      expect(cancel).toHaveBeenCalledOnce();
      expect(writer.close).not.toHaveBeenCalled();
    }
    // A failed local operation released the slot and left the host available to other protocols.
    await expect(coordinator.run(URL, async () => 'ready')).resolves.toBe('ready');
  });
});

describe('progressive media download', () => {
  it('waits for each file write before reading more and reports the completed byte count', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled <= 3) controller.enqueue(Uint8Array.of(pulled));
        else controller.close();
      },
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers: { 'Content-Length': '3' } });
    const buffer = vi.spyOn(response, 'arrayBuffer');
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);
    const writer = outputWriter();
    let finishWrite: (() => void) | undefined;
    writer.write.mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    const progress: HlsDownloadProgress[] = [];
    const pending = downloadProgressiveMedia(URL, writer, {
      onProgress: (value) => progress.push(value),
    });
    await vi.waitFor(() => expect(writer.write).toHaveBeenCalledOnce());
    expect(pulled).toBe(1);
    expect(writer.close).not.toHaveBeenCalled();
    finishWrite!();
    await pending;

    expect(writer.write.mock.calls.map(([bytes]) => [...bytes])).toEqual([[1], [2], [3]]);
    expect(buffer).not.toHaveBeenCalled();
    expect(writer.close).toHaveBeenCalledOnce();
    expect(writer.abort).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(URL, expect.objectContaining({ credentials: 'include' }));
    expect(progress.at(-1)).toMatchObject({ phase: 'completed', bytesWritten: 3, completedSegments: 1 });
  });

  it.each([403, 206])('rejects HTTP %i without writing or committing a file', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.of(1), { status })));
    const writer = outputWriter();

    await expect(downloadProgressiveMedia(URL, writer)).rejects.toThrow();
    expect(writer.write).not.toHaveBeenCalled();
    expect(writer.close).not.toHaveBeenCalled();
    expect(writer.abort).toHaveBeenCalledOnce();
  });

  it('discards truncated output instead of committing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.of(1, 2), {
      headers: { 'Content-Length': '3' },
    })));
    const writer = outputWriter();

    await expect(downloadProgressiveMedia(URL, writer)).rejects.toThrow(/complete file/i);
    expect(writer.write).toHaveBeenCalledOnce();
    expect(writer.close).not.toHaveBeenCalled();
    expect(writer.abort).toHaveBeenCalledOnce();
  });

  it('cancels a pending read and aborts the output when the user cancels', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetchMock = vi.fn(async () => new Response(body));
    vi.stubGlobal('fetch', fetchMock);
    const writer = outputWriter();
    const controller = new AbortController();
    const pending = downloadProgressiveMedia(URL, writer, { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort();
    await rejected;

    expect(cancel).toHaveBeenCalledOnce();
    expect(writer.abort).toHaveBeenCalledOnce();
    expect(writer.close).not.toHaveBeenCalled();
  });

  it('times out a stalled body without retrying already written chunks', async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Uint8Array.of(1)); },
    });
    const fetchMock = vi.fn(async () => new Response(body));
    vi.stubGlobal('fetch', fetchMock);
    const writer = outputWriter();
    const pending = downloadProgressiveMedia(URL, writer, { networkPolicy: { idleTimeoutMs: 50 } });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'NetworkTimeoutError' });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(writer.write).toHaveBeenCalledOnce();
    expect(writer.abort).toHaveBeenCalledOnce();
    expect(writer.close).not.toHaveBeenCalled();
  });

  it('preserves a write error and cancels the network stream when the destination fails', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Uint8Array.of(1)); },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const writer = outputWriter();
    const failure = new Error('Disk full');
    writer.write.mockRejectedValueOnce(failure);

    await expect(downloadProgressiveMedia(URL, writer)).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledOnce();
    expect(writer.abort).toHaveBeenCalledWith(failure);
    expect(writer.close).not.toHaveBeenCalled();
  });
});
