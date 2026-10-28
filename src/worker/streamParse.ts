import { createParser, detectFormat } from '../parser';
import type { ColumnDef, LineParser, LogFormat, LogRow, LogTimeZone, MalformedRow } from '../parser';

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const BATCH_ROWS = 20_000;

export interface StreamBatch {
  rows: LogRow[];
  malformed: MalformedRow[];
  meta: string[];
  schema: ColumnDef[];
}

export interface StreamParseOptions {
  /** Force a format instead of auto-detecting. */
  format?: LogFormat;
  chunkBytes?: number;
  batchRows?: number;
  onStart?(format: LogFormat, detected: LogFormat): void;
  onBatch(batch: StreamBatch): void;
  onProgress?(bytesRead: number, totalBytes: number, lines: number): void;
  isCancelled?(): boolean;
}

export interface StreamParseSummary {
  format: LogFormat;
  detected: LogFormat;
  schema: ColumnDef[];
  lines: number;
  rows: number;
  malformed: number;
  timeZone: LogTimeZone;
}

export class ParseError extends Error {}
export class CancelledError extends Error {}

/** Heuristic: lots of NULs or U+FFFD replacement chars means this is not a text log. */
function looksBinary(text: string): boolean {
  const n = Math.min(text.length, 8192);
  if (n === 0) return false;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 0 || c === 0xfffd) bad++;
  }
  return bad / n > 0.05;
}

/**
 * Read a Blob in slices, decode incrementally, split into lines and feed the
 * format parser, emitting rows in batches. Runs in the worker, but has no
 * worker-specific dependencies so it is unit-testable in Node.
 */
export async function streamParse(blob: Blob, opts: StreamParseOptions): Promise<StreamParseSummary> {
  if (blob.size === 0) throw new ParseError('The file is empty.');
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const batchRows = opts.batchRows ?? BATCH_ROWS;
  const decoder = new TextDecoder('utf-8');

  let parser: LineParser | null = null;
  let format: LogFormat = 'generic';
  let detected: LogFormat = 'generic';
  let offset = 0;
  let carry = '';
  let lineNo = 0;
  let pending = 0;
  let totalRows = 0;
  let totalMalformed = 0;

  const emit = (final: boolean) => {
    if (!parser) return;
    const chunk = final ? parser.finish() : parser.drain();
    pending = 0;
    if (chunk.rows.length === 0 && chunk.malformed.length === 0 && chunk.meta.length === 0) return;
    totalRows += chunk.rows.length;
    totalMalformed += chunk.malformed.length;
    opts.onBatch({ ...chunk, schema: parser.schema() });
  };

  while (offset < blob.size) {
    if (opts.isCancelled?.()) throw new CancelledError('Cancelled');
    const end = Math.min(offset + chunkBytes, blob.size);
    const buf = await blob.slice(offset, end).arrayBuffer();
    const isFirst = offset === 0;
    offset = end;
    const last = offset >= blob.size;
    let text = carry + decoder.decode(buf, { stream: !last });
    if (isFirst) {
      if (looksBinary(text)) throw new ParseError('This file does not look like a text log (binary content detected).');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }

    let complete: string;
    if (last) {
      complete = text;
      carry = '';
    } else {
      const nl = text.lastIndexOf('\n');
      if (nl < 0) {
        carry = text;
        continue;
      }
      complete = text.slice(0, nl);
      carry = text.slice(nl + 1);
    }

    const lines = complete.split('\n');
    if (!parser) {
      detected = detectFormat(lines.slice(0, 200));
      format = opts.format ?? detected;
      parser = createParser(format);
      opts.onStart?.(format, detected);
    }
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i]!;
      if (l.charCodeAt(l.length - 1) === 13) l = l.slice(0, -1);
      lineNo++;
      parser.pushLine(l, lineNo);
      if (++pending >= batchRows) emit(false);
    }
    emit(false);
    opts.onProgress?.(offset, blob.size, lineNo);
  }

  emit(true);
  if (!parser) throw new ParseError('The file is empty.');
  if (totalRows === 0 && totalMalformed === 0) throw new ParseError('No log entries were found in this file.');
  return { format, detected, schema: parser.schema(), lines: lineNo, rows: totalRows, malformed: totalMalformed, timeZone: parser.timeZone() };
}
