import { normalizeLevel } from './generic';
import { KEY_ROLES, toEpochMs } from './jsonl';
import { SchemaBuilder, TIMESTAMP_COLUMN } from './schema';
import { OffsetTracker, parseZoneSuffix } from './timezone';
import type { CellValue, ColumnRole, LineParser, LogRow, MalformedRow, ParsedChunk } from './types';

/**
 * logfmt: one entry per line as key=value pairs, values optionally double-quoted.
 *   time=2026-10-27T04:42:03Z level=error msg="upstream timed out" path=/api/x status=500 duration=12ms
 * Used by Go (log/slog's TextHandler, logrus, go-kit), Heroku, Grafana Loki and others.
 */

const TIMESTAMP_KEYS = ['time', 'ts', 't', 'timestamp', '@timestamp', 'date', 'datetime'];
const KEY_RE = /^[A-Za-z_@][\w.\-/@]*$/;

/** Extra roles for logfmt keys (lower-cased), on top of the JSON ones. */
const LOGFMT_ROLES: Record<string, ColumnRole> = {
  duration: 'duration',
  dur: 'duration',
  latency: 'duration',
  took: 'duration',
  'time-taken': 'duration',
};

const roleOf = (key: string): ColumnRole | undefined => {
  const k = key.toLowerCase();
  return KEY_ROLES[k] ?? LOGFMT_ROLES[k];
};

/** Go duration ("12ms", "1.5s", "1m2s", "350µs") → milliseconds, else null. */
const DURATION_RE = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/;
const DURATION_PART_RE = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
const UNIT_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

export function parseGoDuration(s: string): number | null {
  if (!DURATION_RE.test(s)) return null;
  let ms = 0;
  for (const m of s.matchAll(DURATION_PART_RE)) ms += Number(m[1]) * UNIT_MS[m[2]!]!;
  return Math.round(ms * 1000) / 1000;
}

// No leading zeros, so ids like "007" stay text.
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Split a logfmt line into [key, value] pairs (a bare key has value `true`).
 * Returns null when the line doesn't look like logfmt.
 */
export function splitLogfmt(line: string): [string, string | true][] | null {
  const pairs: [string, string | true][] = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i >= n) break;
    const keyStart = i;
    while (i < n && line[i] !== '=' && line[i] !== ' ' && line[i] !== '\t') i++;
    const key = line.slice(keyStart, i);
    if (!KEY_RE.test(key)) return null;
    if (line[i] !== '=') {
      pairs.push([key, true]);
      continue;
    }
    i++; // '='
    if (line[i] === '"') {
      i++;
      let v = '';
      let closed = false;
      while (i < n) {
        const c = line[i]!;
        if (c === '\\' && i + 1 < n) {
          const e = line[i + 1]!;
          v += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else if (c === '"') {
          i++;
          closed = true;
          break;
        } else {
          v += c;
          i++;
        }
      }
      if (!closed) return null;
      pairs.push([key, v]);
    } else {
      const vStart = i;
      while (i < n && line[i] !== ' ' && line[i] !== '\t') i++;
      pairs.push([key, line.slice(vStart, i)]);
    }
  }
  return pairs.length > 0 ? pairs : null;
}

/** Whether a line is logfmt: starts with key=value and is mostly (≥ 75%) key=value pairs, at least 3. */
export function isLogfmtLine(line: string): boolean {
  const t = line.trim();
  if (t.startsWith('{') || t.startsWith('[')) return false;
  const pairs = splitLogfmt(t);
  if (!pairs || pairs[0]![1] === true) return false;
  const withValue = pairs.filter((p) => p[1] !== true).length;
  return withValue >= 3 && withValue / pairs.length >= 0.75;
}

function toValue(key: string, raw: string | true, durationKeys: Set<string>): CellValue {
  if (raw === true) return true;
  if (NUMBER_RE.test(raw)) return Number(raw);
  const d = parseGoDuration(raw);
  if (d !== null) {
    durationKeys.add(key);
    return d;
  }
  return raw;
}

export function createLogfmtParser(): LineParser {
  const schema = new SchemaBuilder();
  const zones = new OffsetTracker();
  const durationKeys = new Set<string>();
  let rows: LogRow[] = [];
  let malformed: MalformedRow[] = [];
  let pending: LogRow | null = null;
  let messageKey: string | null = null;
  let rowId = 0;
  let malformedId = 0;

  function pushLine(line: string, lineNo: number): void {
    if (line.trim().length === 0) return;
    const pairs = splitLogfmt(line.trim());
    if (!pairs || pairs[0]![1] === true || !pairs.some((p) => p[1] !== true && p !== pairs[0])) {
      // Not logfmt (a Go panic's stack trace, a wrapped message): part of the previous entry.
      if (pending) {
        const mk = messageKey ?? 'message';
        if (!messageKey) schema.observe('message', '', 'message');
        messageKey = mk;
        const prev = pending.values[mk];
        pending.values[mk] = prev === null || prev === undefined || prev === '' ? line : `${String(prev)}\n${line}`;
        pending.raw += `\n${line}`;
      } else {
        malformed.push({ id: malformedId++, lineNo, raw: line, reason: 'Not key=value pairs' });
      }
      return;
    }
    if (pending) rows.push(pending);
    const values: Record<string, CellValue> = {};
    let ts: number | null = null;
    const tsPair = pairs.find(([k, v]) => v !== true && TIMESTAMP_KEYS.includes(k.toLowerCase()));
    if (tsPair) {
      const raw = tsPair[1] as string;
      ts = toEpochMs(NUMBER_RE.test(raw) ? Number(raw) : raw);
      if (ts !== null) {
        zones.observe(parseZoneSuffix(raw));
        schema.add(TIMESTAMP_COLUMN);
        values.timestamp = ts;
      }
    }
    for (const [k, raw] of pairs) {
      if (tsPair && k === tsPair[0] && ts !== null) continue;
      const key = k === 'timestamp' ? 'timestamp_raw' : k;
      if (key in values) continue; // repeated key: the first one wins
      let v = toValue(key, raw, durationKeys);
      const role = roleOf(key);
      if (role === 'level' && typeof v === 'string') v = normalizeLevel(v);
      if (role === 'message' && !messageKey) messageKey = key;
      schema.observe(key, v, role);
      values[key] = v;
    }
    pending = { id: rowId++, lineNo, ts, values, raw: line };
  }

  function drain(): ParsedChunk {
    const out = { rows, malformed, meta: [] };
    rows = [];
    malformed = [];
    return out;
  }

  function finish(): ParsedChunk {
    if (pending) {
      rows.push(pending);
      pending = null;
    }
    return drain();
  }

  function columns() {
    return schema.list().map((c) => (durationKeys.has(c.key) && c.type === 'number' ? { ...c, label: `${c.key} (ms)` } : c));
  }

  return { format: 'logfmt', pushLine, drain, finish, schema: columns, timeZone: () => zones.result() };
}
