import { GENERIC_LINE_RE, normalizeLevel, refineEntry } from './generic';
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
  // Python (python-json-logger), Elastic Common Schema, logstash-logback-encoder.
  levelname: 'level',
  'log.level': 'level',
  logger_name: 'logger',
  'log.logger': 'logger',
  status_code: 'status',
  'http.response.status_code': 'status',
  'http.request.method': 'method',
  'url.path': 'uri',
  'client.ip': 'clientIp',
  remote_addr: 'clientIp',
  remote_ip: 'clientIp',
  duration_ms: 'duration',
  elapsed_ms: 'duration',
  latency_ms: 'duration',
  // pino-http / express request logging (after `req` and `res` are flattened).
  'req.method': 'method',
  'req.url': 'uri',
  'req.remoteaddress': 'clientIp',
  'res.statuscode': 'status',
  responsetime: 'duration',
  response_time: 'duration',
};

/** pino/bunyan numeric levels. */
const NUMERIC_LEVELS: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const LEVEL_KEYS = new Set(['level', 'lvl', 'severity', 'loglevel']);

/** Nested request/response objects whose fields get their own columns ("req.method", "res.statusCode"). */
const FLATTEN_KEYS = ['req', 'res', 'request', 'response'];

/** A leading level word in container output that has no other layout ("ERROR boom", "[WARN] x"). */
const LEADING_LEVEL_RE =
  /^\s*\[?(TRACE|DEBUG|INFORMATION|INFO|NOTICE|WARNING|WARN|ERROR|ERR|FATAL|CRITICAL|CRIT|VERBOSE|DBG|INF|WRN|FTL)\]?(?![A-Za-z])[\s:|-]*/i;

/**
 * Docker's json-file driver (also `kubectl logs` from it): {"log":"text\n","stream":"stderr","time":"…"}.
 * The container's own output is in "log": a JSON object there is spread into columns, a text line
 * is read like a text log (level, logger, message). Returns null for other objects.
 */
function fromDocker(rec: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof rec.log !== 'string' || typeof rec.stream !== 'string' || !('time' in rec)) return null;
  const text = rec.log.replace(/\r?\n$/, '');
  const { log: _log, ...out } = rec;
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const inner: unknown = JSON.parse(trimmed);
      if (isPlainObject(inner)) {
        for (const k in inner) if (!(k in out)) out[k] = inner[k];
        return out;
      }
    } catch {
      // Not JSON after all: read it as text.
    }
  }
  const m = GENERIC_LINE_RE.exec(text);
  if (m) {
    const e = refineEntry(m[2], m[3], m[4] ?? '');
    if (e.level) out.level = e.level;
    if (e.logger) out.logger = e.logger;
    Object.assign(out, e.extra);
    out.message = e.message;
  } else {
    const l = LEADING_LEVEL_RE.exec(text);
    if (l) out.level = normalizeLevel(l[1]!);
    out.message = l ? text.slice(l[0].length) : text;
  }
  return out;
}

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
    rec = fromDocker(rec) ?? rec;
    // Serilog's JsonFormatter nests event properties under "Properties": give each its own column.
    if (isPlainObject(rec.Properties)) {
      const { Properties: props, ...rest } = rec;
      rec = { ...rest };
      for (const k in props) if (!(k in rec)) rec[k] = props[k];
    }
    // pino-http and similar: {"req":{"method":"GET","url":"/x"},"res":{"statusCode":200}} → "req.method", …
    for (const fk of FLATTEN_KEYS) {
      const nested = rec[fk];
      if (!isPlainObject(nested)) continue;
      const flat: Record<string, unknown> = {};
      for (const k in rec) {
        if (k !== fk) flat[k] = rec[k];
        else for (const nk in nested) flat[`${fk}.${nk}`] = nested[nk];
      }
      rec = flat;
    }
    // structlog writes the message as "event".
    const eventIsMessage = typeof rec.event === 'string' && !('message' in rec) && !('msg' in rec);
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
      const lower = k.toLowerCase();
      if (typeof v === 'number' && LEVEL_KEYS.has(lower) && NUMERIC_LEVELS[v]) v = NUMERIC_LEVELS[v]!;
      // Avoid clobbering the synthetic timestamp column with an unrelated "timestamp" key.
      const key = k === 'timestamp' ? 'timestamp_raw' : k;
      schema.observe(key, v, eventIsMessage && k === 'event' ? 'message' : KEY_ROLES[lower]);
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
