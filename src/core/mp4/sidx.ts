import type { DashResource } from '../../shared/media';

interface ParsedBox {
  type: string;
  start: number;
  contentStart: number;
  end: number;
}

function readType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function boxes(bytes: Uint8Array): ParsedBox[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: ParsedBox[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error('The DASH index ends with an incomplete MP4 box.');
    const compactSize = view.getUint32(offset);
    let headerSize = 8;
    let size = compactSize;
    if (compactSize === 1) {
      if (offset + 16 > bytes.byteLength) throw new Error('The DASH index has an incomplete extended MP4 box.');
      const extended = view.getBigUint64(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The DASH index contains an oversized MP4 box.');
      size = Number(extended);
      headerSize = 16;
    } else if (compactSize === 0) {
      size = bytes.byteLength - offset;
    }
    const type = readType(bytes, offset + 4);
    if (size < headerSize || offset + size > bytes.byteLength) {
      throw new Error(`The DASH index contains an invalid ${type} box.`);
    }
    result.push({ type, start: offset, contentStart: offset + headerSize, end: offset + size });
    offset += size;
  }
  return result;
}

function safeInteger(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`The DASH ${label} is too large.`);
  return Number(value);
}

export function parseSidxResources(
  bytes: Uint8Array,
  indexResource: DashResource,
): DashResource[] {
  const indexOffset = indexResource.byteRange?.offset ?? 0;
  const sidx = boxes(bytes).find(({ type }) => type === 'sidx');
  if (!sidx) throw new Error('The DASH SegmentBase index does not contain a sidx box.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(sidx.contentStart);
  if (version !== 0 && version !== 1) throw new Error(`Unsupported DASH sidx version: ${version}.`);
  let cursor = sidx.contentStart + 4;
  if (cursor + 8 > sidx.end) throw new Error('The DASH sidx header is truncated.');
  cursor += 4;
  const timescale = view.getUint32(cursor);
  cursor += 4;
  if (timescale === 0) throw new Error('The DASH sidx timescale is invalid.');
  let firstOffset: number;
  if (version === 0) {
    if (cursor + 8 > sidx.end) throw new Error('The DASH sidx timing fields are truncated.');
    cursor += 4;
    firstOffset = view.getUint32(cursor);
    cursor += 4;
  } else {
    if (cursor + 16 > sidx.end) throw new Error('The DASH sidx timing fields are truncated.');
    cursor += 8;
    firstOffset = safeInteger(view.getBigUint64(cursor), 'sidx first offset');
    cursor += 8;
  }
  if (cursor + 4 > sidx.end) throw new Error('The DASH sidx reference table is truncated.');
  cursor += 2;
  const referenceCount = view.getUint16(cursor);
  cursor += 2;
  let mediaOffset = indexOffset + sidx.end + firstOffset;
  const resources: DashResource[] = [];
  for (let index = 0; index < referenceCount; index += 1) {
    if (cursor + 12 > sidx.end) throw new Error('The DASH sidx reference table is truncated.');
    const reference = view.getUint32(cursor);
    cursor += 4;
    const referenceType = reference >>> 31;
    const size = reference & 0x7fff_ffff;
    cursor += 8;
    if (referenceType !== 0) throw new Error('Hierarchical DASH sidx references are not supported.');
    if (size === 0) throw new Error('The DASH sidx contains an empty media reference.');
    resources.push({
      url: indexResource.url,
      ...(indexResource.alternativeUrls?.length
        ? { alternativeUrls: indexResource.alternativeUrls }
        : {}),
      byteRange: { offset: mediaOffset, length: size },
    });
    mediaOffset += size;
  }
  if (resources.length === 0) throw new Error('The DASH sidx contains no media references.');
  return resources;
}
