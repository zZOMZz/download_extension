import { readFileSync } from 'node:fs';
import muxjs from 'mux.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DownloadRuntime, type DownloadRuntimeOptions, type ExecutionLocks, type TaskStore } from '../src/runtime/download-runtime';
import type { ArtifactStore } from '../src/runtime/artifact-store';
import type { TaskExecutorContext, TaskExecutorResult } from '../src/runtime/task-executors/types';
import { RuntimeError } from '../src/runtime/errors';
import { NetworkResourceError } from '../src/core/hls/download-hls';
import type { DownloadTask, HlsDownloadCheckpoint } from '../src/shared/download-task';
import { DEFAULT_NETWORK_SETTINGS } from '../src/shared/settings';
import { resolveDiscoveredMedia } from '../src/core/discovery/registry';
import type { TaskDiagnosticEvent } from '../src/shared/task-diagnostics';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return { id: 'one', source: { id: 'source-one', adapterId: 'fixture', title: 'Fixture', pageUrl: 'https://example.test/watch' },
    status: 'queued', outputFormat: 'original', createdAt: 1, updatedAt: 1, ...overrides };
}

function checkpoint(overrides: Partial<HlsDownloadCheckpoint> = {}): HlsDownloadCheckpoint {
  return { version: 1, playlistFingerprint: 'fixture', directoryName: 'Downloads', directoryHandleId: 'directory-a',
    partialFilename: 'one.part.ts', finalFilename: 'one.ts', completedSegments: 1, totalSegments: 1,
    bytesWritten: 564, segmentEndOffsets: [564], updatedAt: 1, ...overrides };
}

function commit(): NonNullable<DownloadTask['outputCommit']> {
  return { directoryName: 'Downloads', directoryHandleId: 'directory-a', finalFilename: 'one.ts',
    validationOptions: { format: 'ts', expectedBytes: 564 }, partialFilenames: ['one.part.ts'] };
}

function validTs(): Uint8Array {
  const bytes = new Uint8Array(564);
  for (const offset of [0, 188, 376]) bytes[offset] = 0x47;
  return bytes;
}

class MemoryTaskStore implements TaskStore {
  readonly tasks = new Map<string, DownloadTask>();
  beforeSave?: (task: DownloadTask) => void | Promise<void>;
  afterSave?: (task: DownloadTask) => void | Promise<void>;
  constructor(tasks: DownloadTask[], readonly log: string[]) {
    for (const item of tasks) this.tasks.set(item.id, structuredClone(item));
  }
  list = vi.fn(async () => [...this.tasks.values()].map((item) => structuredClone(item)));
  save = vi.fn(async (value: DownloadTask) => {
    await this.beforeSave?.(value);
    this.tasks.set(value.id, structuredClone(value));
    this.log.push(`save:${value.id}:${value.status}:${value.outputCommit ? 'commit' : 'clean'}`);
    await this.afterSave?.(value);
    return structuredClone(value);
  });
  remove = vi.fn(async (id: string) => { this.tasks.delete(id); this.log.push(`remove-task:${id}`); });
}

class MemoryExecutionLocks implements ExecutionLocks {
  held = false;
  constructor(readonly log: string[]) {}
  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.held) throw new RuntimeError('runtimeBusy');
    this.held = true;
    this.log.push('lock-acquired');
    try { return await operation(); }
    finally { this.log.push('lock-released'); this.held = false; }
  }
}

function harness(tasks: DownloadTask[] = [task()]) {
  const log: string[] = [];
  const files = new Map<string, Uint8Array>();
  const store = new MemoryTaskStore(tasks, log);
  const locks = new MemoryExecutionLocks(log);
  const artifacts: ArtifactStore = {
    name: 'Downloads', id: 'directory-a',
    stat: vi.fn(async (name) => { log.push(`validate:${name}`); const bytes = files.get(name); return bytes ? { size: bytes.length } : null; }),
    read: vi.fn(async (name, offset, length) => {
      const bytes = files.get(name);
      if (!bytes) throw new Error('Missing artifact');
      return bytes.slice(offset, offset + length);
    }),
    open: vi.fn(async () => { throw new Error('The fixture executor supplies its output directly.'); }),
    remove: vi.fn(async (name) => { log.push(`remove-file:${name}`); files.delete(name); }),
  };
  const executor = { kind: 'hls' as const, execute: vi.fn(async (context: TaskExecutorContext): Promise<TaskExecutorResult> => {
    await context.persistTask({ ...context.task, status: 'downloading' });
    files.set(`${context.task.id}.part.ts`, validTs());
    files.set(`${context.task.id}.ts`, validTs());
    return { finalFilename: `${context.task.id}.ts`, validationOptions: { format: 'ts', expectedBytes: 564 },
      partialOutputsToRemove: [`${context.task.id}.part.ts`] };
  }) };
  const resolve = vi.fn(async () => ({ kind: 'hls' as const, url: 'https://example.test/index.m3u8', title: 'Fixture' }));
  const options: DownloadRuntimeOptions = {
    store, artifacts, locks, resolve,
    transforms: { createHlsWriter: (writer) => writer, createDashWriter: (writer) => writer },
    concurrency: 2, executors: [executor],
    networkSettings: { ...DEFAULT_NETWORK_SETTINGS, taskRecoveryAttempts: 1, taskRetryBaseDelaySeconds: 5, taskRetryMaxDelaySeconds: 30 },
  };
  return { runtime: new DownloadRuntime(options), options, store, locks, artifacts, executor, resolve, log, files };
}

function recoverableFailure(): NetworkResourceError {
  return new NetworkResourceError('media-segment', 'https://example.test/segment', 1, true, new Error('Temporary outage'));
}

afterEach(() => vi.useRealTimers());

describe('download runtime ownership and recovery', () => {
  it('does not claim or recover interrupted work when a client only refreshes or subscribes', async () => {
    const h = harness([task({ status: 'downloading', checkpoint: checkpoint() })]);
    const observer = vi.fn();
    const unsubscribe = h.runtime.subscribe(observer);
    await h.runtime.refresh();
    expect(observer).toHaveBeenCalledOnce();
    expect(h.runtime.getSnapshot().tasks[0]?.status).toBe('downloading');
    expect(h.store.save).not.toHaveBeenCalled();
    expect(h.log).not.toContain('lock-acquired');
    expect(h.executor.execute).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('excludes another runtime and its mutations until the active owner finishes', async () => {
    const h = harness();
    const second = new DownloadRuntime(h.options);
    const entered = deferred();
    const release = deferred();
    const execute = h.executor.execute.getMockImplementation()!;
    h.executor.execute.mockImplementation(async (context) => {
      await context.persistTask({ ...context.task, status: 'downloading' });
      entered.resolve();
      await release.promise;
      return execute(context);
    });
    const first = h.runtime.start();
    await entered.promise;
    await second.refresh();
    expect(second.getSnapshot().tasks[0]?.status).toBe('downloading');
    await expect(second.start()).rejects.toMatchObject({ code: 'runtimeBusy' });
    await expect(second.retry('one')).rejects.toMatchObject({ code: 'runtimeBusy' });
    await expect(second.remove('one')).rejects.toMatchObject({ code: 'runtimeBusy' });
    expect(h.locks.held).toBe(true);
    release.resolve();
    await first;
    expect(h.executor.execute).toHaveBeenCalledOnce();
    expect(h.store.tasks.get('one')?.status).toBe('completed');
    expect(h.locks.held).toBe(false);
  });

  it('recovers an interrupted task only after acquiring execution ownership', async () => {
    const h = harness([task({ status: 'downloading', checkpoint: checkpoint() })]);
    await h.runtime.start();
    expect(h.log[0]).toBe('lock-acquired');
    expect(h.log.indexOf('save:one:queued:clean')).toBeGreaterThan(0);
    expect(h.executor.execute.mock.calls[0]?.[0].task.checkpoint).toEqual(checkpoint());
    expect(h.store.tasks.get('one')?.status).toBe('completed');
  });

  it('rejects a resume in a different output identity before resolving or running an executor', async () => {
    const h = harness([task({ checkpoint: checkpoint({ directoryHandleId: 'another-directory' }) })]);
    await h.runtime.start();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.executor.execute).not.toHaveBeenCalled();
    expect(h.store.tasks.get('one')).toMatchObject({ status: 'failed', failure: { code: 'chooseOriginalFolderResume' } });
    expect(h.artifacts.remove).not.toHaveBeenCalled();
  });

  it.each(['restart', 'remove'] as const)('blocks %s when names match but output identities differ', async (operation) => {
    const original = task({ status: 'failed', checkpoint: checkpoint({ directoryHandleId: 'another-directory' }) });
    const h = harness([original]);
    await expect(h.runtime[operation]('one')).rejects.toMatchObject({ code: 'chooseOriginalFolderResume' });
    expect(h.store.tasks.get('one')).toEqual(original);
    expect(h.artifacts.remove).not.toHaveBeenCalled();
    expect(h.store.remove).not.toHaveBeenCalled();
  });

  it.each(['restart', 'remove'] as const)('protects committed output with another directory identity during %s', async (operation) => {
    const original = task({ status: 'failed', outputCommit: { ...commit(), directoryHandleId: 'another-directory' } });
    const h = harness([original]);
    await expect(h.runtime[operation]('one')).rejects.toMatchObject({ code: 'chooseOriginalFolderResume' });
    expect(h.store.tasks.get('one')).toEqual(original);
    expect(h.artifacts.remove).not.toHaveBeenCalled();
  });

  it('retains compatibility with a legacy checkpoint identified only by directory name', async () => {
    const saved = checkpoint();
    delete saved.directoryHandleId;
    const h = harness([task({ checkpoint: saved })]);
    await h.runtime.start();
    expect(h.executor.execute).toHaveBeenCalledOnce();
    expect(h.store.tasks.get('one')?.status).toBe('completed');
  });

  it('queues a manual retry while retaining its checkpoint and resetting backoff', async () => {
    const h = harness([task({ status: 'failed', checkpoint: checkpoint(), recoveryAttempt: 3, nextRetryAt: 100 })]);
    await h.runtime.retry('one');
    expect(h.store.tasks.get('one')).toMatchObject({ status: 'queued', checkpoint: checkpoint() });
    expect(h.store.tasks.get('one')?.recoveryAttempt).toBeUndefined();
    expect(h.store.tasks.get('one')?.nextRetryAt).toBeUndefined();
    expect(h.executor.execute).not.toHaveBeenCalled();
  });

  it('retries a recoverable failure after its backoff and retains ownership while waiting', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.executor.execute.mockRejectedValueOnce(recoverableFailure());
    const waiting = deferred();
    h.runtime.subscribe(({ tasks }) => { if (tasks[0]?.status === 'waiting') waiting.resolve(); });
    const pending = h.runtime.start();
    await waiting.promise;
    expect(h.locks.held).toBe(true);
    expect(h.executor.execute).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(h.executor.execute).toHaveBeenCalledTimes(2);
    expect(h.store.tasks.get('one')?.status).toBe('completed');
    expect(h.store.tasks.get('one')?.recoveryAttempt).toBeUndefined();
  });

  it('stops automatic recovery at its configured attempt limit', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.executor.execute.mockRejectedValue(recoverableFailure());
    const waiting = deferred();
    h.runtime.subscribe(({ tasks }) => { if (tasks[0]?.status === 'waiting') waiting.resolve(); });
    const pending = h.runtime.start();
    await waiting.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(h.executor.execute).toHaveBeenCalledTimes(2);
    expect(h.store.tasks.get('one')?.status).toBe('failed');
    expect(h.store.tasks.get('one')?.nextRetryAt).toBeUndefined();
    expect(h.locks.held).toBe(false);
  });

  it('cancels a backoff wait without executing the retry or releasing ownership early', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.executor.execute.mockRejectedValueOnce(recoverableFailure());
    const waiting = deferred();
    h.runtime.subscribe(({ tasks }) => { if (tasks[0]?.status === 'waiting') waiting.resolve(); });
    const pending = h.runtime.start();
    await waiting.promise;
    h.runtime.cancel();
    await pending;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.executor.execute).toHaveBeenCalledOnce();
    expect(h.runtime.getSnapshot().running).toBe(false);
    expect(h.locks.held).toBe(false);
  });

  it('retains ownership until a peer finishes after another worker encounters a store failure', async () => {
    const h = harness([task(), task({ id: 'two' })]);
    const failure = new Error('First task cannot persist any state');
    h.store.beforeSave = (value) => { if (value.id === 'one') throw failure; };
    const entered = deferred();
    const release = deferred();
    const execute = h.executor.execute.getMockImplementation()!;
    h.executor.execute.mockImplementation(async (context) => {
      entered.resolve();
      await release.promise;
      return execute(context);
    });
    let settled = false;
    const pending = h.runtime.start().then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    await entered.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.locks.held).toBe(true);
    await expect(new DownloadRuntime(h.options).start()).rejects.toMatchObject({ code: 'runtimeBusy' });
    release.resolve();
    expect(await pending).toBe(failure);
    expect(h.store.tasks.get('two')?.status).toBe('completed');
    expect(h.locks.held).toBe(false);
    expect(h.log.indexOf('lock-released')).toBeGreaterThan(h.log.indexOf('save:two:completed:clean'));
  });

  it('drains an aborted executor before allowing another owner', async () => {
    const h = harness();
    const entered = deferred();
    const aborted = deferred();
    const release = deferred();
    h.executor.execute.mockImplementation(async ({ signal }) => {
      entered.resolve();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
      await release.promise;
      throw signal.reason;
    });
    const pending = h.runtime.start();
    await entered.promise;
    h.runtime.cancel();
    await aborted.promise;
    expect(h.locks.held).toBe(true);
    await expect(new DownloadRuntime(h.options).start()).rejects.toMatchObject({ code: 'runtimeBusy' });
    release.resolve();
    await pending;
    expect(h.store.tasks.get('one')?.status).toBe('cancelled');
    expect(h.locks.held).toBe(false);
  });
});

describe('download runtime output commit boundaries', () => {
  it('persists the commit intent, validates, persists completed, and only then removes fragments', async () => {
    const h = harness();
    await h.runtime.start();
    const intent = h.log.indexOf('save:one:downloading:commit');
    const validate = h.log.indexOf('validate:one.ts');
    const completed = h.log.indexOf('save:one:completed:commit');
    const cleanup = h.log.indexOf('remove-file:one.part.ts');
    const cleaned = h.log.indexOf('save:one:completed:clean');
    expect(intent).toBeGreaterThan(-1);
    expect(validate).toBeGreaterThan(intent);
    expect(completed).toBeGreaterThan(validate);
    expect(cleanup).toBeGreaterThan(completed);
    expect(cleaned).toBeGreaterThan(cleanup);
    expect(h.files.has('one.part.ts')).toBe(false);
    expect(h.files.has('one.ts')).toBe(true);
  });

  it('preserves fragments when saving the output commit intent fails', async () => {
    const h = harness();
    h.store.beforeSave = (value) => {
      if (value.outputCommit && value.status !== 'completed') throw new Error('Intent storage unavailable');
    };
    await h.runtime.start();
    expect(h.artifacts.stat).not.toHaveBeenCalled();
    expect(h.artifacts.remove).not.toHaveBeenCalled();
    expect(h.files.has('one.part.ts')).toBe(true);
    expect(h.store.tasks.get('one')?.status).toBe('failed');
  });

  it('retains a durable commit intent after a lost save response and completes it on manual retry', async () => {
    const h = harness();
    let failed = false;
    h.store.afterSave = (value) => {
      if (!failed && value.status === 'downloading' && value.outputCommit) {
        failed = true;
        throw new Error('Lost output intent acknowledgement');
      }
    };
    await h.runtime.start();
    expect(h.store.tasks.get('one')).toMatchObject({ status: 'failed', outputCommit: commit() });
    expect(h.files.has('one.part.ts')).toBe(true);
    expect(h.artifacts.remove).not.toHaveBeenCalled();
    await h.runtime.retry('one');
    await h.runtime.start();
    expect(h.executor.execute).toHaveBeenCalledOnce();
    expect(h.store.tasks.get('one')?.status).toBe('completed');
    expect(h.files.has('one.part.ts')).toBe(false);
  });

  it('retains the commit and fragments when output validation fails', async () => {
    const h = harness();
    const execute = h.executor.execute.getMockImplementation()!;
    h.executor.execute.mockImplementation(async (context) => {
      const result = await execute(context);
      h.files.set('one.ts', Uint8Array.of(1));
      return result;
    });
    await h.runtime.start();
    expect(h.store.tasks.get('one')).toMatchObject({ status: 'failed', outputCommit: commit() });
    expect(h.files.has('one.part.ts')).toBe(true);
    expect(h.artifacts.remove).not.toHaveBeenCalled();
  });

  it('keeps recovery fragments when persisting completed fails before commit', async () => {
    const h = harness();
    h.store.beforeSave = (value) => { if (value.status === 'completed') throw new Error('Completion storage unavailable'); };
    await h.runtime.start();
    expect(h.store.tasks.get('one')?.status).not.toBe('completed');
    expect(h.store.tasks.get('one')?.outputCommit).toEqual(commit());
    expect(h.files.has('one.part.ts')).toBe(true);
    expect(h.artifacts.remove).not.toHaveBeenCalled();
  });

  it('never overwrites a durable completed state when its save response is lost', async () => {
    const h = harness();
    let failed = false;
    h.store.afterSave = (value) => {
      if (!failed && value.status === 'completed') { failed = true; throw new Error('Lost completion acknowledgement'); }
    };
    await h.runtime.start();
    expect(h.store.tasks.get('one')?.status).toBe('completed');
    const completed = h.log.indexOf('save:one:completed:commit');
    expect(h.log.slice(completed + 1).some((entry) => entry.includes(':failed:'))).toBe(false);
  });

  it('keeps completed durable and retries fragment cleanup on the next owned run', async () => {
    const h = harness();
    const remove = vi.mocked(h.artifacts.remove);
    remove.mockRejectedValueOnce(new Error('Directory temporarily unavailable'));
    await h.runtime.start();
    expect(h.store.tasks.get('one')).toMatchObject({ status: 'completed', outputCommit: commit() });
    expect(h.files.has('one.part.ts')).toBe(true);
    await h.runtime.start();
    expect(h.executor.execute).toHaveBeenCalledOnce();
    expect(h.store.tasks.get('one')?.status).toBe('completed');
    expect(h.store.tasks.get('one')?.outputCommit).toBeUndefined();
    expect(h.files.has('one.part.ts')).toBe(false);
  });

  it('does not downgrade completed when saving the cleanup result fails', async () => {
    const h = harness();
    h.store.beforeSave = (value) => {
      if (value.status === 'completed' && !value.outputCommit) throw new Error('Cleanup acknowledgement unavailable');
    };
    await h.runtime.start();
    expect(h.store.tasks.get('one')).toMatchObject({ status: 'completed', outputCommit: commit() });
    expect(h.files.has('one.part.ts')).toBe(false);
    delete h.store.beforeSave;
    await h.runtime.start();
    expect(h.executor.execute).toHaveBeenCalledOnce();
    expect(h.store.tasks.get('one')?.status).toBe('completed');
    expect(h.store.tasks.get('one')?.outputCommit).toBeUndefined();
  });

  it('recovers a saved output commit without rerunning the source or download', async () => {
    const h = harness([task({ status: 'downloading', checkpoint: checkpoint(), outputCommit: commit() })]);
    h.files.set('one.ts', validTs());
    h.files.set('one.part.ts', validTs());
    await h.runtime.start();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.executor.execute).not.toHaveBeenCalled();
    expect(h.store.tasks.get('one')?.status).toBe('completed');
    expect(h.store.tasks.get('one')?.checkpoint).toBeUndefined();
    expect(h.files.has('one.part.ts')).toBe(false);
  });
});

describe('download runtime queue commands', () => {
  it('deduplicates existing and repeated sources while preserving source metadata and per-protocol output policy', async () => {
    const original = task({ status: 'completed', outputFormat: 'mp4' });
    const h = harness([original]);
    const source = original.source;
    const hls = { ...source, id: 'hls', mediaKind: 'hls' as const, title: 'HLS choice', sequence: 3 };
    const dash = { ...source, id: 'dash', mediaKind: 'dash' as const, title: 'DASH choice', sequence: 4 };
    const progressive = { ...source, id: 'progressive', mediaKind: 'progressive' as const, title: 'MP4 choice', sequence: 5 };
    const unknown = { ...source, id: 'unspecified' };
    const result = await h.runtime.enqueue([source, hls, hls, dash, progressive, unknown], 'original');
    expect(result.tasks).toHaveLength(5);
    expect(h.store.tasks.get(original.id)).toEqual(original);
    const added = result.tasks.filter(({ id }) => id !== original.id);
    expect(added.find(({ source: item }) => item.id === 'hls')).toMatchObject({ source: hls, outputFormat: 'original', status: 'queued' });
    expect(added.find(({ source: item }) => item.id === 'dash')).toMatchObject({ source: dash, outputFormat: 'mp4', status: 'queued' });
    expect(added.find(({ source: item }) => item.id === 'progressive')).toMatchObject({ source: progressive, outputFormat: 'mp4', status: 'queued' });
    expect(added.find(({ source: item }) => item.id === 'unspecified')?.outputFormat).toBe('original');
    expect(h.executor.execute).not.toHaveBeenCalled();
    expect(h.log[0]).toBe('lock-acquired');
    expect(h.log.at(-1)).toBe('lock-released');
  });

  it('applies the same deduplication and output policy through a host bulk-add port', async () => {
    const h = harness([]);
    const source = task().source;
    const hls = { ...source, id: 'hls', mediaKind: 'hls' as const };
    const dash = { ...source, id: 'dash', mediaKind: 'dash' as const };
    const progressive = { ...source, id: 'progressive', mediaKind: 'progressive' as const };
    const add = vi.fn<NonNullable<TaskStore['add']>>(async (items, outputFormat) => {
      for (const item of items) h.store.tasks.set(item.id, task({ id: item.id, source: item, outputFormat }));
      return h.store.list();
    });
    h.options.store.add = add;
    await h.runtime.enqueue([hls, dash, progressive, hls], 'original');
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith([hls], 'original');
    expect(add).toHaveBeenCalledWith([dash, progressive], 'mp4');
    expect(h.store.save).not.toHaveBeenCalled();
    expect(h.runtime.getSnapshot().tasks).toHaveLength(3);
    await h.runtime.enqueue([hls, dash, progressive], 'mp4');
    expect(add).toHaveBeenCalledTimes(2);
  });

  it.each(['enqueue', 'clearCompleted'] as const)('requires ownership for %s and does not mutate a running queue', async (command) => {
    const h = harness();
    const release = deferred();
    const owned = h.locks.runExclusive(() => release.promise);
    const before = await h.store.list();
    const pending = command === 'enqueue'
      ? h.runtime.enqueue([{ ...task().source, id: 'another' }], 'mp4')
      : h.runtime.clearCompleted();
    await expect(pending).rejects.toMatchObject({ code: 'runtimeBusy' });
    expect(await h.store.list()).toEqual(before);
    expect(h.artifacts.remove).not.toHaveBeenCalled();
    release.resolve();
    await owned;
  });

  it('clears completed records only after fragment cleanup and preserves final files and unfinished tasks', async () => {
    const h = harness([task({ status: 'completed', outputCommit: commit() }), task({ id: 'two', status: 'completed' }), task({ id: 'three' })]);
    h.files.set('one.ts', validTs());
    h.files.set('one.part.ts', validTs());
    await h.runtime.clearCompleted();
    expect([...h.store.tasks.keys()]).toEqual(['three']);
    expect(h.runtime.getSnapshot().tasks.map(({ id }) => id)).toEqual(['three']);
    expect(h.files.has('one.ts')).toBe(true);
    expect(h.files.has('one.part.ts')).toBe(false);
    expect(h.log.indexOf('remove-task:one')).toBeGreaterThan(h.log.indexOf('save:one:completed:clean'));
    expect(h.log.indexOf('save:one:completed:clean')).toBeGreaterThan(h.log.indexOf('remove-file:one.part.ts'));
  });

  it('retains a completed record and its cleanup intent if fragment removal fails', async () => {
    const h = harness([task({ status: 'completed', outputCommit: commit() })]);
    h.files.set('one.part.ts', validTs());
    vi.mocked(h.artifacts.remove).mockRejectedValueOnce(new Error('Output temporarily unavailable'));
    await h.runtime.clearCompleted();
    expect(h.store.tasks.get('one')).toMatchObject({ status: 'completed', outputCommit: commit() });
    expect(h.store.remove).not.toHaveBeenCalled();
    expect(h.files.has('one.part.ts')).toBe(true);
    await h.runtime.clearCompleted();
    expect(h.store.tasks.size).toBe(0);
    expect(h.files.has('one.part.ts')).toBe(false);
  });

  it('retains a completed record until cleanup state can be durably saved', async () => {
    const h = harness([task({ status: 'completed', outputCommit: commit() })]);
    h.files.set('one.part.ts', validTs());
    h.store.beforeSave = () => { throw new Error('Storage unavailable'); };
    await h.runtime.clearCompleted();
    expect(h.store.tasks.get('one')).toMatchObject({ status: 'completed', outputCommit: commit() });
    expect(h.store.remove).not.toHaveBeenCalled();
    expect(h.files.has('one.part.ts')).toBe(false);
    delete h.store.beforeSave;
    await h.runtime.clearCompleted();
    expect(h.store.tasks.size).toBe(0);
  });

  it('refuses to clear a pending cleanup record belonging to a different directory identity', async () => {
    const original = task({ status: 'completed', outputCommit: { ...commit(), directoryHandleId: 'another-directory' } });
    const h = harness([original]);
    await expect(h.runtime.clearCompleted()).rejects.toMatchObject({ code: 'chooseOriginalFolderResume' });
    expect(h.store.tasks.get('one')).toEqual(original);
    expect(h.artifacts.remove).not.toHaveBeenCalled();
    expect(h.store.remove).not.toHaveBeenCalled();
  });
});

function allowArtifactWrites(h: ReturnType<typeof harness>) {
  vi.mocked(h.artifacts.open).mockImplementation(async (name) => {
    h.files.set(name, new Uint8Array(0));
    return {
      async write(bytes) {
        const previous = h.files.get(name)!;
        const next = new Uint8Array(previous.length + bytes.length);
        next.set(previous); next.set(bytes, previous.length); h.files.set(name, next);
      },
      async writeAt(position, bytes) {
        const previous = h.files.get(name)!;
        const next = new Uint8Array(Math.max(previous.length, position + bytes.length));
        next.set(previous); next.set(bytes, position); h.files.set(name, next);
      },
      async close() {}, async abort() {},
    };
  });
}

function writeSameOutput(h: ReturnType<typeof harness>, filename = 'shared.ts') {
  allowArtifactWrites(h);
  h.executor.execute.mockImplementation(async ({ artifacts }) => {
    const writer = await artifacts.open(filename);
    await writer.write(validTs());
    await writer.close();
    return { finalFilename: filename, validationOptions: { format: 'ts', expectedBytes: 564 } };
  });
}

describe('download runtime output ownership', () => {
  it('rejects a second task opening the same output before it can truncate the first task output', async () => {
    const h = harness([task(), task({ id: 'two' })]);
    writeSameOutput(h);
    await h.runtime.start();
    expect(h.artifacts.open).toHaveBeenCalledOnce();
    expect(h.store.tasks.get('one')?.status).toBe('completed');
    expect(h.store.tasks.get('two')).toMatchObject({ status: 'failed', failure: { code: 'outputConflict' } });
    expect(h.files.get('shared.ts')).toEqual(validTs());
  });

  it('does not persist another task file ownership before an output conflict is detected', async () => {
    const h = harness([task(), task({ id: 'two' })]);
    allowArtifactWrites(h);
    const saved = checkpoint({ partialFilename: 'shared.part.ts', finalFilename: 'shared.ts' });
    h.executor.execute.mockImplementation(async (context) => {
      await context.persistTask({ ...context.task, status: 'downloading', checkpoint: saved });
      const writer = await context.artifacts.open('shared.part.ts');
      await writer.write(validTs());
      await writer.close();
      throw new Error('Fixture stops with recoverable partial output');
    });
    await h.runtime.start();
    expect(h.store.tasks.get('one')).toMatchObject({ status: 'failed', checkpoint: saved });
    expect(h.store.tasks.get('two')).toMatchObject({ status: 'failed', failure: { code: 'outputConflict' } });
    expect(h.store.tasks.get('two')?.checkpoint).toBeUndefined();
    expect(h.artifacts.open).toHaveBeenCalledOnce();
    await h.runtime.remove('two');
    expect(h.files.get('shared.part.ts')).toEqual(validTs());
  });

  it.each(['checkpoint', 'outputCommit'] as const)('reserves existing %s output before a new task can open it', async (record) => {
    const owner = record === 'checkpoint'
      ? task({ status: 'failed', checkpoint: checkpoint() })
      : task({ status: 'completed', outputCommit: commit() });
    const h = harness([owner, task({ id: 'two' })]);
    h.files.set('one.ts', validTs());
    h.files.set('one.part.ts', validTs());
    writeSameOutput(h, 'one.ts');
    await h.runtime.start();
    expect(h.artifacts.open).not.toHaveBeenCalled();
    expect(h.store.tasks.get('one')?.status).toBe(owner.status);
    expect(h.store.tasks.get('two')).toMatchObject({ status: 'failed', failure: { code: 'outputConflict' } });
    expect(h.files.get('one.ts')).toEqual(validTs());
    if (record === 'checkpoint') expect(h.files.get('one.part.ts')).toEqual(validTs());
  });

  it.each(['restart', 'remove'] as const)('refuses %s cleanup for a legacy checkpoint shared with another task', async (operation) => {
    const saved = checkpoint({ partialFilename: 'shared.part.ts', finalFilename: 'shared.ts' });
    const one = task({ status: 'failed', checkpoint: saved });
    const two = task({ id: 'two', status: 'failed', checkpoint: saved });
    const h = harness([one, two]);
    h.files.set('shared.part.ts', validTs());
    await expect(h.runtime[operation]('two')).rejects.toMatchObject({ code: 'outputConflict' });
    expect(h.artifacts.remove).not.toHaveBeenCalled();
    expect(h.store.tasks.get('one')).toEqual(one);
    expect(h.store.tasks.get('two')).toEqual(two);
    expect(h.files.get('shared.part.ts')).toEqual(validTs());
  });

  it('does not reserve names belonging to a different output directory', async () => {
    const owner = task({ status: 'failed', checkpoint: checkpoint({ directoryHandleId: 'another-directory' }) });
    const h = harness([owner, task({ id: 'two' })]);
    writeSameOutput(h, 'one.ts');
    await h.runtime.start();
    expect(h.store.tasks.get('one')).toEqual(owner);
    expect(h.store.tasks.get('two')?.status).toBe('completed');
    expect(h.artifacts.open).toHaveBeenCalledOnce();
    expect(h.files.get('one.ts')).toEqual(validTs());
  });
});


function bilibiliProgressiveTask(mediaKind?: 'dash'): DownloadTask {
  return task({ source: {
    id: 'bilibili:ep102:1002', adapterId: 'bilibili', title: 'Fixture',
    pageUrl: 'https://www.bilibili.com/bangumi/play/ep102',
    ...(mediaKind ? { mediaKind } : {}),
  } });
}

function bilibiliProgressivePage(token: string): string {
  return `<script>const playurlSSRData = ${JSON.stringify({ status: 200, data: { result: {
    arc: { cid: 1002 }, ep_id: 102, play_video_type: 'whole',
    video_info: { format: 'mp4', durl: [{ url: `https://cdn.example/full.mp4?token=${token}`, length: 1000 }] },
  } } })};</script>`;
}

async function progressiveMp4(): Promise<Uint8Array> {
  const muxer = new muxjs.mp4.Transmuxer();
  let bytes = new Uint8Array();
  muxer.on('data', (chunk) => {
    bytes = new Uint8Array(chunk.initSegment.byteLength + chunk.data.byteLength);
    bytes.set(chunk.initSegment); bytes.set(chunk.data, chunk.initSegment.byteLength);
  });
  const done = new Promise<void>((resolve) => muxer.on('done', resolve));
  muxer.push(new Uint8Array(readFileSync('node_modules/mux.js/test/segments/test-segment.ts')));
  muxer.flush();
  await done;
  return bytes;
}

describe('download runtime Bilibili progressive compatibility', () => {
  it.each([undefined, 'dash'] as const)('persists resolved progressive metadata before default dispatch from initial %s', async (initialKind) => {
    const h = harness([bilibiliProgressiveTask(initialKind)]);
    allowArtifactWrites(h);
    delete h.options.executors; // Use the production registry, including its progressive executor.
    h.options.resolve = resolveDiscoveredMedia;
    h.options.networkSettings = { ...h.options.networkSettings, taskRecoveryAttempts: 0 };
    const mp4 = await progressiveMp4();
    const beforeDownload: DownloadTask[] = [];
    const events: TaskDiagnosticEvent[] = [];
    h.options.recordEvent = async (event) => { events.push(event); };
    h.options.transport = { fetch: async (input) => {
      if (String(input).startsWith('https://www.bilibili.com/')) return new Response(bilibiliProgressivePage('fresh'));
      beforeDownload.push(structuredClone(h.store.tasks.get('one')!));
      return new Response(mp4.slice().buffer as ArrayBuffer, { headers: { 'Content-Length': String(mp4.byteLength) } });
    } };
    await h.runtime.start();
    expect(beforeDownload).toMatchObject([{ source: { mediaKind: 'progressive' }, outputFormat: 'mp4', status: 'downloading' }]);
    expect(h.store.tasks.get('one')).toMatchObject({ source: { mediaKind: 'progressive' }, outputFormat: 'mp4', status: 'completed' });
    expect(h.store.tasks.get('one')?.checkpoint).toBeUndefined();
    expect(h.files.get('Fixture.mp4')).toEqual(mp4);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'source-resolved', protocol: 'progressive' })]));
    expect(h.executor.execute).not.toHaveBeenCalled();
  });

  it('resolves a fresh complete-file URL after an expired Bilibili URL and recovers without a range checkpoint', async () => {
    const mp4 = await progressiveMp4();
    vi.useFakeTimers();
    const h = harness([bilibiliProgressiveTask()]);
    allowArtifactWrites(h);
    delete h.options.executors;
    const resolve = vi.fn(resolveDiscoveredMedia);
    h.options.resolve = resolve;
    let pageRequests = 0;
    const fileRequests: Array<{ url: string; headers: Headers }> = [];
    h.options.transport = { fetch: async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://www.bilibili.com/')) {
        return new Response(bilibiliProgressivePage(++pageRequests === 1 ? 'expired' : 'fresh'));
      }
      fileRequests.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith('token=expired')) return new Response(null, { status: 403 });
      return new Response(mp4.slice().buffer as ArrayBuffer);
    } };
    const waiting = deferred();
    h.runtime.subscribe(({ tasks }) => { if (tasks[0]?.status === 'waiting') waiting.resolve(); });
    const pending = h.runtime.start();
    await waiting.promise;
    expect(h.store.tasks.get('one')).toMatchObject({ status: 'waiting', outputFormat: 'mp4', source: { mediaKind: 'progressive' } });
    expect(h.store.tasks.get('one')?.checkpoint).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[1]?.[0].mediaKind).toBe('progressive');
    expect(pageRequests).toBe(2);
    expect(fileRequests.map(({ url }) => url)).toEqual([
      'https://cdn.example/full.mp4?token=expired', 'https://cdn.example/full.mp4?token=fresh',
    ]);
    expect(fileRequests.every(({ headers }) => !headers.has('Range'))).toBe(true);
    expect(h.artifacts.open).toHaveBeenCalledTimes(2);
    expect(h.store.save.mock.calls.every(([saved]) => saved.checkpoint === undefined)).toBe(true);
    expect(h.store.tasks.get('one')).toMatchObject({ status: 'completed', outputFormat: 'mp4', source: { mediaKind: 'progressive' } });
    expect(h.files.get('Fixture.mp4')).toEqual(mp4);
  });
});
