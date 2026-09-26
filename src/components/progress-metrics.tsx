import { formatByteRate, formatBytes, formatDuration } from '../core/format';
import type { DownloadTaskProgress } from '../shared/download-task';
import type { MessageKey, Translator } from '../shared/i18n';
import { useProgressSnapshot } from './use-progress-snapshot';

const PHASE_LABEL_KEYS: Record<NonNullable<DownloadTaskProgress['phase']>, MessageKey> = {
  requesting: 'phaseRequesting',
  downloading: 'phaseDownloading',
  decrypting: 'phaseDecrypting',
  processing: 'phaseProcessing',
  finalizing: 'phaseFinalizing',
  retrying: 'phaseRetrying',
  completed: 'phaseCompleted',
};

export interface ProgressMetricView {
  id: 'phase' | 'current-rate' | 'average-rate' | 'eta' | 'segment' | 'last-segment';
  label: string;
  value: string;
  emphasized?: boolean;
}

export function buildProgressMetrics(
  progress: DownloadTaskProgress,
  t: Translator,
): ProgressMetricView[] {
  const currentRate = formatByteRate(progress.currentSpeedBytesPerSecond);
  const averageRate = formatByteRate(progress.averageSpeedBytesPerSecond);
  const eta = formatDuration(progress.estimatedSecondsRemaining);
  const segmentReceived = formatBytes(progress.currentSegmentBytesReceived);
  const segmentTotal = formatBytes(progress.currentSegmentBytesTotal);
  const lastSegment = progress.lastSegmentDurationMs === undefined
    ? undefined
    : formatDuration(progress.lastSegmentDurationMs / 1_000);

  return [
    {
      id: 'phase',
      label: t('progressActivity'),
      value: progress.phase ? t(PHASE_LABEL_KEYS[progress.phase]) : t('downloading'),
      emphasized: true,
    },
    { id: 'current-rate', label: t('progressCurrentSpeed'), value: currentRate ?? '—' },
    { id: 'average-rate', label: t('progressAverageSpeed'), value: averageRate ?? '—' },
    { id: 'eta', label: t('progressTimeRemaining'), value: eta ?? '—' },
    {
      id: 'segment',
      label: t('progressCurrentSegment'),
      value: segmentReceived && segmentTotal ? `${segmentReceived} / ${segmentTotal}` : '—',
    },
    { id: 'last-segment', label: t('progressLastSegment'), value: lastSegment ?? '—' },
  ];
}

export function ProgressMetrics({ progress: liveProgress, t }: {
  progress: DownloadTaskProgress;
  t: Translator;
}) {
  const progress = useProgressSnapshot(liveProgress);
  const metrics = buildProgressMetrics(progress, t);
  const retrying = progress.phase === 'retrying';
  const retryText = retrying
    ? [
        t('retryAttempt', {
          attempt: progress.retryAttempt ?? 0,
          max: progress.maxAttempts ?? 0,
          duration: formatDuration((progress.retryDelayMs ?? 0) / 1_000) ?? '0s',
        }),
        progress.retryReason,
      ].filter(Boolean).join(' · ')
    : '\u00a0';

  return (
    <>
      <div className="progress-metrics">
        {metrics.map((metric) => (
          <div
            className={`progress-metric progress-metric-${metric.id}${metric.emphasized ? ' is-emphasized' : ''}`}
            key={metric.id}
          >
            <span className="progress-metric-label">{metric.label}</span>
            <strong className="progress-metric-value" title={metric.value}>{metric.value}</strong>
          </div>
        ))}
      </div>
      <p
        className={`retry-detail${retrying ? '' : ' retry-detail-placeholder'}`}
        aria-hidden={retrying ? undefined : true}
        title={retrying ? retryText : undefined}
      >
        {retryText}
      </p>
    </>
  );
}
