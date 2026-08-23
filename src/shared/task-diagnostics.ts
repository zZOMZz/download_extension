import { z } from 'zod';

export const downloadFailureCategorySchema = z.enum([
  'network',
  'http',
  'timeout',
  'source',
  'manifest',
  'encryption',
  'filesystem',
  'output',
  'unsupported',
  'cancelled',
  'unknown',
]);

export const downloadFailureSchema = z.object({
  category: downloadFailureCategorySchema,
  code: z.string().min(1),
  message: z.string().min(1),
  recoverable: z.boolean(),
  occurredAt: z.number().int().nonnegative(),
  causeName: z.string().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  resourceKind: z.enum(['text', 'media-segment', 'encryption-key', 'initialization-segment']).optional(),
  resourceHost: z.string().optional(),
  resourcePath: z.string().optional(),
});

export const taskDiagnosticEventCodeSchema = z.enum([
  'manager-interrupted',
  'resolve-started',
  'source-resolved',
  'manifest-loaded',
  'output-opened',
  'resume-prepared',
  'download-started',
  'request-retry',
  'checkpoint-saved',
  'recovery-scheduled',
  'finalize-started',
  'task-completed',
  'task-failed',
  'task-cancelled',
  'manual-retry',
  'manual-restart',
]);

export const taskDiagnosticEventSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  at: z.number().int().nonnegative(),
  level: z.enum(['info', 'warning', 'error']),
  code: taskDiagnosticEventCodeSchema,
  message: z.string().optional(),
  resourceKind: z.enum(['text', 'media-segment', 'encryption-key', 'initialization-segment']).optional(),
  resourceHost: z.string().optional(),
  resourcePath: z.string().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  attempt: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
  delayMs: z.number().int().nonnegative().optional(),
  segment: z.number().int().positive().optional(),
  totalSegments: z.number().int().positive().optional(),
  completedSegments: z.number().int().nonnegative().optional(),
  bytesWritten: z.number().int().nonnegative().optional(),
  recoveryAttempt: z.number().int().positive().optional(),
  nextRetryAt: z.number().int().nonnegative().optional(),
  filename: z.string().optional(),
  directoryName: z.string().optional(),
});

export const TASK_DIAGNOSTICS_STORAGE_KEY = 'download-task-diagnostics:v1';
export const MAX_TASK_DIAGNOSTIC_EVENTS = 160;
export const MAX_TOTAL_TASK_DIAGNOSTIC_EVENTS = 4_000;

export type DownloadFailure = z.infer<typeof downloadFailureSchema>;
export type DownloadFailureCategory = z.infer<typeof downloadFailureCategorySchema>;
export type TaskDiagnosticEvent = z.infer<typeof taskDiagnosticEventSchema>;
export type TaskDiagnosticEventCode = z.infer<typeof taskDiagnosticEventCodeSchema>;

export function createTaskDiagnosticEvent(
  input: Omit<TaskDiagnosticEvent, 'id' | 'at'> & { id?: string; at?: number },
): TaskDiagnosticEvent {
  return taskDiagnosticEventSchema.parse({
    ...input,
    ...(input.message ? { message: sanitizeDiagnosticText(input.message) } : {}),
    id: input.id ?? crypto.randomUUID(),
    at: input.at ?? Date.now(),
  });
}

export function sanitizeDiagnosticText(value: string): string {
  return value.replace(/https?:\/\/[^\s)\]}>]+/gi, (match) => {
    const trailingPunctuation = /[.,;:]$/.test(match) ? match.slice(-1) : '';
    const candidate = trailingPunctuation ? match.slice(0, -1) : match;
    try {
      const url = new URL(candidate);
      return `${url.origin}${url.pathname}${trailingPunctuation}`;
    } catch {
      return '[redacted URL]';
    }
  });
}

export function diagnosticResource(rawUrl: string): { resourceHost?: string; resourcePath?: string } {
  try {
    const url = new URL(rawUrl);
    return { resourceHost: url.host, resourcePath: url.pathname };
  } catch {
    return {};
  }
}
