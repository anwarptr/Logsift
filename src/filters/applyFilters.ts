import type { LogRow } from '../parser';
import { getPatternIndex } from '../utils/messagePatterns';
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
export const BIT_PATTERN = 1 << 29;
/** The time range has its own bit, so the Compare view can set its own ranges and ignore it. */
export const BIT_TIME = 1 << 28;
const FACET_BIT_SHIFT = 3;

export type ComparisonOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | '..';

export interface FieldPredicate {
  key: string;
  negated: boolean;
  op: ComparisonOp;
  value: string;
  numValue?: number;
  numValueEnd?: number;
}

export interface StructuredQuery {
  terms: string[];
  negatedTerms: string[];
  predicates: FieldPredicate[];
}

export interface CompiledSearch {
  /** Case-insensitive matcher for regex mode, or null. */
  test: RegExp | null;
  /** Structured field & text query, or null when regex mode or empty. */
  structured: StructuredQuery | null;
  /** Global variant for highlighting matches in cells. */
  highlight: RegExp | null;
  error: string | null;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split search input into tokens, respecting double-quoted strings with backslash escapes. */
export function parseSearchTokens(text: string): string[] {
  const tokens: string[] = [];
  const re = /(?:[^\s"]|"(?:[^"\\]|\\.)*")+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push(m[0]!);
  }
  return tokens;
}

function unquote(s: string): string {
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

/** Parse a numeric string with optional time units: "500", "500ms", "2.5s", "1m". */
export function parseNumWithUnits(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(s.trim());
  if (!m) return undefined;
  const val = Number(m[1]);
  if (!Number.isFinite(val)) return undefined;
  const unit = (m[2] || '').toLowerCase();
  switch (unit) {
    case 's': return Math.round(val * 1000);
    case 'm': return Math.round(val * 60000);
    case 'h': return Math.round(val * 3600000);
    case 'ms':
    default:
      return val;
  }
}

/**
 * Parse structured search syntax:
 *   status:500 status:>=400 status:5xx status:500..599
 *   duration:>500 duration:<=100 duration:>1s duration:200..800
 *   level:error level:warn
 *   method:POST
 *   ip:192.168.1.1
 *   field:value field:"quoted value"
 *   -term -"quoted term" -status:200 !error !status:200
 *   word "exact phrase"
 */
export function parseStructuredQuery(text: string): StructuredQuery | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const rawTokens = parseSearchTokens(trimmed);
  if (rawTokens.length === 0) return null;

  const terms: string[] = [];
  const negatedTerms: string[] = [];
  const predicates: FieldPredicate[] = [];

  for (const rawToken of rawTokens) {
    const colon = rawToken.indexOf(':');
    // A colon that isn't part of a URL protocol (like "https://") or time ("12:30")
    if (colon > 0 && !rawToken.slice(colon + 1).startsWith('//')) {
      const pre = rawToken.slice(0, colon);
      const negated = pre.startsWith('-') || pre.startsWith('!');
      const key = (negated ? pre.slice(1) : pre).toLowerCase();
      if (/^[a-z_@][\w.-]*$/.test(key)) {
        let valPart = unquote(rawToken.slice(colon + 1));
        // Check for range: e.g. status:500..599 or duration:100ms..2s
        const rangeIdx = valPart.indexOf('..');
        if (rangeIdx > 0) {
          const startStr = valPart.slice(0, rangeIdx);
          const endStr = valPart.slice(rangeIdx + 2);
          const nStart = parseNumWithUnits(startStr);
          const nEnd = parseNumWithUnits(endStr);
          if (nStart !== undefined && nEnd !== undefined) {
            predicates.push({
              key,
              negated,
              op: '..',
              value: valPart,
              numValue: Math.min(nStart, nEnd),
              numValueEnd: Math.max(nStart, nEnd),
            });
            continue;
          }
        }

        let op: ComparisonOp = '=';
        const opMatch = /^(>=|<=|>|<|!=|=)(.*)$/.exec(valPart);
        if (opMatch) {
          op = opMatch[1] as ComparisonOp;
          valPart = unquote(opMatch[2]!);
        }
        const numValue = parseNumWithUnits(valPart);
        predicates.push({ key, negated, op, value: valPart, numValue });
        continue;
      }
    }

    // Negated text term: -word, !word, -"quoted phrase", !"quoted phrase"
    if ((rawToken.startsWith('-') || rawToken.startsWith('!')) && rawToken.length > 1) {
      const val = unquote(rawToken.slice(1)).toLowerCase();
      if (val) negatedTerms.push(val);
      continue;
    }

    // Positive text term: word or "quoted phrase"
    const val = unquote(rawToken).toLowerCase();
    if (val) terms.push(val);
  }

  return { terms, negatedTerms, predicates };
}

function compareNum(actual: number, op: ComparisonOp, target: number): boolean {
  switch (op) {
    case '=': return actual === target;
    case '!=': return actual !== target;
    case '>': return actual > target;
    case '>=': return actual >= target;
    case '<': return actual < target;
    case '<=': return actual <= target;
    default: return false;
  }
}

export function matchesFieldPredicate(row: LogRow, index: LogIndex, r: number, p: FieldPredicate): boolean {
  const k = p.key;

  // 1. Status code (e.g. status:500, status:>=400, status:4xx)
  if (k === 'status' || k === 'sc-status' || k === 'statuscode' || k === 'status_code') {
    const st = index.status ? index.status[r]! : Number(row.values['sc-status'] ?? row.values.status ?? row.values.statusCode ?? row.values.status_code);
    if (!Number.isFinite(st)) return false;
    if (p.value.endsWith('xx') && /^\d/.test(p.value)) {
      return Math.floor(st / 100) === Number(p.value[0]);
    }
    if (p.op === '..' && p.numValue !== undefined && p.numValueEnd !== undefined) {
      return st >= p.numValue && st <= p.numValueEnd;
    }
    if (p.numValue !== undefined) {
      return compareNum(st, p.op, p.numValue);
    }
    return String(st) === p.value;
  }

  // 2. Duration (e.g. duration:>500, duration:>=1000)
  if (k === 'duration' || k === 'time-taken' || k === 'durationms' || k === 'duration_ms' || k === 'latency') {
    const dur = index.duration ? index.duration[r]! : Number(row.values['time-taken'] ?? row.values.duration ?? row.values.durationMs ?? row.values.duration_ms);
    if (!Number.isFinite(dur)) return false;
    if (p.op === '..' && p.numValue !== undefined && p.numValueEnd !== undefined) {
      return dur >= p.numValue && dur <= p.numValueEnd;
    }
    if (p.numValue !== undefined) {
      return compareNum(dur, p.op, p.numValue);
    }
    return String(dur) === p.value;
  }

  // 3. Level (e.g. level:error, level:warn, level:info)
  if (k === 'level' || k === 'severity' || k === 'lvl' || k === 'loglevel') {
    const want = p.value.toLowerCase();
    if (want === 'error' || want === 'err' || want === 'fatal' || want === 'crit') {
      return isErrorRow(index, r);
    }
    const lv = row.values.level ?? row.values.severity ?? row.values.lvl ?? row.values.loglevel;
    if (typeof lv === 'string') {
      return lv.toLowerCase().startsWith(want);
    }
    return false;
  }

  // 4. HTTP Method (e.g. method:POST)
  if (k === 'method' || k === 'cs-method' || k === 'requestmethod') {
    const m = row.values['cs-method'] ?? row.values.method ?? row.values.requestMethod ?? row.values['req.method'];
    return typeof m === 'string' && m.toLowerCase() === p.value.toLowerCase();
  }

  // 5. Client IP (e.g. ip:192.168.1.1, c-ip:10.0.*)
  if (k === 'ip' || k === 'c-ip' || k === 'clientip' || k === 'client_ip') {
    const ip = row.values['c-ip'] ?? row.values.clientIp ?? row.values.ip ?? row.values.client_ip ?? row.values['client.ip'] ?? row.values['httpRequest.remoteIp'];
    if (typeof ip !== 'string') return false;
    const sIp = ip.toLowerCase();
    const sWant = p.value.toLowerCase();
    if (sWant.includes('*')) {
      const prefix = sWant.split('*')[0]!;
      return sIp.startsWith(prefix);
    }
    return sIp.includes(sWant);
  }

  // 6. Arbitrary column lookup
  let val = row.values[p.key];
  if (val === undefined) {
    const lk = p.key.toLowerCase();
    for (const vk in row.values) {
      if (vk.toLowerCase() === lk) {
        val = row.values[vk];
        break;
      }
    }
  }
  if (val === null || val === undefined) return false;
  if (p.op === '..' && p.numValue !== undefined && p.numValueEnd !== undefined) {
    const n = typeof val === 'number' ? val : Number(val);
    return Number.isFinite(n) && n >= p.numValue && n <= p.numValueEnd;
  }
  if (typeof val === 'number' && p.numValue !== undefined && p.op !== '=') {
    return compareNum(val, p.op, p.numValue);
  }
  const sVal = String(val).toLowerCase();
  const sWant = p.value.toLowerCase();
  if (p.op === '!=') return !sVal.includes(sWant);
  return sVal.includes(sWant);
}

/**
 * Whether a regular expression has the shape that can take exponential time on a non-matching line
 * ("catastrophic backtracking"): a repeated group that itself contains a repetition or an alternation,
 * like (a+)+, (\w*\s?)* or (a|ab)*. A conservative check, not a proof: used to refuse such patterns from
 * a shared link, where whoever made the link chose them (the search runs over every row on the page's
 * main thread, so one of these would freeze the tab).
 */
export function isRiskyRegex(source: string): boolean {
  const groups: { quant: boolean; alt: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    const top = groups.at(-1);
    if (c === '[') inClass = true;
    else if (c === '(') groups.push({ quant: false, alt: false });
    else if (c === '|' && top) top.alt = true;
    else if ((c === '*' || c === '+' || c === '{') && top) top.quant = true;
    else if (c === ')') {
      const g = groups.pop();
      if (!g) continue;
      // Repeated without bound: *, + or {n,} ({3} or {1,3} can't blow up).
      const repeated = /^(?:[*+]|\{\d*,\})/.test(source.slice(i + 1, i + 12));
      if (repeated && (g.quant || g.alt)) return true;
      const parent = groups.at(-1);
      if (parent && (g.quant || repeated)) parent.quant = true;
    }
  }
  return false;
}

export function compileSearch(text: string, regex: boolean): CompiledSearch {
  if (!text) return { test: null, structured: null, highlight: null, error: null };
  if (regex) {
    try {
      return {
        test: new RegExp(text, 'i'),
        structured: null,
        highlight: new RegExp(text, 'gi'),
        error: null,
      };
    } catch (e) {
      return {
        test: null,
        structured: null,
        highlight: null,
        error: e instanceof Error ? e.message : 'Invalid regular expression',
      };
    }
  }

  const structured = parseStructuredQuery(text);
  if (!structured) return { test: null, structured: null, highlight: null, error: null };

  const hlTerms: string[] = [
    ...structured.terms,
    ...structured.predicates
      .filter((p) => !p.negated && p.op === '=' && p.value.length > 0)
      .map((p) => p.value),
  ]
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);

  let highlight: RegExp | null = null;
  if (hlTerms.length > 0) {
    try {
      highlight = new RegExp(hlTerms.map(escapeRegExp).join('|'), 'gi');
    } catch {
      highlight = null;
    }
  }

  return {
    test: null,
    structured,
    highlight,
    error: null,
  };
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

  // Global search over the raw line & field query syntax.
  const search = compileSearch(f.search, f.regex);
  if (search.test) {
    const re = search.test;
    for (let i = 0; i < n; i++) if (!re.test(rows[i]!.raw)) mask[i]! |= BIT_OTHER;
  } else if (search.structured) {
    const { terms, negatedTerms, predicates } = search.structured;
    const hasTerms = terms.length > 0;
    const hasNeg = negatedTerms.length > 0;
    const hasPreds = predicates.length > 0;

    if (hasTerms || hasNeg || hasPreds) {
      for (let i = 0; i < n; i++) {
        if (hasPreds) {
          let fail = false;
          for (const p of predicates) {
            const matches = matchesFieldPredicate(rows[i]!, index, i, p);
            if (p.negated ? matches : !matches) {
              fail = true;
              break;
            }
          }
          if (fail) {
            mask[i]! |= BIT_OTHER;
            continue;
          }
        }

        if (hasTerms || hasNeg) {
          const raw = rows[i]!.raw.toLowerCase();
          if (hasNeg) {
            let fail = false;
            for (const nt of negatedTerms) {
              if (raw.includes(nt)) {
                fail = true;
                break;
              }
            }
            if (fail) {
              mask[i]! |= BIT_OTHER;
              continue;
            }
          }
          if (hasTerms) {
            let fail = false;
            for (const pt of terms) {
              if (!raw.includes(pt)) {
                fail = true;
                break;
              }
            }
            if (fail) {
              mask[i]! |= BIT_OTHER;
              continue;
            }
          }
        }
      }
    }
  }

  // Time range.
  if (f.timeFrom !== null || f.timeTo !== null) {
    const from = f.timeFrom ?? -Infinity;
    const to = f.timeTo ?? Infinity;
    const ts = index.ts;
    for (let i = 0; i < n; i++) {
      const t = ts[i]!;
      // NaN (no timestamp) fails both comparisons and is excluded.
      if (!(t >= from && t <= to)) mask[i]! |= BIT_TIME;
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

  // Message pattern, also with its own bit (for the Patterns view). The pattern index is built here on first use.
  if (f.pattern && index.messageKey) {
    const pidx = getPatternIndex(rows, index.messageKey);
    const code = pidx.values.indexOf(f.pattern);
    const codes = pidx.codes;
    for (let i = 0; i < n; i++) if (codes[i] !== code) mask[i]! |= BIT_PATTERN;
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
