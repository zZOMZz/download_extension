import { BROWSER_SOURCE_CHANNEL, browserSourceReplySchema, type BrowserSourceCommand } from '../shared/browser-source';

export function requestPageSource(command: BrowserSourceCommand, owner: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', receive); };
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.channel !== BROWSER_SOURCE_CHANNEL ||
          event.data.direction !== 'response' || event.data.requestId !== requestId) return;
      try { if (JSON.stringify(event.data.response).length > 4 * 1024 * 1024) return; } catch { return; }
      const parsed = browserSourceReplySchema.safeParse(event.data.response); if (!parsed.success) return;
      cleanup(); resolve(parsed.data);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('browserSourceUnavailable')); }, command.method === 'open' ? 35_000 : 5_000);
    window.addEventListener('message', receive);
    window.postMessage({ channel: BROWSER_SOURCE_CHANNEL, direction: 'request', requestId, owner, command }, location.origin);
  });
}
