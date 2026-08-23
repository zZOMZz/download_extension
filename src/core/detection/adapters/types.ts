import type { CandidateObservation } from '../../../shared/media';

export interface MediaDetectionAdapter {
  id: string;
  matches(pageUrl: URL): boolean;
  detect(document: Document, pageUrl: URL): CandidateObservation[];
}
