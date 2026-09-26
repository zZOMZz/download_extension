export interface TaskPoolResult<Result> {
  index: number;
  value: Result;
}

export interface TaskPoolOptions<Item, Result> {
  items: readonly Item[];
  concurrency: number;
  run: (item: Item, index: number) => Promise<Result>;
  shouldStop?: () => boolean;
}

export async function runTaskPool<Item, Result>({
  items,
  concurrency,
  run,
  shouldStop,
}: TaskPoolOptions<Item, Result>): Promise<Array<TaskPoolResult<Result>>> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Task pool concurrency must be a positive integer.');
  }

  const results: Array<TaskPoolResult<Result>> = [];
  let nextIndex = 0;
  const takeNext = (): { item: Item; index: number } | undefined => {
    if (shouldStop?.() || nextIndex >= items.length) return undefined;
    const index = nextIndex;
    nextIndex += 1;
    return { item: items[index]!, index };
  };

  const worker = async () => {
    while (true) {
      const next = takeNext();
      if (!next) return;
      results.push({ index: next.index, value: await run(next.item, next.index) });
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  // A failed worker must not release the caller's execution lock while peers still write.
  const settled = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results.sort((left, right) => left.index - right.index);
}
