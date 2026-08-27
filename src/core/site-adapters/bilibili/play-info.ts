import {
  dashMediaSourceSchema,
  type DashByteRange,
  type DashMediaSource,
  type DashTrack,
} from '../../../shared/media';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = numberValue(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function validHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function byteRange(value: unknown): DashByteRange | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const offset = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || end < offset) return undefined;
  return { offset, length: end - offset + 1 };
}

function jsonObjectAfterAssignment(script: string, marker: string): JsonRecord | undefined {
  const markerIndex = script.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const start = script.indexOf('{', markerIndex + marker.length);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < script.length; index += 1) {
    const character = script[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return asRecord(JSON.parse(script.slice(start, index + 1)));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function frameRate(value: unknown): number | undefined {
  if (typeof value === 'number') return value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const [numerator, denominator = '1'] = value.split('/', 2);
  const parsed = Number(numerator) / Number(denominator);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseTrack(value: unknown, kind: DashTrack['kind']): DashTrack | undefined {
  const track = asRecord(value);
  if (!track) return undefined;
  const id = stringValue(track.id);
  const url = validHttpUrl(track.baseUrl ?? track.base_url);
  const alternativeUrls = [...new Set(
    asArray(track.backupUrl ?? track.backup_url)
      .map(validHttpUrl)
      .filter((candidate): candidate is string => Boolean(candidate) && candidate !== url),
  )];
  const segmentBase = asRecord(track.SegmentBase ?? track.segment_base);
  const initializationRange = byteRange(segmentBase?.Initialization ?? segmentBase?.initialization);
  const indexRange = byteRange(segmentBase?.indexRange ?? segmentBase?.index_range);
  if (!id || !url || !initializationRange || !indexRange) return undefined;
  try {
    const bandwidth = positiveInteger(track.bandwidth);
    const mimeType = stringValue(track.mimeType ?? track.mime_type);
    if (mimeType && mimeType.toLowerCase() !== `${kind}/mp4`) return undefined;
    const codecs = stringValue(track.codecs);
    const width = positiveInteger(track.width);
    const height = positiveInteger(track.height);
    const parsedFrameRate = frameRate(track.frameRate ?? track.frame_rate);
    return {
      id,
      kind,
      initialization: {
        url,
        ...(alternativeUrls.length ? { alternativeUrls } : {}),
        byteRange: initializationRange,
      },
      index: {
        url,
        ...(alternativeUrls.length ? { alternativeUrls } : {}),
        byteRange: indexRange,
      },
      ...(bandwidth === undefined ? {} : { bandwidth }),
      ...(mimeType ? { mimeType } : {}),
      ...(codecs ? { codecs } : {}),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(parsedFrameRate === undefined ? {} : { frameRate: parsedFrameRate }),
    };
  } catch {
    return undefined;
  }
}

function parsePlayInfoRecord(playInfo: JsonRecord | undefined): DashMediaSource | undefined {
  const data = asRecord(playInfo?.data);
  const dash = asRecord(data?.dash);
  if (!dash) return undefined;
  const tracks = [
    ...asArray(dash.video).map((track) => parseTrack(track, 'video')),
    ...asArray(dash.audio).map((track) => parseTrack(track, 'audio')),
  ].filter((track): track is DashTrack => Boolean(track));
  if (!tracks.length) return undefined;
  const dashDuration = numberValue(dash.duration);
  const durationMilliseconds = numberValue(data?.timelength);
  const durationSeconds = dashDuration !== undefined && dashDuration > 0
    ? dashDuration
    : durationMilliseconds !== undefined && durationMilliseconds > 0
      ? durationMilliseconds / 1_000
      : undefined;
  return dashMediaSourceSchema.parse({
    type: 'static',
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    hasContentProtection: false,
    tracks,
  });
}

export function parseBilibiliPlayInfoScript(script: string): DashMediaSource | undefined {
  const playInfo = jsonObjectAfterAssignment(script, 'window.__playinfo__')
    ?? jsonObjectAfterAssignment(script, '__playinfo__');
  return parsePlayInfoRecord(playInfo);
}

export function parseBilibiliPlayInfoResponse(responseText: string): DashMediaSource | undefined {
  try {
    return parsePlayInfoRecord(asRecord(JSON.parse(responseText)));
  } catch {
    return undefined;
  }
}
