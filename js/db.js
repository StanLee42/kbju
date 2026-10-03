// Обёртка над IndexedDB. Хранилища объявлены все сразу, включая те, что
// понадобятся на следующих этапах: так не придётся делать миграции.
const DB_NAME = 'kbju';
const DB_VERSION = 1;
const STORES = ['entries', 'settings', 'dishes', 'measurements', 'usage'];

let dbPromise = null;

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: 'id' });
        if (name === 'entries') store.createIndex('date', 'date');
        if (name === 'usage') store.createIndex('at', 'at');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function db() {
  if (!dbPromise) dbPromise = open();
  return dbPromise;
}

function run(storeName, mode, action) {
  return db().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try {
      result = action(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export function put(storeName, value) {
  return run(storeName, 'readwrite', (store) => store.put(value)).then(() => value);
}

export function putAll(storeName, values) {
  return run(storeName, 'readwrite', (store) => {
    for (const value of values) store.put(value);
    return null;
  });
}

export function get(storeName, id) {
  return run(storeName, 'readonly', (store) => store.get(id));
}

export function remove(storeName, id) {
  return run(storeName, 'readwrite', (store) => store.delete(id));
}

export function all(storeName) {
  return run(storeName, 'readonly', (store) => store.getAll());
}

export function byIndex(storeName, indexName, value) {
  return run(storeName, 'readonly', (store) => store.index(indexName).getAll(value));
}

export function clearStore(storeName) {
  return run(storeName, 'readwrite', (store) => store.clear());
}

export async function wipeEverything() {
  const names = STORES;
  for (const name of names) await clearStore(name);
}

export async function usageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

/** Просим постоянное хранилище, чтобы Chrome не вычистил дневник. */
export async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return null;
  if (await navigator.storage.persisted?.()) return true;
  try {
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export async function isStoragePersistent() {
  if (!navigator.storage || !navigator.storage.persisted) return null;
  try {
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}
