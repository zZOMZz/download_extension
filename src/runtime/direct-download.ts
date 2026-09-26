import type { DashMediaSource, YouTubeSabrSource } from '../shared/media';
import type { OutputFormat } from '../shared/settings';
import { downloadDashPlan, preferredDashTrack, prepareDashDownload } from '../core/dash/download-dash';
import { downloadProgressiveMedia } from '../core/progressive/download-progressive';
import { downloadYouTubeSabr, type YouTubeSabrDownloadContext } from '../core/site-adapters/youtube/download-sabr';
import {
  downloadHlsPlaylist, fetchTextResource, validateHlsDownload,
  type HlsDownloadProgress, type HlsNetworkPolicy, type RandomAccessBinaryWriter,
} from '../core/hls/download-hls';
import type { InspectedHls } from '../core/hls/inspect-hls';
import { combinedHlsMediaPlaylist, hlsPlaylistUsesFmp4 } from '../core/hls/media-bundle';
import { createHlsOutputPlan } from '../core/hls/output-plan';
import { safeFilename } from '../core/format';
import { browserTransport, type Transport } from '../core/network/transport';
import {
  validateMediaOutput, type OutputValidationOptions, type OutputValidationResult, type RandomAccessMedia,
} from '../core/media/output-validator';
import type { TransformBackend } from './transform-backend';
import { RuntimeError } from './errors';

export type DirectMediaSelection =
  | { kind: 'hls'; hls: InspectedHls; outputFormat: OutputFormat }
  | { kind: 'dash'; source: DashMediaSource; videoTrackId?: string; audioTrackId?: string }
  | { kind: 'progressive'; url: string; contentLength?: number }
  | { kind: 'sabr'; source: YouTubeSabrSource; videoItag: number; audioItag: number };

export type DirectDownloadRequest = Exclude<DirectMediaSelection, { kind: 'sabr' }>
  | Extract<DirectMediaSelection, { kind: 'sabr' }> & { context: YouTubeSabrDownloadContext };

/** A one-shot user-selected output, deliberately without persistent checkpoints or resume. */
export interface DirectOutputTarget {
  readonly resumable: false;
  readonly writer: RandomAccessBinaryWriter;
  /** Available after writer.close(); validation uses bounded reads. */
  read(): Promise<RandomAccessMedia | null>;
  /** Publish the validated output and await host-confirmed completion. */
  finish(signal?: AbortSignal): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface DirectDownloadOptions {
  transforms: TransformBackend;
  transport?: Transport;
  networkPolicy?: HlsNetworkPolicy;
  loadText?: (url: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  onProgress?: (progress: HlsDownloadProgress) => void;
}

export interface DirectOutputDescription {
  filename: string;
  mimeType: string;
  extension: 'mp4' | 'ts';
  allowMemoryFallback: boolean;
}

/** Synchronous metadata lets a host open its picker during the original user gesture. */
export function describeDirectOutput(selection: DirectMediaSelection, title = 'video'): DirectOutputDescription {
  const base = safeFilename(title);
  if (selection.kind === 'hls') {
    const plan = createHlsOutputPlan(selection.hls, selection.outputFormat);
    const height = selection.hls.selectedVariant?.resolution?.height;
    return {
      filename: `${base}${height ? `-${height}p` : ''}.${plan.extension}`,
      mimeType: plan.mimeType, extension: plan.extension, allowMemoryFallback: true,
    };
  }
  const height = selection.kind === 'dash'
    ? (selection.source.tracks.find((track) => track.kind === 'video' && track.id === selection.videoTrackId)
      ?? preferredDashTrack(selection.source, 'video'))?.height
    : selection.kind === 'sabr' ? selection.source.formats.find((format) => format.itag === selection.videoItag)?.height
    : undefined;
  return {
    filename: `${base}${height ? `-${height}p` : ''}.mp4`, mimeType: 'video/mp4', extension: 'mp4',
    allowMemoryFallback: selection.kind === 'dash',
  };
}

/** Protocol engines own bytes; this runtime owns validation and the final success event. */
export async function executeDirectDownload(
  request: DirectDownloadRequest,
  target: DirectOutputTarget,
  options: DirectDownloadOptions,
): Promise<OutputValidationResult> {
  const transport = options.transport ?? browserTransport;
  const loadText = options.loadText ?? ((url: string, signal?: AbortSignal) =>
    fetchTextResource(url, signal, options.networkPolicy, {}, transport));
  let latest: HlsDownloadProgress = { completedSegments: 0, totalSegments: 1, bytesWritten: 0, phase: 'requesting' };
  const onProgress = (progress: HlsDownloadProgress) => {
    latest = { ...progress, phase: progress.phase === 'completed' ? 'finalizing' : progress.phase ?? 'downloading' };
    options.onProgress?.(latest);
  };
  let closePromise: Promise<void> | undefined;
  const writer: RandomAccessBinaryWriter = {
    write: (chunk) => target.writer.write(chunk),
    writeAt: (offset, chunk) => target.writer.writeAt(offset, chunk),
    close: () => closePromise ??= target.writer.close(),
    abort: (reason) => target.writer.abort(reason),
  };
  const common = {
    transport,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.networkPolicy ? { networkPolicy: options.networkPolicy } : {}),
    onProgress,
  };
  let validationOptions: OutputValidationOptions = { format: 'mp4', requireVideo: true };
  try {
    options.signal?.throwIfAborted();
    onProgress(latest);
    if (request.kind === 'hls') {
      const hls = request.hls;
      const problems = [...validateHlsDownload(hls.media), ...(hls.audioMedia ? validateHlsDownload(hls.audioMedia) : [])];
      if (problems.length) throw new Error(problems.join(' '));
      if (hls.audioMedia && request.outputFormat !== 'mp4') throw new RuntimeError('separateAudioRequiresMp4');
      if (hls.audioMedia && hlsPlaylistUsesFmp4(hls.media) !== hlsPlaylistUsesFmp4(hls.audioMedia)) {
        throw new RuntimeError('mixedSeparateTrackContainers');
      }
      const plan = createHlsOutputPlan(hls, request.outputFormat);
      await downloadHlsPlaylist(combinedHlsMediaPlaylist(hls), options.transforms.createHlsWriter(writer, plan), {
        ...common, loadText,
      });
      validationOptions = {
        format: plan.extension, requireVideo: true,
        ...(plan.extension === 'ts' ? { expectedBytes: latest.bytesWritten } : {}),
      };
    } else if (request.kind === 'dash') {
      const video = request.source.tracks.find((track) => track.kind === 'video' && track.id === request.videoTrackId);
      const audio = request.source.tracks.find((track) => track.kind === 'audio' && track.id === request.audioTrackId);
      const plan = await prepareDashDownload(request.source, common, {
        ...(video ? { video } : {}), ...(audio ? { audio } : {}),
      });
      await downloadDashPlan(plan, options.transforms.createDashWriter(
        writer, plan.video.segments.length, plan.audio.segments.length,
      ), common);
    } else if (request.kind === 'progressive') {
      await downloadProgressiveMedia(request.url, writer, {
        ...common, ...(request.contentLength === undefined ? {} : { contentLength: request.contentLength }),
      });
      validationOptions.expectedBytes = latest.bytesWritten;
    } else {
      await downloadYouTubeSabr(request.source, request.context, writer, {
        transport,
        videoItag: request.videoItag, audioItag: request.audioItag,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.networkPolicy?.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.networkPolicy.idleTimeoutMs }),
        onProgress,
      });
    }
    options.signal?.throwIfAborted();
    await writer.close();
    onProgress({ ...latest, phase: 'finalizing' });
    const validation = await validateMediaOutput(await target.read(), validationOptions);
    options.signal?.throwIfAborted();
    await target.finish(options.signal);
    options.signal?.throwIfAborted();
    options.onProgress?.({
      ...latest, completedSegments: latest.totalSegments, bytesWritten: validation.size,
      phase: 'completed', currentSpeedBytesPerSecond: 0,
    });
    return validation;
  } catch (cause) {
    await target.abort(cause).catch(() => {});
    throw cause;
  }
}
