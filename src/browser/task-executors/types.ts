import type { WritableDirectoryHandle } from '../directory-output-writer';
import type { Translator } from '../../shared/i18n';
import type {
  TaskExecutorContext as RuntimeTaskExecutorContext,
  TaskExecutorResult,
} from '../../runtime/task-executors/types';

export type { TaskExecutorResult, RecordTaskEvent } from '../../runtime/task-executors/types';

/** @deprecated UI-free executors accept ArtifactStore and TransformBackend instead. */
export interface TaskExecutorContext extends Omit<RuntimeTaskExecutorContext, 'artifacts' | 'transforms'> {
  directory: WritableDirectoryHandle;
  directoryHandleId?: string;
  t: Translator;
}

export interface ProtocolTaskExecutor {
  readonly kind: RuntimeTaskExecutorContext['media']['kind'];
  execute(context: TaskExecutorContext): Promise<TaskExecutorResult>;
}
