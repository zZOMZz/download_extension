import type { WritableDirectoryHandle } from '../directory-output-writer';
import type { HlsNetworkPolicy, NetworkRetryEvent } from '../../core/hls/download-hls';
import type { OutputValidationOptions } from '../../core/media/output-validator';
import type { ResolvedDiscoveredMedia } from '../../core/discovery/types';
import type { DownloadTask, DownloadTaskProgress } from '../../shared/download-task';
import type {
  TaskDiagnosticEvent,
  TaskDiagnosticEventCode,
} from '../../shared/task-diagnostics';
import type { NetworkSettings } from '../../shared/settings';
import type { Translator } from '../../shared/i18n';

export type RecordTaskEvent = (
  code: TaskDiagnosticEventCode,
  level?: TaskDiagnosticEvent['level'],
  details?: Omit<TaskDiagnosticEvent, 'id' | 'taskId' | 'at' | 'level' | 'code'>,
) => Promise<void>;

export interface TaskExecutorContext {
  task: DownloadTask;
  media: ResolvedDiscoveredMedia;
  directory: WritableDirectoryHandle;
  directoryHandleId?: string;
  signal: AbortSignal;
  networkPolicy: HlsNetworkPolicy;
  networkSettings: NetworkSettings;
  loadText(url: string, signal?: AbortSignal): Promise<string>;
  refreshMedia(): Promise<ResolvedDiscoveredMedia>;
  persistTask(task: DownloadTask): Promise<DownloadTask>;
  onProgress(progress: DownloadTaskProgress): void;
  recordTaskEvent: RecordTaskEvent;
  recordRequestRetry(
    retry: NetworkRetryEvent,
    resourceKind: TaskDiagnosticEvent['resourceKind'],
    resourceUrl: string,
    segment?: number,
  ): void;
  t: Translator;
}

export interface TaskExecutorResult {
  finalFilename: string;
  validationOptions: OutputValidationOptions;
  partialOutputsToRemove?: readonly string[];
}

export interface ProtocolTaskExecutor {
  readonly kind: ResolvedDiscoveredMedia['kind'];
  execute(context: TaskExecutorContext): Promise<TaskExecutorResult>;
}
