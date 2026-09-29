import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  tabs: { query: vi.fn(), create: vi.fn(), remove: vi.fn() },
  runtime: { getURL: vi.fn((path: string) => `chrome-extension://test${path}`), sendMessage: vi.fn() },
}));
vi.mock('wxt/browser', () => ({ browser: api }));
import { createBrowserMediaSourceProvider } from '../src/browser/media-source-provider';

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('browser source readiness diagnostics', () => {
  it('prepares the requested source and records a sanitized initialization reason on timeout', async () => {
    const target = { providerId: 'aliplayer' as const, mediaId: 'dc1a89b5-854c-4566-9090-ecdb551a70bb',
      pageUrl: 'https://app.koala-oss.club/videos/dc1a89b5-854c-4566-9090-ecdb551a70bb' };
    api.tabs.query.mockResolvedValue([{ id: 23, url: target.pageUrl }]);
    api.runtime.sendMessage.mockResolvedValue({ ok: true, value: { mediaId: target.mediaId, state: 'waiting',
      reason: 'processor-pending', width: 0, height: 0, observedInstances: 1, attachedInstances: 1, mediaReadyState: 0 } });
    const pending = createBrowserMediaSourceProvider().open(target, 0, new AbortController().signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'browserSourceUnavailable', params: {
      stage: 'prepare', reason: 'processor-pending', observedInstances: 1, attachedInstances: 1, mediaReadyState: 0,
    } });
    await vi.advanceTimersByTimeAsync(41_000); await assertion;
    expect(api.runtime.sendMessage).toHaveBeenCalledWith({ type: 'browser-source:relay', sourceTabId: 23,
      command: { method: 'prepare', mediaId: target.mediaId } });
    expect(api.tabs.remove).not.toHaveBeenCalled();
  });
});
