import type { CandidateObservation } from '../../../shared/media';

export interface MediaDetectionContext {
  observedResourceUrls?: readonly string[];
}

export interface MediaDetectionAdapter {
  id: string;
  matches(pageUrl: URL): boolean;
  claimsResource?(resourceUrl: URL): boolean;
  ownsResource?(resourceUrl: URL, pageUrl: URL): boolean;
  suppressesGenericMedia?(pageUrl: URL): boolean;
  detect(
    document: Document,
    pageUrl: URL,
    context?: MediaDetectionContext,
  ): CandidateObservation[];
}
