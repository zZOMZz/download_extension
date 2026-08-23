export type MediaOutputFormat = 'mp4' | 'ts';

export type OutputValidationErrorCode =
  | 'missing-output'
  | 'empty-output'
  | 'size-mismatch'
  | 'invalid-mp4'
  | 'missing-mp4-box'
  | 'missing-media-track'
  | 'missing-video-track'
  | 'invalid-transport-stream';

export class OutputValidationError extends Error {
  readonly code: OutputValidationErrorCode;

  constructor(code: OutputValidationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OutputValidationError';
    this.code = code;
  }
}

export interface OutputValidationOptions {
  format: MediaOutputFormat;
  expectedBytes?: number;
  requireVideo?: boolean;
}

export interface OutputValidationResult {
  format: MediaOutputFormat;
  size: number;
  videoTracks?: number;
  audioTracks?: number;
  durationSeconds?: number;
  fragmented?: boolean;
}

interface Mp4Box {
  type: string;
  start: number;
  contentStart: number;
  end: number;
}

const MP4_HEADER_BYTES = 16;
const MAX_BOXES_PER_LEVEL = 100_000;
const TS_SCAN_BYTES = 1024 * 1024;
const TS_PACKET_SIZES = [188, 192, 204] as const;

function fail(code: OutputValidationErrorCode, message: string, cause?: unknown): never {
  throw new OutputValidationError(code, message, cause === undefined ? undefined : { cause });
}

async function readBytes(blob: Blob, start: number, length: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

async function readMp4Box(blob: Blob, offset: number, parentEnd: number): Promise<Mp4Box> {
  if (parentEnd - offset < 8) {
    fail('invalid-mp4', `The MP4 output has an incomplete box header at byte ${offset}.`);
  }
  const bytes = await readBytes(blob, offset, Math.min(MP4_HEADER_BYTES, parentEnd - offset));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compactSize = view.getUint32(0);
  const type = ascii(bytes, 4, 4);
  let headerSize = 8;
  let size: number;
  if (compactSize === 1) {
    if (bytes.byteLength < MP4_HEADER_BYTES) {
      fail('invalid-mp4', `The MP4 output has an incomplete extended ${type} box header.`);
    }
    const extendedSize = view.getBigUint64(8);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail('invalid-mp4', `The MP4 output contains an unsupported ${type} box size.`);
    }
    headerSize = MP4_HEADER_BYTES;
    size = Number(extendedSize);
  } else if (compactSize === 0) {
    size = parentEnd - offset;
  } else {
    size = compactSize;
  }
  if (size < headerSize || offset + size > parentEnd) {
    fail('invalid-mp4', `The MP4 output contains a truncated or invalid ${type} box.`);
  }
  return {
    type,
    start: offset,
    contentStart: offset + headerSize,
    end: offset + size,
  };
}

async function listMp4Boxes(blob: Blob, start: number, end: number): Promise<Mp4Box[]> {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset < end) {
    if (boxes.length >= MAX_BOXES_PER_LEVEL) {
      fail('invalid-mp4', 'The MP4 output contains too many boxes to validate safely.');
    }
    const box = await readMp4Box(blob, offset, end);
    boxes.push(box);
    offset = box.end;
  }
  if (offset !== end) fail('invalid-mp4', 'The MP4 output box boundaries do not reach the end of the file.');
  return boxes;
}

async function movieDurationSeconds(blob: Blob, movie: Mp4Box): Promise<number | undefined> {
  const children = await listMp4Boxes(blob, movie.contentStart, movie.end);
  const header = children.find(({ type }) => type === 'mvhd');
  if (!header) return undefined;
  const bytes = await readBytes(blob, header.contentStart, Math.min(32, header.end - header.contentStart));
  if (bytes.byteLength < 20) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[0];
  if (version === 0) {
    const timescale = view.getUint32(12);
    return timescale === 0 ? undefined : view.getUint32(16) / timescale;
  }
  if (version === 1 && bytes.byteLength >= 32) {
    const timescale = view.getUint32(20);
    const duration = view.getBigUint64(24);
    return timescale === 0 ? undefined : Number(duration) / timescale;
  }
  return undefined;
}

async function movieTrackTypes(blob: Blob, movie: Mp4Box): Promise<string[]> {
  const children = await listMp4Boxes(blob, movie.contentStart, movie.end);
  const result: string[] = [];
  for (const track of children.filter(({ type }) => type === 'trak')) {
    const trackChildren = await listMp4Boxes(blob, track.contentStart, track.end);
    const media = trackChildren.find(({ type }) => type === 'mdia');
    if (!media) continue;
    const mediaChildren = await listMp4Boxes(blob, media.contentStart, media.end);
    const handler = mediaChildren.find(({ type }) => type === 'hdlr');
    if (!handler || handler.end - handler.contentStart < 12) continue;
    const bytes = await readBytes(blob, handler.contentStart, 12);
    result.push(ascii(bytes, 8, 4));
  }
  return result;
}

async function validateMp4(blob: Blob, requireVideo: boolean): Promise<OutputValidationResult> {
  let topLevel: Mp4Box[];
  try {
    topLevel = await listMp4Boxes(blob, 0, blob.size);
  } catch (cause) {
    if (cause instanceof OutputValidationError) throw cause;
    fail('invalid-mp4', 'The MP4 output could not be parsed.', cause);
  }
  const types = new Set(topLevel.map(({ type }) => type));
  if (!types.has('ftyp')) fail('missing-mp4-box', 'The MP4 output is missing its ftyp box.');
  if (!types.has('moov')) fail('missing-mp4-box', 'The MP4 output is missing its moov metadata box.');
  if (!types.has('mdat')) fail('missing-mp4-box', 'The MP4 output is missing media data.');

  const movie = topLevel.find(({ type }) => type === 'moov')!;
  const trackTypes = await movieTrackTypes(blob, movie);
  const videoTracks = trackTypes.filter((type) => type === 'vide').length;
  const audioTracks = trackTypes.filter((type) => type === 'soun').length;
  if (videoTracks + audioTracks === 0) {
    fail('missing-media-track', 'The MP4 output does not contain a playable audio or video track.');
  }
  if (requireVideo && videoTracks === 0) {
    fail('missing-video-track', 'The MP4 output does not contain a video track.');
  }

  const durationSeconds = await movieDurationSeconds(blob, movie);
  const fragmented = types.has('moof');
  if (!fragmented && (durationSeconds === undefined || durationSeconds <= 0)) {
    fail('invalid-mp4', 'The MP4 output does not contain a positive media duration.');
  }
  return {
    format: 'mp4',
    size: blob.size,
    videoTracks,
    audioTracks,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    fragmented,
  };
}

function hasTransportStreamSync(bytes: Uint8Array): boolean {
  for (const packetSize of TS_PACKET_SIZES) {
    const searchEnd = Math.min(bytes.byteLength, 64 * 1024);
    for (let start = 0; start < searchEnd; start += 1) {
      if (
        bytes[start] === 0x47 &&
        bytes[start + packetSize] === 0x47 &&
        bytes[start + packetSize * 2] === 0x47
      ) return true;
    }
  }
  return false;
}

async function validateTransportStream(blob: Blob): Promise<OutputValidationResult> {
  const bytes = await readBytes(blob, 0, Math.min(TS_SCAN_BYTES, blob.size));
  if (!hasTransportStreamSync(bytes)) {
    fail('invalid-transport-stream', 'The transport-stream output does not contain a valid packet sync pattern.');
  }
  return { format: 'ts', size: blob.size };
}

export async function validateMediaOutput(
  blob: Blob | null,
  options: OutputValidationOptions,
): Promise<OutputValidationResult> {
  if (!blob) fail('missing-output', 'The final output file is missing.');
  if (blob.size === 0) fail('empty-output', 'The final output file is empty.');
  if (options.expectedBytes !== undefined && blob.size !== options.expectedBytes) {
    fail(
      'size-mismatch',
      `The final output size does not match the completed download (${blob.size} != ${options.expectedBytes}).`,
    );
  }
  return options.format === 'mp4'
    ? validateMp4(blob, options.requireVideo ?? true)
    : validateTransportStream(blob);
}
