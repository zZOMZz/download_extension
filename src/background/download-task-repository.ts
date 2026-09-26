import { browser } from 'wxt/browser';
import {
  DOWNLOAD_TASKS_STORAGE_KEY,
  downloadTaskSchema,
  type DownloadTask,
} from '../shared/download-task';
import type { DiscoveredMediaItem } from '../shared/discovery';
import type { OutputFormat } from '../shared/settings';

let queue = Promise.resolve();

async function read(): Promise<DownloadTask[]> {
  const stored = await browser.storage.local.get(DOWNLOAD_TASKS_STORAGE_KEY);
  const value = stored[DOWNLOAD_TASKS_STORAGE_KEY];
  if (value === undefined) return [];
  // Invalid persisted state must not silently become an empty queue on the next write.
  return downloadTaskSchema.array().parse(value);
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function write(tasks: DownloadTask[]): Promise<void> {
  await browser.storage.local.set({ [DOWNLOAD_TASKS_STORAGE_KEY]: tasks });
}

export async function listDownloadTasks(): Promise<DownloadTask[]> {
  await queue;
  return read();
}

export function addDownloadTasks(
  items: DiscoveredMediaItem[],
  outputFormat: OutputFormat,
): Promise<DownloadTask[]> {
  return enqueue(async () => {
    const tasks = await read();
    const existingSourceIds = new Set(tasks.map(({ source }) => source.id));
    const now = Date.now();
    for (const item of items) {
      if (existingSourceIds.has(item.id)) continue;
      tasks.push({
        id: crypto.randomUUID(),
        source: item,
        outputFormat,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      });
      existingSourceIds.add(item.id);
    }
    tasks.sort((left, right) => left.createdAt - right.createdAt);
    if (tasks.length > 1000) throw new Error('The task queue is full (1000 tasks). Clear completed tasks before adding more.');
    await write(tasks);
    return tasks;
  });
}

export function replaceDownloadTask(task: DownloadTask): Promise<DownloadTask> {
  return enqueue(async () => {
    const tasks = await read();
    const index = tasks.findIndex(({ id }) => id === task.id);
    if (index < 0) throw new Error('The download task no longer exists.');
    const updated = { ...task, updatedAt: Date.now() };
    tasks[index] = updated;
    await write(tasks);
    return updated;
  });
}

export function removeDownloadTask(taskId: string): Promise<void> {
  return enqueue(async () => {
    const tasks = await read();
    await write(tasks.filter(({ id }) => id !== taskId));
  });
}

export function clearCompletedDownloadTasks(): Promise<void> {
  return enqueue(async () => {
    const tasks = await read();
    await write(tasks.filter(({ status }) => status !== 'completed'));
  });
}
