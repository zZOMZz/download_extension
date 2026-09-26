import { openDirectoryOutputWriter } from '../directory-output-writer';
import { safeFilename } from '../../core/format';
import {
  HttpStatusError,
  NetworkResourceError,
  NetworkTimeoutError,
} from '../../core/hls/download-hls';
import { downloadProgressiveMedia } from '../../core/progressive/download-progressive';
import { resetTaskState } from '../../core/task-state';
import type { DownloadTaskProgress } from '../../shared/download-task';
import type { ProtocolTaskExecutor } from './types';

export const progressiveTaskExecutor: ProtocolTaskExecutor = {
  kind: 'progressive',
  async execute(context) {
    if (context.media.kind !== 'progressive') {
      throw new Error('The progressive task executor received another protocol.');
    }
    // A segmented checkpoint cannot be applied to a complete-file response.
    if (context.task.checkpoint) throw new Error(context.t('refreshedStreamIncompatible'));
    context.signal.throwIfAborted();
    const title = [context.task.source.seriesTitle, context.task.source.title].filter(Boolean).join(' - ');
    const filename = `${safeFilename(title || context.task.source.title)}.mp4`;
    await context.persistTask(resetTaskState(context.task, 'downloading'));
    const destination = await openDirectoryOutputWriter(context.directory, filename);
    let latestProgress: DownloadTaskProgress | undefined;
    let outputFailure: unknown;
    try {
      await context.recordTaskEvent('output-opened', 'info', {
        directoryName: context.directory.name,
        filename,
      });
      await context.recordTaskEvent('download-started', 'info', { totalSegments: 1 });
      await downloadProgressiveMedia(context.media.url, {
        async write(bytes) {
          try { await destination.write(bytes); }
          catch (cause) { outputFailure = cause; throw cause; }
        },
        async close() {
          try { await destination.close(); }
          catch (cause) { outputFailure = cause; throw cause; }
        },
        abort: (cause) => destination.abort(cause),
      }, {
        signal: context.signal,
        networkPolicy: context.networkPolicy,
        onProgress: (progress) => {
          latestProgress = progress;
          context.onProgress(progress);
        },
      });
    } catch (cause) {
      await destination.abort(cause).catch(() => {});
      if (!context.signal.aborted && cause !== outputFailure && (
        cause instanceof HttpStatusError || cause instanceof NetworkTimeoutError || cause instanceof TypeError
      )) {
        const recoverable = !(cause instanceof HttpStatusError) ||
          [401, 403, 408, 425, 429].includes(cause.status) || cause.status >= 500;
        // Queue recovery resolves a fresh URL and starts a new complete-file write.
        throw new NetworkResourceError('media-segment', context.media.url, 1, recoverable, cause);
      }
      throw cause;
    }
    return {
      finalFilename: filename,
      validationOptions: {
        format: 'mp4',
        requireVideo: true,
        ...(latestProgress ? { expectedBytes: latestProgress.bytesWritten } : {}),
      },
    };
  },
};
