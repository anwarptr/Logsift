import type { LiveDirHandle } from './watcher';

/**
 * The last opened folder's handle, kept in IndexedDB (handles can be stored there, not in
 * localStorage) so it can be reopened with one click; the browser asks again for permission.
 * Storage may be unavailable (private mode), so every access is guarded.
 */
const DB = 'logsift';
const STORE = 'handles';
const KEY = 'lastFolder';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    if (typeof indexedDB === 'undefined') return undefined;
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export async function loadSavedFolder(): Promise<LiveDirHandle | null> {
  const h = await run<unknown>('readonly', (s) => s.get(KEY));
  return h && typeof h === 'object' && (h as LiveDirHandle).kind === 'directory' ? (h as LiveDirHandle) : null;
}

export async function saveFolder(dir: LiveDirHandle): Promise<void> {
  await run('readwrite', (s) => s.put(dir, KEY));
}

/** Whether this browser can open folders (File System Access API). */
export const canOpenFolders = (): boolean => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/** Ask for the folder picker; null when cancelled. */
export async function pickFolder(): Promise<LiveDirHandle | null> {
  const w = window as unknown as { showDirectoryPicker(o?: { id?: string; mode?: 'read' }): Promise<LiveDirHandle> };
  try {
    return await w.showDirectoryPicker({ id: 'logsift-logs', mode: 'read' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/** Read permission for a remembered folder (prompts if needed; must run in a click handler). */
export async function ensureReadPermission(dir: LiveDirHandle): Promise<boolean> {
  try {
    if ((await dir.queryPermission?.({ mode: 'read' })) === 'granted') return true;
    return (await dir.requestPermission?.({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}
