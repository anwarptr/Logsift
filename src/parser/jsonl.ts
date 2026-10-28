import { SchemaBuilder, TIMESTAMP_COLUMN } from './schema';
import { OffsetTracker, parseZoneSuffix } from './timezone';
import type { CellValue, ColumnRole, LineParser, LogRow, MalformedRow, ParsedChunk } from './types';

const TIMESTAMP_KEYS = ['timestamp', '@timestamp', 'time', 'ts', 'date', 'datetime', 'Timestamp', 'Time'];

const KEY_ROLES: Record<string, ColumnRole> = {
  level: 'level',
  severity: 'level',
  lvl: 'level',
  loglevel: 'level',
  message: 'message',
  msg: 'message',
  logger: 'logger',
  source: 'logger',
  category: 'logger',
  sourcecontext: 'logger',
  status: 'status',
  statuscode: 'status',
  path: 'uri',
  url: 'uri',
  uri: 'uri',
  method: 'method',
  durationms: 'duration',
  elapsedms: 'duration',
  'time-taken': 'duration',
  ip: 'clientIp',
  clientip: 'clientIp',
  host: 'host',
};

/** Convert a JSON timestamp value (ISO string, epoch seconds or epoch ms) to epoch ms. */
export function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === 'string') {
    // Zone-less date-times are UTC, as in the generic parser (Date.parse would use local time).
    const t = Date.parse(parseZoneSuffix(v) === null && /\d:\d{2}/.test(v) ? v.trim() + 'Z' : v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function createJsonlParser(): LineParser {
  const schema = new SchemaBuilder();
  let rows: LogRow[] = [];
  let malformed: MalformedRow[] = [];
  let rowId = 0;
  let malformedId = 0;
  const zones = new OffsetTracker();

  function bad(line: string, lineNo: number, reason: string): void {
    malformed.push({ id: malformedId++, lineNo, raw: line, reason });
  }

  function pushLine(line: string, lineNo: number): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    if (trimmed.charCodeAt(0) !== 123 /* { */) return bad(line, lineNo, 'Not a JSON object');
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return bad(line, lineNo, 'Invalid JSON');
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return bad(line, lineNo, 'Not a JSON object');
    const rec = obj as Record<string, unknown>;
    let tsKey: string | undefined;
    for (const k of TIMESTAMP_KEYS) {
      if (k in rec) {
        tsKey = k;
        break;
      }
    }
    const values: Record<string, CellValue> = {};
    let ts: number | null = null;
    if (tsKey !== undefined) {
      const rawTs = rec[tsKey];
      ts = toEpochMs(rawTs);
      if (typeof rawTs === 'string' && ts !== null) zones.observe(parseZoneSuffix(rawTs));
      schema.add(TIMESTAMP_COLUMN);
      values.timestamp = ts;
    }
    for (const k in rec) {
      if (k === tsKey) continue;
      const raw = rec[k];
      let v: CellValue;
      if (raw === null || raw === undefined) v = null;
      else if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') v = raw;
      else v = JSON.stringify(raw);
      // Avoid clobbering the synthetic timestamp column with an unrelated "timestamp" key.
      const key = k === 'timestamp' ? 'timestamp_raw' : k;
      schema.observe(key, v, KEY_ROLES[k.toLowerCase()]);
      values[key] = v;
    }
    rows.push({ id: rowId++, lineNo, ts, values, raw: line });
  }

  function drain(): ParsedChunk {
    const out = { rows, malformed, meta: [] };
    rows = [];
    malformed = [];
    return out;
  }

  return { format: 'jsonl', pushLine, drain, finish: drain, schema: () => schema.list(), timeZone: () => zones.result() };
}
