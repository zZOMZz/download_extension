import { describe, expect, it } from 'vitest';
import { isManagerRuntimeSender, isBackgroundRuntimeSender } from '../src/background/runtime-access';

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

describe('page-source broker boundary', () => {
  const worker = 'chrome-extension://test-id/background.js';
  it('accepts only its own background context, including Chrome senders without a URL', () => {
    expect(isBackgroundRuntimeSender({ id: 'test-id', url: worker }, 'test-id', worker)).toBe(true);
    expect(isBackgroundRuntimeSender({ id: 'test-id' }, 'test-id', worker)).toBe(true);
    for (const value of [sender, { id: 'other' }, { id: 'test-id', url: manager },
      { id: 'test-id', url: 'https://app.koala-oss.club/' }, { id: 'test-id', url: worker, tab: { id: 3 } }]) {
      expect(isBackgroundRuntimeSender(value, 'test-id', worker)).toBe(false);
    }
  });
});
