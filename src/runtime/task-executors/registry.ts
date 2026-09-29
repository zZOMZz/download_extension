import type { ResolvedDiscoveredMedia } from '../../core/discovery/source';
import { dashTaskExecutor } from './dash';
import { hlsTaskExecutor } from './hls';
import { progressiveTaskExecutor } from './progressive';
import { browserSourceTaskExecutor } from './browser-source';
import type { ProtocolTaskExecutor } from './types';

export const PROTOCOL_TASK_EXECUTORS: readonly ProtocolTaskExecutor[] = Object.freeze([
  hlsTaskExecutor,
  dashTaskExecutor,
  progressiveTaskExecutor,
  browserSourceTaskExecutor,
]);

export function findTaskExecutor(
  kind: ResolvedDiscoveredMedia['kind'],
  executors: readonly ProtocolTaskExecutor[] = PROTOCOL_TASK_EXECUTORS,
  mode: 'http' | 'browser-session' = 'http',
): ProtocolTaskExecutor | undefined {
  const matches = executors.filter((executor) => executor.kind === kind && (executor.mode ?? 'http') === mode);
  if (matches.length > 1) {
    throw new Error(`Multiple task executors are registered for ${kind}.`);
  }
  return matches[0];
}
