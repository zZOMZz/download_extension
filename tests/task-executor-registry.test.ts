import { describe, expect, it } from 'vitest';
import { findTaskExecutor } from '../src/browser/task-executors/registry';
import type { ProtocolTaskExecutor } from '../src/browser/task-executors/types';

describe('task executor registry', () => {
  it('selects the executor registered for each queued media protocol', () => {
    expect(findTaskExecutor('hls')?.kind).toBe('hls');
    expect(findTaskExecutor('dash')?.kind).toBe('dash');
    expect(findTaskExecutor('progressive')?.kind).toBe('progressive');
    expect(findTaskExecutor('sabr')).toBeUndefined();
  });

  it('rejects overlapping protocol executors', () => {
    const executor = { kind: 'hls', execute: async () => ({
      finalFilename: 'test.ts',
      validationOptions: { format: 'ts' as const },
    }) } satisfies ProtocolTaskExecutor;
    expect(() => findTaskExecutor('hls', [executor, executor])).toThrow(/multiple/i);
  });
});
