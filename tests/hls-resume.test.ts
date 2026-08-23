import { describe, expect, it } from 'vitest';
import {
  checkpointMatchesDirectory,
  hlsPlaylistFingerprint,
  reconcileCheckpointFile,
} from '../src/core/hls/resume';
import { parseHlsPlaylist } from '../src/core/protocols/hls';
import type { DownloadCheckpoint } from '../src/shared/download-task';

function playlist(url: string) {
  const parsed = parseHlsPlaylist(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:20
#EXTINF:4,
one.ts?sign=old
#EXTINF:4,
two.ts?sign=old
#EXT-X-ENDLIST`, url);
  if (parsed.type !== 'media') throw new Error('Expected a media playlist.');
  return parsed;
}

describe('HLS resume metadata', () => {
  it('keeps the playlist identity stable when only signed query parameters change', () => {
    const first = playlist('https://cdn.example/show/index.m3u8?token=one');
    const second = playlist('https://cdn.example/show/index.m3u8?token=two');
    second.segments[0]!.uri = second.segments[0]!.uri.replace('sign=old', 'sign=fresh');
    second.segments[1]!.uri = second.segments[1]!.uri.replace('sign=old', 'sign=fresh');
    expect(hlsPlaylistFingerprint(first)).toBe(hlsPlaylistFingerprint(second));
    expect(hlsPlaylistFingerprint(first)).toBe('hls-v1:20:2:97b20c30');
  });

  it('rolls back to the last segment boundary present in the committed file', () => {
    const checkpoint: DownloadCheckpoint = {
      version: 1,
      playlistFingerprint: 'test',
      directoryName: 'Downloads',
      directoryHandleId: 'directory-1',
      partialFilename: 'video.part.ts',
      finalFilename: 'video.mp4',
      completedSegments: 3,
      totalSegments: 4,
      bytesWritten: 300,
      segmentEndOffsets: [100, 200, 300],
      updatedAt: 1,
    };
    expect(reconcileCheckpointFile(checkpoint, 250)).toEqual({
      completedSegments: 2,
      bytesWritten: 200,
      segmentEndOffsets: [100, 200],
    });
  });

  it('uses the persisted handle identity for new checkpoints and folder names for legacy checkpoints', () => {
    const checkpoint: DownloadCheckpoint = {
      version: 1,
      playlistFingerprint: 'test',
      directoryName: 'Downloads',
      directoryHandleId: 'original-directory',
      partialFilename: 'video.part.ts',
      finalFilename: 'video.mp4',
      completedSegments: 1,
      totalSegments: 2,
      bytesWritten: 100,
      segmentEndOffsets: [100],
      updatedAt: 1,
    };
    expect(checkpointMatchesDirectory(checkpoint, {
      name: 'Downloads',
      handleId: 'original-directory',
    })).toBe(true);
    expect(checkpointMatchesDirectory(checkpoint, {
      name: 'Downloads',
      handleId: 'different-directory',
    })).toBe(false);

    const legacy = { ...checkpoint };
    delete legacy.directoryHandleId;
    expect(checkpointMatchesDirectory(legacy, { name: 'Downloads' })).toBe(true);
  });
});
