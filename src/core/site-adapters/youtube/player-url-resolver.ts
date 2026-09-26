interface PlayerUrl {
  get(name: string): unknown;
}

type PlayerUrlConstructor = new (url: string, transform: boolean) => PlayerUrl;

/** Locate the URL class used by the already loaded player's n/signature wrapper. */
export function findYouTubePlayerUrlConstructorName(playerSource: string): string | undefined {
  // The property name changes between player builds and between ES6/legacy bundles.
  const match = /\b([\w$]+)\s*=\s*new\s+[\w$]+\.([\w$]+)\(\s*\1\s*,\s*(?:!0|true)\s*\)\s*;\s*\1\.set\(\s*(['"])alr\3\s*,\s*(['"])yes\4\s*\)/.exec(playerSource);
  return match?.[2];
}

function playerUrlConstructor(playerNamespace: unknown, playerSource: string): PlayerUrlConstructor | undefined {
  if (!playerNamespace || typeof playerNamespace !== 'object') return undefined;
  const name = findYouTubePlayerUrlConstructorName(playerSource);
  if (!name) return undefined;
  const constructor: unknown = Object.getOwnPropertyDescriptor(playerNamespace, name)?.value;
  if (typeof constructor !== 'function') return undefined;
  const prototype: unknown = Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value;
  if (!prototype || typeof prototype !== 'object') return undefined;
  for (const method of ['get', 'set', 'clone']) {
    if (typeof Object.getOwnPropertyDescriptor(prototype, method)?.value !== 'function') return undefined;
  }
  return constructor as PlayerUrlConstructor;
}

/**
 * Reuse the page's own URL class without evaluating downloaded player source.
 * Ciphered signatures remain on the observed-request path; this only resolves n.
 */
export function resolveYouTubePlayerUrl(
  rawUrl: string,
  playerNamespace: unknown,
  playerSource: string,
): string | undefined {
  if (rawUrl !== rawUrl.trim()) return undefined;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' ||
      (url.hostname !== 'googlevideo.com' && !url.hostname.endsWith('.googlevideo.com'))) {
      return undefined;
    }
    if (url.pathname !== '/videoplayback') return undefined;
    const values = url.searchParams.getAll('n');
    if (!values.length) return rawUrl;
    const input = values[0];
    if (values.length !== 1 || !input) return undefined;
    const signed = [
      ...(url.searchParams.get('sparams') ?? '').split(','),
      ...(url.searchParams.get('lsparams') ?? '').split(','),
    ];
    if (signed.includes('n')) return undefined;
    const Constructor = playerUrlConstructor(playerNamespace, playerSource);
    if (!Constructor) return undefined;
    // get() triggers the player's lazy URL parsing and n transformation.
    const value = new Constructor(rawUrl, true).get('n');
    if (typeof value !== 'string' || !value) return undefined;
    const resolved = decodeURIComponent(value);
    if (!resolved || resolved === input || resolved.startsWith('enhanced_except_')) return undefined;

    // Re-serializing URLSearchParams can change signed query bytes. Replace only n.
    const hashIndex = rawUrl.indexOf('#');
    const hash = hashIndex >= 0 ? rawUrl.slice(hashIndex) : '';
    const withoutHash = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;
    const queryIndex = withoutHash.indexOf('?');
    const query = withoutHash.slice(queryIndex + 1).split('&').map((part) => {
      const equals = part.indexOf('=');
      const name = equals >= 0 ? part.slice(0, equals) : part;
      return decodeURIComponent(name.replace(/\+/g, ' ')) === 'n'
        ? `${name}=${encodeURIComponent(resolved)}`
        : part;
    }).join('&');
    return `${withoutHash.slice(0, queryIndex + 1)}${query}${hash}`;
  } catch {
    return undefined;
  }
}
