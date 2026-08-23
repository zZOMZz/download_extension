import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  directoryHandlesMatch,
  loadPersistedDirectoryHandle,
  persistDirectoryHandle,
  queryDirectoryPermission,
  requestDirectoryPermission,
} from '../src/browser/directory-handle-store';
import type { WritableDirectoryHandle } from '../src/browser/directory-output-writer';

function directory(
  name: string,
  options: {
    permission?: PermissionState;
    requestPermission?: PermissionState;
    matches?: (other: WritableDirectoryHandle) => boolean;
  } = {},
): WritableDirectoryHandle {
  return {
    name,
    getFileHandle: async () => { throw new Error('not used'); },
    removeEntry: async () => {},
    queryPermission: async () => options.permission ?? 'prompt',
    requestPermission: async () => options.requestPermission ?? options.permission ?? 'prompt',
    isSameEntry: async (other) => options.matches?.(other) ?? false,
  };
}

function fakeIndexedDb(): IDBFactory {
  const values = new Map<IDBValidKey, unknown>();
  let storeCreated = false;

  const makeRequest = <T>(operation: () => T, afterSuccess?: () => void): IDBRequest<T> => {
    const request = { result: undefined, error: null } as unknown as IDBRequest<T>;
    queueMicrotask(() => {
      try {
        (request as unknown as { result: T }).result = operation();
        request.onsuccess?.(new Event('success') as IDBRequestEventMap['success']);
        afterSuccess?.();
      } catch (cause) {
        (request as unknown as { error: DOMException }).error = new DOMException(String(cause));
        request.onerror?.(new Event('error') as IDBRequestEventMap['error']);
      }
    });
    return request;
  };

  const database = {
    objectStoreNames: { contains: () => storeCreated },
    createObjectStore: () => { storeCreated = true; },
    close: () => {},
    transaction: () => {
      const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
      } as unknown as IDBTransaction;
      const objectStore = {
        get: (key: IDBValidKey) => makeRequest(() => values.get(key)),
        put: (value: unknown, key: IDBValidKey) => makeRequest(() => {
          values.set(key, value);
          return key;
        }, () => queueMicrotask(() => transaction.oncomplete?.(new Event('complete')))),
      } as unknown as IDBObjectStore;
      (transaction as unknown as { objectStore(name: string): IDBObjectStore }).objectStore = () => objectStore;
      return transaction;
    },
  } as unknown as IDBDatabase;

  return {
    open: () => {
      const request = { result: database, error: null } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => {
        if (!storeCreated) request.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent);
        request.onsuccess?.(new Event('success') as IDBRequestEventMap['success']);
      });
      return request;
    },
  } as unknown as IDBFactory;
}

afterEach(() => vi.unstubAllGlobals());

describe('persisted output directory handles', () => {
  it('stores a directory handle and preserves its identity when the same folder is selected again', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDb());
    const first = directory('Downloads', { matches: (other) => other.name === 'Downloads' });
    const saved = await persistDirectoryHandle(first);
    const savedAgain = await persistDirectoryHandle(directory('Downloads'));

    expect(savedAgain.id).toBe(saved.id);
    expect((await loadPersistedDirectoryHandle())?.handle.name).toBe('Downloads');
  });

  it('queries and requests write permission only when necessary', async () => {
    const prompt = directory('Downloads', { permission: 'prompt', requestPermission: 'granted' });
    expect(await queryDirectoryPermission(prompt)).toBe('prompt');
    expect(await requestDirectoryPermission(prompt)).toBe('granted');
    expect(await queryDirectoryPermission(directory('Downloads', { permission: 'granted' }))).toBe('granted');
  });

  it('does not equate folders only because their display names match', async () => {
    expect(await directoryHandlesMatch(directory('Downloads'), directory('Downloads'))).toBe(false);
  });
});
