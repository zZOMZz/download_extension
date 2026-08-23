import type { HlsByteRange, HlsKey, HlsMap, HlsMediaPlaylist } from '~/src/core/protocols/hls';
import type { DownloadTaskProgress } from '~/src/shared/download-task';
import type { NetworkRequestCoordinator } from '~/src/core/network/host-health';
import { resolveHlsAes128Key } from './key-resolver';

export interface BinaryWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface RandomAccessBinaryWriter extends BinaryWriter {
  writeAt(position: number, chunk: Uint8Array): Promise<void>;
}

export type HlsDownloadProgress = DownloadTaskProgress;

export interface HlsNetworkPolicy {
  maxAttempts?: number;
  firstByteTimeoutMs?: number;
  idleTimeoutMs?: number;
  requestCoordinator?: NetworkRequestCoordinator;
}

export interface HlsDownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: HlsDownloadProgress) => void;
  onSegmentComplete?: (progress: HlsDownloadProgress) => void | Promise<void>;
  networkPolicy?: HlsNetworkPolicy;
  loadText?: (url: string, signal?: AbortSignal) => Promise<string>;
  startSegmentIndex?: number;
  initialBytesWritten?: number;
  onRequestRetry?: (event: HlsRequestRetryEvent) => void;
}

export type NetworkResourceKind = 'text' | 'media-segment' | 'encryption-key' | 'initialization-segment';

export class NetworkResourceError extends Error {
  override readonly name = 'NetworkResourceError';

  constructor(
    readonly resourceKind: NetworkResourceKind,
    readonly resourceUrl: string,
    readonly attempts: number,
    readonly recoverable: boolean,
    cause: unknown,
  ) {
    const label: Record<NetworkResourceKind, string> = {
      text: 'text resource',
      'media-segment': 'media segment',
      'encryption-key': 'encryption key',
      'initialization-segment': 'initialization segment',
    };
    const suffix = cause instanceof Error ? cause.message : String(cause);
    let displayUrl = resourceUrl;
    try {
      const parsed = new URL(resourceUrl);
      displayUrl = `${parsed.hostname}${parsed.pathname}`;
    } catch {
      // Keep the original URL when it is not parseable.
    }
    super(
      `Failed to download a ${label[resourceKind]} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${suffix} (${displayUrl})`,
      { cause },
    );
  }
}

export function isRecoverableNetworkError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof NetworkResourceError) return current.recoverable;
    current = current.cause;
  }
  return false;
}

interface ResolvedNetworkPolicy {
  maxAttempts: number;
  firstByteTimeoutMs: number;
  idleTimeoutMs: number;
  requestCoordinator?: NetworkRequestCoordinator;
}

export interface FetchChunkEvent {
  chunkBytes: number;
  attemptBytesReceived: number;
  contentLength?: number;
}

export interface NetworkRetryEvent {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export interface HlsRequestRetryEvent extends NetworkRetryEvent {
  resourceKind: Exclude<NetworkResourceKind, 'text'>;
  resourceUrl: string;
  segment?: number;
}

export interface FetchBytesCallbacks {
  onChunk?: (event: FetchChunkEvent) => void;
  onRetry?: (event: NetworkRetryEvent) => void;
}

const DEFAULT_NETWORK_POLICY: ResolvedNetworkPolicy = {
  maxAttempts: 4,
  firstByteTimeoutMs: 15_000,
  idleTimeoutMs: 20_000,
};

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | undefined,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
  }
}

export class NetworkTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkTimeoutError';
  }
}

function rangeHeader(range: HlsByteRange): HeadersInit {
  return { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` };
}

function networkPolicy(options: HlsNetworkPolicy | undefined): ResolvedNetworkPolicy {
  return {
    maxAttempts: Math.max(1, Math.floor(options?.maxAttempts ?? DEFAULT_NETWORK_POLICY.maxAttempts)),
    firstByteTimeoutMs: Math.max(1, options?.firstByteTimeoutMs ?? DEFAULT_NETWORK_POLICY.firstByteTimeoutMs),
    idleTimeoutMs: Math.max(1, options?.idleTimeoutMs ?? DEFAULT_NETWORK_POLICY.idleTimeoutMs),
    ...(options?.requestCoordinator ? { requestCoordinator: options.requestCoordinator } : {}),
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The download was cancelled.', 'AbortError');
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(Math.max(0, date - Date.now()), 60_000);
}

function shouldRetry(error: unknown): boolean {
  if (!(error instanceof HttpStatusError)) return true;
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

function retryDelay(error: unknown, completedAttempts: number): number {
  if (error instanceof HttpStatusError && error.retryAfterMs !== undefined) return error.retryAfterMs;
  return [1_000, 3_000, 10_000, 20_000, 40_000, 60_000][Math.min(completedAttempts - 1, 5)]!;
}

function isTaskRecoverable(error: unknown): boolean {
  if (!(error instanceof HttpStatusError)) return true;
  return error.status === 401 || error.status === 403 || shouldRetry(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal ? abortReason(signal) : new DOMException('The download was cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => NetworkTimeoutError,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = createError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readResponseBytes(
  response: Response,
  policy: ResolvedNetworkPolicy,
  controller: AbortController,
  onChunk: FetchBytesCallbacks['onChunk'],
): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get('Content-Length');
  const contentLengthValue = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  const contentLength = contentLengthValue !== undefined && Number.isFinite(contentLengthValue) && contentLengthValue >= 0
    ? contentLengthValue
    : undefined;
  if (!response.body) {
    const buffer = await withTimeout(
      response.arrayBuffer(),
      policy.idleTimeoutMs,
      () => new NetworkTimeoutError(`The response body did not finish within ${Math.round(policy.idleTimeoutMs / 1_000)} seconds.`),
      controller,
    );
    const bytes = new Uint8Array(buffer);
    onChunk?.({
      chunkBytes: bytes.byteLength,
      attemptBytesReceived: bytes.byteLength,
      ...(contentLength !== undefined ? { contentLength } : {}),
    });
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const reportIdle = () => onChunk?.({
      chunkBytes: 0,
      attemptBytesReceived: received,
      ...(contentLength !== undefined ? { contentLength } : {}),
    });
    const idleReporter = setInterval(reportIdle, 500);
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await withTimeout(
        reader.read(),
        policy.idleTimeoutMs,
        () => new NetworkTimeoutError(`No response data was received for ${Math.round(policy.idleTimeoutMs / 1_000)} seconds.`),
        controller,
      );
    } finally {
      clearInterval(idleReporter);
    }
    if (result.done) break;
    chunks.push(result.value);
    received += result.value.byteLength;
    onChunk?.({
      chunkBytes: result.value.byteLength,
      attemptBytesReceived: received,
      ...(contentLength !== undefined ? { contentLength } : {}),
    });
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchBytes(
  url: string,
  range: HlsByteRange | undefined,
  signal: AbortSignal | undefined,
  policy: ResolvedNetworkPolicy,
  callbacks: FetchBytesCallbacks = {},
  resourceKind: Exclude<NetworkResourceKind, 'text'> = 'media-segment',
  requireExactRange = false,
): Promise<Uint8Array> {
  let lastError: unknown;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal ? abortReason(signal) : undefined);
    if (signal?.aborted) throw abortReason(signal);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const request = async () => {
        const response = await withTimeout(
          fetch(url, {
            credentials: 'include',
            ...(range ? { headers: rangeHeader(range) } : {}),
            signal: controller.signal,
          }),
          policy.firstByteTimeoutMs,
          () => new NetworkTimeoutError(`The server did not respond within ${Math.round(policy.firstByteTimeoutMs / 1_000)} seconds.`),
          controller,
        );
        if (!response.ok) {
          throw new HttpStatusError(response.status, parseRetryAfter(response.headers.get('Retry-After')));
        }
        if (range && requireExactRange) {
          const contentRange = response.headers.get('Content-Range');
          const expectedEnd = range.offset + range.length - 1;
          const match = contentRange ? /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(contentRange) : null;
          if (response.status !== 206 || !match || Number(match[1]) !== range.offset || Number(match[2]) !== expectedEnd) {
            await response.body?.cancel();
            throw new Error(`The server did not honor the requested byte range ${range.offset}-${expectedEnd}.`);
          }
        }
        let bytes = await readResponseBytes(response, policy, controller, callbacks.onChunk);
        if (range && response.status === 200) {
          bytes = bytes.slice(range.offset, range.offset + range.length);
        }
        if (range && bytes.byteLength !== range.length) {
          throw new Error(`Expected ${range.length} bytes but received ${bytes.byteLength}.`);
        }
        return bytes;
      };
      return await (policy.requestCoordinator
        ? policy.requestCoordinator.run(url, request, signal)
        : request());
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      lastError = error;
      if (attempt >= policy.maxAttempts || !shouldRetry(error)) break;
      const delayMs = retryDelay(error, attempt);
      callbacks.onRetry?.({
        attempt: attempt + 1,
        maxAttempts: policy.maxAttempts,
        delayMs,
        reason: errorMessage(error),
      });
      await waitForRetry(delayMs, signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new NetworkResourceError(
    resourceKind,
    url,
    attemptsUsed,
    isTaskRecoverable(lastError),
    lastError,
  );
}

export async function fetchBinaryResource(
  url: string,
  range?: HlsByteRange,
  signal?: AbortSignal,
  policyOptions?: HlsNetworkPolicy,
  callbacks: FetchBytesCallbacks = {},
  resourceKind: Exclude<NetworkResourceKind, 'text'> = 'media-segment',
  requireExactRange = false,
): Promise<Uint8Array> {
  return fetchBytes(url, range, signal, networkPolicy(policyOptions), callbacks, resourceKind, requireExactRange);
}

export async function fetchTextResource(
  url: string,
  signal?: AbortSignal,
  policyOptions?: HlsNetworkPolicy,
  callbacks: { onRetry?: (event: NetworkRetryEvent) => void } = {},
): Promise<string> {
  const policy = networkPolicy(policyOptions);
  let lastError: unknown;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal ? abortReason(signal) : undefined);
    if (signal?.aborted) throw abortReason(signal);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const request = async () => {
        const response = await withTimeout(
          fetch(url, { credentials: 'include', signal: controller.signal }),
          policy.firstByteTimeoutMs,
          () => new NetworkTimeoutError(`The server did not respond within ${Math.round(policy.firstByteTimeoutMs / 1_000)} seconds.`),
          controller,
        );
        if (!response.ok) {
          throw new HttpStatusError(response.status, parseRetryAfter(response.headers.get('Retry-After')));
        }
        return withTimeout(
          response.text(),
          policy.idleTimeoutMs,
          () => new NetworkTimeoutError(`The text response did not finish within ${Math.round(policy.idleTimeoutMs / 1_000)} seconds.`),
          controller,
        );
      };
      return await (policy.requestCoordinator
        ? policy.requestCoordinator.run(url, request, signal)
        : request());
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      lastError = error;
      if (attempt >= policy.maxAttempts || !shouldRetry(error)) break;
      const delayMs = retryDelay(error, attempt);
      callbacks.onRetry?.({
        attempt: attempt + 1,
        maxAttempts: policy.maxAttempts,
        delayMs,
        reason: errorMessage(error),
      });
      await waitForRetry(delayMs, signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new NetworkResourceError('text', url, attemptsUsed, isTaskRecoverable(lastError), lastError);
}

class NetworkSpeedTracker {
  private readonly startedAt = Date.now();
  private readonly samples: Array<{ at: number; bytes: number }> = [{ at: this.startedAt, bytes: 0 }];
  totalBytes = 0;

  record(byteLength: number): { current: number; average: number } {
    const now = Date.now();
    this.totalBytes += byteLength;
    this.samples.push({ at: now, bytes: this.totalBytes });
    const cutoff = now - 5_000;
    while (this.samples.length > 2 && this.samples[1]!.at < cutoff) this.samples.shift();
    const oldest = this.samples[0]!;
    return {
      current: (this.totalBytes - oldest.bytes) * 1_000 / Math.max(1, now - oldest.at),
      average: this.totalBytes * 1_000 / Math.max(1, now - this.startedAt),
    };
  }
}

export function estimateRemainingSeconds(progress: HlsDownloadProgress): number | undefined {
  const speed = progress.currentSpeedBytesPerSecond || progress.averageSpeedBytesPerSecond;
  if (!speed) return undefined;

  let remainingBytes: number | undefined;
  if (progress.completedSegments > 0) {
    const averageSegmentBytes = progress.bytesWritten / progress.completedSegments;
    remainingBytes = averageSegmentBytes * (progress.totalSegments - progress.completedSegments);
    remainingBytes = Math.max(0, remainingBytes - (progress.currentSegmentBytesReceived ?? 0));
  } else if (progress.currentSegmentBytesTotal !== undefined && progress.currentSegment !== undefined) {
    remainingBytes = Math.max(0, progress.currentSegmentBytesTotal - (progress.currentSegmentBytesReceived ?? 0));
    remainingBytes += progress.currentSegmentBytesTotal * (progress.totalSegments - progress.currentSegment);
  }
  return remainingBytes === undefined ? undefined : remainingBytes / speed;
}

function ivFromSequence(sequence: number): Uint8Array {
  let value = BigInt(sequence);
  const iv = new Uint8Array(16);
  for (let index = 15; index >= 0; index -= 1) {
    iv[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return iv;
}

function parseIv(value: string): Uint8Array {
  const normalized = value.toLowerCase().startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length > 32) {
    throw new Error('The HLS playlist contains an invalid AES initialization vector.');
  }
  const padded = normalized.padStart(32, '0');
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16),
  );
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function decryptAes128(
  encrypted: Uint8Array,
  keyBytes: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  if (keyBytes.byteLength !== 16) throw new Error('An HLS AES-128 key must contain exactly 16 bytes.');
  const key = await crypto.subtle.importKey('raw', arrayBufferOf(keyBytes), 'AES-CBC', false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: arrayBufferOf(iv) },
    key,
    arrayBufferOf(encrypted),
  );
  return new Uint8Array(decrypted);
}

function validateKey(key: HlsKey): asserts key is HlsKey & { uri: string } {
  if (key.method !== 'AES-128' || key.keyFormat.toLowerCase() !== 'identity') {
    throw new Error(`Unsupported or protected HLS encryption: ${key.method}/${key.keyFormat}`);
  }
  if (!key.uri) throw new Error('The HLS encryption key has no URI.');
}

export function validateHlsDownload(playlist: HlsMediaPlaylist): string[] {
  const problems: string[] = [];
  if (!playlist.endList) problems.push('Live playlists are not supported yet.');
  if (playlist.segments.some((segment) => segment.discontinuity)) {
    problems.push('This playlist contains discontinuities and needs a remuxing backend.');
  }
  for (const segment of playlist.segments) {
    if (segment.key) {
      if (segment.key.method !== 'AES-128' || segment.key.keyFormat.toLowerCase() !== 'identity') {
        problems.push(`Unsupported or protected encryption: ${segment.key.method}/${segment.key.keyFormat}.`);
        break;
      }
      if (!segment.key.uri) {
        problems.push('An encrypted segment is missing its key URI.');
        break;
      }
    }
    if (segment.map?.key && !segment.map.key.iv) {
      problems.push('An encrypted initialization segment must specify an explicit IV.');
      break;
    }
  }
  return [...new Set(problems)];
}

export async function downloadHlsPlaylist(
  playlist: HlsMediaPlaylist,
  writer: BinaryWriter,
  options: HlsDownloadOptions = {},
): Promise<void> {
  const problems = validateHlsDownload(playlist);
  if (problems.length > 0) throw new Error(problems.join(' '));

  const policy = networkPolicy(options.networkPolicy);
  const startSegmentIndex = options.startSegmentIndex ?? 0;
  const initialBytesWritten = options.initialBytesWritten ?? 0;
  if (!Number.isInteger(startSegmentIndex) || startSegmentIndex < 0 || startSegmentIndex > playlist.segments.length) {
    throw new Error('The HLS resume segment index is invalid.');
  }
  if (!Number.isInteger(initialBytesWritten) || initialBytesWritten < 0) {
    throw new Error('The HLS resume byte position is invalid.');
  }
  const keyCache = new Map<string, Promise<Uint8Array>>();
  const speedTracker = new NetworkSpeedTracker();
  let currentMapIdentity = '';
  let bytesWritten = initialBytesWritten;
  let lastProgressAt = 0;
  const progress: HlsDownloadProgress = {
    completedSegments: startSegmentIndex,
    totalSegments: playlist.segments.length,
    bytesWritten,
    phase: 'requesting',
    networkBytesReceived: 0,
  };

  const publishProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 200) return;
    const estimate = estimateRemainingSeconds(progress);
    if (estimate === undefined || !Number.isFinite(estimate)) delete progress.estimatedSecondsRemaining;
    else progress.estimatedSecondsRemaining = estimate;
    lastProgressAt = now;
    options.onProgress?.({ ...progress });
  };

  const clearRetryProgress = () => {
    delete progress.retryAttempt;
    delete progress.maxAttempts;
    delete progress.retryDelayMs;
    delete progress.retryReason;
  };

  const keyBytes = (key: HlsKey): Promise<Uint8Array> => {
    validateKey(key);
    const existing = keyCache.get(key.uri);
    if (existing) return existing;
    const request = fetchBytes(key.uri, undefined, options.signal, policy, {
      onRetry: (retry) => options.onRequestRetry?.({
        ...retry,
        resourceKind: 'encryption-key',
        resourceUrl: key.uri,
      }),
    }, 'encryption-key').then((downloadedBytes) =>
      resolveHlsAes128Key({
        downloadedBytes,
        keyUri: key.uri,
        loadText: options.loadText ?? ((url, signal) => fetchTextResource(url, signal, policy)),
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
    keyCache.set(key.uri, request);
    return request;
  };

  const decryptIfNeeded = async (
    bytes: Uint8Array,
    key: HlsKey | undefined,
    sequence: number,
    requireExplicitIv = false,
  ): Promise<Uint8Array> => {
    if (!key) return bytes;
    validateKey(key);
    if (requireExplicitIv && !key.iv) {
      throw new Error('An encrypted initialization segment requires an explicit IV.');
    }
    const iv = key.iv ? parseIv(key.iv) : ivFromSequence(sequence);
    return decryptAes128(bytes, await keyBytes(key), iv);
  };

  const writeMap = async (map: HlsMap, sequence: number, streamRole = ''): Promise<void> => {
    const identity = `${streamRole}|${map.uri}|${map.byteRange?.offset ?? ''}|${map.byteRange?.length ?? ''}|${map.key?.uri ?? ''}|${map.key?.iv ?? ''}`;
    if (identity === currentMapIdentity) return;
    let bytes = await fetchBytes(map.uri, map.byteRange, options.signal, policy, {
      onRetry: (retry) => options.onRequestRetry?.({
        ...retry,
        resourceKind: 'initialization-segment',
        resourceUrl: map.uri,
      }),
    }, 'initialization-segment');
    bytes = await decryptIfNeeded(bytes, map.key, sequence, true);
    await writer.write(bytes);
    bytesWritten += bytes.byteLength;
    currentMapIdentity = identity;
  };

  try {
    for (let index = startSegmentIndex; index < playlist.segments.length; index += 1) {
      const segment = playlist.segments[index]!;
      if (options.signal?.aborted) throw abortReason(options.signal);
      const segmentStartedAt = Date.now();
      progress.currentSegment = index + 1;
      progress.currentSegmentBytesReceived = 0;
      delete progress.currentSegmentBytesTotal;
      progress.currentSpeedBytesPerSecond = 0;
      progress.phase = 'requesting';
      clearRetryProgress();
      publishProgress(true);
      if (segment.map) await writeMap(segment.map, segment.sequence, segment.streamRole);

      let bytes = await fetchBytes(segment.uri, segment.byteRange, options.signal, policy, {
        onChunk: ({ chunkBytes, attemptBytesReceived, contentLength }) => {
          const firstReceivedBytes = chunkBytes > 0 && (progress.currentSegmentBytesReceived ?? 0) === 0;
          const startedReceiving = progress.phase !== 'downloading';
          const speed = speedTracker.record(chunkBytes);
          progress.phase = 'downloading';
          progress.networkBytesReceived = speedTracker.totalBytes;
          progress.currentSegmentBytesReceived = attemptBytesReceived;
          if (contentLength !== undefined) progress.currentSegmentBytesTotal = contentLength;
          progress.currentSpeedBytesPerSecond = speed.current;
          progress.averageSpeedBytesPerSecond = speed.average;
          clearRetryProgress();
          publishProgress(firstReceivedBytes || startedReceiving);
        },
        onRetry: ({ attempt, maxAttempts, delayMs, reason }) => {
          progress.phase = 'retrying';
          progress.retryAttempt = attempt;
          progress.maxAttempts = maxAttempts;
          progress.retryDelayMs = delayMs;
          progress.retryReason = reason;
          progress.currentSegmentBytesReceived = 0;
          progress.currentSpeedBytesPerSecond = 0;
          delete progress.currentSegmentBytesTotal;
          publishProgress(true);
          options.onRequestRetry?.({
            attempt,
            maxAttempts,
            delayMs,
            reason,
            resourceKind: 'media-segment',
            resourceUrl: segment.uri,
            segment: index + 1,
          });
        },
      });
      progress.phase = 'decrypting';
      progress.currentSpeedBytesPerSecond = 0;
      clearRetryProgress();
      publishProgress(true);
      bytes = await decryptIfNeeded(bytes, segment.key, segment.sequence);
      progress.phase = 'processing';
      publishProgress(true);
      await writer.write(bytes);
      bytesWritten += bytes.byteLength;
      progress.completedSegments = index + 1;
      progress.bytesWritten = bytesWritten;
      progress.lastSegmentDurationMs = Date.now() - segmentStartedAt;
      progress.currentSegmentBytesReceived = progress.currentSegmentBytesTotal ?? bytes.byteLength;
      await options.onSegmentComplete?.({ ...progress });
      publishProgress(true);
    }
    await writer.close();
    progress.phase = 'completed';
    progress.currentSpeedBytesPerSecond = 0;
    delete progress.estimatedSecondsRemaining;
    clearRetryProgress();
    publishProgress(true);
  } catch (error) {
    await writer.abort(error);
    throw error;
  }
}
