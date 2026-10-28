import { create } from 'zustand';
import type { ColumnDef, LogFormat, LogRow, MalformedRow } from '../parser';
import { startParse } from '../worker/client';
import type { WorkerResponse } from '../worker/protocol';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface FileMeta {
  name: string;
  size: number;
}

export interface LogState {
  status: LoadStatus;
  error: string | null;
  file: FileMeta | null;
  /** Kept so the file can be re-parsed with a different format override. */
  source: Blob | null;
  format: LogFormat | null;
  detectedFormat: LogFormat | null;
  formatOverride: LogFormat | 'auto';
  progress: { bytesRead: number; totalBytes: number; lines: number };
  parseMs: number | null;

  rows: LogRow[];
  malformed: MalformedRow[];
  meta: string[];
  schema: ColumnDef[];

  loadFile(file: File): void;
  setFormatOverride(format: LogFormat | 'auto'): void;
  setError(message: string): void;
}

export const ACCEPTED_EXTENSIONS = ['.log', '.txt'];

export function isAcceptedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export const useLogStore = create<LogState>()((set, get) => {
  function parse(source: Blob, file: FileMeta, override: LogFormat | 'auto') {
    set({
      status: 'loading',
      error: null,
      file,
      source,
      format: null,
      detectedFormat: null,
      formatOverride: override,
      progress: { bytesRead: 0, totalBytes: source.size, lines: 0 },
      parseMs: null,
      rows: [],
      malformed: [],
      meta: [],
      schema: [],
    });
    startParse(source, override === 'auto' ? undefined : override, (msg: WorkerResponse) => {
      switch (msg.type) {
        case 'start':
          set({ format: msg.format, detectedFormat: msg.detected });
          break;
        case 'batch': {
          const s = get();
          set({
            rows: msg.rows.length ? s.rows.concat(msg.rows) : s.rows,
            malformed: msg.malformed.length ? s.malformed.concat(msg.malformed) : s.malformed,
            meta: msg.meta.length ? s.meta.concat(msg.meta) : s.meta,
            schema: msg.schema,
          });
          break;
        }
        case 'progress':
          set({ progress: { bytesRead: msg.bytesRead, totalBytes: msg.totalBytes, lines: msg.lines } });
          break;
        case 'done':
          set((s) => ({ status: 'ready', parseMs: msg.elapsedMs, progress: { ...s.progress, lines: msg.lines } }));
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
    source: null,
    format: null,
    detectedFormat: null,
    formatOverride: 'auto',
    progress: { bytesRead: 0, totalBytes: 0, lines: 0 },
    parseMs: null,
    rows: [],
    malformed: [],
    meta: [],
    schema: [],

    loadFile(file) {
      if (!isAcceptedFile(file.name)) {
        set({ status: 'error', error: `"${file.name}" is not supported. Choose a .log or .txt file.` });
        return;
      }
      if (file.size === 0) {
        set({ status: 'error', error: `"${file.name}" is empty.`, file: { name: file.name, size: 0 } });
        return;
      }
      parse(file, { name: file.name, size: file.size }, get().formatOverride);
    },

    setFormatOverride(format) {
      const { source, file } = get();
      if (source && file) parse(source, file, format);
      else set({ formatOverride: format });
    },

    setError(message) {
      set({ status: 'error', error: message });
    },
  };
});
