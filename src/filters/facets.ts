import { BIT_STATUS, BIT_URI, type FilterEval } from './applyFilters';
import type { FacetColumn, LogIndex } from './logIndex';
import { facetLabel, type StatusClass } from './types';

export interface FacetEntry {
  key: string;
  label: string;
  count: number;
}

/** Rows that pass every filter except the ones in `ignoreBits`. */
function passesExcept(mask: number, ignoreBits: number): boolean {
  return (mask & ~ignoreBits) === 0;
}

/**
 * Value counts for a facet column over the rows matching every *other* filter,
 * so selecting a value doesn't make its siblings disappear.
 */
export function facetCounts(col: FacetColumn, ev: FilterEval): FacetEntry[] {
  const bit = ev.facetBits.get(col.key) ?? 0;
  const counts = new Uint32Array(col.values.length);
  const { mask } = ev;
  const codes = col.codes;
  for (let i = 0; i < mask.length; i++) {
    if (passesExcept(mask[i]!, bit)) counts[codes[i]!]!++;
  }
  return col.values
    .map((key, code) => ({ key, label: facetLabel(key), count: counts[code]! }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, undefined, { numeric: true }));
}

export function statusClassCounts(index: LogIndex, ev: FilterEval): Record<StatusClass, number> {
  const out: Record<StatusClass, number> = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  const st = index.status;
  if (!st) return out;
  const { mask } = ev;
  for (let i = 0; i < mask.length; i++) {
    if (!passesExcept(mask[i]!, BIT_STATUS)) continue;
    const c = Math.floor(st[i]! / 100);
    if (c >= 1 && c <= 5) out[`${c}xx` as StatusClass]++;
  }
  return out;
}

/** Most frequent URI stems among rows matching every filter except the URI filter. */
export function topUris(index: LogIndex, ev: FilterEval, limit = 10): FacetEntry[] {
  const uris = index.uri;
  if (!uris) return [];
  const counts = new Map<string, number>();
  const { mask } = ev;
  for (let i = 0; i < mask.length; i++) {
    if (!passesExcept(mask[i]!, BIT_URI)) continue;
    const u = uris[i];
    if (u == null) continue;
    counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  return topN(counts, limit);
}

export function topN(counts: Map<string, number>, limit: number): FacetEntry[] {
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([key, count]) => ({ key, label: facetLabel(key), count }));
}
