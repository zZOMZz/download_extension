import type { DiscoveredMediaItem } from '~/src/shared/discovery';
import { bilibiliDiscoveryAdapter } from './adapters/bilibili';
import { twoRkDiscoveryAdapter } from './adapters/two-rk';
import type {
  DiscoveryResolveContext,
  DiscoveryScanContext,
  ResolvedDiscoveredMedia,
  SiteDiscoveryAdapter,
} from './types';

export const SITE_DISCOVERY_ADAPTERS: readonly SiteDiscoveryAdapter[] = Object.freeze([
  twoRkDiscoveryAdapter,
  bilibiliDiscoveryAdapter,
]);

function uniqueMatch(
  adapters: readonly SiteDiscoveryAdapter[],
  predicate: (adapter: SiteDiscoveryAdapter) => boolean,
  description: string,
): SiteDiscoveryAdapter | undefined {
  const matches = adapters.filter(predicate);
  if (matches.length > 1) {
    throw new Error(`Multiple site discovery adapters matched ${description}: ${matches.map(({ id }) => id).join(', ')}`);
  }
  return matches[0];
}

export function findSiteDiscoveryAdapter(
  pageUrl: URL,
  adapters: readonly SiteDiscoveryAdapter[] = SITE_DISCOVERY_ADAPTERS,
): SiteDiscoveryAdapter | undefined {
  return uniqueMatch(adapters, (adapter) => adapter.matches(pageUrl), pageUrl.href);
}

export function supportsSiteDiscovery(rawUrl: string): boolean {
  try {
    return Boolean(findSiteDiscoveryAdapter(new URL(rawUrl)));
  } catch {
    return false;
  }
}

export async function discoverMediaItems(
  document: Document,
  pageUrl: URL,
  context?: DiscoveryScanContext,
): Promise<DiscoveredMediaItem[]> {
  return await findSiteDiscoveryAdapter(pageUrl)?.discover(document, pageUrl, context) ?? [];
}

export async function resolveDiscoveredMedia(
  item: DiscoveredMediaItem,
  context: DiscoveryResolveContext,
  adapters: readonly SiteDiscoveryAdapter[] = SITE_DISCOVERY_ADAPTERS,
): Promise<ResolvedDiscoveredMedia> {
  const adapter = uniqueMatch(adapters, ({ id }) => id === item.adapterId, `adapter id ${item.adapterId}`);
  if (!adapter) throw new Error(`No site discovery adapter is registered for ${item.adapterId}.`);
  return adapter.resolve(item, context);
}
