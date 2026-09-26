import { fetchTextResource, isRecoverableNetworkError, type HlsNetworkPolicy, type NetworkRetryEvent } from '../core/hls/download-hls';
import { HostHealthController, type HostHealthSnapshot } from '../core/network/host-health';
import type { Transport } from '../core/network/transport';
import type { DiscoveryResolveContext, ResolvedDiscoveredMedia } from '../core/discovery/source';
import { OutputValidationError, validateMediaOutput } from '../core/media/output-validator';
import { checkpointPartialFilenames, checkpointMatchesDirectory } from '../core/task-checkpoint';
import { classifyTaskError } from '../core/task-error';
import { runTaskPool } from '../core/task-pool';
import { resetTaskState } from '../core/task-state';
import type { DiscoveredMediaItem } from '../shared/discovery';
import type { DownloadTask, DownloadTaskProgress } from '../shared/download-task';
import type { NetworkSettings, OutputFormat } from '../shared/settings';
import { createTaskDiagnosticEvent, diagnosticResource, type TaskDiagnosticEvent, type TaskDiagnosticEventCode } from '../shared/task-diagnostics';
import { readMediaArtifact, type ArtifactStore } from './artifact-store';
import { RuntimeError } from './errors';
import { findTaskExecutor } from './task-executors/registry';
import type { ProtocolTaskExecutor, TaskExecutorResult } from './task-executors/types';
import type { TransformBackend } from './transform-backend';

export interface TaskStore {
  add?(items: DiscoveredMediaItem[], outputFormat: OutputFormat): Promise<DownloadTask[]>;
  list(): Promise<DownloadTask[]>;
  save(task: DownloadTask): Promise<DownloadTask>;
  remove(taskId: string): Promise<void>;
}

/** Must exclude ALL writers to the same task store for the entire operation. */
export interface ExecutionLocks {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export interface RuntimeSnapshot {
  running: boolean;
  tasks: readonly DownloadTask[];
  hostHealth: readonly HostHealthSnapshot[];
}

export interface DownloadRuntimeOptions {
  store: TaskStore;
  artifacts: ArtifactStore;
  transforms: TransformBackend;
  locks: ExecutionLocks;
  resolve(source: DiscoveredMediaItem, context: DiscoveryResolveContext): Promise<ResolvedDiscoveredMedia>;
  networkSettings: NetworkSettings;
  concurrency: number;
  transport?: Transport;
  executors?: readonly ProtocolTaskExecutor[];
  /** Host setup, e.g. extension session header rules. Runs after acquiring ownership. */
  prepare?(tasks: readonly DownloadTask[]): Promise<void>;
  recordEvent?(event: TaskDiagnosticEvent): Promise<void>;
}

function waitUntil(timestamp: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, timestamp - Date.now()));
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** A host-independent task owner. Opening a client never takes ownership or recovers tasks. */
export class DownloadRuntime {
  readonly #options: DownloadRuntimeOptions;
  readonly #listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  #snapshot: RuntimeSnapshot = { running: false, tasks: [], hostHealth: [] };
  #controller: AbortController | undefined;
  readonly #outputOwners = new Map<string, string>();

  constructor(options: DownloadRuntimeOptions) { this.#options = options; }
  getSnapshot(): RuntimeSnapshot { return this.#snapshot; }
  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  #publish(patch: Partial<RuntimeSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) {
      try { listener(this.#snapshot); } catch { /* Observers cannot change task execution. */ }
    }
  }
  async refresh(): Promise<void> { this.#publish({ tasks: await this.#options.store.list() }); }
  async #save(task: DownloadTask): Promise<DownloadTask> {
    const saved = await this.#options.store.save(task);
    this.#publish({ tasks: this.#snapshot.tasks.map((item) => item.id === saved.id ? saved : item) });
    return saved;
  }
  #progress(taskId: string, progress: DownloadTaskProgress): void {
    this.#publish({ tasks: this.#snapshot.tasks.map((task) => task.id === taskId ? { ...task, progress } : task) });
  }
  async #event(taskId: string, code: TaskDiagnosticEventCode, level: TaskDiagnosticEvent['level'] = 'info',
    details: Omit<TaskDiagnosticEvent, 'id' | 'taskId' | 'at' | 'level' | 'code'> = {}): Promise<void> {
    try { await this.#options.recordEvent?.(createTaskDiagnosticEvent({ taskId, code, level, ...details })); }
    catch { /* Diagnostics are best effort; task state is not. */ }
  }
  cancel(): void { this.#controller?.abort(new DOMException('The queue was stopped.', 'AbortError')); }

  async start(): Promise<RuntimeSnapshot> {
    if (this.#controller) throw new RuntimeError('runtimeBusy');
    const controller = new AbortController();
    this.#controller = controller;
    try {
      await this.#options.locks.runExclusive(async () => {
        this.#publish({ running: true, hostHealth: [] });
        await this.refresh();
        this.#outputOwners.clear();
        for (const task of this.#snapshot.tasks) {
          if (this.#sameOutput(task)) this.#claimTaskOutput(task);
        }
        // Only a host holding exclusive ownership may declare a previous execution interrupted.
        for (const task of this.#snapshot.tasks) {
          if (task.status === 'resolving' || task.status === 'downloading') {
            await this.#save(resetTaskState(task, 'queued'));
            await this.#event(task.id, 'manager-interrupted', 'warning');
          } else if (task.status === 'completed' && task.outputCommit && this.#sameOutput(task)) {
            await this.#cleanup(task);
          }
        }
        const initial = this.#snapshot.tasks.filter((task) => task.status === 'queued' || task.status === 'waiting');
        await this.#options.prepare?.(initial);
        const included = new Set(initial.map(({ id }) => id));
        const health = new HostHealthController({ maxConcurrency: this.#options.concurrency,
          onChange: (hostHealth) => this.#publish({ hostHealth }) });
        const settings = this.#options.networkSettings;
        const policy: HlsNetworkPolicy = { maxAttempts: settings.maxAttempts,
          firstByteTimeoutMs: settings.firstByteTimeoutSeconds * 1000,
          idleTimeoutMs: settings.idleTimeoutSeconds * 1000, requestCoordinator: health };
        while (!controller.signal.aborted) {
          await this.refresh();
          const candidates = this.#snapshot.tasks.filter(({ id, status }) => included.has(id) && (status === 'queued' || status === 'waiting'));
          if (!candidates.length) break;
          const ready = candidates.filter(({ status, nextRetryAt }) => status === 'queued' || !nextRetryAt || nextRetryAt <= Date.now());
          if (!ready.length) {
            await waitUntil(Math.min(...candidates.map(({ nextRetryAt }) => nextRetryAt ?? Date.now())), controller.signal);
            continue;
          }
          // runTaskPool drains every worker before rejecting, so ownership cannot be released early.
          await runTaskPool({ items: ready, concurrency: this.#options.concurrency,
            run: (task) => this.#execute(task, controller.signal, policy), shouldStop: () => controller.signal.aborted });
        }
      });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      this.#controller = undefined;
      this.#publish({ running: false });
      await this.refresh();
    }
    return this.#snapshot;
  }

  #claimOutput(taskId: string, filename: string): void {
    const owner = this.#outputOwners.get(filename);
    if (owner && owner !== taskId) throw new RuntimeError('outputConflict', { filename });
    this.#outputOwners.set(filename, taskId);
  }
  #taskFilenames(task: DownloadTask): string[] {
    return [...new Set([
      ...(task.checkpoint ? [task.checkpoint.finalFilename, ...checkpointPartialFilenames(task.checkpoint)] : []),
      ...(task.outputCommit ? [task.outputCommit.finalFilename, ...task.outputCommit.partialFilenames] : []),
    ])];
  }
  #claimTaskOutput(task: DownloadTask): void {
    const names = this.#taskFilenames(task);
    // Validate the entire set before claiming any name or persisting another task's fragments.
    for (const filename of names) {
      const owner = this.#outputOwners.get(filename);
      if (owner && owner !== task.id) throw new RuntimeError('outputConflict', { filename });
    }
    for (const filename of names) this.#outputOwners.set(filename, task.id);
  }
  #assertUnsharedCleanup(task: DownloadTask, names: Iterable<string>): void {
    const deleting = new Set(names);
    for (const other of this.#snapshot.tasks) {
      if (other.id === task.id || !this.#sameOutput(other)) continue;
      for (const filename of this.#taskFilenames(other)) {
        if (deleting.has(filename)) throw new RuntimeError('outputConflict', { filename });
      }
    }
  }
  #taskArtifacts(taskId: string): ArtifactStore {
    const store = this.#options.artifacts;
    return { name: store.name, ...(store.id ? { id: store.id } : {}),
      stat: (name) => store.stat(name), read: (name, offset, length) => store.read(name, offset, length),
      remove: (name) => { this.#claimOutput(taskId, name); return store.remove(name); },
      open: (name, options) => { this.#claimOutput(taskId, name); return store.open(name, options); },
    };
  }
  #sameOutput(task: DownloadTask): boolean {
    const identity = task.outputCommit ?? task.checkpoint;
    return !identity || checkpointMatchesDirectory(identity, {
      name: this.#options.artifacts.name,
      ...(this.#options.artifacts.id ? { handleId: this.#options.artifacts.id } : {}),
    });
  }
  #assertOutput(task: DownloadTask): void {
    if (!this.#sameOutput(task)) throw new RuntimeError('chooseOriginalFolderResume', {
      name: (task.outputCommit ?? task.checkpoint)!.directoryName,
    });
  }
  async #cleanup(task: DownloadTask): Promise<void> {
    if (!task.outputCommit) return;
    this.#assertOutput(task);
    try {
      this.#assertUnsharedCleanup(task, task.outputCommit.partialFilenames);
      for (const name of task.outputCommit.partialFilenames) await this.#options.artifacts.remove(name);
      const cleaned = { ...task };
      delete cleaned.outputCommit;
      await this.#save(cleaned);
    } catch {
      // Completed remains durable. Retain the cleanup record for the next owned run.
      await this.#event(task.id, 'output-cleanup-pending', 'warning');
    }
  }
  async #commit(task: DownloadTask): Promise<void> {
    this.#assertOutput(task);
    const commit = task.outputCommit!;
    const validation = await validateMediaOutput(await readMediaArtifact(this.#options.artifacts, commit.finalFilename), {
      format: commit.validationOptions.format,
      ...(commit.validationOptions.expectedBytes === undefined ? {} : { expectedBytes: commit.validationOptions.expectedBytes }),
      ...(commit.validationOptions.requireVideo === undefined ? {} : { requireVideo: commit.validationOptions.requireVideo }),
    });
    await this.#event(task.id, 'output-validated', 'info', { filename: commit.finalFilename, bytesWritten: validation.size });
    const completed = resetTaskState(task, 'completed');
    delete completed.checkpoint;
    delete completed.recoveryAttempt;
    delete completed.nextRetryAt;
    // Persist success BEFORE deleting the only recoverable fragments.
    const saved = await this.#save(completed);
    await this.#event(task.id, 'task-completed', 'info', { bytesWritten: validation.size });
    await this.#cleanup(saved);
  }

  async #execute(initial: DownloadTask, signal: AbortSignal, networkPolicy: HlsNetworkPolicy): Promise<void> {
    let task = initial;
    let latestProgress = task.progress;
    const settings = this.#options.networkSettings;
    const recordRetry = (retry: NetworkRetryEvent, resourceKind: TaskDiagnosticEvent['resourceKind'], url: string, segment?: number) => {
      const status = /^HTTP (\d{3})$/.exec(retry.reason);
      void this.#event(task.id, 'request-retry', 'warning', { ...diagnosticResource(url),
        ...(resourceKind ? { resourceKind } : {}), ...(segment === undefined ? {} : { segment }),
        ...(status ? { httpStatus: Number(status[1]) } : {}), attempt: retry.attempt,
        maxAttempts: retry.maxAttempts, delayMs: retry.delayMs, message: retry.reason });
    };
    const loadText = (url: string, requestSignal?: AbortSignal) => fetchTextResource(url, requestSignal, networkPolicy, {
      onRetry: (retry) => {
        const progress: DownloadTaskProgress = { completedSegments: latestProgress?.completedSegments ?? task.checkpoint?.completedSegments ?? 0,
          totalSegments: latestProgress?.totalSegments ?? task.checkpoint?.totalSegments ?? 1,
          bytesWritten: latestProgress?.bytesWritten ?? task.checkpoint?.bytesWritten ?? 0,
          phase: 'retrying', retryAttempt: retry.attempt, maxAttempts: retry.maxAttempts,
          retryDelayMs: retry.delayMs, retryReason: retry.reason };
        latestProgress = progress; this.#progress(task.id, progress); recordRetry(retry, 'text', url);
      },
    }, this.#options.transport);
    try {
      this.#assertOutput(task);
      if (task.outputCommit) { await this.#commit(task); return; }
      task = await this.#save(resetTaskState(task, 'resolving'));
      await this.#event(task.id, 'resolve-started');
      signal.throwIfAborted();
      const media = await this.#options.resolve(task.source, { fetchText: loadText, signal });
      if (media.kind === 'hls' || media.kind === 'dash' || media.kind === 'progressive') {
        // Discovery may only know the episode identity. Persist the actual protocol before execution
        // so retries and newly opened clients retain progressive fallback and its MP4 output policy.
        task = await this.#save({ ...task, source: { ...task.source, mediaKind: media.kind },
          ...(media.kind === 'progressive' ? { outputFormat: 'mp4' as const } : {}) });
      }
      await this.#event(task.id, 'source-resolved', 'info', { ...diagnosticResource(media.url),
        ...(media.kind === 'hls' || media.kind === 'dash' || media.kind === 'progressive' ? { protocol: media.kind } : {}) });
      const executor = findTaskExecutor(media.kind, this.#options.executors);
      if (!executor) throw new RuntimeError('batchProtocolUnsupported');
      const execution: TaskExecutorResult = await executor.execute({ task, media, signal, networkPolicy,
        networkSettings: settings, artifacts: this.#taskArtifacts(task.id), transforms: this.#options.transforms,
        ...(this.#options.transport ? { transport: this.#options.transport } : {}), loadText,
        refreshMedia: () => this.#options.resolve(task.source, { fetchText: loadText, signal }),
        persistTask: async (next) => {
          this.#assertOutput(next); this.#claimTaskOutput(next);
          task = await this.#save(next); return task;
        },
        onProgress: (progress) => { latestProgress = progress; this.#progress(task.id, progress); },
        recordTaskEvent: (code, level, details) => this.#event(task.id, code, level, details), recordRequestRetry: recordRetry });
      const committing: DownloadTask = { ...task, outputCommit: {
        directoryName: this.#options.artifacts.name,
        ...(this.#options.artifacts.id ? { directoryHandleId: this.#options.artifacts.id } : {}),
        finalFilename: execution.finalFilename, validationOptions: execution.validationOptions,
        partialFilenames: [...execution.partialOutputsToRemove ?? []],
      } };
      this.#claimTaskOutput(committing);
      task = await this.#save(committing);
      await this.#commit(task);
    } catch (cause) {
      // Storage may commit successfully and then lose its reply. Never overwrite durable success
      // with a stale failure snapshot, and preserve any commit/checkpoint saved before the error.
      const durable = (await this.#options.store.list()).find(({ id }) => id === task.id);
      if (!durable) throw cause;
      if (durable.status === 'completed') { await this.#cleanup(durable); return; }
      task = durable;
      if (cause instanceof OutputValidationError && task.outputCommit) {
        // The intent points to a proven invalid/missing final output. A retry must execute again
        // using the retained checkpoint, rather than revalidate the same bad artifact forever.
        // I/O/storage failures keep the intent, because the finished output may still be valid.
        task = { ...task };
        delete task.outputCommit;
      }
      const cancelled = signal.aborted || (cause instanceof Error && cause.name === 'AbortError');
      const failure = classifyTaskError(cancelled ? new DOMException('Task cancelled.', 'AbortError') : cause);
      if (cause instanceof RuntimeError) { failure.code = cause.code; failure.params = cause.params; }
      const attempts = task.recoveryAttempt ?? 0;
      if (!cancelled && isRecoverableNetworkError(cause) && attempts < settings.taskRecoveryAttempts) {
        const recoveryAttempt = attempts + 1;
        const nextRetryAt = Date.now() + Math.min(settings.taskRetryMaxDelaySeconds,
          settings.taskRetryBaseDelaySeconds * 2 ** attempts) * 1000;
        await this.#save({ ...task, status: 'waiting', failure, error: failure.message, recoveryAttempt, nextRetryAt,
          ...(latestProgress ? { progress: { ...latestProgress, phase: 'retrying' } } : {}) });
        await this.#event(task.id, 'recovery-scheduled', 'warning', { recoveryAttempt, nextRetryAt });
      } else {
        const stopped = resetTaskState(task, cancelled ? 'cancelled' : 'failed', failure.message);
        stopped.failure = failure;
        if (latestProgress) stopped.progress = latestProgress;
        await this.#save(stopped);
        await this.#event(task.id, cancelled ? 'task-cancelled' : 'task-failed', cancelled ? 'warning' : 'error', { message: failure.message });
      }
    }
  }

  async #mutate(taskId: string, operation: (task: DownloadTask) => Promise<void>): Promise<void> {
    await this.#options.locks.runExclusive(async () => {
      await this.refresh();
      const task = this.#snapshot.tasks.find(({ id }) => id === taskId);
      if (!task) throw new RuntimeError('taskNotFound');
      await operation(task);
      await this.refresh();
    });
  }
  async retry(taskId: string): Promise<void> {
    await this.#mutate(taskId, async (task) => {
      if (task.status === 'completed') return;
      const next = resetTaskState(task, 'queued');
      delete next.recoveryAttempt;
      await this.#save(next); await this.#event(taskId, 'manual-retry');
    });
  }
  async restart(taskId: string): Promise<void> {
    await this.#mutate(taskId, async (task) => {
      this.#assertOutput(task);
      const files = new Set([...(task.checkpoint ? checkpointPartialFilenames(task.checkpoint) : []), ...task.outputCommit?.partialFilenames ?? []]);
      this.#assertUnsharedCleanup(task, files);
      for (const filename of files) await this.#options.artifacts.remove(filename);
      const next = resetTaskState(task, 'queued');
      delete next.checkpoint; delete next.outputCommit; delete next.recoveryAttempt;
      await this.#save(next); await this.#event(taskId, 'manual-restart');
    });
  }
  async enqueue(items: readonly DiscoveredMediaItem[], outputFormat: OutputFormat): Promise<RuntimeSnapshot> {
    await this.#options.locks.runExclusive(async () => {
      const existing = new Set((await this.#options.store.list()).map(({ source }) => source.id));
      const fresh = items.filter((item) => {
        if (existing.has(item.id)) return false;
        existing.add(item.id); return true;
      });
      for (const format of ['mp4', 'original'] as const) {
        const group = fresh.filter((item) => (item.mediaKind === 'dash' || item.mediaKind === 'progressive' ? 'mp4' : outputFormat) === format);
        if (!group.length) continue;
        if (this.#options.store.add) await this.#options.store.add(group, format);
        else for (const source of group) {
          const now = Date.now();
          await this.#options.store.save({ id: crypto.randomUUID(), source, outputFormat: format,
            status: 'queued', createdAt: now, updatedAt: now });
        }
      }
      await this.refresh();
    });
    return this.#snapshot;
  }
  async clearCompleted(): Promise<void> {
    await this.#options.locks.runExclusive(async () => {
      await this.refresh();
      for (const task of this.#snapshot.tasks.filter(({ status }) => status === 'completed')) {
        if (task.outputCommit) {
          this.#assertOutput(task);
          await this.#cleanup(task);
          if ((await this.#options.store.list()).find(({ id }) => id === task.id)?.outputCommit) continue;
        }
        await this.#options.store.remove(task.id);
      }
      await this.refresh();
    });
  }
  async remove(taskId: string): Promise<void> {
    await this.#mutate(taskId, async (task) => {
      this.#assertOutput(task);
      const files = new Set([...(task.checkpoint ? checkpointPartialFilenames(task.checkpoint) : []), ...task.outputCommit?.partialFilenames ?? []]);
      this.#assertUnsharedCleanup(task, files);
      for (const filename of files) await this.#options.artifacts.remove(filename);
      await this.#options.store.remove(task.id);
    });
  }
}
