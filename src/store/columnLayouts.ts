import type { LogFormat } from '../parser';

/**
 * Column order, widths and hidden columns remembered per log format (and per pattern for the custom
 * format), so the next log of the same kind opens the way it was left. Kept by column key: a layout
 * only affects columns with the same names, so JSON logs of different apps don't disturb each other.
 * Stored in localStorage; failures (private mode) are ignored.
 */
export interface ColumnLayout {
  /** Column keys in display order (also ones not in the current log, kept from earlier logs). */
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
  /** Last change (ms), to forget the oldest layouts first. */
  at: number;
}

const KEY = 'logsift:column-layouts';
/** Layouts kept at most (the custom format has one per pattern). */
const MAX_LAYOUTS = 30;
/** Columns one layout remembers at most (this log's, then earlier logs' columns). */
export const MAX_LAYOUT_COLUMNS = 300;

export function layoutKey(format: LogFormat | null, pattern: string): string | null {
  if (!format) return null;
  return format === 'custom' ? `custom:${pattern}` : format;
}

function loadAll(): Record<string, ColumnLayout> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as unknown;
    return all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, ColumnLayout>) : {};
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, ColumnLayout>): void {
  try {
    // Newest first; on equal times the one saved last wins (saveLayout re-inserts the key it saves).
    const keys = Object.keys(all)
      .reverse()
      .sort((a, b) => (all[b]!.at ?? 0) - (all[a]!.at ?? 0));
    for (const k of keys.slice(MAX_LAYOUTS)) delete all[k];
    globalThis.localStorage?.setItem(KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A stored layout, cleaned up (it may have been edited, or written by another version); null if unusable. */
function readLayout(l: unknown): ColumnLayout | null {
  if (!l || typeof l !== 'object') return null;
  const { order, hidden, widths, at } = l as Partial<ColumnLayout>;
  if (!isStringArray(order) || !isStringArray(hidden)) return null;
  const clean: Record<string, number> = {};
  if (widths && typeof widths === 'object' && !Array.isArray(widths)) {
    for (const [k, w] of Object.entries(widths)) if (typeof w === 'number' && Number.isFinite(w) && w > 0) clean[k] = w;
  }
  return { order, hidden, widths: clean, at: typeof at === 'number' ? at : 0 };
}

export function loadLayout(key: string | null): ColumnLayout | null {
  if (!key) return null;
  return readLayout(loadAll()[key]);
}

/**
 * Remember the current columns for `key`. Columns of earlier logs that this one doesn't have keep
 * their saved state (and stay after this log's columns in the order).
 */
export function saveLayout(
  key: string | null,
  order: string[],
  hidden: Record<string, true>,
  widths: Record<string, number>,
): void {
  if (!key) return;
  const all = loadAll();
  const prev = readLayout(all[key]);
  const current = new Set(order);
  // Columns of earlier logs, most recently placed first, up to a limit (JSON logs of many apps).
  const kept = prev ? prev.order.filter((k) => !current.has(k)).slice(0, Math.max(0, MAX_LAYOUT_COLUMNS - order.length)) : [];
  const keptSet = new Set(kept);
  const keptWidths: Record<string, number> = {};
  for (const k of kept) if (prev?.widths[k] !== undefined) keptWidths[k] = prev.widths[k]!;
  delete all[key];
  all[key] = {
    order: [...order, ...kept],
    hidden: [...order.filter((k) => hidden[k]), ...(prev?.hidden.filter((k) => keptSet.has(k)) ?? [])],
    widths: { ...keptWidths, ...Object.fromEntries(order.filter((k) => widths[k] !== undefined).map((k) => [k, widths[k]!])) },
    at: Date.now(),
  };
  saveAll(all);
}

export function clearLayout(key: string | null): void {
  if (!key) return;
  const all = loadAll();
  if (!(key in all)) return;
  delete all[key];
  saveAll(all);
}

/**
 * Add new columns to the current order: each one the layout knows goes right after the nearest column
 * that comes before it in the layout (first if none); the others go at the end. Columns already in
 * the order are never moved, so the user's choices in this session stay even if the saved layout is
 * stale (storage full or unavailable).
 */
export function insertWithLayout(current: string[], added: string[], layout: ColumnLayout | null): string[] {
  if (!layout) return [...current, ...added];
  const rank = new Map(layout.order.map((k, i) => [k, i]));
  const out = [...current];
  const known = added.filter((k) => rank.has(k)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  for (const k of known) {
    const r = rank.get(k)!;
    // The column placed before this one in the layout that is already in the order, if any.
    let at = -1;
    let best = -1;
    for (let i = 0; i < out.length; i++) {
      const ri = rank.get(out[i]!);
      if (ri !== undefined && ri < r && ri > best) {
        best = ri;
        at = i;
      }
    }
    out.splice(at + 1, 0, k);
  }
  return [...out, ...added.filter((k) => !rank.has(k))];
}
