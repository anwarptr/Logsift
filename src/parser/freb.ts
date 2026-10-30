import { SchemaBuilder, TIMESTAMP_COLUMN } from './schema';
import { OffsetTracker, parseZoneSuffix } from './timezone';
import type { CellValue, ColumnRole, LineParser, LogRow, MalformedRow, ParsedChunk } from './types';

/*
 * IIS Failed Request Tracing (FREB) files: fr000123.xml, one failed request per file, as a
 * <failedRequest> root holding the request's trace events. Each request becomes one row; the
 * row's `raw` is a readable event timeline instead of the XML. The schema is regular, so a few
 * regexes do the job (DOMParser is not available in workers).
 */

const ROOT_START_RE = /<failedRequest\b/;
const ROOT_END = '</failedRequest>';
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const EVENT_RE = /<Event\b[\s\S]*?<\/Event>/g;
const DATA_RE = /<Data\s+Name="([^"]*)"\s*(?:\/>|>([\s\S]*?)<\/Data>)/g;
const DESCRIPTION_RE = /<freb:Description\s+Data="([^"]*)"\s*>([\s\S]*?)<\/freb:Description>/g;
const RENDERED_OPCODE_RE = /<RenderingInfo\b[\s\S]*?<Opcode>([^<]*)<\/Opcode>/;
const LEVEL_RE = /<Level>(\d+)<\/Level>/;
const SYSTEM_TIME_RE = /<TimeCreated\s+SystemTime="([^"]*)"/;

/** Trace and Windows event levels (1 = most severe). */
export const LEVEL_NAMES = ['', 'Critical', 'Error', 'Warning', 'Information', 'Verbose'];

const ENTITY_RE = /&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|amp|quot|apos));/gi;
const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY_RE, (m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? m;
    const cp = hex ? parseInt(hex, 16) : Number(dec);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

export function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(ATTR_RE)) out[m[1]!] = decodeXml(m[2] ?? m[3] ?? '');
  return out;
}

interface TraceEvent {
  time: string | null;
  level: number;
  name: string;
  /** Data fields, with numeric codes replaced by IIS's description where it gives one. */
  data: [string, string][];
}

function readEvent(xml: string): TraceEvent {
  const desc = new Map<string, string>();
  for (const m of xml.matchAll(DESCRIPTION_RE)) desc.set(m[1]!, decodeXml(m[2]!));
  const data: [string, string][] = [];
  for (const m of xml.matchAll(DATA_RE)) data.push([m[1]!, desc.get(m[1]!) ?? decodeXml(m[2] ?? '')]);
  const level = LEVEL_RE.exec(xml);
  return {
    time: SYSTEM_TIME_RE.exec(xml)?.[1] ?? null,
    level: level ? +level[1]! : 0,
    name: RENDERED_OPCODE_RE.exec(xml)?.[1]?.trim() || 'EVENT',
    data,
  };
}

const field = (e: TraceEvent, name: string) => e.data.find(([k]) => k === name)?.[1];

/** "12:34:56.789" from "2026-10-30T12:34:56.7891234Z". */
const timeOfDay = (iso: string) => /T(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/.exec(iso)?.[1] ?? iso;

/** One line per event: time, offset from the first event, name, level (warnings and worse), data. */
function timeline(events: TraceEvent[], t0: number | null): string {
  return events
    .map((e) => {
      const t = e.time === null ? null : Date.parse(e.time);
      const when = e.time === null ? '' : timeOfDay(e.time) + (t0 !== null && t !== null ? ` +${t - t0} ms` : '');
      const level = e.level >= 1 && e.level <= 3 ? ` [${LEVEL_NAMES[e.level]}]` : '';
      const data = e.data
        .filter(([k, v]) => k !== 'ContextId' && v.trim() !== '')
        .map(([k, v]) => `\n    ${k}: ${v.trimEnd().replace(/\r?\n/g, '\n      ')}`)
        .join('');
      return `${when}  ${e.name}${level}${data}`;
    })
    .join('\n');
}

const KEY_ROLES: Record<string, ColumnRole> = {
  method: 'method',
  host: 'host',
  uri: 'uri',
  query: 'uriQuery',
  status: 'status',
  timeTaken: 'duration',
  level: 'level',
  message: 'message',
  userAgent: 'userAgent',
  bytesSent: 'bytesSent',
  bytesReceived: 'bytesReceived',
};

const toNumber = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function createFrebParser(): LineParser {
  const schema = new SchemaBuilder();
  const zones = new OffsetTracker();
  let rows: LogRow[] = [];
  let malformed: MalformedRow[] = [];
  let rowId = 0;
  let malformedId = 0;
  /** Lines of the <failedRequest> being read, and the line it started on. */
  let doc: string[] | null = null;
  let docLine = 0;

  function bad(raw: string, lineNo: number, reason: string): void {
    malformed.push({ id: malformedId++, lineNo, raw, reason });
  }

  function incomplete(): void {
    if (doc === null) return;
    bad(doc.slice(0, 20).join('\n'), docLine, 'Incomplete failed request trace (no closing </failedRequest>)');
    doc = null;
  }

  function readRequest(xml: string, lineNo: number): void {
    const rootTag = /<failedRequest\b[^>]*>/.exec(xml)?.[0] ?? '';
    const req = attributes(rootTag);
    const events = [...xml.matchAll(EVENT_RE)].map((m) => readEvent(m[0]));
    if (req.url === undefined && events.length === 0) return bad(rootTag || xml.slice(0, 500), lineNo, 'No request or events in trace');

    const values: Record<string, CellValue> = {};
    const set = (key: string, v: CellValue) => {
      schema.observe(key, v, KEY_ROLES[key]);
      values[key] = v;
    };

    const firstTime = events.find((e) => e.time !== null)?.time ?? null;
    const t0 = firstTime === null ? null : Date.parse(firstTime);
    const ts = t0 === null || Number.isNaN(t0) ? null : t0;
    if (firstTime !== null && ts !== null) zones.observe(parseZoneSuffix(firstTime));
    schema.add(TIMESTAMP_COLUMN);
    values.timestamp = ts;

    set('method', req.verb ?? null);
    let host: string | null = null;
    let uri = req.url ?? null;
    let query: string | null = null;
    if (uri !== null) {
      try {
        const u = new URL(uri);
        host = u.host;
        uri = decodeURIComponentSafe(u.pathname);
        query = u.search ? u.search.slice(1) : null;
      } catch {
        // Not an absolute URL: keep it as the path.
      }
    }
    set('host', host);
    set('uri', uri);
    set('query', query);

    // "404" or "500.19" (status.substatus).
    const errorEvent = [...events].reverse().find((e) => e.name === 'MODULE_SET_RESPONSE_ERROR_STATUS');
    const endEvent = events.find((e) => e.name === 'GENERAL_REQUEST_END');
    const [statusText, subText] = (req.statusCode ?? '').split('.');
    set('status', toNumber(statusText));
    const statusEvent = errorEvent ?? endEvent;
    set('subStatus', toNumber(subText) ?? toNumber(statusEvent && field(statusEvent, 'HttpSubStatus')));
    set('timeTaken', toNumber(req.timeTaken));

    const worst = events.reduce((min, e) => (e.level >= 1 && e.level < min ? e.level : min), 6);
    set('level', worst <= 5 ? LEVEL_NAMES[worst]! : null);
    set('failureReason', req.failureReason || null);
    set('module', (errorEvent && field(errorEvent, 'ModuleName')) || null);
    set('notification', (errorEvent && field(errorEvent, 'Notification')) || null);
    set('message', summary(req, errorEvent));

    set('bytesSent', toNumber(endEvent && field(endEvent, 'BytesSent')));
    set('bytesReceived', toNumber(endEvent && field(endEvent, 'BytesReceived')));
    const headers = events.find((e) => e.name === 'GENERAL_REQUEST_HEADERS');
    const ua = headers && /^User-Agent:\s*(.*)$/im.exec(field(headers, 'Headers') ?? '');
    set('userAgent', ua ? ua[1]!.trim() : null);
    set('appPool', req.appPoolId || null);
    set('userName', req.userName || null);
    set('siteId', toNumber(req.siteId));
    set('processId', toNumber(req.processId));
    set('activityId', req.activityId || null);
    set('events', events.length);

    const raw = timeline(events, ts);
    rows.push({ id: rowId++, lineNo, ts, values, raw: raw || rootTag });
  }

  function pushLine(line: string, lineNo: number): void {
    if (doc === null) {
      if (!ROOT_START_RE.test(line)) {
        const t = line.trim();
        // The XML declaration, stylesheet and comments IIS writes before the root are skipped.
        if (t !== '' && !t.startsWith('<?') && !t.startsWith('<!--')) bad(line, lineNo, 'Not part of a failed request trace');
        return;
      }
      doc = [];
      docLine = lineNo;
    } else if (ROOT_START_RE.test(line)) {
      incomplete();
      doc = [];
      docLine = lineNo;
    }
    doc.push(line);
    if (line.includes(ROOT_END)) {
      const xml = doc.join('\n');
      doc = null;
      readRequest(xml, docLine);
    }
  }

  function drain(): ParsedChunk {
    const out = { rows, malformed, meta: [] };
    rows = [];
    malformed = [];
    return out;
  }

  /** Called at the end of every file: a trace left open there is incomplete. */
  function finish(): ParsedChunk {
    incomplete();
    return drain();
  }

  return { format: 'freb', pushLine, drain, finish, schema: () => schema.list(), timeZone: () => zones.result() };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** "AspNetCoreModuleV2 set 404.0 Not Found in EXECUTE_REQUEST_HANDLER", plus the error when there is one. */
function summary(req: Record<string, string>, errorEvent: TraceEvent | undefined): string | null {
  if (!errorEvent) {
    if (!req.failureReason) return null;
    return req.failureReason === 'TIME_TAKEN' && req.timeTaken
      ? `Took ${req.timeTaken} ms (slow request trace)`
      : `Failure reason: ${req.failureReason}${req.statusCode ? `, status ${req.statusCode}` : ''}`;
  }
  const f = (name: string) => field(errorEvent, name)?.trim() ?? '';
  const status = [f('HttpStatus'), f('HttpSubStatus')].filter(Boolean).join('.');
  let text = `${f('ModuleName') || 'A module'} set ${status} ${f('HttpReason')}`.trimEnd();
  if (f('Notification')) text += ` in ${f('Notification')}`;
  const code = f('ErrorCode');
  if (code && !/^0$|\(0x0\)$/.test(code)) text += `: ${code}`;
  if (f('ConfigExceptionInfo')) text += `\n${f('ConfigExceptionInfo')}`;
  return text;
}
