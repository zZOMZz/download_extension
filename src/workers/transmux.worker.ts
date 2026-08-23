/// <reference lib="webworker" />

import muxjs from 'mux.js';

interface TransmuxRequest {
  type: 'transmux';
  id: number;
  data: ArrayBuffer;
  separateTimeline: boolean;
}

interface TransmuxOutput {
  mediaType: 'combined' | 'audio' | 'video';
  initializationSegment?: ArrayBuffer;
  data: ArrayBuffer;
}

interface TransmuxSuccess {
  type: 'result';
  id: number;
  outputs: TransmuxOutput[];
}

interface TransmuxFailure {
  type: 'error';
  id: number;
  message: string;
}

const scope = self as DedicatedWorkerGlobalScope;
let transmuxer: InstanceType<typeof muxjs.mp4.Transmuxer> | null = null;
let separateTimeline: boolean | null = null;
let activeRequestId: number | null = null;
let outputs: TransmuxOutput[] = [];
const initializedMediaTypes = new Set<TransmuxOutput['mediaType']>();

function createTransmuxer(useSeparateTimeline: boolean): InstanceType<typeof muxjs.mp4.Transmuxer> {
  const instance = new muxjs.mp4.Transmuxer(useSeparateTimeline
    ? { remux: false, keepOriginalTimestamps: true }
    : undefined);
  instance.on('data', (segment) => {
    const initializationSegment = initializedMediaTypes.has(segment.type)
      ? undefined
      : segment.initSegment.slice().buffer as ArrayBuffer;
    initializedMediaTypes.add(segment.type);
    outputs.push({
      mediaType: segment.type,
      ...(initializationSegment ? { initializationSegment } : {}),
      data: segment.data.slice().buffer as ArrayBuffer,
    });
  });
  instance.on('done', () => {
    if (activeRequestId === null) return;
    const response: TransmuxSuccess = { type: 'result', id: activeRequestId, outputs };
    const transfers = outputs.flatMap((output) => [
      ...(output.initializationSegment ? [output.initializationSegment] : []),
      output.data,
    ]);
    scope.postMessage(response, { transfer: transfers });
    activeRequestId = null;
    outputs = [];
  });
  return instance;
}

scope.addEventListener('message', (event: MessageEvent<TransmuxRequest>) => {
  if (event.data.type !== 'transmux') return;
  if (separateTimeline !== null && separateTimeline !== event.data.separateTimeline) {
    scope.postMessage({
      type: 'error',
      id: event.data.id,
      message: 'The MPEG-TS worker mode cannot change after initialization.',
    } satisfies TransmuxFailure);
    return;
  }
  if (!transmuxer) {
    separateTimeline = event.data.separateTimeline;
    transmuxer = createTransmuxer(event.data.separateTimeline);
  }
  activeRequestId = event.data.id;
  outputs = [];
  try {
    transmuxer.push(new Uint8Array(event.data.data));
    transmuxer.flush();
  } catch (cause) {
    const response: TransmuxFailure = {
      type: 'error',
      id: event.data.id,
      message: cause instanceof Error ? cause.message : 'The MPEG-TS segment could not be remuxed.',
    };
    scope.postMessage(response);
    activeRequestId = null;
    outputs = [];
    transmuxer.reset();
  }
});
