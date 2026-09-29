import { BROWSER_SOURCE_STATE_SELECTOR, browserSourceStatusSchema } from '../../../shared/browser-source';
import { KOALA_ORIGIN, koalaVideoId, koalaVideoUrl } from '../../site-adapters/koala/identity';
import type { MediaDetectionAdapter } from './types';

export const koalaDetectionAdapter: MediaDetectionAdapter = {
  id: 'koala', matches: url => Boolean(koalaVideoId(url.href)),
  suppressesGenericMedia: url => url.origin === KOALA_ORIGIN,
  detect(document, pageUrl) {
    const id = koalaVideoId(pageUrl.href); if (!id) return [];
    let state;
    try { state = browserSourceStatusSchema.parse(JSON.parse(document.querySelector(BROWSER_SOURCE_STATE_SELECTOR)?.textContent ?? '')); }
    catch { return []; }
    if (state.mediaId !== id) return [];
    const title = document.querySelector('h1')?.textContent?.trim() || document.title;
    // A known page source can be queued before its player has buffered frames.
    // The browser host prepares it when the task actually starts.
    return [{ kind: 'hls', source: 'dom', url: koalaVideoUrl(id),
      siteAdapterId: 'koala', sourcePageUrl: koalaVideoUrl(id), title,
      hasContentProtection: state.state === 'protected',
      browserSource: { providerId: 'aliplayer', mediaId: id, pageUrl: koalaVideoUrl(id) } }];
  },
};
