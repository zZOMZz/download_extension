import type {
  BinaryWriter,
  FetchBytesCallbacks,
  HlsDownloadProgress,
  HlsNetworkPolicy,
  HlsRequestRetryEvent,
  NetworkResourceKind,
} from '../hls/download-hls';
import { estimateRemainingSeconds, fetchBinaryResource } from '../hls/download-hls';
import { parseSidxResources } from '../mp4/sidx';
import type { Transport } from '../network/transport';
import { NetworkSpeedTracker } from '../network/speed-tracker';
import type { DashMediaSource, DashResource, DashTrack } from '../../shared/media';

export interface ResolvedDashTrack extends DashTrack {
  segments: DashResource[];
}

export interface DashDownloadPlan {
  video: ResolvedDashTrack;
  audio: ResolvedDashTrack;
  totalSegments: number;
}

export interface DashDownloadOptions {
  transport?: Transport;
  signal?: AbortSignal;
  networkPolicy?: HlsNetworkPolicy;
  onProgress?: (progress: HlsDownloadProgress) => void;
  onRequestRetry?: (event: HlsRequestRetryEvent) => void;
  onResourceFallback?: (event: {
    resourceKind: Exclude<NetworkResourceKind, 'text'>;
    failedUrl: string;
    nextUrl: string;
    reason: string;
  }) => void;
}

export interface DashTrackDownloadOptions extends DashDownloadOptions {
  initializationWritten?: boolean;
  startSegmentIndex?: number;
  initialBytesWritten?: number;
  onInitializationComplete?: (bytesWritten: number) => void | Promise<void>;
  onSegmentComplete?: (
    progress: HlsDownloadProgress,
    trackSegmentIndex: number,
  ) => void | Promise<void>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function fetchDashResource(
  resource: DashResource,
  options: DashDownloadOptions,
  resourceKind: Exclude<NetworkResourceKind, 'text'>,
  callbacksForUrl: (url: string) => FetchBytesCallbacks,
): Promise<{ bytes: Uint8Array; url: string }> {
  const urls = [...new Set([resource.url, ...(resource.alternativeUrls ?? [])])];
  let lastCause: unknown;
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]!;
    try {
      const bytes = await fetchBinaryResource(
        url,
        resource.byteRange,
        options.signal,
        options.networkPolicy,
        callbacksForUrl(url),
        resourceKind,
        true,
        options.transport,
      );
      return { bytes, url };
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      lastCause = cause;
      const nextUrl = urls[index + 1];
      if (nextUrl) {
        options.onResourceFallback?.({
          resourceKind,
          failedUrl: url,
          nextUrl,
          reason: errorMessage(cause),
        });
      }
    }
  }
  if (urls.length === 1) throw lastCause;
  throw new Error(
    `All ${urls.length} DASH resource URLs failed. Last error: ${errorMessage(lastCause)}`,
    { cause: lastCause },
  );
}

function preferResourceUrl(resource: DashResource, preferredUrl: string): DashResource {
  const urls = [...new Set([
    resource.url,
    ...(resource.alternativeUrls ?? []),
  ])];
  if (!urls.includes(preferredUrl)) return resource;
  const alternatives = urls.filter((url) => url !== preferredUrl);
  return {
    ...resource,
    url: preferredUrl,
    ...(alternatives.length ? { alternativeUrls: alternatives } : {}),
  };
}

function codecPreference(track: DashTrack): number {
  const codecs = track.codecs?.toLowerCase() ?? '';
  if (track.kind === 'video') {
    if (codecs.includes('avc1') || codecs.includes('avc3')) return 3;
    if (codecs.includes('hev1') || codecs.includes('hvc1')) return 2;
    if (codecs.includes('av01')) return 1;
  } else {
    if (codecs.includes('mp4a')) return 3;
    if (codecs.includes('opus')) return 2;
  }
  return 0;
}

export function preferredDashTrack(
  source: DashMediaSource,
  kind: DashTrack['kind'],
): DashTrack | undefined {
  return [...source.tracks]
    .filter((track) => track.kind === kind)
    .sort((left, right) => {
      if (codecPreference(left) !== codecPreference(right)) {
        return codecPreference(right) - codecPreference(left);
      }
      if (kind === 'video' && (left.height ?? 0) !== (right.height ?? 0)) {
        return (right.height ?? 0) - (left.height ?? 0);
      }
      return (right.bandwidth ?? 0) - (left.bandwidth ?? 0);
    })[0];
}

function validateDashSource(source: DashMediaSource): void {
  if (source.type !== 'static') throw new Error('Live DASH manifests are not supported yet.');
  if (source.hasContentProtection) throw new Error('DRM-protected DASH media is not supported.');
}

async function resolveTrack(
  track: DashTrack,
  options: DashDownloadOptions,
): Promise<ResolvedDashTrack> {
  if (track.segments?.length) return { ...track, segments: track.segments };
  if (!track.index) throw new Error(`The DASH ${track.kind} track has no downloadable segments.`);
  const indexDownload = await fetchDashResource(
    track.index,
    options,
    'initialization-segment',
    (url) => ({
      onRetry: (retry) => options.onRequestRetry?.({
        ...retry,
        resourceKind: 'initialization-segment',
        resourceUrl: url,
      }),
    }),
  );
  const preferredIndex = preferResourceUrl(track.index, indexDownload.url);
  return {
    ...track,
    initialization: preferResourceUrl(track.initialization, indexDownload.url),
    segments: parseSidxResources(indexDownload.bytes, preferredIndex),
  };
}

export async function prepareDashDownload(
  source: DashMediaSource,
  options: DashDownloadOptions = {},
  selection: { video?: DashTrack; audio?: DashTrack } = {},
): Promise<DashDownloadPlan> {
  validateDashSource(source);
  const video = selection.video ?? preferredDashTrack(source, 'video');
  const audio = selection.audio ?? preferredDashTrack(source, 'audio');
  if (!video) throw new Error('The DASH manifest contains no supported video track.');
  if (!audio) throw new Error('The DASH manifest contains no supported audio track.');
  const [resolvedVideo, resolvedAudio] = await Promise.all([
    resolveTrack(video, options),
    resolveTrack(audio, options),
  ]);
  if (!resolvedVideo.segments.length) throw new Error('The selected DASH video track has no media segments.');
  if (!resolvedAudio.segments.length) throw new Error('The selected DASH audio track has no media segments.');
  return {
    video: resolvedVideo,
    audio: resolvedAudio,
    totalSegments: resolvedVideo.segments.length + resolvedAudio.segments.length,
  };
}

export async function downloadDashTrack(
  track: ResolvedDashTrack,
  writer: BinaryWriter,
  options: DashTrackDownloadOptions = {},
): Promise<void> {
  const startSegmentIndex = options.startSegmentIndex ?? 0;
  const initializationWritten = options.initializationWritten ?? false;
  if (!Number.isInteger(startSegmentIndex) || startSegmentIndex < 0 || startSegmentIndex > track.segments.length) {
    throw new Error('The DASH resume segment is outside the selected track.');
  }
  if (startSegmentIndex > 0 && !initializationWritten) {
    throw new Error('A DASH track cannot resume without its initialization segment.');
  }
  let bytesWritten = options.initialBytesWritten ?? 0;
  if (!initializationWritten && bytesWritten !== 0) {
    throw new Error('A DASH track without initialization cannot have committed bytes.');
  }

  const speed = new NetworkSpeedTracker();
  const progress: HlsDownloadProgress = {
    completedSegments: startSegmentIndex,
    totalSegments: track.segments.length,
    bytesWritten,
    networkBytesReceived: 0,
    phase: 'requesting',
  };
  let lastProgressAt = 0;
  const publish = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 200) return;
    const rates = speed.sample();
    progress.currentSpeedBytesPerSecond = ['retrying', 'finalizing', 'completed'].includes(progress.phase ?? '')
      ? 0 : rates.current;
    progress.averageSpeedBytesPerSecond = rates.average;
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
  const download = async (
    resource: DashResource,
    resourceKind: 'initialization-segment' | 'media-segment',
    segment?: number,
  ) => {
    progress.phase = 'requesting';
    progress.currentSegmentBytesReceived = 0;
    delete progress.currentSegmentBytesTotal;
    if (segment !== undefined) progress.currentSegment = segment;
    else delete progress.currentSegment;
    clearRetryProgress();
    publish(true);
    return fetchDashResource(
      resource,
      options,
      resourceKind,
      (url) => ({
        onChunk: ({ chunkBytes, attemptBytesReceived, contentLength }) => {
          const startedReceiving = progress.phase !== 'downloading';
          const firstReceivedBytes = chunkBytes > 0 && (progress.currentSegmentBytesReceived ?? 0) === 0;
          speed.record(chunkBytes);
          progress.phase = 'downloading';
          progress.networkBytesReceived = speed.totalBytes;
          progress.currentSegmentBytesReceived = attemptBytesReceived;
          if (contentLength !== undefined) progress.currentSegmentBytesTotal = contentLength;
          clearRetryProgress();
          publish(startedReceiving || firstReceivedBytes);
        },
        onRetry: (retry) => {
          progress.phase = 'retrying';
          progress.retryAttempt = retry.attempt;
          progress.maxAttempts = retry.maxAttempts;
          progress.retryDelayMs = retry.delayMs;
          progress.retryReason = retry.reason;
          progress.currentSegmentBytesReceived = 0;
          progress.currentSpeedBytesPerSecond = 0;
          delete progress.currentSegmentBytesTotal;
          publish(true);
          options.onRequestRetry?.({
            ...retry,
            resourceKind,
            resourceUrl: url,
            ...(segment === undefined ? {} : { segment }),
          });
        },
      }),
    ).then(({ bytes }) => bytes);
  };

  const progressTimer = setInterval(() => publish(), 500);
  try {
    if (!initializationWritten) {
      const initialization = await download(track.initialization, 'initialization-segment');
      progress.phase = 'processing';
      publish(true);
      await writer.write(initialization);
      bytesWritten += initialization.byteLength;
      progress.bytesWritten = bytesWritten;
      await options.onInitializationComplete?.(bytesWritten);
    }
    for (let index = startSegmentIndex; index < track.segments.length; index += 1) {
      const startedAt = Date.now();
      const bytes = await download(track.segments[index]!, 'media-segment', index + 1);
      progress.phase = 'processing';
      publish(true);
      await writer.write(bytes);
      bytesWritten += bytes.byteLength;
      progress.completedSegments = index + 1;
      progress.bytesWritten = bytesWritten;
      progress.lastSegmentDurationMs = Date.now() - startedAt;
      progress.currentSegmentBytesReceived = progress.currentSegmentBytesTotal ?? bytes.byteLength;
      await options.onSegmentComplete?.({ ...progress }, index);
      publish(true);
    }
    await writer.close();
    progress.phase = 'completed';
    progress.currentSpeedBytesPerSecond = 0;
    delete progress.estimatedSecondsRemaining;
    clearRetryProgress();
    publish(true);
  } catch (cause) {
    await writer.abort(cause);
    throw cause;
  } finally {
    clearInterval(progressTimer);
  }
}

export async function downloadDashPlan(
  plan: DashDownloadPlan,
  writer: BinaryWriter,
  options: DashDownloadOptions = {},
): Promise<void> {
  const speed = new NetworkSpeedTracker();
  let completedSegments = 0;
  let bytesWritten = 0;
  const progress: HlsDownloadProgress = {
    completedSegments: 0,
    totalSegments: plan.totalSegments,
    bytesWritten: 0,
    networkBytesReceived: 0,
    phase: 'requesting',
  };
  let lastProgressAt = 0;
  const publish = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 200) return;
    const rates = speed.sample();
    progress.currentSpeedBytesPerSecond = ['retrying', 'finalizing', 'completed'].includes(progress.phase ?? '')
      ? 0 : rates.current;
    progress.averageSpeedBytesPerSecond = rates.average;
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
  const download = async (
    resource: DashResource,
    resourceKind: 'initialization-segment' | 'media-segment',
    segment?: number,
  ) => {
    progress.phase = 'requesting';
    progress.currentSegmentBytesReceived = 0;
    delete progress.currentSegmentBytesTotal;
    if (segment !== undefined) progress.currentSegment = segment;
    else delete progress.currentSegment;
    clearRetryProgress();
    publish(true);
    return fetchDashResource(
      resource,
      options,
      resourceKind,
      (url) => ({
        onChunk: ({ chunkBytes, attemptBytesReceived, contentLength }) => {
          const startedReceiving = progress.phase !== 'downloading';
          const firstReceivedBytes = chunkBytes > 0 && (progress.currentSegmentBytesReceived ?? 0) === 0;
          speed.record(chunkBytes);
          progress.phase = 'downloading';
          progress.networkBytesReceived = speed.totalBytes;
          progress.currentSegmentBytesReceived = attemptBytesReceived;
          if (contentLength !== undefined) progress.currentSegmentBytesTotal = contentLength;
          clearRetryProgress();
          publish(startedReceiving || firstReceivedBytes);
        },
        onRetry: (retry) => {
          progress.phase = 'retrying';
          progress.retryAttempt = retry.attempt;
          progress.maxAttempts = retry.maxAttempts;
          progress.retryDelayMs = retry.delayMs;
          progress.retryReason = retry.reason;
          progress.currentSegmentBytesReceived = 0;
          progress.currentSpeedBytesPerSecond = 0;
          delete progress.currentSegmentBytesTotal;
          publish(true);
          options.onRequestRetry?.({
            ...retry,
            resourceKind,
            resourceUrl: url,
            ...(segment === undefined ? {} : { segment }),
          });
        },
      }),
    ).then(({ bytes }) => bytes);
  };

  const progressTimer = setInterval(() => publish(), 500);
  try {
    for (const track of [plan.video, plan.audio]) {
      const initialization = await download(track.initialization, 'initialization-segment');
      progress.phase = 'processing';
      publish(true);
      await writer.write(initialization);
      bytesWritten += initialization.byteLength;
      progress.bytesWritten = bytesWritten;
      for (const resource of track.segments) {
        const segmentNumber = completedSegments + 1;
        const startedAt = Date.now();
        const bytes = await download(resource, 'media-segment', segmentNumber);
        progress.phase = 'processing';
        publish(true);
        await writer.write(bytes);
        bytesWritten += bytes.byteLength;
        completedSegments += 1;
        progress.completedSegments = completedSegments;
        progress.bytesWritten = bytesWritten;
        progress.lastSegmentDurationMs = Date.now() - startedAt;
        progress.currentSegmentBytesReceived = progress.currentSegmentBytesTotal ?? bytes.byteLength;
        publish(true);
      }
    }
    progress.phase = 'finalizing';
    publish(true);
    await writer.close();
    progress.phase = 'completed';
    progress.currentSpeedBytesPerSecond = 0;
    delete progress.estimatedSecondsRemaining;
    clearRetryProgress();
    publish(true);
  } catch (cause) {
    await writer.abort(cause);
    throw cause;
  } finally {
    clearInterval(progressTimer);
  }
}
