import type { RandomAccessBinaryWriter } from '../hls/download-hls';

interface ParsedBox {
  type: string;
  start: number;
  contentStart: number;
  end: number;
}

interface TrackSample {
  duration: number;
  size: number;
  compositionOffset: number;
  isSync: boolean;
}

interface TrackChunk {
  offset: number;
  sampleCount: number;
}

interface TrackState {
  sourceId: string;
  type: string;
  timescale: number;
  sourceTrack: Uint8Array;
  samples: TrackSample[];
  chunks: TrackChunk[];
  firstDecodeTime?: number;
  decodeDuration: number;
  presentationEnd: number;
}

interface TrackFragmentDefaults {
  trackId: number;
  duration: number;
  size: number;
  flags: number;
}

interface ParsedTrackRun {
  dataOffset?: number;
  samples: TrackSample[];
}

const UINT32_MAX = 0xffff_ffff;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function parseBoxes(bytes: Uint8Array, start = 0, end = bytes.byteLength): ParsedBox[] {
  const view = viewOf(bytes);
  const boxes: ParsedBox[] = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw new Error('The MP4 data ends with an incomplete box.');
    const compactSize = view.getUint32(offset);
    let size = compactSize;
    let headerSize = 8;
    if (compactSize === 1) {
      if (offset + 16 > end) throw new Error('The MP4 data ends with an incomplete extended-size box.');
      const extendedSize = view.getBigUint64(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('An MP4 box is too large to process.');
      size = Number(extendedSize);
      headerSize = 16;
    } else if (compactSize === 0) {
      size = end - offset;
    }
    const type = readType(bytes, offset + 4);
    if (size < headerSize || offset + size > end) throw new Error(`The MP4 ${type} box has an invalid size.`);
    boxes.push({ type, start: offset, contentStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

function childBoxes(bytes: Uint8Array, parent: ParsedBox): ParsedBox[] {
  return parseBoxes(bytes, parent.contentStart, parent.end);
}

function requiredBox(boxes: readonly ParsedBox[], type: string): ParsedBox {
  const box = boxes.find((candidate) => candidate.type === type);
  if (!box) throw new Error(`The MP4 data is missing its ${type} box.`);
  return box;
}

function sliceBox(bytes: Uint8Array, box: ParsedBox): Uint8Array {
  return bytes.slice(box.start, box.end);
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function typeBytes(type: string): Uint8Array {
  if (type.length !== 4) throw new Error(`Invalid MP4 box type: ${type}`);
  return Uint8Array.from(type, (character) => character.charCodeAt(0));
}

function makeBox(type: string, ...contents: readonly Uint8Array[]): Uint8Array {
  const size = 8 + contents.reduce((sum, content) => sum + content.byteLength, 0);
  if (size > UINT32_MAX) throw new Error(`The generated MP4 ${type} box is too large.`);
  const result = new Uint8Array(size);
  const view = viewOf(result);
  view.setUint32(0, size);
  result.set(typeBytes(type), 4);
  let offset = 8;
  for (const content of contents) {
    result.set(content, offset);
    offset += content.byteLength;
  }
  return result;
}

function fullBox(type: string, version: number, flags: number, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = version;
  header[1] = (flags >>> 16) & 0xff;
  header[2] = (flags >>> 8) & 0xff;
  header[3] = flags & 0xff;
  return makeBox(type, header, payload);
}

function uint32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) throw new Error('An MP4 uint32 value is out of range.');
  const result = new Uint8Array(4);
  viewOf(result).setUint32(0, value);
  return result;
}

function int32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    throw new Error('An MP4 int32 value is out of range.');
  }
  const result = new Uint8Array(4);
  viewOf(result).setInt32(0, value);
  return result;
}

function uint64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('An MP4 uint64 value is out of range.');
  const result = new Uint8Array(8);
  viewOf(result).setBigUint64(0, BigInt(value));
  return result;
}

function patchFullBoxDuration(source: Uint8Array, type: string, duration: number): Uint8Array {
  const result = source.slice();
  const box = requiredBox(parseBoxes(result), type);
  const view = viewOf(result);
  const version = view.getUint8(box.contentStart);
  if (version !== 0 && version !== 1) throw new Error(`Unsupported MP4 ${type} version: ${version}.`);
  const offset = box.contentStart + (type === 'tkhd' ? (version === 1 ? 28 : 20) : (version === 1 ? 24 : 16));
  if (version === 1) {
    view.setBigUint64(offset, BigInt(Math.ceil(duration)));
  } else {
    if (duration >= UINT32_MAX) throw new Error(`The MP4 ${type} duration is too large.`);
    view.setUint32(offset, Math.ceil(duration));
  }
  return result;
}

function trackIdFromHeader(bytes: Uint8Array, trackHeader: ParsedBox): number {
  const view = viewOf(bytes);
  const version = view.getUint8(trackHeader.contentStart);
  if (version !== 0 && version !== 1) throw new Error(`Unsupported MP4 track header version: ${version}.`);
  return view.getUint32(trackHeader.contentStart + (version === 1 ? 20 : 12));
}

function patchTrackId(sourceTrack: Uint8Array, trackId: number): Uint8Array {
  const result = sourceTrack.slice();
  const track = requiredBox(parseBoxes(result), 'trak');
  const header = requiredBox(childBoxes(result, track), 'tkhd');
  const view = viewOf(result);
  const version = view.getUint8(header.contentStart);
  if (version !== 0 && version !== 1) throw new Error(`Unsupported MP4 track header version: ${version}.`);
  view.setUint32(header.contentStart + (version === 1 ? 20 : 12), trackId);
  return result;
}

function timescaleFromMediaHeader(bytes: Uint8Array, mediaHeader: ParsedBox): number {
  const view = viewOf(bytes);
  const version = view.getUint8(mediaHeader.contentStart);
  if (version !== 0 && version !== 1) throw new Error(`Unsupported MP4 media header version: ${version}.`);
  const timescale = view.getUint32(mediaHeader.contentStart + (version === 1 ? 20 : 12));
  if (timescale === 0) throw new Error('The MP4 media timescale is invalid.');
  return timescale;
}

function handlerType(bytes: Uint8Array, handler: ParsedBox): string {
  if (handler.contentStart + 12 > handler.end) throw new Error('The MP4 handler box is truncated.');
  return readType(bytes, handler.contentStart + 8);
}

function parseTrackFragmentDefaults(bytes: Uint8Array, header: ParsedBox): TrackFragmentDefaults {
  const view = viewOf(bytes);
  const flags = (view.getUint8(header.contentStart + 1) << 16) |
    (view.getUint8(header.contentStart + 2) << 8) |
    view.getUint8(header.contentStart + 3);
  let offset = header.contentStart + 4;
  const trackId = view.getUint32(offset);
  offset += 4;
  if (flags & 0x000001) offset += 8;
  if (flags & 0x000002) offset += 4;
  let duration = 0;
  let size = 0;
  let sampleFlags = 0;
  if (flags & 0x000008) {
    duration = view.getUint32(offset);
    offset += 4;
  }
  if (flags & 0x000010) {
    size = view.getUint32(offset);
    offset += 4;
  }
  if (flags & 0x000020) sampleFlags = view.getUint32(offset);
  return { trackId, duration, size, flags: sampleFlags };
}

function decodeTime(bytes: Uint8Array, decodeTimeBox: ParsedBox): number {
  const view = viewOf(bytes);
  const version = view.getUint8(decodeTimeBox.contentStart);
  const offset = decodeTimeBox.contentStart + 4;
  const value = version === 1 ? view.getBigUint64(offset) : BigInt(view.getUint32(offset));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The MP4 decode timestamp is too large.');
  return Number(value);
}

function parseTrackRun(
  bytes: Uint8Array,
  run: ParsedBox,
  defaults: TrackFragmentDefaults,
): ParsedTrackRun {
  const view = viewOf(bytes);
  const version = view.getUint8(run.contentStart);
  const flags = (view.getUint8(run.contentStart + 1) << 16) |
    (view.getUint8(run.contentStart + 2) << 8) |
    view.getUint8(run.contentStart + 3);
  let offset = run.contentStart + 4;
  const sampleCount = view.getUint32(offset);
  offset += 4;
  let dataOffset: number | undefined;
  if (flags & 0x000001) {
    dataOffset = view.getInt32(offset);
    offset += 4;
  }
  let firstSampleFlags: number | undefined;
  if (flags & 0x000004) {
    firstSampleFlags = view.getUint32(offset);
    offset += 4;
  }

  const samples: TrackSample[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const duration = flags & 0x000100 ? view.getUint32(offset) : defaults.duration;
    if (flags & 0x000100) offset += 4;
    const size = flags & 0x000200 ? view.getUint32(offset) : defaults.size;
    if (flags & 0x000200) offset += 4;
    let sampleFlags = index === 0 && firstSampleFlags !== undefined ? firstSampleFlags : defaults.flags;
    if (flags & 0x000400) {
      sampleFlags = view.getUint32(offset);
      offset += 4;
    }
    let compositionOffset = 0;
    if (flags & 0x000800) {
      compositionOffset = version === 1 ? view.getInt32(offset) : view.getUint32(offset);
      offset += 4;
    }
    if (duration === 0 || size === 0) throw new Error('An MP4 fragment contains a sample without a duration or size.');
    samples.push({
      duration,
      size,
      compositionOffset,
      isSync: (sampleFlags & 0x0001_0000) === 0,
    });
  }
  if (offset > run.end) throw new Error('The MP4 track run is truncated.');
  return { ...(dataOffset !== undefined ? { dataOffset } : {}), samples };
}

function runLengthEntries(values: readonly number[]): Array<{ count: number; value: number }> {
  const entries: Array<{ count: number; value: number }> = [];
  for (const value of values) {
    const current = entries.at(-1);
    if (current?.value === value) current.count += 1;
    else entries.push({ count: 1, value });
  }
  return entries;
}

function buildTimeToSample(samples: readonly TrackSample[]): Uint8Array {
  const entries = runLengthEntries(samples.map(({ duration }) => duration));
  const payload = new Uint8Array(4 + entries.length * 8);
  const view = viewOf(payload);
  view.setUint32(0, entries.length);
  entries.forEach((entry, index) => {
    view.setUint32(4 + index * 8, entry.count);
    view.setUint32(8 + index * 8, entry.value);
  });
  return fullBox('stts', 0, 0, payload);
}

function buildCompositionOffsets(samples: readonly TrackSample[]): Uint8Array | undefined {
  if (samples.every(({ compositionOffset }) => compositionOffset === 0)) return undefined;
  const entries = runLengthEntries(samples.map(({ compositionOffset }) => compositionOffset));
  const signed = entries.some(({ value }) => value < 0);
  const payload = new Uint8Array(4 + entries.length * 8);
  const view = viewOf(payload);
  view.setUint32(0, entries.length);
  entries.forEach((entry, index) => {
    view.setUint32(4 + index * 8, entry.count);
    if (signed) view.setInt32(8 + index * 8, entry.value);
    else view.setUint32(8 + index * 8, entry.value);
  });
  return fullBox('ctts', signed ? 1 : 0, 0, payload);
}

function buildSampleToChunk(chunks: readonly TrackChunk[]): Uint8Array {
  const entries: Array<{ firstChunk: number; samplesPerChunk: number }> = [];
  chunks.forEach((chunk, index) => {
    if (entries.at(-1)?.samplesPerChunk !== chunk.sampleCount) {
      entries.push({ firstChunk: index + 1, samplesPerChunk: chunk.sampleCount });
    }
  });
  const payload = new Uint8Array(4 + entries.length * 12);
  const view = viewOf(payload);
  view.setUint32(0, entries.length);
  entries.forEach((entry, index) => {
    view.setUint32(4 + index * 12, entry.firstChunk);
    view.setUint32(8 + index * 12, entry.samplesPerChunk);
    view.setUint32(12 + index * 12, 1);
  });
  return fullBox('stsc', 0, 0, payload);
}

function buildSampleSizes(samples: readonly TrackSample[]): Uint8Array {
  const payload = new Uint8Array(8 + samples.length * 4);
  const view = viewOf(payload);
  view.setUint32(0, 0);
  view.setUint32(4, samples.length);
  samples.forEach((sample, index) => view.setUint32(8 + index * 4, sample.size));
  return fullBox('stsz', 0, 0, payload);
}

function buildChunkOffsets(chunks: readonly TrackChunk[]): Uint8Array {
  const payload = new Uint8Array(4 + chunks.length * 8);
  const view = viewOf(payload);
  view.setUint32(0, chunks.length);
  chunks.forEach((chunk, index) => view.setBigUint64(4 + index * 8, BigInt(chunk.offset)));
  return fullBox('co64', 0, 0, payload);
}

function buildSyncSamples(samples: readonly TrackSample[], trackType: string): Uint8Array | undefined {
  if (trackType !== 'vide') return undefined;
  const syncSamples = samples.flatMap((sample, index) => sample.isSync ? [index + 1] : []);
  if (syncSamples.length === samples.length) return undefined;
  if (syncSamples.length === 0) throw new Error('The MP4 video track contains no sync samples.');
  const payload = new Uint8Array(4 + syncSamples.length * 4);
  const view = viewOf(payload);
  view.setUint32(0, syncSamples.length);
  syncSamples.forEach((sampleNumber, index) => view.setUint32(4 + index * 4, sampleNumber));
  return fullBox('stss', 0, 0, payload);
}

function buildSampleTable(source: Uint8Array, table: ParsedBox, track: TrackState): Uint8Array {
  const sourceDescription = requiredBox(childBoxes(source, table), 'stsd');
  const boxes = [
    sliceBox(source, sourceDescription),
    buildTimeToSample(track.samples),
    buildCompositionOffsets(track.samples),
    buildSampleToChunk(track.chunks),
    buildSampleSizes(track.samples),
    buildChunkOffsets(track.chunks),
    buildSyncSamples(track.samples, track.type),
  ].filter((box): box is Uint8Array => box !== undefined);
  return makeBox('stbl', ...boxes);
}

function rebuildContainer(
  source: Uint8Array,
  container: ParsedBox,
  replace: (child: ParsedBox) => Uint8Array | undefined,
): Uint8Array {
  return makeBox(container.type, ...childBoxes(source, container).flatMap((child) => {
    const replacement = replace(child);
    return replacement === undefined ? [] : [replacement];
  }));
}

function trackStartSeconds(track: TrackState): number {
  return (track.firstDecodeTime ?? 0) / track.timescale;
}

function buildEditList(
  track: TrackState,
  movieTimescale: number,
  timelineOriginSeconds: number,
): Uint8Array | undefined {
  const delaySeconds = Math.max(0, trackStartSeconds(track) - timelineOriginSeconds);
  if (delaySeconds === 0) return undefined;
  const emptyDuration = Math.ceil(delaySeconds * movieTimescale);
  const mediaDuration = Math.ceil(track.presentationEnd * movieTimescale / track.timescale);
  const payload = concatenate([
    uint32(2),
    uint32(emptyDuration), int32(-1), new Uint8Array([0, 1, 0, 0]),
    uint32(mediaDuration), int32(0), new Uint8Array([0, 1, 0, 0]),
  ]);
  return makeBox('edts', fullBox('elst', 0, 0, payload));
}

function buildTrack(
  track: TrackState,
  movieTimescale: number,
  timelineOriginSeconds: number,
): Uint8Array {
  const source = track.sourceTrack;
  const trackBox = requiredBox(parseBoxes(source), 'trak');
  const trackDuration = Math.ceil((
    Math.max(0, trackStartSeconds(track) - timelineOriginSeconds) +
    track.presentationEnd / track.timescale
  ) * movieTimescale);
  const editList = buildEditList(track, movieTimescale, timelineOriginSeconds);
  return makeBox('trak', ...childBoxes(source, trackBox).flatMap((child) => {
    if (child.type === 'tkhd') return [patchFullBoxDuration(sliceBox(source, child), 'tkhd', trackDuration)];
    if (child.type === 'edts') return [];
    if (child.type !== 'mdia') return [sliceBox(source, child)];
    const media = rebuildContainer(source, child, (mediaChild) => {
      if (mediaChild.type === 'mdhd') {
        return patchFullBoxDuration(sliceBox(source, mediaChild), 'mdhd', track.decodeDuration);
      }
      if (mediaChild.type !== 'minf') return sliceBox(source, mediaChild);
      return rebuildContainer(source, mediaChild, (mediaInfoChild) => {
        if (mediaInfoChild.type !== 'stbl') return sliceBox(source, mediaInfoChild);
        return buildSampleTable(source, mediaInfoChild, track);
      });
    });
    return [...(editList ? [editList] : []), media];
  }));
}

function movieTimescale(bytes: Uint8Array, movieHeader: ParsedBox): number {
  const view = viewOf(bytes);
  const version = view.getUint8(movieHeader.contentStart);
  if (version !== 0 && version !== 1) throw new Error(`Unsupported MP4 movie header version: ${version}.`);
  const timescale = view.getUint32(movieHeader.contentStart + (version === 1 ? 20 : 12));
  if (timescale === 0) throw new Error('The MP4 movie timescale is invalid.');
  return timescale;
}

function sourceTrackKey(sourceId: string, trackId: number): string {
  return `${sourceId}\u0000${trackId}`;
}

function patchMovieHeader(
  source: Uint8Array,
  duration: number,
  nextTrackId: number,
): Uint8Array {
  const result = patchFullBoxDuration(source, 'mvhd', duration);
  const header = requiredBox(parseBoxes(result), 'mvhd');
  viewOf(result).setUint32(header.end - 4, nextTrackId);
  return result;
}

export class FlatMp4Muxer {
  readonly #destination: RandomAccessBinaryWriter;
  readonly #tracks = new Map<string, TrackState>();
  readonly #usedTrackIds = new Set<number>();
  readonly #sourceIds = new Set<string>();
  #sourceInitialization: Uint8Array | null = null;
  #sourceMovie: ParsedBox | null = null;
  #movieTimescale = 0;
  #mdatStart = 0;
  #writePosition = 0;
  #initialized = false;
  #finalized = false;

  constructor(destination: RandomAccessBinaryWriter) {
    this.#destination = destination;
  }

  async initialize(initializationSegment: Uint8Array): Promise<void> {
    await this.addSource('default', initializationSegment);
  }

  async addSource(
    sourceId: string,
    initializationSegment: Uint8Array,
    acceptedTrackType?: 'vide' | 'soun',
  ): Promise<void> {
    if (this.#finalized) throw new Error('The MP4 muxer has already been finalized.');
    if (!sourceId) throw new Error('An MP4 source ID is required.');
    if (this.#sourceIds.has(sourceId)) throw new Error(`The MP4 source “${sourceId}” is already initialized.`);
    const topLevel = parseBoxes(initializationSegment);
    const fileType = requiredBox(topLevel, 'ftyp');
    const movie = requiredBox(topLevel, 'moov');
    const movieChildren = childBoxes(initializationSegment, movie);
    const movieHeader = requiredBox(movieChildren, 'mvhd');
    this.#movieTimescale = movieTimescale(initializationSegment, movieHeader);
    for (const trackBox of movieChildren.filter(({ type }) => type === 'trak')) {
      const trackChildren = childBoxes(initializationSegment, trackBox);
      const trackHeader = requiredBox(trackChildren, 'tkhd');
      const media = requiredBox(trackChildren, 'mdia');
      const mediaChildren = childBoxes(initializationSegment, media);
      const mediaHeader = requiredBox(mediaChildren, 'mdhd');
      const handler = requiredBox(mediaChildren, 'hdlr');
      const type = handlerType(initializationSegment, handler);
      if (acceptedTrackType && type !== acceptedTrackType) continue;
      const sourceTrackId = trackIdFromHeader(initializationSegment, trackHeader);
      const id = this.#allocateTrackId(sourceTrackId);
      this.#tracks.set(sourceTrackKey(sourceId, sourceTrackId), {
        sourceId,
        type,
        timescale: timescaleFromMediaHeader(initializationSegment, mediaHeader),
        sourceTrack: patchTrackId(sliceBox(initializationSegment, trackBox), id),
        samples: [],
        chunks: [],
        decodeDuration: 0,
        presentationEnd: 0,
      });
    }
    if (![...this.#tracks.values()].some((track) => track.sourceId === sourceId)) {
      throw new Error('The MP4 initialization segment contains no tracks.');
    }
    this.#sourceIds.add(sourceId);

    if (!this.#initialized) {
      this.#sourceInitialization = initializationSegment.slice();
      this.#sourceMovie = movie;
      const fileTypeBytes = sliceBox(initializationSegment, fileType);
      await this.#destination.write(fileTypeBytes);
      this.#writePosition = fileTypeBytes.byteLength;
      this.#mdatStart = this.#writePosition;
      const mediaHeaderBytes = concatenate([uint32(1), typeBytes('mdat'), uint64(16)]);
      await this.#destination.write(mediaHeaderBytes);
      this.#writePosition += mediaHeaderBytes.byteLength;
      this.#initialized = true;
    }
  }

  async appendFragment(fragment: Uint8Array, sourceId = 'default'): Promise<void> {
    if (!this.#initialized || this.#finalized) throw new Error('The MP4 muxer is not accepting media fragments.');
    const boxes = parseBoxes(fragment);
    for (let index = 0; index < boxes.length; index += 1) {
      const movieFragment = boxes[index]!;
      if (movieFragment.type === 'styp' || movieFragment.type === 'sidx' || movieFragment.type === 'emsg' || movieFragment.type === 'prft') {
        continue;
      }
      if (movieFragment.type !== 'moof') throw new Error(`Unexpected ${movieFragment.type} box in MP4 media data.`);
      const mediaData = boxes[index + 1];
      if (!mediaData || mediaData.type !== 'mdat') throw new Error('An MP4 movie fragment is missing its media data.');
      index += 1;
      const fragmentChildren = childBoxes(fragment, movieFragment);
      for (const trackFragment of fragmentChildren.filter(({ type }) => type === 'traf')) {
        const trackFragmentChildren = childBoxes(fragment, trackFragment);
        const defaults = parseTrackFragmentDefaults(fragment, requiredBox(trackFragmentChildren, 'tfhd'));
        const track = this.#tracks.get(sourceTrackKey(sourceId, defaults.trackId));
        if (!track) throw new Error(`The MP4 fragment references unknown track ${defaults.trackId}.`);
        const baseDecodeTime = decodeTime(fragment, requiredBox(trackFragmentChildren, 'tfdt'));
        if (track.firstDecodeTime === undefined) track.firstDecodeTime = baseDecodeTime;
        let implicitDataOffset = mediaData.contentStart;
        for (const runBox of trackFragmentChildren.filter(({ type }) => type === 'trun')) {
          const run = parseTrackRun(fragment, runBox, defaults);
          const dataStart = run.dataOffset === undefined ? implicitDataOffset : movieFragment.start + run.dataOffset;
          const byteLength = run.samples.reduce((sum, sample) => sum + sample.size, 0);
          const dataEnd = dataStart + byteLength;
          if (dataStart < mediaData.contentStart || dataEnd > mediaData.end) {
            throw new Error('An MP4 track run points outside its media data box.');
          }
          track.chunks.push({ offset: this.#writePosition, sampleCount: run.samples.length });
          let sampleDecodeTime = track.decodeDuration;
          for (const sample of run.samples) {
            track.presentationEnd = Math.max(
              track.presentationEnd,
              sampleDecodeTime + sample.compositionOffset + sample.duration,
            );
            sampleDecodeTime += sample.duration;
            track.decodeDuration += sample.duration;
            track.samples.push(sample);
          }
          const mediaBytes = fragment.slice(dataStart, dataEnd);
          await this.#destination.write(mediaBytes);
          this.#writePosition += mediaBytes.byteLength;
          implicitDataOffset = dataEnd;
        }
      }
    }
  }

  async finalize(): Promise<void> {
    if (!this.#initialized || this.#finalized || !this.#sourceInitialization || !this.#sourceMovie) {
      throw new Error('The MP4 muxer cannot be finalized in its current state.');
    }
    for (const track of this.#tracks.values()) {
      if (track.samples.length === 0 || track.chunks.length === 0) {
        throw new Error(`The MP4 ${track.type} track contains no samples.`);
      }
    }
    const mediaDataSize = this.#writePosition - this.#mdatStart;
    await this.#destination.writeAt(this.#mdatStart + 8, uint64(mediaDataSize));

    const source = this.#sourceInitialization;
    const movieChildren = childBoxes(source, this.#sourceMovie);
    const timelineOriginSeconds = Math.min(...[...this.#tracks.values()].map(trackStartSeconds));
    const durationSeconds = Math.max(...[...this.#tracks.values()].map((track) =>
      Math.max(0, trackStartSeconds(track) - timelineOriginSeconds) + track.presentationEnd / track.timescale));
    const movieDuration = Math.ceil(durationSeconds * this.#movieTimescale);
    let insertedTracks = false;
    const movie = makeBox('moov', ...movieChildren.flatMap((child) => {
      if (child.type === 'mvex') return [];
      if (child.type === 'mvhd') {
        return [patchMovieHeader(
          sliceBox(source, child),
          movieDuration,
          Math.max(...this.#usedTrackIds) + 1,
        )];
      }
      if (child.type !== 'trak') return [sliceBox(source, child)];
      if (insertedTracks) return [];
      insertedTracks = true;
      return [...this.#tracks.values()].map((track) =>
        buildTrack(track, this.#movieTimescale, timelineOriginSeconds));
    }));
    await this.#destination.write(movie);
    this.#writePosition += movie.byteLength;
    this.#finalized = true;
  }

  #allocateTrackId(preferred: number): number {
    let candidate = preferred > 0 && !this.#usedTrackIds.has(preferred) ? preferred : 1;
    while (this.#usedTrackIds.has(candidate)) candidate += 1;
    if (candidate > UINT32_MAX) throw new Error('The MP4 output contains too many tracks.');
    this.#usedTrackIds.add(candidate);
    return candidate;
  }
}
