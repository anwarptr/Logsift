import type { LogRow } from '../parser';
import { FLAG_HEALTH, FLAG_SCM, isErrorRow, type LogIndex } from './logIndex';
import type { FilterState } from './types';

/**
 * Each row gets a bitmask of the filters it fails. A row is visible when its
 * mask is 0. Facets, status classes and the URI filter get their own bit so
 * their lists can show counts "as if this filter were not applied" without
 * re-running the whole filter pass (standard faceted-search behaviour).
 */
export const BIT_OTHER = 1;
export const BIT_STATUS = 2;
export const BIT_URI = 4;
/** Above the facet bits (shift 3, at most 24 facets → bits 3..26). */
export const BIT_ENDPOINT = 1 << 30;
const FACET_BIT_SHIFT = 3;

export interface CompiledSearch {
  /** Case-insensitive matcher for filtering, or null when there is no (valid) search. */
  test: RegExp | null;
  /** Global variant for highlighting matches in cells. */
  highlight: RegExp | null;
  error: string | null;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileSearch(text: string, regex: boolean): CompiledSearch {
  if (!text) return { test: null, highlight: null, error: null };
  const source = regex ? text : escapeRegExp(text);
  try {
    return { test: new RegExp(source, 'i'), highlight: new RegExp(source, 'gi'), error: null };
  } catch (e) {
    return { test: null, highlight: null, error: e instanceof Error ? e.message : 'Invalid regular expression' };
  }
}

export interface FilterOptions {
  slowThresholdMs: number;
}

export interface FilterEval {
  /** Per-row failure mask; 0 means the row passes every filter. */
  mask: Uint32Array;
  /** Indices of passing rows, in file order. */
  matched: Uint32Array;
  /** Bit assigned to each facet column, by column key. */
  facetBits: Map<string, number>;
  searchError: string | null;
}

export function evaluateFilters(
  rows: readonly LogRow[],
  index: LogIndex,
  f: FilterState,
  opts: FilterOptions,
): FilterEval {
  const n = index.n;
  const mask = new Uint32Array(n);
  const facetBits = new Map<string, number>();
  index.facets.forEach((c, i) => facetBits.set(c.key, 1 << (FACET_BIT_SHIFT + i)));

  // Global search over the raw line.
  const search = compileSearch(f.search, f.regex);
  if (search.test) {
    const re = search.test;
    for (let i = 0; i < n; i++) if (!re.test(rows[i]!.raw)) mask[i]! |= BIT_OTHER;
  }

  // Time range.
  if (f.timeFrom !== null || f.timeTo !== null) {
    const from = f.timeFrom ?? -Infinity;
    const to = f.timeTo ?? Infinity;
    const ts = index.ts;
    for (let i = 0; i < n; i++) {
      const t = ts[i]!;
      // NaN (no timestamp) fails both comparisons and is excluded.
      if (!(t >= from && t <= to)) mask[i]! |= BIT_OTHER;
    }
  }

  // Numeric ranges.
  for (const key in f.ranges) {
    const range = f.ranges[key]!;
    const col = index.ranges.find((r) => r.key === key);
    if (!col || (range[0] === null && range[1] === null)) continue;
    const lo = range[0] ?? -Infinity;
    const hi = range[1] ?? Infinity;
    const vals = col.values;
    for (let i = 0; i < n; i++) {
      const v = vals[i]!;
      if (!(v >= lo && v <= hi)) mask[i]! |= BIT_OTHER;
    }
  }

  // Facets: OR within a column, AND across columns.
  for (const key in f.facets) {
    const selected = f.facets[key]!;
    if (selected.length === 0) continue;
    const col = index.facets.find((c) => c.key === key);
    const bit = facetBits.get(key);
    if (!col || bit === undefined) continue;
    const allowed = new Uint8Array(col.values.length);
    const want = new Set(selected);
    col.values.forEach((v, code) => {
      if (want.has(v)) allowed[code] = 1;
    });
    const codes = col.codes;
    for (let i = 0; i < n; i++) if (!allowed[codes[i]!]) mask[i]! |= bit;
  }

  // Status classes (2xx/3xx/...).
  if (f.statusClasses.length > 0 && index.status) {
    const allowed = new Uint8Array(10);
    for (const c of f.statusClasses) allowed[Number(c[0])] = 1;
    const st = index.status;
    for (let i = 0; i < n; i++) {
      const s = st[i]!;
      const cls = Math.floor(s / 100);
      if (!(cls >= 0 && cls < 10 && allowed[cls])) mask[i]! |= BIT_STATUS;
    }
  }

  // URI stem.
  if (f.uri && index.uri) {
    const needle = f.uri.toLowerCase();
    const uris = index.uri;
    const mode = f.uriMode;
    for (let i = 0; i < n; i++) {
      const u = uris[i];
      let ok = false;
      if (u != null) {
        const l = u.toLowerCase();
        ok = mode === 'equals' ? l === needle : mode === 'startsWith' ? l.startsWith(needle) : l.includes(needle);
      }
      if (!ok) mask[i]! |= BIT_URI;
    }
  }

  // Endpoint (URI pattern), with its own bit so the Endpoints view can list every endpoint while one is selected.
  if (f.endpoint && index.uriPattern) {
    const code = index.uriPattern.values.indexOf(f.endpoint);
    const codes = index.uriPattern.codes;
    for (let i = 0; i < n; i++) if (codes[i] !== code) mask[i]! |= BIT_ENDPOINT;
  }

  // Quick toggles.
  const flags = index.flags;
  if (f.hideHealthChecks && index.hasHealthCheck) {
    for (let i = 0; i < n; i++) if (flags[i]! & FLAG_HEALTH) mask[i]! |= BIT_OTHER;
  }
  if (f.hideScm && index.hasScm) {
    for (let i = 0; i < n; i++) if (flags[i]! & FLAG_SCM) mask[i]! |= BIT_OTHER;
  }
  if (f.onlyErrors && (index.status || index.hasLevel)) {
    for (let i = 0; i < n; i++) if (!isErrorRow(index, i)) mask[i]! |= BIT_OTHER;
  }
  if (f.onlySlow && index.duration) {
    const d = index.duration;
    const threshold = opts.slowThresholdMs;
    for (let i = 0; i < n; i++) if (!(d[i]! > threshold)) mask[i]! |= BIT_OTHER;
  }

  let count = 0;
  for (let i = 0; i < n; i++) if (mask[i] === 0) count++;
  const matched = new Uint32Array(count);
  for (let i = 0, j = 0; i < n; i++) if (mask[i] === 0) matched[j++] = i;

  return { mask, matched, facetBits, searchError: search.error };
}

/** Convenience wrapper returning only the passing row indices. */
export function applyFilters(
  rows: readonly LogRow[],
  index: LogIndex,
  f: FilterState,
  opts: FilterOptions,
): Uint32Array {
  return evaluateFilters(rows, index, f, opts).matched;
}
