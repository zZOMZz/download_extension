export type TextResourceLoader = (url: string, signal?: AbortSignal) => Promise<string>;

export interface HlsSiteAdapterMatchContext {
  resourceUrl: URL;
}

export interface HlsAes128KeyAdapterContext {
  downloadedBytes: Uint8Array;
  keyUri: URL;
  loadText: TextResourceLoader;
  signal?: AbortSignal;
}

export interface HlsSiteAdapter {
  readonly id: string;
  matches(context: HlsSiteAdapterMatchContext): boolean;
  resolveAes128Key?(context: HlsAes128KeyAdapterContext): Promise<Uint8Array>;
}

export type HlsAes128KeyAdapter = HlsSiteAdapter &
  Required<Pick<HlsSiteAdapter, 'resolveAes128Key'>>;
