import { AliplayerSourceService } from '../src/core/site-adapters/aliplayer/source-service';
import { koalaVideoId } from '../src/core/site-adapters/koala/identity';
import { BROWSER_SOURCE_CHANNEL, BROWSER_SOURCE_STATE_ATTRIBUTE, BROWSER_SOURCE_STATE_SELECTOR,
  browserSourceCommandSchema } from '../src/shared/browser-source';

export default defineContentScript({
  matches: ['https://app.koala-oss.club/*'], runAt: 'document_start', world: 'MAIN',
  main() {
    const service = new AliplayerSourceService(() => koalaVideoId(location.href));
    const publish = () => {
      const id = koalaVideoId(location.href);
      if (!id) { document.querySelector(BROWSER_SOURCE_STATE_SELECTOR)?.remove(); return; }
      if (!document.documentElement) return;
      const data = JSON.stringify(service.status());
      let element = document.querySelector<HTMLElement>(BROWSER_SOURCE_STATE_SELECTOR);
      if (!element) { element = document.createElement('div'); element.hidden = true; element.setAttribute(BROWSER_SOURCE_STATE_ATTRIBUTE, ''); document.documentElement.append(element); }
      if (element.textContent !== data) element.textContent = data;
    };
    const listener = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin || !koalaVideoId(location.href)) return;
      const data = event.data;
      if (!data || data.channel !== BROWSER_SOURCE_CHANNEL || data.direction !== 'request' ||
          typeof data.requestId !== 'string' || data.requestId.length > 80 || !Number.isSafeInteger(data.owner)) return;
      const parsed = browserSourceCommandSchema.safeParse(data.command); if (!parsed.success) return;
      void service.handle(parsed.data, data.owner).then(value => ({ ok: true, value }), cause => ({ ok: false,
        error: cause instanceof Error && /^browserSource[A-Za-z]+$/.test(cause.message) ? cause.message : 'browserSourceUnsupported' }))
        .then(response => window.postMessage({ channel: BROWSER_SOURCE_CHANNEL, direction: 'response', requestId: data.requestId, response }, location.origin));
    };
    window.addEventListener('message', listener);
    const timer = setInterval(publish, 750);
    window.addEventListener('pagehide', () => { clearInterval(timer); window.removeEventListener('message', listener); service.dispose(); }, { once: true });
    publish();
  },
});
