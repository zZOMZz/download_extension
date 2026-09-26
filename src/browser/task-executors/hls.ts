import { hlsTaskExecutor as runtimeExecutor } from '../../runtime/task-executors/hls';
import { browserTransformBackend, createBrowserArtifactStore } from '../runtime-adapters';
import type { ProtocolTaskExecutor } from './types';

/** Compatibility entrypoint; new callers use the runtime executor and injected host ports. */
export const hlsTaskExecutor: ProtocolTaskExecutor = {
  kind: runtimeExecutor.kind,
  execute: (context) => runtimeExecutor.execute({
    ...context,
    artifacts: createBrowserArtifactStore(context.directory, context.directoryHandleId),
    transforms: browserTransformBackend,
  }),
};
