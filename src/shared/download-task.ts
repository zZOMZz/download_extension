import { z } from 'zod';
import { discoveredMediaItemSchema } from './discovery';
import { outputFormatSchema } from './settings';
import { downloadFailureSchema } from './task-diagnostics';

export const DOWNLOAD_TASKS_STORAGE_KEY = 'download-tasks:v1';

export const downloadTaskStatusSchema = z.enum([
  'queued',
  'resolving',
  'downloading',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);

export const downloadTaskProgressSchema = z.object({
  completedSegments: z.number().int().nonnegative(),
  totalSegments: z.number().int().nonnegative(),
  bytesWritten: z.number().int().nonnegative(),
  phase: z.enum(['requesting', 'downloading', 'decrypting', 'processing', 'finalizing', 'retrying', 'completed']).optional(),
  networkBytesReceived: z.number().int().nonnegative().optional(),
  currentSegment: z.number().int().positive().optional(),
  currentSegmentBytesReceived: z.number().int().nonnegative().optional(),
  currentSegmentBytesTotal: z.number().int().nonnegative().optional(),
  currentSpeedBytesPerSecond: z.number().nonnegative().optional(),
  averageSpeedBytesPerSecond: z.number().nonnegative().optional(),
  estimatedSecondsRemaining: z.number().nonnegative().optional(),
  retryAttempt: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
  retryDelayMs: z.number().int().nonnegative().optional(),
  retryReason: z.string().optional(),
  lastSegmentDurationMs: z.number().nonnegative().optional(),
});

export const downloadCheckpointSchema = z.object({
  version: z.literal(1),
  playlistFingerprint: z.string().min(1),
  directoryName: z.string().min(1),
  directoryHandleId: z.string().min(1).optional(),
  partialFilename: z.string().min(1),
  finalFilename: z.string().min(1),
  completedSegments: z.number().int().nonnegative(),
  totalSegments: z.number().int().positive(),
  bytesWritten: z.number().int().nonnegative(),
  segmentEndOffsets: z.array(z.number().int().nonnegative()),
  updatedAt: z.number().int().nonnegative(),
});

export const downloadTaskSchema = z.object({
  id: z.string().min(1),
  source: discoveredMediaItemSchema,
  outputFormat: outputFormatSchema,
  status: downloadTaskStatusSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  progress: downloadTaskProgressSchema.optional(),
  checkpoint: downloadCheckpointSchema.optional(),
  recoveryAttempt: z.number().int().nonnegative().optional(),
  nextRetryAt: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  failure: downloadFailureSchema.optional(),
});

export type DownloadTask = z.infer<typeof downloadTaskSchema>;
export type DownloadTaskStatus = z.infer<typeof downloadTaskStatusSchema>;
export type DownloadTaskProgress = z.infer<typeof downloadTaskProgressSchema>;
export type DownloadCheckpoint = z.infer<typeof downloadCheckpointSchema>;
