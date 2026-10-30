import { createParser, detectFormat, looksLikeXml, SOURCE_COLUMN } from '../parser';
import type { ColumnDef, LineParser, LogFormat, LogRow, LogTimeZone, MalformedRow } from '../parser';
import { isZipName, listZipEntries, zipEntryData, ZipError } from './unzip';

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const BATCH_ROWS = 20_000;

/** A file to parse. `.gz` files and `.zip` archives are decompressed on the fly. */
export interface LogSource {
  name: string;
  blob: Blob;
}

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
  /** `files` are the log files actually parsed (archives expanded), in parse order. */
  onStart?(format: LogFormat, detected: LogFormat, files: string[]): void;
  onBatch(batch: StreamBatch): void;
  onProgress?(bytesRead: number, totalBytes: number, lines: number): void;
  isCancelled?(): boolean;
}

export interface StreamParseSummary {
  format: LogFormat;
  detected: LogFormat;
  schema: ColumnDef[];
  files: string[];
  lines: number;
  rows: number;
  malformed: number;
  timeZone: LogTimeZone;
}

export class ParseError extends Error {}
export class CancelledError extends Error {}

/** Accepted inside archives. */
const LOG_NAME_RE = /\.(log|txt|json|jsonl|ndjson|clef|xml|csv|tsv)$/i;
const GZIP_RE = /\.gz$/i;

/** A whole JSON document (not JSON lines) is parsed in memory, so it is capped. */
export const MAX_JSON_DOCUMENT_CHARS = 256 * 1024 * 1024;

/**
 * Whether text is one JSON document ("[ {...}, ... ]", or a pretty-printed object) rather than
 * lines: a leading "[", or a leading "{" whose first line is not a complete object. null = can't
 * tell yet (first line not complete and more text may follow).
 */
export function isJsonDocument(text: string, final: boolean): boolean | null {
  const i = text.search(/\S/);
  if (i < 0) return final ? false : null;
  if (text[i] === '[') return true;
  if (text[i] !== '{') return false;
  const nl = text.indexOf('\n', i);
  if (nl < 0 && !final) return null;
  try {
    const first: unknown = JSON.parse(text.slice(i, nl < 0 ? undefined : nl));
    return !(first !== null && typeof first === 'object' && !Array.isArray(first));
  } catch {
    return true;
  }
}

/**
 * The log entries in a parsed JSON document: the array itself, or the first array of objects
 * found directly under an object ({"logs": [...]}, {"value": [...]}); otherwise the object alone.
 */
export function jsonDocumentRecords(doc: unknown): unknown[] {
  if (Array.isArray(doc)) return doc;
  if (doc !== null && typeof doc === 'object') {
    for (const v of Object.values(doc)) {
      if (Array.isArray(v) && v.length > 0 && v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))) {
        return v;
      }
    }
  }
  return [doc];
}

/** Natural order, so u_ex26102709.log sorts before u_ex26102710.log and file2 before file10. */
export const compareNames = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

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

/** `consumed` is how many bytes of the original (possibly compressed) source this chunk accounts for. */
interface Chunk {
  bytes: Uint8Array;
  consumed: number;
}

interface Input {
  name: string;
  /** Modified time of the file (or the archive it came from); dates time-only log lines. */
  modified: number;
  chunks(): AsyncGenerator<Chunk>;
}

async function* sliceChunks(blob: Blob, chunkBytes: number): AsyncGenerator<Chunk> {
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, blob.size);
    yield { bytes: new Uint8Array(await blob.slice(offset, end).arrayBuffer()), consumed: end - offset };
  }
}

async function* decompressChunks(name: string, compressed: Blob, format: CompressionFormat): AsyncGenerator<Chunk> {
  let read = 0;
  let reported = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      read += chunk.byteLength;
      ctl.enqueue(chunk);
    },
  });
  const reader = compressed
    .stream()
    .pipeThrough(counter)
    .pipeThrough(new DecompressionStream(format) as unknown as TransformStream<Uint8Array, Uint8Array>)
    .getReader();
  let done = false;
  try {
    for (;;) {
      let res: ReadableStreamReadResult<Uint8Array>;
      try {
        res = await reader.read();
      } catch (e) {
        throw new ParseError(`Could not decompress "${name}": ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.done) break;
      yield { bytes: res.value, consumed: read - reported };
      reported = read;
    }
    done = true;
  } finally {
    // Stop decompressing if the consumer bailed out early (cancel, error).
    if (!done) void reader.cancel().catch(() => {});
  }
  if (read > reported) yield { bytes: new Uint8Array(0), consumed: read - reported };
}

/** Expand archives and compressed files into the plain-text inputs to parse, in natural name order. */
async function expandSources(sources: LogSource[], chunkBytes: number): Promise<Input[]> {
  const inputs: Input[] = [];
  for (const s of [...sources].sort((a, b) => compareNames(a.name, b.name))) {
    // Files have a modified time; pasted text (a plain Blob) is dated now.
    const modified = (s.blob as Partial<File>).lastModified ?? Date.now();
    if (isZipName(s.name)) {
      let entries;
      try {
        entries = (await listZipEntries(s.blob)).filter((e) => LOG_NAME_RE.test(e.name));
      } catch (e) {
        throw new ParseError(`"${s.name}": ${e instanceof ZipError ? e.message : String(e)}`);
      }
      if (entries.length === 0) throw new ParseError(`"${s.name}" contains no log files (.log, .txt, .json, .xml or .csv).`);
      entries.sort((a, b) => compareNames(a.name, b.name));
      for (const entry of entries) {
        const data = await zipEntryData(s.blob, entry).catch((e: unknown) => {
          throw new ParseError(`"${s.name}": ${e instanceof Error ? e.message : String(e)}`);
        });
        inputs.push({
          name: entry.name,
          modified,
          chunks: () =>
            entry.method === 8 ? decompressChunks(entry.name, data, 'deflate-raw') : sliceChunks(data, chunkBytes),
        });
      }
    } else if (GZIP_RE.test(s.name)) {
      inputs.push({ name: s.name.replace(GZIP_RE, ''), modified, chunks: () => decompressChunks(s.name, s.blob, 'gzip') });
    } else {
      inputs.push({ name: s.name, modified, chunks: () => sliceChunks(s.blob, chunkBytes) });
    }
  }
  return inputs;
}

/** Parse a single Blob (kept for callers and tests that deal with one plain file). */
export function streamParse(blob: Blob, opts: StreamParseOptions): Promise<StreamParseSummary> {
  return streamParseSources([{ name: 'input.log', blob }], opts);
}

/**
 * Read files chunk by chunk, decode incrementally, split into lines and feed
 * one format parser, emitting rows in batches. Several files are parsed in
 * natural name order into one result; each row then gets a `sourceFile` value
 * and line numbers restart per file. Runs in the worker, but has no
 * worker-specific dependencies so it is unit-testable in Node.
 */
export async function streamParseSources(sources: LogSource[], opts: StreamParseOptions): Promise<StreamParseSummary> {
  const totalBytes = sources.reduce((sum, s) => sum + s.blob.size, 0);
  if (totalBytes === 0) throw new ParseError(sources.length > 1 ? 'The files are empty.' : 'The file is empty.');
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const batchRows = opts.batchRows ?? BATCH_ROWS;

  const inputs = await expandSources(sources, chunkBytes);
  const files = inputs.map((i) => i.name);
  const multi = inputs.length > 1;

  let parser: LineParser | null = null;
  let format: LogFormat = 'generic';
  let detected: LogFormat = 'generic';
  let current = '';
  let bytesRead = 0;
  let reportedBytes = 0;
  let lines = 0;
  let pending = 0;
  let totalRows = 0;
  let totalMalformed = 0;

  const schema = () => (multi ? [...parser!.schema(), SOURCE_COLUMN] : parser!.schema());

  const emit = (final: boolean) => {
    if (!parser) return;
    const chunk = final ? parser.finish() : parser.drain();
    pending = 0;
    if (chunk.rows.length === 0 && chunk.malformed.length === 0 && chunk.meta.length === 0) return;
    if (multi) {
      for (const r of chunk.rows) r.values.sourceFile = current;
      for (const m of chunk.malformed) m.file = current;
    }
    totalRows += chunk.rows.length;
    totalMalformed += chunk.malformed.length;
    opts.onBatch({ ...chunk, schema: schema() });
  };

  const progress = (force: boolean) => {
    if (!opts.onProgress || (!force && bytesRead - reportedBytes < Math.min(chunkBytes, 1 << 20))) return;
    reportedBytes = bytesRead;
    opts.onProgress(bytesRead, totalBytes, lines);
  };

  for (const input of inputs) {
    current = input.name;
    // Later files reuse the parser (created on the first lines); tell it this file's date.
    (parser as LineParser | null)?.setDefaultDate?.(input.modified);
    const decoder = new TextDecoder('utf-8');
    let carry = '';
    let started = false;
    let lineNo = 0;
    let sinceEmit = 0;

    const checkStart = (text: string): string => {
      if (started || text.length === 0) return text;
      started = true;
      if (looksBinary(text)) {
        throw new ParseError(
          multi
            ? `"${input.name}" does not look like a text log (binary content detected).`
            : 'This file does not look like a text log (binary content detected).',
        );
      }
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    };

    const feedLines = (ls: string[], guess: () => LogFormat) => {
      if (!parser) {
        detected = guess();
        format = opts.format ?? detected;
        parser = createParser(format);
        parser.setDefaultDate?.(input.modified);
        opts.onStart?.(format, detected, files);
      }
      for (let i = 0; i < ls.length; i++) {
        let l = ls[i]!;
        if (l.charCodeAt(l.length - 1) === 13) l = l.slice(0, -1);
        lineNo++;
        lines++;
        parser.pushLine(l, lineNo);
        if (++pending >= batchRows) emit(false);
      }
    };
    const feed = (complete: string) => {
      const ls = complete.split('\n');
      feedLines(ls, () => {
        const sample = ls.slice(0, 200);
        const guess = detectFormat(sample);
        // Read as plain text, other XML would only produce noise.
        if (guess !== 'freb' && guess !== 'winevent' && !opts.format && looksLikeXml(sample)) {
          throw new ParseError(
            `${multi ? `"${input.name}"` : 'This file'} is XML, but neither an IIS failed request trace (fr*.xml) ` +
              'nor a Windows Event Log export, the XML formats Logsift reads.',
          );
        }
        return guess;
      });
    };
    // A JSON document: each entry becomes one JSON line ("line" numbers count entries).
    // Text that isn't valid JSON after all is read line by line instead.
    const feedDocument = (text: string) => {
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        return feed(text);
      }
      feedLines(
        jsonDocumentRecords(doc).map((r) => JSON.stringify(r) ?? 'null'),
        () => 'jsonl',
      );
    };

    // Decided from the first text: line-by-line (streamed) or one JSON document (read whole).
    let documentMode: boolean | null = null;
    const docParts: string[] = [];
    let docChars = 0;
    const addDocText = (t: string) => {
      docParts.push(t);
      docChars += t.length;
      if (docChars > MAX_JSON_DOCUMENT_CHARS) {
        throw new ParseError(
          `"${input.name}" is a single JSON document larger than ${MAX_JSON_DOCUMENT_CHARS / 1024 / 1024} MB, ` +
            'which is too big to open. Save it as JSON lines (one object per line) instead.',
        );
      }
    };

    for await (const { bytes, consumed } of input.chunks()) {
      if (opts.isCancelled?.()) throw new CancelledError('Cancelled');
      bytesRead += consumed;
      const text = carry + checkStart(decoder.decode(bytes, { stream: true }));
      carry = '';
      if (documentMode === null) documentMode = isJsonDocument(text, false);
      if (documentMode === null) {
        carry = text;
      } else if (documentMode) {
        addDocText(text);
      } else {
        const nl = text.lastIndexOf('\n');
        if (nl < 0) {
          carry = text;
        } else {
          feed(text.slice(0, nl));
          carry = text.slice(nl + 1);
          sinceEmit += nl;
          if (sinceEmit >= chunkBytes) {
            emit(false);
            sinceEmit = 0;
          }
        }
      }
      progress(false);
    }
    const rest = carry + checkStart(decoder.decode());
    if (documentMode === null) documentMode = isJsonDocument(rest, true);
    if (documentMode) {
      addDocText(rest);
      feedDocument(docParts.join(''));
    } else if (started) {
      feed(rest);
    }
    emit(true);
    progress(true);
  }

  if (!parser) throw new ParseError(multi ? 'The files are empty.' : 'The file is empty.');
  if (totalRows === 0 && totalMalformed === 0) {
    throw new ParseError(multi ? 'No log entries were found in these files.' : 'No log entries were found in this file.');
  }
  const p = parser as LineParser;
  return {
    format,
    detected,
    schema: schema(),
    files,
    lines,
    rows: totalRows,
    malformed: totalMalformed,
    timeZone: p.timeZone(),
  };
}
