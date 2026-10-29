import { createApacheParser } from './apache';
import { detectFormat } from './detectFormat';
import { createGenericParser } from './generic';
import { createIisParser } from './iis';
import { createJsonlParser } from './jsonl';
import type { LineParser, LogFormat, LogRow, MalformedRow, ParseResult } from './types';

export * from './types';
export { detectFormat } from './detectFormat';
export { SOURCE_COLUMN } from './schema';
export { IIS_TIME_ZONE, OffsetTracker, parseZoneSuffix } from './timezone';

export function createParser(format: LogFormat): LineParser {
  switch (format) {
    case 'iis':
      return createIisParser();
    case 'apache':
      return createApacheParser();
    case 'jsonl':
      return createJsonlParser();
    case 'generic':
      return createGenericParser();
  }
}

/** Split text into lines, tolerating CRLF and a leading BOM. */
export function splitLines(text: string): string[] {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = t.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.charCodeAt(l.length - 1) === 13) lines[i] = l.slice(0, -1);
  }
  return lines;
}

/**
 * Parse a whole text in one go (used by tests and the benchmark; the worker streams instead).
 * `defaultDate` dates lines that carry only a time of day (default: today).
 */
export function parseText(text: string, format?: LogFormat, defaultDate?: number): ParseResult {
  const lines = splitLines(text);
  const fmt = format ?? detectFormat(lines.slice(0, 200));
  const parser = createParser(fmt);
  if (defaultDate !== undefined) parser.setDefaultDate?.(defaultDate);
  const rows: LogRow[] = [];
  const malformed: MalformedRow[] = [];
  const meta: string[] = [];
  for (let i = 0; i < lines.length; i++) parser.pushLine(lines[i]!, i + 1);
  const chunk = parser.finish();
  for (const r of chunk.rows) rows.push(r);
  for (const m of chunk.malformed) malformed.push(m);
  for (const m of chunk.meta) meta.push(m);
  return { format: fmt, rows, malformed, meta, schema: parser.schema(), timeZone: parser.timeZone() };
}
