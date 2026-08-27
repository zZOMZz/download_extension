import type { ResolvedDiscoveredMedia } from '../../core/discovery/types';
import { dashTaskExecutor } from './dash';
import { hlsTaskExecutor } from './hls';
import type { ProtocolTaskExecutor } from './types';

export const PROTOCOL_TASK_EXECUTORS: readonly ProtocolTaskExecutor[] = Object.freeze([
  hlsTaskExecutor,
  dashTaskExecutor,
]);

export function findTaskExecutor(
  kind: ResolvedDiscoveredMedia['kind'],
  executors: readonly ProtocolTaskExecutor[] = PROTOCOL_TASK_EXECUTORS,
): ProtocolTaskExecutor | undefined {
  const matches = executors.filter((executor) => executor.kind === kind);
  if (matches.length > 1) {
    throw new Error(`Multiple task executors are registered for ${kind}.`);
  }
  return matches[0];
}
