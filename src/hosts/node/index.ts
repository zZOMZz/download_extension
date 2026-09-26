import { join } from 'node:path';
import { DownloadRuntime, type DownloadRuntimeOptions } from '../../runtime/download-runtime';
import { NETWORK_PRESETS, type NetworkSettings } from '../../shared/settings';
import type { Transport } from '../../core/network/transport';
import { NodeArtifactStore } from './artifact-store';
import { NodeTaskStore } from './task-store';
import { NodeExecutionLocks } from './execution-locks';
import { createNodeTransport } from './transport';
import { nodeTransforms } from './transforms';

export { NodeArtifactStore, NodeTaskStore, NodeExecutionLocks, createNodeTransport, nodeTransforms };

export interface NodeHostOptions {
  outputDirectory: string;
  lockPort?: number;
  networkSettings?: NetworkSettings;
  concurrency?: number;
  transport?: Transport;
  resolve?: DownloadRuntimeOptions['resolve'];
  recordEvent?: DownloadRuntimeOptions['recordEvent'];
}

export async function createNodeHost(options: NodeHostOptions) {
  const artifacts = await NodeArtifactStore.create(options.outputDirectory);
  const store = new NodeTaskStore(join(artifacts.root, '.download-runtime.tasks.json'));
  // All clients sharing this output namespace also share its task snapshot and execution lock.
  const locks = new NodeExecutionLocks(artifacts.id, options.lockPort);
  const runtime = new DownloadRuntime({
    store,
    artifacts,
    locks,
    transforms: nodeTransforms,
    transport: options.transport ?? createNodeTransport(),
    networkSettings: options.networkSettings ?? NETWORK_PRESETS.balanced,
    concurrency: options.concurrency ?? 1,
    resolve: options.resolve ?? (async (source) => {
      if (source.adapterId !== 'direct' || !source.mediaKind) {
        throw new Error('This Node host requires a direct HLS or DASH URL. Browser playback sessions need an explicit source provider.');
      }
      return { kind: source.mediaKind, url: source.pageUrl, title: source.title };
    }),
    ...(options.recordEvent ? { recordEvent: options.recordEvent } : {}),
  });
  return { runtime, store, artifacts, locks };
}
