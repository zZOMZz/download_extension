import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => {
  const changed = new Set<(delta: { id: number; state?: { current: string }; error?: { current: string } }) => void>();
  const erased = new Set<(id: number) => void>();
  return {
    changed, erased,
    download: vi.fn(), search: vi.fn(), cancel: vi.fn(),
  };
});
vi.mock('wxt/browser', () => ({ browser: { downloads: {
  download: host.download, search: host.search, cancel: host.cancel,
  onChanged: { addListener: (listener: never) => host.changed.add(listener), removeListener: (listener: never) => host.changed.delete(listener) },
  onErased: { addListener: (listener: never) => host.erased.add(listener), removeListener: (listener: never) => host.erased.delete(listener) },
} } }));
import { openOutputTarget } from '../src/browser/output-writer';

beforeEach(() => {
  host.changed.clear(); host.erased.clear();
  host.download.mockReset().mockResolvedValue(41);
  host.search.mockReset().mockResolvedValue([{ id: 41, state: 'in_progress' }]);
  host.cancel.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('window', {});
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function memoryOutput() {
  const target = await openOutputTarget('video.mp4', 'video/mp4', 'mp4');
  await target.writer.write(Uint8Array.of(1, 2, 3));
  await target.writer.close();
  return target;
}
function changed(state: string, error?: string) {
  for (const listener of host.changed) listener({ id: 41, state: { current: state }, ...(error ? { error: { current: error } } : {}) });
}
function expectCleaned() {
  expect(host.changed.size).toBe(0);
  expect(host.erased.size).toBe(0);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture');
}

describe('browser output publication', () => {
  it('keeps bytes readable after close and waits for actual download completion', async () => {
    const target = await memoryOutput();
    expect(host.download).not.toHaveBeenCalled();
    expect(await (await target.read())!.read(0, 3)).toEqual(Uint8Array.of(1, 2, 3));
    let done = false;
    const pending = target.finish().then(() => { done = true; });
    await vi.waitFor(() => expect(host.search).toHaveBeenCalledWith({ id: 41 }));
    expect(done).toBe(false);
    expect(host.changed.size).toBe(1);
    changed('complete');
    await pending;
    expect(done).toBe(true);
    expectCleaned();
  });

  it('detects completion that occurred before the download ID was returned', async () => {
    host.search.mockResolvedValue([{ id: 41, state: 'complete' }]);
    await (await memoryOutput()).finish();
    expectCleaned();
  });

  it('rejects interrupted downloads and disposes every listener', async () => {
    const target = await memoryOutput();
    const pending = expect(target.finish()).rejects.toThrow('FILE_NO_SPACE');
    await vi.waitFor(() => expect(host.search).toHaveBeenCalled());
    changed('interrupted', 'FILE_NO_SPACE');
    await pending;
    expectCleaned();
  });

  it('cancels a download whose ID arrives after the user aborts publication', async () => {
    let created!: (id: number) => void;
    host.download.mockImplementation(() => new Promise<number>((resolve) => { created = resolve; }));
    const controller = new AbortController();
    const target = await memoryOutput();
    const pending = expect(target.finish(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await pending;
    expectCleaned();
    created(41);
    await vi.waitFor(() => expect(host.cancel).toHaveBeenCalledWith(41));
    expect(host.search).not.toHaveBeenCalled();
  });

  it('opens a streaming picker synchronously and reads the committed selected file', async () => {
    const close = vi.fn(async () => {});
    const file = new File([Uint8Array.of(4, 5)], 'selected.mp4');
    const picker = vi.fn(async () => ({
      createWritable: async () => ({ write: async () => {}, close, abort: async () => {} }),
      getFile: async () => file,
    }));
    vi.stubGlobal('window', { showSaveFilePicker: picker });
    const pending = openOutputTarget('video.mp4', 'video/mp4', 'mp4');
    expect(picker).toHaveBeenCalledOnce();
    const target = await pending;
    await target.writer.close();
    expect(await (await target.read())!.read(0, 2)).toEqual(Uint8Array.of(4, 5));
    await target.finish();
    expect(close).toHaveBeenCalledOnce();
    expect(host.download).not.toHaveBeenCalled();
  });
});
