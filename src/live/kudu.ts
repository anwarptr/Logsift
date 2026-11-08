import type { LiveDirHandle, LiveFileHandle } from './watcher';

/**
 * Azure App Service through Kudu, without the Azure CLI: the "Logsift for Kudu" bookmarklet runs in
 * the app's Kudu tab (https://<app>.scm.azurewebsites.net), where the user is signed in, and opens
 * Logsift. Logsift asks it, by postMessage, to list folders and read parts of files with Kudu's VFS API;
 * the Kudu tab does the requests and answers. Nothing goes anywhere but between the two tabs.
 *
 * Here: the Logsift end. It only talks to the window that opened it, only when that is a Kudu site,
 * and only asks to list and read (the bookmarklet only does those either).
 */

/** Kudu sites: <app>.scm.azurewebsites.net, or with a region (<app>-<hash>.scm.<region>.azurewebsites.net). */
export const KUDU_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.scm\.(?:[a-z0-9-]+\.)?azurewebsites\.net$/i;

export interface KuduEntry {
  name: string;
  size: number;
  /** Modified time (ms). */
  mtime: number;
  dir: boolean;
}

/** The minimal window interface the bridge uses (so tests can pass fakes). */
export interface BridgeWindow {
  postMessage(message: unknown, targetOrigin: string): void;
  closed?: boolean;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const CALL_TIMEOUT_MS = 30_000;

/** The connection to the bookmarklet in the Kudu tab. */
export class KuduBridge {
  /** The Kudu site's origin, once it said hello. */
  origin: string | null = null;
  app: string | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private helloWaiters: ((ok: boolean) => void)[] = [];
  private readonly onMessage = (e: MessageEvent) => this.receive(e);

  constructor(
    private readonly opener: BridgeWindow,
    private readonly win: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  ) {
    win.addEventListener('message', this.onMessage as EventListener);
  }

  /** Ask the Kudu tab to say hello; resolves true once it did (false after `timeoutMs`). */
  connect(timeoutMs = 10_000): Promise<boolean> {
    if (this.origin) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.helloWaiters.push(resolve);
      // The origin isn't known yet: the ping carries nothing, the answer is checked.
      const ping = () => this.opener.postMessage({ type: 'logsift-ready' }, '*');
      ping();
      const retry = setInterval(() => (this.origin ? clearInterval(retry) : ping()), 500);
      setTimeout(() => {
        clearInterval(retry);
        if (!this.origin) {
          this.helloWaiters = this.helloWaiters.filter((w) => w !== resolve);
          resolve(false);
        }
      }, timeoutMs);
    });
  }

  get connected(): boolean {
    return this.origin !== null && !this.opener.closed;
  }

  close(): void {
    this.win.removeEventListener('message', this.onMessage as EventListener);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('closed'));
    }
    this.pending.clear();
  }

  private receive(e: MessageEvent): void {
    if (e.source !== (this.opener as unknown) || !KUDU_ORIGIN_RE.test(e.origin)) return;
    const m = e.data as { type?: string; id?: number; ok?: boolean; data?: unknown; error?: string; app?: string } | null;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'logsift-hello') {
      if (this.origin && this.origin !== e.origin) return;
      this.origin = e.origin;
      this.app = typeof m.app === 'string' ? m.app : new URL(e.origin).hostname.split('.')[0]!;
      for (const w of this.helloWaiters) w(true);
      this.helloWaiters = [];
      return;
    }
    if (m.type !== 'logsift-reply' || e.origin !== this.origin || typeof m.id !== 'number') return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.data);
    else p.reject(new Error(m.error ?? 'failed'));
  }

  private call<T>(op: 'list' | 'read', args: Record<string, unknown>): Promise<T> {
    if (!this.origin) return Promise.reject(new Error('not connected to Kudu'));
    if (this.opener.closed) return Promise.reject(new Error('the Kudu tab was closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Kudu did not answer'));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.opener.postMessage({ type: 'logsift-call', id, op, ...args }, this.origin!);
    });
  }

  /** Entries of a folder (a path under the site's home, like "LogFiles/Application"). */
  async list(path: string): Promise<KuduEntry[]> {
    const raw = await this.call<unknown>('list', { path });
    if (!Array.isArray(raw)) throw new Error('unexpected answer from Kudu');
    return raw
      .filter((x): x is { name: string; size?: number; mtime?: string | number; dir?: boolean } => !!x && typeof x.name === 'string')
      .map((x) => ({
        name: x.name,
        size: typeof x.size === 'number' ? x.size : 0,
        // Kudu writes 7 fractional digits (2026-11-05T08:40:01.1234567+00:00); Date.parse wants at most 3.
        mtime: typeof x.mtime === 'number' ? x.mtime : Date.parse(String(x.mtime).replace(/(\.\d{3})\d+/, '$1')) || 0,
        dir: x.dir === true,
      }));
  }

  /** Bytes [start, end) of a file. */
  async read(path: string, start: number, end: number): Promise<ArrayBuffer> {
    if (end <= start) return new ArrayBuffer(0);
    const data = await this.call<unknown>('read', { path, start, end });
    if (!(data instanceof ArrayBuffer)) throw new Error('unexpected answer from Kudu');
    return data;
  }
}

const LOG_EXT_RE = /\.(log|txt|csv|tsv|json|jsonl|ndjson|clef|xml|gz|zip)$/i;
/** Names of settings, keys and secrets files, never read even when their type is allowed. */
const SECRET_NAME_RE =
  /(appsettings|settings|web\.config|\.config$|^\.env|secret|password|passwd|connection-?string|credential|private|(^|[-_.])(keys?|tokens?)[-_.])/i;
/** A folder named as a log folder: "log", "logs", or ending in one after a separator ("app-logs", "App_Log"). */
const LOG_DIR_RE = /^(.*[-_. ])?logs?$/i;

/** Path segments: no "..", no "." and none made of dots and spaces only (".. " is ".." to some file systems). */
const segmentsOf = (path: string): string[] | null => {
  const segments = path.split('/').filter(Boolean);
  return segments.some((s) => /^[. ]+$/.test(s)) ? null : segments;
};

const isLogDir = (segments: string[]) => segments[0] === 'LogFiles' || segments.some((s) => LOG_DIR_RE.test(s));

/**
 * Whether a folder on the App Service may be listed, which is all the bookmarklet lists (it has the same
 * rule): LogFiles/ and what is under it, or a folder named as a log folder (site/wwwroot/Logs,
 * App_Data/logs…) and what is under it. Folders that merely contain "log" ("blog", "catalog") don't count.
 */
export function isKuduLogFolder(path: string): boolean {
  const segments = segmentsOf(path);
  return segments !== null && isLogDir(segments);
}

/**
 * Whether a file on the App Service counts as a log, which is all the bookmarklet reads (it has the same
 * rule): a log file type, in a log folder (see isKuduLogFolder), and not named like settings, keys or
 * secrets (appsettings.json, local.settings.json, web.config, .env, keys.json…).
 */
export function isKuduLogPath(path: string): boolean {
  const segments = segmentsOf(path);
  if (segments === null) return false;
  const file = segments.pop() ?? '';
  if (!LOG_EXT_RE.test(file) || SECRET_NAME_RE.test(file)) return false;
  return isLogDir(segments);
}

/** Folder listings are kept briefly: live tail looks at every file each second. */
const LIST_CACHE_MS = 2000;

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * A file on the App Service, read through Kudu. It looks like a File only as far as live tail uses one:
 * name, size, lastModified, slice(start, end).arrayBuffer() and arrayBuffer().
 */
function remoteFile(bridge: KuduBridge, path: string, e: KuduEntry): File {
  const range = (start: number, end: number) => ({ arrayBuffer: () => bridge.read(path, start, end) });
  return {
    name: e.name,
    size: e.size,
    lastModified: e.mtime,
    slice: (start = 0, end = e.size) => range(Math.max(0, start), Math.min(e.size, end)),
    arrayBuffer: () => bridge.read(path, 0, e.size),
  } as unknown as File;
}

/** A Kudu folder as a live tail folder handle (and its files and sub-folders). */
export class KuduDirHandle implements LiveDirHandle {
  readonly kind = 'directory' as const;
  private cache: { at: number; entries: Promise<KuduEntry[]> } | null = null;

  constructor(
    private readonly bridge: KuduBridge,
    /** Path under the site's home, without a trailing slash ('' for the home itself). */
    readonly path: string,
    readonly name: string = path.split('/').pop() || 'home',
  ) {}

  entries(): Promise<KuduEntry[]> {
    if (!this.cache || Date.now() - this.cache.at > LIST_CACHE_MS) {
      const entries = this.bridge.list(this.path);
      this.cache = { at: Date.now(), entries };
      entries.catch(() => (this.cache = null));
    }
    return this.cache.entries;
  }

  async *values(): AsyncIterable<KuduDirHandle | LiveFileHandle> {
    for (const e of await this.entries()) {
      const p = join(this.path, e.name);
      if (e.dir) yield new KuduDirHandle(this.bridge, p, e.name);
      // Only log files: the bookmarklet would refuse to read the others anyway.
      else if (isKuduLogPath(p)) yield this.file(e.name);
    }
  }

  /** A file of this folder; getFile() looks its size and time up in the (briefly cached) listing. */
  file(name: string): LiveFileHandle {
    const p = join(this.path, name);
    return {
      kind: 'file',
      name,
      getFile: async () => {
        const e = (await this.entries()).find((x) => x.name === name && !x.dir);
        if (!e) throw new DOMException(`${p} is gone`, 'NotFoundError');
        return remoteFile(this.bridge, p, e);
      },
    };
  }
}

/** Folders worth watching on an App Service (paths under the site's home). */
export const KUDU_FOLDERS: { path: string; label: string; hint: string }[] = [
  { path: 'LogFiles/Application', label: 'Application logs', hint: 'What the app logs (requires "Application logging (Filesystem)" turned on in Azure)' },
  { path: 'site/wwwroot/Logs', label: "The app's own Logs folder", hint: 'Files the app writes itself, e.g. Serilog to Logs/ (site/wwwroot/Logs)' },
  { path: 'LogFiles/http/RawLogs', label: 'Web server (IIS) logs', hint: 'Requests, status codes and times (requires "Web server logging" turned on in Azure)' },
  { path: 'LogFiles', label: 'All of LogFiles', hint: 'Every log App Service keeps, including failed request traces and the event log' },
];

/** Opening a Kudu folder reads less than a local one: it all comes over the network. */
export const KUDU_LIMITS = { maxFiles: 10, maxBytes: 64 * 1024 * 1024 };

/** Clean a folder path typed by the user: forward slashes, no leading or trailing slash, no "..". */
export function cleanKuduPath(input: string): string | null {
  const p = input.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (p.split('/').some((s) => /^[. ]+$/.test(s))) return null;
  return /^[\w .()/-]*$/.test(p) ? p : null;
}
