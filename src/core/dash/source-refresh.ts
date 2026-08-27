import {
  HttpStatusError,
  NetworkResourceError,
} from '../hls/download-hls';

function errorChain(error: unknown): Error[] {
  const result: Error[] = [];
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    result.push(current);
    current = current.cause;
  }
  return result;
}

export function isExpiredDashResourceError(error: unknown): boolean {
  const chain = errorChain(error);
  return chain.some((item) => item instanceof NetworkResourceError) &&
    chain.some((item) => item instanceof HttpStatusError && (item.status === 401 || item.status === 403));
}
