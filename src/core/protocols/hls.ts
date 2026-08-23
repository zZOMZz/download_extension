export interface HlsByteRange {
  length: number;
  offset: number;
}

export interface HlsKey {
  method: string;
  uri?: string;
  iv?: string;
  keyFormat: string;
}

export interface HlsMap {
  uri: string;
  byteRange?: HlsByteRange;
  key?: HlsKey;
}

export interface HlsSegment {
  uri: string;
  duration: number;
  sequence: number;
  byteRange?: HlsByteRange;
  discontinuity: boolean;
  key?: HlsKey;
  map?: HlsMap;
  streamRole?: 'video' | 'audio';
}

export interface HlsVariant {
  uri: string;
  bandwidth?: number;
  averageBandwidth?: number;
  codecs?: string;
  resolution?: { width: number; height: number };
  frameRate?: number;
  audioGroup?: string;
}

export interface HlsRendition {
  type: string;
  groupId?: string;
  name?: string;
  uri?: string;
  language?: string;
  isDefault: boolean;
  autoSelect: boolean;
  forced: boolean;
  channels?: string;
}

export interface HlsMasterPlaylist {
  type: 'master';
  variants: HlsVariant[];
  renditions: HlsRendition[];
}

export interface HlsMediaPlaylist {
  type: 'media';
  targetDuration?: number;
  mediaSequence: number;
  playlistType?: string;
  endList: boolean;
  segments: HlsSegment[];
}

export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylist;

export class HlsParseError extends Error {
  override readonly name = 'HlsParseError';
}

function resolveUri(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).href;
  } catch {
    throw new HlsParseError(`Invalid playlist URI: ${value}`);
  }
}

export function parseAttributeList(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let cursor = 0;

  while (cursor < input.length) {
    const equals = input.indexOf('=', cursor);
    if (equals < 0) break;
    const key = input.slice(cursor, equals).trim().toUpperCase();
    cursor = equals + 1;

    let value = '';
    if (input[cursor] === '"') {
      cursor += 1;
      const start = cursor;
      while (cursor < input.length && input[cursor] !== '"') cursor += 1;
      value = input.slice(start, cursor);
      cursor += 1;
    } else {
      const comma = input.indexOf(',', cursor);
      const end = comma < 0 ? input.length : comma;
      value = input.slice(cursor, end).trim();
      cursor = end;
    }

    if (key) attributes[key] = value;
    while (cursor < input.length && (input[cursor] === ',' || input[cursor] === ' ')) cursor += 1;
  }

  return attributes;
}

function positiveInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function decimal(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseResolution(value?: string): HlsVariant['resolution'] {
  if (!value) return undefined;
  const match = /^(\d+)x(\d+)$/i.exec(value);
  if (!match) return undefined;
  const width = Number.parseInt(match[1] ?? '', 10);
  const height = Number.parseInt(match[2] ?? '', 10);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
}

function parseByteRange(value: string | undefined, previousEnd: number): HlsByteRange | undefined {
  if (!value) return undefined;
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!match) throw new HlsParseError(`Invalid byte range: ${value}`);
  const length = Number.parseInt(match[1] ?? '', 10);
  const explicitOffset = match[2] ? Number.parseInt(match[2], 10) : undefined;
  return { length, offset: explicitOffset ?? previousEnd };
}

function parseKey(attributes: Record<string, string>, baseUrl: string): HlsKey | undefined {
  const method = attributes.METHOD?.toUpperCase();
  if (!method || method === 'NONE') return undefined;
  return {
    method,
    keyFormat: attributes.KEYFORMAT ?? 'identity',
    ...(attributes.URI ? { uri: resolveUri(attributes.URI, baseUrl) } : {}),
    ...(attributes.IV ? { iv: attributes.IV } : {}),
  };
}

function parseMaster(lines: string[], baseUrl: string): HlsMasterPlaylist {
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  let pendingVariant: Record<string, string> | null = null;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length));
      renditions.push({
        type: attributes.TYPE ?? 'UNKNOWN',
        isDefault: attributes.DEFAULT === 'YES',
        autoSelect: attributes.AUTOSELECT === 'YES',
        forced: attributes.FORCED === 'YES',
        ...(attributes['GROUP-ID'] ? { groupId: attributes['GROUP-ID'] } : {}),
        ...(attributes.NAME ? { name: attributes.NAME } : {}),
        ...(attributes.LANGUAGE ? { language: attributes.LANGUAGE } : {}),
        ...(attributes.CHANNELS ? { channels: attributes.CHANNELS } : {}),
        ...(attributes.URI ? { uri: resolveUri(attributes.URI, baseUrl) } : {}),
      });
      continue;
    }
    if (!line.startsWith('#') && pendingVariant) {
      const resolution = parseResolution(pendingVariant.RESOLUTION);
      const bandwidth = positiveInteger(pendingVariant.BANDWIDTH);
      const averageBandwidth = positiveInteger(pendingVariant['AVERAGE-BANDWIDTH']);
      const frameRate = decimal(pendingVariant['FRAME-RATE']);
      variants.push({
        uri: resolveUri(line, baseUrl),
        ...(bandwidth !== undefined ? { bandwidth } : {}),
        ...(averageBandwidth !== undefined ? { averageBandwidth } : {}),
        ...(pendingVariant.CODECS ? { codecs: pendingVariant.CODECS } : {}),
        ...(resolution ? { resolution } : {}),
        ...(frameRate !== undefined ? { frameRate } : {}),
        ...(pendingVariant.AUDIO ? { audioGroup: pendingVariant.AUDIO } : {}),
      });
      pendingVariant = null;
    }
  }

  if (variants.length === 0) throw new HlsParseError('The master playlist contains no variants.');
  return { type: 'master', variants, renditions };
}

function parseMedia(lines: string[], baseUrl: string): HlsMediaPlaylist {
  const segments: HlsSegment[] = [];
  const rangeEnds = new Map<string, number>();
  let mediaSequence = 0;
  let targetDuration: number | undefined;
  let playlistType: string | undefined;
  let endList = false;
  let pendingDuration = 0;
  let pendingByteRange: string | undefined;
  let discontinuity = false;
  let currentKey: HlsKey | undefined;
  let currentMap: HlsMap | undefined;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = positiveInteger(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) ?? 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = decimal(line.slice('#EXT-X-TARGETDURATION:'.length));
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim().toUpperCase();
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = decimal(line.slice('#EXTINF:'.length).split(',', 1)[0]) ?? 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = line.slice('#EXT-X-BYTERANGE:'.length).trim();
    } else if (line.startsWith('#EXT-X-KEY:')) {
      currentKey = parseKey(parseAttributeList(line.slice('#EXT-X-KEY:'.length)), baseUrl);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
      if (!attributes.URI) throw new HlsParseError('EXT-X-MAP is missing a URI.');
      const uri = resolveUri(attributes.URI, baseUrl);
      const previousEnd = rangeEnds.get(uri) ?? 0;
      const byteRange = parseByteRange(attributes.BYTERANGE, previousEnd);
      if (byteRange) rangeEnds.set(uri, byteRange.offset + byteRange.length);
      currentMap = {
        uri,
        ...(byteRange ? { byteRange } : {}),
        ...(currentKey ? { key: { ...currentKey } } : {}),
      };
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (line && !line.startsWith('#')) {
      const uri = resolveUri(line, baseUrl);
      const previousEnd = rangeEnds.get(uri) ?? 0;
      const byteRange = parseByteRange(pendingByteRange, previousEnd);
      if (byteRange) rangeEnds.set(uri, byteRange.offset + byteRange.length);

      segments.push({
        uri,
        duration: pendingDuration,
        sequence: mediaSequence + segments.length,
        discontinuity,
        ...(byteRange ? { byteRange } : {}),
        ...(currentKey ? { key: { ...currentKey } } : {}),
        ...(currentMap ? { map: { ...currentMap } } : {}),
      });
      pendingDuration = 0;
      pendingByteRange = undefined;
      discontinuity = false;
    }
  }

  if (segments.length === 0) throw new HlsParseError('The media playlist contains no segments.');
  return {
    type: 'media',
    mediaSequence,
    endList,
    segments,
    ...(targetDuration !== undefined ? { targetDuration } : {}),
    ...(playlistType ? { playlistType } : {}),
  };
}

export function parseHlsPlaylist(text: string, baseUrl: string): HlsPlaylist {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines[0] !== '#EXTM3U') throw new HlsParseError('This response is not an HLS playlist.');
  const isMaster = lines.some((line) => line.startsWith('#EXT-X-STREAM-INF:'));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}
