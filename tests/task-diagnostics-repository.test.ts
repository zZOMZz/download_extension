import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TASK_DIAGNOSTIC_EVENTS,
  createTaskDiagnosticEvent,
} from '../src/shared/task-diagnostics';

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
  appendTaskDiagnosticEvent,
  listTaskDiagnosticEvents,
  removeTaskDiagnosticEvents,
} from '../src/background/task-diagnostics-repository';

beforeEach(() => storage.clear());

describe('task diagnostics repository', () => {
  it('keeps a bounded event history per task and removes it with the task', async () => {
    for (let index = 0; index < MAX_TASK_DIAGNOSTIC_EVENTS + 2; index += 1) {
      await appendTaskDiagnosticEvent(createTaskDiagnosticEvent({
        id: `event-${index}`,
        at: index,
        taskId: 'task-1',
        code: 'checkpoint-saved',
        level: 'info',
        completedSegments: index,
        totalSegments: MAX_TASK_DIAGNOSTIC_EVENTS + 2,
      }));
    }

    const events = await listTaskDiagnosticEvents('task-1');
    expect(events).toHaveLength(MAX_TASK_DIAGNOSTIC_EVENTS);
    expect(events[0]?.id).toBe('event-2');

    await removeTaskDiagnosticEvents('task-1');
    expect(await listTaskDiagnosticEvents('task-1')).toEqual([]);
  });
});
