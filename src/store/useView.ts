import { useMemo } from 'react';
import { BIT_ENDPOINT, compileSearch, evaluateFilters, type FilterEval } from '../filters/applyFilters';
import { buildLogIndex, type LogIndex } from '../filters/logIndex';
import type { FilterState } from '../filters/types';
import type { ColumnDef, LogRow, LogTimeZone } from '../parser';
import { computeEndpoints, type EndpointStat } from '../utils/endpoints';
import { computeInsights, type Insights } from '../utils/insights';
import { sortIndices } from '../utils/sort';
import { logDisplayZone, type DisplayZone } from '../utils/timezone';
import { useLogStore } from './logStore';
import type { TimeDisplay } from './prefs';

/**
 * Derived data is shared by the table, sidebar and insights panel, so it is
 * memoized at module level (by input identity) rather than per component.
 */
function memoLast<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let lastArgs: A | null = null;
  let lastResult: R;
  return (...args: A) => {
    if (lastArgs && lastArgs.length === args.length && lastArgs.every((a, i) => Object.is(a, args[i]))) return lastResult;
    lastResult = fn(...args);
    lastArgs = args;
    return lastResult;
  };
}

const getIndex = memoLast((rows: LogRow[], schema: ColumnDef[]) => buildLogIndex(rows, schema));
const getEval = memoLast((rows: LogRow[], index: LogIndex, filters: FilterState, slowThresholdMs: number) =>
  evaluateFilters(rows, index, filters, { slowThresholdMs }),
);
const getAllIndices = memoLast((n: number) => {
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
});
const getSorted = memoLast((rows: LogRow[], indices: Uint32Array, col: ColumnDef | undefined, dir: 'asc' | 'desc' | undefined) =>
  col && dir ? sortIndices(rows, indices, col, dir) : indices,
);

/** Columnar index; null while a file is still loading (rebuilding it per batch would waste time). */
export function useLogIndex(): LogIndex | null {
  const rows = useLogStore((s) => s.rows);
  const schema = useLogStore((s) => s.schema);
  const ready = useLogStore((s) => s.status === 'ready');
  return ready ? getIndex(rows, schema) : null;
}

/** Filter evaluation for the current filters, or null while loading. */
export function useFilterEval(): FilterEval | null {
  const rows = useLogStore((s) => s.rows);
  const filters = useLogStore((s) => s.filters);
  const slow = useLogStore((s) => s.slowThresholdMs);
  const index = useLogIndex();
  return index ? getEval(rows, index, filters, slow) : null;
}

/** Row indices matching the filters (all rows while loading), in file order. */
export function useMatchedIndices(): Uint32Array {
  const rows = useLogStore((s) => s.rows);
  const ev = useFilterEval();
  return ev ? ev.matched : getAllIndices(rows.length);
}

/** Matched row indices in display order. */
export function useDisplayIndices(): Uint32Array {
  const rows = useLogStore((s) => s.rows);
  const schema = useLogStore((s) => s.schema);
  const sort = useLogStore((s) => s.sort);
  const matched = useMatchedIndices();
  const col = sort ? schema.find((c) => c.key === sort.key) : undefined;
  return getSorted(rows, matched, col, sort?.dir);
}

const getInsights = memoLast(
  (rows: LogRow[], schema: ColumnDef[], index: LogIndex, matched: Uint32Array, zone: DisplayZone) =>
    computeInsights(rows, schema, index, matched, undefined, zone),
);

/** Insights over the filtered rows; null while loading. */
export function useInsights(): Insights | null {
  const rows = useLogStore((s) => s.rows);
  const schema = useLogStore((s) => s.schema);
  const index = useLogIndex();
  const ev = useFilterEval();
  const zone = useDisplayZone();
  return index && ev ? getInsights(rows, schema, index, ev.matched, zone) : null;
}

export function useSearchHighlight(): RegExp | null {
  const search = useLogStore((s) => s.filters.search);
  const regex = useLogStore((s) => s.filters.regex);
  return useMemo(() => compileSearch(search, regex).highlight, [search, regex]);
}

/** Visible columns in display order. */
export function useVisibleColumns(): ColumnDef[] {
  const schema = useLogStore((s) => s.schema);
  const order = useLogStore((s) => s.columnOrder);
  const hidden = useLogStore((s) => s.hiddenColumns);
  return useMemo(() => {
    const byKey = new Map(schema.map((c) => [c.key, c]));
    return order.filter((k) => !hidden[k]).map((k) => byKey.get(k)).filter((c): c is ColumnDef => c !== undefined);
  }, [schema, order, hidden]);
}

const LOCAL_ZONE: DisplayZone = { kind: 'local' };
// Module-level so every component gets the same object (it feeds the memoized insights).
const getZone = memoLast((display: TimeDisplay, tz: LogTimeZone | null) =>
  display === 'local' ? LOCAL_ZONE : logDisplayZone(tz),
);

/** Zone timestamps are shown in: the log's own zone, or local time when the user switched to it. */
export function useDisplayZone(): DisplayZone {
  const tz = useLogStore((s) => s.logTimeZone);
  const display = useLogStore((s) => s.timeDisplay);
  return getZone(display, tz);
}

const getEndpoints = memoLast((rows: LogRow[], index: LogIndex, mask: Uint32Array, methodKey: string | undefined) =>
  computeEndpoints(rows, index, mask, BIT_ENDPOINT, methodKey),
);

/** Per-endpoint stats over the filtered rows, ignoring the endpoint filter itself; null while loading. */
export function useEndpoints(): EndpointStat[] | null {
  const rows = useLogStore((s) => s.rows);
  const schema = useLogStore((s) => s.schema);
  const index = useLogIndex();
  const ev = useFilterEval();
  const methodKey = schema.find((c) => c.role === 'method')?.key;
  if (!index?.uriPattern || !ev) return null;
  return getEndpoints(rows, index, ev.mask, methodKey);
}
