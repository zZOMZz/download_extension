import type { DashDownloadPlan, ResolvedDashTrack } from './download-dash';
import type { DashTrackCheckpoint } from '../../shared/download-task';

function stableResourcePath(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl.split('?', 1)[0] ?? rawUrl;
  }
}

function resourceIdentity(resource: ResolvedDashTrack['initialization']): string {
  return [
    stableResourcePath(resource.url),
    resource.byteRange?.offset ?? '',
    resource.byteRange?.length ?? '',
  ].join(':');
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function dashTrackFingerprint(track: ResolvedDashTrack): string {
  const identity = [
    track.id,
    track.kind,
    track.codecs ?? '',
    track.width ?? '',
    track.height ?? '',
    resourceIdentity(track.initialization),
    ...track.segments.map(resourceIdentity),
  ].join('|');
  return `dash-track-v1:${track.segments.length}:${fnv1a(identity)}`;
}

export function dashPlanFingerprint(plan: DashDownloadPlan): string {
  return `dash-plan-v1:${dashTrackFingerprint(plan.video)}:${dashTrackFingerprint(plan.audio)}`;
}

export interface ReconciledDashTrackPosition {
  initializationBytes: number;
  completedSegments: number;
  bytesWritten: number;
  segmentEndOffsets: number[];
}

export function reconcileDashTrackFile(
  checkpoint: DashTrackCheckpoint,
  fileSize: number,
): ReconciledDashTrackPosition {
  if (checkpoint.segmentEndOffsets.length !== checkpoint.completedSegments) {
    throw new Error('The saved DASH checkpoint has inconsistent segment offsets.');
  }
  if (checkpoint.completedSegments > checkpoint.totalSegments) {
    throw new Error('The saved DASH checkpoint exceeds the track length.');
  }
  if (checkpoint.initializationBytes === 0) {
    if (checkpoint.completedSegments !== 0 || checkpoint.bytesWritten !== 0) {
      throw new Error('The saved DASH checkpoint is missing its initialization boundary.');
    }
    return {
      initializationBytes: 0,
      completedSegments: 0,
      bytesWritten: 0,
      segmentEndOffsets: [],
    };
  }

  let previous = checkpoint.initializationBytes;
  for (const offset of checkpoint.segmentEndOffsets) {
    if (offset <= previous) {
      throw new Error('The saved DASH checkpoint has invalid segment offsets.');
    }
    previous = offset;
  }
  if ((checkpoint.segmentEndOffsets.at(-1) ?? checkpoint.initializationBytes) !== checkpoint.bytesWritten) {
    throw new Error('The saved DASH checkpoint has an inconsistent byte length.');
  }
  if (fileSize < checkpoint.initializationBytes) {
    return {
      initializationBytes: 0,
      completedSegments: 0,
      bytesWritten: 0,
      segmentEndOffsets: [],
    };
  }

  const completedSegments = checkpoint.segmentEndOffsets.filter((offset) => offset <= fileSize).length;
  const segmentEndOffsets = checkpoint.segmentEndOffsets.slice(0, completedSegments);
  return {
    initializationBytes: checkpoint.initializationBytes,
    completedSegments,
    bytesWritten: segmentEndOffsets.at(-1) ?? checkpoint.initializationBytes,
    segmentEndOffsets,
  };
}
