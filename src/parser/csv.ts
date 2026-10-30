import { KEY_ROLES, toEpochMs } from './jsonl';
import { SchemaBuilder, TIMESTAMP_COLUMN } from './schema';
import { OffsetTracker, parseZoneSuffix } from './timezone';
import type { CellValue, ColumnRole, LineParser, LogRow, MalformedRow, ParsedChunk } from './types';

/*
 * CSV / TSV with a header row: exports from Azure Log Analytics, Application Insights, SQL, Excel.
 * RFC 4180 quoting, including quoted fields that span lines. The delimiter (comma, tab or semicolon)
 * is the one that splits the header into the most fields.
 */

const DELIMITERS = [',', '\t', ';'];

/** Header names that hold the entry's time (lower-cased; "[UTC]" style suffixes are ignored). */
const TIME_HEADERS = new Set([
  'timestamp', '@timestamp', 'time', 'ts', 'date', 'datetime', 'timegenerated', 'eventtime', 'logged', 'created', 'createdat',
  'date (utc)', 'time (utc)',
]);

/** Roles for header names found in log exports, on top of the JSON ones. */
const CSV_ROLES: Record<string, ColumnRole> = {
  resultcode: 'status',
  'sc-status': 'status',
  httpstatus: 'status',
  severitylevel: 'level',
  duration: 'duration',
  timetaken: 'duration',
  'cs-uri-stem': 'uri',
  'cs-method': 'method',
  httpmethod: 'method',
  client_ip: 'clientIp',
  'c-ip': 'clientIp',
  useragent: 'userAgent',
  'cs(user-agent)': 'userAgent',
};

/** Application Insights' numeric severityLevel. */
const SEVERITY_LEVELS = ['Verbose', 'Information', 'Warning', 'Error', 'Critical'];

const baseName = (h: string) => h.toLowerCase().replace(/\s*[[(]utc[\])]\s*$/, '').trim();

function roleOf(header: string): ColumnRole | undefined {
  const k = baseName(header);
  return CSV_ROLES[k] ?? KEY_ROLES[k];
}

/** Count of fields the delimiter splits a line into, quotes respected. */
function fieldCount(line: string, delim: string): number {
  let n = 1;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === delim && !quoted) n++;
  }
  return n;
}

export function pickDelimiter(header: string): string | null {
  let best: string | null = null;
  let bestCount = 1;
  for (const d of DELIMITERS) {
    const n = fieldCount(header, d);
    if (n > bestCount) [best, bestCount] = [d, n];
  }
  return best;
}

/** A header cell looks like a column name: short, starts with a letter (or @, _, [, "), not a date. */
const NAME_RE = /^"?[A-Za-z@_[][^\n]{0,59}$/;

/** Fields of each complete record in `lines` (quoted newlines joined). */
function recordFields(lines: readonly string[], delim: string): string[][] {
  const out: string[][] = [];
  let parts: string[] = [];
  let quoted = false;
  for (const line of lines) {
    parts.push(line);
    for (let i = 0; i < line.length; i++) if (line[i] === '"') quoted = !quoted;
    if (!quoted) {
      out.push(splitRecord(parts.join('\n'), delim));
      parts = [];
    }
  }
  return out;
}

/** Whether a record has the header's `n` fields; extra empty ones (a trailing delimiter) are allowed. */
function fitsHeader(fields: readonly string[], n: number): boolean {
  return fields.length === n || (fields.length > n && fields.slice(n).every((f) => f.trim() === ''));
}

/**
 * Whether the sample is a delimited table: a header of names, and at least 80% of the following
 * records with the same number of fields. Comma and semicolon tables need 3+ columns, since
 * ordinary text with one comma per line would otherwise pass for a 2-column table.
 */
export function isCsv(sample: readonly string[]): boolean {
  const header = sample[0];
  if (!header) return false;
  const delim = pickDelimiter(header);
  if (!delim) return false;
  const names = splitRecord(header, delim);
  if (!names.every((h) => h.trim() === '' || NAME_RE.test(h.trim()))) return false;
  if (names.filter((h) => h.trim() !== '').length < (delim === '\t' ? 2 : 3)) return false;
  const records = recordFields(sample.slice(1), delim);
  if (records.length === 0) return false;
  return records.filter((f) => fitsHeader(f, names.length)).length / records.length >= 0.8;
}

/** Fields of one complete record (its lines joined with \n). */
export function splitRecord(text: string, delim: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field.trim() === '') {
      field = '';
      quoted = true;
    } else if (c === delim) {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out;
}

/** "10/30/2026, 4:48:28.868 AM" (Log Analytics) or "30/10/2026 16:48:28": day-first when the first part > 12. */
const SLASH_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(?: ?([AP]M))?$/i;

/** Epoch ms for a time cell; zone-less values are UTC (as elsewhere). */
export function parseCsvTime(v: string): number | null {
  const m = SLASH_DATE_RE.exec(v.trim());
  if (m) {
    const [month, day] = +m[1]! > 12 ? [+m[2]!, +m[1]!] : [+m[1]!, +m[2]!];
    let h = +m[4]!;
    if (m[8]) h = (h % 12) + (m[8].toUpperCase() === 'PM' ? 12 : 0);
    const ms = m[7] ? Math.floor(+`0.${m[7]}` * 1000) : 0;
    const t = Date.UTC(+m[3]!, month - 1, day, h, +m[5]!, +(m[6] ?? 0), ms);
    return Number.isNaN(t) ? null : t;
  }
  return toEpochMs(/^\d+(\.\d+)?$/.test(v) ? Number(v) : v);
}

const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function createCsvParser(): LineParser {
  const schema = new SchemaBuilder();
  const zones = new OffsetTracker();
  let rows: LogRow[] = [];
  let malformed: MalformedRow[] = [];
  let rowId = 0;
  let malformedId = 0;
  let header: string[] | null = null;
  let delim = ',';
  let timeIndex = -1;
  let timeIsUtc = false;
  /** Lines of a record whose quoted field continues on the next line. */
  let partial: string[] = [];
  let partialLine = 0;
  let quoted = false;

  function readHeader(text: string): void {
    delim = pickDelimiter(text) ?? ',';
    const names = splitRecord(text.replace(/^﻿/, ''), delim).map((h) => h.trim());
    const used = new Set<string>(['timestamp']);
    header = names.map((h, i) => {
      let k = h || `column${i + 1}`;
      for (let n = 2; used.has(k); n++) k = `${h || `column${i + 1}`}_${n}`;
      used.add(k);
      return k;
    });
    timeIndex = names.findIndex((h) => TIME_HEADERS.has(baseName(h)));
    timeIsUtc = timeIndex >= 0 && /utc/i.test(names[timeIndex]!);
    if (timeIndex >= 0) schema.add(TIMESTAMP_COLUMN);
  }

  function readRecord(text: string, lineNo: number): void {
    if (!header) return readHeader(text);
    let fields = splitRecord(text, delim);
    // Some exports end every line with a delimiter: drop empty extras.
    while (fields.length > header.length && fields[fields.length - 1]!.trim() === '') fields = fields.slice(0, -1);
    if (fields.length !== header.length) {
      if (fields.every((f) => f.trim() === '')) return;
      malformed.push({ id: malformedId++, lineNo, raw: text, reason: `Expected ${header.length} fields, found ${fields.length}` });
      return;
    }
    const values: Record<string, CellValue> = {};
    let ts: number | null = null;
    if (timeIndex >= 0) {
      const t = fields[timeIndex]!.trim();
      ts = t === '' ? null : parseCsvTime(t);
      if (ts !== null) zones.observe(timeIsUtc ? 0 : parseZoneSuffix(t));
      values.timestamp = ts;
    }
    for (let i = 0; i < header.length; i++) {
      if (i === timeIndex) continue;
      const key = header[i]!;
      const f = fields[i]!;
      const t = f.trim();
      let v: CellValue = t === '' ? null : NUMBER_RE.test(t) ? Number(t) : f;
      if (baseName(key) === 'severitylevel' && typeof v === 'number') v = SEVERITY_LEVELS[v] ?? v;
      schema.observe(key, v, roleOf(key));
      values[key] = v;
    }
    rows.push({ id: rowId++, lineNo, ts, values, raw: text });
  }

  function pushLine(line: string, lineNo: number): void {
    if (partial.length === 0) {
      if (line.trim() === '') return;
      partialLine = lineNo;
    }
    partial.push(line);
    for (let i = 0; i < line.length; i++) if (line[i] === '"') quoted = !quoted;
    if (quoted) return;
    const text = partial.join('\n');
    partial = [];
    readRecord(text, partialLine);
  }

  function drain(): ParsedChunk {
    const out = { rows, malformed, meta: [] };
    rows = [];
    malformed = [];
    return out;
  }

  /** At the end of each file: an unclosed quote is reported; the next file starts with its own header. */
  function finish(): ParsedChunk {
    if (partial.length > 0) {
      malformed.push({ id: malformedId++, lineNo: partialLine, raw: partial.join('\n').slice(0, 2000), reason: 'Unclosed quote' });
    }
    partial = [];
    quoted = false;
    header = null;
    return drain();
  }

  return { format: 'csv', pushLine, drain, finish, schema: () => schema.list(), timeZone: () => zones.result() };
}
