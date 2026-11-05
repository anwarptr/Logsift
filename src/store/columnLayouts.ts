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

const isLayout = (l: unknown): l is ColumnLayout =>
  !!l &&
  typeof l === 'object' &&
  Array.isArray((l as ColumnLayout).order) &&
  Array.isArray((l as ColumnLayout).hidden) &&
  typeof (l as ColumnLayout).widths === 'object';

export function loadLayout(key: string | null): ColumnLayout | null {
  if (!key) return null;
  const l = loadAll()[key];
  return isLayout(l) ? l : null;
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
  const prev = isLayout(all[key]) ? all[key] : null;
  const current = new Set(order);
  const kept = prev ? prev.order.filter((k) => !current.has(k)) : [];
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
 * Column order with a saved layout applied: columns the layout knows come first, in its order; the
 * others keep their current order after them.
 */
export function orderWithLayout(keys: string[], layout: ColumnLayout | null): string[] {
  if (!layout) return keys;
  const rank = new Map(layout.order.map((k, i) => [k, i]));
  const known = keys.filter((k) => rank.has(k)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  return [...known, ...keys.filter((k) => !rank.has(k))];
}
