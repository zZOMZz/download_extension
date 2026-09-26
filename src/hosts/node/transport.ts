import type { Transport } from '../../core/network/transport';

/** Node has no browser cookie jar. A separate authenticated transport must be supplied explicitly. */
export function createNodeTransport(fetchImplementation: typeof globalThis.fetch = globalThis.fetch): Transport {
  return {
    fetch(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('The Node download host only supports HTTP and HTTPS sources.');
      }
      return fetchImplementation(input, { ...init, credentials: 'omit' });
    },
  };
}
