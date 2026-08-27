const WEBM_MIME_TYPE = /^(?:audio|video)\/webm(?:\s*;|$)/i;
const INCOMPATIBLE_CODEC = /(?:^|[\s"',;=])(?:av01|opus|vp0?8|vp0?9|vorbis)(?:[.\s"',;]|$)/i;

export function shouldSuppressYouTubePlaybackType(rawType: string): boolean {
  const type = rawType.trim();
  return WEBM_MIME_TYPE.test(type) || INCOMPATIBLE_CODEC.test(type);
}

interface MediaDecodingConfigurationLike {
  audio?: { contentType?: string };
  video?: { contentType?: string };
}

interface MediaDecodingInfoLike {
  powerEfficient: boolean;
  smooth: boolean;
  supported: boolean;
}

interface MediaCapabilitiesTypeSupport {
  decodingInfo(configuration: MediaDecodingConfigurationLike): Promise<MediaDecodingInfoLike>;
}

interface MediaSourceTypeSupport {
  isTypeSupported(type: string): boolean;
}

interface MediaElementTypeSupport {
  canPlayType(type: string): CanPlayTypeResult;
}

export function preferYouTubeMp4MediaCapabilities(
  target: MediaCapabilitiesTypeSupport | undefined,
): () => void {
  if (!target || typeof target.decodingInfo !== 'function') return () => {};

  const original = target.decodingInfo;
  const preferred = function (
    this: MediaCapabilitiesTypeSupport,
    configuration: MediaDecodingConfigurationLike,
  ): Promise<MediaDecodingInfoLike> {
    const contentTypes = [configuration.video?.contentType, configuration.audio?.contentType];
    if (contentTypes.some((type) => type && shouldSuppressYouTubePlaybackType(type))) {
      return Promise.resolve({ powerEfficient: false, smooth: false, supported: false });
    }
    return original.call(this, configuration);
  };
  try {
    target.decodingInfo = preferred;
  } catch {
    return () => {};
  }

  return () => {
    if (target.decodingInfo === preferred) target.decodingInfo = original;
  };
}

export function preferYouTubeMp4MediaSource(
  target: MediaSourceTypeSupport | undefined,
): () => void {
  if (!target || typeof target.isTypeSupported !== 'function') return () => {};

  const original = target.isTypeSupported;
  const preferred = (type: string): boolean =>
    !shouldSuppressYouTubePlaybackType(type) && original.call(target, type);
  try {
    target.isTypeSupported = preferred;
  } catch {
    return () => {};
  }

  return () => {
    if (target.isTypeSupported === preferred) target.isTypeSupported = original;
  };
}

export function preferYouTubeMp4MediaElement(
  target: MediaElementTypeSupport | undefined,
): () => void {
  if (!target || typeof target.canPlayType !== 'function') return () => {};

  const original = target.canPlayType;
  const preferred = function (this: MediaElementTypeSupport, type: string): CanPlayTypeResult {
    return shouldSuppressYouTubePlaybackType(type) ? '' : original.call(this, type);
  };
  try {
    target.canPlayType = preferred;
  } catch {
    return () => {};
  }

  return () => {
    if (target.canPlayType === preferred) target.canPlayType = original;
  };
}
