import { describe, expect, it } from 'vitest';
import { buildProgressMetrics } from '../src/components/progress-metrics';
import { createTranslator } from '../src/shared/i18n';
import type { DownloadTaskProgress } from '../src/shared/download-task';

const t = createTranslator('en');

function progress(overrides: Partial<DownloadTaskProgress> = {}): DownloadTaskProgress {
  return {
    completedSegments: 0,
    totalSegments: 10,
    bytesWritten: 0,
    ...overrides,
  };
}

describe('progress metrics', () => {
  it('keeps all metric slots present before measurements are available', () => {
    const metrics = buildProgressMetrics(progress({ phase: 'requesting' }), t);

    expect(metrics.map(({ id }) => id)).toEqual([
      'phase',
      'current-rate',
      'average-rate',
      'eta',
      'segment',
      'last-segment',
    ]);
    expect(metrics.map(({ value }) => value)).toEqual([
      'Waiting for server',
      '—',
      '—',
      '—',
      '—',
      '—',
    ]);
  });

  it('updates values without changing metric identity or count', () => {
    const emptyIds = buildProgressMetrics(progress(), t).map(({ id }) => id);
    const measured = buildProgressMetrics(progress({
      phase: 'downloading',
      currentSpeedBytesPerSecond: 1_500_000,
      averageSpeedBytesPerSecond: 1_250_000,
      estimatedSecondsRemaining: 65,
      currentSegmentBytesReceived: 500_000,
      currentSegmentBytesTotal: 2_000_000,
      lastSegmentDurationMs: 1_500,
    }), t);

    expect(measured.map(({ id }) => id)).toEqual(emptyIds);
    expect(measured.map(({ value }) => value)).toEqual([
      'Receiving segment',
      '1.4 MB/s',
      '1.2 MB/s',
      '1m 5s',
      '488 KB / 1.9 MB',
      '2s',
    ]);
  });
});
