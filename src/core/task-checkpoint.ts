import type { DownloadCheckpoint } from '../shared/download-task';

export function checkpointMatchesDirectory(
  checkpoint: Pick<DownloadCheckpoint, 'directoryHandleId' | 'directoryName'>,
  directory: { name: string; handleId?: string },
): boolean {
  return checkpoint.directoryHandleId
    ? checkpoint.directoryHandleId === directory.handleId
    : checkpoint.directoryName === directory.name;
}

export function checkpointPartialFilenames(checkpoint: DownloadCheckpoint): string[] {
  return checkpoint.version === 1
    ? [checkpoint.partialFilename]
    : [checkpoint.tracks.video.partialFilename, checkpoint.tracks.audio.partialFilename];
}
