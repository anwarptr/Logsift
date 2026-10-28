import { SchemaBuilder, TIMESTAMP_COLUMN } from './schema';
import type { CellValue, ColumnDef, ColumnRole, LineParser, LogRow, MalformedRow, ParsedChunk } from './types';

const NUMERIC_FIELDS = new Set([
  's-port',
  'sc-status',
  'sc-substatus',
  'sc-win32-status',
  'sc-bytes',
  'cs-bytes',
  'time-taken',
]);

const FIELD_ROLES: Record<string, ColumnRole> = {
  'sc-status': 'status',
  'time-taken': 'duration',
  'cs-uri-stem': 'uri',
  'cs-uri-query': 'uriQuery',
  'c-ip': 'clientIp',
  'sc-bytes': 'bytesSent',
  'cs-bytes': 'bytesReceived',
  'cs-method': 'method',
  'cs-host': 'host',
  's-sitename': 'site',
  'cs(User-Agent)': 'userAgent',
};

const ARR_LOG_ID_RE = /X-ARR-LOG-ID=([0-9a-fA-F-]{36})/;
const SCM_PREFIX = '~1';

const KIND_STR = 0;
const KIND_NUM = 1;
const KIND_SKIP = 2;
const KIND_SITE = 3;

interface FieldPlan {
  n: number;
  keys: string[];
  kinds: number[];
  dateIdx: number;
  timeIdx: number;
  siteIdx: number;
  queryIdx: number;
  uaIdx: number;
  ipIdx: number;
}

/** Parse IIS "YYYY-MM-DD" + "HH:MM:SS[.fff]" (always UTC in W3C logs) into epoch ms. */
export function parseIisTimestamp(date: string | undefined, time: string | undefined): number | null {
  if (!date || !time || date.length < 10 || time.length < 8) return null;
  const ms = time.length > 9 ? Math.round(Number('0' + time.slice(8)) * 1000) : 0;
  const v = Date.UTC(
    +date.slice(0, 4),
    +date.slice(5, 7) - 1,
    +date.slice(8, 10),
    +time.slice(0, 2),
    +time.slice(3, 5),
    +time.slice(6, 8),
    ms,
  );
  return Number.isNaN(v) ? null : v;
}

export function createIisParser(): LineParser {
  const schema = new SchemaBuilder();
  let plan: FieldPlan | null = null;
  let rows: LogRow[] = [];
  let malformed: MalformedRow[] = [];
  let meta: string[] = [];
  let rowId = 0;
  let malformedId = 0;

  function setFields(fields: string[]): void {
    const dateIdx = fields.indexOf('date');
    const timeIdx = fields.indexOf('time');
    const hasTs = dateIdx >= 0 && timeIdx >= 0;
    const kinds: number[] = [];
    fields.forEach((f, i) => {
      if (hasTs && (i === dateIdx || i === timeIdx)) {
        kinds.push(KIND_SKIP);
        if (i === Math.min(dateIdx, timeIdx)) schema.add(TIMESTAMP_COLUMN);
        return;
      }
      const numeric = NUMERIC_FIELDS.has(f);
      kinds.push(f === 's-sitename' ? KIND_SITE : numeric ? KIND_NUM : KIND_STR);
      schema.add({ key: f, label: f, type: numeric ? 'number' : 'string', role: FIELD_ROLES[f] });
    });
    const p: FieldPlan = {
      n: fields.length,
      keys: fields,
      kinds,
      dateIdx: hasTs ? dateIdx : -1,
      timeIdx: hasTs ? timeIdx : -1,
      siteIdx: fields.indexOf('s-sitename'),
      queryIdx: fields.indexOf('cs-uri-query'),
      uaIdx: fields.indexOf('cs(User-Agent)'),
      ipIdx: fields.indexOf('c-ip'),
    };
    const derived: ColumnDef[] = [];
    if (p.siteIdx >= 0) derived.push({ key: 'isScm', label: 'isScm', type: 'boolean', role: 'scm', derived: true });
    if (p.queryIdx >= 0) derived.push({ key: 'arrLogId', label: 'arrLogId', type: 'string', derived: true });
    if (p.uaIdx >= 0 || p.ipIdx >= 0)
      derived.push({ key: 'isHealthCheck', label: 'isHealthCheck', type: 'boolean', role: 'healthCheck', derived: true });
    derived.forEach((d) => schema.add(d));
    plan = p;
  }

  function pushLine(line: string, lineNo: number): void {
    if (line.length === 0) return;
    if (line.charCodeAt(0) === 35 /* # */) {
      meta.push(line);
      if (line.startsWith('#Fields:')) {
        setFields(line.slice(8).trim().split(/\s+/).filter(Boolean));
      }
      return;
    }
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) return;
    if (!plan) {
      malformed.push({ id: malformedId++, lineNo, raw: line, reason: 'Data line before any #Fields directive' });
      return;
    }
    const parts = trimmed.split(' ');
    if (parts.length !== plan.n) {
      malformed.push({
        id: malformedId++,
        lineNo,
        raw: line,
        reason: `Expected ${plan.n} fields, found ${parts.length}`,
      });
      return;
    }
    const values: Record<string, CellValue> = {};
    let ts: number | null = null;
    if (plan.dateIdx >= 0) {
      ts = parseIisTimestamp(parts[plan.dateIdx], parts[plan.timeIdx]);
      values.timestamp = ts;
    }
    let isScm = false;
    for (let i = 0; i < plan.n; i++) {
      const kind = plan.kinds[i];
      if (kind === KIND_SKIP) continue;
      const key = plan.keys[i]!;
      const p = parts[i]!;
      if (p === '-') {
        values[key] = null;
      } else if (kind === KIND_NUM) {
        const n = Number(p);
        values[key] = Number.isNaN(n) ? p : n;
      } else if (kind === KIND_SITE && p.startsWith(SCM_PREFIX)) {
        isScm = true;
        values[key] = p.slice(SCM_PREFIX.length);
      } else {
        values[key] = p;
      }
    }
    if (plan.siteIdx >= 0) values.isScm = isScm;
    if (plan.queryIdx >= 0) {
      const q = parts[plan.queryIdx]!;
      const m = q === '-' ? null : ARR_LOG_ID_RE.exec(q);
      values.arrLogId = m ? m[1]! : null;
    }
    if (plan.uaIdx >= 0 || plan.ipIdx >= 0) {
      values.isHealthCheck =
        (plan.uaIdx >= 0 && parts[plan.uaIdx] === 'AlwaysOn') || (plan.ipIdx >= 0 && parts[plan.ipIdx] === '127.0.0.1');
    }
    rows.push({ id: rowId++, lineNo, ts, values, raw: line });
  }

  function drain(): ParsedChunk {
    const out = { rows, malformed, meta };
    rows = [];
    malformed = [];
    meta = [];
    return out;
  }

  return {
    format: 'iis',
    pushLine,
    drain,
    finish: drain,
    schema: () => schema.list(),
  };
}
