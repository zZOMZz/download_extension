import type { HlsSiteAdapter } from './types';

const IDENTIFIER = '[A-Za-z_$][\\w$]*';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isTwoRkDecoyKey(uri: URL): boolean {
  return (uri.hostname === '2rk.cc' || uri.hostname === 'www.2rk.cc') && uri.pathname === '/saber';
}

/**
 * Extracts the fixed AES key used by 2rk.cc's customized hls.js build.
 *
 * The player constructs a 16-byte ArrayBuffer and fills it through a DataView.
 * We only parse literal byte assignments; the remote script is never executed.
 */
export function extractTwoRkPlayerKey(source: string): Uint8Array | undefined {
  const declaration = new RegExp(
    `(?:var|let|const)\\s+(${IDENTIFIER})\\s*=\\s*new ArrayBuffer\\(16\\)\\s*,\\s*(${IDENTIFIER})\\s*=\\s*new DataView\\(\\1\\)`,
    'g',
  );

  for (const match of source.matchAll(declaration)) {
    const viewName = match[2];
    if (!viewName || match.index === undefined) continue;

    const scan = source.slice(match.index, match.index + 20_000);
    const escapedViewName = escapeRegExp(viewName);
    const assignment = new RegExp(
      `\\b${escapedViewName}(?:\\.setUint8|\\[[^\\]]+\\])\\(\\s*(\\d{1,2})\\s*,\\s*(\\d{1,3})\\s*\\)`,
      'g',
    );
    const keyReference = new RegExp(
      `this(?:\\.${IDENTIFIER}|\\[[^\\]]+\\])\\s*=\\s*${escapedViewName}(?:\\.buffer|\\[[^\\]]+\\])`,
    );
    if (!keyReference.test(scan)) continue;

    const bytes = new Uint8Array(16);
    const assigned = new Set<number>();
    for (const byteMatch of scan.matchAll(assignment)) {
      const index = Number.parseInt(byteMatch[1] ?? '', 10);
      const value = Number.parseInt(byteMatch[2] ?? '', 10);
      if (index < 0 || index > 15 || value < 0 || value > 255) continue;
      bytes[index] = value;
      assigned.add(index);
      if (assigned.size === 16) return bytes;
    }
  }

  return undefined;
}

export const twoRkHlsAdapter: HlsSiteAdapter = {
  id: '2rk-player-embedded-key',
  matches: ({ resourceUrl }) => isTwoRkDecoyKey(resourceUrl),
  async resolveAes128Key({ keyUri, loadText, signal }) {
    try {
      const playerSource = await loadText(new URL('/h.js', keyUri).href, signal);
      const embeddedKey = extractTwoRkPlayerKey(playerSource);
      if (embeddedKey) return embeddedKey;
      throw new Error('The player script does not contain the expected embedded key structure.');
    } catch (cause) {
      throw new Error(
        'This 2rk.cc stream uses a player-embedded AES key, but the key could not be resolved.',
        { cause },
      );
    }
  },
};
