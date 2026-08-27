import { browser } from 'wxt/browser';
import { shouldIncludeMediaCandidate } from '~/src/core/detection/filter-candidate';
import { candidateIdentity, mediaCandidateSchema } from '~/src/shared/media';
import type { CandidateObservation, MediaCandidate } from '~/src/shared/media';

const queues = new Map<number, Promise<void>>();

function storageKey(tabId: number): string {
  return `media-candidates:${tabId}`;
}

async function read(tabId: number): Promise<MediaCandidate[]> {
  const key = storageKey(tabId);
  const stored = await browser.storage.session.get(key);
  const parsed = mediaCandidateSchema.array().safeParse(stored[key]);
  return parsed.success ? parsed.data : [];
}

function enqueue(tabId: number, operation: () => Promise<void>): Promise<void> {
  const previous = queues.get(tabId) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  queues.set(tabId, next);
  void next.then(() => {
    if (queues.get(tabId) === next) queues.delete(tabId);
  }, () => {
    if (queues.get(tabId) === next) queues.delete(tabId);
  });
  return next;
}

export async function listCandidates(tabId: number): Promise<MediaCandidate[]> {
  await queues.get(tabId);
  return (await read(tabId)).filter(shouldIncludeMediaCandidate);
}

export async function findCandidate(tabId: number, candidateId: string): Promise<MediaCandidate | null> {
  const candidates = await listCandidates(tabId);
  return candidates.find((candidate) => candidate.id === candidateId) ?? null;
}

export function upsertCandidate(
  tabId: number,
  frameId: number,
  observation: CandidateObservation,
): Promise<void> {
  if (!shouldIncludeMediaCandidate(observation)) return Promise.resolve();

  return enqueue(tabId, async () => {
    const candidates = await read(tabId);
    const identity = candidateIdentity(observation);
    const existingIndex = candidates.findIndex(
      (candidate) => candidateIdentity(candidate) === identity,
    );

    if (existingIndex >= 0) {
      const existing = candidates[existingIndex];
      if (!existing) return;
      candidates[existingIndex] = {
        ...existing,
        ...observation,
        id: existing.id,
        tabId,
        frameId,
        detectedAt: existing.detectedAt,
      };
    } else {
      candidates.push({
        ...observation,
        id: crypto.randomUUID(),
        tabId,
        frameId,
        detectedAt: Date.now(),
      });
    }

    candidates.sort((left, right) => right.detectedAt - left.detectedAt);
    await browser.storage.session.set({ [storageKey(tabId)]: candidates.slice(0, 100) });
  });
}

export function clearCandidates(tabId: number): Promise<void> {
  return enqueue(tabId, () => browser.storage.session.remove(storageKey(tabId)));
}
