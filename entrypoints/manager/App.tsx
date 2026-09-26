import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  listPersistentDownloadTasks,
  listPersistentTaskDiagnosticEvents,
  scanTabForMedia,
} from '~/src/browser/runtime-client';
import type { WritableDirectoryHandle } from '~/src/browser/directory-output-writer';
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
import { buildTaskDiagnosticReport } from '~/src/core/diagnostics/task-report';
import { formatBytes, formatDuration, safeFilename } from '~/src/core/format';
import { ProgressMetrics } from '~/src/components/progress-metrics';
import { BrandMark } from '~/src/components/brand-mark';
import { LiquidShader } from '~/src/components/liquid-shader';
import type { HostHealthSnapshot } from '~/src/core/network/host-health';
import { createBrowserDownloadRuntime } from '~/src/browser/download-runtime';
import { runtimeErrorMessage, runtimeFailureMessage } from '~/src/browser/runtime-messages';
import type { DownloadRuntime } from '~/src/runtime/download-runtime';
import { createTranslator, LANGUAGE_OPTIONS, type MessageKey, type Translator } from '~/src/shared/i18n';
import {
  DOWNLOAD_TASKS_STORAGE_KEY,
  type DashDownloadCheckpoint,
  type DownloadTask,
  type DownloadTaskStatus,
} from '~/src/shared/download-task';
import type { DiscoveredMediaItem } from '~/src/shared/discovery';
import {
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
  'dash-tracks-selected': 'eventDashTracksSelected',
  'audio-rendition-loaded': 'eventAudioRenditionLoaded',
  'output-opened': 'eventOutputOpened',
  'resume-prepared': 'eventResumePrepared',
  'download-started': 'eventDownloadStarted',
  'request-retry': 'eventRequestRetry',
  'checkpoint-saved': 'eventCheckpointSaved',
  'recovery-scheduled': 'eventRecoveryScheduled',
  'finalize-started': 'eventFinalizeStarted',
  'output-validated': 'eventOutputValidated',
  'output-cleanup-pending': 'eventOutputCleanupPending',
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
  return (
    <div className="progress-block">
      <div className="progress-headline">
        <span>{t('segmentsProgress', { completed: progress.completedSegments, total: progress.totalSegments })}</span>
        <span>{formatBytes(progress.bytesWritten)}</span>
      </div>
      <progress value={progressValue(progress)} max={progress.totalSegments} />
      <ProgressMetrics progress={progress} t={t} />
    </div>
  );
}

function taskMediaKind(task: DownloadTask): 'hls' | 'dash' | 'progressive' | undefined {
  if (task.source.mediaKind) return task.source.mediaKind;
  if (task.checkpoint?.version === 1) return 'hls';
  if (task.checkpoint?.version === 2) return 'dash';
  return undefined;
}

function formatBitRate(bitsPerSecond: number | undefined): string | undefined {
  if (bitsPerSecond === undefined) return undefined;
  return bitsPerSecond >= 1_000_000
    ? `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`
    : `${Math.round(bitsPerSecond / 1_000)} kbps`;
}

function DashCheckpointProgress({ checkpoint, t }: {
  checkpoint: DashDownloadCheckpoint;
  t: Translator;
}) {
  return (
    <div className="dash-track-progress">
      {(['video', 'audio'] as const).map((kind) => {
        const track = checkpoint.tracks[kind];
        return (
          <div className="dash-track" key={kind}>
            <div>
              <strong>{t(kind === 'video' ? 'videoTrack' : 'audioTrack')}</strong>
              <span>{t('segmentsProgress', {
                completed: track.completedSegments,
                total: track.totalSegments,
              })}</span>
              <span>{formatBytes(track.bytesWritten) ?? '0 B'}</span>
            </div>
            <progress value={track.completedSegments} max={track.totalSegments} />
          </div>
        );
      })}
    </div>
  );
}

function diagnosticEventMetadata(event: TaskDiagnosticEvent, t: Translator): string[] {
  const details: string[] = [];
  if (event.protocol) details.push(t(event.protocol === 'dash' ? 'protocolDash' : 'protocolHls'));
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
  if (event.videoTrackId) {
    const trackDetails = [
      event.videoTrackId,
      event.videoWidth && event.videoHeight ? `${event.videoWidth}×${event.videoHeight}` : undefined,
      event.videoCodec,
      formatBitRate(event.videoBandwidth),
    ].filter(Boolean).join(' · ');
    details.push(t('diagnosticVideoTrack', { details: trackDetails }));
  }
  if (event.audioTrackId) {
    const trackDetails = [
      event.audioTrackId,
      event.audioCodec,
      formatBitRate(event.audioBandwidth),
    ].filter(Boolean).join(' · ');
    details.push(t('diagnosticAudioTrack', { details: trackDetails }));
  }
  if (event.durationSeconds !== undefined) {
    details.push(t('diagnosticMediaDuration', {
      duration: formatDuration(event.durationSeconds) ?? '0s',
    }));
  }
  if (event.filename) details.push(event.filename);
  return details;
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
  const runtimeRef = useRef<DownloadRuntime | null>(null);
  const t = useMemo(() => createTranslator(language), [language]);

  const refreshTasks = async () => {
    setTasks(await listPersistentDownloadTasks());
  };

  const createRuntime = () => createBrowserDownloadRuntime({
    directory,
    ...(directoryHandleId ? { directoryHandleId } : {}),
    networkSettings,
    concurrency: taskConcurrency,
    onEvent: (event) => setDiagnosticEvents((current) => current[event.taskId]
      ? { ...current, [event.taskId]: [...current[event.taskId]!, event] }
      : current),
  });

  useEffect(() => () => runtimeRef.current?.cancel(), []);

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
        setTasks(storedTasks);

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
      const snapshot = await createRuntime().enqueue(items, outputFormat);
      setTasks([...snapshot.tasks]);
      setSelectedIds(new Set());
      setError(null);
    } catch (cause) {
      setError(runtimeErrorMessage(cause, t));
    }
  };

  const startQueue = async () => {
    if (!directory) { setError(t('chooseDirectoryBeforeQueue')); return; }
    if (runtimeRef.current) return;
    const runtime = createRuntime();
    runtimeRef.current = runtime;
    setRunning(true);
    setError(null);
    setSummary(null);
    const included = new Set(tasks.filter(({ status }) =>
      ['queued', 'waiting', 'resolving', 'downloading'].includes(status)).map(({ id }) => id));
    const unsubscribe = runtime.subscribe((snapshot) => {
      setTasks([...snapshot.tasks]);
      setHostHealth([...snapshot.hostHealth]);
    });
    try {
      const snapshot = await runtime.start();
      const results = snapshot.tasks.filter(({ id }) => included.has(id));
      const completed = results.filter(({ status }) => status === 'completed').length;
      const failed = results.filter(({ status }) => status === 'failed').length;
      const cancelled = results.filter(({ status }) => status === 'cancelled').length;
      const queued = results.filter(({ status }) => status === 'queued' || status === 'waiting').length;
      setSummary(t('queueFinished', { completed, failed,
        cancelled: cancelled ? t('cancelledSuffix', { count: cancelled }) : '',
        queued: queued ? t('queuedSuffix', { count: queued }) : '' }));
    } catch (cause) {
      setError(runtimeErrorMessage(cause, t));
    } finally {
      unsubscribe();
      runtimeRef.current = null;
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

  const runTaskCommand = async (command: 'retry' | 'restart' | 'remove', task: DownloadTask) => {
    try {
      const runtime = createRuntime();
      await runtime[command](task.id);
      setTasks([...runtime.getSnapshot().tasks]);
      setError(null);
    } catch (cause) { setError(runtimeErrorMessage(cause, t)); }
  };
  const retryTask = (task: DownloadTask) => runTaskCommand('retry', task);
  const restartTask = (task: DownloadTask) => runTaskCommand('restart', task);
  const removeTask = (task: DownloadTask) => runTaskCommand('remove', task);
  const clearCompleted = async () => {
    try {
      const runtime = createRuntime();
      await runtime.clearCompleted();
      setTasks([...runtime.getSnapshot().tasks]);
    } catch (cause) { setError(runtimeErrorMessage(cause, t)); }
  };

  const queuedCount = tasks.filter(({ status, outputCommit }) => ['queued', 'waiting', 'resolving', 'downloading'].includes(status) || (status === 'completed' && outputCommit)).length;
  const completedCount = tasks.filter(({ status }) => status === 'completed').length;
  const activeCount = tasks.filter(({ status }) => status === 'resolving' || status === 'downloading').length;
  const discoveredDashOnly = discovered.length > 0 && discovered.every(({ mediaKind }) => mediaKind === 'dash' || mediaKind === 'progressive');

  return (
    <>
      <LiquidShader />
      <main>
      <header className="hero">
        <BrandMark />
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
            <button className="danger" onClick={() => runtimeRef.current?.cancel()}>{t('stopQueue')}</button>
          )}
        </div>
      </header>

      <section className="queue-overview" aria-label={t('downloadQueue')}>
        <div className="queue-heading">
          <p className="eyebrow">{t('persistentBatchQueue')}</p>
          <h1>{t('downloadQueue')}</h1>
          <p className="lede">{t('managerDescription')}</p>
        </div>
        <div className="queue-counts">
          <div className="queue-count">
            <strong>{activeCount}</strong>
            <span>{t('statusDownloading')}</span>
          </div>
          <div className="queue-count">
            <strong>{queuedCount}</strong>
            <span>{t('statusQueued')}</span>
          </div>
          <div className="queue-count">
            <strong>{completedCount}</strong>
            <span>{t('statusCompleted')}</span>
          </div>
        </div>
      </section>

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
              <select
                value={discoveredDashOnly ? 'mp4' : outputFormat}
                disabled={discoveredDashOnly}
                onChange={(event) => void changeOutputFormat(event.target.value as OutputFormat)}
              >
                <option value="mp4">{t('mp4LosslessRemux')}</option>
                <option value="original">{t('originalStream')}</option>
              </select>
            </label>
            {discoveredDashOnly && <p className="dash-output-note">{t('dashBatchMp4Notice')}</p>}
            <button className="primary" disabled={running || selectedIds.size === 0} onClick={() => void addSelected()}>
              {t('addSelected', { count: selectedIds.size })}
            </button>
          </div>
        </section>
      )}

      <section className="panel task-panel">
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
              <button className="quiet" disabled={running} onClick={() => void clearCompleted()}>{t('clearCompleted')}</button>
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
          {tasks.map((task, index) => {
            const mediaKind = taskMediaKind(task);
            return (
            <article className="task" key={task.id}>
              <span className="task-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <div className="task-copy">
                <div className="task-title">
                  <strong>{task.source.title}</strong>
                  <div className="task-badges">
                    {mediaKind && (
                      <span className={`protocol protocol-${mediaKind}`}>
                        {mediaKind === 'progressive' ? 'MP4' : t(mediaKind === 'dash' ? 'protocolDash' : 'protocolHls')}
                      </span>
                    )}
                    <span className="output-badge">
                      {mediaKind === 'dash' || mediaKind === 'progressive' || task.outputFormat === 'mp4'
                        ? t('outputMp4')
                        : t('outputOriginal')}
                    </span>
                    <span className={`status status-${task.status}`}>{t(STATUS_LABEL_KEYS[task.status])}</span>
                  </div>
                </div>
                <span>{task.source.seriesTitle}</span>
                {task.error && <p className="task-error">{runtimeFailureMessage(task.failure, task.error, t)}</p>}
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
                {task.checkpoint?.version === 2 && task.status !== 'completed' && (
                  <DashCheckpointProgress checkpoint={task.checkpoint} t={t} />
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
            );
          })}
        </div>
      </section>

      <p className="footnote">{t('taskFootnote')}</p>
      </main>
    </>
  );
}
