import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadProgressiveMedia } from '../src/core/progressive/download-progressive';
import type { HlsDownloadProgress } from '../src/core/hls/download-hls';

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
