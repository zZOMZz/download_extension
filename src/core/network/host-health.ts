export interface HostHealthSnapshot {
  host: string;
  concurrencyLimit: number;
  maxConcurrency: number;
  consecutiveFailures: number;
  blockedUntil?: number;
}

export interface NetworkRequestCoordinator {
  run<T>(url: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

interface HostState {
  activeRequests: number;
  concurrencyLimit: number;
  consecutiveFailures: number;
  recoverySuccesses: number;
  blockedUntil: number;
  waiters: Set<() => void>;
}

interface HostHealthControllerOptions {
  maxConcurrency: number;
  circuitFailureThreshold?: number;
  cooldownMs?: number;
  recoverySuccessThreshold?: number;
  onChange?: (snapshots: HostHealthSnapshot[]) => void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The request was cancelled.', 'AbortError');
}

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host || '[unknown host]';
  } catch {
    return '[unknown host]';
  }
}

function retryableHostFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (error.name === 'AbortError') return false;
  if (error.name === 'NetworkTimeoutError' || error.name === 'TypeError') return true;
  if (error.name !== 'HttpStatusError') return true;
  const status = (error as Error & { status?: unknown }).status;
  return typeof status === 'number' && (status === 408 || status === 425 || status === 429 || status >= 500);
}

export class HostHealthController implements NetworkRequestCoordinator {
  private readonly maxConcurrency: number;
  private readonly circuitFailureThreshold: number;
  private readonly cooldownMs: number;
  private readonly recoverySuccessThreshold: number;
  private readonly onChange: ((snapshots: HostHealthSnapshot[]) => void) | undefined;
  private readonly states = new Map<string, HostState>();

  constructor(options: HostHealthControllerOptions) {
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency));
    this.circuitFailureThreshold = Math.max(2, Math.floor(options.circuitFailureThreshold ?? 4));
    this.cooldownMs = Math.max(0, options.cooldownMs ?? 30_000);
    this.recoverySuccessThreshold = Math.max(1, Math.floor(options.recoverySuccessThreshold ?? 8));
    this.onChange = options.onChange;
  }

  snapshots(): HostHealthSnapshot[] {
    return [...this.states.entries()]
      .map(([host, state]) => ({
        host,
        concurrencyLimit: state.concurrencyLimit,
        maxConcurrency: this.maxConcurrency,
        consecutiveFailures: state.consecutiveFailures,
        ...(state.blockedUntil > Date.now() ? { blockedUntil: state.blockedUntil } : {}),
      }))
      .filter(({ concurrencyLimit, maxConcurrency, consecutiveFailures, blockedUntil }) =>
        concurrencyLimit < maxConcurrency || consecutiveFailures > 0 || blockedUntil !== undefined)
      .sort((left, right) => left.host.localeCompare(right.host));
  }

  async run<T>(url: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const host = hostOf(url);
    const state = this.state(host);
    const release = await this.acquire(state, signal);
    try {
      const result = await operation();
      this.recordSuccess(state);
      return result;
    } catch (cause) {
      if (retryableHostFailure(cause)) this.recordFailure(state);
      throw cause;
    } finally {
      release();
    }
  }

  private state(host: string): HostState {
    const existing = this.states.get(host);
    if (existing) return existing;
    const created: HostState = {
      activeRequests: 0,
      concurrencyLimit: this.maxConcurrency,
      consecutiveFailures: 0,
      recoverySuccesses: 0,
      blockedUntil: 0,
      waiters: new Set(),
    };
    this.states.set(host, created);
    return created;
  }

  private async acquire(state: HostState, signal?: AbortSignal): Promise<() => void> {
    while (true) {
      if (signal?.aborted) throw abortReason(signal);
      const cooldownRemaining = state.blockedUntil - Date.now();
      if (cooldownRemaining > 0) {
        await this.wait(state, cooldownRemaining, signal);
        continue;
      }
      if (state.activeRequests < state.concurrencyLimit) {
        state.activeRequests += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          state.activeRequests = Math.max(0, state.activeRequests - 1);
          this.wake(state);
        };
      }
      await this.wait(state, undefined, signal);
    }
  }

  private wait(state: HostState, delayMs: number | undefined, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer !== undefined) clearTimeout(timer);
        state.waiters.delete(finish);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        if (timer !== undefined) clearTimeout(timer);
        state.waiters.delete(finish);
        signal?.removeEventListener('abort', onAbort);
        reject(signal ? abortReason(signal) : new DOMException('The request was cancelled.', 'AbortError'));
      };
      state.waiters.add(finish);
      if (delayMs !== undefined) timer = setTimeout(finish, delayMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private wake(state: HostState): void {
    for (const waiter of [...state.waiters]) waiter();
  }

  private recordFailure(state: HostState): void {
    state.consecutiveFailures += 1;
    state.recoverySuccesses = 0;
    const previousLimit = state.concurrencyLimit;
    state.concurrencyLimit = Math.max(1, Math.floor(state.concurrencyLimit / 2));
    if (state.consecutiveFailures >= this.circuitFailureThreshold) {
      state.blockedUntil = Math.max(state.blockedUntil, Date.now() + this.cooldownMs);
    }
    if (state.concurrencyLimit !== previousLimit || state.consecutiveFailures >= this.circuitFailureThreshold) {
      this.emit();
    }
  }

  private recordSuccess(state: HostState): void {
    const wasUnhealthy = state.consecutiveFailures > 0 || state.blockedUntil > 0;
    state.consecutiveFailures = 0;
    state.blockedUntil = 0;
    if (state.concurrencyLimit < this.maxConcurrency) {
      state.recoverySuccesses += 1;
      if (state.recoverySuccesses >= this.recoverySuccessThreshold) {
        state.concurrencyLimit += 1;
        state.recoverySuccesses = 0;
        this.emit();
      } else if (wasUnhealthy) {
        this.emit();
      }
    } else {
      state.recoverySuccesses = 0;
      if (wasUnhealthy) this.emit();
    }
    this.wake(state);
  }

  private emit(): void {
    this.onChange?.(this.snapshots());
  }
}
