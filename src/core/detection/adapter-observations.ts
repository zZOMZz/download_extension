import { candidateIdentity, type CandidateObservation } from '../../shared/media';

/** Report refreshed adapter data while suppressing identical scans of the current page. */
export function createAdapterObservationReporter(
  sendObservation: (candidate: CandidateObservation) => Promise<unknown>,
): (pageUrl: string, candidates: CandidateObservation[]) => void {
  let currentPage: string | undefined;
  const reported = new Map<string, { fingerprint: string }>();

  return (pageUrl, candidates) => {
    if (pageUrl !== currentPage) {
      currentPage = pageUrl;
      reported.clear();
    }

    for (const candidate of candidates) {
      const identity = candidateIdentity(candidate);
      const fingerprint = JSON.stringify(candidate);
      if (reported.get(identity)?.fingerprint === fingerprint) continue;

      const observation = { fingerprint };
      reported.set(identity, observation);
      void sendObservation(candidate).catch(() => {
        // A rejected older request must not erase a newer update or page visit.
        if (reported.get(identity) === observation) reported.delete(identity);
      });
    }
  };
}
