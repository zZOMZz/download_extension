import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredMediaItem } from '../src/shared/discovery';

const storage = vi.hoisted(() => new Map<string, unknown>());

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        }),
      },
    },
  },
}));

import {
  addDownloadTasks,
  clearCompletedDownloadTasks,
  listDownloadTasks,
  replaceDownloadTask,
} from '../src/background/download-task-repository';

function item(sequence: number): DiscoveredMediaItem {
  return {
    id: `2rk-series:series:${sequence}`,
    adapterId: '2rk-series',
    pageUrl: `https://www.2rk.cc/detail/series?id=${sequence}`,
    title: `Episode ${sequence}`,
    seriesTitle: 'Series',
    sequence,
  };
}

beforeEach(() => {
  storage.clear();
});

describe('persistent download task repository', () => {
  it('deduplicates discovered items and persists task status changes', async () => {
    const added = await addDownloadTasks([item(1), item(1), item(2)], 'mp4');
    expect(added).toHaveLength(2);
    expect(added.every(({ status }) => status === 'queued')).toBe(true);

    const first = added[0]!;
    await replaceDownloadTask({ ...first, status: 'completed' });
    expect((await listDownloadTasks())[0]?.status).toBe('completed');

    await clearCompletedDownloadTasks();
    const remaining = await listDownloadTasks();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.source.sequence).toBe(2);
  });

  it('preserves simultaneous updates from concurrent task workers', async () => {
    const added = await addDownloadTasks([item(1), item(2), item(3)], 'mp4');
    await Promise.all([
      replaceDownloadTask({ ...added[0]!, status: 'downloading' }),
      replaceDownloadTask({ ...added[1]!, status: 'completed' }),
      replaceDownloadTask({ ...added[2]!, status: 'failed', error: 'test failure' }),
    ]);

    expect((await listDownloadTasks()).map(({ status }) => status)).toEqual([
      'downloading',
      'completed',
      'failed',
    ]);
  });

  it('persists waiting state and resumable checkpoint metadata', async () => {
    const [task] = await addDownloadTasks([item(1)], 'mp4');
    const waiting = await replaceDownloadTask({
      ...task!,
      status: 'waiting',
      recoveryAttempt: 2,
      nextRetryAt: 5_000,
      checkpoint: {
        version: 1,
        playlistFingerprint: 'hls-v1:test',
        directoryName: 'Downloads',
        partialFilename: 'episode.part.ts',
        finalFilename: 'episode.mp4',
        completedSegments: 2,
        totalSegments: 3,
        bytesWritten: 20,
        segmentEndOffsets: [10, 20],
        updatedAt: 4_000,
      },
    });

    expect(waiting).toMatchObject({
      status: 'waiting',
      recoveryAttempt: 2,
      checkpoint: { completedSegments: 2, bytesWritten: 20 },
    });
  });
});
