import { describe, expect, it } from 'vitest';
import { buildTaskDiagnosticReport } from '../src/core/diagnostics/task-report';
import { NETWORK_PRESETS } from '../src/shared/settings';
import type { DownloadTask } from '../src/shared/download-task';

describe('task diagnostic report', () => {
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

    expect(parsed.reportVersion).toBe(1);
    expect(parsed.task.pageUrl).toBe('https://video.example/detail/show');
    expect(report).not.toContain('secret');
  });
});
