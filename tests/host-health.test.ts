import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpStatusError } from '../src/core/hls/download-hls';
import { HostHealthController } from '../src/core/network/host-health';

afterEach(() => {
  vi.useRealTimers();
});

describe('per-host request health control', () => {
  it('limits concurrent requests independently for each host', async () => {
    const controller = new HostHealthController({ maxConcurrency: 2 });
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const operation = () => new Promise<number>((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      releases.push(() => {
        active -= 1;
        resolve(active);
      });
    });

    const requests = [1, 2, 3].map(() => controller.run('https://cdn.example/segment.ts', operation));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()?.();
    releases.shift()?.();
    await Promise.all(requests);

    expect(maximumActive).toBe(2);
  });

  it('reduces concurrency after retryable failures and gradually recovers', async () => {
    const changes: number[] = [];
    const controller = new HostHealthController({
      maxConcurrency: 4,
      circuitFailureThreshold: 10,
      recoverySuccessThreshold: 2,
      onChange: (snapshots) => changes.push(snapshots[0]?.concurrencyLimit ?? 4),
    });
    const fail = () => controller.run('https://cdn.example/segment.ts', async () => {
      throw new HttpStatusError(503, undefined);
    });

    await expect(fail()).rejects.toThrow('HTTP 503');
    await expect(fail()).rejects.toThrow('HTTP 503');
    expect(controller.snapshots()[0]?.concurrencyLimit).toBe(1);

    await controller.run('https://cdn.example/segment.ts', async () => 'ok');
    await controller.run('https://cdn.example/segment.ts', async () => 'ok');
    expect(controller.snapshots()[0]?.concurrencyLimit).toBe(2);
    expect(changes).toContain(1);
  });

  it('holds new requests during a circuit-breaker cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const controller = new HostHealthController({
      maxConcurrency: 2,
      circuitFailureThreshold: 2,
      cooldownMs: 5_000,
    });
    const fail = () => controller.run('https://cdn.example/segment.ts', async () => {
      throw new HttpStatusError(503, undefined);
    });
    await expect(fail()).rejects.toThrow();
    await expect(fail()).rejects.toThrow();

    const operation = vi.fn(async () => 'ok');
    const pending = controller.run('https://cdn.example/segment.ts', operation);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBe('ok');
  });

  it('does not throttle a host for permanent client errors', async () => {
    const controller = new HostHealthController({ maxConcurrency: 4 });
    await expect(controller.run('https://cdn.example/missing.ts', async () => {
      throw new HttpStatusError(404, undefined);
    })).rejects.toThrow('HTTP 404');
    expect(controller.snapshots()).toEqual([]);
  });
});
