import type { DownloadCheckpoint, DownloadTask } from '../../shared/download-task';
import type { NetworkSettings, TaskConcurrency } from '../../shared/settings';
import type { TaskDiagnosticEvent } from '../../shared/task-diagnostics';
import { sanitizeDiagnosticText } from '../../shared/task-diagnostics';

interface TaskDiagnosticReportContext {
  network: NetworkSettings;
  taskConcurrency: TaskConcurrency;
  userAgent?: string;
  generatedAt?: number;
}

function urlWithoutSecrets(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[unparseable URL]';
  }
}

function taskMediaKind(task: DownloadTask): 'hls' | 'dash' | 'progressive' | undefined {
  if (task.source.mediaKind) return task.source.mediaKind;
  if (task.checkpoint?.version === 1) return 'hls';
  if (task.checkpoint?.version === 2) return 'dash';
  return undefined;
}

function checkpointReport(checkpoint: DownloadCheckpoint) {
  const common = {
    version: checkpoint.version,
    protocol: checkpoint.version === 1 ? 'hls' : checkpoint.version === 2 ? 'dash' : 'browser-source',
    directoryName: checkpoint.directoryName,
    directoryHandleId: checkpoint.directoryHandleId,
    finalFilename: checkpoint.finalFilename,
    completedSegments: checkpoint.completedSegments,
    totalSegments: checkpoint.totalSegments,
    bytesWritten: checkpoint.bytesWritten,
    updatedAt: new Date(checkpoint.updatedAt).toISOString(),
  } as const;

  if (checkpoint.version === 1) {
    return {
      ...common,
      playlistFingerprint: checkpoint.playlistFingerprint,
      partialFilename: checkpoint.partialFilename,
      savedBoundaries: checkpoint.segmentEndOffsets.length,
    };
  }

  return {
    ...common,
    planFingerprint: checkpoint.planFingerprint,
    tracks: Object.fromEntries(
      (['video', 'audio'] as const).map((kind) => {
        const track = checkpoint.tracks[kind];
        return [kind, {
          trackId: track.trackId,
          fingerprint: track.fingerprint,
          partialFilename: track.partialFilename,
          initializationBytes: track.initializationBytes,
          completedSegments: track.completedSegments,
          totalSegments: track.totalSegments,
          bytesWritten: track.bytesWritten,
          savedBoundaries: track.segmentEndOffsets.length,
        }];
      }),
    ),
  };
}

export function buildTaskDiagnosticReport(
  task: DownloadTask,
  events: TaskDiagnosticEvent[],
  context: TaskDiagnosticReportContext,
): string {
  const generatedAt = context.generatedAt ?? Date.now();
  return JSON.stringify({
    reportVersion: 2,
    generatedAt: new Date(generatedAt).toISOString(),
    environment: {
      userAgent: context.userAgent ?? 'unknown',
      taskConcurrency: context.taskConcurrency,
      network: context.network,
    },
    task: {
      id: task.id,
      adapterId: task.source.adapterId,
      title: task.source.title,
      seriesTitle: task.source.seriesTitle,
      pageUrl: urlWithoutSecrets(task.source.pageUrl),
      mediaKind: taskMediaKind(task),
      outputFormat: task.outputFormat,
      status: task.status,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
      failure: task.failure ? {
        ...task.failure,
        message: sanitizeDiagnosticText(task.failure.message),
      } : undefined,
      progress: task.progress,
      checkpoint: task.checkpoint ? checkpointReport(task.checkpoint) : undefined,
      recoveryAttempt: task.recoveryAttempt,
      nextRetryAt: task.nextRetryAt ? new Date(task.nextRetryAt).toISOString() : undefined,
    },
    events: [...events]
      .sort((left, right) => left.at - right.at)
      .map((event) => ({
        ...event,
        at: new Date(event.at).toISOString(),
        ...(event.message ? { message: sanitizeDiagnosticText(event.message) } : {}),
      })),
  }, null, 2);
}
