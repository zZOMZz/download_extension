import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  addPersistentDownloadTasks,
  appendPersistentTaskDiagnosticEvent,
  clearCompletedPersistentDownloadTasks,
  configureManagerRequestAdapters,
  listPersistentDownloadTasks,
  listPersistentTaskDiagnosticEvents,
  removePersistentDownloadTask,
  replacePersistentDownloadTask,
  scanTabForMedia,
} from '~/src/browser/runtime-client';
import {
  removeDirectoryFile,
  type WritableDirectoryHandle,
} from '~/src/browser/directory-output-writer';
import {
  loadPersistedDirectoryHandle,
  persistDirectoryHandle,
  queryDirectoryPermission,
  requestDirectoryPermission,
  type PersistedDirectoryHandle,
} from '~/src/browser/directory-handle-store';
import {
  readSettings,
  setLanguage as persistLanguage,
  setNetworkSettings as persistNetworkSettings,
  setOutputFormat as persistOutputFormat,
  setTaskConcurrency as persistTaskConcurrency,
} from '~/src/browser/settings';
import { commitValidatedDirectoryOutput } from '~/src/browser/validated-output';
import { findTaskExecutor } from '~/src/browser/task-executors/registry';
import { buildTaskDiagnosticReport } from '~/src/core/diagnostics/task-report';
import { resolveDiscoveredMedia } from '~/src/core/discovery/registry';
import { formatByteRate, formatBytes, formatDuration, safeFilename } from '~/src/core/format';
import {
  fetchTextResource,
  isRecoverableNetworkError,
  type HlsNetworkPolicy,
  type HlsDownloadProgress,
  type NetworkRetryEvent,
} from '~/src/core/hls/download-hls';
import {
  HostHealthController,
  type HostHealthSnapshot,
  type NetworkRequestCoordinator,
} from '~/src/core/network/host-health';
import { OutputValidationError } from '~/src/core/media/output-validator';
import { runTaskPool } from '~/src/core/task-pool';
import { classifyTaskError } from '~/src/core/task-error';
import { checkpointPartialFilenames } from '~/src/core/task-checkpoint';
import { resetTaskState } from '~/src/core/task-state';
import { createTranslator, LANGUAGE_OPTIONS, type MessageKey, type Translator } from '~/src/shared/i18n';
import {
  DOWNLOAD_TASKS_STORAGE_KEY,
  type DownloadTask,
  type DownloadTaskProgress,
  type DownloadTaskStatus,
} from '~/src/shared/download-task';
import type { DiscoveredMediaItem } from '~/src/shared/discovery';
import {
  createTaskDiagnosticEvent,
  diagnosticResource,
  sanitizeDiagnosticText,
  type DownloadFailureCategory,
  type TaskDiagnosticEvent,
  type TaskDiagnosticEventCode,
} from '~/src/shared/task-diagnostics';
import {
  NETWORK_PRESETS,
  appLanguageSchema,
  networkProfileSchema,
  networkSettingsSchema,
  taskConcurrencySchema,
  type AppLanguage,
  type NetworkSettings,
  type OutputFormat,
  type TaskConcurrency,
} from '~/src/shared/settings';

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<WritableDirectoryHandle>;
}

const STATUS_LABEL_KEYS: Record<DownloadTaskStatus, MessageKey> = {
  queued: 'statusQueued',
  resolving: 'statusResolving',
  downloading: 'statusDownloading',
  waiting: 'statusWaiting',
  completed: 'statusCompleted',
  failed: 'statusFailed',
  cancelled: 'statusCancelled',
};

const PHASE_LABEL_KEYS: Record<NonNullable<DownloadTaskProgress['phase']>, MessageKey> = {
  requesting: 'phaseRequesting',
  downloading: 'phaseDownloading',
  decrypting: 'phaseDecrypting',
  processing: 'phaseProcessing',
  finalizing: 'phaseFinalizing',
  retrying: 'phaseRetrying',
  completed: 'phaseCompleted',
};

const FAILURE_CATEGORY_LABEL_KEYS: Record<DownloadFailureCategory, MessageKey> = {
  network: 'failureNetwork',
  http: 'failureHttp',
  timeout: 'failureTimeout',
  source: 'failureSource',
  manifest: 'failureManifest',
  encryption: 'failureEncryption',
  filesystem: 'failureFilesystem',
  output: 'failureOutput',
  unsupported: 'failureUnsupported',
  cancelled: 'failureCancelled',
  unknown: 'failureUnknown',
};

const DIAGNOSTIC_EVENT_LABEL_KEYS: Record<TaskDiagnosticEventCode, MessageKey> = {
  'manager-interrupted': 'eventManagerInterrupted',
  'resolve-started': 'eventResolveStarted',
  'source-resolved': 'eventSourceResolved',
  'source-refresh-started': 'eventSourceRefreshStarted',
  'source-refreshed': 'eventSourceRefreshed',
  'manifest-loaded': 'eventManifestLoaded',
  'audio-rendition-loaded': 'eventAudioRenditionLoaded',
  'output-opened': 'eventOutputOpened',
  'resume-prepared': 'eventResumePrepared',
  'download-started': 'eventDownloadStarted',
  'request-retry': 'eventRequestRetry',
  'checkpoint-saved': 'eventCheckpointSaved',
  'recovery-scheduled': 'eventRecoveryScheduled',
  'finalize-started': 'eventFinalizeStarted',
  'output-validated': 'eventOutputValidated',
  'task-completed': 'eventTaskCompleted',
  'task-failed': 'eventTaskFailed',
  'task-cancelled': 'eventTaskCancelled',
  'manual-retry': 'eventManualRetry',
  'manual-restart': 'eventManualRestart',
};

function progressValue(progress: NonNullable<DownloadTask['progress']>): number {
  if (!progress.currentSegmentBytesTotal) return progress.completedSegments;
  const fraction = (progress.currentSegmentBytesReceived ?? 0) / progress.currentSegmentBytesTotal;
  return Math.min(progress.totalSegments, progress.completedSegments + Math.min(1, fraction));
}

function TaskProgress({ progress, t }: {
  progress: NonNullable<DownloadTask['progress']>;
  t: Translator;
}) {
  const currentRate = formatByteRate(progress.currentSpeedBytesPerSecond);
  const averageRate = formatByteRate(progress.averageSpeedBytesPerSecond);
  const eta = formatDuration(progress.estimatedSecondsRemaining);
  const segmentReceived = formatBytes(progress.currentSegmentBytesReceived);
  const segmentTotal = formatBytes(progress.currentSegmentBytesTotal);
  const lastSegmentTime = progress.lastSegmentDurationMs === undefined
    ? null
    : formatDuration(progress.lastSegmentDurationMs / 1_000);
  return (
    <div className="progress-block">
      <div className="progress-headline">
        <span>{t('segmentsProgress', { completed: progress.completedSegments, total: progress.totalSegments })}</span>
        <span>{formatBytes(progress.bytesWritten)}</span>
      </div>
      <progress value={progressValue(progress)} max={progress.totalSegments} />
      <div className="progress-metrics">
        <span>{progress.phase ? t(PHASE_LABEL_KEYS[progress.phase]) : t('downloading')}</span>
        {currentRate && <span>{t('nowRate', { rate: currentRate })}</span>}
        {averageRate && <span>{t('averageRate', { rate: averageRate })}</span>}
        {eta && <span>{t('eta', { duration: eta })}</span>}
        {segmentReceived && segmentTotal && (
          <span>{t('segmentBytes', { received: segmentReceived, total: segmentTotal })}</span>
        )}
        {lastSegmentTime && <span>{t('lastSegment', { duration: lastSegmentTime })}</span>}
      </div>
      {progress.phase === 'retrying' && progress.retryAttempt !== undefined && (
        <p className="retry-detail">
          {t('retryAttempt', {
            attempt: progress.retryAttempt,
            max: progress.maxAttempts ?? 0,
            duration: formatDuration((progress.retryDelayMs ?? 0) / 1_000) ?? '0s',
          })}
          {progress.retryReason ? ` · ${progress.retryReason}` : ''}
        </p>
      )}
    </div>
  );
}

function diagnosticEventMetadata(event: TaskDiagnosticEvent, t: Translator): string[] {
  const details: string[] = [];
  if (event.resourceHost) details.push(`${event.resourceHost}${event.resourcePath ?? ''}`);
  if (event.httpStatus) details.push(`HTTP ${event.httpStatus}`);
  if (event.segment) details.push(t('diagnosticSegment', { segment: event.segment }));
  if (event.attempt && event.maxAttempts) {
    details.push(t('diagnosticAttempt', { attempt: event.attempt, max: event.maxAttempts }));
  }
  if (event.delayMs !== undefined) {
    details.push(t('diagnosticDelay', { duration: formatDuration(event.delayMs / 1_000) ?? '0s' }));
  }
  if (event.completedSegments !== undefined && event.totalSegments !== undefined) {
    details.push(t('diagnosticProgress', {
      completed: event.completedSegments,
      total: event.totalSegments,
    }));
  } else if (event.totalSegments !== undefined) {
    details.push(t('diagnosticTotalSegments', { total: event.totalSegments }));
  }
  const bytes = formatBytes(event.bytesWritten);
  if (bytes) details.push(t('diagnosticBytes', { bytes }));
  if (event.videoTracks !== undefined || event.audioTracks !== undefined) {
    details.push(t('diagnosticTracks', {
      video: event.videoTracks ?? 0,
      audio: event.audioTracks ?? 0,
    }));
  }
  if (event.durationSeconds !== undefined) {
    details.push(t('diagnosticMediaDuration', {
      duration: formatDuration(event.durationSeconds) ?? '0s',
    }));
  }
  if (event.filename) details.push(event.filename);
  return details;
}

function configuredNetworkPolicy(
  settings: NetworkSettings,
  requestCoordinator?: NetworkRequestCoordinator,
): HlsNetworkPolicy {
  return {
    maxAttempts: settings.maxAttempts,
    firstByteTimeoutMs: settings.firstByteTimeoutSeconds * 1_000,
    idleTimeoutMs: settings.idleTimeoutSeconds * 1_000,
    ...(requestCoordinator ? { requestCoordinator } : {}),
  };
}

function taskRetryDelay(settings: NetworkSettings, recoveryAttempt: number): number {
  const delaySeconds = Math.min(
    settings.taskRetryMaxDelaySeconds,
    settings.taskRetryBaseDelaySeconds * (2 ** Math.max(0, recoveryAttempt - 1)),
  );
  return delaySeconds * 1_000;
}

async function waitUntil(timestamp: number, signal: AbortSignal): Promise<void> {
  const delayMs = Math.max(0, timestamp - Date.now());
  if (delayMs === 0) return;
  if (signal.aborted) throw signal.reason ?? new DOMException('The queue was stopped.', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = window.setTimeout(finish, delayMs);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('The queue was stopped.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function App() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const rawSourceTabId = params.get('tabId');
  const sourceTabId = rawSourceTabId === null ? null : Number(rawSourceTabId);
  const [discovered, setDiscovered] = useState<DiscoveredMediaItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('mp4');
  const [taskConcurrency, setTaskConcurrency] = useState<TaskConcurrency>(2);
  const [networkSettings, setNetworkSettings] = useState<NetworkSettings>(NETWORK_PRESETS.resilient);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [directory, setDirectory] = useState<WritableDirectoryHandle | null>(null);
  const [directoryHandleId, setDirectoryHandleId] = useState<string | null>(null);
  const [rememberedDirectory, setRememberedDirectory] = useState<PersistedDirectoryHandle | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [diagnosticEvents, setDiagnosticEvents] = useState<Record<string, TaskDiagnosticEvent[]>>({});
  const [diagnosticsLoadingId, setDiagnosticsLoadingId] = useState<string | null>(null);
  const [hostHealth, setHostHealth] = useState<HostHealthSnapshot[]>([]);
  const abortController = useRef<AbortController | null>(null);
  const t = useMemo(() => createTranslator(language), [language]);

  const refreshTasks = async () => {
    setTasks(await listPersistentDownloadTasks());
  };

  const recordTaskEvent = async (
    taskId: string,
    code: TaskDiagnosticEventCode,
    level: TaskDiagnosticEvent['level'] = 'info',
    details: Omit<TaskDiagnosticEvent, 'id' | 'taskId' | 'at' | 'level' | 'code'> = {},
  ): Promise<void> => {
    const event = createTaskDiagnosticEvent({ taskId, code, level, ...details });
    setDiagnosticEvents((current) => current[taskId]
      ? { ...current, [taskId]: [...current[taskId], event] }
      : current);
    try {
      await appendPersistentTaskDiagnosticEvent(event);
    } catch (cause) {
      console.warn('Unable to persist task diagnostics.', cause);
    }
  };

  const toggleTaskDetails = async (taskId: string) => {
    if (expandedTaskId === taskId) {
      setExpandedTaskId(null);
      return;
    }
    setExpandedTaskId(taskId);
    if (diagnosticEvents[taskId]) return;
    setDiagnosticsLoadingId(taskId);
    try {
      const events = await listPersistentTaskDiagnosticEvents(taskId);
      setDiagnosticEvents((current) => ({ ...current, [taskId]: events }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('unableLoadDiagnostics'));
    } finally {
      setDiagnosticsLoadingId(null);
    }
  };

  const exportTaskDiagnostics = async (task: DownloadTask) => {
    try {
      const events = diagnosticEvents[task.id] ?? await listPersistentTaskDiagnosticEvents(task.id);
      setDiagnosticEvents((current) => ({ ...current, [task.id]: events }));
      const report = buildTaskDiagnosticReport(task, events, {
        network: networkSettings,
        taskConcurrency,
        userAgent: navigator.userAgent,
      });
      const url = URL.createObjectURL(new Blob([report], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${safeFilename(task.source.title)}-diagnostics.json`;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setSummary(t('diagnosticReportExported'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('unableExportDiagnostics'));
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const [settings, storedTasks, persistedDirectory] = await Promise.all([
          readSettings(),
          listPersistentDownloadTasks(),
          loadPersistedDirectoryHandle().catch((cause) => {
            console.warn('Unable to load the remembered output directory.', cause);
            return null;
          }),
        ]);
        const settingsT = createTranslator(settings.language);
        setLanguage(settings.language);
        setOutputFormat(settings.outputFormat);
        setTaskConcurrency(settings.taskConcurrency);
        setNetworkSettings(settings.network);
        if (persistedDirectory) {
          setRememberedDirectory(persistedDirectory);
          const permission = await queryDirectoryPermission(persistedDirectory.handle).catch(() => 'prompt' as const);
          if (permission === 'granted') {
            setDirectory(persistedDirectory.handle);
            setDirectoryHandleId(persistedDirectory.id);
          }
        }
        const interrupted = storedTasks.filter(
          ({ status }) => status === 'resolving' || status === 'downloading',
        );
        for (const task of interrupted) {
          await replacePersistentDownloadTask(
            resetTaskState(task, 'queued', settingsT('previousSessionEnded')),
          );
          await recordTaskEvent(task.id, 'manager-interrupted', 'warning', {
            message: settingsT('previousSessionEnded'),
          });
        }
        setTasks(interrupted.length ? await listPersistentDownloadTasks() : storedTasks);

        if (sourceTabId !== null && Number.isInteger(sourceTabId) && sourceTabId >= 0) {
          const items = await scanTabForMedia(sourceTabId);
          setDiscovered(items);
          setSelectedIds(new Set(items.map(({ id }) => id)));
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('unableInitializeManager'));
      } finally {
        setLoading(false);
      }
    })();
  }, [sourceTabId]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t('downloadManager');
  }, [language, t]);

  useEffect(() => {
    const listener = (changes: Record<string, Browser.storage.StorageChange>, area: string) => {
      if (area === 'local' && DOWNLOAD_TASKS_STORAGE_KEY in changes && !running) void refreshTasks();
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [running]);

  const chooseDirectory = async () => {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    try {
      if (!directory && rememberedDirectory) {
        try {
          const permission = await requestDirectoryPermission(rememberedDirectory.handle);
          if (permission === 'granted') {
            setDirectory(rememberedDirectory.handle);
            setDirectoryHandleId(rememberedDirectory.id);
            setError(null);
            return;
          }
        } catch (cause) {
          console.warn('Unable to restore access to the remembered output directory.', cause);
        }
      }
      if (!picker) {
        setError(t('unsupportedDirectoryOutput'));
        return;
      }
      const handle = await picker({ mode: 'readwrite' });
      setDirectory(handle);
      setDirectoryHandleId(null);
      setError(null);
      try {
        const persisted = await persistDirectoryHandle(handle);
        setRememberedDirectory(persisted);
        setDirectoryHandleId(persisted.id);
      } catch (cause) {
        console.warn('Unable to remember the output directory.', cause);
        setError(t('unableRememberOutputFolder'));
      }
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause.message : t('unableOpenDirectory'));
      }
    }
  };

  const addSelected = async () => {
    const items = discovered.filter(({ id }) => selectedIds.has(id));
    if (items.length === 0) return;
    try {
      setTasks(await addPersistentDownloadTasks(items, outputFormat));
      setSelectedIds(new Set());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('unableAddEpisodes'));
    }
  };

  const persistTask = async (task: DownloadTask): Promise<DownloadTask> => {
    const saved = await replacePersistentDownloadTask(task);
    setTasks((current) => current.map((item) => item.id === saved.id ? saved : item));
    return saved;
  };

  const showProgress = (taskId: string, progress: HlsDownloadProgress) => {
    setTasks((current) => current.map((item) => item.id === taskId ? { ...item, progress } : item));
  };

  const executeTask = async (
    initialTask: DownloadTask,
    signal: AbortSignal,
    requestCoordinator: NetworkRequestCoordinator,
  ) => {
    const networkPolicy = configuredNetworkPolicy(networkSettings, requestCoordinator);
    let latestProgress = initialTask.progress;
    let task = await persistTask(resetTaskState(initialTask, 'resolving'));
    await recordTaskEvent(task.id, 'resolve-started');
    const recordRequestRetry = (
      retry: NetworkRetryEvent,
      resourceKind: TaskDiagnosticEvent['resourceKind'],
      resourceUrl: string,
      segment?: number,
    ) => {
      const statusMatch = /^HTTP (\d{3})$/.exec(retry.reason);
      void recordTaskEvent(task.id, 'request-retry', 'warning', {
        ...diagnosticResource(resourceUrl),
        ...(resourceKind ? { resourceKind } : {}),
        ...(segment === undefined ? {} : { segment }),
        ...(statusMatch ? { httpStatus: Number(statusMatch[1]) } : {}),
        attempt: retry.attempt,
        maxAttempts: retry.maxAttempts,
        delayMs: retry.delayMs,
        message: retry.reason,
      });
    };
    const showTextRetry = (retry: NetworkRetryEvent, url: string) => {
      const progress: HlsDownloadProgress = {
        completedSegments: latestProgress?.completedSegments ?? task.checkpoint?.completedSegments ?? 0,
        totalSegments: latestProgress?.totalSegments ?? task.checkpoint?.totalSegments ?? 1,
        bytesWritten: latestProgress?.bytesWritten ?? task.checkpoint?.bytesWritten ?? 0,
        networkBytesReceived: latestProgress?.networkBytesReceived ?? 0,
        phase: 'retrying',
        retryAttempt: retry.attempt,
        maxAttempts: retry.maxAttempts,
        retryDelayMs: retry.delayMs,
        retryReason: retry.reason,
      };
      latestProgress = progress;
      showProgress(task.id, progress);
      recordRequestRetry(retry, 'text', url);
    };
    const loadText = (url: string, requestSignal?: AbortSignal) =>
      fetchTextResource(url, requestSignal, networkPolicy, {
        onRetry: (retry) => showTextRetry(retry, url),
      });
    try {
      const media = await resolveDiscoveredMedia(task.source, { fetchText: loadText, signal });
      await recordTaskEvent(task.id, 'source-resolved', 'info', {
        ...diagnosticResource(media.url),
      });
      if (!directory) throw new Error(t('chooseDirectoryBeforeQueue'));
      const executor = findTaskExecutor(media.kind);
      if (!executor) throw new Error(t('batchProtocolUnsupported'));
      const execution = await executor.execute({
        task,
        media,
        directory,
        ...(directoryHandleId ? { directoryHandleId } : {}),
        signal,
        networkPolicy,
        networkSettings,
        loadText,
        refreshMedia: () => resolveDiscoveredMedia(task.source, { fetchText: loadText, signal }),
        persistTask: async (next) => {
          task = await persistTask(next);
          return task;
        },
        onProgress: (progress) => {
          latestProgress = progress;
          showProgress(task.id, progress);
        },
        recordTaskEvent: (code, level, details) =>
          recordTaskEvent(task.id, code, level ?? 'info', details ?? {}),
        recordRequestRetry,
        t,
      });
      const validation = await commitValidatedDirectoryOutput(
        directory,
        execution.finalFilename,
        execution.validationOptions,
        execution.partialOutputsToRemove,
      );
      await recordTaskEvent(task.id, 'output-validated', 'info', {
        filename: execution.finalFilename,
        bytesWritten: validation.size,
        ...(validation.videoTracks === undefined ? {} : { videoTracks: validation.videoTracks }),
        ...(validation.audioTracks === undefined ? {} : { audioTracks: validation.audioTracks }),
        ...(validation.durationSeconds === undefined
          ? {}
          : { durationSeconds: validation.durationSeconds }),
      });
      const completed = resetTaskState(task, 'completed');
      delete completed.checkpoint;
      delete completed.recoveryAttempt;
      delete completed.nextRetryAt;
      await persistTask(completed);
      await recordTaskEvent(task.id, 'task-completed', 'info', {
        completedSegments: latestProgress?.completedSegments,
        totalSegments: latestProgress?.totalSegments,
        bytesWritten: validation.size,
      });
      return 'completed' as const;
    } catch (cause) {
      const cancelled = signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError');
      const message = cancelled
        ? t('taskCancelled')
        : cause instanceof OutputValidationError ? t('outputValidationFailed')
        : cause instanceof Error ? cause.message : t('downloadFailed');
      const classified = classifyTaskError(cancelled
        ? new DOMException(message, 'AbortError')
        : cause);
      const failure = { ...classified, message: sanitizeDiagnosticText(message) };
      const previousRecoveryAttempts = task.recoveryAttempt ?? 0;
      if (
        !cancelled &&
        isRecoverableNetworkError(cause) &&
        previousRecoveryAttempts < networkSettings.taskRecoveryAttempts
      ) {
        const recoveryAttempt = previousRecoveryAttempts + 1;
        const delayMs = taskRetryDelay(networkSettings, recoveryAttempt);
        const recoveryProgress = latestProgress ? { ...latestProgress, phase: 'retrying' as const } : undefined;
        if (recoveryProgress) {
          delete recoveryProgress.retryAttempt;
          delete recoveryProgress.maxAttempts;
          delete recoveryProgress.retryDelayMs;
          delete recoveryProgress.retryReason;
        }
        const waiting: DownloadTask = {
          ...task,
          status: 'waiting',
          updatedAt: Date.now(),
          error: message,
          failure,
          recoveryAttempt,
          nextRetryAt: Date.now() + delayMs,
          ...(recoveryProgress ? { progress: recoveryProgress } : {}),
        };
        await persistTask(waiting);
        await recordTaskEvent(task.id, 'recovery-scheduled', 'warning', {
          message,
          recoveryAttempt,
          nextRetryAt: waiting.nextRetryAt,
          ...(failure.resourceHost ? { resourceHost: failure.resourceHost } : {}),
          ...(failure.resourcePath ? { resourcePath: failure.resourcePath } : {}),
          ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}),
          ...(failure.resourceKind ? { resourceKind: failure.resourceKind } : {}),
        });
        return 'waiting' as const;
      }
      const status = cancelled ? 'cancelled' : 'failed';
      const stopped = resetTaskState(task, status, message);
      stopped.failure = failure;
      if (latestProgress) stopped.progress = latestProgress;
      delete stopped.nextRetryAt;
      await persistTask(stopped);
      await recordTaskEvent(task.id, cancelled ? 'task-cancelled' : 'task-failed', cancelled ? 'warning' : 'error', {
        message,
        ...(failure.resourceHost ? { resourceHost: failure.resourceHost } : {}),
        ...(failure.resourcePath ? { resourcePath: failure.resourcePath } : {}),
        ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}),
        ...(failure.resourceKind ? { resourceKind: failure.resourceKind } : {}),
      });
      return status;
    }
  };

  const startQueue = async () => {
    if (!directory) {
      setError(t('chooseDirectoryBeforeQueue'));
      return;
    }
    const controller = new AbortController();
    abortController.current = controller;
    setRunning(true);
    setError(null);
    setSummary(null);
    setHostHealth([]);
    const hostController = new HostHealthController({
      maxConcurrency: taskConcurrency,
      onChange: setHostHealth,
    });
    try {
      const initial = (await listPersistentDownloadTasks()).filter(
        ({ status }) => status === 'queued' || status === 'waiting',
      );
      await configureManagerRequestAdapters(initial.map(({ source }) => source.adapterId));
      const includedIds = new Set(initial.map(({ id }) => id));
      while (!controller.signal.aborted) {
        const candidates = (await listPersistentDownloadTasks()).filter(
          ({ id, status }) => includedIds.has(id) && (status === 'queued' || status === 'waiting'),
        );
        if (candidates.length === 0) break;
        const now = Date.now();
        const ready = candidates.filter(({ status, nextRetryAt }) =>
          status === 'queued' || nextRetryAt === undefined || nextRetryAt <= now);
        if (ready.length === 0) {
          const nextRetryAt = Math.min(...candidates.map(({ nextRetryAt }) => nextRetryAt ?? now));
          await waitUntil(nextRetryAt, controller.signal);
          continue;
        }
        await runTaskPool({
          items: ready,
          concurrency: taskConcurrency,
          run: (task) => executeTask(task, controller.signal, hostController),
          shouldStop: () => controller.signal.aborted,
        });
      }

      const finalTasks = (await listPersistentDownloadTasks()).filter(({ id }) => includedIds.has(id));
      const completed = finalTasks.filter(({ status }) => status === 'completed').length;
      const failed = finalTasks.filter(({ status }) => status === 'failed').length;
      const cancelled = finalTasks.filter(({ status }) => status === 'cancelled').length;
      const untouched = finalTasks.filter(({ status }) => status === 'queued' || status === 'waiting').length;
      setSummary(t('queueFinished', {
        completed,
        failed,
        cancelled: cancelled ? t('cancelledSuffix', { count: cancelled }) : '',
        queued: untouched ? t('queuedSuffix', { count: untouched }) : '',
      }));
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : t('queueStoppedUnexpectedly'));
      }
    } finally {
      abortController.current = null;
      setRunning(false);
      await refreshTasks();
    }
  };

  const changeLanguage = async (rawValue: string) => {
    const previous = language;
    const next = appLanguageSchema.parse(rawValue);
    setLanguage(next);
    setSummary(null);
    try {
      await persistLanguage(next);
      setError(null);
    } catch (cause) {
      setLanguage(previous);
      setError(cause instanceof Error ? cause.message : t('unableSaveLanguage'));
    }
  };

  const changeTaskConcurrency = async (rawValue: string) => {
    const previous = taskConcurrency;
    const concurrency = taskConcurrencySchema.parse(Number(rawValue));
    setTaskConcurrency(concurrency);
    try {
      await persistTaskConcurrency(concurrency);
      setError(null);
    } catch (cause) {
      setTaskConcurrency(previous);
      setError(cause instanceof Error ? cause.message : t('unableSaveConcurrency'));
    }
  };

  const changeOutputFormat = async (next: OutputFormat) => {
    const previous = outputFormat;
    setOutputFormat(next);
    try {
      await persistOutputFormat(next);
      setError(null);
    } catch (cause) {
      setOutputFormat(previous);
      setError(cause instanceof Error ? cause.message : t('unableSaveOutput'));
    }
  };

  const saveNetworkSettings = async (next: NetworkSettings) => {
    const previous = networkSettings;
    setNetworkSettings(next);
    try {
      await persistNetworkSettings(next);
      setError(null);
    } catch (cause) {
      setNetworkSettings(previous);
      setError(cause instanceof Error ? cause.message : t('unableSaveNetwork'));
    }
  };

  const changeNetworkProfile = async (rawValue: string) => {
    const profile = networkProfileSchema.parse(rawValue);
    if (profile === 'custom') return;
    await saveNetworkSettings(NETWORK_PRESETS[profile]);
  };

  const changeNetworkValue = async <Key extends keyof Omit<NetworkSettings, 'profile'>>(
    key: Key,
    value: NetworkSettings[Key],
  ) => {
    const parsed = networkSettingsSchema.safeParse({ ...networkSettings, profile: 'custom', [key]: value });
    if (!parsed.success) {
      setError(t('networkSettingOutOfRange'));
      return;
    }
    await saveNetworkSettings(parsed.data);
  };

  const retryTask = async (task: DownloadTask) => {
    const queued = resetTaskState(task, 'queued');
    delete queued.recoveryAttempt;
    delete queued.nextRetryAt;
    await persistTask(queued);
    await recordTaskEvent(task.id, 'manual-retry');
  };

  const restartTask = async (task: DownloadTask) => {
    if (task.checkpoint) {
      if (!directory) {
        setError(t('chooseTaskFolderDiscard'));
        return;
      }
      if (directory.name !== task.checkpoint.directoryName) {
        setError(t('chooseOriginalFolderRestart', { name: task.checkpoint.directoryName }));
        return;
      }
      for (const partialFilename of checkpointPartialFilenames(task.checkpoint)) {
        await removeDirectoryFile(directory, partialFilename);
      }
    }
    const queued = resetTaskState(task, 'queued');
    delete queued.checkpoint;
    delete queued.recoveryAttempt;
    delete queued.nextRetryAt;
    await persistTask(queued);
    await recordTaskEvent(task.id, 'manual-restart');
  };

  const removeTask = async (task: DownloadTask) => {
    if (task.checkpoint) {
      if (!directory) {
        setError(t('chooseTaskFolderRemove'));
        return;
      }
      if (directory.name !== task.checkpoint.directoryName) {
        setError(t('chooseOriginalFolderRemove', { name: task.checkpoint.directoryName }));
        return;
      }
      for (const partialFilename of checkpointPartialFilenames(task.checkpoint)) {
        await removeDirectoryFile(directory, partialFilename);
      }
    }
    await removePersistentDownloadTask(task.id);
    setTasks((current) => current.filter(({ id }) => id !== task.id));
  };

  const clearCompleted = async () => {
    await clearCompletedPersistentDownloadTasks();
    await refreshTasks();
  };

  const queuedCount = tasks.filter(({ status }) => status === 'queued' || status === 'waiting').length;
  const completedCount = tasks.filter(({ status }) => status === 'completed').length;
  const activeCount = tasks.filter(({ status }) => status === 'resolving' || status === 'downloading').length;

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">{t('persistentBatchQueue')}</p>
          <h1>{t('downloadManager')}</h1>
          <p className="lede">{t('managerDescription')}</p>
        </div>
        <div className="hero-actions">
          <button className="secondary" onClick={() => void chooseDirectory()} disabled={running}>
            {directory
              ? t('folderSelected', { name: directory.name })
              : rememberedDirectory
                ? t('reconnectFolder', { name: rememberedDirectory.handle.name })
                : t('chooseOutputFolder')}
          </button>
          <button className="primary" onClick={() => void startQueue()} disabled={running || queuedCount === 0}>
            {running
              ? t('runningTasks', { active: activeCount, concurrency: taskConcurrency })
              : t('startQueue', { count: queuedCount })}
          </button>
          {running && (
            <button className="danger" onClick={() => abortController.current?.abort()}>{t('stopQueue')}</button>
          )}
        </div>
      </header>

      {error && <div className="notice error">{error}</div>}
      {summary && <div className="notice info">{summary}</div>}
      {hostHealth.map((health) => (
        <div className="notice host-health" key={health.host}>
          {health.blockedUntil && health.blockedUntil > Date.now()
            ? t('hostProtectionCooling', {
              host: health.host,
              time: new Date(health.blockedUntil).toLocaleTimeString(language),
            })
            : t('hostProtectionLimited', {
              host: health.host,
              limit: health.concurrencyLimit,
            })}
        </div>
      ))}
      {loading && <div className="notice info">{t('loadingManager')}</div>}

      {discovered.length > 0 && (
        <section className="panel discovery-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{t('discoveryAdapter')}</p>
              <h2>{discovered[0]?.seriesTitle ?? t('episodesFound')}</h2>
            </div>
            <div className="selection-actions">
              <button className="quiet" onClick={() => setSelectedIds(new Set(discovered.map(({ id }) => id)))}>
                {t('selectAll')}
              </button>
              <button className="quiet" onClick={() => setSelectedIds(new Set())}>{t('selectNone')}</button>
            </div>
          </div>
          <div className="episode-grid">
            {discovered.map((item) => (
              <label className="episode" key={item.id}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(item.id)}
                  onChange={(event) => {
                    const next = new Set(selectedIds);
                    if (event.target.checked) next.add(item.id);
                    else next.delete(item.id);
                    setSelectedIds(next);
                  }}
                />
                <span>{item.title}</span>
              </label>
            ))}
          </div>
          <div className="add-bar">
            <label>
              {t('output')}
              <select value={outputFormat} onChange={(event) => void changeOutputFormat(event.target.value as OutputFormat)}>
                <option value="mp4">{t('mp4LosslessRemux')}</option>
                <option value="original">{t('originalStream')}</option>
              </select>
            </label>
            <button className="primary" disabled={selectedIds.size === 0} onClick={() => void addSelected()}>
              {t('addSelected', { count: selectedIds.size })}
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{t('tasks')}</p>
            <h2>{t('savedCompleted', { saved: tasks.length, completed: completedCount })}</h2>
          </div>
          <div className="task-toolbar">
            <button className="secondary" disabled={running} onClick={() => setSettingsOpen((value) => !value)}>
              {settingsOpen ? t('closeSettings') : t('settings')}
            </button>
            {completedCount > 0 && (
              <button className="quiet" onClick={() => void clearCompleted()}>{t('clearCompleted')}</button>
            )}
          </div>
        </div>

        {settingsOpen && (
          <div className="settings-panel">
            <div className="settings-heading">
              <div>
                <p className="eyebrow">{t('downloadDefaults')}</p>
                <h3>{t('reliabilitySettings')}</h3>
              </div>
              <p>{t('settingsDescription')}</p>
            </div>
            <fieldset className="settings-grid" disabled={running}>
              <label>
                <span>{t('language')}</span>
                <select value={language} onChange={(event) => void changeLanguage(event.target.value)}>
                  {LANGUAGE_OPTIONS.map((option) => (
                    <option value={option.value} key={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t('outputFormat')}</span>
                <select value={outputFormat} onChange={(event) => void changeOutputFormat(event.target.value as OutputFormat)}>
                  <option value="mp4">{t('mp4LosslessRemux')}</option>
                  <option value="original">{t('originalStream')}</option>
                </select>
              </label>
              <label>
                <span>{t('concurrentDownloads')}</span>
                <select value={taskConcurrency} onChange={(event) => void changeTaskConcurrency(event.target.value)}>
                  {[1, 2, 3, 4].map((value) => <option value={value} key={value}>{value}</option>)}
                </select>
              </label>
              <label>
                <span>{t('networkProfile')}</span>
                <select value={networkSettings.profile} onChange={(event) => void changeNetworkProfile(event.target.value)}>
                  <option value="resilient">{t('profileResilient')}</option>
                  <option value="balanced">{t('profileBalanced')}</option>
                  <option value="custom">{t('profileCustom')}</option>
                </select>
              </label>
              <label>
                <span>{t('attemptsPerRequest')}</span>
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={networkSettings.maxAttempts}
                  onChange={(event) => Number.isFinite(event.currentTarget.valueAsNumber) &&
                    void changeNetworkValue('maxAttempts', event.currentTarget.valueAsNumber)}
                />
              </label>
              <label>
                <span>{t('firstByteTimeout')}</span>
                <input
                  type="number"
                  min="5"
                  max="120"
                  value={networkSettings.firstByteTimeoutSeconds}
                  onChange={(event) => Number.isFinite(event.currentTarget.valueAsNumber) &&
                    void changeNetworkValue('firstByteTimeoutSeconds', event.currentTarget.valueAsNumber)}
                />
              </label>
              <label>
                <span>{t('idleTimeout')}</span>
                <input
                  type="number"
                  min="5"
                  max="120"
                  value={networkSettings.idleTimeoutSeconds}
                  onChange={(event) => Number.isFinite(event.currentTarget.valueAsNumber) &&
                    void changeNetworkValue('idleTimeoutSeconds', event.currentTarget.valueAsNumber)}
                />
              </label>
              <label>
                <span>{t('taskRecoveryRounds')}</span>
                <input
                  type="number"
                  min="0"
                  max="12"
                  value={networkSettings.taskRecoveryAttempts}
                  onChange={(event) => Number.isFinite(event.currentTarget.valueAsNumber) &&
                    void changeNetworkValue('taskRecoveryAttempts', event.currentTarget.valueAsNumber)}
                />
              </label>
              <label>
                <span>{t('recoveryDelay')}</span>
                <input
                  type="number"
                  min="5"
                  max="300"
                  value={networkSettings.taskRetryBaseDelaySeconds}
                  onChange={(event) => Number.isFinite(event.currentTarget.valueAsNumber) &&
                    void changeNetworkValue('taskRetryBaseDelaySeconds', event.currentTarget.valueAsNumber)}
                />
              </label>
              <label>
                <span>{t('maxRecoveryDelay')}</span>
                <input
                  type="number"
                  min="30"
                  max="900"
                  value={networkSettings.taskRetryMaxDelaySeconds}
                  onChange={(event) => Number.isFinite(event.currentTarget.valueAsNumber) &&
                    void changeNetworkValue('taskRetryMaxDelaySeconds', event.currentTarget.valueAsNumber)}
                />
              </label>
              <label className="toggle-setting">
                <input
                  type="checkbox"
                  checked={networkSettings.resumePartialDownloads}
                  onChange={(event) => void changeNetworkValue('resumePartialDownloads', event.currentTarget.checked)}
                />
                <span>{t('keepPartialDownloads')}</span>
              </label>
            </fieldset>
            <p className="settings-note">{t('twoRkConcurrencyHint')}</p>
          </div>
        )}

        {tasks.length === 0 && <div className="empty">{t('noBatchTasks')}</div>}
        <div className="task-list">
          {tasks.map((task) => (
            <article className="task" key={task.id}>
              <div className="task-copy">
                <div className="task-title">
                  <strong>{task.source.title}</strong>
                  <span className={`status status-${task.status}`}>{t(STATUS_LABEL_KEYS[task.status])}</span>
                </div>
                <span>{task.source.seriesTitle}</span>
                {task.error && <p className="task-error">{task.error}</p>}
                {task.failure && (
                  <p className={`failure-summary failure-${task.failure.category}`}>
                    {t('failureSummary', {
                      category: t(FAILURE_CATEGORY_LABEL_KEYS[task.failure.category]),
                      recoverability: t(task.failure.recoverable ? 'failureRecoverable' : 'failureNeedsAction'),
                    })}
                  </p>
                )}
                {task.status === 'waiting' && task.nextRetryAt && (
                  <p className="recovery-detail">
                    {t('recoverySchedule', {
                      attempt: task.recoveryAttempt ?? 0,
                      max: networkSettings.taskRecoveryAttempts,
                      time: new Date(task.nextRetryAt).toLocaleTimeString(language),
                    })}
                  </p>
                )}
                {task.checkpoint && task.status !== 'completed' && (
                  <p className="checkpoint-detail">
                    {t('resumeSaved', {
                      completed: task.checkpoint.completedSegments,
                      total: task.checkpoint.totalSegments,
                      bytes: formatBytes(task.checkpoint.bytesWritten) ?? '0 B',
                    })}
                  </p>
                )}
                {task.progress && <TaskProgress progress={task.progress} t={t} />}
                {expandedTaskId === task.id && (
                  <div className="diagnostic-panel">
                    <div className="diagnostic-heading">
                      <strong>{t('details')}</strong>
                      <button className="secondary" onClick={() => void exportTaskDiagnostics(task)}>
                        {t('exportDiagnosticReport')}
                      </button>
                    </div>
                    {diagnosticsLoadingId === task.id && (
                      <p className="diagnostic-empty">{t('loadingDiagnostics')}</p>
                    )}
                    {diagnosticsLoadingId !== task.id && (diagnosticEvents[task.id]?.length ?? 0) === 0 && (
                      <p className="diagnostic-empty">{t('noDiagnosticEvents')}</p>
                    )}
                    <ol className="diagnostic-events">
                      {(diagnosticEvents[task.id] ?? []).map((event) => {
                        const metadata = diagnosticEventMetadata(event, t);
                        return (
                          <li className={`diagnostic-event event-${event.level}`} key={event.id}>
                            <time>{new Date(event.at).toLocaleTimeString(language)}</time>
                            <div>
                              <strong>{t(DIAGNOSTIC_EVENT_LABEL_KEYS[event.code])}</strong>
                              {metadata.length > 0 && <span>{metadata.join(' · ')}</span>}
                              {event.message && <p>{event.message}</p>}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                )}
              </div>
              <div className="task-actions">
                <button className="quiet" onClick={() => void toggleTaskDetails(task.id)}>
                  {expandedTaskId === task.id ? t('closeDetails') : t('details')}
                </button>
                {(task.status === 'failed' || task.status === 'cancelled' || task.status === 'waiting') && (
                  <button className="secondary" disabled={running} onClick={() => void retryTask(task)}>
                    {task.checkpoint ? t('resume') : t('retry')}
                  </button>
                )}
                {task.checkpoint && (task.status === 'failed' || task.status === 'cancelled' || task.status === 'waiting') && (
                  <button className="quiet" disabled={running} onClick={() => void restartTask(task)}>{t('restart')}</button>
                )}
                {task.status !== 'downloading' && task.status !== 'resolving' && (
                  <button className="quiet" disabled={running} onClick={() => void removeTask(task)}>{t('remove')}</button>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      <p className="footnote">{t('taskFootnote')}</p>
    </main>
  );
}
