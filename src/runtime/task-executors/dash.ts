import { readMediaArtifact } from '../artifact-store';
import { RuntimeError } from '../errors';
import {
  downloadDashPlan,
  downloadDashTrack,
  prepareDashDownload,
  type DashDownloadPlan,
  type ResolvedDashTrack,
} from '../../core/dash/download-dash';
import {
  dashPlanFingerprint,
  dashTrackFingerprint,
  reconcileDashTrackFile,
} from '../../core/dash/resume';
import { isExpiredDashResourceError } from '../../core/dash/source-refresh';
import { safeFilename } from '../../core/format';
import { checkpointMatchesDirectory } from '../../core/task-checkpoint';
import type {
  HlsDownloadProgress,
  HlsRequestRetryEvent,
} from '../../core/hls/download-hls';
import { parseDashMediaSource } from '../../core/protocols/dash';
import { resetTaskState } from '../../core/task-state';
import type {
  DashDownloadCheckpoint,
  DashTrackCheckpoint,
  DownloadTask,
} from '../../shared/download-task';
import { diagnosticResource } from '../../shared/task-diagnostics';
import type { ProtocolTaskExecutor, TaskExecutorContext } from './types';

type DashTrackKind = keyof DashDownloadCheckpoint['tracks'];

function outputFilename(task: DownloadTask): string {
  const title = [task.source.seriesTitle, task.source.title].filter(Boolean).join(' - ');
  return `${safeFilename(title || task.source.title)}.mp4`;
}

function partialFilename(filename: string, kind: DashTrackKind): string {
  return `${filename.replace(/\.mp4$/i, '')}.${kind}.part.m4s`;
}

function shouldRecordCheckpoint(completedSegments: number, totalSegments: number): boolean {
  const interval = Math.max(1, Math.ceil(totalSegments / 20));
  return completedSegments === 1 || completedSegments === totalSegments || completedSegments % interval === 0;
}

function createTrackCheckpoint(
  track: ResolvedDashTrack,
  filename: string,
): DashTrackCheckpoint {
  return {
    trackId: track.id,
    fingerprint: dashTrackFingerprint(track),
    partialFilename: filename,
    initializationBytes: 0,
    completedSegments: 0,
    totalSegments: track.segments.length,
    bytesWritten: 0,
    segmentEndOffsets: [],
  };
}

function summarizeCheckpoint(checkpoint: DashDownloadCheckpoint): DashDownloadCheckpoint {
  const tracks = Object.values(checkpoint.tracks);
  return {
    ...checkpoint,
    completedSegments: tracks.reduce((sum, track) => sum + track.completedSegments, 0),
    totalSegments: tracks.reduce((sum, track) => sum + track.totalSegments, 0),
    bytesWritten: tracks.reduce((sum, track) => sum + track.bytesWritten, 0),
    updatedAt: Date.now(),
  };
}

function replaceTrackCheckpoint(
  checkpoint: DashDownloadCheckpoint,
  kind: DashTrackKind,
  track: DashTrackCheckpoint,
): DashDownloadCheckpoint {
  return summarizeCheckpoint({
    ...checkpoint,
    tracks: { ...checkpoint.tracks, [kind]: track },
  });
}

function combinedProgress(
  checkpoint: DashDownloadCheckpoint,
  kind: DashTrackKind,
  progress: HlsDownloadProgress,
): HlsDownloadProgress {
  const other = checkpoint.tracks[kind === 'video' ? 'audio' : 'video'];
  const currentSegment = progress.currentSegment === undefined
    ? undefined
    : progress.currentSegment + (kind === 'audio' ? checkpoint.tracks.video.totalSegments : 0);
  const completedSegments = progress.completedSegments + other.completedSegments;
  return {
    ...progress,
    completedSegments,
    totalSegments: checkpoint.totalSegments,
    bytesWritten: progress.bytesWritten + other.bytesWritten,
    phase: progress.phase === 'completed' && completedSegments < checkpoint.totalSegments
      ? 'processing'
      : progress.phase,
    ...(currentSegment === undefined ? {} : { currentSegment }),
  };
}

async function finalizeDashOutput(
  context: TaskExecutorContext,
  checkpoint: DashDownloadCheckpoint,
): Promise<void> {
  const files = await Promise.all((['video', 'audio'] as const).map(async (kind) => {
    const track = checkpoint.tracks[kind];
    const file = await readMediaArtifact(context.artifacts, track.partialFilename);
    if (!file || file.size < track.bytesWritten || track.initializationBytes === 0) {
      throw new RuntimeError('partialMissingOrShort');
    }
    if (track.completedSegments !== track.totalSegments) {
      throw new RuntimeError('partialClosedEarly');
    }
    return { kind, file, track };
  }));
  const destination = await context.artifacts.open(checkpoint.finalFilename);
  const writer = context.transforms.createDashWriter(
    destination,
    checkpoint.tracks.video.totalSegments,
    checkpoint.tracks.audio.totalSegments,
  );
  let finalizedSegments = 0;
  try {
    for (const { file, track } of files) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new DOMException('The task was cancelled.', 'AbortError');
      }
      await writer.write(await file.read(0, track.initializationBytes));
      let start = track.initializationBytes;
      for (const end of track.segmentEndOffsets) {
        if (context.signal.aborted) {
          throw context.signal.reason ?? new DOMException('The task was cancelled.', 'AbortError');
        }
        await writer.write(await file.read(start, end - start));
        start = end;
        finalizedSegments += 1;
        context.onProgress({
          completedSegments: checkpoint.totalSegments,
          totalSegments: checkpoint.totalSegments,
          bytesWritten: checkpoint.bytesWritten,
          networkBytesReceived: 0,
          phase: 'finalizing',
          currentSegment: finalizedSegments,
        });
      }
    }
    await writer.close();
  } catch (cause) {
    await writer.abort(cause);
    throw cause;
  }
}

function assertCompatibleCheckpoint(
  context: TaskExecutorContext,
  checkpoint: DashDownloadCheckpoint,
  plan: DashDownloadPlan,
  finalFilename: string,
  videoPartialFilename: string,
  audioPartialFilename: string,
): void {
  if (
    checkpoint.planFingerprint !== dashPlanFingerprint(plan) ||
    checkpoint.finalFilename !== finalFilename ||
    checkpoint.tracks.video.trackId !== plan.video.id ||
    checkpoint.tracks.audio.trackId !== plan.audio.id ||
    checkpoint.tracks.video.fingerprint !== dashTrackFingerprint(plan.video) ||
    checkpoint.tracks.audio.fingerprint !== dashTrackFingerprint(plan.audio) ||
    checkpoint.tracks.video.partialFilename !== videoPartialFilename ||
    checkpoint.tracks.audio.partialFilename !== audioPartialFilename ||
    checkpoint.tracks.video.totalSegments !== plan.video.segments.length ||
    checkpoint.tracks.audio.totalSegments !== plan.audio.segments.length
  ) {
    throw new RuntimeError('refreshedDashMismatch');
  }
}

export const dashTaskExecutor: ProtocolTaskExecutor = {
  kind: 'dash',
  async execute(context) {
    if (context.media.kind !== 'dash') throw new Error('The DASH task executor received another protocol.');
    let task = context.task;
    let resolvedMedia = context.media;
    let sourceRefreshAttempt = 0;
    const maxSourceRefreshes = Math.min(2, context.networkSettings.taskRecoveryAttempts);
    const retry = (event: HlsRequestRetryEvent) =>
      context.recordRequestRetry(event, event.resourceKind, event.resourceUrl, event.segment);
    const prepare = async () => {
      const source = resolvedMedia.dash ?? parseDashMediaSource(
        await context.loadText(resolvedMedia.url, context.signal),
        resolvedMedia.url,
      );
      return prepareDashDownload(source, {
        signal: context.signal,
        networkPolicy: context.networkPolicy,
        ...(context.transport ? { transport: context.transport } : {}),
        onRequestRetry: retry,
      });
    };
    const refreshExpiredSource = async (cause: unknown) => {
      if (
        !isExpiredDashResourceError(cause) ||
        sourceRefreshAttempt >= maxSourceRefreshes
      ) throw cause;
      sourceRefreshAttempt += 1;
      await context.recordTaskEvent('source-refresh-started', 'warning', {
        attempt: sourceRefreshAttempt,
        maxAttempts: maxSourceRefreshes,
      });
      const refreshed = await context.refreshMedia();
      if (refreshed.kind !== 'dash') {
        throw new RuntimeError('dashCheckpointProtocolMismatch');
      }
      resolvedMedia = refreshed;
      await context.recordTaskEvent('source-refreshed', 'info', {
        ...diagnosticResource(refreshed.url),
        protocol: 'dash',
        attempt: sourceRefreshAttempt,
        maxAttempts: maxSourceRefreshes,
      });
    };
    const prepareWithRefresh = async (): Promise<DashDownloadPlan> => {
      while (true) {
        try {
          return await prepare();
        } catch (cause) {
          await refreshExpiredSource(cause);
        }
      }
    };
    let plan = await prepareWithRefresh();
    await context.recordTaskEvent('dash-tracks-selected', 'info', {
      protocol: 'dash',
      videoTrackId: plan.video.id,
      audioTrackId: plan.audio.id,
      ...(plan.video.codecs ? { videoCodec: plan.video.codecs } : {}),
      ...(plan.audio.codecs ? { audioCodec: plan.audio.codecs } : {}),
      ...(plan.video.width ? { videoWidth: plan.video.width } : {}),
      ...(plan.video.height ? { videoHeight: plan.video.height } : {}),
      ...(plan.video.bandwidth === undefined ? {} : { videoBandwidth: plan.video.bandwidth }),
      ...(plan.audio.bandwidth === undefined ? {} : { audioBandwidth: plan.audio.bandwidth }),
    });
    await context.recordTaskEvent('manifest-loaded', 'info', {
      ...diagnosticResource(resolvedMedia.url),
      protocol: 'dash',
      totalSegments: plan.totalSegments,
    });
    const finalFilename = outputFilename(task);
    const resumeEnabled = Boolean(task.checkpoint) || context.networkSettings.resumePartialDownloads;
    if (!resumeEnabled) {
      while (true) {
        const destination = await context.artifacts.open(finalFilename);
        const writer = context.transforms.createDashWriter(
          destination,
          plan.video.segments.length,
          plan.audio.segments.length,
        );
        task = await context.persistTask(resetTaskState(task, 'downloading'));
        await context.recordTaskEvent('output-opened', 'info', {
          directoryName: context.artifacts.name,
          filename: finalFilename,
        });
        await context.recordTaskEvent('download-started', 'info', { totalSegments: plan.totalSegments });
        try {
          await downloadDashPlan(plan, writer, {
            signal: context.signal,
            networkPolicy: context.networkPolicy,
            ...(context.transport ? { transport: context.transport } : {}),
            onProgress: context.onProgress,
            onRequestRetry: retry,
          });
          break;
        } catch (cause) {
          await refreshExpiredSource(cause);
          plan = await prepareWithRefresh();
        }
      }
      return {
        finalFilename,
        validationOptions: { format: 'mp4', requireVideo: true },
      };
    }

    const videoPartialFilename = partialFilename(finalFilename, 'video');
    const audioPartialFilename = partialFilename(finalFilename, 'audio');
    const existingCheckpoint = task.checkpoint?.version === 2 ? task.checkpoint : undefined;
    if (task.checkpoint && !existingCheckpoint) {
      throw new RuntimeError('dashCheckpointProtocolMismatch');
    }
    if (existingCheckpoint && !checkpointMatchesDirectory(existingCheckpoint, {
      name: context.artifacts.name,
      ...(context.artifacts.id ? { handleId: context.artifacts.id } : {}),
    })) {
      throw new RuntimeError('chooseOriginalFolderResume', {
        name: existingCheckpoint.directoryName,
      });
    }
    if (existingCheckpoint) {
      assertCompatibleCheckpoint(
        context,
        existingCheckpoint,
        plan,
        finalFilename,
        videoPartialFilename,
        audioPartialFilename,
      );
    }

    const initialTracks = {
      video: createTrackCheckpoint(plan.video, videoPartialFilename),
      audio: createTrackCheckpoint(plan.audio, audioPartialFilename),
    };
    const files = await Promise.all((['video', 'audio'] as const).map(async (kind) => ({
      kind,
      file: await readMediaArtifact(context.artifacts, initialTracks[kind].partialFilename),
    })));
    let checkpoint: DashDownloadCheckpoint = summarizeCheckpoint({
      version: 2,
      protocol: 'dash',
      planFingerprint: dashPlanFingerprint(plan),
      directoryName: context.artifacts.name,
      ...(context.artifacts.id ? { directoryHandleId: context.artifacts.id } : {}),
      finalFilename,
      completedSegments: 0,
      totalSegments: plan.totalSegments,
      bytesWritten: 0,
      tracks: initialTracks,
      updatedAt: Date.now(),
    });
    if (existingCheckpoint) {
      for (const { kind, file } of files) {
        const saved = existingCheckpoint.tracks[kind];
        if (!file && saved.bytesWritten > 0) {
          throw new RuntimeError('savedPartialNotFound', { name: saved.partialFilename });
        }
        const reconciled = reconcileDashTrackFile(saved, file?.size ?? 0);
        checkpoint = replaceTrackCheckpoint(checkpoint, kind, { ...saved, ...reconciled });
      }
    }
    await context.recordTaskEvent('resume-prepared', 'info', {
      directoryName: context.artifacts.name,
      filename: `${videoPartialFilename}, ${audioPartialFilename}`,
      completedSegments: checkpoint.completedSegments,
      totalSegments: checkpoint.totalSegments,
      bytesWritten: checkpoint.bytesWritten,
    });
    task = await context.persistTask({ ...resetTaskState(task, 'downloading'), checkpoint });
    await context.recordTaskEvent('download-started', 'info', {
      completedSegments: checkpoint.completedSegments,
      totalSegments: checkpoint.totalSegments,
    });

    const downloadTrack = async (kind: DashTrackKind) => {
      while (true) {
        const saved = checkpoint.tracks[kind];
        if (saved.initializationBytes > 0 && saved.completedSegments === saved.totalSegments) return;
        const writer = await context.artifacts.open(
          saved.partialFilename,
          { resumeFrom: saved.bytesWritten },
        );
        await context.recordTaskEvent('output-opened', 'info', {
          directoryName: context.artifacts.name,
          filename: saved.partialFilename,
          bytesWritten: saved.bytesWritten,
        });
        try {
          await downloadDashTrack(plan[kind], writer, {
            signal: context.signal,
            networkPolicy: context.networkPolicy,
            ...(context.transport ? { transport: context.transport } : {}),
            initializationWritten: saved.initializationBytes > 0,
            startSegmentIndex: saved.completedSegments,
            initialBytesWritten: saved.bytesWritten,
            onProgress: (progress) => context.onProgress(combinedProgress(checkpoint, kind, progress)),
            onRequestRetry: (event) => context.recordRequestRetry(
              event,
              event.resourceKind,
              event.resourceUrl,
              event.segment === undefined
                ? undefined
                : event.segment + (kind === 'audio' ? checkpoint.tracks.video.totalSegments : 0),
            ),
            onInitializationComplete: async (bytesWritten) => {
              checkpoint = replaceTrackCheckpoint(checkpoint, kind, {
                ...checkpoint.tracks[kind],
                initializationBytes: bytesWritten,
                bytesWritten,
              });
              task = await context.persistTask({ ...task, checkpoint });
            },
            onSegmentComplete: async (progress, trackSegmentIndex) => {
              const segmentEndOffsets = checkpoint.tracks[kind].segmentEndOffsets.slice(0, trackSegmentIndex);
              segmentEndOffsets.push(progress.bytesWritten);
              checkpoint = replaceTrackCheckpoint(checkpoint, kind, {
                ...checkpoint.tracks[kind],
                completedSegments: progress.completedSegments,
                bytesWritten: progress.bytesWritten,
                segmentEndOffsets,
              });
              const aggregateProgress = combinedProgress(checkpoint, kind, progress);
              task = await context.persistTask({ ...task, progress: aggregateProgress, checkpoint });
              if (shouldRecordCheckpoint(checkpoint.completedSegments, checkpoint.totalSegments)) {
                void context.recordTaskEvent('checkpoint-saved', 'info', {
                  completedSegments: checkpoint.completedSegments,
                  totalSegments: checkpoint.totalSegments,
                  bytesWritten: checkpoint.bytesWritten,
                });
              }
            },
          });
          return;
        } catch (cause) {
          await refreshExpiredSource(cause);
          const refreshedPlan = await prepareWithRefresh();
          assertCompatibleCheckpoint(
            context,
            checkpoint,
            refreshedPlan,
            finalFilename,
            videoPartialFilename,
            audioPartialFilename,
          );
          plan = refreshedPlan;
        }
      }
    };

    await downloadTrack('video');
    await downloadTrack('audio');
    if (checkpoint.completedSegments !== checkpoint.totalSegments) {
      throw new RuntimeError('partialClosedEarly');
    }
    await context.recordTaskEvent('finalize-started', 'info', {
      filename: checkpoint.finalFilename,
      bytesWritten: checkpoint.bytesWritten,
    });
    await finalizeDashOutput(context, checkpoint);
    return {
      finalFilename,
      validationOptions: { format: 'mp4', requireVideo: true },
      partialOutputsToRemove: [videoPartialFilename, audioPartialFilename],
    };
  },
};
