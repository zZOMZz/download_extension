import type { HlsMediaPlaylist } from '../protocols/hls';
import type { DownloadCheckpoint } from '../../shared/download-task';

export function checkpointMatchesDirectory(
  checkpoint: DownloadCheckpoint,
  directory: { name: string; handleId?: string },
): boolean {
  return checkpoint.directoryHandleId
    ? checkpoint.directoryHandleId === directory.handleId
    : checkpoint.directoryName === directory.name;
}

function stableResourcePath(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl.split('?', 1)[0] ?? rawUrl;
  }
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function hlsPlaylistFingerprint(playlist: HlsMediaPlaylist): string {
  const identity = playlist.segments.map((segment) => [
    segment.sequence,
    Math.round(segment.duration * 1_000),
    stableResourcePath(segment.uri),
    segment.byteRange?.offset ?? '',
    segment.byteRange?.length ?? '',
    segment.map ? stableResourcePath(segment.map.uri) : '',
  ].join(':')).join('|');
  return `hls-v1:${playlist.mediaSequence}:${playlist.segments.length}:${fnv1a(identity)}`;
}

export interface ReconciledCheckpointPosition {
  completedSegments: number;
  bytesWritten: number;
  segmentEndOffsets: number[];
}

export function reconcileCheckpointFile(
  checkpoint: DownloadCheckpoint,
  fileSize: number,
): ReconciledCheckpointPosition {
  if (checkpoint.segmentEndOffsets.length !== checkpoint.completedSegments) {
    throw new Error('The saved download checkpoint has inconsistent segment offsets.');
  }
  if (checkpoint.completedSegments > checkpoint.totalSegments) {
    throw new Error('The saved download checkpoint exceeds the playlist length.');
  }
  let previous = 0;
  for (const offset of checkpoint.segmentEndOffsets) {
    if (offset <= previous) throw new Error('The saved download checkpoint has invalid segment offsets.');
    previous = offset;
  }
  if ((checkpoint.segmentEndOffsets.at(-1) ?? 0) !== checkpoint.bytesWritten) {
    throw new Error('The saved download checkpoint has an inconsistent byte length.');
  }

  const completedSegments = checkpoint.segmentEndOffsets.filter((offset) => offset <= fileSize).length;
  const segmentEndOffsets = checkpoint.segmentEndOffsets.slice(0, completedSegments);
  return {
    completedSegments,
    bytesWritten: segmentEndOffsets.at(-1) ?? 0,
    segmentEndOffsets,
  };
}
