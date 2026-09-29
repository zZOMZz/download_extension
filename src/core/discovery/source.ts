import type { MediaKind, DashMediaSource } from '../../shared/media';
import type { BrowserSourceTarget } from '../../shared/browser-source';

export interface ResolvedDiscoveredMedia {
  kind: Exclude<MediaKind, 'blob'>;
  url: string;
  title: string;
  dash?: DashMediaSource;
  browserSource?: BrowserSourceTarget;
}

export interface DiscoveryResolveContext {
  fetchText(url: string, signal?: AbortSignal): Promise<string>;
  signal?: AbortSignal;
}
