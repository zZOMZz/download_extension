import { XMLParser } from 'fast-xml-parser';
import {
  dashMediaSourceSchema,
  type DashByteRange,
  type DashMediaSource,
  type DashResource,
  type DashTrack,
} from '../../shared/media';

export interface DashRepresentation {
  id?: string;
  bandwidth?: number;
  contentType?: string;
  mimeType?: string;
  codecs?: string;
  width?: number;
  height?: number;
}

export interface DashManifestSummary {
  type: 'static' | 'dynamic';
  duration?: string;
  hasContentProtection: boolean;
  representations: DashRepresentation[];
}

type XmlNode = Record<string, unknown>;
const MAX_DASH_SEGMENTS_PER_TRACK = 1_000_000;

function asRecord(value: unknown): XmlNode | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as XmlNode)
    : null;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function hasProtection(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasProtection);
  const record = asRecord(node);
  if (!record) return false;
  if ('ContentProtection' in record) return true;
  return Object.values(record).some(hasProtection);
}

function parseXml(text: string): XmlNode {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: true,
  });
  const root = asRecord(parser.parse(text));
  const mpd = asRecord(root?.MPD);
  if (!mpd) throw new Error('This response is not a DASH MPD.');
  return mpd;
}

export function parseDashManifest(text: string): DashManifestSummary {
  const mpd = parseXml(text);

  const representations: DashRepresentation[] = [];
  for (const periodValue of asArray(mpd.Period)) {
    const period = asRecord(periodValue);
    if (!period) continue;
    for (const adaptationValue of asArray(period.AdaptationSet)) {
      const adaptation = asRecord(adaptationValue);
      if (!adaptation) continue;
      for (const representationValue of asArray(adaptation.Representation)) {
        const representation = asRecord(representationValue);
        if (!representation) continue;
        const id = optionalIdentifier(representation.id);
        const bandwidth = optionalNumber(representation.bandwidth);
        const contentType = optionalString(representation.contentType ?? adaptation.contentType);
        const mimeType = optionalString(representation.mimeType ?? adaptation.mimeType);
        const codecs = optionalString(representation.codecs ?? adaptation.codecs);
        const width = optionalNumber(representation.width);
        const height = optionalNumber(representation.height);
        representations.push({
          ...(id ? { id } : {}),
          ...(bandwidth !== undefined ? { bandwidth } : {}),
          ...(contentType ? { contentType } : {}),
          ...(mimeType ? { mimeType } : {}),
          ...(codecs ? { codecs } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
        });
      }
    }
  }

  const duration = optionalString(mpd.mediaPresentationDuration);
  return {
    type: mpd.type === 'dynamic' ? 'dynamic' : 'static',
    hasContentProtection: hasProtection(mpd),
    representations,
    ...(duration ? { duration } : {}),
  };
}

export function parseIsoDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 86_400 +
    Number(match[2] ?? 0) * 3_600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0);
}

function nodeText(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return optionalString(asRecord(value)?.['#text']);
}

function resolvedBaseUrl(parentUrl: string, node: XmlNode): string {
  const child = asArray(node.BaseURL).map(nodeText).find((value): value is string => Boolean(value));
  return child ? new URL(child, parentUrl).href : parentUrl;
}

function parseByteRange(value: unknown): DashByteRange | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
  return { offset: start, length: end - start + 1 };
}

function resource(url: string, range?: DashByteRange): DashResource {
  return { url, ...(range ? { byteRange: range } : {}) };
}

function frameRate(value: unknown): number | undefined {
  if (typeof value === 'number') return value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const [numerator, denominator = '1'] = value.split('/', 2);
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function trackKind(
  representation: XmlNode,
  adaptation: XmlNode,
): DashTrack['kind'] | undefined {
  const contentType = optionalString(representation.contentType ?? adaptation.contentType)?.toLowerCase();
  const mimeType = optionalString(representation.mimeType ?? adaptation.mimeType)?.toLowerCase();
  if (contentType === 'video' || mimeType?.startsWith('video/')) return 'video';
  if (contentType === 'audio' || mimeType?.startsWith('audio/')) return 'audio';
  return undefined;
}

function substituteTemplate(
  template: string,
  values: { representationId: string; bandwidth?: number; number?: number; time?: number },
): string {
  const escapedDollar = '\u0000';
  return template.replace(/\$\$/g, escapedDollar).replace(
    /\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g,
    (_match, key: string, width: string | undefined) => {
      const value = key === 'RepresentationID' ? values.representationId
        : key === 'Bandwidth' ? values.bandwidth
        : key === 'Number' ? values.number
        : values.time;
      if (value === undefined) throw new Error(`The DASH template requires an unavailable $${key}$ value.`);
      const rendered = String(value);
      return width ? rendered.padStart(Number(width), '0') : rendered;
    },
  ).replaceAll(escapedDollar, '$');
}

function inheritedNode(adaptation: XmlNode, representation: XmlNode, key: string): XmlNode | null {
  const parent = asRecord(adaptation[key]);
  const child = asRecord(representation[key]);
  if (!parent) return child;
  if (!child) return parent;
  return {
    ...parent,
    ...child,
    ...(child.SegmentTimeline === undefined && parent.SegmentTimeline !== undefined
      ? { SegmentTimeline: parent.SegmentTimeline }
      : {}),
    ...(child.Initialization === undefined && parent.Initialization !== undefined
      ? { Initialization: parent.Initialization }
      : {}),
  };
}

function templateResources(
  template: XmlNode,
  baseUrl: string,
  representationId: string,
  bandwidth: number | undefined,
  durationSeconds: number | undefined,
): { initialization: DashResource; segments: DashResource[] } | undefined {
  const initializationTemplate = optionalString(template.initialization);
  const mediaTemplate = optionalString(template.media);
  if (!initializationTemplate || !mediaTemplate) return undefined;
  const timescale = optionalNumber(template.timescale) ?? 1;
  const startNumber = optionalNumber(template.startNumber) ?? 1;
  if (timescale <= 0 || !Number.isInteger(startNumber) || startNumber < 0) {
    throw new Error('The DASH SegmentTemplate timing is invalid.');
  }
  const values = { representationId, ...(bandwidth === undefined ? {} : { bandwidth }) };
  const initialization = resource(new URL(substituteTemplate(initializationTemplate, values), baseUrl).href);
  const timeline = asRecord(template.SegmentTimeline);
  const timelineEntries = asArray(timeline?.S).map(asRecord).filter((entry): entry is XmlNode => Boolean(entry));
  const segments: DashResource[] = [];
  if (timelineEntries.length) {
    let currentTime = 0;
    let number = startNumber;
    timelineEntries.forEach((entry, entryIndex) => {
      const duration = optionalNumber(entry.d);
      if (!duration || duration <= 0) throw new Error('A DASH SegmentTimeline entry has no positive duration.');
      currentTime = optionalNumber(entry.t) ?? currentTime;
      let repeat = optionalNumber(entry.r) ?? 0;
      if (!Number.isInteger(repeat) || repeat < -1) {
        throw new Error('A DASH SegmentTimeline repeat count is invalid.');
      }
      if (repeat < 0) {
        const nextStart = optionalNumber(timelineEntries[entryIndex + 1]?.t);
        const end = nextStart ?? (durationSeconds === undefined ? undefined : durationSeconds * timescale);
        if (end === undefined) throw new Error('An open-ended DASH SegmentTimeline needs a period duration.');
        repeat = Math.max(0, Math.ceil((end - currentTime) / duration) - 1);
      }
      if (segments.length + repeat + 1 > MAX_DASH_SEGMENTS_PER_TRACK) {
        throw new Error('The DASH track contains too many media segments.');
      }
      for (let index = 0; index <= repeat; index += 1) {
        const path = substituteTemplate(mediaTemplate, { ...values, number, time: currentTime });
        segments.push(resource(new URL(path, baseUrl).href));
        currentTime += duration;
        number += 1;
      }
    });
  } else {
    const segmentDuration = optionalNumber(template.duration);
    if (!segmentDuration || !durationSeconds) return undefined;
    const count = Math.ceil(durationSeconds * timescale / segmentDuration);
    if (count > MAX_DASH_SEGMENTS_PER_TRACK) {
      throw new Error('The DASH track contains too many media segments.');
    }
    for (let index = 0; index < count; index += 1) {
      const number = startNumber + index;
      const path = substituteTemplate(mediaTemplate, {
        ...values,
        number,
        time: index * segmentDuration,
      });
      segments.push(resource(new URL(path, baseUrl).href));
    }
  }
  return segments.length ? { initialization, segments } : undefined;
}

function listResources(
  list: XmlNode,
  baseUrl: string,
): { initialization: DashResource; segments: DashResource[] } | undefined {
  const initializationNode = asRecord(list.Initialization);
  if (!initializationNode) return undefined;
  const initializationUrl = optionalString(initializationNode?.sourceURL);
  const initialization = resource(
    initializationUrl ? new URL(initializationUrl, baseUrl).href : baseUrl,
    parseByteRange(initializationNode?.range),
  );
  const segments = asArray(list.SegmentURL).map(asRecord).filter((entry): entry is XmlNode => Boolean(entry)).map((entry) => {
    const media = optionalString(entry.media);
    return resource(media ? new URL(media, baseUrl).href : baseUrl, parseByteRange(entry.mediaRange));
  });
  return segments.length ? { initialization, segments } : undefined;
}

function baseResources(
  segmentBase: XmlNode,
  baseUrl: string,
): { initialization: DashResource; index: DashResource } | undefined {
  const initializationNode = asRecord(segmentBase.Initialization);
  const initializationRange = parseByteRange(initializationNode?.range);
  const indexRange = parseByteRange(segmentBase.indexRange);
  if (!initializationRange || !indexRange) return undefined;
  const initializationUrl = optionalString(initializationNode?.sourceURL);
  return {
    initialization: resource(
      initializationUrl ? new URL(initializationUrl, baseUrl).href : baseUrl,
      initializationRange,
    ),
    index: resource(baseUrl, indexRange),
  };
}

export function parseDashMediaSource(text: string, manifestUrl: string): DashMediaSource {
  const mpd = parseXml(text);
  const type = mpd.type === 'dynamic' ? 'dynamic' : 'static';
  const mpdDuration = parseIsoDuration(optionalString(mpd.mediaPresentationDuration));
  const mpdBaseUrl = resolvedBaseUrl(manifestUrl, mpd);
  const tracks: DashTrack[] = [];
  const periods = asArray(mpd.Period);
  if (periods.length > 1) throw new Error('Multi-period DASH manifests are not supported yet.');
  for (const periodValue of periods) {
    const period = asRecord(periodValue);
    if (!period) continue;
    const periodBaseUrl = resolvedBaseUrl(mpdBaseUrl, period);
    const periodDuration = parseIsoDuration(optionalString(period.duration)) ?? mpdDuration;
    for (const adaptationValue of asArray(period.AdaptationSet)) {
      const adaptation = asRecord(adaptationValue);
      if (!adaptation) continue;
      const adaptationBaseUrl = resolvedBaseUrl(periodBaseUrl, adaptation);
      for (const representationValue of asArray(adaptation.Representation)) {
        const representation = asRecord(representationValue);
        if (!representation) continue;
        const kind = trackKind(representation, adaptation);
        const id = optionalIdentifier(representation.id);
        if (!kind || !id) continue;
        const bandwidth = optionalNumber(representation.bandwidth);
        const representationBaseUrl = resolvedBaseUrl(adaptationBaseUrl, representation);
        const template = inheritedNode(adaptation, representation, 'SegmentTemplate');
        const list = inheritedNode(adaptation, representation, 'SegmentList');
        const segmentBase = inheritedNode(adaptation, representation, 'SegmentBase');
        const addressing = template
          ? templateResources(template, representationBaseUrl, id, bandwidth, periodDuration)
          : list
            ? listResources(list, representationBaseUrl)
            : segmentBase
              ? baseResources(segmentBase, representationBaseUrl)
              : undefined;
        if (!addressing) continue;
        const mimeType = optionalString(representation.mimeType ?? adaptation.mimeType);
        if (mimeType && mimeType.toLowerCase() !== `${kind}/mp4`) continue;
        const codecs = optionalString(representation.codecs ?? adaptation.codecs);
        const width = optionalNumber(representation.width);
        const height = optionalNumber(representation.height);
        const parsedFrameRate = frameRate(representation.frameRate ?? adaptation.frameRate);
        tracks.push({
          id,
          kind,
          initialization: addressing.initialization,
          ...('index' in addressing ? { index: addressing.index } : { segments: addressing.segments }),
          ...(bandwidth === undefined ? {} : { bandwidth }),
          ...(mimeType ? { mimeType } : {}),
          ...(codecs ? { codecs } : {}),
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
          ...(parsedFrameRate === undefined ? {} : { frameRate: parsedFrameRate }),
        });
      }
    }
  }
  return dashMediaSourceSchema.parse({
    type,
    ...(mpdDuration === undefined ? {} : { durationSeconds: mpdDuration }),
    hasContentProtection: hasProtection(mpd),
    tracks,
  });
}
