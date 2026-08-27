import { z } from 'zod';
import { discoveredMediaItemSchema } from './discovery';
import { downloadTaskSchema } from './download-task';
import { outputFormatSchema } from './settings';
import { taskDiagnosticEventSchema } from './task-diagnostics';

export const mediaKindSchema = z.enum(['progressive', 'hls', 'dash', 'blob']);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const candidateSourceSchema = z.enum(['network', 'dom', 'performance']);
export type CandidateSource = z.infer<typeof candidateSourceSchema>;

export const dashByteRangeSchema = z.object({
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
});

export const dashResourceSchema = z.object({
  url: z.string().url(),
  alternativeUrls: z.string().url().array().optional(),
  byteRange: dashByteRangeSchema.optional(),
});

export const dashTrackSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['video', 'audio']),
  bandwidth: z.number().int().nonnegative().optional(),
  mimeType: z.string().optional(),
  codecs: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frameRate: z.number().positive().optional(),
  initialization: dashResourceSchema,
  index: dashResourceSchema.optional(),
  segments: dashResourceSchema.array().optional(),
});

export const dashMediaSourceSchema = z.object({
  type: z.enum(['static', 'dynamic']),
  durationSeconds: z.number().nonnegative().optional(),
  hasContentProtection: z.boolean(),
  tracks: dashTrackSchema.array(),
});

export type DashByteRange = z.infer<typeof dashByteRangeSchema>;
export type DashResource = z.infer<typeof dashResourceSchema>;
export type DashTrack = z.infer<typeof dashTrackSchema>;
export type DashMediaSource = z.infer<typeof dashMediaSourceSchema>;

export const mediaCandidateSchema = z.object({
  id: z.string().min(1),
  tabId: z.number().int(),
  frameId: z.number().int(),
  kind: mediaKindSchema,
  source: candidateSourceSchema,
  url: z.string().min(1),
  title: z.string().optional(),
  mimeType: z.string().optional(),
  contentLength: z.number().int().nonnegative().optional(),
  detectedAt: z.number().int().nonnegative(),
  siteAdapterId: z.string().min(1).optional(),
  dash: dashMediaSourceSchema.optional(),
});

export type MediaCandidate = z.infer<typeof mediaCandidateSchema>;

export const candidateObservationSchema = mediaCandidateSchema.omit({
  id: true,
  tabId: true,
  frameId: true,
  detectedAt: true,
});

export type CandidateObservation = z.infer<typeof candidateObservationSchema>;

export const runtimeRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('candidate:observe'),
    candidate: candidateObservationSchema,
  }),
  z.object({
    type: z.literal('candidate:list'),
    tabId: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('candidate:clear'),
    tabId: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('download:direct'),
    candidateId: z.string().min(1),
    tabId: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('downloader:open'),
    candidateId: z.string().min(1),
    tabId: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('request-adapter:configure'),
    candidateId: z.string().min(1),
    sourceTabId: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('request-adapter:configure-manager'),
    adapterIds: z.string().min(1).array(),
  }),
  z.object({
    type: z.literal('manager:open'),
    tabId: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('discovery:scan'),
    tabId: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('task:list'),
  }),
  z.object({
    type: z.literal('task:add'),
    items: discoveredMediaItemSchema.array(),
    outputFormat: outputFormatSchema,
  }),
  z.object({
    type: z.literal('task:replace'),
    task: downloadTaskSchema,
  }),
  z.object({
    type: z.literal('task:remove'),
    taskId: z.string().min(1),
  }),
  z.object({
    type: z.literal('task:clear-completed'),
  }),
  z.object({
    type: z.literal('task:diagnostic:add'),
    event: taskDiagnosticEventSchema,
  }),
  z.object({
    type: z.literal('task:diagnostic:list'),
    taskId: z.string().min(1),
  }),
]);

export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;

export function candidateIdentity(candidate: Pick<MediaCandidate, 'kind' | 'url'>): string {
  return `${candidate.kind}\u0000${candidate.url}`;
}
