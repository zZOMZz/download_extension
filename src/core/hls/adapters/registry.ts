import { twoRkHlsAdapter } from './two-rk';
import type { HlsAes128KeyAdapter, HlsSiteAdapter, HlsSiteAdapterMatchContext } from './types';

export const HLS_SITE_ADAPTERS: readonly HlsSiteAdapter[] = Object.freeze([twoRkHlsAdapter]);

function hasAes128KeyResolver(adapter: HlsSiteAdapter): adapter is HlsAes128KeyAdapter {
  return typeof adapter.resolveAes128Key === 'function';
}

export function findHlsAes128KeyAdapter(
  context: HlsSiteAdapterMatchContext,
  adapters: readonly HlsSiteAdapter[] = HLS_SITE_ADAPTERS,
): HlsAes128KeyAdapter | undefined {
  const matches = adapters.filter(
    (adapter): adapter is HlsAes128KeyAdapter => hasAes128KeyResolver(adapter) && adapter.matches(context),
  );

  if (matches.length > 1) {
    throw new Error(`Multiple HLS site adapters matched this key: ${matches.map(({ id }) => id).join(', ')}`);
  }
  return matches[0];
}
