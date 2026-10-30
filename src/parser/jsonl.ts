import { SchemaBuilder, TIMESTAMP_COLUMN } from './schema';
import { OffsetTracker, parseZoneSuffix } from './timezone';
import type { CellValue, ColumnRole, LineParser, LogRow, MalformedRow, ParsedChunk } from './types';

const TIMESTAMP_KEYS = ['timestamp', '@timestamp', 'time', 'ts', 'date', 'datetime', 'Timestamp', 'Time', '@t'];

/** Semantic roles for well-known field names (lower-cased); also used for CSV headers. */
export const KEY_ROLES: Record<string, ColumnRole> = {
  level: 'level',
  severity: 'level',
  lvl: 'level',
  loglevel: 'level',
  message: 'message',
  msg: 'message',
  renderedmessage: 'message',
  requestpath: 'uri',
  requestmethod: 'method',
  elapsed: 'duration',
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

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const TEMPLATE_HOLE_RE = /\{\{|\}\}|\{[@$]?([A-Za-z0-9_]+)(?:,[^:}]*)?(?::[^}]*)?\}/g;

/** Fill a Serilog message template ("Took {Elapsed:0.0} ms") from the event's properties. */
export function renderTemplate(template: string, props: Record<string, unknown>): string {
  return template.replace(TEMPLATE_HOLE_RE, (hole, name: string | undefined) => {
    if (hole === '{{') return '{';
    if (hole === '}}') return '}';
    if (name === undefined || !(name in props)) return hole;
    const v = props[name];
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/**
 * Serilog's compact JSON (CLEF: "@t", "@mt"/"@m", "@l", "@x", …) mapped to the usual column names:
 * level (missing "@l" means Information), message (rendered from the template when "@m" is absent),
 * MessageTemplate, Exception, EventId. Returns null for other objects.
 */
function fromClef(rec: Record<string, unknown>): Record<string, unknown> | null {
  if (!('@t' in rec) || !('@mt' in rec || '@m' in rec)) return null;
  const out: Record<string, unknown> = { '@t': rec['@t'], level: rec['@l'] ?? 'Information' };
  out.message = typeof rec['@m'] === 'string' ? rec['@m'] : renderTemplate(String(rec['@mt']), rec);
  if ('@mt' in rec) out.MessageTemplate = rec['@mt'];
  if ('@x' in rec) out.Exception = rec['@x'];
  if ('@i' in rec) out.EventId = rec['@i'];
  for (const k in rec) {
    // "@r" holds renderings already applied above; other "@" keys are the ones mapped here.
    if (k.startsWith('@') && !k.startsWith('@@')) {
      if (k === '@tr' || k === '@sp') out[k === '@tr' ? 'TraceId' : 'SpanId'] = rec[k];
      continue;
    }
    out[k.startsWith('@@') ? k.slice(1) : k] = rec[k];
  }
  return out;
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
    if (!isPlainObject(obj)) return bad(line, lineNo, 'Not a JSON object');
    let rec = fromClef(obj) ?? obj;
    // Serilog's JsonFormatter nests event properties under "Properties": give each its own column.
    if (isPlainObject(rec.Properties)) {
      const { Properties: props, ...rest } = rec;
      rec = { ...rest };
      for (const k in props) if (!(k in rec)) rec[k] = props[k];
    }
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
