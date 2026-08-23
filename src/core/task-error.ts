import {
  HttpStatusError,
  NetworkResourceError,
  NetworkTimeoutError,
} from './hls/download-hls';
import {
  diagnosticResource,
  sanitizeDiagnosticText,
  type DownloadFailure,
} from '../shared/task-diagnostics';

function causes(error: unknown): Error[] {
  const result: Error[] = [];
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    result.push(current);
    current = current.cause;
  }
  return result;
}

function baseFailure(
  error: unknown,
  category: DownloadFailure['category'],
  code: string,
  recoverable: boolean,
): DownloadFailure {
  const top = error instanceof Error ? error : new Error(String(error));
  return {
    category,
    code,
    message: sanitizeDiagnosticText(top.message),
    recoverable,
    occurredAt: Date.now(),
    causeName: top.name,
  };
}

export function classifyTaskError(error: unknown): DownloadFailure {
  const chain = causes(error);
  const networkResource = chain.find((item): item is NetworkResourceError => item instanceof NetworkResourceError);
  const http = chain.find((item): item is HttpStatusError => item instanceof HttpStatusError);
  const timeout = chain.find((item): item is NetworkTimeoutError => item instanceof NetworkTimeoutError);

  if (chain.some(({ name }) => name === 'AbortError')) {
    return baseFailure(error, 'cancelled', 'cancelled', false);
  }

  if (networkResource) {
    const resource = diagnosticResource(networkResource.resourceUrl);
    if (http) {
      return {
        ...baseFailure(error, 'http', `http-${http.status}`, networkResource.recoverable),
        ...resource,
        httpStatus: http.status,
        resourceKind: networkResource.resourceKind,
      };
    }
    if (timeout) {
      return {
        ...baseFailure(error, 'timeout', 'network-timeout', networkResource.recoverable),
        ...resource,
        resourceKind: networkResource.resourceKind,
      };
    }
    return {
      ...baseFailure(error, 'network', 'network-request-failed', networkResource.recoverable),
      ...resource,
      resourceKind: networkResource.resourceKind,
    };
  }

  const message = chain.map(({ message: value }) => value).join(' ').toLowerCase();
  if (message.includes('expired') || message.includes('signature') || message.includes('token')) {
    return baseFailure(error, 'source', 'source-expired', true);
  }
  if (message.includes('aes') || message.includes('decrypt') || message.includes('encryption key')) {
    return baseFailure(error, 'encryption', 'encryption-failed', false);
  }
  if (
    message.includes('file') ||
    message.includes('folder') ||
    message.includes('directory') ||
    message.includes('checkpoint')
  ) {
    return baseFailure(error, 'filesystem', 'filesystem-failed', false);
  }
  if (message.includes('mp4') || message.includes('mux') || message.includes('writer') || message.includes('output')) {
    return baseFailure(error, 'output', 'output-failed', false);
  }
  if (message.includes('unsupported') || message.includes('not supported')) {
    return baseFailure(error, 'unsupported', 'unsupported-media', false);
  }
  if (message.includes('playlist') || message.includes('manifest') || message.includes('m3u8')) {
    return baseFailure(error, 'manifest', 'manifest-invalid', false);
  }
  return baseFailure(error, 'unknown', 'unknown', false);
}
