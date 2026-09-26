import { dashTaskExecutor as runtimeExecutor } from '../../runtime/task-executors/dash';
import { browserTransformBackend, createBrowserArtifactStore } from '../runtime-adapters';
import type { ProtocolTaskExecutor } from './types';

/** Compatibility entrypoint; new callers use the runtime executor and injected host ports. */
export const dashTaskExecutor: ProtocolTaskExecutor = {
  kind: runtimeExecutor.kind,
  execute: (context) => runtimeExecutor.execute({
    ...context,
    artifacts: createBrowserArtifactStore(context.directory, context.directoryHandleId),
    transforms: browserTransformBackend,
  }),
};
