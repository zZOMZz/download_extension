import { describe, expect, it } from 'vitest';
import {
  HttpStatusError,
  NetworkResourceError,
  NetworkTimeoutError,
} from '../src/core/hls/download-hls';
import { classifyTaskError } from '../src/core/task-error';
import { OutputValidationError } from '../src/core/media/output-validator';

describe('task error classification', () => {
  it('extracts an HTTP status and strips signed query parameters', () => {
    const failure = classifyTaskError(new NetworkResourceError(
      'media-segment',
      'https://cdn.example/video/12.ts?sign=secret&token=private',
      4,
      true,
      new HttpStatusError(503, undefined),
    ));

    expect(failure).toMatchObject({
      category: 'http',
      code: 'http-503',
      recoverable: true,
      httpStatus: 503,
      resourceKind: 'media-segment',
      resourceHost: 'cdn.example',
      resourcePath: '/video/12.ts',
    });
    expect(JSON.stringify(failure)).not.toContain('secret');
  });

  it('redacts query parameters from URLs embedded in generic error messages', () => {
    const failure = classifyTaskError(new Error(
      'Request failed at https://cdn.example/index.m3u8?token=secret.',
    ));
    expect(failure.message).toContain('https://cdn.example/index.m3u8.');
    expect(failure.message).not.toContain('secret');
  });

  it('distinguishes timeouts, filesystem errors, and cancellation', () => {
    expect(classifyTaskError(new NetworkResourceError(
      'text',
      'https://cdn.example/index.m3u8',
      2,
      true,
      new NetworkTimeoutError('idle timeout'),
    )).category).toBe('timeout');
    expect(classifyTaskError(new Error('The partial file is shorter than its checkpoint.')).category).toBe('filesystem');
    expect(classifyTaskError(new DOMException('cancelled', 'AbortError')).category).toBe('cancelled');
  });

  it('preserves structured output validation error codes', () => {
    expect(classifyTaskError(new OutputValidationError(
      'missing-video-track',
      'The MP4 output does not contain a video track.',
    ))).toMatchObject({
      category: 'output',
      code: 'missing-video-track',
      recoverable: false,
    });
  });
});
