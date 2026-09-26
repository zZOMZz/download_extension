import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', () => ({ browser: { downloads: { download: vi.fn() } } }));

import { openOutputWriter } from '../src/browser/output-writer';

afterEach(() => vi.unstubAllGlobals());

describe('streaming output writer', () => {
  it('invokes the save picker before yielding and forwards writes and abort to the file', async () => {
    const writable = {
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const picker = vi.fn(async () => ({ createWritable: async () => writable }));
    vi.stubGlobal('window', { showSaveFilePicker: picker });

    const pending = openOutputWriter('video.mp4', 'video/mp4', 'mp4', { allowMemoryFallback: false });
    expect(picker).toHaveBeenCalledOnce();
    const writer = await pending;
    const chunk = Uint8Array.of(1, 2, 3);
    await writer.write(chunk);
    expect(writable.write).toHaveBeenCalledWith({ type: 'write', position: 0, data: chunk });
    await writer.abort();
    expect(writable.abort).toHaveBeenCalledOnce();
    expect(writable.close).not.toHaveBeenCalled();
  });

  it('refuses an unbounded memory fallback when streaming file output is required', async () => {
    vi.stubGlobal('window', {});
    await expect(openOutputWriter('video.mp4', 'video/mp4', 'mp4', { allowMemoryFallback: false }))
      .rejects.toThrow(/streaming file save support/i);
  });
});
