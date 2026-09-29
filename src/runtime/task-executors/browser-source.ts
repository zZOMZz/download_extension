import type { BrowserSourceCheckpoint, DownloadTask } from '../../shared/download-task';
import type { BrowserSourcePlan, ProcessedSegment } from '../../shared/browser-source';
import { SOURCE_CHUNK_BYTES } from '../../shared/browser-source';
import type { RandomAccessBinaryWriter } from '../../core/hls/download-hls';
import { safeFilename } from '../../core/format';
import { FlatMp4Muxer } from '../../core/mp4/flat-mp4-muxer';
import { NetworkSpeedTracker } from '../../core/network/speed-tracker';
import { readMediaArtifact } from '../artifact-store';
import type { MediaSourceSession } from '../media-source';
import { RuntimeError } from '../errors';
import type { ProtocolTaskExecutor, TaskExecutorContext, TaskExecutorResult } from './types';

const KINDS = ['video', 'audio'] as const;
const COMMIT_SEGMENTS = 4;

function filenameFor(task: DownloadTask): string {
  return `${safeFilename([task.source.seriesTitle, task.source.title].filter(Boolean).join(' - '))}.mp4`;
}

function validateCheckpoint(task: DownloadTask, checkpoint: BrowserSourceCheckpoint): void {
  const filename = filenameFor(task);
  if (checkpoint.finalFilename !== filename || checkpoint.completedSegments > checkpoint.totalSegments ||
      checkpoint.bytesWritten !== checkpoint.tracks.audio.bytesWritten + checkpoint.tracks.video.bytesWritten) throw new RuntimeError('browserSourcePlanChanged');
  for (const kind of KINDS) {
    const track = checkpoint.tracks[kind];
    if (track.partialFilename !== `${filename.slice(0, -4)}.${kind}.source.part.m4s` || track.trackId !== kind ||
        track.completedSegments !== checkpoint.completedSegments || track.totalSegments !== checkpoint.totalSegments ||
        track.segmentEndOffsets.length !== checkpoint.completedSegments || track.bytesWritten < track.initializationBytes ||
        (checkpoint.completedSegments > 0 && (!track.initializationBytes || !Number.isFinite(track.firstStartDTS) || !Number.isFinite(track.lastEndDTS)))) {
      throw new RuntimeError('browserSourcePlanChanged');
    }
    let end = track.initializationBytes;
    for (const offset of track.segmentEndOffsets) {
      if (offset <= end || offset - end > 64 * 1024 * 1024) throw new RuntimeError('browserSourcePlanChanged');
      end = offset;
    }
    if (end !== track.bytesWritten) throw new RuntimeError('browserSourcePlanChanged');
  }
}

function checkpointFor(context: TaskExecutorContext, plan: BrowserSourcePlan, first: ProcessedSegment): BrowserSourceCheckpoint {
  const source = context.media.browserSource!;
  const filename = filenameFor(context.task);
  const track = (kind: 'audio' | 'video') => ({ trackId: kind, fingerprint: first.tracks[kind].initializationHash,
    partialFilename: `${filename.slice(0, -4)}.${kind}.source.part.m4s`, initializationBytes: 0,
    completedSegments: 0, totalSegments: plan.segments.length, bytesWritten: 0, segmentEndOffsets: [] as number[] });
  return { version: 3, protocol: 'browser-source', providerId: source.providerId, mediaId: source.mediaId,
    planFingerprint: plan.fingerprint, durationSeconds: plan.durationSeconds,
    directoryName: context.artifacts.name, ...(context.artifacts.id ? { directoryHandleId: context.artifacts.id } : {}),
    finalFilename: filename, completedSegments: 0, totalSegments: plan.segments.length, bytesWritten: 0,
    tracks: { video: track('video'), audio: track('audio') }, updatedAt: Date.now() };
}

async function finalize(context: TaskExecutorContext, checkpoint: BrowserSourceCheckpoint): Promise<TaskExecutorResult> {
  const destination = await context.artifacts.open(checkpoint.finalFilename);
  const muxer = new FlatMp4Muxer(destination);
  try {
    for (const kind of KINDS) {
      const track = checkpoint.tracks[kind];
      const file = await readMediaArtifact(context.artifacts, track.partialFilename);
      if (!file || file.size < track.bytesWritten || !track.initializationBytes || track.segmentEndOffsets.length !== checkpoint.totalSegments) throw new RuntimeError('partialMissingOrShort');
      await muxer.addSource(kind, await file.read(0, track.initializationBytes), kind === 'video' ? 'vide' : 'soun');
      let start = track.initializationBytes;
      for (const end of track.segmentEndOffsets) {
        context.signal.throwIfAborted();
        if (end <= start || end - start > 64 * 1024 * 1024) throw new RuntimeError('browserSourceIncomplete');
        await muxer.appendFragment(await file.read(start, end - start), kind); start = end;
        context.onProgress({ completedSegments: checkpoint.totalSegments, totalSegments: checkpoint.totalSegments,
          bytesWritten: checkpoint.bytesWritten, phase: 'finalizing' });
      }
    }
    await muxer.finalize(); await destination.close();
  } catch (cause) { await destination.abort(cause); throw cause; }
  return { finalFilename: checkpoint.finalFilename,
    validationOptions: { format: 'mp4', requireVideo: true, expectedDurationSeconds: checkpoint.durationSeconds, durationToleranceSeconds: 1 },
    partialOutputsToRemove: KINDS.map(kind => checkpoint.tracks[kind].partialFilename) };
}

export const browserSourceTaskExecutor: ProtocolTaskExecutor = {
  kind: 'hls', mode: 'browser-session',
  async execute(context) {
    const source = context.media.browserSource;
    if (!source) throw new RuntimeError('browserSourceUnsupported');
    if (context.task.checkpoint && context.task.checkpoint.version !== 3) throw new RuntimeError('browserSourcePlanChanged');
    let task: DownloadTask = context.task;
    let checkpoint = task.checkpoint?.version === 3 ? structuredClone(task.checkpoint) : undefined;
    if (checkpoint) validateCheckpoint(task, checkpoint);
    if (checkpoint && (checkpoint.mediaId !== source.mediaId || checkpoint.providerId !== source.providerId)) throw new RuntimeError('browserSourcePlanChanged');
    if (checkpoint && checkpoint.completedSegments === checkpoint.totalSegments) return finalize(context, checkpoint);
    if (!context.mediaSourceProvider) throw new RuntimeError('browserSourceUnavailable');
    const speed = new NetworkSpeedTracker();
    let refreshes = 0;
    while (true) {
      let session: MediaSourceSession | undefined;
      const writers: Partial<Record<'audio' | 'video', RandomAccessBinaryWriter>> = {};
      const closeWriters = async (reason?: unknown) => {
        const results = await Promise.allSettled(KINDS.map(async kind => {
          const writer = writers[kind]; delete writers[kind];
          if (writer) { if (reason) await writer.abort(reason); else await writer.close(); }
        }));
        if (!reason) { const failure = results.find(item => item.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason; }
      };
      try {
        session = await context.mediaSourceProvider.open(source, checkpoint?.completedSegments ?? 0, context.signal, { fresh: refreshes > 0 });
        const plan = session.plan;
        if (checkpoint && (checkpoint.planFingerprint !== plan.fingerprint || checkpoint.totalSegments !== plan.segments.length)) throw new RuntimeError('browserSourcePlanChanged');
        task = await context.persistTask({ ...task, status: 'downloading', outputFormat: 'mp4' });
        await context.recordTaskEvent(refreshes ? 'source-refreshed' : 'manifest-loaded', 'info', {
          protocol: 'hls', totalSegments: plan.segments.length, durationSeconds: plan.durationSeconds,
          ...(plan.width > 0 ? { videoWidth: plan.width } : {}), ...(plan.height > 0 ? { videoHeight: plan.height } : {}) });
        for (let index = checkpoint?.completedSegments ?? 0; index < plan.segments.length; index++) {
          context.signal.throwIfAborted();
          let segmentBytes = 0;
          const data = await session.process(index, (bytes, phase) => {
            speed.record(Math.max(0, bytes - segmentBytes)); segmentBytes = bytes;
            const rates = speed.sample();
            context.onProgress({ completedSegments: index, totalSegments: plan.segments.length, bytesWritten: checkpoint?.bytesWritten ?? 0,
              networkBytesReceived: speed.totalBytes, phase, currentSegment: index + 1, currentSegmentBytesReceived: bytes,
              currentSpeedBytesPerSecond: rates.current, averageSpeedBytesPerSecond: rates.average });
          }, context.signal);
          if (!checkpoint) {
            checkpoint = checkpointFor(context, plan, data);
            task = await context.persistTask({ ...task, outputFormat: 'mp4', checkpoint: structuredClone(checkpoint) });
          }
          for (const kind of KINDS) {
            const track = checkpoint.tracks[kind], incoming = data.tracks[kind];
            if (track.fingerprint !== incoming.initializationHash || (track.lastEndDTS !== undefined && Math.abs(incoming.startDTS - track.lastEndDTS) > 0.15)) {
              throw new RuntimeError('browserSourcePlanChanged');
            }
            if (incoming.endDTS <= incoming.startDTS || Math.abs(incoming.endDTS - incoming.startDTS - plan.segments[index]!.duration) > 0.3) throw new RuntimeError('browserSourceIncomplete');
            if (!writers[kind]) {
              const file = await context.artifacts.stat(track.partialFilename);
              if ((file?.size ?? 0) < track.bytesWritten) throw new RuntimeError('partialMissingOrShort');
              writers[kind] = await context.artifacts.open(track.partialFilename, { resumeFrom: track.bytesWritten });
            }
            const writer = writers[kind]!;
            const transfer = async (part: 'initialization' | 'media', length: number) => {
              for (let offset = 0; offset < length; offset += SOURCE_CHUNK_BYTES) {
                context.signal.throwIfAborted();
                const bytes = await session!.read(kind, part, offset, Math.min(SOURCE_CHUNK_BYTES, length - offset), context.signal);
                if (bytes.length !== Math.min(SOURCE_CHUNK_BYTES, length - offset)) throw new RuntimeError('browserSourceIncomplete');
                await writer.write(bytes); track.bytesWritten += bytes.length;
              }
            };
            if (!track.initializationBytes) { await transfer('initialization', incoming.initializationBytes); track.initializationBytes = incoming.initializationBytes; }
            await transfer('media', incoming.mediaBytes);
            track.segmentEndOffsets.push(track.bytesWritten); track.completedSegments = index + 1;
            track.firstStartDTS ??= incoming.startDTS; track.lastEndDTS = incoming.endDTS;
          }
          checkpoint.completedSegments = index + 1;
          checkpoint.bytesWritten = checkpoint.tracks.audio.bytesWritten + checkpoint.tracks.video.bytesWritten;
          checkpoint.updatedAt = Date.now();
          if ((index + 1) % COMMIT_SEGMENTS === 0 || index + 1 === plan.segments.length) {
            // Closing both files commits File System Access's staged writes before persisting progress.
            await closeWriters();
            task = await context.persistTask({ ...task, checkpoint: structuredClone(checkpoint), outputFormat: 'mp4' });
            await context.recordTaskEvent('checkpoint-saved', 'info', { completedSegments: checkpoint.completedSegments,
              totalSegments: checkpoint.totalSegments, bytesWritten: checkpoint.bytesWritten });
          }
          await session.acknowledge(index, context.signal);
        }
        break;
      } catch (cause) {
        await closeWriters(cause);
        checkpoint = task.checkpoint?.version === 3 ? structuredClone(task.checkpoint) : undefined;
        if (!context.signal.aborted && checkpoint?.completedSegments === checkpoint?.totalSegments && checkpoint) break;
        if (!context.signal.aborted && cause instanceof RuntimeError && cause.code === 'browserSourceExpired' && refreshes < 1) {
          refreshes++;
          await context.recordTaskEvent('source-refresh-started', 'warning');
          continue;
        }
        throw cause;
      } finally { await closeWriters(new Error('closed')); await session?.close(); }
    }
    if (!checkpoint || checkpoint.completedSegments !== checkpoint.totalSegments) throw new RuntimeError('browserSourceIncomplete');
    await context.recordTaskEvent('finalize-started', 'info', { totalSegments: checkpoint.totalSegments, bytesWritten: checkpoint.bytesWritten });
    return finalize(context, checkpoint);
  },
};
