declare module 'mux.js' {
  interface TransmuxedSegment {
    type: 'combined' | 'audio' | 'video';
    initSegment: Uint8Array;
    data: Uint8Array;
  }

  interface SegmentTimingInfo {
    start: { dts: number; pts: number };
    end: { dts: number; pts: number };
    prependedContentDuration: number;
    baseMediaDecodeTime: number;
  }

  interface TransmuxerOptions {
    baseMediaDecodeTime?: number;
    keepOriginalTimestamps?: boolean;
    remux?: boolean;
  }

  type TransmuxerEvent = 'data' | 'done' | 'videoSegmentTimingInfo' | 'audioSegmentTimingInfo';

  class Transmuxer {
    constructor(options?: TransmuxerOptions);
    on(event: 'data', listener: (segment: TransmuxedSegment) => void): void;
    on(event: 'done', listener: () => void): void;
    on(
      event: 'videoSegmentTimingInfo' | 'audioSegmentTimingInfo',
      listener: (timing: SegmentTimingInfo) => void,
    ): void;
    off(event: TransmuxerEvent): void;
    push(data: Uint8Array): void;
    flush(): void;
    reset(): void;
  }

  const muxjs: {
    mp4: {
      Transmuxer: typeof Transmuxer;
    };
  };

  export default muxjs;
}
