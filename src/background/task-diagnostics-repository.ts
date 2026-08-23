import { browser } from 'wxt/browser';
import {
  MAX_TASK_DIAGNOSTIC_EVENTS,
  MAX_TOTAL_TASK_DIAGNOSTIC_EVENTS,
  TASK_DIAGNOSTICS_STORAGE_KEY,
  taskDiagnosticEventSchema,
  type TaskDiagnosticEvent,
} from '../shared/task-diagnostics';

const diagnosticsSchema = taskDiagnosticEventSchema.array();
let queue = Promise.resolve();

async function read(): Promise<TaskDiagnosticEvent[]> {
  const stored = await browser.storage.local.get(TASK_DIAGNOSTICS_STORAGE_KEY);
  const parsed = diagnosticsSchema.safeParse(stored[TASK_DIAGNOSTICS_STORAGE_KEY]);
  return parsed.success ? parsed.data : [];
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function write(events: TaskDiagnosticEvent[]): Promise<void> {
  await browser.storage.local.set({ [TASK_DIAGNOSTICS_STORAGE_KEY]: events });
}

export async function listTaskDiagnosticEvents(taskId: string): Promise<TaskDiagnosticEvent[]> {
  await queue;
  return (await read()).filter((event) => event.taskId === taskId);
}

export function appendTaskDiagnosticEvent(event: TaskDiagnosticEvent): Promise<TaskDiagnosticEvent> {
  return enqueue(async () => {
    const events = await read();
    events.push(taskDiagnosticEventSchema.parse(event));
    const currentTaskEvents = events.filter(({ taskId }) => taskId === event.taskId);
    const overflow = Math.max(0, currentTaskEvents.length - MAX_TASK_DIAGNOSTIC_EVENTS);
    let retained = events;
    if (overflow > 0) {
      const discarded = new Set(currentTaskEvents.slice(0, overflow).map(({ id }) => id));
      retained = events.filter(({ id }) => !discarded.has(id));
    }
    await write(retained.slice(-MAX_TOTAL_TASK_DIAGNOSTIC_EVENTS));
    return event;
  });
}

export function removeTaskDiagnosticEvents(taskId: string): Promise<void> {
  return enqueue(async () => {
    const events = await read();
    await write(events.filter((event) => event.taskId !== taskId));
  });
}
