import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fault = vi.hoisted(() => ({ sync: undefined as Error | undefined, close: undefined as Error | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (fault.sync) vi.spyOn(handle, 'sync').mockRejectedValueOnce(fault.sync);
    if (fault.close) {
      const close = handle.close.bind(handle);
      const cause = fault.close;
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => { await close(); throw cause; });
    }
    return handle;
  } };
});
import { NodeArtifactStore } from '../src/hosts/node/artifact-store';

let root: string;
beforeEach(async () => {
  fault.sync = undefined; fault.close = undefined;
  root = await mkdtemp(join(tmpdir(), 'download-artifact-failure-'));
});
afterEach(async () => {
  vi.restoreAllMocks(); fault.sync = undefined; fault.close = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('Node artifact finalization failure recovery', () => {
  it('removes fresh staging data after rename fails, preserving the destination and original error', async () => {
    const artifacts = await NodeArtifactStore.create(root);
    await mkdir(join(root, 'video.mp4'));
    const writer = await artifacts.open('video.mp4');
    await writer.write(Uint8Array.of(1, 2, 3));
    await expect(writer.close()).rejects.toMatchObject({ code: 'EISDIR' });
    await writer.abort();
    expect(await readdir(root)).toEqual(['video.mp4']);
    expect((await stat(join(root, 'video.mp4'))).isDirectory()).toBe(true);
  });

  it('keeps a prior valid destination and the first failure when sync and close both fail', async () => {
    const artifacts = await NodeArtifactStore.create(root);
    await writeFile(join(root, 'video.mp4'), Uint8Array.of(9, 8, 7));
    const syncFailure = new Error('Failed to sync fresh output');
    fault.sync = syncFailure; fault.close = new Error('Secondary close failure');
    const writer = await artifacts.open('video.mp4');
    await writer.write(Uint8Array.of(1, 2, 3));
    await expect(writer.close()).rejects.toBe(syncFailure);
    await writer.abort();
    expect(await readdir(root)).toEqual(['video.mp4']);
    expect([...await readFile(join(root, 'video.mp4'))]).toEqual([9, 8, 7]);
  });

  it('retains checkpoint-owned partial bytes if synchronizing a resumed output fails', async () => {
    const artifacts = await NodeArtifactStore.create(root);
    await writeFile(join(root, 'video.part.ts'), Uint8Array.of(1, 2, 3));
    const failure = new Error('Failed to sync partial output');
    fault.sync = failure;
    const writer = await artifacts.open('video.part.ts', { resumeFrom: 3 });
    await writer.write(Uint8Array.of(4, 5));
    await expect(writer.close()).rejects.toBe(failure);
    await writer.abort();
    expect(await readdir(root)).toEqual(['video.part.ts']);
    expect([...await readFile(join(root, 'video.part.ts'))]).toEqual([1, 2, 3, 4, 5]);
  });
});
