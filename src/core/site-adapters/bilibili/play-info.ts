import {
  dashMediaSourceSchema,
  type DashByteRange,
  type DashMediaSource,
  type DashTrack,
} from '../../../shared/media';

type JsonRecord = Record<string, unknown>;

export interface BilibiliPlaybackInfo {
  dash?: DashMediaSource | undefined;
  progressiveUrl?: string | undefined;
  isPreview: boolean;
  hasContentProtection: boolean;
  episodeId?: number | undefined;
  cid?: number | undefined;
  durationSeconds?: number | undefined;
}

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
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = numberValue(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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
  const length = end - offset + 1;
  return Number.isSafeInteger(length) ? { offset, length } : undefined;
}

function jsonObjectAt(script: string, start: number): { value: JsonRecord; end: number } | undefined {
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
          const value = asRecord(JSON.parse(script.slice(start, index + 1)));
          return value ? { value, end: index + 1 } : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Read literal JSON assignments only; never execute page JavaScript or follow arbitrary expressions. */
function scriptPlayInfoRecords(script: string): { records: JsonRecord[]; episodeId?: number } {
  const records: JsonRecord[] = [];
  let episodeId: number | undefined;
  const assignment = /(?:window\s*\.\s*)?(?:__playinfo__|playurlSSRData)\s*=\s*(?=\{)/y;
  const configAssignment = /config\s*=\s*Object\s*\.\s*assign\s*\(\s*config\s*,\s*(?=\{)/y;
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index]!;
    if (character === '/' && script[index + 1] === '/') {
      const end = script.indexOf('\n', index + 2);
      index = end < 0 ? script.length : end;
      continue;
    }
    if (character === '/' && script[index + 1] === '*') {
      const end = script.indexOf('*/', index + 2);
      index = end < 0 ? script.length : end + 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      for (index += 1; index < script.length; index += 1) {
        if (script[index] === '\\') index += 1;
        else if (script[index] === character) break;
      }
      continue;
    }
    if (index > 0 && /[\w$.]/.test(script[index - 1]!)) continue;
    assignment.lastIndex = index;
    const match = assignment.exec(script);
    configAssignment.lastIndex = index;
    const configMatch = !match && configAssignment.exec(script);
    if (!match && !configMatch) continue;
    const object = jsonObjectAt(script, match ? assignment.lastIndex : configAssignment.lastIndex);
    if (!object) continue;
    if (match) records.push(object.value);
    else episodeId = positiveInteger(object.value.episodeId ?? object.value.ep_id);
    index = object.end - 1;
  }
  return { records, ...(episodeId ? { episodeId } : {}) };
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

function enabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') {
    return !['', '0', 'false', 'none', 'null'].includes(value.trim().toLowerCase());
  }
  return false;
}

function nonempty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  const record = asRecord(value);
  return record ? Object.keys(record).length > 0 : enabled(value);
}

function hasProtection(record: JsonRecord): boolean {
  return ['is_drm', 'isDrm', 'drm_tech_type', 'drmTechType'].some((key) => enabled(record[key])) ||
    ['drm', 'drm_info', 'drmInfo', 'drmInfos', 'drm_infos', 'ContentProtection', 'content_protection',
      'contentProtection', 'widevine_pssh', 'playready_pssh'].some((key) => nonempty(record[key]));
}

function isPreviewRecord(record: JsonRecord): boolean {
  return enabled(record.is_preview ?? record.isPreview) ||
    stringValue(record.play_video_type)?.toLowerCase() === 'preview';
}

/** Only these known envelopes are traversed, rather than unrelated recommendations or account state. */
function playbackPath(record: JsonRecord, parents: JsonRecord[] = []): JsonRecord[] | undefined {
  if (parents.length >= 8) return undefined;
  if (record.code !== undefined && numberValue(record.code) !== 0) return undefined;
  const path = [...parents, record];
  for (const key of ['video_info', 'data', 'result']) {
    const child = asRecord(record[key]);
    const found = child && playbackPath(child, path);
    if (found) return found;
  }
  return asRecord(record.dash) || Array.isArray(record.durl) || hasProtection(record) || isPreviewRecord(record)
    ? path : undefined;
}

function uniqueTrackIds(tracks: DashTrack[]): DashTrack[] {
  // Quality IDs are reused across AVC/HEVC/AV1. CDN URLs and list order must not define identity.
  const identities = tracks.map((track) => [
      track.id, track.kind, track.codecs ?? 'unknown', track.width ?? 0, track.height ?? 0,
      track.frameRate ?? 0, track.bandwidth ?? 0,
      track.initialization.byteRange?.offset ?? 0, track.initialization.byteRange?.length ?? 0,
      track.index?.byteRange?.offset ?? 0, track.index?.byteRange?.length ?? 0,
  ].join(':'));
  const variants = new Map<string, Set<string>>();
  for (const [index, track] of tracks.entries()) {
    const set = variants.get(track.id) ?? new Set<string>();
    set.add(identities[index]!);
    variants.set(track.id, set);
  }
  const result = new Map<string, DashTrack>();
  for (const [index, track] of tracks.entries()) {
    const id = variants.get(track.id)!.size === 1 ? track.id : identities[index]!;
    const existing = result.get(id);
    if (!existing) {
      result.set(id, { ...track, id });
      continue;
    }
    for (const key of ['initialization', 'index'] as const) {
      const current = existing[key];
      const duplicate = track[key];
      if (!current || !duplicate) continue;
      const alternatives = [...new Set([
        ...(current.alternativeUrls ?? []), duplicate.url, ...(duplicate.alternativeUrls ?? []),
      ])].filter((url) => url !== current.url);
      if (alternatives.length) current.alternativeUrls = alternatives;
    }
  }
  return [...result.values()];
}

function episodeIdentity(path: JsonRecord[]): { episodeId?: number; cid?: number } {
  let episodeId: number | undefined;
  let cid: number | undefined;
  for (const record of [...path].reverse()) {
    const arc = asRecord(record.arc);
    const episode = asRecord(asRecord(record.supplement)?.ogv_episode_info);
    const business = asRecord(asRecord(record.play_view_business_info)?.episode_info);
    episodeId ??= positiveInteger(record.ep_id ?? record.episode_id) ??
      positiveInteger(episode?.episode_id) ?? positiveInteger(business?.ep_id);
    cid ??= positiveInteger(record.cid) ?? positiveInteger(arc?.cid) ?? positiveInteger(business?.cid);
    for (const format of asArray(record.support_formats)) {
      episodeId ??= positiveInteger(asRecord(asRecord(format)?.report)?.ep_id);
    }
  }
  return { ...(episodeId ? { episodeId } : {}), ...(cid ? { cid } : {}) };
}

function parsePlaybackRecord(playInfo: JsonRecord | undefined): BilibiliPlaybackInfo | undefined {
  if (!playInfo) return undefined;
  const path = playbackPath(playInfo);
  const data = path?.at(-1);
  if (!path || !data) return undefined;
  const dashRecord = asRecord(data.dash);
  const rawTracks = [...asArray(dashRecord?.video), ...asArray(dashRecord?.audio)];
  const hasContentProtection = [...path, ...(dashRecord ? [dashRecord] : []),
    ...rawTracks.map(asRecord).filter((track): track is JsonRecord => Boolean(track)),
  ].some(hasProtection);
  const isPreview = path.some(isPreviewRecord);
  const tracks = uniqueTrackIds([
    ...asArray(dashRecord?.video).map((track) => parseTrack(track, 'video')),
    ...asArray(dashRecord?.audio).map((track) => parseTrack(track, 'audio')),
  ].filter((track): track is DashTrack => Boolean(track)));
  const durls = asArray(data.durl);
  const singleFile = durls.length === 1 ? asRecord(durls[0]) : undefined;
  const fileUrl = validHttpUrl(singleFile?.url);
  // A multi-file durl list must not silently become a truncated single-file download.
  const progressiveUrl = fileUrl && (new URL(fileUrl).pathname.toLowerCase().endsWith('.mp4') ||
    stringValue(data.format)?.toLowerCase() === 'mp4') ? fileUrl : undefined;
  const dashDuration = numberValue(dashRecord?.duration);
  const fileDuration = numberValue(singleFile?.length);
  const totalDuration = numberValue(data.timelength);
  // Preview responses can still report the full episode's timelength.
  const durationSeconds = dashDuration !== undefined && dashDuration > 0 ? dashDuration :
    progressiveUrl && fileDuration !== undefined && fileDuration > 0 ? fileDuration / 1_000 :
      !isPreview && totalDuration !== undefined && totalDuration > 0 ? totalDuration / 1_000 : undefined;
  const dash = dashRecord && tracks.length ? dashMediaSourceSchema.parse({
    type: 'static',
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    hasContentProtection,
    tracks,
  }) : undefined;
  if (!dash && !progressiveUrl && !hasContentProtection && !isPreview) return undefined;
  return {
    ...(dash ? { dash } : {}),
    ...(progressiveUrl && !hasContentProtection ? { progressiveUrl } : {}),
    isPreview,
    hasContentProtection,
    ...episodeIdentity(path),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
}

export function parseBilibiliPlaybackInfoScript(script: string): BilibiliPlaybackInfo | undefined {
  const { records, episodeId } = scriptPlayInfoRecords(script);
  for (const record of records.reverse()) {
    const info = parsePlaybackRecord(record);
    if (info) return episodeId && !info.episodeId ? { ...info, episodeId } : info;
  }
  return undefined;
}

export function parseBilibiliPlaybackInfoResponse(responseText: string): BilibiliPlaybackInfo | undefined {
  try {
    return parsePlaybackRecord(asRecord(JSON.parse(responseText)));
  } catch {
    return undefined;
  }
}

export function parseBilibiliPlayInfoScript(script: string): DashMediaSource | undefined {
  const info = parseBilibiliPlaybackInfoScript(script);
  return info?.isPreview ? undefined : info?.dash;
}

export function parseBilibiliPlayInfoResponse(responseText: string): DashMediaSource | undefined {
  const info = parseBilibiliPlaybackInfoResponse(responseText);
  return info?.isPreview ? undefined : info?.dash;
}
