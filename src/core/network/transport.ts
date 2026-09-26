/** Host-owned HTTP implementation. Session credentials and headers belong to the host. */
export interface Transport {
  fetch: typeof globalThis.fetch;
}

/** Preserve extension/browser request credentials for callers that do not inject a host. */
export const browserTransport: Transport = {
  fetch(input, init) {
    return globalThis.fetch(input, { credentials: 'include', ...init });
  },
};
