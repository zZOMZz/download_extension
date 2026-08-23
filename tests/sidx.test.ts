import { describe, expect, it } from 'vitest';
import { parseSidxResources } from '../src/core/mp4/sidx';

function sidx(referenceSizes: number[], firstOffset = 0): Uint8Array {
  const size = 8 + 4 + 4 + 4 + 4 + 4 + 2 + 2 + referenceSizes.length * 12;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size);
  bytes.set(new TextEncoder().encode('sidx'), 4);
  let offset = 8;
  view.setUint32(offset, 0);
  offset += 4;
  view.setUint32(offset, 1);
  offset += 4;
  view.setUint32(offset, 1_000);
  offset += 4;
  view.setUint32(offset, 0);
  offset += 4;
  view.setUint32(offset, firstOffset);
  offset += 4;
  view.setUint16(offset, 0);
  offset += 2;
  view.setUint16(offset, referenceSizes.length);
  offset += 2;
  for (const referenceSize of referenceSizes) {
    view.setUint32(offset, referenceSize);
    offset += 4;
    view.setUint32(offset, 4_000);
    offset += 4;
    view.setUint32(offset, 0x9000_0000);
    offset += 4;
  }
  return bytes;
}

describe('DASH sidx parser', () => {
  it('turns SegmentBase references into absolute byte ranges', () => {
    const bytes = sidx([100, 200], 50);
    const result = parseSidxResources(bytes, {
      url: 'https://cdn.example/video.m4s',
      byteRange: { offset: 1_000, length: bytes.byteLength },
    });

    expect(result).toEqual([
      {
        url: 'https://cdn.example/video.m4s',
        byteRange: { offset: 1_000 + bytes.byteLength + 50, length: 100 },
      },
      {
        url: 'https://cdn.example/video.m4s',
        byteRange: { offset: 1_000 + bytes.byteLength + 150, length: 200 },
      },
    ]);
  });

  it('rejects hierarchical references', () => {
    const bytes = sidx([100]);
    new DataView(bytes.buffer).setUint32(32, 0x8000_0064);
    expect(() => parseSidxResources(bytes, {
      url: 'https://cdn.example/video.m4s',
      byteRange: { offset: 0, length: bytes.byteLength },
    })).toThrow(/hierarchical/i);
  });

  it('propagates fallback URLs to every indexed media range', () => {
    const bytes = sidx([100]);
    expect(parseSidxResources(bytes, {
      url: 'https://primary.example/video.m4s',
      alternativeUrls: ['https://backup.example/video.m4s'],
      byteRange: { offset: 1_000, length: bytes.byteLength },
    })[0]).toEqual({
      url: 'https://primary.example/video.m4s',
      alternativeUrls: ['https://backup.example/video.m4s'],
      byteRange: { offset: 1_000 + bytes.byteLength, length: 100 },
    });
  });
});
