import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredMediaItem } from '../src/shared/discovery';
import { DOWNLOAD_TASKS_STORAGE_KEY } from '../src/shared/download-task';

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

  it('persists independent DASH video and audio checkpoints', async () => {
    const [task] = await addDownloadTasks([item(1)], 'mp4');
    const waiting = await replaceDownloadTask({
      ...task!,
      status: 'waiting',
      checkpoint: {
        version: 2,
        protocol: 'dash',
        planFingerprint: 'dash-plan-v1:test',
        directoryName: 'Downloads',
        finalFilename: 'episode.mp4',
        completedSegments: 3,
        totalSegments: 5,
        bytesWritten: 500,
        tracks: {
          video: {
            trackId: 'video',
            fingerprint: 'dash-track-v1:video',
            partialFilename: 'episode.video.part.m4s',
            initializationBytes: 100,
            completedSegments: 2,
            totalSegments: 3,
            bytesWritten: 300,
            segmentEndOffsets: [200, 300],
          },
          audio: {
            trackId: 'audio',
            fingerprint: 'dash-track-v1:audio',
            partialFilename: 'episode.audio.part.m4s',
            initializationBytes: 100,
            completedSegments: 1,
            totalSegments: 2,
            bytesWritten: 200,
            segmentEndOffsets: [200],
          },
        },
        updatedAt: 4_000,
      },
    });

    expect(waiting.checkpoint).toMatchObject({
      version: 2,
      completedSegments: 3,
      tracks: {
        video: { completedSegments: 2 },
        audio: { completedSegments: 1 },
      },
    });
  });

  it('rejects corrupt persisted state without replacing the existing queue', async () => {
    const [valid] = await addDownloadTasks([item(1)], 'mp4');
    const corrupted = [valid, { ...valid, id: 'corrupt-task', status: 'unknown-state' }];
    storage.set(DOWNLOAD_TASKS_STORAGE_KEY, corrupted);
    const snapshot = structuredClone(corrupted);

    await expect(listDownloadTasks()).rejects.toThrow();
    await expect(addDownloadTasks([item(2)], 'mp4')).rejects.toThrow();
    await expect(clearCompletedDownloadTasks()).rejects.toThrow();
    expect(storage.get(DOWNLOAD_TASKS_STORAGE_KEY)).toEqual(snapshot);

    // A failed read must not poison the serialization queue after explicit repair.
    storage.set(DOWNLOAD_TASKS_STORAGE_KEY, [valid]);
    expect(await addDownloadTasks([item(2)], 'mp4')).toHaveLength(2);
  });

  it('rejects capacity overflow atomically instead of dropping older tasks', async () => {
    const items = Array.from({ length: 999 }, (_, index) => item(index));
    const added = await addDownloadTasks(items, 'mp4');
    await replaceDownloadTask({ ...added[0]!, status: 'downloading' });
    const before = await listDownloadTasks();

    await expect(addDownloadTasks([item(999), item(1000)], 'mp4')).rejects.toThrow(/queue is full/i);
    expect(await listDownloadTasks()).toEqual(before);
    expect(storage.get(DOWNLOAD_TASKS_STORAGE_KEY)).toEqual(before);

    const full = await addDownloadTasks([item(999)], 'mp4');
    expect(full).toHaveLength(1000);
    expect(full[0]).toMatchObject({ id: added[0]!.id, status: 'downloading' });
    expect(await addDownloadTasks([item(0), item(999)], 'mp4')).toEqual(full);
    await expect(addDownloadTasks([item(1000)], 'mp4')).rejects.toThrow(/queue is full/i);
    expect(await listDownloadTasks()).toEqual(full);
  });

});
