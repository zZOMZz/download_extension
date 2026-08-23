import type { WritableDirectoryHandle } from './directory-output-writer';

const DATABASE_NAME = 'open-media-downloader';
const DATABASE_VERSION = 1;
const STORE_NAME = 'file-system-handles';
const OUTPUT_DIRECTORY_KEY = 'output-directory';

export interface PersistedDirectoryHandle {
  id: string;
  handle: WritableDirectoryHandle;
  savedAt: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open the directory handle database.'));
    request.onblocked = () => reject(new Error('The directory handle database upgrade was blocked.'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The directory handle database request failed.'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('The directory handle transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('The directory handle transaction was aborted.'));
  });
}

function isDirectoryHandle(value: unknown): value is WritableDirectoryHandle {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WritableDirectoryHandle>;
  return typeof candidate.name === 'string' &&
    typeof candidate.getFileHandle === 'function' &&
    typeof candidate.removeEntry === 'function';
}

function isPersistedDirectoryHandle(value: unknown): value is PersistedDirectoryHandle {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedDirectoryHandle>;
  return typeof candidate.id === 'string' &&
    Number.isFinite(candidate.savedAt) &&
    isDirectoryHandle(candidate.handle);
}

export async function loadPersistedDirectoryHandle(): Promise<PersistedDirectoryHandle | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const value: unknown = await requestResult(transaction.objectStore(STORE_NAME).get(OUTPUT_DIRECTORY_KEY));
    return isPersistedDirectoryHandle(value) ? value : null;
  } finally {
    database.close();
  }
}

export async function directoryHandlesMatch(
  left: WritableDirectoryHandle,
  right: WritableDirectoryHandle,
): Promise<boolean> {
  if (left === right) return true;
  if (left.isSameEntry) {
    try {
      return await left.isSameEntry(right);
    } catch {
      return false;
    }
  }
  if (right.isSameEntry) {
    try {
      return await right.isSameEntry(left);
    } catch {
      return false;
    }
  }
  return false;
}

export async function persistDirectoryHandle(
  handle: WritableDirectoryHandle,
): Promise<PersistedDirectoryHandle> {
  const previous = await loadPersistedDirectoryHandle();
  const sameDirectory = previous ? await directoryHandlesMatch(previous.handle, handle) : false;
  const record: PersistedDirectoryHandle = {
    id: sameDirectory ? previous!.id : crypto.randomUUID(),
    handle,
    savedAt: Date.now(),
  };
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const completed = transactionComplete(transaction);
    await Promise.all([
      requestResult(transaction.objectStore(STORE_NAME).put(record, OUTPUT_DIRECTORY_KEY)),
      completed,
    ]);
    return record;
  } finally {
    database.close();
  }
}

export async function queryDirectoryPermission(
  handle: WritableDirectoryHandle,
): Promise<PermissionState> {
  if (!handle.queryPermission) return 'prompt';
  return handle.queryPermission({ mode: 'readwrite' });
}

export async function requestDirectoryPermission(
  handle: WritableDirectoryHandle,
): Promise<PermissionState> {
  const current = await queryDirectoryPermission(handle);
  if (current === 'granted') return current;
  if (!handle.requestPermission) return current;
  return handle.requestPermission({ mode: 'readwrite' });
}
