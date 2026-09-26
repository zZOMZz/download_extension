import type { DiscoveredMediaItem } from '../../shared/discovery';

export type { ResolvedDiscoveredMedia, DiscoveryResolveContext } from './source';
import type { ResolvedDiscoveredMedia, DiscoveryResolveContext } from './source';

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
