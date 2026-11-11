import { isErrorRow, type LogIndex } from '../filters/logIndex';
import { NULL_KEY } from '../filters/types';
import type { PatternIndex } from './messagePatterns';
import { percentile } from './stats';

/**
 * "What changed?": the rows of two time ranges side by side — overall rates, endpoints that got
 * worse, message patterns that are new or growing, and values (status codes, IPs, …) that only
 * appear in the later range. Counts are compared per minute, since the ranges can differ in length.
 */

export type ComparePreset = 'halves' | 'last15m' | 'last1h' | 'last1d' | 'split';

export interface CompareSetting {
  preset: ComparePreset;
  /** For 'split': where "after" starts (epoch ms). */
  splitAt: number | null;
}

export const DEFAULT_COMPARE: CompareSetting = { preset: 'halves', splitAt: null };

/** Half-open time range [from, to). */
export interface TimeRange {
  from: number;
  to: number;
}

const MIN = 60_000;
const PRESET_MS: Partial<Record<ComparePreset, number>> = { last15m: 15 * MIN, last1h: 60 * MIN, last1d: 24 * 60 * MIN };

/**
 * The "before" (a) and "after" (b) ranges for a setting, over logs from `minTs` to `maxTs`.
 * "Last …" presets end at the newest row, so with live tail they follow the log. Null when the
 * log has no time span to split.
 */
export function compareRanges(setting: CompareSetting, minTs: number | null, maxTs: number | null): { a: TimeRange; b: TimeRange } | null {
  if (minTs === null || maxTs === null || !(maxTs > minTs)) return null;
  const end = maxTs + 1;
  const len = PRESET_MS[setting.preset];
  if (len !== undefined) return { a: { from: end - 2 * len, to: end - len }, b: { from: end - len, to: end } };
  let split = setting.preset === 'split' && setting.splitAt !== null ? setting.splitAt : Math.round((minTs + maxTs) / 2);
  split = Math.min(Math.max(split, minTs + 1), maxTs);
  return { a: { from: minTs, to: split }, b: { from: split, to: end } };
}

export interface SideStats {
  rows: number;
  errors: number;
  /** p95 duration (ms), NaN without durations. */
  p95: number;
  /** Length of the range that the log covers, in minutes (rates are per this). */
  minutes: number;
}

export interface SideCounts {
  count: number;
  errors: number;
  p95: number;
}

export interface EndpointChange {
  pattern: string;
  a: SideCounts;
  b: SideCounts;
}

export interface PatternChange {
  pattern: string;
  a: number;
  b: number;
  errorsB: number;
  /** A row of the pattern in the later range (an example to look at). */
  sampleId: number;
}

export interface NewValue {
  key: string;
  label: string;
  value: string;
  count: number;
}

export interface Comparison {
  a: SideStats;
  b: SideStats;
  endpoints: EndpointChange[];
  patterns: PatternChange[];
  /** Per column, values seen only in the later range, most frequent first. */
  newValues: { key: string; label: string; values: NewValue[]; more: number }[];
}

/** Columns whose new values are not news (every row has its own). */
const SKIP_NEW_VALUES = new Set(['sourceFile', 'logFormat']);
const NEW_VALUES_SHOWN = 5;

/** Minutes of `r` that the log (minTs…maxTs) covers; at least one second. */
function coveredMinutes(r: TimeRange, minTs: number, maxTs: number): number {
  const ms = Math.min(r.to, maxTs + 1) - Math.max(r.from, minTs);
  return Math.max(ms, 1000) / MIN;
}

const sortedP95 = (values: number[]) => (values.length ? percentile(values.sort((x, y) => x - y), 95) : Number.NaN);

/**
 * Compare the `candidates` rows (already filtered) that fall in `a` and in `b`. `pidx` gives message
 * patterns (null without a message column).
 */
export function compareRows(
  index: LogIndex,
  candidates: ArrayLike<number>,
  ranges: { a: TimeRange; b: TimeRange },
  pidx: PatternIndex | null,
): Comparison {
  const { a, b } = ranges;
  const ts = index.ts;
  const dur = index.duration;
  const sideOf = (t: number) => (t >= b.from && t < b.to ? 1 : t >= a.from && t < a.to ? 0 : -1);

  const rowsN = [0, 0];
  const errorsN = [0, 0];
  const durs: [number[], number[]] = [[], []];

  const pat = index.uriPattern;
  const epCount = pat ? [new Uint32Array(pat.values.length), new Uint32Array(pat.values.length)] : null;
  const epErr = pat ? [new Uint32Array(pat.values.length), new Uint32Array(pat.values.length)] : null;
  const epDur: Map<number, number[]>[] = [new Map(), new Map()];

  const pCount = pidx ? [new Uint32Array(pidx.values.length), new Uint32Array(pidx.values.length)] : null;
  const pErrB = pidx ? new Uint32Array(pidx.values.length) : null;
  const pSampleB = pidx ? new Int32Array(pidx.values.length).fill(-1) : null;

  const facets = index.facets.filter((f) => !SKIP_NEW_VALUES.has(f.key));
  const fCount = facets.map((f) => [new Uint32Array(f.values.length), new Uint32Array(f.values.length)] as const);

  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i]!;
    const sideN = sideOf(ts[r]!);
    if (sideN < 0) continue;
    const side = sideN as 0 | 1;
    rowsN[side]!++;
    const err = isErrorRow(index, r);
    if (err) errorsN[side]!++;
    const d = dur ? dur[r]! : Number.NaN;
    if (Number.isFinite(d)) durs[side].push(d);
    if (pat && epCount && epErr) {
      const c = pat.codes[r]!;
      epCount[side]![c]!++;
      if (err) epErr[side]![c]!++;
      if (Number.isFinite(d)) {
        const m = epDur[side]!;
        let list = m.get(c);
        if (!list) m.set(c, (list = []));
        list.push(d);
      }
    }
    if (pidx && pCount && pErrB && pSampleB) {
      const c = pidx.codes[r]!;
      pCount[side]![c]!++;
      if (side === 1) {
        if (err) pErrB[c]!++;
        if (pSampleB[c] === -1) pSampleB[c] = r;
      }
    }
    for (let f = 0; f < facets.length; f++) fCount[f]![side][facets[f]!.codes[r]!]!++;
  }

  const minTs = index.minTs ?? a.from;
  const maxTs = index.maxTs ?? b.to;
  const side = (s: 0 | 1): SideStats => ({
    rows: rowsN[s]!,
    errors: errorsN[s]!,
    p95: sortedP95(durs[s]),
    minutes: coveredMinutes(s === 0 ? a : b, minTs, maxTs),
  });

  const endpoints: EndpointChange[] = [];
  if (pat && epCount && epErr) {
    for (let c = 0; c < pat.values.length; c++) {
      const ca = epCount[0]![c]!;
      const cb = epCount[1]![c]!;
      // Rows without a URL (application lines among requests) are not an endpoint.
      if ((ca === 0 && cb === 0) || pat.values[c] === NULL_KEY) continue;
      endpoints.push({
        pattern: pat.values[c]!,
        a: { count: ca, errors: epErr[0]![c]!, p95: sortedP95(epDur[0]!.get(c) ?? []) },
        b: { count: cb, errors: epErr[1]![c]!, p95: sortedP95(epDur[1]!.get(c) ?? []) },
      });
    }
  }

  const patterns: PatternChange[] = [];
  if (pidx && pCount && pErrB && pSampleB) {
    for (let c = 0; c < pidx.values.length; c++) {
      const pa = pCount[0]![c]!;
      const pb = pCount[1]![c]!;
      if (pb === 0) continue;
      patterns.push({ pattern: pidx.values[c]!, a: pa, b: pb, errorsB: pErrB[c]!, sampleId: pSampleB[c]! });
    }
  }

  const newValues: Comparison['newValues'] = [];
  facets.forEach((f, fi) => {
    const [ca, cb] = fCount[fi]!;
    const found: NewValue[] = [];
    for (let c = 0; c < f.values.length; c++) {
      // An empty value is not news (rows of another kind without that column).
      if (ca[c] === 0 && cb[c]! > 0 && f.values[c] !== NULL_KEY) found.push({ key: f.key, label: f.label, value: f.values[c]!, count: cb[c]! });
    }
    // A column where (nearly) every value is new tells nothing (ids, timestamps as text).
    const inB = cb.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
    if (found.length === 0 || (inB >= 10 && found.length / inB > 0.8)) return;
    found.sort((x, y) => y.count - x.count);
    newValues.push({ key: f.key, label: f.label, values: found.slice(0, NEW_VALUES_SHOWN), more: Math.max(0, found.length - NEW_VALUES_SHOWN) });
  });

  return { a: side(0), b: side(1), endpoints, patterns, newValues };
}

/** Per-minute rate of `count` on a side. */
export const perMinute = (count: number, s: SideStats) => count / s.minutes;

export type EndpointSort = 'errors' | 'slower' | 'traffic';

/** Endpoints that got worse, most changed first, by errors per minute, p95 or requests per minute. */
export function worseEndpoints(c: Comparison, sort: EndpointSort, limit = 30): EndpointChange[] {
  const score = (e: EndpointChange): number => {
    switch (sort) {
      case 'errors':
        return perMinute(e.b.errors, c.b) - perMinute(e.a.errors, c.a);
      case 'traffic':
        return perMinute(e.b.count, c.b) - perMinute(e.a.count, c.a);
      case 'slower':
        // Only endpoints with requests on both sides have a change in duration.
        return e.a.count >= 3 && e.b.count >= 3 && Number.isFinite(e.a.p95) && Number.isFinite(e.b.p95) ? e.b.p95 - e.a.p95 : -Infinity;
    }
  };
  return c.endpoints
    .map((e) => [e, score(e)] as const)
    .filter(([, s]) => s > 0)
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([e]) => e);
}

/**
 * Message patterns that are new in the later range, then those at least twice as frequent
 * (per minute, with at least 3 rows), most changed first.
 */
export function changedPatterns(c: Comparison, limit = 30): (PatternChange & { isNew: boolean })[] {
  const fresh = c.patterns.filter((p) => p.a === 0).sort((x, y) => y.errorsB - x.errorsB || y.b - x.b);
  const grown = c.patterns
    .filter((p) => p.a > 0 && p.b >= 3 && perMinute(p.b, c.b) >= 2 * perMinute(p.a, c.a))
    .sort((x, y) => perMinute(y.b, c.b) - perMinute(y.a, c.a) - (perMinute(x.b, c.b) - perMinute(x.a, c.a)));
  return [...fresh.map((p) => ({ ...p, isNew: true })), ...grown.map((p) => ({ ...p, isNew: false }))].slice(0, limit);
}
