import { describe, expect, it } from 'vitest';
import { isExpiredDashResourceError } from '../src/core/dash/source-refresh';
import {
  HttpStatusError,
  NetworkResourceError,
} from '../src/core/hls/download-hls';

function resourceError(status: number): NetworkResourceError {
  return new NetworkResourceError(
    'media-segment',
    'https://cdn.example/media.m4s?token=secret',
    1,
    true,
    new HttpStatusError(status, undefined),
  );
}

describe('DASH source refresh classification', () => {
  it('refreshes authorization failures from a DASH resource request', () => {
    expect(isExpiredDashResourceError(resourceError(401))).toBe(true);
    expect(isExpiredDashResourceError(new Error('all CDNs failed', {
      cause: resourceError(403),
    }))).toBe(true);
  });

  it('does not refresh unrelated HTTP or unscoped authorization failures', () => {
    expect(isExpiredDashResourceError(resourceError(404))).toBe(false);
    expect(isExpiredDashResourceError(new HttpStatusError(403, undefined))).toBe(false);
    expect(isExpiredDashResourceError(new TypeError('Failed to fetch'))).toBe(false);
  });
});
