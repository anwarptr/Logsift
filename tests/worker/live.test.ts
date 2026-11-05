import { describe, expect, it } from 'vitest';
import { appendToSession, streamParseSources, type StreamBatch } from '../../src/worker/streamParse';

const enc = (s: string) => new TextEncoder().encode(s);
const line = (sec: number, level: string, msg: string) => `2026-10-27 04:42:${String(sec).padStart(2, '0')} ${level} ${msg}\n`;

async function liveParse(files: Record<string, string>, multi?: boolean) {
  const batches: StreamBatch[] = [];
  const summary = await streamParseSources(
    Object.entries(files).map(([name, text]) => ({ name, blob: new Blob([text]) })),
    { live: true, multi, onBatch: (b) => batches.push(b) },
  );
  const session = summary.session!;
  const append = (name: string, text: string, final = false) =>
    appendToSession(session, name, enc(text), Date.now(), (b) => batches.push(b), final);
  return { summary, session, append, rows: () => batches.flatMap((b) => b.rows), malformed: () => batches.flatMap((b) => b.malformed) };
}

describe('live parsing', () => {
  it('holds back an unfinished last line and reads it with the next append', async () => {
    const { summary, append, rows } = await liveParse({ 'app.log': line(1, 'INFO', 'one') + '2026-10-27 04:42:02 ERR' });
    expect(rows()).toHaveLength(1);
    expect(summary.held).toEqual({ 'app.log': enc('2026-10-27 04:42:02 ERR').length });

    // The watcher reads from the held offset: the rest of the line plus a partial next one.
    const r = append('app.log', '2026-10-27 04:42:02 ERROR two\n2026-10-27 04:42:0');
    expect(r.consumed).toBe(enc('2026-10-27 04:42:02 ERROR two\n').length);
    // The entry stays open (a stack trace may follow) until the file stops growing.
    expect(rows()).toHaveLength(1);
    append('app.log', '2026-10-27 04:42:03 INFO three', true);
    const all = rows();
    expect(all.map((x) => [x.values.message, x.lineNo, x.id])).toEqual([
      ['one', 1, 0],
      ['two', 2, 1],
      ['three', 3, 2],
    ]);
  });

  it('reads nothing until a line is complete, unless the file stopped growing', async () => {
    const { append, rows } = await liveParse({ 'app.log': line(1, 'INFO', 'one') });
    expect(append('app.log', '2026-10-27 04:42:02 INFO no newline').consumed).toBe(0);
    expect(append('app.log', '2026-10-27 04:42:02 INFO no newline', true).consumed).toBe(enc('2026-10-27 04:42:02 INFO no newline').length);
    expect(rows().map((r) => r.values.message)).toEqual(['one', 'no newline']);
  });

  it('joins a stack trace written in a later check to its entry', async () => {
    const { append, rows, malformed } = await liveParse({ 'app.log': line(1, 'INFO', 'one') });
    append('app.log', line(2, 'ERROR', 'boom'));
    append('app.log', '   at Foo.Bar()\r\n   at Baz()\n');
    append('app.log', '', true);
    expect(String(rows()[1]!.values.message)).toBe('boom\n   at Foo.Bar()\n   at Baz()');
    expect(malformed()).toEqual([]);
  });

  it('numbers lines per file, tags rows with their file, and closes a file when another is read', async () => {
    const { append, rows, summary } = await liveParse({ 'a.log': line(1, 'INFO', 'a1') }, true);
    expect(rows()[0]!.values.sourceFile).toBe('a.log');
    expect(summary.schema.some((c) => c.key === 'sourceFile')).toBe(true);
    append('b.log', line(2, 'INFO', 'b1') + line(3, 'INFO', 'b2'));
    append('a.log', line(4, 'WARN', 'a2')); // closes b.log's open entry (b2)
    append('a.log', '', true);
    expect(rows().map((r) => [r.values.message, r.values.sourceFile, r.lineNo])).toEqual([
      ['a1', 'a.log', 1],
      ['b1', 'b.log', 1],
      ['b2', 'b.log', 2],
      ['a2', 'a.log', 2],
    ]);
  });

  it('keeps each CSV file\'s header for lines appended later', async () => {
    const { append, rows, malformed } = await liveParse(
      { 'a.csv': 'time,level,message\n2026-10-27T04:42:01Z,Info,a1\n', 'b.csv': 'ts,msg,status\n2026-10-27T04:42:02Z,b1,200\n' },
      true,
    );
    append('a.csv', '2026-10-27T04:42:03Z,Error,a2\n');
    append('b.csv', '2026-10-27T04:42:04Z,b2,500\n');
    append('b.csv', '', true);
    expect(malformed()).toEqual([]);
    const byMsg = Object.fromEntries(rows().map((r) => [String(r.values.message ?? r.values.msg), r.values]));
    expect(byMsg.a2).toMatchObject({ level: 'Error', message: 'a2', sourceFile: 'a.csv' });
    expect(byMsg.b2).toMatchObject({ msg: 'b2', status: 500, sourceFile: 'b.csv' });
  });

  it('keeps IIS #Fields per file', async () => {
    const header = (fields: string) => `#Software: Microsoft Internet Information Services 10.0\n#Fields: ${fields}\n`;
    const { append, rows } = await liveParse(
      {
        'u_ex1.log': header('date time cs-method cs-uri-stem sc-status') + '2026-10-27 04:42:01 GET /a 200\n',
        'u_ex2.log': header('date time sc-status cs-uri-stem') + '2026-10-27 04:42:02 404 /b\n',
      },
      true,
    );
    append('u_ex1.log', '2026-10-27 04:42:03 POST /c 500\n', true);
    const last = rows()[rows().length - 1]!;
    expect(last.values).toMatchObject({ 'cs-method': 'POST', 'cs-uri-stem': '/c', 'sc-status': 500 });
  });

  it('does not hold back lines of compressed files (they are not tailed)', async () => {
    const gzBytes = await new Response(
      new Blob([line(1, 'INFO', 'x') + 'partial line']).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer();
    const batches: StreamBatch[] = [];
    const summary = await streamParseSources([{ name: 'old.log.gz', blob: new Blob([gzBytes]) }], {
      live: true,
      onBatch: (b) => batches.push(b),
    });
    expect(summary.held).toEqual({});
    expect(batches.flatMap((b) => b.rows).map((r) => r.values.message)).toEqual(['x\npartial line']);
  });
});
