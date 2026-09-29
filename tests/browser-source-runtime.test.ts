import { readFileSync } from 'node:fs';
import muxjs from 'mux.js';
import { describe, expect, it } from 'vitest';
import { DownloadRuntime } from '../src/runtime/download-runtime';
import type { ArtifactStore } from '../src/runtime/artifact-store';
import type { MediaSourceProvider } from '../src/runtime/media-source';
import { RuntimeError } from '../src/runtime/errors';
import { koalaItem, koalaDiscoveryAdapter } from '../src/core/discovery/adapters/koala';
import { DEFAULT_NETWORK_SETTINGS } from '../src/shared/settings';
import type { DownloadTask } from '../src/shared/download-task';
import { SOURCE_CHUNK_BYTES } from '../src/shared/browser-source';
import type { TaskDiagnosticEvent } from '../src/shared/task-diagnostics';
import { buildTaskDiagnosticReport } from '../src/core/diagnostics/task-report';

const page = 'https://app.koala-oss.club/videos/a38d4ed3-873b-4110-bf51-02f3a6319f2c';
async function harness() {
  const streams = new Map<string, { init: Uint8Array; media: Uint8Array }>();
  const transmuxer = new muxjs.mp4.Transmuxer({ remux: false, keepOriginalTimestamps: true });
  transmuxer.on('data', data => streams.set(data.type, { init: data.initSegment, media: data.data }));
  const done = new Promise<void>(resolve => transmuxer.on('done', resolve));
  transmuxer.push(new Uint8Array(readFileSync('node_modules/mux.js/test/segments/test-segment.ts'))); transmuxer.flush(); await done;
  const files = new Map<string, Uint8Array>(), log: string[] = [], tasks = new Map<string, DownloadTask>();
  const events: TaskDiagnosticEvent[] = [];
  const source = koalaItem(page, 'Browser source');
  tasks.set('task', { id: 'task', source, status: 'queued', outputFormat: 'mp4', createdAt: 1, updatedAt: 1 });
  const artifacts: ArtifactStore = {
    name: 'fixture', id: 'fixture-directory',
    async stat(name) { const bytes = files.get(name); return bytes ? { size: bytes.length } : null; },
    async read(name, offset, length) { return files.get(name)!.slice(offset, offset + length); },
    async remove(name) { files.delete(name); },
    async open(name, options) {
      let bytes = (files.get(name) ?? new Uint8Array()).slice(0, options?.resumeFrom ?? 0);
      let position = bytes.length;
      const writeAt = async (offset: number, data: Uint8Array) => {
        const next = new Uint8Array(Math.max(bytes.length, offset + data.length)); next.set(bytes); next.set(data, offset); bytes = next;
      };
      return {
        write: async data => { await writeAt(position, data); position += data.length; }, writeAt,
        close: async () => { files.set(name, bytes); log.push(`close:${name}`); },
        abort: async () => { if (options?.resumeFrom !== undefined) files.set(name, bytes); },
      };
    },
  };
  const control = { failAt: -1, failure: 'browserSourceUnavailable' as 'browserSourceUnavailable' | 'browserSourceExpired', fingerprint: 'stable-plan', gapAt: -1 };
  const processed: number[] = [], opened: Array<{ start: number; fresh: boolean }> = [];
  let closed = 0;
  const provider: MediaSourceProvider = {
    async open(_target, start, _signal, options) {
      opened.push({ start, fresh: options?.fresh ?? false });
      let current = start;
      return {
        plan: { sessionId: crypto.randomUUID(), fingerprint: control.fingerprint, durationSeconds: 6 * 8.94,
          width: 640, height: 360, segments: Array.from({ length: 6 }, (_, index) => ({ index, id: String(index), start: index * 8.94, duration: 8.94 })) },
        async process(index, onProgress) {
          processed.push(index);
          if (index === control.failAt) { control.failAt = -1; throw new RuntimeError(control.failure, { stage: 'process', segment: index }); }
          current = index; onProgress(100, 'downloading');
          const track = (kind: string) => ({ initializationBytes: streams.get(kind)!.init.length, initializationHash: `${kind}-init`, mediaBytes: streams.get(kind)!.media.length,
            startDTS: index * 8.94 + (index === control.gapAt ? 2 : 0), endDTS: (index + 1) * 8.94 + (index === control.gapAt ? 2 : 0),
            startPTS: index * 8.94, endPTS: (index + 1) * 8.94 });
          return { index, networkBytes: 100, tracks: { audio: track('audio'), video: track('video') } };
        },
        async read(kind, part, offset, length) {
          expect(length).toBeLessThanOrEqual(SOURCE_CHUNK_BYTES);
          return streams.get(kind)![part === 'initialization' ? 'init' : 'media'].slice(offset, offset + length);
        },
        async acknowledge(index) { expect(index).toBe(current); },
        async close() { closed++; },
      };
    },
  };
  const runtime = new DownloadRuntime({ artifacts, mediaSourceProvider: provider,
    recordEvent: async event => { events.push(structuredClone(event)); },
    store: { list: async () => [...tasks.values()].map(task => structuredClone(task)),
      save: async task => {
        const cp = task.checkpoint;
        if (cp?.version === 3 && cp.completedSegments) {
          for (const track of Object.values(cp.tracks)) expect(files.get(track.partialFilename)?.length).toBeGreaterThanOrEqual(track.bytesWritten);
          log.push(`checkpoint:${cp.completedSegments}`);
        }
        tasks.set(task.id, structuredClone(task)); return structuredClone(task);
      }, remove: async id => { tasks.delete(id); } },
    locks: { runExclusive: operation => operation() },
    resolve: item => koalaDiscoveryAdapter.resolve(item, { fetchText: async () => '' }),
    transforms: { createHlsWriter: writer => writer, createDashWriter: writer => writer },
    concurrency: 1, networkSettings: { ...DEFAULT_NETWORK_SETTINGS, taskRecoveryAttempts: 0 },
  });
  return { runtime, tasks, files, control, processed, opened, log, events, closed: () => closed };
}

describe('browser media source runtime', () => {
  it('keeps the last failure evidence exportable after a manual retry clears current task state', async () => {
    const h = await harness(); h.control.failAt = 0; await h.runtime.start();
    await h.runtime.retry('task');
    expect(h.tasks.get('task')?.failure).toBeUndefined();
    const report = JSON.parse(buildTaskDiagnosticReport(h.tasks.get('task')!, h.events,
      { network: DEFAULT_NETWORK_SETTINGS, taskConcurrency: 1 }));
    expect(report.events.find((event: TaskDiagnosticEvent) => event.code === 'source-waiting')).toMatchObject({
      failure: { code: 'browserSourceUnavailable', params: { stage: 'process', segment: 0 } },
    });
  });
  it('downloads a whole plan through bounded reads and commits durable checkpoints before completion', async () => {
    const h = await harness(); await h.runtime.start();
    expect(h.tasks.get('task')?.status).toBe('completed');
    expect(h.processed).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...h.files.keys()]).toEqual(['Browser source.mp4']);
    expect(h.log).toContain('checkpoint:4'); expect(h.closed()).toBe(1);
  });
  it('releases a missing source into a separate waiting state and resumes only committed segments', async () => {
    const h = await harness(); h.control.failAt = 4;
    await h.runtime.start();
    expect(h.tasks.get('task')?.status).toBe('waiting-source');
    expect(h.tasks.get('task')?.checkpoint?.completedSegments).toBe(4);
    await h.runtime.retry('task'); await h.runtime.start();
    expect(h.opened.map(value => value.start)).toEqual([0, 4]);
    expect(h.processed.filter(index => index < 4)).toEqual([0, 1, 2, 3]);
    expect(h.tasks.get('task')?.status).toBe('completed');
  });
  it('renews expired authorization once using a fresh host session, retaining committed media', async () => {
    const h = await harness(); h.control.failAt = 4; h.control.failure = 'browserSourceExpired';
    await h.runtime.start();
    expect(h.opened).toEqual([{ start: 0, fresh: false }, { start: 4, fresh: true }]);
    expect(h.tasks.get('task')?.status).toBe('completed');
  });
  it('keeps partial files when a refreshed plan changes', async () => {
    const h = await harness(); h.control.failAt = 4; await h.runtime.start();
    h.control.fingerprint = 'different-content'; await h.runtime.retry('task'); await h.runtime.start();
    expect(h.tasks.get('task')?.failure?.code).toBe('browserSourcePlanChanged');
    expect(h.tasks.get('task')?.checkpoint?.completedSegments).toBe(4);
    expect([...h.files.keys()].sort()).toEqual(['Browser source.audio.source.part.m4s', 'Browser source.video.source.part.m4s']);
  });
  it('refuses a timeline gap instead of silently joining it', async () => {
    const h = await harness(); h.control.gapAt = 4; await h.runtime.start();
    expect(h.tasks.get('task')?.status).toBe('failed');
    expect(h.tasks.get('task')?.failure?.code).toBe('browserSourcePlanChanged');
    expect(h.tasks.get('task')?.checkpoint?.completedSegments).toBe(4);
  });
  it.each(['filename', 'boundary'])('refuses a corrupted checkpoint %s before touching files', async kind => {
    const h = await harness(); h.control.failAt = 4; await h.runtime.start();
    const task = h.tasks.get('task')!;
    if (task.checkpoint?.version !== 3) throw Error('Missing fixture checkpoint');
    h.files.set('unrelated.mp4', new Uint8Array(task.checkpoint.tracks.video.bytesWritten).fill(7));
    const original = new Map([...h.files].map(([name, value]) => [name, value.slice()]));
    if (kind === 'filename') task.checkpoint.tracks.video.partialFilename = 'unrelated.mp4';
    else task.checkpoint.tracks.video.segmentEndOffsets[0] = 1;
    await h.runtime.retry('task'); await h.runtime.start();
    expect(h.tasks.get('task')?.failure?.code).toBe('browserSourcePlanChanged');
    expect(h.files).toEqual(original);
    expect(h.opened).toHaveLength(1);
  });
});
