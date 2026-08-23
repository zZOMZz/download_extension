/// <reference lib="webworker" />

import muxjs from 'mux.js';

interface TransmuxRequest {
  type: 'transmux';
  id: number;
  data: ArrayBuffer;
}

interface TransmuxSuccess {
  type: 'result';
  id: number;
  initializationSegment?: ArrayBuffer;
  chunks: ArrayBuffer[];
}

interface TransmuxFailure {
  type: 'error';
  id: number;
  message: string;
}

const scope = self as DedicatedWorkerGlobalScope;
const transmuxer = new muxjs.mp4.Transmuxer();
let activeRequestId: number | null = null;
let outputChunks: ArrayBuffer[] = [];
let wroteInitializationSegment = false;
let pendingInitializationSegment: ArrayBuffer | undefined;

transmuxer.on('data', (segment) => {
  if (!wroteInitializationSegment) {
    pendingInitializationSegment = segment.initSegment.slice().buffer as ArrayBuffer;
    wroteInitializationSegment = true;
  }
  outputChunks.push(segment.data.slice().buffer as ArrayBuffer);
});

transmuxer.on('done', () => {
  if (activeRequestId === null) return;
  const response: TransmuxSuccess = {
    type: 'result',
    id: activeRequestId,
    ...(pendingInitializationSegment ? { initializationSegment: pendingInitializationSegment } : {}),
    chunks: outputChunks,
  };
  const transfers = pendingInitializationSegment
    ? [pendingInitializationSegment, ...outputChunks]
    : outputChunks;
  scope.postMessage(response, { transfer: transfers });
  activeRequestId = null;
  outputChunks = [];
  pendingInitializationSegment = undefined;
});

scope.addEventListener('message', (event: MessageEvent<TransmuxRequest>) => {
  if (event.data.type !== 'transmux') return;
  activeRequestId = event.data.id;
  outputChunks = [];
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
    outputChunks = [];
    transmuxer.reset();
  }
});
