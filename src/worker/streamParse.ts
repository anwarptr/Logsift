import { createParser, detectFormat, looksLikeXml, SOURCE_COLUMN } from '../parser';
import type { ColumnDef, LineParser, LogFormat, LogRow, LogTimeZone, MalformedRow, ParsedChunk } from '../parser';
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
  /** Layout for the 'custom' format. */
  pattern?: string;
  chunkBytes?: number;
  batchRows?: number;
  /** `files` are the log files actually parsed (archives expanded), in parse order. */
  onStart?(format: LogFormat, detected: LogFormat, files: string[]): void;
  onBatch(batch: StreamBatch): void;
  onProgress?(bytesRead: number, totalBytes: number, lines: number): void;
  isCancelled?(): boolean;
  /** Keep the parser for `appendToSession`, and hold back each plain file's unfinished last line. */
  live?: boolean;
  /** Give rows a `sourceFile` value even for one file (a folder may get more files later). */
  multi?: boolean;
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
  /** Live: bytes of each file's unfinished last line, not read yet (by file name). */
  held?: Record<string, number>;
  session?: LiveSession;
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

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be';

/**
 * The encoding of log bytes: UTF-8 unless there is a UTF-16 byte order mark, or the bytes look like
 * UTF-16 without one (every other byte zero, as ASCII text written by Windows PowerShell's `>>` or
 * `Out-File`, or by .NET's Encoding.Unicode). Null when there are too few bytes to tell.
 */
export function sniffEncoding(bytes: Uint8Array): TextEncodingName | null {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  }
  const n = Math.min(bytes.length, 1024) & ~1;
  if (n < 4) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZero++;
    if (bytes[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (oddZero / pairs > 0.3 && evenZero / pairs < 0.05) return 'utf-16le';
  if (evenZero / pairs > 0.3 && oddZero / pairs < 0.05) return 'utf-16be';
  return 'utf-8';
}

/** Bytes of `s` in `encoding`. */
const byteLength = (s: string, encoding: TextEncodingName) =>
  encoding === 'utf-8' ? new TextEncoder().encode(s).length : s.length * 2;

/** End (exclusive) of the last complete line in `bytes`, or 0 when there is none. */
function lastLineEnd(bytes: Uint8Array, encoding: TextEncodingName): number {
  if (encoding === 'utf-8') return bytes.lastIndexOf(10) + 1;
  for (let i = (bytes.length - 2) & ~1; i >= 0; i -= 2) {
    if (encoding === 'utf-16le' ? bytes[i] === 10 && bytes[i + 1] === 0 : bytes[i] === 0 && bytes[i + 1] === 10) return i + 2;
  }
  return 0;
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
  /** Read as is (not from an archive or .gz), so bytes appended to it later can be read too. */
  plain?: boolean;
  chunks(): AsyncGenerator<Chunk>;
}

async function* sliceChunks(blob: Blob, chunkBytes: number): AsyncGenerator<Chunk> {
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, blob.size);
    yield { bytes: new Uint8Array(await blob.slice(offset, end).arrayBuffer()), consumed: end - offset };
  }
}

/**
 * Most text one compressed file may unpack to. A tiny "zip bomb" can unpack to many gigabytes; the tab
 * would run out of memory long before, so stop with a message instead.
 */
export const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;

export async function* decompressChunks(
  name: string,
  compressed: Blob,
  format: CompressionFormat,
  maxUnpacked = MAX_UNPACKED_BYTES,
): AsyncGenerator<Chunk> {
  let read = 0;
  let reported = 0;
  let unpacked = 0;
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
      unpacked += res.value.byteLength;
      if (unpacked > maxUnpacked) {
        throw new ParseError(`"${name}" unpacks to more than ${Math.round(maxUnpacked / 1024 ** 3)} GB of text, more than Logsift can hold. Unpack it and open part of it.`);
      }
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
      inputs.push({ name: s.name, modified, plain: true, chunks: () => sliceChunks(s.blob, chunkBytes) });
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
  const multi = opts.multi ?? inputs.length > 1;
  const held: Record<string, number> = {};
  const lineNos = new Map<string, number>();
  const fileStates = new Map<string, unknown>();
  const encodings = new Map<string, TextEncodingName>();

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
    // Chosen from the file's first bytes (UTF-8, or UTF-16 from Windows tools).
    let encoding: TextEncodingName = 'utf-8';
    let decoder: TextDecoder | null = null;
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
        parser = createParser(format, opts.pattern);
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
      if (!decoder) {
        encoding = sniffEncoding(bytes) ?? 'utf-8';
        decoder = new TextDecoder(encoding);
      }
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
    const rest = carry + checkStart(decoder?.decode() ?? '');
    if (documentMode === null) documentMode = isJsonDocument(rest, true);
    if (documentMode) {
      addDocText(rest);
      feedDocument(docParts.join(''));
    } else if (started) {
      // Live: an unfinished last line is still being written; it is read with the next append.
      // (Nothing after the final newline is not a line, so it isn't counted either.)
      if (opts.live && input.plain && rest !== '' && parser) held[input.name] = byteLength(rest, encoding);
      else if (rest !== '' || !parser) feed(rest);
    }
    // Before finish(), which resets it for the next file.
    if (opts.live) {
      fileStates.set(input.name, (parser as LineParser | null)?.fileState?.());
      encodings.set(input.name, encoding);
    }
    emit(true);
    progress(true);
    lineNos.set(input.name, lineNo);
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
    ...(opts.live ? { held, session: { parser: p, multi, lineNos, fileStates, encodings, openFile: null } } : {}),
  };
}


/** The state kept after a live parse, so lines appended to the files later continue the same log. */
export interface LiveSession {
  parser: LineParser;
  /** Rows get a `sourceFile` value (several files, or a folder). */
  multi: boolean;
  /** Lines read so far per file, to number appended lines. */
  lineNos: Map<string, number>;
  /** Each file's parser state (CSV header, IIS #Fields), as `LineParser.fileState` gave it. */
  fileStates: Map<string, unknown>;
  /** Each file's text encoding, as detected when it was first read. */
  encodings: Map<string, TextEncodingName>;
  /** The file whose last entry is still open (more lines of it may follow), or null. */
  openFile: string | null;
}

/**
 * Parse bytes appended to a file (or a new file) of a live session. Only complete lines are read:
 * returns how many bytes were consumed (up to and including the last newline); the rest is read again
 * with the next append. The file's last entry stays open, so a stack trace written a moment after its
 * line still joins it; it is closed when another file is read or with `final`, which the watcher sends
 * once the file stops growing: `'lines'` closes the entry and leaves an unfinished last line for later
 * (an editor may be in the middle of it), `true` (once the file has been quiet for a while) reads
 * every byte, that line included. `modified` dates time-only lines in a file seen for the first time.
 */
export function appendToSession(
  session: LiveSession,
  name: string,
  bytes: Uint8Array,
  modified: number,
  onBatch: (batch: StreamBatch) => void,
  final: boolean | 'lines' = false,
): { consumed: number; timeZone: LogTimeZone } {
  const { parser } = session;
  const schema = () => (session.multi ? [...parser.schema(), SOURCE_COLUMN] : parser.schema());
  const emit = (file: string, chunk: ParsedChunk) => {
    if (session.multi) {
      for (const r of chunk.rows) r.values.sourceFile = file;
      for (const m of chunk.malformed) m.file = file;
    }
    if (chunk.rows.length || chunk.malformed.length || chunk.meta.length) onBatch({ ...chunk, schema: schema() });
  };
  /** Close the open file's last entry, keeping its state for later lines. */
  const close = (file: string) => {
    session.fileStates.set(file, parser.fileState?.());
    emit(file, parser.finish());
    session.openFile = null;
  };

  // Usually the file's encoding; text appended in another one (UTF-16 from PowerShell's `>>` to a
  // UTF-8 log) is recognised by its own bytes.
  const encoding = sniffEncoding(bytes) ?? session.encodings.get(name) ?? 'utf-8';
  if (!session.encodings.has(name)) session.encodings.set(name, encoding);
  const end = final === true ? bytes.length : lastLineEnd(bytes, encoding);
  if (end === 0 && !final) return { consumed: 0, timeZone: parser.timeZone() };
  if (session.openFile !== null && session.openFile !== name) close(session.openFile);
  let lineNo = session.lineNos.get(name);
  if (session.openFile !== name) {
    if (lineNo === undefined) parser.setDefaultDate?.(modified);
    parser.restoreFileState?.(session.fileStates.get(name));
  }
  lineNo ??= 0;
  if (end > 0) {
    let text = new TextDecoder(encoding).decode(bytes.subarray(0, end));
    if (text.endsWith('\n')) text = text.slice(0, -1);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    for (const raw of text.split('\n')) {
      const l = raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw;
      parser.pushLine(l, ++lineNo);
    }
  }
  session.lineNos.set(name, lineNo);
  if (final) {
    close(name);
  } else {
    session.fileStates.set(name, parser.fileState?.());
    session.openFile = name;
    emit(name, parser.drain());
  }
  return { consumed: end, timeZone: parser.timeZone() };
}
