import type { MediaCandidate } from '../shared/media';
import {
  describeDirectOutput, executeDirectDownload, type DirectDownloadOptions, type DirectMediaSelection, type DirectOutputTarget,
} from '../runtime/direct-download';
import { browserTransformBackend } from './runtime-adapters';
import { browserTransport } from '../core/network/transport';
import { getYouTubeSabrContext } from './runtime-client';

/** Keep site preview metadata in the browser host, including the existing filename marker. */
export function describeBrowserDirectOutput(
  selection: DirectMediaSelection,
  candidate: Pick<MediaCandidate, 'title' | 'isPreview'>,
) {
  const output = describeDirectOutput(selection, candidate.title ?? 'video');
  if (candidate.isPreview && (selection.kind === 'dash' || selection.kind === 'progressive')) {
    output.filename = output.filename.replace(/\.mp4$/, '-preview.mp4');
  }
  return output;
}

export interface BrowserDirectDownloadOptions extends Omit<DirectDownloadOptions, 'transforms'> {
  sourceTabId: number;
  candidateId: string;
}

/** The caller has already invoked the picker under a user gesture before this bridge awaits it. */
export async function runBrowserDirectDownload(
  selection: DirectMediaSelection,
  pendingTarget: Promise<DirectOutputTarget>,
  options: BrowserDirectDownloadOptions,
) {
  const target = await pendingTarget;
  try {
    options.signal?.throwIfAborted();
    const request = selection.kind === 'sabr'
      ? { ...selection, context: await getYouTubeSabrContext(options.sourceTabId, options.candidateId) }
      : selection;
    options.signal?.throwIfAborted();
    return await executeDirectDownload(request, target, {
      ...options,
      transport: options.transport ?? browserTransport,
      transforms: browserTransformBackend,
    });
  } catch (cause) {
    await target.abort(cause).catch(() => {});
    throw cause;
  }
}
