import { describe, expect, it, vi } from 'vitest';
import {
  preferYouTubeMp4MediaCapabilities,
  preferYouTubeMp4MediaElement,
  preferYouTubeMp4MediaSource,
  shouldSuppressYouTubePlaybackType,
} from '../src/core/site-adapters/youtube/playback-preference';

describe('YouTube playback preference', () => {
  it('suppresses containers and codecs that the MP4 output pipeline cannot merge', () => {
    expect(shouldSuppressYouTubePlaybackType('video/webm; codecs="vp9"')).toBe(true);
    expect(shouldSuppressYouTubePlaybackType('audio/webm; codecs="opus"')).toBe(true);
    expect(shouldSuppressYouTubePlaybackType('video/mp4; codecs="av01.0.08M.08"')).toBe(true);
    expect(shouldSuppressYouTubePlaybackType('video/mp4; codecs="avc1.640028"')).toBe(false);
    expect(shouldSuppressYouTubePlaybackType('audio/mp4; codecs="mp4a.40.2"')).toBe(false);
  });

  it('masks incompatible MediaSource support and can restore the native function', () => {
    const native = vi.fn((_type: string) => true);
    const mediaSource = { isTypeSupported: native };
    const restore = preferYouTubeMp4MediaSource(mediaSource);

    expect(mediaSource.isTypeSupported('video/webm; codecs="vp9"')).toBe(false);
    expect(mediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"')).toBe(true);
    expect(native).toHaveBeenCalledTimes(1);

    restore();
    expect(mediaSource.isTypeSupported).toBe(native);
  });

  it('masks incompatible MediaCapabilities results used for codec selection', async () => {
    const supported = { powerEfficient: true, smooth: true, supported: true };
    const native = vi.fn(async (_configuration: {
      audio?: { contentType?: string };
      video?: { contentType?: string };
    }) => supported);
    const mediaCapabilities = { decodingInfo: native };
    const restore = preferYouTubeMp4MediaCapabilities(mediaCapabilities);

    await expect(mediaCapabilities.decodingInfo({
      video: { contentType: 'video/mp4; codecs="av01.0.08M.08"' },
    })).resolves.toEqual({ powerEfficient: false, smooth: false, supported: false });
    await expect(mediaCapabilities.decodingInfo({
      video: { contentType: 'video/mp4; codecs="avc1.640028"' },
    })).resolves.toEqual(supported);
    expect(native).toHaveBeenCalledTimes(1);

    restore();
    expect(mediaCapabilities.decodingInfo).toBe(native);
  });

  it('masks incompatible media element support without changing compatible results', () => {
    const native = vi.fn((_type: string): CanPlayTypeResult => 'probably');
    const mediaElement = { canPlayType: native };
    const restore = preferYouTubeMp4MediaElement(mediaElement);

    expect(mediaElement.canPlayType('audio/webm; codecs="opus"')).toBe('');
    expect(mediaElement.canPlayType('audio/mp4; codecs="mp4a.40.2"')).toBe('probably');
    expect(native).toHaveBeenCalledTimes(1);

    restore();
    expect(mediaElement.canPlayType).toBe(native);
  });
});
