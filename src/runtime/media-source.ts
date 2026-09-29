import type { BrowserSourcePlan, BrowserSourceTarget, ProcessedSegment } from '../shared/browser-source';

/** Ephemeral host capability. Persist source identity/checkpoints, never this session or SDK context. */
export interface MediaSourceSession {
  readonly plan: BrowserSourcePlan;
  process(index: number, onProgress: (bytes: number, phase: 'requesting' | 'downloading' | 'processing') => void, signal: AbortSignal): Promise<ProcessedSegment>;
  read(track: 'audio' | 'video', part: 'initialization' | 'media', offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
  acknowledge(index: number, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface MediaSourceProvider {
  open(target: BrowserSourceTarget, startIndex: number, signal: AbortSignal, options?: { fresh?: boolean }): Promise<MediaSourceSession>;
}
