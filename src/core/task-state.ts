import type { DownloadTask, DownloadTaskStatus } from '../shared/download-task';

export function resetTaskState(
  task: DownloadTask,
  status: DownloadTaskStatus,
  error?: string,
): DownloadTask {
  const next: DownloadTask = { ...task, status, updatedAt: Date.now() };
  delete next.error;
  delete next.failure;
  delete next.progress;
  if (status !== 'waiting') delete next.nextRetryAt;
  if (error) next.error = error;
  return next;
}
