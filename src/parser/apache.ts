import { SchemaBuilder, TIMESTAMP_COLUMN } from './schema';
import type { CellValue, ColumnDef, LineParser, LogRow, MalformedRow, ParsedChunk } from './types';

/**
 * Apache/Nginx "combined" (and "common", without referer/user-agent):
 * host ident user [time] "request" status bytes "referer" "user-agent"
 */
export const APACHE_LINE_RE =
  /^(\S+) (\S+) (\S+) \[([^\]]+)\] "((?:[^"\\]|\\.)*)" (\d{3}) (\S+)(?: "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)")?/;

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Parse "10/Oct/2000:13:55:36 -0700" into epoch ms (UTC). */
export function parseApacheTimestamp(s: string): number | null {
  const month = MONTHS[s.slice(3, 6)];
  if (month === undefined || s.length < 20) return null;
  let v = Date.UTC(+s.slice(7, 11), month, +s.slice(0, 2), +s.slice(12, 14), +s.slice(15, 17), +s.slice(18, 20));
  if (s.length >= 26) {
    const sign = s[21] === '-' ? -1 : 1;
    const offsetMin = +s.slice(22, 24) * 60 + +s.slice(24, 26);
    v -= sign * offsetMin * 60_000;
  }
  return Number.isNaN(v) ? null : v;
}

const COLUMNS: ColumnDef[] = [
  TIMESTAMP_COLUMN,
  { key: 'c-ip', label: 'c-ip', type: 'string', role: 'clientIp' },
  { key: 'cs-username', label: 'cs-username', type: 'string' },
  { key: 'cs-method', label: 'cs-method', type: 'string', role: 'method' },
  { key: 'cs-uri-stem', label: 'cs-uri-stem', type: 'string', role: 'uri' },
  { key: 'cs-uri-query', label: 'cs-uri-query', type: 'string', role: 'uriQuery' },
  { key: 'cs-version', label: 'cs-version', type: 'string' },
  { key: 'sc-status', label: 'sc-status', type: 'number', role: 'status' },
  { key: 'sc-bytes', label: 'sc-bytes', type: 'number', role: 'bytesSent' },
  { key: 'cs(Referer)', label: 'cs(Referer)', type: 'string' },
  { key: 'cs(User-Agent)', label: 'cs(User-Agent)', type: 'string', role: 'userAgent' },
];

const dash = (s: string | undefined): string | null => (s === undefined || s === '-' || s === '' ? null : s);

export function createApacheParser(): LineParser {
  const schema = new SchemaBuilder();
  COLUMNS.forEach((c) => schema.add(c));
  let rows: LogRow[] = [];
  let malformed: MalformedRow[] = [];
  let rowId = 0;
  let malformedId = 0;

  function pushLine(line: string, lineNo: number): void {
    if (line.trim().length === 0) return;
    const m = APACHE_LINE_RE.exec(line);
    if (!m) {
      malformed.push({ id: malformedId++, lineNo, raw: line, reason: 'Line does not match combined log format' });
      return;
    }
    const ts = parseApacheTimestamp(m[4]!);
    const request = m[5]!;
    const reqParts = request.split(' ');
    let method: string | null = null;
    let target: string | null = request || null;
    let version: string | null = null;
    if (reqParts.length === 3) {
      method = reqParts[0]!;
      target = reqParts[1]!;
      version = reqParts[2]!;
    }
    let stem = target;
    let query: string | null = null;
    if (target) {
      const q = target.indexOf('?');
      if (q >= 0) {
        stem = target.slice(0, q);
        query = target.slice(q + 1) || null;
      }
    }
    const bytes = dash(m[7]);
    const values: Record<string, CellValue> = {
      timestamp: ts,
      'c-ip': m[1]!,
      'cs-username': dash(m[3]),
      'cs-method': method,
      'cs-uri-stem': stem,
      'cs-uri-query': query,
      'cs-version': version,
      'sc-status': Number(m[6]),
      'sc-bytes': bytes === null ? null : Number(bytes),
      'cs(Referer)': dash(m[8]),
      'cs(User-Agent)': dash(m[9]),
    };
    rows.push({ id: rowId++, lineNo, ts, values, raw: line });
  }

  function drain(): ParsedChunk {
    const out = { rows, malformed, meta: [] };
    rows = [];
    malformed = [];
    return out;
  }

  return { format: 'apache', pushLine, drain, finish: drain, schema: () => schema.list() };
}
