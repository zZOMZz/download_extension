import { describe, expect, it } from 'vitest';
import {
  dashPlanFingerprint,
  reconcileDashTrackFile,
} from '../src/core/dash/resume';
import type { DashDownloadPlan } from '../src/core/dash/download-dash';
import type { DashTrackCheckpoint } from '../src/shared/download-task';

function plan(token: string): DashDownloadPlan {
  return {
    video: {
      id: 'video-1080',
      kind: 'video',
      codecs: 'avc1.640028',
      height: 1080,
      initialization: { url: `https://video.example/show/init.m4s?token=${token}` },
      segments: [
        { url: `https://video.example/show/media.m4s?token=${token}`, byteRange: { offset: 100, length: 20 } },
        { url: `https://video.example/show/media.m4s?token=${token}`, byteRange: { offset: 120, length: 30 } },
      ],
    },
    audio: {
      id: 'audio-aac',
      kind: 'audio',
      codecs: 'mp4a.40.2',
      initialization: { url: `https://audio.example/show/init.m4s?token=${token}` },
      segments: [
        { url: `https://audio.example/show/media.m4s?token=${token}`, byteRange: { offset: 80, length: 15 } },
      ],
    },
    totalSegments: 3,
  };
}

describe('DASH resume metadata', () => {
  it('keeps plan identity stable when only hosts and signed query values change', () => {
    const refreshed = plan('fresh');
    refreshed.video.initialization.url = 'https://backup.example/show/init.m4s?token=fresh';
    refreshed.video.segments.forEach((resource) => {
      resource.url = resource.url.replace('video.example', 'backup.example');
    });
    expect(dashPlanFingerprint(plan('old'))).toBe(dashPlanFingerprint(refreshed));

    refreshed.video.segments[0]!.byteRange = { offset: 101, length: 20 };
    expect(dashPlanFingerprint(plan('old'))).not.toBe(dashPlanFingerprint(refreshed));
  });

  it('rolls a track back to its last complete fragment boundary', () => {
    const checkpoint: DashTrackCheckpoint = {
      trackId: 'video',
      fingerprint: 'dash-track-v1:test',
      partialFilename: 'episode.video.part.m4s',
      initializationBytes: 50,
      completedSegments: 3,
      totalSegments: 4,
      bytesWritten: 350,
      segmentEndOffsets: [150, 250, 350],
    };
    expect(reconcileDashTrackFile(checkpoint, 280)).toEqual({
      initializationBytes: 50,
      completedSegments: 2,
      bytesWritten: 250,
      segmentEndOffsets: [150, 250],
    });
    expect(reconcileDashTrackFile(checkpoint, 20)).toEqual({
      initializationBytes: 0,
      completedSegments: 0,
      bytesWritten: 0,
      segmentEndOffsets: [],
    });
  });
});
