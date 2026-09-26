import type { MediaKind, DashMediaSource } from '../../shared/media';

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

