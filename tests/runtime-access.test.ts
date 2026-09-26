import { describe, expect, it } from 'vitest';
import { isManagerRuntimeSender } from '../src/background/runtime-access';

const manager = 'chrome-extension://test-id/manager.html';
const sender = { id: 'test-id', tab: { id: 3 }, frameId: 0, url: `${manager}?tabId=4` };
describe('task storage sender boundary', () => {
  it('accepts its manager tab, including source query parameters', () => {
    expect(isManagerRuntimeSender(sender, 'test-id', manager)).toBe(true);
  });
  it.each([
    { ...sender, id: 'another-extension' },
    { ...sender, url: 'https://example.com/manager.html' },
    { ...sender, url: `${manager}.other` },
    { ...sender, url: 'chrome-extension://other-id/manager.html' },
    { ...sender, url: 'chrome-extension://test-id/popup.html' },
    { ...sender, frameId: 1 },
    { ...sender, tab: undefined },
  ])('rejects unrelated source $url', (untrusted) => {
    expect(isManagerRuntimeSender(untrusted, 'test-id', manager)).toBe(false);
  });
});
