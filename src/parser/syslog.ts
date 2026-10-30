import { parseLooseIso } from './generic';
import { TIMESTAMP_COLUMN } from './schema';
import { OffsetTracker, parseZoneSuffix, type LogTimeZone } from './timezone';
import type { CellValue, ColumnDef, LineParser, LogRow, MalformedRow, ParsedChunk } from './types';

/*
 * Syslog, as written to files by rsyslog/syslog-ng and sent by network devices:
 *   Oct 27 04:42:03 web01 sshd[1234]: Accepted publickey for deploy        (RFC 3164 / BSD)
 *   <34>Oct 27 04:42:03 web01 su: 'su root' failed on /dev/pts/8           (with priority)
 *   2026-10-27T04:42:03.120+04:00 web01 nginx[88]: worker started          (rsyslog high precision)
 *   <165>1 2026-10-27T04:42:03.120Z web01 app 123 ID47 [x@1 a="b"] message  (RFC 5424)
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** BSD syslog: no year and no zone. Groups: pri, month, day, h, m, s, fraction, host, tag, pid, message. */
export const BSD_SYSLOG_RE =
  /^(?:<(\d{1,3})>)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))? (\S+) (?:([^\s:[\]]+)(?:\[(\d+)\])?: ?)?(.*)$/;

/** ISO timestamp, then host and a "tag[pid]:" (required, so ISO-stamped app logs aren't taken for syslog). */
export const ISO_SYSLOG_RE =
  /^(?:<(\d{1,3})>)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?) (\S+) ([^\s:[\]]+)(?:\[(\d+)\])?: ?(.*)$/;

/** RFC 5424. Groups: pri, timestamp, host, app, procid, msgid, structured data, message. */
export const RFC5424_RE = /^<(\d{1,3})>1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|(?:\[(?:[^\]"\\]|\\.|"(?:[^"\\]|\\.)*")*\])+)(?: (.*))?$/;

/** Words that are log levels, not host names (rules out "2026-…T… ERROR app: …" lines). */
const LEVEL_WORD_RE = /^(trace|debug|info|information|warn|warning|error|err|fatal|critical|crit|notice|verbose)$/i;

/** Severity (priority % 8) as a level; emergency, alert and critical count as errors. */
export const SEVERITIES = ['EMERG', 'ALERT', 'CRIT', 'ERROR', 'WARN', 'NOTICE', 'INFO', 'DEBUG'];
const FACILITIES = [
  'kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news', 'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clock',
  'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7',
];

/** Whether a line looks like syslog (used by format detection). */
export function isSyslogLine(line: string): boolean {
  if (BSD_SYSLOG_RE.test(line) || RFC5424_RE.test(line)) return true;
  const m = ISO_SYSLOG_RE.exec(line);
  return !!m && !LEVEL_WORD_RE.test(m[3]!);
}

const COLUMNS: ColumnDef[] = [
  { ...TIMESTAMP_COLUMN },
  { key: 'level', label: 'level', type: 'string', role: 'level' },
  { key: 'facility', label: 'facility', type: 'string' },
  { key: 'host', label: 'host', type: 'string', role: 'host' },
  { key: 'app', label: 'app', type: 'string', role: 'logger' },
  { key: 'pid', label: 'pid', type: 'number' },
  { key: 'msgid', label: 'msgid', type: 'string' },
  { key: 'message', label: 'message', type: 'string', role: 'message' },
];

export function createSyslogParser(): LineParser {
  let rows: LogRow[] = [];
  let malformed: MalformedRow[] = [];
  let pending: LogRow | null = null;
  let rowId = 0;
  let malformedId = 0;
  const zones = new OffsetTracker();
  const seen = new Set<string>();
  // BSD lines have no year: take the file's, or the year before for months after the file's month
  // (December lines in a file written in January).
  let ref = new Date();
  const assumedYears = new Set<number>();

  function setDefaultDate(ms: number): void {
    ref = new Date(ms);
  }

  function bsdTime(m: RegExpExecArray): number {
    const month = MONTHS.indexOf(m[2]!);
    const year = month > ref.getMonth() + 1 ? ref.getFullYear() - 1 : ref.getFullYear();
    assumedYears.add(year);
    const ms = m[7] ? Math.floor(+`0.${m[7]}` * 1000) : 0;
    return Date.UTC(year, month, +m[3]!) + ((+m[4]! * 60 + +m[5]!) * 60 + +m[6]!) * 1000 + ms;
  }

  function priority(pri: string | undefined, values: Record<string, CellValue>): void {
    if (pri === undefined || +pri > 191) return;
    values.level = SEVERITIES[+pri % 8]!;
    values.facility = FACILITIES[Math.floor(+pri / 8)] ?? null;
  }

  /** Column values for an entry line, or null for a continuation / foreign line. */
  function parse(line: string): Record<string, CellValue> | null {
    const nil = (s: string | undefined) => (s === undefined || s === '-' ? null : s);
    let m = RFC5424_RE.exec(line);
    if (m) {
      const time = nil(m[2]);
      const values: Record<string, CellValue> = { timestamp: time === null ? null : parseLooseIso(time) };
      if (time !== null) zones.observe(parseZoneSuffix(time));
      priority(m[1], values);
      values.host = nil(m[3]);
      values.app = nil(m[4]);
      values.pid = nil(m[5]) !== null && Number.isFinite(+m[5]!) ? +m[5]! : null;
      values.msgid = nil(m[6]);
      const sd = m[7] === '-' ? '' : `${m[7]} `;
      values.message = (sd + (m[8] ?? '')).replace(/^﻿/, '').trim();
      return values;
    }
    m = BSD_SYSLOG_RE.exec(line);
    if (m) {
      const values: Record<string, CellValue> = { timestamp: bsdTime(m) };
      zones.observe(null);
      priority(m[1], values);
      values.host = m[8]!;
      values.app = m[9] ?? null;
      values.pid = m[10] ? +m[10] : null;
      values.message = m[11] ?? '';
      return values;
    }
    m = ISO_SYSLOG_RE.exec(line);
    if (m && !LEVEL_WORD_RE.test(m[3]!)) {
      const values: Record<string, CellValue> = { timestamp: parseLooseIso(m[2]!) };
      zones.observe(parseZoneSuffix(m[2]!));
      priority(m[1], values);
      values.host = m[3]!;
      values.app = m[4]!;
      values.pid = m[5] ? +m[5] : null;
      values.message = m[6] ?? '';
      return values;
    }
    return null;
  }

  function pushLine(line: string, lineNo: number): void {
    if (line.trim().length === 0) return;
    const values = parse(line);
    if (values) {
      if (pending) rows.push(pending);
      for (const k in values) if (values[k] !== null) seen.add(k);
      pending = { id: rowId++, lineNo, ts: values.timestamp as number | null, values, raw: line };
      return;
    }
    if (pending) {
      // Continuation line (multi-line message, stack trace).
      pending.values.message = `${pending.values.message as string}\n${line}`;
      pending.raw += `\n${line}`;
      return;
    }
    malformed.push({ id: malformedId++, lineNo, raw: line, reason: 'Not a syslog line and no preceding entry' });
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
    if (assumedYears.size === 0) return tz;
    const years = [...assumedYears].sort();
    return { ...tz, assumedDate: `year ${years.join(' – ')} (syslog lines have no year)` };
  }

  // Columns appear once some line has them (only timestamp and message always do).
  const schema = () => COLUMNS.filter((c) => c.key === 'timestamp' || c.key === 'message' || seen.has(c.key)).map((c) => ({ ...c }));

  return { format: 'syslog', pushLine, drain, finish, schema, timeZone, setDefaultDate };
}
