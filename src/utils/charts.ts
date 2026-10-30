import { isErrorRow, type LogIndex } from '../filters/logIndex';
import { NULL_KEY, type StatusClass } from '../filters/types';
import type { ColumnDef, LogRow } from '../parser';
import { autoBucketSize, percentile } from './stats';
import { zoneOffsetAt, type DisplayZone } from './timezone';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------- Response times over time ----------

export interface ResponseTimes {
  /** Start of the first bucket and bucket size (ms). */
  start: number;
  bucketMs: number;
  /** Per bucket: requests with a duration, and their p50 / p95 / max (NaN when empty). */
  count: Uint32Array;
  p50: Float64Array;
  p95: Float64Array;
  max: Float64Array;
  minTs: number;
  maxTs: number;
  /** Smallest and largest duration (for the y-axis). */
  minMs: number;
  maxMs: number;
  /** Rows plotted (with a timestamp and a duration). */
  total: number;
}

/** Durations of the matched rows over time, bucketed like the requests-over-time chart. */
export function responseTimes(index: LogIndex, matched: Uint32Array, zone: DisplayZone, targetBuckets = 80): ResponseTimes | null {
  const dur = index.duration;
  if (!dur) return null;
  let minTs = Infinity;
  let maxTs = -Infinity;
  let minMs = Infinity;
  let maxMs = -Infinity;
  let total = 0;
  for (let k = 0; k < matched.length; k++) {
    const r = matched[k]!;
    const t = index.ts[r]!;
    const d = dur[r]!;
    if (!Number.isFinite(t) || !Number.isFinite(d)) continue;
    total++;
    if (t < minTs) minTs = t;
    if (t > maxTs) maxTs = t;
    if (d < minMs) minMs = d;
    if (d > maxMs) maxMs = d;
  }
  if (total === 0) return null;
  const bucketMs = autoBucketSize(maxTs - minTs, targetBuckets);
  const align = zoneOffsetAt(zone, minTs) * 60_000;
  const start = Math.floor((minTs + align) / bucketMs) * bucketMs - align;
  const n = Math.max(1, Math.floor((maxTs - start) / bucketMs) + 1);
  const count = new Uint32Array(n);
  const bucketOf = (t: number) => Math.min(n - 1, Math.floor((t - start) / bucketMs));
  for (let k = 0; k < matched.length; k++) {
    const r = matched[k]!;
    if (Number.isFinite(index.ts[r]!) && Number.isFinite(dur[r]!)) count[bucketOf(index.ts[r]!)]!++;
  }
  // Durations grouped by bucket in one array (counting sort), then sorted per bucket for percentiles.
  const offsets = new Uint32Array(n + 1);
  for (let b = 0; b < n; b++) offsets[b + 1] = offsets[b]! + count[b]!;
  const filled = new Uint32Array(n);
  const byBucket = new Float64Array(total);
  for (let k = 0; k < matched.length; k++) {
    const r = matched[k]!;
    const t = index.ts[r]!;
    const d = dur[r]!;
    if (!Number.isFinite(t) || !Number.isFinite(d)) continue;
    const b = bucketOf(t);
    byBucket[offsets[b]! + filled[b]!++] = d;
  }
  const p50 = new Float64Array(n).fill(Number.NaN);
  const p95 = new Float64Array(n).fill(Number.NaN);
  const max = new Float64Array(n).fill(Number.NaN);
  for (let b = 0; b < n; b++) {
    if (count[b] === 0) continue;
    const d = byBucket.subarray(offsets[b]!, offsets[b + 1]!).sort();
    p50[b] = percentile(d, 50);
    p95[b] = percentile(d, 95);
    max[b] = d[d.length - 1]!;
  }
  return { start, bucketMs, count, p50, p95, max, minTs, maxTs, minMs, maxMs, total };
}

// ---------- Duration distribution ----------

/** Bin edges in ms: each bin is [edge, next edge). */
export const DURATION_EDGES = [0, 10, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 30_000];

export interface DurationBin {
  from: number;
  /** Exclusive upper bound; Infinity for the last bin. */
  to: number;
  label: string;
  /** Compact axis label: "<10", "10–50", "1–2s", "≥30s" (ms unless marked s). */
  short: string;
  count: number;
  errors: number;
}

const msLabel = (ms: number) => (ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`);
const num = (ms: number) => (ms >= 1000 ? `${ms / 1000}s` : String(ms));
/** "1–2s" rather than "1s–2s" when both ends are in seconds. */
const shortRange = (a: number, b: number) => (a >= 1000 ? `${a / 1000}–${b / 1000}s` : `${a}–${num(b)}`);

/** How many matched requests fall in each duration range, and how many of those are errors. */
export function durationBins(index: LogIndex, matched: Uint32Array): DurationBin[] | null {
  const dur = index.duration;
  if (!dur) return null;
  const bins: DurationBin[] = DURATION_EDGES.map((from, i) => {
    const to = DURATION_EDGES[i + 1] ?? Infinity;
    const label = i === 0 ? `< ${msLabel(to)}` : to === Infinity ? `≥ ${msLabel(from)}` : `${msLabel(from)}–${msLabel(to)}`;
    const short = i === 0 ? `<${num(to)}` : to === Infinity ? `≥${num(from)}` : shortRange(from, to);
    return { from, to, label, short, count: 0, errors: 0 };
  });
  let any = false;
  for (let k = 0; k < matched.length; k++) {
    const r = matched[k]!;
    const d = dur[r]!;
    if (!Number.isFinite(d)) continue;
    any = true;
    let i = bins.length - 1;
    while (i > 0 && d < bins[i]!.from) i--;
    bins[i]!.count++;
    if (isErrorRow(index, r)) bins[i]!.errors++;
  }
  return any ? bins : null;
}

// ---------- Traffic heatmap ----------

export interface Heatmap {
  /** 'days': one row per calendar day; 'weekdays': Mon–Sun totals (when the log spans more than 31 days). */
  mode: 'days' | 'weekdays';
  rows: { label: string; /** UTC ms of the row's midnight in the display zone ('days' only). */ start: number | null }[];
  /** rows × 24, row-major. */
  counts: Uint32Array;
  errors: Uint32Array;
  maxCount: number;
  maxErrors: number;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const MAX_HEATMAP_DAYS = 31;

/** Matched rows by day (or weekday) and hour of day, in the display zone. */
export function heatmap(index: LogIndex, matched: Uint32Array, zone: DisplayZone): Heatmap | null {
  let minDay = Infinity;
  let maxDay = -Infinity;
  const wall = (t: number) => t + zoneOffsetAt(zone, t) * 60_000;
  for (let k = 0; k < matched.length; k++) {
    const t = index.ts[matched[k]!]!;
    if (!Number.isFinite(t)) continue;
    const d = Math.floor(wall(t) / DAY);
    if (d < minDay) minDay = d;
    if (d > maxDay) maxDay = d;
  }
  if (minDay > maxDay) return null;
  const mode = maxDay - minDay + 1 <= MAX_HEATMAP_DAYS ? 'days' : 'weekdays';
  const nRows = mode === 'days' ? maxDay - minDay + 1 : 7;
  const counts = new Uint32Array(nRows * 24);
  const errors = new Uint32Array(nRows * 24);
  for (let k = 0; k < matched.length; k++) {
    const r = matched[k]!;
    const t = index.ts[r]!;
    if (!Number.isFinite(t)) continue;
    const w = wall(t);
    const day = Math.floor(w / DAY);
    const hour = Math.floor((w - day * DAY) / HOUR);
    // 1970-01-01 was a Thursday: (day + 3) % 7 makes Monday 0.
    const row = mode === 'days' ? day - minDay : (((day + 3) % 7) + 7) % 7;
    counts[row * 24 + hour]!++;
    if (isErrorRow(index, r)) errors[row * 24 + hour]!++;
  }
  const rows =
    mode === 'days'
      ? Array.from({ length: nRows }, (_, i) => {
          const dayWall = (minDay + i) * DAY;
          const label = new Date(dayWall).toISOString().slice(0, 10);
          return { label, start: dayWall - zoneOffsetAt(zone, dayWall) * 60_000 };
        })
      : WEEKDAYS.map((label) => ({ label, start: null }));
  let maxCount = 0;
  let maxErrors = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i]! > maxCount) maxCount = counts[i]!;
    if (errors[i]! > maxErrors) maxErrors = errors[i]!;
  }
  return { mode, rows, counts, errors, maxCount, maxErrors };
}

// ---------- Request flow (caller → endpoint → status) ----------

export const OTHER_KEY = '\u0000other';

export interface FlowNode {
  key: string;
  label: string;
  count: number;
  errors: number;
}

export interface Flow {
  /** Column the callers come from (client IP, host, site or logger). */
  callerKey: string;
  callerLabel: string;
  /** Empty when the log has no caller column (or it is always empty): the flow then starts at the endpoints. */
  callers: FlowNode[];
  endpoints: FlowNode[];
  statuses: (FlowNode & { cls: StatusClass | null })[];
  /** Counts per [caller index, endpoint index] and [endpoint index, status index]. */
  callerToEndpoint: Map<string, number>;
  endpointToStatus: Map<string, number>;
}

const CALLER_ROLES = ['clientIp', 'host', 'site', 'logger'] as const;
const STATUS_ORDER: (StatusClass | null)[] = ['2xx', '3xx', '4xx', '5xx', '1xx', null];

/** Most frequent keys of `counts`, the rest folded into "Other". Returns the kept keys in order and a key → index map. */
function topKeys(counts: Map<string, number>, limit: number): { keys: string[]; indexOf: (k: string) => number } {
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const keys = sorted.slice(0, sorted.length > limit + 1 ? limit : limit + 1).map(([k]) => k);
  const pos = new Map(keys.map((k, i) => [k, i]));
  const folded = sorted.length > keys.length;
  if (folded) keys.push(OTHER_KEY);
  return { keys, indexOf: (k) => pos.get(k) ?? keys.length - 1 };
}

/**
 * Who calls which endpoints, and how those calls end: top callers (client IP, else host/site/logger)
 * → top endpoint patterns → status classes, over the matched rows that have a URI (other lines, such as
 * application messages in a Serilog log, are not requests). null without URIs and statuses.
 */
export function requestFlow(
  rows: readonly LogRow[],
  schema: ColumnDef[],
  index: LogIndex,
  matched: Uint32Array,
  limits = { callers: 8, endpoints: 10 },
): Flow | null {
  const pat = index.uriPattern;
  const status = index.status;
  if (!pat || !status || !index.uri) return null;
  const uri = index.uri;
  const requests = matched.filter((r) => uri[r] !== null);
  if (requests.length === 0) return null;
  const callerCol = CALLER_ROLES.map((role) => schema.find((c) => c.role === role)).find((c) => c !== undefined);
  const callerOf = (r: number) => {
    if (!callerCol) return NULL_KEY;
    const v = rows[r]!.values[callerCol.key];
    return v === null || v === undefined || v === '' ? NULL_KEY : String(v);
  };
  const callerCounts = new Map<string, number>();
  const endpointCounts = new Map<string, number>();
  for (let k = 0; k < requests.length; k++) {
    const r = requests[k]!;
    const c = callerOf(r);
    callerCounts.set(c, (callerCounts.get(c) ?? 0) + 1);
    const e = pat.values[pat.codes[r]!]!;
    endpointCounts.set(e, (endpointCounts.get(e) ?? 0) + 1);
  }
  const callerTop = topKeys(callerCounts, limits.callers);
  const endpointTop = topKeys(endpointCounts, limits.endpoints);
  const node = (key: string): FlowNode => ({ key, label: key === OTHER_KEY ? 'Other' : key === NULL_KEY ? '(empty)' : key, count: 0, errors: 0 });
  const noCallers = callerTop.keys.length === 1 && callerTop.keys[0] === NULL_KEY;
  const callers = callerTop.keys.map(node);
  const endpoints = endpointTop.keys.map(node);
  const statuses = STATUS_ORDER.map((cls) => ({ ...node(cls ?? 'none'), label: cls ?? 'No status', cls }));
  const statusIndex = (s: number): number => {
    if (!Number.isFinite(s)) return STATUS_ORDER.length - 1;
    const i = STATUS_ORDER.indexOf(`${Math.floor(s / 100)}xx` as StatusClass);
    return i < 0 ? STATUS_ORDER.length - 1 : i;
  };
  const callerToEndpoint = new Map<string, number>();
  const endpointToStatus = new Map<string, number>();
  for (let k = 0; k < requests.length; k++) {
    const r = requests[k]!;
    const ci = callerTop.indexOf(callerOf(r));
    const ei = endpointTop.indexOf(pat.values[pat.codes[r]!]!);
    const si = statusIndex(status[r]!);
    const err = isErrorRow(index, r);
    for (const n of [callers[ci]!, endpoints[ei]!, statuses[si]!]) {
      n.count++;
      if (err) n.errors++;
    }
    const a = `${ci},${ei}`;
    const b = `${ei},${si}`;
    callerToEndpoint.set(a, (callerToEndpoint.get(a) ?? 0) + 1);
    endpointToStatus.set(b, (endpointToStatus.get(b) ?? 0) + 1);
  }
  return {
    callerKey: callerCol?.key ?? '',
    callerLabel: callerCol?.label ?? 'caller',
    callers: noCallers ? [] : callers,
    endpoints,
    statuses: statuses.filter((s) => s.count > 0),
    callerToEndpoint: noCallers ? new Map() : callerToEndpoint,
    endpointToStatus: remapStatuses(endpointToStatus, statuses),
  };
}

/** Status indices shift once empty status classes are dropped. */
function remapStatuses(links: Map<string, number>, statuses: FlowNode[]): Map<string, number> {
  const kept = statuses.map((s, i) => (s.count > 0 ? i : -1)).filter((i) => i >= 0);
  const out = new Map<string, number>();
  for (const [k, v] of links) {
    const [e, s] = k.split(',').map(Number);
    out.set(`${e},${kept.indexOf(s!)}`, v);
  }
  return out;
}
