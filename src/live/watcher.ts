/**
 * Live tail: watch log files (from a folder or opened with "Open with") and send the bytes written
 * to them since the last read. Uses the File System Access API (Chrome, Edge); only the parts used
 * here are typed, so tests can pass plain objects.
 */

export interface LiveFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

export interface LiveDirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<LiveFileHandle | LiveDirHandle>;
  queryPermission?(desc: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(desc: { mode: 'read' }): Promise<PermissionState>;
}

export interface FolderEntry {
  /** Path inside the folder, e.g. "W3SVC1/u_ex261027.log". */
  path: string;
  handle: LiveFileHandle;
}

/** Sub-folders searched below the opened folder (Azure's LogFiles has logs two levels down). */
export const MAX_DEPTH = 3;
/** Opening a folder reads at most this many files (the most recently changed)… */
export const MAX_FOLDER_FILES = 50;
/** …and at most this many bytes (they are copied into memory to be read safely while written). */
export const MAX_FOLDER_BYTES = 512 * 1024 * 1024;
/** A last line without a newline is read once the file has not changed for this long. */
export const PARTIAL_LINE_QUIET_MS = 10_000;
/** At most this much new text is read from one file per check. */
export const MAX_APPEND_BYTES = 8 * 1024 * 1024;

const COMPRESSED_RE = /\.(gz|zip)$/i;
/** Whether bytes appended to the file can be read (compressed files are read whole, once). */
export const isTailable = (name: string) => !COMPRESSED_RE.test(name);

/** Log files in a folder and its sub-folders, sorted by path. */
export async function listFolder(dir: LiveDirHandle, accept: (name: string) => boolean): Promise<FolderEntry[]> {
  const out: FolderEntry[] = [];
  async function walk(d: LiveDirHandle, prefix: string, depth: number) {
    for await (const h of d.values()) {
      if (h.kind === 'file') {
        if (accept(h.name)) out.push({ path: prefix + h.name, handle: h });
      } else if (depth < MAX_DEPTH && !h.name.startsWith('.') && h.name !== 'node_modules') {
        await walk(h, `${prefix}${h.name}/`, depth + 1);
      }
    }
  }
  await walk(dir, '', 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The most recently changed non-empty files within the limits, and how many were left out. */
export function chooseRecent<T extends { file: File }>(
  entries: T[],
  maxFiles = MAX_FOLDER_FILES,
  maxBytes = MAX_FOLDER_BYTES,
): { chosen: T[]; skipped: number } {
  const nonEmpty = entries.filter((e) => e.file.size > 0);
  const byRecent = [...nonEmpty].sort((a, b) => b.file.lastModified - a.file.lastModified);
  const chosen: T[] = [];
  let bytes = 0;
  for (const e of byRecent) {
    if (chosen.length >= maxFiles) break;
    if (chosen.length > 0 && bytes + e.file.size > maxBytes) continue;
    chosen.push(e);
    bytes += e.file.size;
  }
  return { chosen, skipped: nonEmpty.length - chosen.length };
}

export interface WatchTarget {
  path: string;
  handle: LiveFileHandle;
  /** Bytes read so far. */
  offset: number;
  /** File size at the previous check (when it was opened, at first). */
  lastSize?: number;
  /** Its last entry may still be open in the parser (closed by a final read once the file stops growing). */
  open?: boolean;
  /** When the file last grew (unset: since it was opened; its modified time counts). */
  quietSince?: number;
}

export interface WatcherOptions {
  /** Watched for new files too (null: only `targets`). */
  dir: LiveDirHandle | null;
  targets: WatchTarget[];
  /** Files of the folder left out on purpose when it was opened (older ones): not picked up later. */
  ignore?: ReadonlySet<string>;
  accept(name: string): boolean;
  /**
   * Parse new bytes of a file; resolves to the bytes consumed (whole lines). Once the file stopped
   * growing, `final` closes its last entry: `'lines'` leaves an unfinished last line for later, `true`
   * (after `PARTIAL_LINE_QUIET_MS` of quiet) reads it too.
   */
  send(path: string, blob: Blob, modified: number, final: boolean | 'lines'): Promise<number>;
  /** After each check; `changed` when any new lines were read. */
  onCheck(changed: boolean): void;
  /** Milliseconds until the next check. */
  delayMs(): number;
  onError?(message: string): void;
}

export class LiveWatcher {
  private targets = new Map<string, WatchTarget>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private paused = false;
  private running = false;

  constructor(private opts: WatcherOptions) {
    for (const t of opts.targets) this.targets.set(t.path, { ...t });
  }

  /** Read a slice now: a File from a handle can't be read any more once the file changes again. */
  private static async read(file: File, start: number, end: number): Promise<Blob | null> {
    try {
      return new Blob([await file.slice(start, end).arrayBuffer()]);
    } catch {
      return null; // changed meanwhile: read it at the next check
    }
  }

  get fileCount(): number {
    return this.targets.size;
  }

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.paused) await this.check();
      this.schedule();
    }, this.opts.delayMs());
  }

  /** Look for new files and new bytes once (also called by tests). Returns whether anything was read. */
  async check(): Promise<boolean> {
    if (this.running || this.stopped) return false;
    this.running = true;
    let changed = false;
    try {
      if (this.opts.dir) {
        let entries: FolderEntry[];
        try {
          entries = await listFolder(this.opts.dir, this.opts.accept);
        } catch (e) {
          this.opts.onError?.(`Can't read the folder any more: ${e instanceof Error ? e.message : String(e)}`);
          entries = [];
        }
        for (const e of entries) {
          if (!this.targets.has(e.path) && !this.opts.ignore?.has(e.path) && isTailable(e.path)) {
            this.targets.set(e.path, { ...e, offset: 0, lastSize: 0 });
          }
        }
      }
      for (const t of [...this.targets.values()]) {
        if (this.stopped) break;
        let file: File;
        try {
          file = await t.handle.getFile();
        } catch {
          this.targets.delete(t.path); // deleted or moved
          continue;
        }
        if (file.size < t.offset) t.offset = 0; // truncated or replaced (log rotation): read it again
        const grew = file.size !== t.lastSize;
        t.lastSize = file.size;
        if (grew) t.quietSince = Date.now();
        const left = file.size - t.offset;
        // Still being written: read whole lines. Stopped growing: close the last entry, and once it has
        // been quiet for a while also read an unfinished last line (an editor or a slow writer may still
        // be in the middle of it: reading it early would split the line in two).
        const quietMs = Date.now() - (t.quietSince ?? file.lastModified);
        let final: boolean | 'lines' = false;
        if (!grew && left <= MAX_APPEND_BYTES) final = quietMs >= PARTIAL_LINE_QUIET_MS ? true : 'lines';
        if (left === 0 && !(final && t.open)) continue;
        if (final === 'lines' && !t.open) continue; // nothing to close; the unfinished line waits
        const end = Math.min(file.size, t.offset + MAX_APPEND_BYTES);
        const blob = await LiveWatcher.read(file, t.offset, end);
        if (!blob) continue;
        const consumed = await this.opts.send(t.path, blob, file.lastModified, final);
        if (this.stopped) break;
        // A single "line" longer than the read limit can't be finished: skip past it.
        t.offset += consumed === 0 && end - t.offset >= MAX_APPEND_BYTES ? end - t.offset : consumed;
        t.open = final === false;
        if (consumed > 0) changed = true;
      }
    } finally {
      this.running = false;
    }
    if (!this.stopped) this.opts.onCheck(changed);
    return changed;
  }
}
