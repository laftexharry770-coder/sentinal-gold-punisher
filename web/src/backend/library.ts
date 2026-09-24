import type { ExpertLibraryStore, StoredExpert } from '@sentinal/engine';

const DB = 'sentinal';
const STORE = 'experts';
const FALLBACK_KEY = 'sentinal.experts.v1';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB would not open'));
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = act(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** localStorage, for browsers (and tests) without IndexedDB: fine for text EAs, tight for many .ex5 files. */
function localStorageStore(): ExpertLibraryStore {
  const all = (): Record<string, StoredExpert> => {
    try {
      return JSON.parse(globalThis.localStorage?.getItem(FALLBACK_KEY) ?? '{}') as Record<string, StoredExpert>;
    } catch {
      return {};
    }
  };
  const put = (map: Record<string, StoredExpert>) => {
    try {
      globalThis.localStorage?.setItem(FALLBACK_KEY, JSON.stringify(map));
    } catch {
      throw new Error("this browser's storage is full");
    }
  };
  return {
    load: async () => Object.values(all()),
    save: async (expert) => put({ ...all(), [expert.id]: expert }),
    remove: async (id) => {
      const map = all();
      delete map[id];
      put(map);
    },
  };
}

/**
 * Where this browser keeps the EA library: IndexedDB, which holds hundreds of
 * megabytes, so any number of EAs (and large .ex5 files) survive a reload.
 */
export function browserLibraryStore(): ExpertLibraryStore {
  if (typeof indexedDB === 'undefined') return localStorageStore();
  let db: Promise<IDBDatabase> | null = null;
  const database = () => (db ??= openDb());
  return {
    load: async () => run<StoredExpert[]>(await database(), 'readonly', (s) => s.getAll() as IDBRequest<StoredExpert[]>),
    save: async (expert) => {
      await run(await database(), 'readwrite', (s) => s.put(expert));
    },
    remove: async (id) => {
      await run(await database(), 'readwrite', (s) => s.delete(id));
    },
  };
}
