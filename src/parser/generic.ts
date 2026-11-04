import { TIMESTAMP_COLUMN } from './schema';
import { OffsetTracker, parseZoneSuffix, type LogTimeZone } from './timezone';
import type { CellValue, ColumnDef, LineParser, LogRow, MalformedRow, ParsedChunk } from './types';

/**
 * Leading ISO-like timestamp, optional level, optional [logger], then the message.
 * Examples:
 *   2026-10-27 04:42:02.120 INFO  [Startup] Application starting
 *   2026-10-27T04:42:03Z WARN [Db] Pool nearly exhausted
 *   [2026-10-27 04:42:03,120] ERROR: something broke
 *   2026/10/27 04:42:03 [error] 123#0: *1 upstream timed out   (Nginx error log)
 * The message is then checked for common layouts that put the level elsewhere
 * (Python logging, logback/log4j, Spring Boot, Nginx): see `refineEntry`.
 */
export const GENERIC_LINE_RE =
  /^\s*\[?(\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?: ?(?:Z|[+-]\d{2}:?\d{2}))?)\]?[\s|:-]*(?:\[?(TRACE|DEBUG|INFORMATION|INFO|NOTICE|WARNING|WARN|ERROR|ERR|FATAL|CRITICAL|CRIT|ALERT|EMERG|VERBOSE|VRB|DBG|INF|WRN|ERR|FTL)\]?(?![A-Za-z]))?[\s|:-]*(?:\[([^\]]{1,120})\])?[\s:-]*(.*)$/i;

/** A level word, as in the line regexes. */
const LEVEL_WORD = 'TRACE|DEBUG|INFORMATION|INFO|NOTICE|WARNING|WARN|ERROR|ERR|FATAL|CRITICAL|CRIT|ALERT|EMERG|VERBOSE|VRB|DBG|INF|WRN|FTL';

/** Python logging's default-style "%(asctime)s - %(name)s - %(levelname)s - %(message)s". */
const PYTHON_RE = new RegExp(`^([\\w.$<>-]{1,200}) - (${LEVEL_WORD}) - ([\\s\\S]*)$`, 'i');
/** Message that starts with the level (logback "[thread] LEVEL logger - msg", after the thread was taken as logger). */
const LEADING_LEVEL_RE = new RegExp(`^(${LEVEL_WORD})(?![A-Za-z])[\\s:]+([\\s\\S]*)$`, 'i');
/** A Java-style logger name, then " - " and the message (logback/log4j "%logger - %msg"). */
const JAVA_LOGGER_RE = /^([\w$]+(?:\.[\w$]+)*)\s+-\s([\s\S]*)$/;
const DOTTED_LOGGER_RE = /^([\w$]+(?:\.[\w$]+)+)\s+-\s([\s\S]*)$/;
/** Spring Boot: "1234 --- [app] [main] c.a.App : msg" (the "[app]" part is Spring Boot 3.2+). */
const SPRING_RE = /^(\d+)\s+---\s+(?:\[[^\]]*\]\s+)?\[\s*([^\]]*?)\s*\]\s+(\S+)\s+:\s?([\s\S]*)$/;
/** Nginx error log message: "pid#tid: *connection text, client: …, request: "GET /x HTTP/1.1", host: "…"". */
const NGINX_RE = /^(\d+)#\d+: (?:\*\d+ )?([\s\S]*)$/;
const NGINX_CLIENT_RE = /, client: ([^,\s]+)/;
const NGINX_REQUEST_RE = /, request: "([A-Z]+) (\S+)[^"]*"/;
const NGINX_HOST_RE = /, host: "([^"]+)"/;

/**
 * Time of day without a date, then a level (required, so ordinary text starting with a time
 * isn't taken for an entry). Serilog's console default is "[HH:mm:ss INF] message":
 *   [11:54:02 INF] Now listening on: http://localhost:5100
 *   11:54:02.120 WARN [Db] Pool nearly exhausted
 */
export const TIME_ONLY_LINE_RE =
  /^\s*\[?(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?[\s|:-]+\[?(TRACE|DEBUG|INFORMATION|INFO|NOTICE|WARNING|WARN|ERROR|ERR|FATAL|CRITICAL|CRIT|ALERT|EMERG|VERBOSE|VRB|DBG|INF|WRN|FTL)\]?(?![A-Za-z])[\s|:-]*(?:\[([^\]]{1,120})\])?[\s:-]*(.*)$/i;

const DAY_MS = 86_400_000;

/** Midnight of `ms`'s local calendar date, as a zone-less (UTC) timestamp like the parsed times. */
export function calendarDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

const isoDate = (day: number) => new Date(day).toISOString().slice(0, 10);

const LEVEL_ALIASES: Record<string, string> = {
  INFORMATION: 'INFO',
  INF: 'INFO',
  WARNING: 'WARN',
  WRN: 'WARN',
  ERR: 'ERROR',
  CRITICAL: 'FATAL',
  CRIT: 'FATAL',
  FTL: 'FATAL',
  DBG: 'DEBUG',
  VERBOSE: 'TRACE',
  VRB: 'TRACE',
};

export function normalizeLevel(level: string): string {
  const up = level.toUpperCase();
  return LEVEL_ALIASES[up] ?? up;
}

/** Parse an ISO-like timestamp; values without a zone are treated as UTC. */
export function parseLooseIso(s: string): number | null {
  let iso = s.replace(/^(\d{4})\/(\d{2})\/(\d{2})/, '$1-$2-$3').replace(' ', 'T').replace(',', '.');
  // "+0400" / " +04:00" → "+04:00"
  iso = iso.replace(/ ?([+-]\d{2}):?(\d{2})$/, '$1:$2').replace(/ Z$/, 'Z');
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) iso += 'Z';
  // Date.parse only understands up to millisecond precision.
  iso = iso.replace(/(\.\d{3})\d+/, '$1');
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * ASP.NET Core request log written by Serilog's UseSerilogRequestLogging():
 *   HTTP GET /api/products responded 200 in 442.7618 ms
 */
export const SERILOG_REQUEST_RE = /^HTTP ([A-Z]+) (\S+) responded (\d{3}) in (\d+(?:\.\d+)?) ms\b/;

/** A text log entry after `refineEntry`: level (normalized), logger, message and any extra fields. */
export interface TextEntry {
  level: string | null;
  logger: string | null;
  message: string;
  /** Keys of `OPTIONAL_COLUMNS`. */
  extra: Record<string, CellValue>;
}

/**
 * Work out level, logger and extra fields for layouts that the line regex alone gets wrong:
 *   Python   2026-10-27 04:42:03,120 - app.db - ERROR - connection lost
 *   logback  2026-10-27 04:42:03.120 [main] ERROR com.acme.Svc - boom
 *   log4j    2026-10-27 04:42:03,120 ERROR [main] com.acme.Svc - boom
 *   Spring   2026-10-27T04:42:03.120Z ERROR 1234 --- [main] c.a.App : boom
 *   Nginx    2026/10/27 04:42:03 [error] 123#0: *1 upstream timed out, client: 1.2.3.4, request: "GET /x HTTP/1.1"
 * `rawLevel`, `rawLogger` and `message` are what the line regex captured.
 */
export function refineEntry(rawLevel: string | undefined, rawLogger: string | undefined, message: string): TextEntry {
  let level = rawLevel;
  let logger = rawLogger;
  let msg = message;
  const extra: Record<string, CellValue> = {};
  if (!level) {
    let m: RegExpExecArray | null;
    if (!logger && (m = PYTHON_RE.exec(msg))) {
      [, logger, level, msg] = m as unknown as [string, string, string, string];
    } else if (logger && (m = LEADING_LEVEL_RE.exec(msg))) {
      // logback: the "[...]" before the level was the thread.
      level = m[1]!;
      msg = m[2]!;
      extra.thread = logger;
      logger = undefined;
      const j = JAVA_LOGGER_RE.exec(msg);
      if (j) [, logger, msg] = j as unknown as [string, string, string];
    }
  } else if (logger) {
    // log4j: "LEVEL [thread] com.acme.Svc - msg".
    const j = DOTTED_LOGGER_RE.exec(msg);
    if (j) {
      extra.thread = logger;
      [, logger, msg] = j as unknown as [string, string, string];
    }
  } else {
    const s = SPRING_RE.exec(msg);
    if (s) {
      extra.pid = Number(s[1]);
      extra.thread = s[2]!;
      logger = s[3]!;
      msg = s[4]!;
    } else {
      const n = NGINX_RE.exec(msg);
      if (n) {
        extra.pid = Number(n[1]);
        msg = n[2]!;
        const client = NGINX_CLIENT_RE.exec(msg);
        if (client) extra.client = client[1]!;
        const req = NGINX_REQUEST_RE.exec(msg);
        if (req) {
          extra.RequestMethod = req[1]!;
          extra.RequestPath = req[2]!;
        }
        const host = NGINX_HOST_RE.exec(msg);
        if (host) extra.host = host[1]!;
      }
    }
  }
  return { level: level ? normalizeLevel(level) : null, logger: logger ?? null, message: msg, extra };
}

const COLUMNS = {
  level: { key: 'level', label: 'level', type: 'string', role: 'level' } as ColumnDef,
  logger: { key: 'logger', label: 'logger', type: 'string', role: 'logger' } as ColumnDef,
  message: { key: 'message', label: 'message', type: 'string', role: 'message' } as ColumnDef,
};

// Shown only when some row has them, in this order (between logger and message).
// The request columns are named after the Serilog properties they come from.
const OPTIONAL_COLUMNS: ColumnDef[] = [
  { key: 'thread', label: 'thread', type: 'string' },
  { key: 'pid', label: 'pid', type: 'number' },
  { key: 'client', label: 'client', type: 'string', role: 'clientIp' },
  { key: 'host', label: 'host', type: 'string', role: 'host' },
  { key: 'RequestMethod', label: 'RequestMethod', type: 'string', role: 'method' },
  { key: 'RequestPath', label: 'RequestPath', type: 'string', role: 'uri' },
  { key: 'StatusCode', label: 'StatusCode', type: 'number', role: 'status' },
  { key: 'Elapsed', label: 'Elapsed (ms)', type: 'number', role: 'duration' },
];

export function createGenericParser(): LineParser {
  let rows: LogRow[] = [];
  let malformed: MalformedRow[] = [];
  let pending: LogRow | null = null;
  let rowId = 0;
  let malformedId = 0;
  let sawLevel = false;
  let sawLogger = false;
  const seen = new Set<string>();
  const zones = new OffsetTracker();
  // Time-only lines: the date comes from outside (file modified date), and moves on a day
  // whenever the clock jumps back more than an hour (past midnight).
  let day = calendarDay(Date.now());
  let lastTimeOfDay = -1;
  const assumedDays = new Set<number>();

  function setDefaultDate(ms: number): void {
    day = calendarDay(ms);
    lastTimeOfDay = -1;
  }

  /** [timestamp text or epoch ms, zone offset, level, logger, message] for an entry line, else null. */
  function matchEntry(line: string): [number | null, number | null, string | undefined, string | undefined, string] | null {
    const m = GENERIC_LINE_RE.exec(line);
    if (m) return [parseLooseIso(m[1]!), parseZoneSuffix(m[1]!), m[2], m[3], m[4] ?? ''];
    const t = TIME_ONLY_LINE_RE.exec(line);
    if (!t || +t[1]! > 23 || +t[2]! > 59 || +t[3]! > 59) return null;
    const ms = t[4] ? Math.floor(+`0.${t[4]}` * 1000) : 0;
    const timeOfDay = ((+t[1]! * 60 + +t[2]!) * 60 + +t[3]!) * 1000 + ms;
    if (lastTimeOfDay >= 0 && timeOfDay < lastTimeOfDay - 3_600_000) day += DAY_MS;
    lastTimeOfDay = timeOfDay;
    assumedDays.add(day);
    return [day + timeOfDay, null, t[5], t[6], t[7] ?? ''];
  }

  function pushLine(line: string, lineNo: number): void {
    if (line.trim().length === 0) return;
    const m = matchEntry(line);
    if (m) {
      if (pending) rows.push(pending);
      const [ts, zone, rawLevel, rawLogger, rawMessage] = m;
      zones.observe(zone);
      const { level, logger, message, extra } = refineEntry(rawLevel, rawLogger, rawMessage);
      if (level) sawLevel = true;
      if (logger) sawLogger = true;
      const values: Record<string, CellValue> = { timestamp: ts, level, logger, message };
      for (const k in extra) {
        values[k] = extra[k]!;
        seen.add(k);
      }
      const req = SERILOG_REQUEST_RE.exec(message);
      if (req) {
        values.RequestMethod = req[1]!;
        values.RequestPath = req[2]!;
        values.StatusCode = Number(req[3]);
        values.Elapsed = Number(req[4]);
        for (const k of ['RequestMethod', 'RequestPath', 'StatusCode', 'Elapsed']) seen.add(k);
      }
      pending = { id: rowId++, lineNo, ts, values, raw: line };
      return;
    }
    if (pending) {
      // Continuation line (stack trace, wrapped message, ...).
      pending.values.message = `${pending.values.message as string}\n${line}`;
      pending.raw += `\n${line}`;
      return;
    }
    malformed.push({ id: malformedId++, lineNo, raw: line, reason: 'No timestamp and no preceding entry' });
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

  function schema(): ColumnDef[] {
    const cols: ColumnDef[] = [{ ...TIMESTAMP_COLUMN }];
    if (sawLevel) cols.push({ ...COLUMNS.level });
    if (sawLogger) cols.push({ ...COLUMNS.logger });
    for (const c of OPTIONAL_COLUMNS) if (seen.has(c.key)) cols.push({ ...c });
    cols.push({ ...COLUMNS.message });
    return cols;
  }

  function timeZone(): LogTimeZone {
    const tz = zones.result();
    if (assumedDays.size === 0) return tz;
    const days = [...assumedDays].sort((a, b) => a - b);
    const range = days.length === 1 ? isoDate(days[0]!) : `${isoDate(days[0]!)} – ${isoDate(days[days.length - 1]!)}`;
    return { ...tz, assumedDate: range };
  }

  return { format: 'generic', pushLine, drain, finish, schema, timeZone, setDefaultDate };
}
