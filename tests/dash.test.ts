import { describe, expect, it } from 'vitest';
import { parseDashManifest } from '../src/core/protocols/dash';

describe('DASH parser', () => {
  it('summarizes representations and inherited attributes', () => {
    const result = parseDashManifest(`<?xml version="1.0"?>
      <MPD type="static" mediaPresentationDuration="PT60S">
        <Period>
          <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.4d401f">
            <Representation id="video-720" bandwidth="1500000" width="1280" height="720" />
          </AdaptationSet>
          <AdaptationSet contentType="audio" mimeType="audio/mp4">
            <Representation id="audio" bandwidth="128000" codecs="mp4a.40.2" />
          </AdaptationSet>
        </Period>
      </MPD>`);

    expect(result).toEqual({
      type: 'static',
      duration: 'PT60S',
      hasContentProtection: false,
      representations: [
        {
          id: 'video-720',
          bandwidth: 1_500_000,
          contentType: 'video',
          mimeType: 'video/mp4',
          codecs: 'avc1.4d401f',
          width: 1280,
          height: 720,
        },
        {
          id: 'audio',
          bandwidth: 128_000,
          contentType: 'audio',
          mimeType: 'audio/mp4',
          codecs: 'mp4a.40.2',
        },
      ],
    });
  });

  it('detects content protection anywhere in the MPD', () => {
    const result = parseDashManifest(`
      <MPD type="dynamic">
        <Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:test" /></AdaptationSet></Period>
      </MPD>`);
    expect(result.type).toBe('dynamic');
    expect(result.hasContentProtection).toBe(true);
  });

  it('rejects non-MPD XML', () => {
    expect(() => parseDashManifest('<html />')).toThrow(/not a DASH/i);
  });
});
