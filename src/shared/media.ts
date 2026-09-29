import { z } from 'zod';
import { browserSourceTargetSchema, browserSourceCommandSchema } from './browser-source';
import { discoveredMediaItemSchema } from './discovery';
import { downloadTaskSchema } from './download-task';
import { outputFormatSchema } from './settings';
import { taskDiagnosticEventSchema } from './task-diagnostics';

export const mediaKindSchema = z.enum(['progressive', 'hls', 'dash', 'sabr', 'blob']);
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

export const youtubeSabrFormatSchema = z.object({
  itag: z.number().int().positive(),
  mimeType: z.string().regex(/^(?:video|audio)\/mp4(?:\s*;|$)/i),
  lastModified: z.string().regex(/^\d+$/),
  bitrate: z.number().positive(),
  approxDurationMs: z.number().positive(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  averageBitrate: z.number().positive().optional(),
  contentLength: z.number().int().positive().optional(),
  xtags: z.string().optional(),
  audioTrack: z.object({
    id: z.string().min(1),
    displayName: z.string().optional(),
    audioIsDefault: z.boolean().optional(),
  }).optional(),
});

export const youtubeSabrSourceSchema = z.object({
  videoId: z.string().regex(/^[0-9A-Za-z_-]{11}$/),
  durationSeconds: z.number().positive(),
  serverAbrStreamingUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.googlevideo.com') &&
      url.pathname === '/videoplayback' && Boolean(url.searchParams.get('id'));
  }),
  formats: youtubeSabrFormatSchema.array().min(2),
});

export type YouTubeSabrFormat = z.infer<typeof youtubeSabrFormatSchema>;
export type YouTubeSabrSource = z.infer<typeof youtubeSabrSourceSchema>;

export const mediaCandidateSchema = z.object({
  id: z.string().min(1),
  tabId: z.number().int(),
  frameId: z.number().int(),
  kind: mediaKindSchema,
  source: candidateSourceSchema,
  url: z.string().min(1),
  title: z.string().optional(),
  thumbnailUrl: z.string().url().optional(),
  mimeType: z.string().optional(),
  contentLength: z.number().int().nonnegative().optional(),
  detectedAt: z.number().int().nonnegative(),
  siteAdapterId: z.string().min(1).optional(),
  sourcePageUrl: z.string().url().optional(),
  isPreview: z.boolean().optional(),
  hasContentProtection: z.boolean().optional(),
  dash: dashMediaSourceSchema.optional(),
  youtubeSabr: youtubeSabrSourceSchema.optional(),
  browserSource: browserSourceTargetSchema.optional(),
});

export type MediaCandidate = z.infer<typeof mediaCandidateSchema>;

export const candidateObservationSchema = mediaCandidateSchema.omit({
  id: true,
  tabId: true,
  frameId: true,
  detectedAt: true,
});

export type CandidateObservation = z.infer<typeof candidateObservationSchema>;

export const adapterResourceObservationSchema = z.object({
  type: z.literal('adapter:resource-observed'),
  url: z.string().url(),
});

export type AdapterResourceObservation = z.infer<typeof adapterResourceObservationSchema>;

export const runtimeRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('browser-source:relay'), sourceTabId: z.number().int().nonnegative(), command: browserSourceCommandSchema }),
  z.object({
    type: z.literal('youtube-sabr:observe'),
    url: z.string().url().max(16 * 1_024),
    videoId: z.string().regex(/^[\w-]{11}$/),
    bodyBase64: z.string().min(1).max(349_528),
  }),
  z.object({
    type: z.literal('youtube-sabr:context'),
    sourceTabId: z.number().int().nonnegative(),
    candidateId: z.string().min(1),
  }),
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
    videoTrackId: z.string().min(1).optional(),
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
    type: z.literal('task:diagnostic:add'),
    event: taskDiagnosticEventSchema,
  }),
  z.object({
    type: z.literal('task:diagnostic:list'),
    taskId: z.string().min(1),
  }),
]);

export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;

export function candidateIdentity(
  candidate: Pick<MediaCandidate, 'kind' | 'url' | 'siteAdapterId' | 'sourcePageUrl' | 'browserSource'>,
): string {
  if (candidate.browserSource) return `browser-source\u0000${candidate.browserSource.providerId}\u0000${candidate.browserSource.mediaId}`;
  if (candidate.siteAdapterId === 'bilibili' && candidate.sourcePageUrl) {
    try {
      const page = new URL(candidate.sourcePageUrl);
      const part = page.searchParams.get('p') || '1';
      return `bilibili\u0000${page.origin}${page.pathname.replace(/\/$/, '')}\u0000${part}`;
    } catch { /* Use resource identity for invalid legacy candidates. */ }
  }
  if (candidate.siteAdapterId === 'youtube') {
    const pageUrl = candidate.sourcePageUrl ?? (candidate.kind === 'dash' || candidate.kind === 'sabr' ? candidate.url : undefined);
    if (pageUrl) return `youtube\u0000${pageUrl}`;
  }
  return `${candidate.kind}\u0000${candidate.url}`;
}
