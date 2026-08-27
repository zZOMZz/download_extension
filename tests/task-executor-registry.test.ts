import { describe, expect, it } from 'vitest';
import { findTaskExecutor } from '../src/browser/task-executors/registry';
import type { ProtocolTaskExecutor } from '../src/browser/task-executors/types';

describe('task executor registry', () => {
  it('selects the HLS executor and leaves unsupported protocols unclaimed', () => {
    expect(findTaskExecutor('hls')?.kind).toBe('hls');
    expect(findTaskExecutor('dash')).toBeUndefined();
  });

  it('rejects overlapping protocol executors', () => {
    const executor = { kind: 'hls', execute: async () => ({
      finalFilename: 'test.ts',
      validationOptions: { format: 'ts' as const },
    }) } satisfies ProtocolTaskExecutor;
    expect(() => findTaskExecutor('hls', [executor, executor])).toThrow(/multiple/i);
  });
});
