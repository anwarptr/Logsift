import { TIMESTAMP_COLUMN } from './schema';
import { OffsetTracker, parseZoneSuffix } from './timezone';
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

const COLUMNS = {
  level: { key: 'level', label: 'level', type: 'string', role: 'level' } as ColumnDef,
  logger: { key: 'logger', label: 'logger', type: 'string', role: 'logger' } as ColumnDef,
  message: { key: 'message', label: 'message', type: 'string', role: 'message' } as ColumnDef,
};

export function createGenericParser(): LineParser {
  let rows: LogRow[] = [];
  let malformed: MalformedRow[] = [];
  let pending: LogRow | null = null;
  let rowId = 0;
  let malformedId = 0;
  let sawLevel = false;
  let sawLogger = false;
  const zones = new OffsetTracker();

  function pushLine(line: string, lineNo: number): void {
    if (line.trim().length === 0) return;
    const m = GENERIC_LINE_RE.exec(line);
    if (m) {
      if (pending) rows.push(pending);
      const ts = parseLooseIso(m[1]!);
      zones.observe(parseZoneSuffix(m[1]!));
      const level = m[2] ? normalizeLevel(m[2]) : null;
      const logger = m[3] ?? null;
      if (level) sawLevel = true;
      if (logger) sawLogger = true;
      const values: Record<string, CellValue> = { timestamp: ts, level, logger, message: m[4] ?? '' };
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
    cols.push({ ...COLUMNS.message });
    return cols;
  }

  return { format: 'generic', pushLine, drain, finish, schema, timeZone: () => zones.result() };
}
