import { parseApacheTimestamp } from './apache';
import { calendarDay, normalizeLevel, parseLooseIso } from './generic';
import { KEY_ROLES } from './jsonl';
import { SchemaBuilder, TIMESTAMP_COLUMN } from './schema';
import { OffsetTracker, parseZoneSuffix, type LogTimeZone } from './timezone';
import type { CellValue, ColumnRole, LineParser, LogRow, MalformedRow, ParsedChunk } from './types';

/**
 * A log layout described by the user, for formats Logsift doesn't know:
 *   {time} [{thread}] {level} {logger} - {message}
 * Each {name} is a field; the text between fields must match as written, and any run of spaces matches
 * one or more spaces (so padded levels like "INFO " work). {_} skips a part. Well-known names get
 * meaning: time/timestamp/ts/datetime (or date + time) is the timestamp, level, message, and the
 * usual column names (status, path, method, ip, duration, logger, …) get their roles.
 * A pattern starting with "^" is a regular expression whose named groups are the fields.
 * Lines that don't match continue the previous entry (stack traces).
 */

export interface CompiledPattern {
  re: RegExp;
  /** Field names in capture-group order ('' for skipped parts). */
  fields: string[];
}

export type CompileResult = { ok: true; pattern: CompiledPattern } | { ok: false; error: string };

const TIME_FIELDS = new Set(['time', 'timestamp', 'ts', 'datetime', 'date']);
const LEVEL_FIELDS = new Set(['level', 'severity', 'lvl', 'loglevel', 'levelname']);
const MESSAGE_FIELDS = new Set(['message', 'msg']);
const FIELD_RE = /\{([^{}]*)\}/g;
const NAME_RE = /^[A-Za-z_][\w.\-]*$/;
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const TIME_OF_DAY_RE = /^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?$/;
/**
 * Capture group for a timestamp field: epoch seconds/ms, text (up to 40 characters) ending in a clock
 * time with an optional AM/PM and zone, or a date alone.
 */
const TIME_GROUP =
  '(\\d{10}(?:\\.\\d+)?|\\d{13}|.{0,40}?\\d{1,2}:\\d{2}(?::\\d{2})?(?:[.,]\\d{1,9})?(?:\\s?[AaPp][Mm])?(?:\\s?(?:Z|[+-]\\d{2}:?\\d{2}|UTC|GMT))?|\\d{4}[-/]\\d{2}[-/]\\d{2})';
/** "27/10/2026 04:42:03" or "10/27/2026 4:42:03 PM": day first when the first number is > 12. */
const NUMERIC_DATE_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,9}))?(?:\s*([AP]M))?$/i;

function parseNumericDate(s: string): number | null {
  const m = NUMERIC_DATE_RE.exec(s);
  if (!m) return null;
  let [a, b] = [+m[1]!, +m[2]!];
  if (a > 12) [a, b] = [b, a]; // day first
  let h = +m[4]!;
  if (m[8]) h = (h % 12) + (m[8].toUpperCase() === 'PM' ? 12 : 0);
  const ms = m[7] ? Math.floor(+`0.${m[7]}` * 1000) : 0;
  const t = Date.UTC(+m[3]!, a - 1, b, h, +m[5]!, m[6] ? +m[6] : 0, ms);
  return Number.isNaN(t) ? null : t;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Literal text of a pattern: escaped, with each run of whitespace matching one or more spaces. */
const literal = (s: string) =>
  s
    .split(/(\s+)/)
    .map((part) => (/^\s+$/.test(part) ? '\\s+' : escapeRe(part)))
    .join('');

export function compilePattern(source: string): CompileResult {
  const text = source.trim();
  if (text === '') return { ok: false, error: 'Enter a pattern, such as {time} {level} {message}.' };
  if (text.startsWith('^')) {
    let re: RegExp;
    try {
      re = new RegExp(text);
    } catch (e) {
      return { ok: false, error: `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}` };
    }
    const names = [...text.matchAll(/\(\?<([A-Za-z_]\w*)>/g)].map((m) => m[1]!);
    if (names.length === 0) return { ok: false, error: 'Name the parts to keep with named groups, e.g. (?<level>\\w+).' };
    // Read named groups by name rather than position (unnamed groups may sit in between).
    return { ok: true, pattern: { re, fields: names.map((n) => `<${n}>`) } };
  }
  const fields: string[] = [];
  let re = '^\\s*';
  let last = 0;
  const matches = [...text.matchAll(FIELD_RE)];
  if (/[{}]/.test(text.replace(FIELD_RE, ''))) return { ok: false, error: 'A "{" or "}" is not paired: write each field as {name}.' };
  if (matches.length === 0) return { ok: false, error: 'Add at least one field in braces, such as {message}.' };
  const lowerNames = matches.map((m) => m[1]!.trim().toLowerCase());
  const hasTime = lowerNames.includes('time');
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const name = m[1]!.trim();
    if (name !== '_' && !NAME_RE.test(name)) return { ok: false, error: `"{${m[1]}}" is not a valid field name.` };
    if (name !== '_' && fields.includes(name)) return { ok: false, error: `The field {${name}} appears twice.` };
    re += literal(text.slice(last, m.index));
    const isLast = i === matches.length - 1 && m.index! + m[0].length === text.length;
    const lower = lowerNames[i]!;
    // A timestamp may contain spaces ("Oct 27 2026 04:42:03"): match up to a clock time and zone.
    const isTimestamp = TIME_FIELDS.has(lower) && !(lower === 'date' && hasTime);
    re += isTimestamp ? TIME_GROUP : isLast ? '(.*)' : '(.*?)';
    fields.push(name === '_' ? '' : name);
    last = m.index! + m[0].length;
  }
  re += literal(text.slice(last)) + '\\s*$';
  if (!fields.some((f) => f !== '')) return { ok: false, error: 'Name at least one field; {_} only skips text.' };
  return { ok: true, pattern: { re: new RegExp(re), fields } };
}

/** The value of each field for a matching line, else null. */
export function matchPattern(p: CompiledPattern, line: string): Record<string, string> | null {
  const m = p.re.exec(line);
  if (!m) return null;
  const out: Record<string, string> = {};
  p.fields.forEach((f, i) => {
    if (f === '') return;
    if (f.startsWith('<')) {
      const name = f.slice(1, -1);
      const v = m.groups?.[name];
      if (v !== undefined) out[name] = v;
    } else {
      out[f] = m[i + 1] ?? '';
    }
  });
  return out;
}

const fieldName = (f: string) => (f.startsWith('<') ? f.slice(1, -1) : f);

/** Parse a timestamp in any of the layouts Logsift knows; zone-less values are UTC. */
function parseAnyTime(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  if (/^\d{10}(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  if (/^\d{13}$/.test(t)) return Number(t);
  const iso = parseLooseIso(t);
  if (iso !== null && /^\d{4}[-/]\d{2}[-/]\d{2}/.test(t)) return iso;
  const numeric = parseNumericDate(t);
  if (numeric !== null) return numeric;
  const apache = /^\d{2}\/[A-Za-z]{3}\/\d{4}:/.test(t) ? parseApacheTimestamp(t) : null;
  if (apache !== null) return apache;
  const withUtc = parseZoneSuffix(t) === null && !/\b(UTC|GMT|Z)\b/.test(t) ? Date.parse(`${t} UTC`) : NaN;
  if (!Number.isNaN(withUtc)) return withUtc;
  const loose = Date.parse(t);
  return Number.isNaN(loose) ? null : loose;
}

function roleOf(name: string): ColumnRole | undefined {
  const k = name.toLowerCase();
  if (LEVEL_FIELDS.has(k)) return 'level';
  if (MESSAGE_FIELDS.has(k)) return 'message';
  return KEY_ROLES[k] ?? (k === 'duration' || k === 'latency' || k === 'took' ? 'duration' : undefined);
}

export function createCustomParser(source: string): LineParser {
  const compiled = compilePattern(source);
  const pattern = compiled.ok ? compiled.pattern : null;
  const names = pattern ? pattern.fields.filter((f) => f !== '').map(fieldName) : [];
  const lower = names.map((n) => n.toLowerCase());
  // A lone "date" or "time" field is the timestamp; "date" + "time" are joined.
  const timeKeys = names.filter((_, i) => TIME_FIELDS.has(lower[i]!));
  const messageKey = names.find((_, i) => MESSAGE_FIELDS.has(lower[i]!)) ?? names[names.length - 1] ?? 'message';
  const schema = new SchemaBuilder();
  const zones = new OffsetTracker();
  let rows: LogRow[] = [];
  let malformed: MalformedRow[] = [];
  let pending: LogRow | null = null;
  let rowId = 0;
  let malformedId = 0;
  let day = calendarDay(Date.now());
  let lastTimeOfDay = -1;
  const assumedDays = new Set<number>();
  if (timeKeys.length) schema.add(TIMESTAMP_COLUMN);

  function timestampOf(fields: Record<string, string>): number | null {
    const text = timeKeys.map((k) => fields[k] ?? '').join(' ').trim();
    const tod = TIME_OF_DAY_RE.exec(text);
    if (tod) {
      const ms = tod[4] ? Math.floor(+`0.${tod[4]}` * 1000) : 0;
      const timeOfDay = ((+tod[1]! * 60 + +tod[2]!) * 60 + +tod[3]!) * 1000 + ms;
      if (lastTimeOfDay >= 0 && timeOfDay < lastTimeOfDay - 3_600_000) day += 86_400_000;
      lastTimeOfDay = timeOfDay;
      assumedDays.add(day);
      return day + timeOfDay;
    }
    const ts = parseAnyTime(text);
    if (ts !== null) zones.observe(parseZoneSuffix(text));
    return ts;
  }

  function pushLine(line: string, lineNo: number): void {
    if (line.trim().length === 0) return;
    const fields = pattern ? matchPattern(pattern, line) : null;
    if (!fields) {
      if (pending) {
        const prev = pending.values[messageKey];
        pending.values[messageKey] = prev === null || prev === undefined || prev === '' ? line : `${String(prev)}\n${line}`;
        pending.raw += `\n${line}`;
      } else {
        malformed.push({ id: malformedId++, lineNo, raw: line, reason: 'Does not match the custom pattern' });
      }
      return;
    }
    if (pending) rows.push(pending);
    const values: Record<string, CellValue> = {};
    let ts: number | null = null;
    if (timeKeys.length) {
      ts = timestampOf(fields);
      values.timestamp = ts;
    }
    names.forEach((name, i) => {
      if (timeKeys.includes(name) && ts !== null) return;
      const raw = (fields[name] ?? '').trim();
      const role = roleOf(name);
      let v: CellValue = raw === '' || raw === '-' ? null : raw;
      if (typeof v === 'string' && role !== 'message' && NUMBER_RE.test(v)) v = Number(v);
      if (role === 'level' && typeof v === 'string') v = normalizeLevel(v);
      const key = lower[i] === 'timestamp' ? 'timestamp_raw' : name;
      schema.observe(key, v, role);
      values[key] = v;
    });
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

  function timeZone(): LogTimeZone {
    const tz = zones.result();
    if (assumedDays.size === 0) return tz;
    const days = [...assumedDays].sort((a, b) => a - b);
    const iso = (d: number) => new Date(d).toISOString().slice(0, 10);
    return { ...tz, assumedDate: days.length === 1 ? iso(days[0]!) : `${iso(days[0]!)} – ${iso(days[days.length - 1]!)}` };
  }

  function setDefaultDate(ms: number): void {
    day = calendarDay(ms);
    lastTimeOfDay = -1;
  }

  return { format: 'custom', pushLine, drain, finish, schema: () => schema.list(), timeZone, setDefaultDate };
}
