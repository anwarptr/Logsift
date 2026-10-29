import { TIMESTAMP_COLUMN } from './schema';
import { OffsetTracker, parseZoneSuffix, type LogTimeZone } from './timezone';
import type { CellValue, ColumnDef, LineParser, LogRow, MalformedRow, ParsedChunk } from './types';

/**
 * Leading ISO-like timestamp, optional level, optional [logger], then the message.
 * Examples:
 *   2026-10-27 04:42:02.120 INFO  [Startup] Application starting
 *   2026-10-27T04:42:03Z WARN [Db] Pool nearly exhausted
 *   [2026-10-27 04:42:03,120] ERROR: something broke
 */
export const GENERIC_LINE_RE =
  /^\s*\[?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?: ?(?:Z|[+-]\d{2}:?\d{2}))?)\]?[\s|:-]*(?:\[?(TRACE|DEBUG|INFORMATION|INFO|WARNING|WARN|ERROR|ERR|FATAL|CRITICAL|CRIT|VERBOSE|VRB|DBG|INF|WRN|ERR|FTL)\]?(?![A-Za-z]))?[\s|:-]*(?:\[([^\]]{1,120})\])?[\s:-]*(.*)$/i;

/**
 * Time of day without a date, then a level (required, so ordinary text starting with a time
 * isn't taken for an entry). Serilog's console default is "[HH:mm:ss INF] message":
 *   [11:54:02 INF] Now listening on: http://localhost:5100
 *   11:54:02.120 WARN [Db] Pool nearly exhausted
 */
export const TIME_ONLY_LINE_RE =
  /^\s*\[?(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,9}))?[\s|:-]+\[?(TRACE|DEBUG|INFORMATION|INFO|WARNING|WARN|ERROR|ERR|FATAL|CRITICAL|CRIT|VERBOSE|VRB|DBG|INF|WRN|FTL)\]?(?![A-Za-z])[\s|:-]*(?:\[([^\]]{1,120})\])?[\s:-]*(.*)$/i;

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
  let iso = s.replace(' ', 'T').replace(',', '.');
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

const COLUMNS = {
  level: { key: 'level', label: 'level', type: 'string', role: 'level' } as ColumnDef,
  logger: { key: 'logger', label: 'logger', type: 'string', role: 'logger' } as ColumnDef,
  message: { key: 'message', label: 'message', type: 'string', role: 'message' } as ColumnDef,
};

// Named after the Serilog properties they come from.
const REQUEST_COLUMNS: ColumnDef[] = [
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
  let sawRequest = false;
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
      const [ts, zone, rawLevel, rawLogger, message] = m;
      zones.observe(zone);
      const level = rawLevel ? normalizeLevel(rawLevel) : null;
      const logger = rawLogger ?? null;
      if (level) sawLevel = true;
      if (logger) sawLogger = true;
      const values: Record<string, CellValue> = { timestamp: ts, level, logger, message };
      const req = SERILOG_REQUEST_RE.exec(message);
      if (req) {
        sawRequest = true;
        values.RequestMethod = req[1]!;
        values.RequestPath = req[2]!;
        values.StatusCode = Number(req[3]);
        values.Elapsed = Number(req[4]);
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
    if (sawRequest) for (const c of REQUEST_COLUMNS) cols.push({ ...c });
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
