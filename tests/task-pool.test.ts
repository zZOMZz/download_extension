import { describe, expect, it } from 'vitest';
import { runTaskPool } from '../src/core/task-pool';

describe('task pool', () => {
  it('never runs more tasks than the configured concurrency', async () => {
    let active = 0;
    let peakActive = 0;
    const results = await runTaskPool({
      items: Array.from({ length: 12 }, (_, index) => index),
      concurrency: 4,
      run: async (value) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return value * 2;
      },
    });

    expect(peakActive).toBe(4);
    expect(results.map(({ value }) => value)).toEqual(
      Array.from({ length: 12 }, (_, index) => index * 2),
    );
  });

  it('does not claim new tasks after the pool is stopped', async () => {
    let stopped = false;
    const started: number[] = [];
    const results = await runTaskPool({
      items: [0, 1, 2, 3],
      concurrency: 2,
      shouldStop: () => stopped,
      run: async (value) => {
        started.push(value);
        stopped = true;
        return value;
      },
    });

    expect(started).toEqual([0]);
    expect(results).toEqual([{ index: 0, value: 0 }]);
  });

  it('waits for active peers before rejecting a failed worker', async () => {
    let releasePeer!: () => void;
    const peer = new Promise<void>((resolve) => { releasePeer = resolve; });
    const failure = new Error('One worker failed');
    let peerFinished = false;
    let settled = false;
    const pending = runTaskPool({
      items: [0, 1], concurrency: 2,
      run: async (value) => {
        if (value === 0) throw failure;
        await peer;
        peerFinished = true;
        return value;
      },
    }).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(peerFinished).toBe(false);
    releasePeer();
    expect(await pending).toBe(failure);
    expect(peerFinished).toBe(true);
  });

  it('rejects invalid concurrency values', async () => {
    await expect(runTaskPool({ items: [1], concurrency: 0, run: async (value) => value })).rejects.toThrow(
      'positive integer',
    );
  });
});
