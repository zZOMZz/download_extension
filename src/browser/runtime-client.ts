import { z } from 'zod';
import { browser } from 'wxt/browser';
import { mediaCandidateSchema } from '~/src/shared/media';
import type { MediaCandidate, RuntimeRequest } from '~/src/shared/media';
import { pageDiscoveryResponseSchema, type DiscoveredMediaItem } from '~/src/shared/discovery';
import { downloadTaskSchema, type DownloadTask } from '~/src/shared/download-task';
import type { OutputFormat } from '~/src/shared/settings';
import { taskDiagnosticEventSchema, type TaskDiagnosticEvent } from '~/src/shared/task-diagnostics';

const candidateListResponseSchema = z.object({
  ok: z.literal(true),
  candidates: mediaCandidateSchema.array(),
});

const actionResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), downloadId: z.number().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const taskListResponseSchema = z.object({
  ok: z.literal(true),
  tasks: downloadTaskSchema.array(),
});

const taskReplaceResponseSchema = z.object({
  ok: z.literal(true),
  task: downloadTaskSchema,
});

const taskDiagnosticsResponseSchema = z.object({
  ok: z.literal(true),
  events: taskDiagnosticEventSchema.array(),
});

export async function listTabCandidates(tabId: number): Promise<MediaCandidate[]> {
  const response: unknown = await browser.runtime.sendMessage({
    type: 'candidate:list',
    tabId,
  } satisfies RuntimeRequest);
  return candidateListResponseSchema.parse(response).candidates;
}

export async function configureCandidateRequestAdapter(
  sourceTabId: number,
  candidateId: string,
): Promise<void> {
  await runRuntimeAction({
    type: 'request-adapter:configure',
    sourceTabId,
    candidateId,
  });
}

export async function configureManagerRequestAdapters(adapterIds: readonly string[]): Promise<void> {
  await runRuntimeAction({
    type: 'request-adapter:configure-manager',
    adapterIds: [...new Set(adapterIds)],
  });
}

export async function runRuntimeAction(request: RuntimeRequest): Promise<void> {
  const response: unknown = await browser.runtime.sendMessage(request);
  const parsed = actionResponseSchema.parse(response);
  if (!parsed.ok) throw new Error(parsed.error);
}

export async function scanTabForMedia(tabId: number): Promise<DiscoveredMediaItem[]> {
  const response: unknown = await browser.runtime.sendMessage({
    type: 'discovery:scan',
    tabId,
  } satisfies RuntimeRequest);
  const parsed = pageDiscoveryResponseSchema.parse(response);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.items;
}

export async function listPersistentDownloadTasks(): Promise<DownloadTask[]> {
  const response: unknown = await browser.runtime.sendMessage({ type: 'task:list' } satisfies RuntimeRequest);
  return taskListResponseSchema.parse(response).tasks;
}

export async function addPersistentDownloadTasks(
  items: DiscoveredMediaItem[],
  outputFormat: OutputFormat,
): Promise<DownloadTask[]> {
  const response: unknown = await browser.runtime.sendMessage({
    type: 'task:add',
    items,
    outputFormat,
  } satisfies RuntimeRequest);
  return taskListResponseSchema.parse(response).tasks;
}

export async function replacePersistentDownloadTask(task: DownloadTask): Promise<DownloadTask> {
  const response: unknown = await browser.runtime.sendMessage({
    type: 'task:replace',
    task,
  } satisfies RuntimeRequest);
  return taskReplaceResponseSchema.parse(response).task;
}

export async function removePersistentDownloadTask(taskId: string): Promise<void> {
  await runRuntimeAction({ type: 'task:remove', taskId });
}

export async function clearCompletedPersistentDownloadTasks(): Promise<void> {
  await runRuntimeAction({ type: 'task:clear-completed' });
}

export async function appendPersistentTaskDiagnosticEvent(event: TaskDiagnosticEvent): Promise<void> {
  await runRuntimeAction({ type: 'task:diagnostic:add', event });
}

export async function listPersistentTaskDiagnosticEvents(taskId: string): Promise<TaskDiagnosticEvent[]> {
  const response: unknown = await browser.runtime.sendMessage({
    type: 'task:diagnostic:list',
    taskId,
  } satisfies RuntimeRequest);
  return taskDiagnosticsResponseSchema.parse(response).events;
}
