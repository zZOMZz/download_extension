import {
  HttpStatusError,
  NetworkTimeoutError,
  type BinaryWriter,
  type HlsDownloadProgress,
  type HlsNetworkPolicy,
} from '../hls/download-hls';

export interface ProgressiveDownloadOptions {
  signal?: AbortSignal;
  networkPolicy?: HlsNetworkPolicy;
  contentLength?: number;
  onProgress?: (progress: HlsDownloadProgress) => void;
}

/** Streams one complete file with backpressure; failed partial writes are never retried in place. */
export async function downloadProgressiveMedia(
  url: string,
  writer: BinaryWriter,
  options: ProgressiveDownloadOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const startedAt = Date.now();
  const progress: HlsDownloadProgress = {
    completedSegments: 0,
    totalSegments: 1,
    bytesWritten: 0,
    networkBytesReceived: 0,
    currentSegment: 1,
    currentSegmentBytesReceived: 0,
    phase: 'requesting',
  };
  let lastPublishedAt = 0;
  let lastSampleAt = startedAt;
  let lastSampleBytes = 0;
  const publish = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPublishedAt < 200) return;
    const bytes = progress.bytesWritten;
    progress.averageSpeedBytesPerSecond = bytes * 1_000 / Math.max(1, now - startedAt);
    progress.currentSpeedBytesPerSecond = (bytes - lastSampleBytes) * 1_000 / Math.max(1, now - lastSampleAt);
    if (progress.currentSegmentBytesTotal && progress.averageSpeedBytesPerSecond > 0) {
      progress.estimatedSecondsRemaining = Math.max(0,
        (progress.currentSegmentBytesTotal - bytes) / progress.averageSpeedBytesPerSecond);
    }
    lastPublishedAt = now;
    lastSampleAt = now;
    lastSampleBytes = bytes;
    options.onProgress?.({ ...progress });
  };
  const waitForNetwork = async <T>(pending: Promise<T>, timeoutMs: number): Promise<T> => {
    controller.signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onRequestAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onRequestAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onRequestAbort, { once: true });
      timer = setTimeout(() => controller.abort(new NetworkTimeoutError(
        `No response data was received for ${Math.round(timeoutMs / 1_000)} seconds.`,
      )), Math.max(1, timeoutMs));
    });
    try {
      return await Promise.race([pending, interrupted]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onRequestAbort) controller.signal.removeEventListener('abort', onRequestAbort);
    }
  };

  try {
    controller.signal.throwIfAborted();
    if (!['https:', 'http:'].includes(new URL(url).protocol)) {
      throw new Error('The media URL must use HTTP or HTTPS.');
    }
    publish(true);
    const request = async (): Promise<{ completed: true } | { completed: false; outputFailure: unknown }> => {
      // Host cooldown/slot waiting must finish before the first-byte timer or fetch starts.
      controller.signal.throwIfAborted();
      const response = await waitForNetwork(fetch(url, {
        credentials: 'include',
        signal: controller.signal,
      }), options.networkPolicy?.firstByteTimeoutMs ?? 15_000);
      if (response.status !== 200) {
        await response.body?.cancel();
        if (!response.ok) throw new HttpStatusError(response.status, undefined);
        throw new Error('The server returned an incomplete media response.');
      }
      if (!response.body) throw new Error('The media response does not support streaming.');
      const headerLength = response.headers.get('Content-Length');
      const totalBytes = headerLength === null ? options.contentLength : Number(headerLength);
      if (totalBytes !== undefined && Number.isSafeInteger(totalBytes) && totalBytes >= 0) {
        progress.currentSegmentBytesTotal = totalBytes;
      }
      reader = response.body.getReader();
      while (true) {
        controller.signal.throwIfAborted();
        const chunk = await waitForNetwork(reader.read(), options.networkPolicy?.idleTimeoutMs ?? 20_000);
        if (chunk.done) break;
        // Await each write before reading more so the entire file is never buffered.
        try {
          await writer.write(chunk.value);
        } catch (outputFailure) {
          // Stop the transfer before releasing its slot, but do not blame the CDN for a disk failure.
          controller.abort(outputFailure);
          await reader.cancel(outputFailure).catch(() => {});
          return { completed: false, outputFailure };
        }
        progress.bytesWritten += chunk.value.byteLength;
        progress.networkBytesReceived = progress.bytesWritten;
        progress.currentSegmentBytesReceived = progress.bytesWritten;
        progress.phase = 'downloading';
        publish();
      }
      controller.signal.throwIfAborted();
      if (progress.bytesWritten === 0 || (
        progress.currentSegmentBytesTotal !== undefined &&
        progress.bytesWritten !== progress.currentSegmentBytesTotal
      )) {
        throw new Error('The media response ended before the complete file was received.');
      }
      return { completed: true };
    };
    const coordinator = options.networkPolicy?.requestCoordinator;
    const result = await (coordinator ? coordinator.run(url, request, controller.signal) : request());
    if (!result.completed) throw result.outputFailure;
    controller.signal.throwIfAborted();
    // Final file commit is local work and must not affect host health or occupy a network slot.
    progress.phase = 'finalizing';
    publish(true);
    await writer.close();
    progress.completedSegments = 1;
    progress.phase = 'completed';
    publish(true);
  } catch (cause) {
    controller.abort(cause);
    await reader?.cancel(cause).catch(() => {});
    await writer.abort(cause).catch(() => {});
    throw cause;
  } finally {
    reader?.releaseLock();
    options.signal?.removeEventListener('abort', onAbort);
  }
}
