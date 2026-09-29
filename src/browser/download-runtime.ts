import { DownloadRuntime, type ExecutionLocks } from '../runtime/download-runtime';
import { RuntimeError } from '../runtime/errors';
import type { ArtifactStore } from '../runtime/artifact-store';
import { resolveDiscoveredMedia } from '../core/discovery/registry';
import type { NetworkSettings } from '../shared/settings';
import type { TaskDiagnosticEvent } from '../shared/task-diagnostics';
import type { WritableDirectoryHandle } from './directory-output-writer';
import { createBrowserArtifactStore, browserTransformBackend } from './runtime-adapters';
import { createBrowserMediaSourceProvider } from './media-source-provider';
import { addPersistentDownloadTasks, appendPersistentTaskDiagnosticEvent, configureManagerRequestAdapters, listPersistentDownloadTasks,
  replacePersistentDownloadTask, removePersistentDownloadTask } from './runtime-client';

/** Web Locks are scoped to the extension origin and released if its owner page exits. */
export const browserExecutionLocks: ExecutionLocks = {
  async runExclusive(operation) {
    if (!globalThis.navigator?.locks) throw new RuntimeError('runtimeLockUnavailable');
    return navigator.locks.request('open-media-downloader:task-runtime', { ifAvailable: true }, async (lock) => {
      if (!lock) throw new RuntimeError('runtimeBusy');
      return operation();
    });
  },
};

const missingOutput = (): never => { throw new RuntimeError('chooseDirectoryBeforeQueue'); };
const unavailableArtifacts: ArtifactStore = {
  name: '', stat: missingOutput, read: missingOutput, open: missingOutput, remove: missingOutput,
};

export function createBrowserDownloadRuntime(options: {
  directory: WritableDirectoryHandle | null;
  directoryHandleId?: string;
  networkSettings: NetworkSettings;
  concurrency: number;
  onEvent?(event: TaskDiagnosticEvent): void;
}): DownloadRuntime {
  return new DownloadRuntime({
    store: { add: addPersistentDownloadTasks, list: listPersistentDownloadTasks, save: replacePersistentDownloadTask, remove: removePersistentDownloadTask },
    artifacts: options.directory ? createBrowserArtifactStore(options.directory, options.directoryHandleId) : unavailableArtifacts,
    transforms: browserTransformBackend,
    mediaSourceProvider: createBrowserMediaSourceProvider(),
    locks: browserExecutionLocks,
    resolve: resolveDiscoveredMedia,
    networkSettings: options.networkSettings,
    concurrency: options.concurrency,
    prepare: (tasks) => {
      if (!options.directory && tasks.length) missingOutput();
      return configureManagerRequestAdapters(tasks.map(({ source }) => source.adapterId));
    },
    recordEvent: async (event) => { options.onEvent?.(event); await appendPersistentTaskDiagnosticEvent(event); },
  });
}
