import { z } from 'zod';

export const BROWSER_SOURCE_CHANNEL = 'open-media-downloader:browser-source:v1';
export const BROWSER_SOURCE_STATE_ATTRIBUTE = 'data-open-media-downloader-browser-source';
export const BROWSER_SOURCE_STATE_SELECTOR = `[${BROWSER_SOURCE_STATE_ATTRIBUTE}]`;
export const SOURCE_CHUNK_BYTES = 128 * 1024;
export const MAX_SOURCE_SEGMENT_BYTES = 32 * 1024 * 1024;
export const MAX_PROCESSED_SEGMENT_BYTES = 64 * 1024 * 1024;

export const browserSourceTargetSchema = z.object({
  providerId: z.literal('aliplayer'),
  mediaId: z.string().min(1).max(128),
  pageUrl: z.string().url(),
});
export type BrowserSourceTarget = z.infer<typeof browserSourceTargetSchema>;

export const browserSourceSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string().min(1).max(128),
  start: z.number().nonnegative(),
  duration: z.number().positive(),
});
export const browserSourcePlanSchema = z.object({
  sessionId: z.string().uuid(),
  fingerprint: z.string().min(1),
  durationSeconds: z.number().positive(),
  segments: browserSourceSegmentSchema.array().min(1).max(100_000),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});
export type BrowserSourcePlan = z.infer<typeof browserSourcePlanSchema>;

export const processedTrackSchema = z.object({
  initializationBytes: z.number().int().positive().max(1024 * 1024),
  initializationHash: z.string().min(1),
  mediaBytes: z.number().int().nonnegative().max(MAX_PROCESSED_SEGMENT_BYTES),
  startDTS: z.number(), endDTS: z.number(), startPTS: z.number(), endPTS: z.number(),
});
export const processedSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  networkBytes: z.number().int().nonnegative(),
  tracks: z.object({ audio: processedTrackSchema, video: processedTrackSchema }),
});
export type ProcessedSegment = z.infer<typeof processedSegmentSchema>;

export const browserSourceCommandSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('status') }),
  z.object({ method: z.literal('prepare'), mediaId: z.string().min(1).max(128) }),
  z.object({ method: z.literal('open'), mediaId: z.string().min(1).max(128), startIndex: z.number().int().nonnegative() }),
  z.object({ method: z.literal('process'), sessionId: z.string().uuid(), index: z.number().int().nonnegative() }),
  z.object({ method: z.literal('poll'), sessionId: z.string().uuid() }),
  z.object({ method: z.literal('read'), sessionId: z.string().uuid(),
    track: z.enum(['audio', 'video']), part: z.enum(['initialization', 'media']),
    offset: z.number().int().nonnegative(), length: z.number().int().positive().max(SOURCE_CHUNK_BYTES) }),
  z.object({ method: z.literal('ack'), sessionId: z.string().uuid(), index: z.number().int().nonnegative() }),
  z.object({ method: z.literal('close'), sessionId: z.string().uuid() }),
]);
export type BrowserSourceCommand = z.infer<typeof browserSourceCommandSchema>;

export const browserSourcePollSchema = z.object({
  state: z.enum(['idle', 'requesting', 'downloading', 'processing', 'ready', 'failed']),
  networkBytes: z.number().int().nonnegative(),
  result: processedSegmentSchema.optional(),
  error: z.string().max(160).optional(),
});
export type BrowserSourcePoll = z.infer<typeof browserSourcePollSchema>;

export const browserSourceStatusSchema = z.object({
  mediaId: z.string(),
  state: z.enum(['waiting', 'ready', 'protected', 'unsupported']),
  width: z.number().int().nonnegative(), height: z.number().int().nonnegative(),
  reason: z.enum(['ready', 'media-unavailable', 'player-unavailable', 'sdk-uninitialized', 'manifest-pending', 'processor-pending', 'metadata-pending', 'media-error', 'protected']).optional(),
  observedInstances: z.number().int().nonnegative().optional(),
  attachedInstances: z.number().int().nonnegative().optional(),
  mediaReadyState: z.number().int().min(0).max(4).optional(),
});
export type BrowserSourceStatus = z.infer<typeof browserSourceStatusSchema>;
export const browserSourceRpcSchema = z.object({ type: z.literal('browser-source:rpc'), owner: z.number().int().nonnegative(), command: browserSourceCommandSchema });
export const browserSourceReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string().max(160) }),
]);
