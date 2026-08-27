import {
  openDirectoryOutputWriter,
  openResumableDirectoryOutputWriter,
  readDirectoryFile,
} from '../directory-output-writer';
import { createHlsOutputWriter } from '../hls-output-writer';
import {
  downloadHlsPlaylist,
  validateHlsDownload,
  type HlsDownloadProgress,
} from '../../core/hls/download-hls';
import { inspectHlsUrl, type InspectedHls } from '../../core/hls/inspect-hls';
import {
  combinedHlsMediaPlaylist,
  hlsPlaylistUsesFmp4,
} from '../../core/hls/media-bundle';
import { createHlsOutputPlan, type HlsOutputPlan } from '../../core/hls/output-plan';
import {
  hlsPlaylistFingerprint,
  reconcileCheckpointFile,
} from '../../core/hls/resume';
import { safeFilename } from '../../core/format';
import { checkpointMatchesDirectory } from '../../core/task-checkpoint';
import { resetTaskState } from '../../core/task-state';
import type { DownloadTask, HlsDownloadCheckpoint } from '../../shared/download-task';
import { diagnosticResource } from '../../shared/task-diagnostics';
import type { ProtocolTaskExecutor, TaskExecutorContext } from './types';

interface HlsOutputDetails extends HlsOutputPlan {
  filename: string;
}

function outputDetails(task: DownloadTask, hls: InspectedHls): HlsOutputDetails {
  const plan = createHlsOutputPlan(hls, task.outputFormat);
  const title = [task.source.seriesTitle, task.source.title].filter(Boolean).join(' - ');
  return {
    ...plan,
    filename: `${safeFilename(title || task.source.title)}.${plan.extension}`,
  };
}

function partialFilename(filename: string): string {
  return `${filename.replace(/\.[^.]+$/, '')}.part.ts`;
}

function shouldRecordCheckpoint(completedSegments: number, totalSegments: number): boolean {
  const interval = Math.max(1, Math.ceil(totalSegments / 20));
  return completedSegments === 1 || completedSegments === totalSegments || completedSegments % interval === 0;
}

async function finalizePartialOutput(
  context: TaskExecutorContext,
  checkpoint: HlsDownloadCheckpoint,
  details: HlsOutputDetails,
): Promise<void> {
  const partial = await readDirectoryFile(context.directory, checkpoint.partialFilename);
  if (!partial || partial.size < checkpoint.bytesWritten) {
    throw new Error(context.t('partialMissingOrShort'));
  }
  const destination = await openDirectoryOutputWriter(context.directory, checkpoint.finalFilename);
  const writer = createHlsOutputWriter(destination, details);
  let start = 0;
  try {
    for (const [index, end] of checkpoint.segmentEndOffsets.entries()) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new DOMException('The task was cancelled.', 'AbortError');
      }
      const bytes = new Uint8Array(await partial.slice(start, end).arrayBuffer());
      await writer.write(bytes);
      start = end;
      context.onProgress({
        completedSegments: checkpoint.totalSegments,
        totalSegments: checkpoint.totalSegments,
        bytesWritten: checkpoint.bytesWritten,
        networkBytesReceived: 0,
        phase: 'finalizing',
        currentSegment: index + 1,
      });
    }
    await writer.close();
  } catch (cause) {
    await writer.abort(cause);
    throw cause;
  }
}

export const hlsTaskExecutor: ProtocolTaskExecutor = {
  kind: 'hls',
  async execute(context) {
    if (context.media.kind !== 'hls') throw new Error('The HLS task executor received another protocol.');
    let task = context.task;
    let latestProgress = task.progress;
    const updateProgress = (progress: HlsDownloadProgress) => {
      latestProgress = progress;
      context.onProgress(progress);
    };
    const hls = await inspectHlsUrl(context.media.url, context.loadText, context.signal);
    const downloadPlaylist = combinedHlsMediaPlaylist(hls);
    await context.recordTaskEvent('manifest-loaded', 'info', {
      ...diagnosticResource(hls.selectedVariant?.uri ?? context.media.url),
      totalSegments: downloadPlaylist.segments.length,
    });
    if (hls.audioMedia) {
      const renditionUrl = hls.selectedAudioRendition?.uri;
      await context.recordTaskEvent('audio-rendition-loaded', 'info', {
        ...(renditionUrl ? diagnosticResource(renditionUrl) : {}),
        totalSegments: hls.audioMedia.segments.length,
        ...(hls.selectedAudioRendition?.name ? { message: hls.selectedAudioRendition.name } : {}),
      });
    }
    const problems = [
      ...validateHlsDownload(hls.media),
      ...(hls.audioMedia ? validateHlsDownload(hls.audioMedia) : []),
    ];
    if (hls.audioMedia && task.outputFormat !== 'mp4') {
      problems.push(context.t('separateAudioRequiresMp4'));
    }
    if (
      hls.audioMedia &&
      hlsPlaylistUsesFmp4(hls.media) !== hlsPlaylistUsesFmp4(hls.audioMedia)
    ) problems.push(context.t('mixedSeparateTrackContainers'));
    if (problems.length) throw new Error(problems.join(' '));

    const details = outputDetails(task, hls);
    let partialOutputToRemove: string | undefined;
    const resumeEnabled = Boolean(task.checkpoint) ||
      (context.networkSettings.resumePartialDownloads && details.resumableTs);
    if (resumeEnabled) {
      if (!details.resumableTs) throw new Error(context.t('refreshedStreamIncompatible'));
      const fingerprint = hlsPlaylistFingerprint(downloadPlaylist);
      const expectedPartialFilename = partialFilename(details.filename);
      const existingCheckpoint = task.checkpoint?.version === 1 ? task.checkpoint : undefined;
      if (task.checkpoint && !existingCheckpoint) {
        throw new Error(context.t('refreshedStreamIncompatible'));
      }
      if (existingCheckpoint && !checkpointMatchesDirectory(existingCheckpoint, {
        name: context.directory.name,
        ...(context.directoryHandleId ? { handleId: context.directoryHandleId } : {}),
      })) {
        throw new Error(context.t('chooseOriginalFolderResume', {
          name: existingCheckpoint.directoryName,
        }));
      }
      if (existingCheckpoint && (
        existingCheckpoint.playlistFingerprint !== fingerprint ||
        existingCheckpoint.partialFilename !== expectedPartialFilename ||
        existingCheckpoint.finalFilename !== details.filename ||
        existingCheckpoint.totalSegments !== downloadPlaylist.segments.length
      )) throw new Error(context.t('refreshedPlaylistMismatch'));

      const partial = await readDirectoryFile(context.directory, expectedPartialFilename);
      if (existingCheckpoint && !partial) {
        throw new Error(context.t('savedPartialNotFound', {
          name: existingCheckpoint.partialFilename,
        }));
      }
      const reconciled = existingCheckpoint
        ? reconcileCheckpointFile(existingCheckpoint, partial?.size ?? 0)
        : { completedSegments: 0, bytesWritten: 0, segmentEndOffsets: [] };
      let checkpoint: HlsDownloadCheckpoint = {
        version: 1,
        playlistFingerprint: fingerprint,
        directoryName: context.directory.name,
        ...(context.directoryHandleId ? { directoryHandleId: context.directoryHandleId } : {}),
        partialFilename: expectedPartialFilename,
        finalFilename: details.filename,
        completedSegments: reconciled.completedSegments,
        totalSegments: downloadPlaylist.segments.length,
        bytesWritten: reconciled.bytesWritten,
        segmentEndOffsets: reconciled.segmentEndOffsets,
        updatedAt: Date.now(),
      };
      await context.recordTaskEvent('resume-prepared', 'info', {
        directoryName: context.directory.name,
        filename: checkpoint.partialFilename,
        completedSegments: checkpoint.completedSegments,
        totalSegments: checkpoint.totalSegments,
        bytesWritten: checkpoint.bytesWritten,
      });
      task = await context.persistTask({ ...resetTaskState(task, 'downloading'), checkpoint });
      const writer = await openResumableDirectoryOutputWriter(
        context.directory,
        checkpoint.partialFilename,
        checkpoint.bytesWritten,
      );
      await context.recordTaskEvent('output-opened', 'info', {
        directoryName: context.directory.name,
        filename: checkpoint.partialFilename,
        bytesWritten: checkpoint.bytesWritten,
      });
      await context.recordTaskEvent('download-started', 'info', {
        completedSegments: checkpoint.completedSegments,
        totalSegments: checkpoint.totalSegments,
      });
      await downloadHlsPlaylist(downloadPlaylist, writer, {
        signal: context.signal,
        networkPolicy: context.networkPolicy,
        loadText: context.loadText,
        startSegmentIndex: checkpoint.completedSegments,
        initialBytesWritten: checkpoint.bytesWritten,
        onProgress: updateProgress,
        onRequestRetry: (retry) => context.recordRequestRetry(
          retry,
          retry.resourceKind,
          retry.resourceUrl,
          retry.segment,
        ),
        onSegmentComplete: async (progress) => {
          const segmentEndOffsets = checkpoint.segmentEndOffsets.slice(0, progress.completedSegments - 1);
          segmentEndOffsets.push(progress.bytesWritten);
          checkpoint = {
            ...checkpoint,
            completedSegments: progress.completedSegments,
            bytesWritten: progress.bytesWritten,
            segmentEndOffsets,
            updatedAt: Date.now(),
          };
          task = await context.persistTask({ ...task, progress, checkpoint });
          if (shouldRecordCheckpoint(progress.completedSegments, progress.totalSegments)) {
            void context.recordTaskEvent('checkpoint-saved', 'info', {
              completedSegments: progress.completedSegments,
              totalSegments: progress.totalSegments,
              bytesWritten: progress.bytesWritten,
            });
          }
        },
      });
      if (checkpoint.completedSegments !== downloadPlaylist.segments.length) {
        throw new Error(context.t('partialClosedEarly'));
      }
      await context.recordTaskEvent('finalize-started', 'info', {
        filename: checkpoint.finalFilename,
        bytesWritten: checkpoint.bytesWritten,
      });
      await finalizePartialOutput(context, checkpoint, details);
      partialOutputToRemove = checkpoint.partialFilename;
    } else {
      const destination = await openDirectoryOutputWriter(context.directory, details.filename);
      const writer = createHlsOutputWriter(destination, details);
      task = await context.persistTask(resetTaskState(task, 'downloading'));
      await context.recordTaskEvent('output-opened', 'info', {
        directoryName: context.directory.name,
        filename: details.filename,
      });
      await context.recordTaskEvent('download-started', 'info', {
        totalSegments: downloadPlaylist.segments.length,
      });
      await downloadHlsPlaylist(downloadPlaylist, writer, {
        signal: context.signal,
        networkPolicy: context.networkPolicy,
        loadText: context.loadText,
        onProgress: updateProgress,
        onRequestRetry: (retry) => context.recordRequestRetry(
          retry,
          retry.resourceKind,
          retry.resourceUrl,
          retry.segment,
        ),
      });
    }

    return {
      finalFilename: details.filename,
      validationOptions: {
        format: details.extension === 'mp4' ? 'mp4' : 'ts',
        ...(details.extension === 'ts' && latestProgress?.bytesWritten !== undefined
          ? { expectedBytes: latestProgress.bytesWritten }
          : {}),
        requireVideo: true,
      },
      ...(partialOutputToRemove ? { partialOutputsToRemove: [partialOutputToRemove] } : {}),
    };
  },
};
