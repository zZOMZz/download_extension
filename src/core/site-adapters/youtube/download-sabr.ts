import { SabrStream } from 'googlevideo/sabr-stream';
import { VideoPlaybackAbrRequest, type ClientInfo } from 'googlevideo/protos';
import type { SabrFormat } from 'googlevideo/shared-types';
import type { YouTubeSabrSource } from '../../../shared/media';
import type { HlsDownloadProgress, RandomAccessBinaryWriter } from '../../hls/download-hls';
import { FlatMp4Muxer } from '../../mp4/flat-mp4-muxer';
import { browserTransport, type Transport } from '../../network/transport';

export interface YouTubeSabrDownloadContext {
  serverAbrStreamingUrl: string;
  videoPlaybackUstreamerConfig: string;
  poToken?: string | undefined;
  clientInfo?: ClientInfo | undefined;
}

export interface YouTubeSabrDownloadOptions {
  transport?: Transport;
  videoItag: number;
  audioItag: number;
  signal?: AbortSignal;
  onProgress?: (progress: HlsDownloadProgress) => void;
  onMintPoToken?: () => Promise<Uint8Array>;
  idleTimeoutMs?: number;
}

type TrackKind = 'video' | 'audio';

function validateStreamingUrl(value: string | URL | Request): void {
  const url = new URL(value instanceof Request ? value.url : value.toString());
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com') ||
    url.pathname !== '/videoplayback' || url.username || url.password) {
    throw new Error('The SABR request must use a secure GoogleVideo playback endpoint.');
  }
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function segmentBoxes(bytes: Uint8Array): Array<{ type: string; start: number; end: number }> {
  const result: Array<{ type: string; start: number; end: number }> = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.byteLength;) {
    if (offset + 8 > bytes.byteLength) throw new Error('An incomplete SABR MP4 box was received.');
    let size = view.getUint32(offset);
    const headerSize = size === 1 ? 16 : 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) throw new Error('An incomplete SABR MP4 box was received.');
      const largeSize = view.getBigUint64(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The SABR MP4 box is too large.');
      size = Number(largeSize);
    } else if (size === 0) size = bytes.byteLength - offset;
    if (size < headerSize || offset + size > bytes.byteLength) {
      throw new Error('An invalid SABR MP4 segment was received.');
    }
    result.push({
      type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)),
      start: offset,
      end: offset + size,
    });
    offset += size;
  }
  return result;
}

/** UMP MEDIA chunks can divide an MP4 box at any byte, including its header. */
function mp4Segments() {
  let buffered = new Uint8Array(0);
  let initialized = false;
  return {
    push(chunk: Uint8Array): Uint8Array[] {
      const joined = new Uint8Array(buffered.byteLength + chunk.byteLength);
      joined.set(buffered);
      joined.set(chunk, buffered.byteLength);
      buffered = joined;
      const completed: Uint8Array[] = [];
      let offset = 0;
      let groupStart = 0;
      let hasMovieFragment = false;
      while (offset + 8 <= buffered.byteLength) {
        const view = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength);
        let size = view.getUint32(offset);
        const headerSize = size === 1 ? 16 : 8;
        if (size === 1) {
          if (offset + 16 > buffered.byteLength) break;
          const largeSize = view.getBigUint64(offset + 8);
          if (largeSize > BigInt(128 * 1024 * 1024)) throw new Error('The SABR MP4 box is too large.');
          size = Number(largeSize);
        }
        if (size < headerSize || size > 128 * 1024 * 1024) throw new Error('The SABR MP4 box has an invalid size.');
        if (offset + size > buffered.byteLength) break;
        const type = String.fromCharCode(...buffered.subarray(offset + 4, offset + 8));
        if (type === 'moof') hasMovieFragment = true;
        if (type === 'moov') {
          if (initialized) throw new Error('The YouTube MP4 initialization changed during download.');
          initialized = true;
          completed.push(buffered.slice(groupStart, offset + size));
          groupStart = offset + size;
        } else if (type === 'mdat') {
          if (!initialized || !hasMovieFragment) throw new Error('The YouTube response is not a fragmented MP4 stream.');
          completed.push(buffered.slice(groupStart, offset + size));
          groupStart = offset + size;
          hasMovieFragment = false;
        } else if (!['ftyp', 'moof', 'moov', 'styp', 'sidx', 'emsg', 'prft', 'free'].includes(type)) {
          throw new Error('The YouTube response contains an unsupported MP4 box.');
        }
        offset += size;
      }
      buffered = buffered.slice(groupStart);
      return completed;
    },
    finish() {
      if (buffered.byteLength) throw new Error('The YouTube MP4 stream ended with an incomplete segment.');
    },
  };
}

/** Downloads the exact selected MP4 tracks and streams them into one seekable MP4 file. */
export async function downloadYouTubeSabr(
  source: YouTubeSabrSource,
  context: YouTubeSabrDownloadContext,
  destination: RandomAccessBinaryWriter,
  options: YouTubeSabrDownloadOptions,
): Promise<void> {
  const controller = new AbortController();
  let stream: SabrStream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: unknown;
  let stopped = false;
  let writeQueue = Promise.resolve();
  let minting: Promise<void> | undefined;
  let refreshedToken: Uint8Array | undefined;
  const readers: Array<ReadableStreamDefaultReader<ArrayBufferView<ArrayBufferLike>>> = [];
  const readerStates: Record<TrackKind, 'starting' | 'reading' | 'writing' | 'done'> = {
    video: 'starting', audio: 'starting',
  };
  const drainWaiters = new Set<() => void>();
  const fail = (cause: unknown) => {
    if (stopped) return;
    stopped = true;
    failure = cause;
    controller.abort(cause);
    try { stream?.abort(); } catch { /* The library may have closed its readers already. */ }
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };
  const onAbort = () => fail(options.signal?.reason ?? new DOMException('Download canceled.', 'AbortError'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const activity = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => fail(new Error('The YouTube download stopped receiving data.')),
      options.idleTimeoutMs ?? 45_000);
  };
  const check = () => { if (stopped) throw failure; };
  const wait = <T>(pending: Promise<T>): Promise<T> => {
    check();
    return new Promise<T>((resolve, reject) => {
      const onInterrupted = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onInterrupted, { once: true });
      pending.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', onInterrupted));
    });
  };
  const notifyDrain = () => {
    if (Object.values(readerStates).every((state) => state === 'reading' || state === 'done')) {
      for (const resolve of drainWaiters) resolve();
      drainWaiters.clear();
    }
  };
  const waitForOutput = async () => {
    check();
    // npm googlevideo 4.1.1 has no stream backpressure. Hold the next response read
    // until both consumers finish their preceding segment writes.
    if (Object.values(readerStates).some((state) => state === 'writing')) {
      await wait(new Promise<void>((resolve) => drainWaiters.add(resolve)));
    }
    check();
  };
  const startedAt = Date.now();
  const progress: HlsDownloadProgress = {
    completedSegments: 0, totalSegments: 2, bytesWritten: 0,
    networkBytesReceived: 0, currentSegmentBytesReceived: 0, phase: 'requesting',
  };
  let lastPublishedAt = 0;
  const publish = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPublishedAt < 200) return;
    lastPublishedAt = now;
    progress.averageSpeedBytesPerSecond = (progress.networkBytesReceived ?? 0) * 1_000 / Math.max(1, now - startedAt);
    progress.currentSpeedBytesPerSecond = progress.phase === 'completed' ? 0 : progress.averageSpeedBytesPerSecond;
    if (progress.currentSegmentBytesTotal && progress.averageSpeedBytesPerSecond > 0) {
      progress.estimatedSecondsRemaining = Math.max(0,
        (progress.currentSegmentBytesTotal - (progress.currentSegmentBytesReceived ?? 0)) / progress.averageSpeedBytesPerSecond);
    }
    options.onProgress?.({ ...progress });
  };

  try {
    if (options.signal?.aborted) onAbort();
    check();
    validateStreamingUrl(context.serverAbrStreamingUrl);
    if (!context.clientInfo?.clientName || !context.clientInfo.clientVersion || !context.videoPlaybackUstreamerConfig) {
      throw new Error('Play this YouTube video first to obtain its current streaming session.');
    }
    const video = source.formats.find((format) => format.itag === options.videoItag && format.mimeType.startsWith('video/mp4'));
    const audio = source.formats.find((format) => format.itag === options.audioItag && format.mimeType.startsWith('audio/mp4'));
    if (!video || !audio) throw new Error('The exact selected YouTube video and audio formats are unavailable.');
    const formats: SabrFormat[] = [video, audio].map((format) => Object.fromEntries(
      Object.entries({ ...format, audioTrackId: format.audioTrack?.id }).filter(([, value]) => value !== undefined),
    ) as unknown as SabrFormat);
    if (video.contentLength && audio.contentLength) {
      progress.currentSegmentBytesTotal = video.contentLength + audio.contentLength;
    }
    const muxer = new FlatMp4Muxer({
      write: async (bytes) => { check(); await destination.write(bytes); progress.bytesWritten += bytes.byteLength; activity(); },
      writeAt: async (position, bytes) => { check(); await destination.writeAt(position, bytes); activity(); },
      close: () => destination.close(), abort: (reason) => destination.abort(reason),
    });
    const fetchWithBackpressure: typeof fetch = async (input, init) => {
      try { validateStreamingUrl(input); } catch (cause) { fail(cause); throw cause; }
      check();
      if (minting) await wait(minting);
      await waitForOutput();
      let bodyBytes = init?.body;
      if (refreshedToken && bodyBytes instanceof Uint8Array) {
        // The library builds its body before invoking fetch; a token refreshed
        // during the awaited callback must also replace that already built body.
        const request = VideoPlaybackAbrRequest.decode(bodyBytes);
        request.streamerContext = { sabrContexts: [], unsentSabrContexts: [], ...request.streamerContext, poToken: refreshedToken };
        bodyBytes = VideoPlaybackAbrRequest.encode(request).finish();
      }
      const response = await (options.transport ?? browserTransport).fetch(input, {
        ...init, ...(bodyBytes === undefined ? {} : { body: bodyBytes }), redirect: 'error',
        signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
      });
      check();
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`The YouTube streaming request failed (HTTP ${response.status}).`);
      }
      if (!response.body) throw new Error('The YouTube streaming response has no body.');
      const body = response.body.getReader();
      const cancelBody = () => { void body.cancel(controller.signal.reason).catch(() => {}); };
      controller.signal.addEventListener('abort', cancelBody, { once: true });
      const removeBodyListener = () => controller.signal.removeEventListener('abort', cancelBody);
      return new Response(new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            await waitForOutput();
            const next = await body.read();
            check();
            if (next.done) { removeBodyListener(); body.releaseLock(); output.close(); return; }
            activity();
            progress.networkBytesReceived = (progress.networkBytesReceived ?? 0) + next.value.byteLength;
            output.enqueue(next.value);
          } catch (cause) { removeBodyListener(); output.error(cause); await body.cancel(cause).catch(() => {}); }
        },
        async cancel(reason) { removeBodyListener(); await body.cancel(reason).catch(() => {}); },
      }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
    };
    stream = new SabrStream({
      serverAbrStreamingUrl: context.serverAbrStreamingUrl,
      videoPlaybackUstreamerConfig: context.videoPlaybackUstreamerConfig,
      clientInfo: context.clientInfo,
      ...(context.poToken ? { poToken: context.poToken } : {}),
      durationMs: source.durationSeconds * 1_000, formats, fetch: fetchWithBackpressure,
    });
    stream.on('formatInitialization', ({ formatInitializationMetadata }) => {
      const metadata = formatInitializationMetadata;
      const kind = metadata.mimeType?.startsWith('video/') ? 'video' : metadata.mimeType?.startsWith('audio/') ? 'audio' : undefined;
      if (!kind || !metadata.mimeType?.startsWith(`${kind}/mp4`) ||
        (metadata.videoId && metadata.videoId !== source.videoId) ||
        metadata.formatId?.itag !== (kind === 'video' ? video.itag : audio.itag)) {
        fail(new Error('YouTube changed the selected stream format; the download was stopped.'));
      }
    });
    stream.on('reloadPlayerResponse', () => fail(new Error('The YouTube streaming session expired. Refresh the video and retry.')));
    let tokenRefreshes = 0;
    stream.on('streamProtectionStatusUpdate', ({ status }) => {
      if (status !== 2 && status !== 3) return;
      if (minting) return;
      if (!options.onMintPoToken || tokenRefreshes >= 3) {
        fail(new Error('YouTube rejected the playback session. Play the video and retry.'));
        return;
      }
      tokenRefreshes += 1;
      minting = options.onMintPoToken().then((token) => {
        check();
        if (!token.byteLength) throw new Error('The YouTube playback session token is unavailable.');
        refreshedToken = token;
        stream!.setPoToken(bytesToBase64(token));
      }).catch(fail).finally(() => { minting = undefined; });
    });
    activity();
    publish(true);
    const result = await wait(stream.start({
      videoFormat: video.itag, audioFormat: audio.itag, maxRetries: 2,
      stallDetectionMs: options.idleTimeoutMs ?? 45_000,
    }));
    if (result.selectedFormats.videoFormat.itag !== video.itag || result.selectedFormats.audioFormat.itag !== audio.itag) {
      throw new Error('YouTube did not select the requested video and audio quality.');
    }
    const consume = async (kind: TrackKind, input: typeof result.videoStream) => {
      const reader = input.getReader();
      readers.push(reader);
      let initialized = false;
      let mediaSegments = 0;
      const assembler = mp4Segments();
      try {
        while (true) {
          check();
          readerStates[kind] = 'reading';
          notifyDrain();
          const next = await wait(reader.read());
          if (next.done) break;
          readerStates[kind] = 'writing';
          const chunk = new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength);
          const segments = assembler.push(chunk);
          const operation = writeQueue.then(async () => {
            check();
            for (const bytes of segments) {
            const boxes = segmentBoxes(bytes);
            const hasInit = boxes.some((box) => box.type === 'moov');
            if (hasInit) {
              if (initialized) throw new Error(`The YouTube ${kind} initialization changed during download.`);
              await muxer.addSource(kind, bytes, kind === 'video' ? 'vide' : 'soun');
              initialized = true;
            }
            const firstMedia = boxes.find((box) => box.type === 'moof');
            if (firstMedia) {
              if (!initialized) throw new Error(`The YouTube ${kind} initialization segment is missing.`);
              await muxer.appendFragment(bytes.subarray(firstMedia.start), kind);
              mediaSegments += 1;
            } else if (!hasInit && bytes.byteLength) {
              throw new Error('The YouTube response did not contain an MP4 media segment.');
            }
            }
            progress.currentSegmentBytesReceived = (progress.currentSegmentBytesReceived ?? 0) + chunk.byteLength;
            progress.phase = 'downloading';
            publish();
          });
          writeQueue = operation;
          await wait(operation);
        }
        assembler.finish();
        if (!initialized || mediaSegments === 0) throw new Error(`The YouTube ${kind} track is incomplete.`);
        progress.completedSegments += 1;
        publish(true);
      } finally {
        readerStates[kind] = 'done';
        notifyDrain();
      }
    };
    await wait(Promise.all([
      consume('video', result.videoStream), consume('audio', result.audioStream),
    ]));
    check();
    progress.phase = 'finalizing';
    publish(true);
    await wait(muxer.finalize());
    check();
    await wait(destination.close());
    progress.phase = 'completed';
    publish(true);
  } catch (cause) {
    fail(cause);
    await Promise.allSettled(readers.map((reader) => reader.cancel(cause)));
    await destination.abort(cause).catch(() => {});
    throw failure ?? cause;
  } finally {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    stream?.removeAllListeners();
    for (const reader of readers) reader.releaseLock();
  }
}
