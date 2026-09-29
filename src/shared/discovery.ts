import { z } from 'zod';

export const discoveredMediaItemSchema = z.object({
  id: z.string().min(1),
  adapterId: z.string().min(1),
  pageUrl: z.string().url(),
  title: z.string().min(1),
  mediaKind: z.enum(['hls', 'dash', 'progressive']).optional(),
  executionMode: z.literal('browser-session').optional(),
  seriesTitle: z.string().min(1).optional(),
  sequence: z.number().int().nonnegative().optional(),
});

export type DiscoveredMediaItem = z.infer<typeof discoveredMediaItemSchema>;

export const pageDiscoveryRequestSchema = z.object({
  type: z.literal('page:discover'),
});

export const pageDiscoveryResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), items: discoveredMediaItemSchema.array() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
