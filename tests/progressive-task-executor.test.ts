// @ts-expect-error Vitest runs in Node; the browser extension intentionally does not include Node typings.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import muxjs from 'mux.js';
import type { WritableDirectoryHandle } from '../src/browser/directory-output-writer';
import { progressiveTaskExecutor } from '../src/browser/task-executors/progressive';
import type { TaskExecutorContext } from '../src/browser/task-executors/types';
import { commitValidatedDirectoryOutput } from '../src/browser/validated-output';
import { isRecoverableNetworkError } from '../src/core/hls/download-hls';
import { classifyTaskError } from '../src/core/task-error';
import type { DownloadTaskProgress } from '../src/shared/download-task';
import { createTranslator } from '../src/shared/i18n';
import { NETWORK_PRESETS } from '../src/shared/settings';

const MEDIA_URL = 'https://cdn.example/episode.mp4?token=private';
let mp4: Uint8Array;

beforeAll(async () => {
  const transmuxer = new muxjs.mp4.Transmuxer();
  transmuxer.on('data', (segment) => {
    mp4 = new Uint8Array(segment.initSegment.byteLength + segment.data.byteLength);
    mp4.set(segment.initSegment);
    mp4.set(segment.data, segment.initSegment.byteLength);
  });
  const done = new Promise<void>((resolve) => transmuxer.on('done', resolve));
  transmuxer.push(new Uint8Array(readFileSync('node_modules/mux.js/test/segments/test-segment.ts')));
  transmuxer.flush();
  await done;
});

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const files = new Map<string, Uint8Array>();
  const abort = vi.fn(async () => {});
  const commit = vi.fn();
  const directory: WritableDirectoryHandle = {
    name: 'Downloads',
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
        files.set(name, new Uint8Array());
      }
      return {
        async getFile() { return new File([files.get(name)!.slice().buffer as ArrayBuffer], name); },
        async createWritable() {
          let staged = new Uint8Array();
          return {
            async write(command) {
              if (command.type === 'truncate') {
                staged = staged.slice(0, command.size);
                return;
              }
              const expanded = new Uint8Array(Math.max(staged.byteLength, command.position + command.data.byteLength));
              expanded.set(staged);
              expanded.set(command.data, command.position);
              staged = expanded;
            },
            async close() { files.set(name, staged); commit(); },
            abort,
          };
        },
      };
    },
    async removeEntry(name) { files.delete(name); },
  };
  const progress: DownloadTaskProgress[] = [];
  const context: TaskExecutorContext = {
    task: {
      id: 'progressive-task',
      source: {
        id: 'bilibili:ep1', adapterId: 'bilibili',
        pageUrl: 'https://www.bilibili.com/bangumi/play/ep1',
        title: 'Episode 1', seriesTitle: 'Series', mediaKind: 'progressive',
      },
      outputFormat: 'mp4', status: 'resolving', createdAt: 1, updatedAt: 1,
    },
    media: { kind: 'progressive', url: MEDIA_URL, title: 'Episode 1' },
    directory,
    signal: new AbortController().signal,
    networkPolicy: { maxAttempts: 1 },
    networkSettings: NETWORK_PRESETS.resilient,
    loadText: async () => { throw new Error('Complete files do not have a manifest.'); },
    refreshMedia: async () => { throw new Error('The queue resolves the source for each new attempt.'); },
    persistTask: vi.fn(async (task) => task),
    onProgress: (value) => progress.push(value),
    recordTaskEvent: vi.fn(async () => {}),
    recordRequestRetry: vi.fn(),
    t: createTranslator('en'),
  };
  return { context, files, progress, abort, commit };
}

describe('progressive task executor', () => {
  it('streams a complete MP4 into the directory and passes the queue output validation', async () => {
    const fetchMock = vi.fn(async () => new Response(mp4.slice().buffer as ArrayBuffer, {
      headers: { 'Content-Length': String(mp4.byteLength) },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { context, files, progress } = setup();
    const result = await progressiveTaskExecutor.execute(context);
    const validation = await commitValidatedDirectoryOutput(
      context.directory, result.finalFilename, result.validationOptions, result.partialOutputsToRemove,
    );

    expect(result.finalFilename).toBe('Series - Episode 1.mp4');
    expect(result.validationOptions).toEqual({ format: 'mp4', requireVideo: true, expectedBytes: mp4.byteLength });
    expect(validation).toMatchObject({ videoTracks: 1, audioTracks: 1, size: mp4.byteLength });
    expect(files.get(result.finalFilename)).toEqual(mp4);
    expect(progress.at(-1)).toMatchObject({ completedSegments: 1, totalSegments: 1, bytesWritten: mp4.byteLength });
    expect(context.persistTask).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloading' }));
    expect(fetchMock).toHaveBeenCalledWith(MEDIA_URL, expect.objectContaining({ credentials: 'include' }));
  });

  it('makes an expired URL recoverable so the queue can resolve and restart the entire file', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(mp4.slice().buffer as ArrayBuffer));
    vi.stubGlobal('fetch', fetchMock);
    const { context, files, abort, commit } = setup();
    const failure = await progressiveTaskExecutor.execute(context).catch((cause: unknown) => cause);
    expect(isRecoverableNetworkError(failure)).toBe(true);
    expect(classifyTaskError(failure)).toMatchObject({ category: 'http', httpStatus: 403, recoverable: true });
    expect((failure as Error).message).not.toContain('private');
    expect(abort).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();

    context.media = { ...context.media, url: 'https://cdn.example/episode.mp4?token=fresh' };
    const result = await progressiveTaskExecutor.execute(context);
    expect(fetchMock.mock.calls[1]).toEqual([
      context.media.url, expect.objectContaining({ credentials: 'include' }),
    ]);
    expect(fetchMock.mock.calls[1]![1]).not.toHaveProperty('headers.Range');
    expect(files.get(result.finalFilename)).toEqual(mp4);
    expect(context.persistTask).not.toHaveBeenCalledWith(expect.objectContaining({ checkpoint: expect.anything() }));
  });

  it('cancels an active response and aborts the staged file', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const { context, abort, commit } = setup();
    const controller = new AbortController();
    context.signal = controller.signal;
    const pending = progressiveTaskExecutor.execute(context);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it('preserves destination errors instead of scheduling a network recovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(mp4.slice().buffer as ArrayBuffer)));
    const { context, abort } = setup();
    const cause = new TypeError('Destination write failed');
    context.directory.getFileHandle = async () => ({
      getFile: async () => new File([], 'episode.mp4'),
      createWritable: async () => ({
        write: async () => { throw cause; }, close: async () => {}, abort,
      }),
    });
    const failure = await progressiveTaskExecutor.execute(context).catch((error: unknown) => error);
    expect(failure).toBe(cause);
    expect(isRecoverableNetworkError(failure)).toBe(false);
    expect(abort).toHaveBeenCalledOnce();
  });

  it('does not overwrite a segmented partial download when the source changes protocol', async () => {
    const { context, files } = setup();
    context.task.checkpoint = {
      version: 1, playlistFingerprint: 'previous', directoryName: 'Downloads',
      partialFilename: 'episode.part.ts', finalFilename: 'episode.mp4',
      completedSegments: 1, totalSegments: 2, bytesWritten: 100,
      segmentEndOffsets: [100], updatedAt: 1,
    };
    await expect(progressiveTaskExecutor.execute(context)).rejects.toThrow(/compatible/i);
    expect(files.size).toBe(0);
    expect(context.persistTask).not.toHaveBeenCalled();
  });
});
