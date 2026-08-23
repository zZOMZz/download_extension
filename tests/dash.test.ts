import { describe, expect, it } from 'vitest';
import { parseDashManifest, parseDashMediaSource } from '../src/core/protocols/dash';

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

  it('expands inherited SegmentTemplate timelines into downloadable tracks', () => {
    const source = parseDashMediaSource(`<?xml version="1.0"?>
      <MPD type="static" mediaPresentationDuration="PT12S">
        <BaseURL>media/</BaseURL>
        <Period>
          <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f">
            <SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number%03d$.m4s" startNumber="5">
              <SegmentTimeline><S t="0" d="4000" r="2" /></SegmentTimeline>
            </SegmentTemplate>
            <Representation id="v1080" bandwidth="4000000" width="1920" height="1080" />
          </AdaptationSet>
        </Period>
      </MPD>`, 'https://cdn.example/show/manifest.mpd');

    expect(source).toMatchObject({
      type: 'static',
      durationSeconds: 12,
      hasContentProtection: false,
    });
    expect(source.tracks[0]).toMatchObject({
      id: 'v1080',
      kind: 'video',
      initialization: { url: 'https://cdn.example/show/media/v1080/init.mp4' },
      segments: [
        { url: 'https://cdn.example/show/media/v1080/005.m4s' },
        { url: 'https://cdn.example/show/media/v1080/006.m4s' },
        { url: 'https://cdn.example/show/media/v1080/007.m4s' },
      ],
    });
  });

  it('parses SegmentBase byte ranges used by single-file DASH tracks', () => {
    const source = parseDashMediaSource(`<MPD type="static" mediaPresentationDuration="PT10S">
      <Period>
        <AdaptationSet contentType="video" mimeType="video/mp4">
          <Representation id="80" bandwidth="3000000" codecs="avc1.640032" width="1920" height="1080">
            <BaseURL>https://cdn.example/video.m4s</BaseURL>
            <SegmentBase indexRange="1000-1199">
              <Initialization range="0-999" />
            </SegmentBase>
          </Representation>
        </AdaptationSet>
      </Period>
    </MPD>`, 'https://www.example/watch/manifest.mpd');

    expect(source.tracks[0]).toMatchObject({
      id: '80',
      kind: 'video',
      initialization: {
        url: 'https://cdn.example/video.m4s',
        byteRange: { offset: 0, length: 1000 },
      },
      index: {
        url: 'https://cdn.example/video.m4s',
        byteRange: { offset: 1000, length: 200 },
      },
    });
  });

  it('rejects multi-period manifests instead of silently downloading only one period', () => {
    expect(() => parseDashMediaSource(`<MPD type="static" mediaPresentationDuration="PT20S">
      <Period duration="PT10S" /><Period duration="PT10S" />
    </MPD>`, 'https://cdn.example/manifest.mpd')).toThrow(/multi-period/i);
  });
});
