/** IndexedDB survives popup/worker shutdown and stores files without localStorage quotas. */
let database: Promise<IDBDatabase> | undefined;
function openStore() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('karl-device-data', 1);
    request.onupgradeneeded = () => {
      for (const name of ['outbox', 'cache', 'drafts']) request.result.createObjectStore(name, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
export async function deviceGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result?.value); request.onerror = () => reject(request.error);
  });
}
export async function deviceEntries<T>(store: string): Promise<{key: string; value: T}[]> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
export async function deviceChange<T>(store: string, key: string, transform: (value: T | undefined) => T | undefined): Promise<T | undefined> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite'), objects = transaction.objectStore(store);
    const read = objects.get(key); let result: T | undefined;
    read.onsuccess = () => {
      result = transform(read.result?.value);
      if (result === undefined) objects.delete(key); else objects.put({ key, value: result });
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Device storage could not be updated'));
  });
}
export const deviceSet = <T>(store: string, key: string, value: T) => deviceChange<T>(store, key, () => value);
