// @ts-expect-error Vitest runs in Node; the browser extension intentionally does not include Node typings.
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import muxjs from 'mux.js';
import type {
  WritableDirectoryHandle,
  WritableFileHandle,
} from '../src/browser/directory-output-writer';
import type { PositionalWritableFileStream } from '../src/browser/random-access-file-writer';
import { dashTaskExecutor } from '../src/browser/task-executors/dash';
import { commitValidatedDirectoryOutput } from '../src/browser/validated-output';
import { createTranslator } from '../src/shared/i18n';
import type { DownloadTask } from '../src/shared/download-task';
import type { DashMediaSource } from '../src/shared/media';
import { NETWORK_PRESETS } from '../src/shared/settings';

class MemoryFileHandle implements WritableFileHandle {
  bytes = new Uint8Array();

  constructor(readonly name: string) {}

  async getFile(): Promise<File> {
    return new File([this.bytes.slice().buffer as ArrayBuffer], this.name);
  }

  async createWritable(options?: { keepExistingData?: boolean }): Promise<PositionalWritableFileStream> {
    let staged = options?.keepExistingData ? this.bytes.slice() : new Uint8Array();
    return {
      write: async (command) => {
        if (command.type === 'truncate') {
          staged = staged.slice(0, command.size);
          return;
        }
        const required = command.position + command.data.byteLength;
        if (required > staged.byteLength) {
          const expanded = new Uint8Array(required);
          expanded.set(staged);
          staged = expanded;
        }
        staged.set(command.data, command.position);
      },
      close: async () => { this.bytes = staged; },
      abort: async () => {},
    };
  }
}

function memoryDirectory(): {
  directory: WritableDirectoryHandle;
  files: Map<string, MemoryFileHandle>;
} {
  const files = new Map<string, MemoryFileHandle>();
  return {
    files,
    directory: {
      name: 'Downloads',
      async getFileHandle(name, options) {
        const existing = files.get(name);
        if (existing) return existing;
        if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
        const created = new MemoryFileHandle(name);
        files.set(name, created);
        return created;
      },
      async removeEntry(name) {
        if (!files.delete(name)) throw new DOMException('Not found', 'NotFoundError');
      },
    },
  };
}

let video: { init: Uint8Array; data: Uint8Array };
let audio: { init: Uint8Array; data: Uint8Array };

beforeAll(async () => {
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: false, keepOriginalTimestamps: true });
  const segments: Array<{ type: 'audio' | 'video'; init: Uint8Array; data: Uint8Array }> = [];
  transmuxer.on('data', (segment) => {
    if (segment.type === 'audio' || segment.type === 'video') {
      segments.push({ type: segment.type, init: segment.initSegment, data: segment.data });
    }
  });
  const done = new Promise<void>((resolve) => transmuxer.on('done', resolve));
  transmuxer.push(new Uint8Array(readFileSync('node_modules/mux.js/test/segments/test-segment.ts')));
  transmuxer.flush();
  await done;
  video = segments.find(({ type }) => type === 'video')!;
  audio = segments.find(({ type }) => type === 'audio')!;
});

afterEach(() => vi.unstubAllGlobals());

describe('DASH task executor', () => {
  it('refreshes an expired URL, resumes both tracks, and removes partials after validation', async () => {
    const resources = new Map<string, Uint8Array>([
      ['https://cdn.example/video-init?token=old', video.init],
      ['https://cdn.example/video-1?token=old', video.data],
      ['https://cdn.example/audio-init?token=old', audio.init],
      ['https://cdn.example/audio-1?token=fresh', audio.data],
    ]);
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url === 'https://cdn.example/audio-1?token=old') {
        return new Response(null, { status: 403 });
      }
      const bytes = resources.get(url);
      return bytes
        ? new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 })
        : new Response(null, { status: 404 });
    }));
    const dash = (token: string): DashMediaSource => ({
      type: 'static',
      hasContentProtection: false,
      tracks: [
        {
          id: 'video',
          kind: 'video',
          codecs: 'avc1.64001f',
          initialization: { url: `https://cdn.example/video-init?token=${token}` },
          segments: [{ url: `https://cdn.example/video-1?token=${token}` }],
        },
        {
          id: 'audio',
          kind: 'audio',
          codecs: 'mp4a.40.2',
          initialization: { url: `https://cdn.example/audio-init?token=${token}` },
          segments: [{ url: `https://cdn.example/audio-1?token=${token}` }],
        },
      ],
    });
    let task: DownloadTask = {
      id: 'dash-task',
      source: {
        id: 'bilibili:video',
        adapterId: 'bilibili',
        pageUrl: 'https://www.bilibili.com/video/BV1test',
        title: 'Episode 1',
        seriesTitle: 'Series',
      },
      outputFormat: 'mp4',
      status: 'resolving',
      createdAt: 1,
      updatedAt: 1,
    };
    const checkpoints: DownloadTask[] = [];
    const events: string[] = [];
    let refreshCalls = 0;
    const { directory, files } = memoryDirectory();
    const result = await dashTaskExecutor.execute({
      task,
      media: {
        kind: 'dash',
        url: 'https://www.bilibili.com/video/BV1test',
        title: 'Episode 1',
        dash: dash('old'),
      },
      directory,
      directoryHandleId: 'directory-1',
      signal: new AbortController().signal,
      networkPolicy: { maxAttempts: 1 },
      networkSettings: NETWORK_PRESETS.resilient,
      loadText: async () => { throw new Error('Embedded DASH metadata should not load an MPD.'); },
      refreshMedia: async () => {
        refreshCalls += 1;
        return {
          kind: 'dash',
          url: 'https://www.bilibili.com/video/BV1test',
          title: 'Episode 1',
          dash: dash('fresh'),
        };
      },
      persistTask: async (next) => {
        task = next;
        checkpoints.push(next);
        return next;
      },
      onProgress: () => {},
      recordTaskEvent: async (code) => { events.push(code); },
      recordRequestRetry: () => {},
      t: createTranslator('en'),
    });

    expect(requests).toEqual([
      'https://cdn.example/video-init?token=old',
      'https://cdn.example/video-1?token=old',
      'https://cdn.example/audio-init?token=old',
      'https://cdn.example/audio-1?token=old',
      'https://cdn.example/audio-1?token=fresh',
    ]);
    expect(refreshCalls).toBe(1);
    expect(events).toEqual(expect.arrayContaining([
      'source-refresh-started',
      'source-refreshed',
    ]));
    expect(checkpoints.some(({ checkpoint }) =>
      checkpoint?.version === 2 &&
      checkpoint.tracks.video.completedSegments === 1 &&
      checkpoint.tracks.audio.completedSegments === 1)).toBe(true);
    expect(result.partialOutputsToRemove).toEqual([
      'Series - Episode 1.video.part.m4s',
      'Series - Episode 1.audio.part.m4s',
    ]);
    const validation = await commitValidatedDirectoryOutput(
      directory,
      result.finalFilename,
      result.validationOptions,
      result.partialOutputsToRemove,
    );
    expect(validation).toMatchObject({ videoTracks: 1, audioTracks: 1, fragmented: false });
    expect(files.has('Series - Episode 1.mp4')).toBe(true);
    expect(files.has('Series - Episode 1.video.part.m4s')).toBe(false);
    expect(files.has('Series - Episode 1.audio.part.m4s')).toBe(false);
  });
});
