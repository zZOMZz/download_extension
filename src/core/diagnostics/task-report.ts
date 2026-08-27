import type { DownloadTask } from '../../shared/download-task';
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

export function buildTaskDiagnosticReport(
  task: DownloadTask,
  events: TaskDiagnosticEvent[],
  context: TaskDiagnosticReportContext,
): string {
  const generatedAt = context.generatedAt ?? Date.now();
  return JSON.stringify({
    reportVersion: 1,
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
      outputFormat: task.outputFormat,
      status: task.status,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
      failure: task.failure ? {
        ...task.failure,
        message: sanitizeDiagnosticText(task.failure.message),
      } : undefined,
      progress: task.progress,
      checkpoint: task.checkpoint ? {
        version: task.checkpoint.version,
        directoryName: task.checkpoint.directoryName,
        directoryHandleId: task.checkpoint.directoryHandleId,
        partialFilenames: task.checkpoint.version === 1
          ? [task.checkpoint.partialFilename]
          : [
              task.checkpoint.tracks.video.partialFilename,
              task.checkpoint.tracks.audio.partialFilename,
            ],
        finalFilename: task.checkpoint.finalFilename,
        completedSegments: task.checkpoint.completedSegments,
        totalSegments: task.checkpoint.totalSegments,
        bytesWritten: task.checkpoint.bytesWritten,
        updatedAt: new Date(task.checkpoint.updatedAt).toISOString(),
      } : undefined,
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
