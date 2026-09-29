import { describe, expect, it } from 'vitest';
import { koalaDiscoveryAdapter, koalaItem } from '../src/core/discovery/adapters/koala';
import { koalaVideoId } from '../src/core/site-adapters/koala/identity';
import { suppressesGenericMedia } from '../src/core/detection/adapters/registry';
import { koalaDetectionAdapter } from '../src/core/detection/adapters/koala';
import { BROWSER_SOURCE_STATE_SELECTOR } from '../src/shared/browser-source';

const id = 'a38d4ed3-873b-4110-bf51-02f3a6319f2c', url = `https://app.koala-oss.club/videos/${id}`;
describe('Koala adapters', () => {
  it('isolates exact origin and UUID video routes', () => {
    expect(koalaVideoId(url)).toBe(id);
    for (const other of [url.replace('app.', 'cdn.'), `${url}/extra`, url.replace('https:', 'http:'), url.replace('koala-oss.club', 'koala-oss.club.evil.test')]) expect(koalaVideoId(other)).toBeUndefined();
    expect(suppressesGenericMedia('https://app.koala-oss.club')).toBe(true);
    expect(suppressesGenericMedia('https://other.test')).toBe(false);
  });
  it('discovers only canonical, unique video links from the current homepage', async () => {
    const links = [url, url + '?tracking=1', 'https://evil.test/videos/' + id];
    const document = { querySelectorAll: () => links.map(href => ({ getAttribute: () => href, querySelector: () => ({ textContent: 'Test video' }) })) } as unknown as Document;
    expect(await koalaDiscoveryAdapter.discover(document, new URL('https://app.koala-oss.club/'))).toEqual([koalaItem(url, 'Test video', 1)]);
  });
  it('rejects stale player metadata and offers a page source once ready', () => {
    let mediaId = 'previous-video';
    const document = { title: 'Site', querySelector: (selector: string) => selector === BROWSER_SOURCE_STATE_SELECTOR
      ? { textContent: JSON.stringify({ mediaId, state: 'ready', width: 1920, height: 1080 }) } : { textContent: 'Video title' } } as unknown as Document;
    expect(koalaDetectionAdapter.detect(document, new URL(url))).toEqual([]);
    mediaId = id;
    expect(koalaDetectionAdapter.detect(document, new URL(url))[0]).toMatchObject({ kind: 'hls', title: 'Video title', browserSource: { providerId: 'aliplayer', mediaId: id } });
  });
  it('offers a known source before the first video frame has loaded', () => {
    const document = { title: 'Unplayed video', querySelector: (selector: string) => selector === BROWSER_SOURCE_STATE_SELECTOR
      ? { textContent: JSON.stringify({ mediaId: id, state: 'waiting', reason: 'sdk-uninitialized', width: 0, height: 0 }) } : null } as unknown as Document;
    expect(koalaDetectionAdapter.detect(document, new URL(url))[0]).toMatchObject({ kind: 'hls', hasContentProtection: false,
      browserSource: { providerId: 'aliplayer', mediaId: id } });
  });
});
