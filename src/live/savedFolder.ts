import type { LiveDirHandle, LiveFileHandle } from './watcher';

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

/** Whether this browser can pick individual file handles to watch (File System Access API). */
export const canOpenFilesWithHandles = (): boolean => typeof window !== 'undefined' && 'showOpenFilePicker' in window;

/** Ask for file handles to watch live; null when cancelled. */
export async function pickFilesToWatch(): Promise<LiveFileHandle[] | null> {
  const w = (typeof window !== 'undefined' ? window : globalThis) as unknown as {
    showOpenFilePicker(o?: {
      id?: string;
      mode?: 'read';
      multiple?: boolean;
      types?: { description: string; accept: Record<string, string[]> }[];
    }): Promise<LiveFileHandle[]>;
  };
  try {
    return await w.showOpenFilePicker({
      id: 'logsift-files',
      mode: 'read',
      multiple: true,
      types: [
        {
          description: 'Log and text files',
          accept: {
            'text/*': ['.log', '.txt', '.json', '.jsonl', '.ndjson', '.clef', '.xml', '.csv', '.tsv', '.out', '.err', '.trace'],
          },
        },
        {
          description: 'All files',
          accept: {
            '*/*': [],
          },
        },
      ],
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/** Ask for the folder picker; null when cancelled. */
export async function pickFolder(): Promise<LiveDirHandle | null> {
  const w = (typeof window !== 'undefined' ? window : globalThis) as unknown as { showDirectoryPicker(o?: { id?: string; mode?: 'read' }): Promise<LiveDirHandle> };
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
