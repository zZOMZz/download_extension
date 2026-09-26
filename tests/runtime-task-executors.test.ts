import { describe, expect, it, vi } from 'vitest';
import type { ArtifactStore } from '../src/runtime/artifact-store';
import type { TransformBackend } from '../src/runtime/transform-backend';
import { hlsTaskExecutor } from '../src/runtime/task-executors/hls';
import type { TaskExecutorContext } from '../src/runtime/task-executors/types';
import type { DownloadTask } from '../src/shared/download-task';
import { NETWORK_PRESETS } from '../src/shared/settings';
import { readMediaArtifact } from '../src/runtime/artifact-store';
import { validateMediaOutput } from '../src/core/media/output-validator';

const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nfirst.ts\n#EXTINF:10,\nsecond.ts\n#EXT-X-ENDLIST\n';
const segment = new Uint8Array(188 * 3);
segment[0] = segment[188] = segment[376] = 0x47;

function memoryArtifacts() {
  const files = new Map<string, Uint8Array>();
  const store: ArtifactStore = {
    id: 'output-1',
    name: 'Downloads',
    stat: async (name) => files.has(name) ? { size: files.get(name)!.byteLength } : null,
    read: async (name, offset, length) => files.get(name)!.slice(offset, offset + length),
    async open(name, options) {
      const initial = options?.resumeFrom === undefined ? new Uint8Array() : files.get(name) ?? new Uint8Array();
      let staged = initial.slice(0, options?.resumeFrom ?? 0);
      let position = staged.byteLength;
      const writeAt = async (offset: number, chunk: Uint8Array) => {
        if (offset + chunk.byteLength > staged.byteLength) {
          const larger = new Uint8Array(offset + chunk.byteLength);
          larger.set(staged);
          staged = larger;
        }
        staged.set(chunk, offset);
      };
      return {
        async write(chunk) {
          await writeAt(position, chunk);
          position += chunk.byteLength;
        },
        writeAt,
        close: async () => { files.set(name, staged); },
        abort: async () => { if (options?.resumeFrom !== undefined) files.set(name, staged); },
      };
    },
    remove: async (name) => { files.delete(name); },
  };
  return { store, files };
}

const transforms: TransformBackend = {
  createHlsWriter: (destination, plan) => {
    if (plan.remuxTs || plan.separateAudio) throw new Error('This fixture only writes TS');
    return destination;
  },
  createDashWriter: () => { throw new Error('This fixture only writes TS'); },
};

function createContext(artifacts: ArtifactStore, transport: NonNullable<TaskExecutorContext['transport']>) {
  let task: DownloadTask = {
    id: 'hls-task',
    source: { id: 'episode', adapterId: 'fixture', title: 'Episode', pageUrl: 'https://example.test/watch' },
    outputFormat: 'original', status: 'resolving', createdAt: 1, updatedAt: 1,
  };
  const context: TaskExecutorContext = {
    task,
    media: { kind: 'hls', url: 'https://example.test/media.m3u8', title: 'Episode' },
    artifacts, transforms, transport,
    signal: new AbortController().signal,
    networkPolicy: { maxAttempts: 1 },
    networkSettings: NETWORK_PRESETS.resilient,
    loadText: async () => playlist,
    refreshMedia: async () => context.media,
    persistTask: async (next) => { task = next; return task; },
    onProgress: () => {},
    recordTaskEvent: async () => {},
    recordRequestRetry: () => {},
  };
  return { context, task: () => task };
}

describe('host-independent HLS task execution', () => {
  it('reconciles a persisted partial and downloads only the missing segment after failure', async () => {
    const { store, files } = memoryArtifacts();
    let failSecond = true;
    const request = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('second.ts') && failSecond) return new Response(null, { status: 503 });
      return new Response(segment.slice().buffer as ArrayBuffer);
    });
    const { context, task } = createContext(store, { fetch: request });
    await expect(hlsTaskExecutor.execute(context)).rejects.toThrow('HTTP 503');
    expect(task().checkpoint).toMatchObject({ version: 1, completedSegments: 1, directoryHandleId: 'output-1' });
    expect(files.get('Episode.part.ts')?.byteLength).toBe(segment.byteLength);

    failSecond = false;
    const result = await hlsTaskExecutor.execute({ ...context, task: task() });
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      'https://example.test/first.ts',
      'https://example.test/second.ts',
      'https://example.test/second.ts',
    ]);
    expect(result.partialOutputsToRemove).toEqual(['Episode.part.ts']);
    expect(files.has('Episode.part.ts')).toBe(true);
    await expect(validateMediaOutput(await readMediaArtifact(store, result.finalFilename), result.validationOptions))
      .resolves.toMatchObject({ format: 'ts', size: segment.byteLength * 2 });
  });

  it('refuses a checkpoint from another output identity before reading or writing its files', async () => {
    const { store } = memoryArtifacts();
    const { context } = createContext(store, { fetch: async () => { throw new Error('Must not request media'); } });
    context.task.checkpoint = {
      version: 1, playlistFingerprint: 'previous', directoryName: store.name, directoryHandleId: 'other-output',
      partialFilename: 'Episode.part.ts', finalFilename: 'Episode.ts', completedSegments: 1,
      totalSegments: 2, bytesWritten: segment.byteLength, segmentEndOffsets: [segment.byteLength], updatedAt: 1,
    };
    const stat = vi.spyOn(store, 'stat');
    const open = vi.spyOn(store, 'open');
    await expect(hlsTaskExecutor.execute(context)).rejects.toMatchObject({
      name: 'RuntimeError', code: 'chooseOriginalFolderResume', params: { name: 'Downloads' },
    });
    expect(stat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
