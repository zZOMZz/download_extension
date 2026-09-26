const WINDOW_MS = 5_000;
const MIN_SAMPLE_MS = 250;

/** Throughput belongs to the transfer, not to an individual segment or phase. */
export class NetworkSpeedTracker {
  private readonly startedAt = Date.now();
  private readonly samples = [{ at: this.startedAt, bytes: 0 }];
  totalBytes = 0;

  record(bytes: number): void {
    this.totalBytes += bytes;
  }

  sample(): { current: number; average: number } {
    const now = Math.max(Date.now(), this.samples.at(-1)!.at);
    this.samples.push({ at: now, bytes: this.totalBytes });
    const cutoff = now - WINDOW_MS;
    while (this.samples.length > 2 && this.samples[1]!.at <= cutoff) this.samples.shift();

    const oldest = this.samples[0]!;
    const next = this.samples[1]!;
    // Interpolate the window boundary so old bursts age out without counting
    // all of a partially overlapping sample (or retaining a stale nonzero rate).
    const start = Math.max(oldest.at, cutoff);
    const baseline = oldest.at < start && next.at > oldest.at
      ? oldest.bytes + (next.bytes - oldest.bytes) * (start - oldest.at) / (next.at - oldest.at)
      : oldest.bytes;
    return {
      current: Math.max(0, this.totalBytes - baseline) * 1_000 / Math.max(MIN_SAMPLE_MS, now - start),
      average: this.totalBytes * 1_000 / Math.max(1, now - this.startedAt),
    };
  }
}
