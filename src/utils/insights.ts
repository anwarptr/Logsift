import { topN, type FacetEntry } from '../filters/facets';
import { FLAG_ERROR_LEVEL, type LogIndex } from '../filters/logIndex';
import type { ColumnDef, LogRow } from '../parser';
import { autoBucketSize, histogram, summarize, type Histogram, type NumberSummary } from './stats';
import { alignOffsetMs, UTC_ZONE, type DisplayZone } from './timezone';

export interface Insights {
  total: number;
  errors: number;
  /** Whether "errors" is based on HTTP status (true) or log level (false); null if neither exists. */
  errorBasis: 'status' | 'level' | null;
  duration: NumberSummary | null;
  bytesSent: number | null;
  timeline: (Histogram & { errors: Uint32Array }) | null;
  /** Status code (or level) distribution, most frequent first. */
  distribution: FacetEntry[];
  distributionKind: 'status' | 'level' | null;
  topUris: FacetEntry[];
  topIps: FacetEntry[];
  slowest: { id: number; duration: number }[];
}

function topValues(rows: readonly LogRow[], matched: Uint32Array, key: string | undefined, limit: number): FacetEntry[] {
  if (!key) return [];
  const counts = new Map<string, number>();
  for (let i = 0; i < matched.length; i++) {
    const v = rows[matched[i]!]!.values[key];
    if (v === null || v === undefined) continue;
    const k = String(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return topN(counts, limit);
}

export function computeInsights(
  rows: readonly LogRow[],
  schema: ColumnDef[],
  index: LogIndex,
  matched: Uint32Array,
  targetBuckets = 60,
  zone: DisplayZone = UTC_ZONE,
): Insights {
  const n = matched.length;
  const byRole = (r: ColumnDef['role']) => schema.find((c) => c.role === r)?.key;

  // Errors.
  let errors = 0;
  const isError = new Uint8Array(n);
  const errorBasis = index.status ? 'status' : index.hasLevel ? 'level' : null;
  if (index.status) {
    for (let i = 0; i < n; i++) if (index.status[matched[i]!]! >= 400) (isError[i] = 1), errors++;
  } else if (index.hasLevel) {
    for (let i = 0; i < n; i++) if (index.flags[matched[i]!]! & FLAG_ERROR_LEVEL) (isError[i] = 1), errors++;
  }

  // Duration stats + slowest.
  let duration: NumberSummary | null = null;
  const slowest: { id: number; duration: number }[] = [];
  if (index.duration) {
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = index.duration[matched[i]!]!;
      d[i] = v;
      if (!Number.isFinite(v)) continue;
      if (slowest.length < 10 || v > slowest[slowest.length - 1]!.duration) {
        slowest.push({ id: matched[i]!, duration: v });
        slowest.sort((a, b) => b.duration - a.duration);
        if (slowest.length > 10) slowest.pop();
      }
    }
    duration = summarize(d);
  }

  // Bytes sent.
  let bytesSent: number | null = null;
  const bytesKey = byRole('bytesSent');
  if (bytesKey) {
    const col = index.ranges.find((r) => r.key === bytesKey);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = col ? col.values[matched[i]!]! : rows[matched[i]!]!.values[bytesKey];
      if (typeof v === 'number' && Number.isFinite(v)) sum += v;
    }
    bytesSent = sum;
  }

  // Timeline histogram (with an error series).
  let timeline: Insights['timeline'] = null;
  let min = Infinity;
  let max = -Infinity;
  const ts = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = index.ts[matched[i]!]!;
    ts[i] = t;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (min <= max) {
    const bucketMs = autoBucketSize(max - min, targetBuckets);
    const h = histogram(ts, min, max, bucketMs, alignOffsetMs(zone, min));
    const errs = new Uint32Array(h.counts.length);
    for (let i = 0; i < n; i++) {
      if (!isError[i]) continue;
      const t = ts[i]!;
      if (Number.isFinite(t)) errs[Math.min(errs.length - 1, Math.floor((t - h.start) / bucketMs))]!++;
    }
    timeline = { ...h, errors: errs };
  }

  const statusKey = byRole('status');
  const levelKey = byRole('level');
  const distKey = statusKey ?? levelKey;

  return {
    total: n,
    errors,
    errorBasis,
    duration,
    bytesSent,
    timeline,
    distribution: topValues(rows, matched, distKey, 12),
    distributionKind: statusKey ? 'status' : levelKey ? 'level' : null,
    topUris: topValues(rows, matched, byRole('uri'), 10),
    topIps: topValues(rows, matched, byRole('clientIp'), 10),
    slowest,
  };
}
