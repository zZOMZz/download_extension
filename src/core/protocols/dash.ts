import { XMLParser } from 'fast-xml-parser';

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

function hasProtection(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasProtection);
  const record = asRecord(node);
  if (!record) return false;
  if ('ContentProtection' in record) return true;
  return Object.values(record).some(hasProtection);
}

export function parseDashManifest(text: string): DashManifestSummary {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: true,
  });
  const root = asRecord(parser.parse(text));
  const mpd = asRecord(root?.MPD);
  if (!mpd) throw new Error('This response is not a DASH MPD.');

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
        const id = optionalString(representation.id);
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
