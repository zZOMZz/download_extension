import { describe, expect, it } from 'vitest';
import { buildTaskDiagnosticReport } from '../src/core/diagnostics/task-report';
import { NETWORK_PRESETS } from '../src/shared/settings';
import type { DownloadTask } from '../src/shared/download-task';
import { createTaskDiagnosticEvent } from '../src/shared/task-diagnostics';

describe('task diagnostic report', () => {
  it('keeps an independent, sanitized failure snapshot in the event history', () => {
    const failure = { category: 'source' as const, code: 'browserSourceUnavailable', recoverable: false,
      occurredAt: 1, message: 'https://example.test/video?token=secret', params: { reason: 'sdk-uninitialized', url: 'https://example.test/video?token=secret' } };
    const event = createTaskDiagnosticEvent({ taskId: 'sample', level: 'warning', code: 'source-waiting', failure });
    failure.params.reason = 'changed-after-retry';
    expect(event.failure?.params?.reason).toBe('sdk-uninitialized');
    expect(JSON.stringify(event)).not.toContain('token=secret');
  });
  it('contains useful task context without signed URL query parameters', () => {
    const task: DownloadTask = {
      id: 'task-1',
      source: {
        id: 'episode-1',
        adapterId: 'test',
        pageUrl: 'https://video.example/detail/show?id=1&token=secret',
        title: 'Episode 1',
        seriesTitle: 'Series',
      },
      outputFormat: 'mp4',
      status: 'failed',
      createdAt: 1,
      updatedAt: 2,
      error: 'HTTP 503',
    };

    const report = buildTaskDiagnosticReport(task, [], {
      network: NETWORK_PRESETS.resilient,
      taskConcurrency: 2,
      generatedAt: 3,
      userAgent: 'test-browser',
    });
    const parsed = JSON.parse(report) as { task: { pageUrl: string }; reportVersion: number };

    expect(parsed.reportVersion).toBe(2);
    expect(parsed.task.pageUrl).toBe('https://video.example/detail/show');
    expect(report).not.toContain('secret');
  });

  it('reports DASH video and audio resume state independently', () => {
    const task: DownloadTask = {
      id: 'task-dash',
      source: {
        id: 'episode-dash',
        adapterId: 'bilibili',
        pageUrl: 'https://www.bilibili.com/video/BVtest?p=2',
        title: 'Episode 2',
        seriesTitle: 'Series',
        mediaKind: 'dash',
      },
      outputFormat: 'mp4',
      status: 'waiting',
      createdAt: 1,
      updatedAt: 2,
      checkpoint: {
        version: 2,
        protocol: 'dash',
        planFingerprint: 'plan-fingerprint',
        directoryName: 'Downloads',
        directoryHandleId: 'directory-1',
        finalFilename: 'episode.mp4',
        completedSegments: 5,
        totalSegments: 10,
        bytesWritten: 3_000,
        tracks: {
          video: {
            trackId: 'video-80',
            fingerprint: 'video-fingerprint',
            partialFilename: 'episode.video.part',
            initializationBytes: 1_000,
            completedSegments: 2,
            totalSegments: 4,
            bytesWritten: 2_000,
            segmentEndOffsets: [1_000, 1_500, 2_000],
          },
          audio: {
            trackId: 'audio-30280',
            fingerprint: 'audio-fingerprint',
            partialFilename: 'episode.audio.part',
            initializationBytes: 500,
            completedSegments: 3,
            totalSegments: 6,
            bytesWritten: 1_000,
            segmentEndOffsets: [500, 700, 850, 1_000],
          },
        },
        updatedAt: 2,
      },
    };

    const report = JSON.parse(buildTaskDiagnosticReport(task, [], {
      network: NETWORK_PRESETS.resilient,
      taskConcurrency: 2,
      generatedAt: 3,
    })) as {
      task: {
        mediaKind: string;
        checkpoint: {
          protocol: string;
          tracks: Record<'video' | 'audio', {
            trackId: string;
            completedSegments: number;
            savedBoundaries: number;
          }>;
        };
      };
    };

    expect(report.task.mediaKind).toBe('dash');
    expect(report.task.checkpoint.protocol).toBe('dash');
    expect(report.task.checkpoint.tracks.video).toMatchObject({
      trackId: 'video-80',
      completedSegments: 2,
      savedBoundaries: 3,
    });
    expect(report.task.checkpoint.tracks.audio).toMatchObject({
      trackId: 'audio-30280',
      completedSegments: 3,
      savedBoundaries: 4,
    });
  });
});
