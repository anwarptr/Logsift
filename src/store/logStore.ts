import { create } from 'zustand';
import { EMPTY_FILTERS, type FilterState } from '../filters/types';
import { hasActiveFilters, parseFilters } from '../filters/urlState';
import type { ColumnDef, LogFormat, LogRow, LogTimeZone, MalformedRow } from '../parser';
import { startParse } from '../worker/client';
import type { WorkerResponse } from '../worker/protocol';
import type { LogSource } from '../worker/streamParse';
import { loadPrefs, savePrefs, type Density, type ThemePref, type TimeDisplay } from './prefs';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SortDir = 'asc' | 'desc';
export type ViewTab = 'rows' | 'endpoints' | 'malformed';

export interface FileMeta {
  name: string;
  size: number;
}

export interface SortState {
  key: string;
  dir: SortDir;
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
  progress: { bytesRead: number; totalBytes: number; lines: number };
  parseMs: number | null;
  rows: LogRow[];
  malformed: MalformedRow[];
  meta: string[];
  schema: ColumnDef[];
  /** Detected once parsing finishes. */
  logTimeZone: LogTimeZone | null;

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

  // --- filters ---
  filters: FilterState;
  /** True when filters came from the URL and should survive the first file load. */
  keepFiltersOnLoad: boolean;

  loadFile(file: File): void;
  /** Open several files as one log, merged in time order. Unsupported or empty files are skipped. */
  loadFiles(files: Iterable<File>): void;
  /** Parse pasted text exactly like a file (same worker pipeline). */
  loadText(text: string): void;
  setFilters(patch: Partial<FilterState>): void;
  replaceFilters(f: FilterState): void;
  clearFilters(): void;
  setFormatOverride(format: LogFormat | 'auto'): void;
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
}

export const ACCEPTED_EXTENSIONS = ['.log', '.txt', '.gz', '.zip'];

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

export function isAcceptedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Noisy columns that start hidden (they can be shown from the column chooser). */
const DEFAULT_HIDDEN = new Set(['cs(Cookie)', 'sc-substatus', 'sc-win32-status', 'timestamp_raw']);

export function defaultColumnWidth(col: ColumnDef): number {
  if (col.type === 'timestamp') return 168;
  if (col.role === 'message') return 520;
  if (col.role === 'uri' || col.role === 'userAgent' || col.key === 'arrLogId') return 240;
  if (col.role === 'status' || col.role === 'method' || col.role === 'level') return 76;
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
  /** Merge a (possibly grown) schema into the column order without disturbing user choices. */
  function syncColumns(schema: ColumnDef[]) {
    const s = get();
    const known = new Set(s.columnOrder);
    const added = schema.filter((c) => !known.has(c.key));
    if (added.length === 0) return {};
    const hidden = { ...s.hiddenColumns };
    const widths = { ...s.columnWidths };
    for (const c of added) {
      if (DEFAULT_HIDDEN.has(c.key)) hidden[c.key] = true;
      widths[c.key] ??= defaultColumnWidth(c);
    }
    return { columnOrder: [...s.columnOrder, ...added.map((c) => c.key)], hiddenColumns: hidden, columnWidths: widths };
  }

  function parse(sources: LogSource[], file: FileMeta, override: LogFormat | 'auto', resetFilters: boolean) {
    if (resetFilters && !get().keepFiltersOnLoad) set({ filters: EMPTY_FILTERS });
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
    startParse(sources, override === 'auto' ? undefined : override, (msg: WorkerResponse) => {
      switch (msg.type) {
        case 'start':
          set({ format: msg.format, detectedFormat: msg.detected, files: msg.files });
          break;
        case 'batch': {
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
          break;
        case 'error':
          set({ status: 'error', error: msg.message });
          break;
      }
    });
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
    progress: { bytesRead: 0, totalBytes: 0, lines: 0 },
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
    density: prefs.density,
    theme: prefs.theme,
    slowThresholdMs: prefs.slowThresholdMs,
    insightsOpen: prefs.insightsOpen,
    timeDisplay: prefs.timeDisplay,
    sidebarOpen: prefs.sidebarOpen && !isNarrowScreen(),
    focusMode: false,
    fileInfoExpanded: prefs.fileInfoExpanded,

    filters: initialFilters,
    keepFiltersOnLoad: hasActiveFilters(initialFilters),

    setFilters(patch) {
      set((s) => ({ filters: { ...s.filters, ...patch } }));
    },

    replaceFilters(filters) {
      set({ filters });
    },

    clearFilters() {
      set({ filters: EMPTY_FILTERS });
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
        if (all.length > 1) error = 'None of these files can be opened: choose non-empty .log, .txt, .gz or .zip files.';
        else if (!isAcceptedFile(f.name)) error = `"${f.name}" is not supported. Choose a .log, .txt, .gz or .zip file.`;
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

    setFormatOverride(format) {
      const { sources, file } = get();
      if (sources.length && file) parse(sources, file, format, false);
      else set({ formatOverride: format });
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
    },

    moveColumn(key, toIndex) {
      set((s) => {
        const order = s.columnOrder.filter((k) => k !== key);
        const i = Math.max(0, Math.min(order.length, toIndex));
        order.splice(i, 0, key);
        return { columnOrder: order };
      });
    },

    setColumnWidth(key, width) {
      set((s) => ({ columnWidths: { ...s.columnWidths, [key]: Math.max(MIN_COLUMN_WIDTH, Math.round(width)) } }));
    },

    resetColumns() {
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

    setSlowThreshold(ms) {
      const v = Number.isFinite(ms) && ms >= 0 ? ms : 1000;
      set({ slowThresholdMs: v });
      savePrefs({ slowThresholdMs: v });
    },
  };
});
