import { readFileSync } from 'node:fs';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseText, type LogRow } from '../../src/parser';
import { mergeByTime } from '../../src/store/logStore';
import { ParseError, streamParseSources, type LogSource, type StreamBatch } from '../../src/worker/streamParse';

const sample = readFileSync('fixtures/sample-iis.log', 'utf8');

const HEADER = '#Software: Microsoft Internet Information Services 10.0\n#Fields: date time cs-method cs-uri-stem sc-status time-taken\n';
const iis = (lines: string[]) => HEADER + lines.join('\n') + '\n';

async function run(sources: LogSource[], chunkBytes = 64) {
  const batches: StreamBatch[] = [];
  const summary = await streamParseSources(sources, { chunkBytes, batchRows: 3, onBatch: (b) => batches.push(b) });
  const rows = batches.flatMap((b) => b.rows);
  return { summary, rows, malformed: batches.flatMap((b) => b.malformed), schema: batches.at(-1)!.schema };
}

/** Minimal ZIP writer for tests: entries are stored (method 0) or deflated (method 8). */
function makeZip(entries: { name: string; data: string; deflate?: boolean }[]): Blob {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = Buffer.from(e.data);
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(e.deflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc32(raw), 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Blob([...parts, ...central, eocd]);
}

const day1 = iis(['2026-10-27 10:00:00 GET /a 200 5', '2026-10-27 10:00:05 GET /b 500 7']);
const day2 = iis(['2026-10-28 09:00:00 GET /c 404 3']);

describe('several files', () => {
  it('parses files in natural name order with a source file column and per-file line numbers', async () => {
    const { summary, rows, schema } = await run([
      { name: 'u_ex26102810.log', blob: new Blob([day2]) },
      { name: 'u_ex2610279.log', blob: new Blob([day1]) },
    ]);
    expect(summary.files).toEqual(['u_ex2610279.log', 'u_ex26102810.log']);
    expect(rows.map((r) => [r.values['cs-uri-stem'], r.values.sourceFile, r.lineNo])).toEqual([
      ['/a', 'u_ex2610279.log', 3],
      ['/b', 'u_ex2610279.log', 4],
      ['/c', 'u_ex26102810.log', 3],
    ]);
    expect(rows.map((r) => r.id)).toEqual([0, 1, 2]);
    expect(schema.find((c) => c.key === 'sourceFile')).toMatchObject({ role: 'source', derived: true });
  });

  it('tags malformed lines with their file', async () => {
    const { malformed } = await run([
      { name: 'a.log', blob: new Blob([day1]) },
      { name: 'b.log', blob: new Blob([HEADER + 'broken line\n']) },
    ]);
    expect(malformed).toMatchObject([{ file: 'b.log', lineNo: 3 }]);
  });

  it('a single file gets no source column', async () => {
    const { schema, rows } = await run([{ name: 'a.log', blob: new Blob([day1]) }]);
    expect(schema.some((c) => c.key === 'sourceFile')).toBe(false);
    expect(rows[0]!.values).not.toHaveProperty('sourceFile');
  });

  it('does not carry a multi-line entry across a file boundary', async () => {
    const { rows } = await run([
      { name: '1.log', blob: new Blob(['2026-01-01 00:00:00 ERROR boom\n  at a()\n']) },
      { name: '2.log', blob: new Blob(['2026-01-01 00:00:01 INFO ok\n']) },
    ]);
    expect(rows.map((r) => [r.values.message, r.values.sourceFile])).toEqual([
      ['boom\n  at a()', '1.log'],
      ['ok', '2.log'],
    ]);
  });

  it('reports a binary file by name', async () => {
    await expect(
      run([
        { name: 'a.log', blob: new Blob([day1]) },
        { name: 'b.log', blob: new Blob([new Uint8Array(500)]) },
      ]),
    ).rejects.toThrow(/"b\.log" does not look like a text log/);
  });
});

describe('compressed input', () => {
  it('reads .gz files like the plain file', async () => {
    const expected = parseText(sample);
    const { rows, summary } = await run([{ name: 'u_ex261027.log.gz', blob: new Blob([gzipSync(sample)]) }], 1 << 20);
    expect(summary.files).toEqual(['u_ex261027.log']);
    expect(rows).toEqual(expected.rows);
  });

  it('expands .zip archives: deflated and stored entries, ignoring non-log files and folders', async () => {
    const zip = makeZip([
      { name: 'logs/', data: '' },
      { name: 'logs/u_ex26102810.log', data: day2, deflate: true },
      { name: 'logs/readme.md', data: '# not a log' },
      { name: 'logs/u_ex2610279.log', data: day1 },
    ]);
    const { summary, rows } = await run([{ name: 'logs.zip', blob: zip }]);
    expect(summary.files).toEqual(['logs/u_ex2610279.log', 'logs/u_ex26102810.log']);
    expect(rows.map((r) => [r.values['cs-uri-stem'], r.values.sourceFile])).toEqual([
      ['/a', 'logs/u_ex2610279.log'],
      ['/b', 'logs/u_ex2610279.log'],
      ['/c', 'logs/u_ex26102810.log'],
    ]);
  });

  it('reports archives without logs, broken archives and broken gzip clearly', async () => {
    await expect(run([{ name: 'x.zip', blob: makeZip([{ name: 'a.md', data: 'x' }]) }])).rejects.toThrow(
      /"x\.zip" contains no \.log or \.txt files/,
    );
    await expect(run([{ name: 'x.zip', blob: new Blob(['not a zip at all']) }])).rejects.toThrow(/not a valid ZIP/);
    await expect(run([{ name: 'x.log.gz', blob: new Blob(['not gzip data']) }])).rejects.toBeInstanceOf(ParseError);
  });
});

describe('mergeByTime', () => {
  const row = (id: number, ts: number | null): LogRow => ({ id, lineNo: id + 1, ts, values: {}, raw: String(id) });

  it('leaves ordered rows untouched', () => {
    const rows = [row(0, 1), row(1, 2), row(2, null), row(3, 3)];
    expect(mergeByTime(rows)).toBe(rows);
  });

  it('interleaves overlapping files by time, stable for ties, and renumbers ids', () => {
    // File A: 10, 30; file B: 20, 30, null
    const rows = [row(0, 10), row(1, 30), row(2, 20), row(3, 30), row(4, null)];
    const merged = mergeByTime(rows);
    expect(merged.map((r) => r.raw)).toEqual(['0', '2', '1', '3', '4']);
    expect(merged.map((r) => r.id)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('time-only logs', () => {
  it("dates each file's lines from its modified time", async () => {
    const day = (d: number) => new Date(2026, 9, d, 18, 0).getTime();
    const a = new File(['[09:00:00 INF] first\n[09:00:05 INF] second\n'], 'app-a.log', { lastModified: day(27) });
    const b = new File(['[08:00:00 INF] next day\n'], 'app-b.log', { lastModified: day(28) });
    const { summary, rows } = await run([a, b].map((f) => ({ name: f.name, blob: f })));
    expect(rows.map((r) => r.ts)).toEqual([
      Date.UTC(2026, 9, 27, 9, 0, 0),
      Date.UTC(2026, 9, 27, 9, 0, 5),
      Date.UTC(2026, 9, 28, 8, 0, 0),
    ]);
    expect(summary.timeZone.assumedDate).toBe('2026-10-27 – 2026-10-28');
  });
});
