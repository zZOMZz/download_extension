import type { CandidateObservation } from '../../../shared/media';

export interface MediaDetectionAdapter {
  id: string;
  matches(pageUrl: URL): boolean;
  ownsResource?(resourceUrl: URL, pageUrl: URL): boolean;
  detect(document: Document, pageUrl: URL): CandidateObservation[];
}
