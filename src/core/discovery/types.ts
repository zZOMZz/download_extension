import type { DiscoveredMediaItem } from '~/src/shared/discovery';
import type { MediaKind } from '~/src/shared/media';
import type { DashMediaSource } from '~/src/shared/media';

export interface ResolvedDiscoveredMedia {
  kind: Exclude<MediaKind, 'blob'>;
  url: string;
  title: string;
  dash?: DashMediaSource;
}

export interface DiscoveryResolveContext {
  fetchText(url: string, signal?: AbortSignal): Promise<string>;
  signal?: AbortSignal;
}

export interface DiscoveryScanContext {
  fetchText(url: string, signal?: AbortSignal): Promise<string>;
  signal?: AbortSignal;
}

export interface SiteDiscoveryAdapter {
  readonly id: string;
  matches(pageUrl: URL): boolean;
  discover(
    document: Document,
    pageUrl: URL,
    context?: DiscoveryScanContext,
  ): DiscoveredMediaItem[] | Promise<DiscoveredMediaItem[]>;
  resolve(item: DiscoveredMediaItem, context: DiscoveryResolveContext): Promise<ResolvedDiscoveredMedia>;
}
