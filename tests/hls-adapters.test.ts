import { describe, expect, it, vi } from 'vitest';
import { findHlsAes128KeyAdapter } from '../src/core/hls/adapters/registry';
import { twoRkHlsAdapter } from '../src/core/hls/adapters/two-rk';
import type { HlsSiteAdapter } from '../src/core/hls/adapters/types';
import { resolveHlsAes128Key } from '../src/core/hls/key-resolver';

describe('HLS site adapter registry', () => {
  it('keeps the 2rk rule limited to the exact host and key path', () => {
    expect(twoRkHlsAdapter.matches({ resourceUrl: new URL('https://www.2rk.cc/saber') })).toBe(true);
    expect(twoRkHlsAdapter.matches({ resourceUrl: new URL('https://2rk.cc/saber') })).toBe(true);
    expect(twoRkHlsAdapter.matches({ resourceUrl: new URL('https://cdn.2rk.cc/saber') })).toBe(false);
    expect(twoRkHlsAdapter.matches({ resourceUrl: new URL('https://not2rk.cc/saber') })).toBe(false);
    expect(twoRkHlsAdapter.matches({ resourceUrl: new URL('https://www.2rk.cc/saber/') })).toBe(false);
    expect(twoRkHlsAdapter.matches({ resourceUrl: new URL('https://www.2rk.cc/other') })).toBe(false);
  });

  it('prefers a standard 16-byte key without consulting adapters', async () => {
    const standardKey = new Uint8Array(16);
    const matches = vi.fn(() => true);
    const resolveAes128Key = vi.fn(async () => new Uint8Array(16).fill(1));
    const adapter: HlsSiteAdapter = { id: 'must-not-run', matches, resolveAes128Key };

    const resolved = await resolveHlsAes128Key({
      downloadedBytes: standardKey,
      keyUri: 'https://www.2rk.cc/saber',
      loadText: vi.fn(),
      adapters: [adapter],
    });

    expect(resolved).toBe(standardKey);
    expect(matches).not.toHaveBeenCalled();
    expect(resolveAes128Key).not.toHaveBeenCalled();
  });

  it('returns a non-standard key untouched when no adapter matches', async () => {
    const downloadedBytes = new Uint8Array(31);
    const loadText = vi.fn();

    const resolved = await resolveHlsAes128Key({
      downloadedBytes,
      keyUri: 'https://cdn.example/saber',
      loadText,
    });

    expect(resolved).toBe(downloadedBytes);
    expect(loadText).not.toHaveBeenCalled();
  });

  it('fails when overlapping adapters match the same key', () => {
    const adapter = (id: string): HlsSiteAdapter => ({
      id,
      matches: () => true,
      resolveAes128Key: async ({ downloadedBytes }) => downloadedBytes,
    });

    expect(() =>
      findHlsAes128KeyAdapter(
        { resourceUrl: new URL('https://cdn.example/key') },
        [adapter('first'), adapter('second')],
      ),
    ).toThrow('Multiple HLS site adapters matched this key: first, second');
  });
});
