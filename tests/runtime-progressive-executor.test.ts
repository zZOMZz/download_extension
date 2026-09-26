import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import muxjs from 'mux.js';
import { progressiveTaskExecutor } from '../src/runtime/task-executors/progressive';
import type { TaskExecutorContext } from '../src/runtime/task-executors/types';
import { readMediaArtifact, type ArtifactStore } from '../src/runtime/artifact-store';
import { validateMediaOutput } from '../src/core/media/output-validator';
import { isRecoverableNetworkError } from '../src/core/hls/download-hls';
import { HostHealthController } from '../src/core/network/host-health';
import { NETWORK_PRESETS } from '../src/shared/settings';

let mp4: Uint8Array;
beforeAll(async () => {
  const transmuxer = new muxjs.mp4.Transmuxer();
  transmuxer.on('data', (segment) => {
    mp4 = new Uint8Array(segment.initSegment.length + segment.data.length);
    mp4.set(segment.initSegment); mp4.set(segment.data, segment.initSegment.length);
  });
  const done = new Promise<void>((resolve) => transmuxer.on('done', resolve));
  transmuxer.push(new Uint8Array(readFileSync('node_modules/mux.js/test/segments/test-segment.ts')));
  transmuxer.flush();
  await done;
});
afterEach(() => vi.unstubAllGlobals());

function setup(failureMethod?: 'write' | 'close') {
  const failure = new TypeError(`Local ${failureMethod} failed`);
  const files = new Map<string, Uint8Array>();
  const abort = vi.fn(async () => {});
  const artifacts: ArtifactStore = {
    name: 'Memory output', id: 'memory-output',
    stat: async (name) => files.has(name) ? { size: files.get(name)!.length } : null,
    read: async (name, offset, length) => files.get(name)!.slice(offset, offset + length),
    remove: async (name) => { files.delete(name); },
    open: vi.fn(async (name) => {
      let staged = new Uint8Array(0);
      return {
        async write(bytes: Uint8Array) {
          if (failureMethod === 'write') throw failure;
          const next = new Uint8Array(staged.length + bytes.length);
          next.set(staged); next.set(bytes, staged.length); staged = next;
        },
        async writeAt() { throw new Error('Progressive output must not seek'); },
        async close() {
          if (failureMethod === 'close') throw failure;
          files.set(name, staged);
        },
        abort,
      };
    }),
  };
  const context: TaskExecutorContext = {
    task: { id: 'episode', source: { id: 'bilibili:ep1:1001', adapterId: 'bilibili',
      pageUrl: 'https://www.bilibili.com/bangumi/play/ep1', title: 'Episode 1', seriesTitle: 'Series', mediaKind: 'progressive' },
      status: 'resolving', outputFormat: 'mp4', createdAt: 1, updatedAt: 1 },
    media: { kind: 'progressive', url: 'https://media.test/episode.mp4', title: 'Episode 1' },
    artifacts,
    transforms: {
      createHlsWriter() { throw new Error('Progressive output must not transmux'); },
      createDashWriter() { throw new Error('Progressive output must not transmux'); },
    },
    signal: new AbortController().signal,
    networkPolicy: { maxAttempts: 1, requestCoordinator: new HostHealthController({ maxConcurrency: 1 }) },
    networkSettings: NETWORK_PRESETS.resilient,
    loadText: async () => { throw new Error('Progressive output does not load a manifest'); },
    refreshMedia: async () => { throw new Error('The queue owns whole-file recovery'); },
    persistTask: vi.fn(async (task) => task), onProgress: vi.fn(),
    recordTaskEvent: vi.fn(async () => {}), recordRequestRetry: vi.fn(),
    transport: { fetch: vi.fn(async () => new Response(mp4.slice().buffer as ArrayBuffer,
      { headers: { 'Content-Length': String(mp4.length) } })) },
  };
  return { context, files, abort, failure };
}

describe('portable progressive task executor', () => {
  it('uses injected transport and artifact ports to create a validated full MP4', async () => {
    const globalFetch = vi.fn(async () => { throw new Error('Host transport was bypassed'); });
    vi.stubGlobal('fetch', globalFetch);
    const { context, files } = setup();
    const result = await progressiveTaskExecutor.execute(context);
    const validation = await validateMediaOutput(await readMediaArtifact(context.artifacts, result.finalFilename), result.validationOptions);
    expect(result.finalFilename).toBe('Series - Episode 1.mp4');
    expect(validation).toMatchObject({ videoTracks: 1, audioTracks: 1, size: mp4.length });
    expect(files.get(result.finalFilename)).toEqual(mp4);
    expect(context.transport!.fetch).toHaveBeenCalledWith(context.media.url, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(vi.mocked(context.transport!.fetch).mock.calls[0]?.[1]?.credentials).toBeUndefined();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(context.persistTask).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloading' }));
  });

  it.each(['write', 'close'] as const)('aborts a local %s failure once without scheduling network recovery', async (method) => {
    const { context, abort, failure, files } = setup(method);
    await expect(progressiveTaskExecutor.execute(context)).rejects.toBe(failure);
    expect(isRecoverableNetworkError(failure)).toBe(false);
    expect((context.networkPolicy.requestCoordinator as HostHealthController).snapshots()).toEqual([]);
    expect(abort).toHaveBeenCalledExactlyOnceWith(failure);
    expect(files.size).toBe(0);
  });

  it('makes an expired injected request recoverable without retrying or committing the partial file', async () => {
    const { context, abort, files } = setup();
    context.transport = { fetch: vi.fn(async () => new Response(null, { status: 403 })) };
    const failure = await progressiveTaskExecutor.execute(context).catch((cause: unknown) => cause);
    expect(isRecoverableNetworkError(failure)).toBe(true);
    expect(context.transport.fetch).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    expect(files.size).toBe(0);
  });

  it('rejects an incompatible segmented checkpoint before opening an output or making a request', async () => {
    const { context } = setup();
    context.task.checkpoint = { version: 1, playlistFingerprint: 'previous', directoryName: 'Memory output', directoryHandleId: 'memory-output',
      partialFilename: 'old.part.ts', finalFilename: 'old.mp4', completedSegments: 1, totalSegments: 2,
      bytesWritten: 100, segmentEndOffsets: [100], updatedAt: 1 };
    await expect(progressiveTaskExecutor.execute(context)).rejects.toMatchObject({ code: 'refreshedStreamIncompatible' });
    expect(context.artifacts.open).not.toHaveBeenCalled();
    expect(context.transport!.fetch).not.toHaveBeenCalled();
    expect(context.persistTask).not.toHaveBeenCalled();
  });
});
