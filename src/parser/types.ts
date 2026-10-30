import type { LogTimeZone } from './timezone';

export type { LogTimeZone } from './timezone';

export type LogFormat = 'iis' | 'freb' | 'winevent' | 'apache' | 'jsonl' | 'syslog' | 'csv' | 'generic';

export const FORMAT_LABELS: Record<LogFormat, string> = {
  iis: 'IIS W3C Extended',
  freb: 'IIS failed request trace',
  winevent: 'Windows Event Log (XML)',
  apache: 'Apache/Nginx combined',
  jsonl: 'JSON lines',
  syslog: 'Syslog',
  csv: 'CSV / TSV',
  generic: 'Generic text',
};

export type CellValue = string | number | boolean | null;

export type ColumnType = 'string' | 'number' | 'timestamp' | 'boolean';

/**
 * Semantic role of a column. Filters, insights and cell rendering key off roles
 * rather than IIS-specific column names, so every format gets the same features
 * when it has an equivalent column.
 */
export type ColumnRole =
  | 'timestamp'
  | 'status'
  | 'level'
  | 'duration'
  | 'uri'
  | 'uriQuery'
  | 'clientIp'
  | 'bytesSent'
  | 'bytesReceived'
  | 'method'
  | 'host'
  | 'site'
  | 'userAgent'
  | 'message'
  | 'logger'
  | 'healthCheck'
  | 'scm'
  /** Which file a row came from, when several files are opened together. */
  | 'source';

export interface ColumnDef {
  key: string;
  label: string;
  type: ColumnType;
  role?: ColumnRole;
  /** Computed by the parser rather than read from the file. */
  derived?: boolean;
}

export interface LogRow {
  /** Index of the row in the rows array (assigned sequentially by the parser). */
  id: number;
  /** 1-based line number in the source file. */
  lineNo: number;
  /** Epoch milliseconds (UTC), or null if the row has no timestamp. */
  ts: number | null;
  values: Record<string, CellValue>;
  /**
   * Original line(s) exactly as they appeared in the file; for an IIS failed request trace,
   * the request's event timeline as readable text.
   */
  raw: string;
}

export interface MalformedRow {
  id: number;
  lineNo: number;
  raw: string;
  reason: string;
  /** Source file name, when several files are opened together. */
  file?: string;
}

export interface ParsedChunk {
  rows: LogRow[];
  malformed: MalformedRow[];
  meta: string[];
}

export interface LineParser {
  readonly format: LogFormat;
  /** Feed one line (without its line terminator). */
  pushLine(line: string, lineNo: number): void;
  /** Return everything completed since the last drain. */
  drain(): ParsedChunk;
  /** Flush pending state at end of input and return the remainder. */
  finish(): ParsedChunk;
  /** Current schema: union of every column seen so far, in first-seen order. */
  schema(): ColumnDef[];
  /** Time zone the timestamps were written in, as far as the lines seen so far tell. */
  timeZone(): LogTimeZone;
  /**
   * Date to use for lines that carry only a time of day (e.g. the file's modified time).
   * Called before each file; parsers whose lines always have a date ignore it.
   */
  setDefaultDate?(ms: number): void;
}

export interface ParseResult {
  format: LogFormat;
  rows: LogRow[];
  malformed: MalformedRow[];
  meta: string[];
  schema: ColumnDef[];
  timeZone: LogTimeZone;
}
