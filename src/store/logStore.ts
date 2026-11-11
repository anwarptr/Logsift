import { create } from 'zustand';
import { EMPTY_FILTERS, type FilterState } from '../filters/types';
import { hasActiveFilters, parseFilters } from '../filters/urlState';
import type { ColumnDef, LogFormat, LogRow, LogTimeZone, MalformedRow } from '../parser';
import {
  chooseRecent,
  isTailable,
  listFolder,
  LiveWatcher,
  type FolderEntry,
  type LiveDirHandle,
  type LiveFileHandle,
  type WatchTarget,
} from '../live/watcher';
import { saveFolder } from '../live/savedFolder';
import { appendLive, startParse } from '../worker/client';
import { clearLayout, insertWithLayout, layoutKey, loadLayout, saveLayout } from './columnLayouts';
import { liveCheckDelayMs } from './perfStats';
import { DEFAULT_COMPARE, type CompareSetting } from '../utils/compare';
import { mapConcurrent } from '../utils/async';
import { notifyDesktop, playAlertChime } from '../utils/sound';
import type { WorkerResponse } from '../worker/protocol';
import type { LogSource } from '../worker/streamParse';
import { loadPrefs, savePrefs, type Density, type ThemePref, type TimeDisplay } from './prefs';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SortDir = 'asc' | 'desc';
export type ViewTab = 'rows' | 'endpoints' | 'patterns' | 'charts' | 'compare' | 'malformed';

export interface FileMeta {
  name: string;
  size: number;
}

export interface SortState {
  key: string;
  dir: SortDir;
}

/** What a live load watches: a folder (and new files in it) or files opened with "Open with". */
interface LiveInit {
  kind: 'folder' | 'files';
  /** Folder or file name, for the live bar. */
  label: string;
  dir: LiveDirHandle | null;
  /** Handle of each opened file, by source name. */
  handles: Map<string, LiveFileHandle>;
  /** Files of the folder left out on purpose (older ones): not watched. */
  ignore: Set<string>;
  notice?: string;
  /** File filter function used to accept files in the watched directory. */
  accept?: (name: string) => boolean;
}

/** How a folder is opened: limits on what is read at first, and whether to offer it for Reopen. */
export interface FolderOpenOptions {
  /** At most this many (most recently changed) files; default MAX_FOLDER_FILES. */
  maxFiles?: number;
  /** At most this many bytes; default MAX_FOLDER_BYTES. */
  maxBytes?: number;
  /** Remember it for Reopen on the start page (default true; a remote folder can't be). */
  remember?: boolean;
  /** Custom filter to accept files in the folder (defaults to isAcceptedFile). */
  accept?: (name: string) => boolean;
}

/** Live tail status, shown in the live bar. */
export interface LiveState {
  kind: 'folder' | 'files';
  label: string;
  /** Files being watched. */
  files: number;
  paused: boolean;
  /** The table keeps the newest row in view (turned off by scrolling up). */
  following: boolean;
  /** When new lines last arrived. */
  updatedAt: number | null;
  /** Rows added since the files were opened. */
  newRows: number;
  notice: string | null;
  error: string | null;
  /** Alert with sound & notification when new errors arrive. */
  alertErrors?: boolean;
  /** Maximum rows to keep in memory (default 50,000). */
  maxRows?: number;
}

export interface LogState {
  // --- data ---
  status: LoadStatus;
  error: string | null;
  /** What was opened: one file, or "3 files" with the total size. */
  file: FileMeta | null;
  /** Kept so the files can be re-parsed with a different format override. */
  sources: LogSource[];
  /** Log files actually parsed (archives expanded), in parse order. */
  files: string[];
  format: LogFormat | null;
  detectedFormat: LogFormat | null;
  formatOverride: LogFormat | 'auto';
  /** Layout used when the format is 'custom' (remembered per browser). */
  customPattern: string;
  progress: { bytesRead: number; totalBytes: number; lines: number };
  parseMs: number | null;
  rows: LogRow[];
  malformed: MalformedRow[];
  meta: string[];
  schema: ColumnDef[];
  /** Detected once parsing finishes. */
  logTimeZone: LogTimeZone | null;
  /** Set while files are watched for new lines (a folder, or files opened with "Open with"). */
  live: LiveState | null;

  // --- view ---
  columnOrder: string[];
  hiddenColumns: Record<string, true>;
  columnWidths: Record<string, number>;
  sort: SortState | null;
  selectedId: number | null;
  tab: ViewTab;
  density: Density;
  theme: ThemePref;
  slowThresholdMs: number;
  insightsOpen: boolean;
  timeDisplay: TimeDisplay;
  sidebarOpen: boolean;
  /** Table fills the window: header, file bar, filter panel and insights are hidden. */
  focusMode: boolean;
  fileInfoExpanded: boolean;
  helpOpen: boolean;
  /** The two time ranges of the Compare tab. */
  compare: CompareSetting;

  // --- filters ---
  filters: FilterState;
  /** True when filters came from the URL and should survive the first file load. */
  keepFiltersOnLoad: boolean;
  /** Filters set aside by "Show in full log", with the row that was shown; null when none are paused. */
  paused: { filters: FilterState; sort: SortState | null; lineNo: number } | null;

  loadFile(file: File): void;
  /** Open several files as one log, merged in time order. Unsupported or empty files are skipped. */
  loadFiles(files: Iterable<File>): void;
  /** Parse pasted text exactly like a file (same worker pipeline). */
  loadText(text: string): void;
  /** Open the log files in a folder (newest first, within limits) and watch it for new lines and files. */
  openFolder(dir: LiveDirHandle, opts?: FolderOpenOptions): Promise<void>;
  /** Open files given as handles ("Open with" in the installed app) and watch them for new lines. */
  openFileHandles(handles: LiveFileHandle[]): Promise<void>;
  stopLive(): void;
  setLivePaused(paused: boolean): void;
  setLiveFollowing(following: boolean): void;
  setLiveAlertErrors(alertErrors: boolean): void;
  clearLiveBuffer(): void;
  /** A note in the live bar (e.g. why no more lines arrive). */
  setLiveNotice(notice: string | null): void;
  setFilters(patch: Partial<FilterState>): void;
  replaceFilters(f: FilterState): void;
  clearFilters(): void;
  /** Clear the filters (keeping them to restore) so a row can be seen among its neighbours. */
  showInFullLog(id: number): void;
  restoreFilters(): void;
  setFormatOverride(format: LogFormat | 'auto'): void;
  /** Save a custom pattern and re-parse the current files with it. */
  setCustomPattern(pattern: string): void;
  setError(message: string | null): void;

  setColumnVisible(key: string, visible: boolean): void;
  moveColumn(key: string, toIndex: number): void;
  setColumnWidth(key: string, width: number): void;
  resetColumns(): void;
  toggleSort(key: string): void;
  select(id: number | null): void;
  setTab(tab: ViewTab): void;
  setDensity(d: Density): void;
  setTheme(t: ThemePref): void;
  setSlowThreshold(ms: number): void;
  setInsightsOpen(open: boolean): void;
  setTimeDisplay(d: TimeDisplay): void;
  setSidebarOpen(open: boolean): void;
  setFocusMode(on: boolean): void;
  setFileInfoExpanded(expanded: boolean): void;
  setHelpOpen(open: boolean): void;
  setCompare(c: CompareSetting): void;
}

export const ACCEPTED_EXTENSIONS = [
  '.log',
  '.txt',
  '.json',
  '.jsonl',
  '.ndjson',
  '.clef',
  '.xml',
  '.csv',
  '.tsv',
  '.out',
  '.err',
  '.trace',
  '.gz',
  '.zip',
];

/** Matches rotated logs like app.log.1, access.log.2026-11-08, service.out.old, etc. */
const ROTATED_RE = /\.(log|txt|json|jsonl|ndjson|clef|xml|csv|tsv|out|err|trace)[._-]\w+$/i;

/** Display name for text pasted instead of a file (also the base of export file names). */
export const PASTED_NAME = 'pasted-text.txt';

/**
 * Interleave rows from several files by timestamp (stable, so equal times keep file order;
 * rows without a timestamp go last) and renumber ids to match the new positions.
 */
export function mergeByTime(rows: LogRow[]): LogRow[] {
  let ordered = true;
  let last = -Infinity;
  for (const r of rows) {
    if (r.ts === null) continue;
    if (r.ts < last) {
      ordered = false;
      break;
    }
    last = r.ts;
  }
  if (ordered) return rows;
  const key = (r: LogRow) => r.ts ?? Infinity;
  const sorted = [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  sorted.forEach((r, i) => (r.id = i));
  return sorted;
}

/** Add rows at the end, numbering them by position. */
function appendRows(rows: LogRow[], added: LogRow[]): LogRow[] {
  if (added.length === 0) return rows;
  const out = rows.concat(added);
  for (let i = rows.length; i < out.length; i++) out[i]!.id = i;
  return out;
}

/**
 * Merge new rows into rows already in time order (live tail of several files): only the part from
 * the first new row's time on is merged, so the usual case (all new rows are newest) is an append.
 * Stable, rows without a timestamp go last (as in `mergeByTime`); ids are renumbered from the merge point.
 */
export function mergeAppend(rows: LogRow[], added: LogRow[]): LogRow[] {
  if (added.length === 0) return rows;
  const key = (r: LogRow) => r.ts ?? Infinity;
  const sorted = [...added].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const first = key(sorted[0]!);
  // First existing row later than the earliest new row.
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(rows[mid]!) <= first) lo = mid + 1;
    else hi = mid;
  }
  const out = rows.slice(0, lo);
  let i = lo;
  let j = 0;
  while (i < rows.length && j < sorted.length) out.push(key(sorted[j]!) < key(rows[i]!) ? sorted[j++]! : rows[i++]!);
  while (i < rows.length) out.push(rows[i++]!);
  while (j < sorted.length) out.push(sorted[j++]!);
  for (let k = lo; k < out.length; k++) out[k]!.id = k;
  return out;
}

/** Read a file from its handle into memory, retrying when it changes while being read. */
async function readStable(handle: LiveFileHandle): Promise<File> {
  for (let attempt = 0; ; attempt++) {
    const file = await handle.getFile();
    try {
      return new File([await file.arrayBuffer()], file.name, { lastModified: file.lastModified });
    } catch (e) {
      if (attempt >= 4) throw e;
    }
  }
}

export function isAcceptedFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  return ROTATED_RE.test(lower);
}

/** Noisy columns that start hidden (they can be shown from the column chooser). */
const DEFAULT_HIDDEN = new Set(['cs(Cookie)', 'sc-substatus', 'sc-win32-status', 'timestamp_raw', 'siteId', 'processId', 'activityId', 'recordId']);

export function defaultColumnWidth(col: ColumnDef): number {
  if (col.type === 'timestamp') return 190; // fits "2026-03-14 09:30:01.102"
  if (col.role === 'message') return 520;
  if (col.role === 'uri' || col.role === 'userAgent' || col.key === 'arrLogId') return 240;
  if (col.role === 'level') return 104; // fits Serilog's "Information"
  if (col.role === 'status' || col.role === 'method') return 76;
  if (col.type === 'number') return 92;
  if (col.type === 'boolean') return 96;
  return 150;
}

export const MIN_COLUMN_WIDTH = 44;

/** Matches the CSS breakpoint where the filter panel becomes an overlay. */
export const isNarrowScreen = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 900px)').matches;

const prefs = loadPrefs();
const initialFilters = typeof location === 'undefined' ? EMPTY_FILTERS : parseFilters(location.hash);

export const useLogStore = create<LogState>()((set, get) => {
  /** Where this kind of log's column layout is remembered. */
  const currentLayoutKey = () => layoutKey(get().format, get().customPattern);

  /**
   * Merge a (possibly grown) schema into the column order without disturbing user choices. New
   * columns take their place, width and visibility from the layout saved for this kind of log.
   */
  function syncColumns(schema: ColumnDef[]) {
    const s = get();
    const known = new Set(s.columnOrder);
    const added = schema.filter((c) => !known.has(c.key));
    if (added.length === 0) return {};
    const layout = loadLayout(currentLayoutKey());
    const saved = new Set(layout?.order);
    const savedHidden = new Set(layout?.hidden);
    const hidden = { ...s.hiddenColumns };
    const widths = { ...s.columnWidths };
    for (const c of added) {
      if (saved.has(c.key) ? savedHidden.has(c.key) : DEFAULT_HIDDEN.has(c.key)) hidden[c.key] = true;
      widths[c.key] ??= layout?.widths[c.key] ?? defaultColumnWidth(c);
    }
    // Only the new columns are placed: the columns already shown keep the order the user gave them.
    const columnOrder = insertWithLayout(s.columnOrder, added.map((c) => c.key), layout);
    return { columnOrder, hiddenColumns: hidden, columnWidths: widths };
  }

  /** Save the column layout for this kind of log (widths are saved shortly after a resize ends). */
  let widthSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** A change made before the format was known (early in a load): saved once it is. */
  let saveWhenFormatKnown = false;
  function saveColumnsNow() {
    if (widthSaveTimer) clearTimeout(widthSaveTimer);
    widthSaveTimer = null;
    const s = get();
    const key = currentLayoutKey();
    if (!key) {
      saveWhenFormatKnown = true;
      return;
    }
    saveWhenFormatKnown = false;
    // Only widths the user changed: untouched columns follow the app's defaults, even if those change.
    const byKey = new Map(s.schema.map((c) => [c.key, c]));
    const widths: Record<string, number> = {};
    for (const [k, w] of Object.entries(s.columnWidths)) {
      const col = byKey.get(k);
      if (!col || w !== defaultColumnWidth(col)) widths[k] = w;
    }
    saveLayout(key, s.columnOrder, s.hiddenColumns, widths);
  }
  function persistColumns(delay = 0) {
    if (widthSaveTimer) clearTimeout(widthSaveTimer);
    widthSaveTimer = delay > 0 ? setTimeout(saveColumnsNow, delay) : null;
    if (delay <= 0) saveColumnsNow();
  }
  /** Before another log replaces this one: save a resize that is still waiting. */
  function flushColumnSave() {
    if (widthSaveTimer) saveColumnsNow();
    saveWhenFormatKnown = false;
  }

  // --- live tail ---
  /** What is being watched, kept so a re-parse (format change) can watch it again. */
  let liveInit: LiveInit | null = null;
  let watcher: LiveWatcher | null = null;
  /** Rows read by the watcher during one check, added to the log together (one index rebuild). */
  let liveBuffer: { rows: LogRow[]; malformed: MalformedRow[]; meta: string[]; schema: ColumnDef[] | null } | null = null;
  let pendingAppend: ((consumed: number) => void) | null = null;

  function stopWatcher() {
    watcher?.stop();
    watcher = null;
    liveBuffer = null;
    pendingAppend?.(0);
    pendingAppend = null;
  }

  /** Add what the last check read to the log. */
  function commitLive() {
    const buf = liveBuffer;
    if (!buf || (buf.rows.length === 0 && buf.malformed.length === 0 && buf.meta.length === 0)) return;
    liveBuffer = { rows: [], malformed: [], meta: [], schema: null };
    const s = get();

    // Alert chime / desktop notification on errors if enabled
    if (s.live?.alertErrors) {
      const isError = (r: LogRow) => {
        const st = Number(r.values['sc-status'] ?? r.values.status ?? r.values.statusCode ?? r.values.status_code);
        if (Number.isFinite(st)) return st >= 400;
        const lv = String(r.values.level ?? r.values.severity ?? r.values.lvl ?? r.values.loglevel ?? '').toLowerCase();
        return lv.startsWith('err') || lv.startsWith('fatal') || lv.startsWith('crit');
      };
      if (buf.malformed.length > 0 || buf.rows.some(isError)) {
        playAlertChime();
        notifyDesktop('Logsift Alert', `New error in ${s.live.label}`);
      }
    }

    // Rows of several files are interleaved by time; keep the selection on the same row.
    const selected = s.selectedId === null ? null : (s.rows.find((r) => r.id === s.selectedId) ?? s.rows[s.selectedId]);
    let rows = s.files.length > 1 || liveInit?.kind === 'folder' ? mergeAppend(s.rows, buf.rows) : appendRows(s.rows, buf.rows);
    const maxRows = s.live?.maxRows ?? 50_000;
    if (rows.length > maxRows) {
      rows = rows.slice(rows.length - maxRows);
    }
    const selectedId = selected ? selected.id : s.selectedId;
    const schema = buf.schema ?? s.schema;
    set({
      rows,
      selectedId,
      malformed: buf.malformed.length ? s.malformed.concat(buf.malformed) : s.malformed,
      meta: buf.meta.length ? s.meta.concat(buf.meta) : s.meta,
      schema,
      ...syncColumns(schema),
      live: s.live && { ...s.live, updatedAt: Date.now(), newRows: s.live.newRows + buf.rows.length },
    });
  }

  function startWatcher(sources: LogSource[], held: Record<string, number>) {
    const init = liveInit;
    if (!init) return;
    const targets: WatchTarget[] = [];
    for (const src of sources) {
      const handle = init.handles.get(src.name);
      if (handle && isTailable(src.name)) {
        targets.push({ path: src.name, handle, offset: src.blob.size - (held[src.name] ?? 0), lastSize: src.blob.size });
      }
    }
    liveBuffer = { rows: [], malformed: [], meta: [], schema: null };
    watcher = new LiveWatcher({
      dir: init.dir,
      targets,
      ignore: init.ignore,
      accept: init.accept ?? isAcceptedFile,
      delayMs: liveCheckDelayMs,
      send: (path, blob, modified, final) =>
        new Promise<number>((resolve) => {
          pendingAppend = resolve;
          appendLive(path, blob, modified, final);
        }),
      onCheck: () => {
        commitLive();
        const s = get();
        if (s.live && watcher && s.live.files !== watcher.fileCount) set({ live: { ...s.live, files: watcher.fileCount } });
      },
      onError: (message) => set((s) => ({ live: s.live && { ...s.live, error: message } })),
    });
    watcher.start();
  }

  function parse(sources: LogSource[], file: FileMeta, override: LogFormat | 'auto', resetFilters: boolean, live?: LiveInit) {
    flushColumnSave();
    stopWatcher();
    liveInit = live ?? null;
    set({
      live: live
        ? {
            kind: live.kind,
            label: live.label,
            files: sources.length,
            paused: false,
            following: true,
            updatedAt: null,
            newRows: 0,
            notice: live.notice ?? null,
            error: null,
            alertErrors: false,
            maxRows: 50_000,
          }
        : null,
    });
    if (resetFilters && !get().keepFiltersOnLoad) set({ filters: EMPTY_FILTERS });
    set({ paused: null });
    set({
      keepFiltersOnLoad: false,
      status: 'loading',
      error: null,
      file,
      sources,
      files: [],
      format: null,
      detectedFormat: null,
      formatOverride: override,
      progress: { bytesRead: 0, totalBytes: file.size, lines: 0 },
      parseMs: null,
      rows: [],
      malformed: [],
      meta: [],
      schema: [],
      logTimeZone: null,
      columnOrder: [],
      hiddenColumns: {},
      columnWidths: {},
      sort: null,
      selectedId: null,
      tab: 'rows',
    });
    const pattern = override === 'custom' ? get().customPattern : undefined;
    const onMessage = (msg: WorkerResponse) => {
      switch (msg.type) {
        case 'start':
          set({ format: msg.format, detectedFormat: msg.detected, files: msg.files });
          if (saveWhenFormatKnown) saveColumnsNow();
          break;
        case 'batch': {
          if (liveBuffer) {
            // New lines from the live watcher: collected until its check ends.
            liveBuffer.rows.push(...msg.rows);
            liveBuffer.malformed.push(...msg.malformed);
            liveBuffer.meta.push(...msg.meta);
            liveBuffer.schema = msg.schema;
            break;
          }
          const s = get();
          set({
            rows: msg.rows.length ? s.rows.concat(msg.rows) : s.rows,
            malformed: msg.malformed.length ? s.malformed.concat(msg.malformed) : s.malformed,
            meta: msg.meta.length ? s.meta.concat(msg.meta) : s.meta,
            schema: msg.schema,
            ...syncColumns(msg.schema),
          });
          break;
        }
        case 'progress':
          set({ progress: { bytesRead: msg.bytesRead, totalBytes: msg.totalBytes, lines: msg.lines } });
          break;
        case 'done':
          set((s) => ({
            // Several files: interleave their rows by time (each file is already in order).
            rows: s.files.length > 1 ? mergeByTime(s.rows) : s.rows,
            status: 'ready',
            parseMs: msg.elapsedMs,
            logTimeZone: msg.timeZone,
            progress: { ...s.progress, lines: msg.lines },
            // A file with only malformed lines is still useful: open that tab.
            tab: s.rows.length === 0 && s.malformed.length > 0 ? 'malformed' : s.tab,
          }));
          if (liveInit) startWatcher(sources, msg.held ?? {});
          break;
        case 'appended': {
          const resolve = pendingAppend;
          pendingAppend = null;
          if (msg.timeZone && msg.consumed > 0) set({ logTimeZone: msg.timeZone });
          resolve?.(msg.consumed);
          break;
        }
        case 'error':
          stopWatcher();
          set({ status: 'error', error: msg.message, live: null });
          break;
      }
    };
    // A folder may get more files later; otherwise the worker decides (a .zip can hold several).
    startParse(sources, override === 'auto' ? undefined : override, pattern, onMessage, live ? { multi: live.kind === 'folder' || undefined } : undefined);
  }

  /** Open files from a folder or from handles, watching them for new lines. */
  async function openLive(
    entries: FolderEntry[],
    init: Omit<LiveInit, 'handles' | 'ignore'>,
    emptyError: string,
    limits: FolderOpenOptions = {},
  ) {
    const withFiles: { path: string; handle: LiveFileHandle; file: File }[] = [];
    await mapConcurrent(entries, 6, async (e) => {
      try {
        const file = await e.handle.getFile();
        withFiles.push({ ...e, file });
      } catch {
        // Skip entries that cannot be queried
      }
    });

    const { chosen, skipped } = chooseRecent(withFiles, limits.maxFiles, limits.maxBytes);
    if (chosen.length === 0) {
      set({ error: emptyError });
      return;
    }

    // Copy files with bounded concurrency (max 4 parallel downloads) so Kudu/network is not choked
    const copies: { entry: (typeof chosen)[0]; file: File }[] = [];
    const failed: { path: string; error: string }[] = [];

    await mapConcurrent(chosen, 4, async (e) => {
      try {
        const copy = await readStable(e.handle);
        copies.push({ entry: e, file: copy });
      } catch (err) {
        failed.push({ path: e.path, error: err instanceof Error ? err.message : String(err) });
      }
    });

    if (copies.length === 0) {
      const firstError = failed[0]?.error ?? 'Kudu did not answer';
      set({ error: `Could not read the files: ${firstError}` });
      return;
    }

    const successfulEntries = copies.map((c) => c.entry);
    const successfulCopies = copies.map((c) => c.file);
    const chosenPaths = new Set(successfulEntries.map((e) => e.path));
    const ignore = new Set(entries.map((e) => e.path).filter((p) => !chosenPaths.has(p)));
    const size = successfulCopies.reduce((sum, f) => sum + f.size, 0);

    let notice = skipped
      ? `Opened the ${successfulEntries.length} most recently changed files; ${skipped} older ${skipped === 1 ? 'file was' : 'files were'} left out.`
      : undefined;

    if (failed.length > 0) {
      const failMsg = `${failed.length} ${failed.length === 1 ? 'file was' : 'files were'} skipped (could not be read: Kudu did not answer).`;
      notice = notice ? `${notice} ${failMsg}` : failMsg;
    }

    const name =
      init.kind === 'folder'
        ? `${init.label}/ (${successfulEntries.length} file${successfulEntries.length === 1 ? '' : 's'})`
        : successfulEntries.length === 1
          ? successfulEntries[0]!.path
          : `${successfulEntries.length} files`;

    parse(
      successfulEntries.map((e, i) => ({ name: e.path, blob: successfulCopies[i]! })),
      { name, size },
      get().formatOverride,
      true,
      { ...init, accept: limits.accept, notice, ignore, handles: new Map(successfulEntries.map((e) => [e.path, e.handle])) },
    );
  }

  return {
    status: 'idle',
    error: null,
    file: null,
    sources: [],
    files: [],
    format: null,
    detectedFormat: null,
    formatOverride: 'auto',
    customPattern: prefs.customPattern,
    progress: { bytesRead: 0, totalBytes: 0, lines: 0 },
    parseMs: null,
    rows: [],
    malformed: [],
    meta: [],
    schema: [],
    logTimeZone: null,
    live: null,

    columnOrder: [],
    hiddenColumns: {},
    columnWidths: {},
    sort: null,
    selectedId: null,
    tab: 'rows',
    density: prefs.density,
    theme: prefs.theme,
    slowThresholdMs: prefs.slowThresholdMs,
    insightsOpen: prefs.insightsOpen,
    timeDisplay: prefs.timeDisplay,
    sidebarOpen: prefs.sidebarOpen && !isNarrowScreen(),
    focusMode: false,
    fileInfoExpanded: prefs.fileInfoExpanded,
    helpOpen: false,
    compare: DEFAULT_COMPARE,

    filters: initialFilters,
    keepFiltersOnLoad: hasActiveFilters(initialFilters),
    paused: null,

    setFilters(patch) {
      set((s) => ({ filters: { ...s.filters, ...patch }, paused: null }));
    },

    replaceFilters(filters) {
      set({ filters, paused: null });
    },

    clearFilters() {
      set({ filters: EMPTY_FILTERS, paused: null });
    },

    showInFullLog(id) {
      const s = get();
      const row = s.rows.find((r) => r.id === id) ?? s.rows[id];
      if (!row || !hasActiveFilters(s.filters)) return;
      // Sorting would scatter the neighbours, so file order is shown until filters are restored.
      set({ paused: { filters: s.filters, sort: s.sort, lineNo: row.lineNo }, filters: EMPTY_FILTERS, sort: null, selectedId: row.id, tab: 'rows' });
    },

    restoreFilters() {
      const p = get().paused;
      if (p) set({ filters: p.filters, sort: p.sort, paused: null });
    },

    loadFile(file) {
      get().loadFiles([file]);
    },

    loadFiles(input) {
      const all = [...input];
      if (all.length === 0) return;
      const ok = all.filter((f) => isAcceptedFile(f.name) && f.size > 0);
      if (ok.length === 0) {
        const f = all[0]!;
        let error: string;
        if (all.length > 1) error = 'None of these files can be opened: choose non-empty .log, .txt, .json, .xml, .csv, .gz or .zip files.';
        else if (!isAcceptedFile(f.name)) error = `"${f.name}" is not supported. Choose a .log, .txt, .json, .xml, .csv, .gz or .zip file.`;
        else error = `"${f.name}" is empty.`;
        set({ error });
        return;
      }
      const size = ok.reduce((sum, f) => sum + f.size, 0);
      const name = ok.length === 1 ? ok[0]!.name : `${ok.length} files`;
      parse(
        ok.map((f) => ({ name: f.name, blob: f })),
        { name, size },
        get().formatOverride,
        true,
      );
      const skipped = all.filter((f) => !ok.includes(f));
      if (skipped.length) {
        const names = skipped.map((f) => f.name).join(', ');
        set({ error: `Skipped ${skipped.length} empty or unsupported file${skipped.length > 1 ? 's' : ''}: ${names}` });
      }
    },

    loadText(text) {
      if (text.trim() === '') {
        set({ error: 'The pasted text is empty.' });
        return;
      }
      const blob = new Blob([text], { type: 'text/plain' });
      parse([{ name: PASTED_NAME, blob }], { name: PASTED_NAME, size: blob.size }, get().formatOverride, true);
    },

    async openFolder(dir, opts = {}) {
      const acceptFn = opts.accept ?? isAcceptedFile;
      let entries: FolderEntry[];
      try {
        entries = await listFolder(dir, acceptFn);
      } catch (e) {
        set({ error: `Could not read the folder "${dir.name}": ${e instanceof Error ? e.message : String(e)}` });
        return;
      }
      if (opts.remember !== false) void saveFolder(dir);
      const isKudu = dir.name.includes(':') || /scm\./i.test(dir.name);
      const emptyError = isKudu
        ? `The folder "${dir.name}" has no log files with content. On Azure App Service, Application Logging (Filesystem) and Web Server Logging are disabled by default: enable them in Azure Portal > App Service logs, or try "The app's own Logs folder".`
        : `The folder "${dir.name}" has no log files with content.`;
      await openLive(
        entries,
        { kind: 'folder', label: dir.name, dir },
        emptyError,
        opts,
      );
    },

    async openFileHandles(handles) {
      const ok = handles.filter((h) => isAcceptedFile(h.name));
      const toOpen = ok.length > 0 ? ok : handles;
      if (toOpen.length === 0) {
        set({ error: 'No files selected to open.' });
        return;
      }
      await openLive(
        toOpen.map((h) => ({ path: h.name, handle: h })),
        { kind: 'files', label: toOpen.length === 1 ? toOpen[0]!.name : `${toOpen.length} files`, dir: null },
        'The files are empty.',
      );
    },

    stopLive() {
      stopWatcher();
      liveInit = null;
      set({ live: null });
    },

    setLivePaused(paused) {
      watcher?.setPaused(paused);
      set((s) => ({ live: s.live && { ...s.live, paused } }));
    },

    setLiveFollowing(following) {
      set((s) => ({ live: s.live && { ...s.live, following } }));
    },

    setLiveAlertErrors(alertErrors) {
      set((s) => ({ live: s.live && { ...s.live, alertErrors } }));
    },

    clearLiveBuffer() {
      const s = get();
      if (!s.live) return;
      set({
        rows: [],
        malformed: [],
        meta: [],
        selectedId: null,
        live: { ...s.live, newRows: 0 },
      });
    },

    setLiveNotice(notice) {
      set((s) => ({ live: s.live && { ...s.live, notice } }));
    },

    setFormatOverride(format) {
      const { sources, file } = get();
      // Keep watching when the files are re-parsed with another format.
      if (sources.length && file) parse(sources, file, format, false, liveInit ?? undefined);
      else set({ formatOverride: format });
    },

    setCustomPattern(pattern) {
      set({ customPattern: pattern });
      savePrefs({ customPattern: pattern });
      get().setFormatOverride('custom');
    },

    setError(message) {
      set({ error: message });
    },

    setColumnVisible(key, visible) {
      set((s) => {
        const hidden = { ...s.hiddenColumns };
        if (visible) delete hidden[key];
        else hidden[key] = true;
        return { hiddenColumns: hidden };
      });
      persistColumns();
    },

    moveColumn(key, toIndex) {
      set((s) => {
        const order = s.columnOrder.filter((k) => k !== key);
        const i = Math.max(0, Math.min(order.length, toIndex));
        order.splice(i, 0, key);
        return { columnOrder: order };
      });
      persistColumns();
    },

    setColumnWidth(key, width) {
      set((s) => ({ columnWidths: { ...s.columnWidths, [key]: Math.max(MIN_COLUMN_WIDTH, Math.round(width)) } }));
      persistColumns(400);
    },

    resetColumns() {
      // Back to the defaults, and forget the layout saved for this kind of log.
      if (widthSaveTimer) clearTimeout(widthSaveTimer);
      widthSaveTimer = null;
      saveWhenFormatKnown = false;
      clearLayout(currentLayoutKey());
      const schema = get().schema;
      set({ columnOrder: [], hiddenColumns: {}, columnWidths: {} });
      set(syncColumns(schema));
    },

    toggleSort(key) {
      set((s) => {
        if (!s.sort || s.sort.key !== key) return { sort: { key, dir: 'asc' } };
        if (s.sort.dir === 'asc') return { sort: { key, dir: 'desc' } };
        return { sort: null };
      });
    },

    select(id) {
      set({ selectedId: id });
    },

    setTab(tab) {
      set({ tab });
    },

    setDensity(density) {
      set({ density });
      savePrefs({ density });
    },

    setTheme(theme) {
      set({ theme });
      savePrefs({ theme });
    },

    setInsightsOpen(insightsOpen) {
      set({ insightsOpen });
      savePrefs({ insightsOpen });
    },

    setTimeDisplay(timeDisplay) {
      set({ timeDisplay });
      savePrefs({ timeDisplay });
    },

    setSidebarOpen(sidebarOpen) {
      set({ sidebarOpen });
      // On narrow screens the panel is a temporary overlay; don't let closing it hide it on desktop.
      if (!isNarrowScreen()) savePrefs({ sidebarOpen });
    },

    setFocusMode(focusMode) {
      set({ focusMode });
    },

    setFileInfoExpanded(fileInfoExpanded) {
      set({ fileInfoExpanded });
      savePrefs({ fileInfoExpanded });
    },

    setCompare(compare) {
      set({ compare });
    },

    setHelpOpen(helpOpen) {
      set({ helpOpen });
    },

    setSlowThreshold(ms) {
      const v = Number.isFinite(ms) && ms >= 0 ? ms : 1000;
      set({ slowThresholdMs: v });
      savePrefs({ slowThresholdMs: v });
    },
  };
});
