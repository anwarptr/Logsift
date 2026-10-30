import { isErrorRow, type LogIndex } from '../filters/logIndex';
import { NULL_KEY } from '../filters/types';
import type { LogRow } from '../parser';

/** Longest message prefix that is grouped; the rest of a long message does not affect its pattern. */
const MAX_CHARS = 300;

// Applied in order: earlier, more specific shapes win over the generic number rule.
const REPLACEMENTS: [RegExp, string][] = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '{guid}'],
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, '{time}'],
  [/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '{time}'],
  [/"[^"\n]{0,200}"/g, '"{…}"'],
  [/'[^'\n]{0,200}'/g, "'{…}'"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '{ip}'],
  [/\b0x[0-9a-f]+\b/gi, '{hex}'],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '{hex}'],
  [/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g, '{n}'],
];

/**
 * Group key for a log message: its first line with variable parts replaced (GUIDs, dates/times,
 * quoted strings, IPs, hex ids, numbers), so "Order 123 took 45 ms" and "Order 9 took 3 ms"
 * become "Order {n} took {n} ms".
 */
export function messagePattern(message: string): string {
  const nl = message.search(/\r?\n/);
  let s = (nl < 0 ? message : message.slice(0, nl)).slice(0, MAX_CHARS);
  for (const [re, to] of REPLACEMENTS) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim() || NULL_KEY;
}

export interface PatternIndex {
  /** Pattern per row, dictionary-coded. */
  codes: Uint32Array;
  values: string[];
}

const cache = new WeakMap<readonly LogRow[], Map<string, PatternIndex>>();

/**
 * Pattern of every row's message (column `key`), built on first use and cached for this rows
 * array, so logs whose patterns are never looked at pay nothing.
 */
export function getPatternIndex(rows: readonly LogRow[], key: string): PatternIndex {
  let byKey = cache.get(rows);
  if (!byKey) cache.set(rows, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit) return hit;

  const n = rows.length;
  const codes = new Uint32Array(n);
  const values: string[] = [];
  const byPattern = new Map<string, number>();
  // Messages repeat a lot, so each distinct one is normalised once.
  const byMessage = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const v = rows[i]!.values[key];
    const msg = v === null || v === undefined ? '' : String(v);
    let code = byMessage.get(msg);
    if (code === undefined) {
      const p = msg === '' ? NULL_KEY : messagePattern(msg);
      code = byPattern.get(p);
      if (code === undefined) {
        code = values.length;
        values.push(p);
        byPattern.set(p, code);
      }
      byMessage.set(msg, code);
    }
    codes[i] = code;
  }
  const idx = { codes, values };
  byKey.set(key, idx);
  return idx;
}

export interface PatternStat {
  pattern: string;
  count: number;
  errors: number;
  /** Most common level among the pattern's rows, if the log has levels. */
  level: string | null;
  firstTs: number | null;
  lastTs: number | null;
  /** First row with this pattern (an example to look at). */
  sampleId: number;
}

/**
 * Per-pattern counts over the rows whose filter `mask` is 0 once `ignoreBits` are cleared
 * (so the pattern filter itself can be ignored), most frequent first.
 */
export function computePatterns(
  rows: readonly LogRow[],
  index: LogIndex,
  pidx: PatternIndex,
  mask: Uint32Array,
  ignoreBits: number,
  levelKey: string | undefined,
): PatternStat[] {
  const keep = ~ignoreBits;
  const g = pidx.values.length;
  const counts = new Uint32Array(g);
  const errors = new Uint32Array(g);
  const first = new Float64Array(g).fill(Infinity);
  const last = new Float64Array(g).fill(-Infinity);
  const sample = new Int32Array(g).fill(-1);
  const levels: (Map<string, number> | undefined)[] = new Array(g);
  for (let r = 0; r < mask.length; r++) {
    if ((mask[r]! & keep) !== 0) continue;
    const c = pidx.codes[r]!;
    counts[c]!++;
    if (sample[c] === -1) sample[c] = r;
    if (isErrorRow(index, r)) errors[c]!++;
    const t = index.ts[r]!;
    if (t < first[c]!) first[c] = t;
    if (t > last[c]!) last[c] = t;
    if (levelKey) {
      const lv = rows[r]!.values[levelKey];
      if (typeof lv === 'string') {
        const m = (levels[c] ??= new Map());
        m.set(lv, (m.get(lv) ?? 0) + 1);
      }
    }
  }
  const out: PatternStat[] = [];
  for (let c = 0; c < g; c++) {
    if (counts[c] === 0) continue;
    const m = levels[c];
    let level: string | null = null;
    if (m) {
      let best = 0;
      for (const [k, v] of m) if (v > best) [level, best] = [k, v];
    }
    out.push({
      pattern: pidx.values[c]!,
      count: counts[c]!,
      errors: errors[c]!,
      level,
      firstTs: Number.isFinite(first[c]!) ? first[c]! : null,
      lastTs: Number.isFinite(last[c]!) ? last[c]! : null,
      sampleId: sample[c]!,
    });
  }
  return out.sort((a, b) => b.count - a.count || (a.pattern < b.pattern ? -1 : 1));
}
