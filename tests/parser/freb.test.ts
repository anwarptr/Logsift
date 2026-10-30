import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectFormat, parseText, splitLines } from '../../src/parser';
import { decodeXml } from '../../src/parser/freb';
import { ParseError, streamParseSources, type LogSource, type StreamBatch } from '../../src/worker/streamParse';

const sample = readFileSync('fixtures/sample-freb.xml', 'utf8');

/** A minimal trace: one request with a start and an end event. */
const trace = (url: string, status: string, time: string) => `<?xml version="1.0" encoding="UTF-8" ?>
<failedRequest url="${url}" verb="GET" statusCode="${status}" failureReason="STATUS_CODE" timeTaken="7">
<Event><System><Level>0</Level><TimeCreated SystemTime="${time}"/></System>
<RenderingInfo Culture="en-US"><Opcode>GENERAL_REQUEST_START</Opcode></RenderingInfo></Event>
<Event><System><Level>0</Level><TimeCreated SystemTime="${time}"/></System>
<EventData><Data Name="BytesSent">10</Data></EventData>
<RenderingInfo Culture="en-US"><Opcode>GENERAL_REQUEST_END</Opcode></RenderingInfo></Event>
</failedRequest>
`;

async function run(sources: LogSource[]) {
  const batches: StreamBatch[] = [];
  const summary = await streamParseSources(sources, { chunkBytes: 256, onBatch: (b) => batches.push(b) });
  return { summary, rows: batches.flatMap((b) => b.rows), malformed: batches.flatMap((b) => b.malformed) };
}

describe('IIS failed request trace (FREB) parser', () => {
  const r = parseText(sample);
  const row = r.rows[0]!;

  it('is detected from the <failedRequest> root', () => {
    expect(detectFormat(splitLines(sample))).toBe('freb');
    expect(r.format).toBe('freb');
  });

  it('turns the whole trace into one request row', () => {
    expect(r.rows).toHaveLength(1);
    expect(r.malformed).toHaveLength(0);
    expect(row.lineNo).toBe(4);
    expect(row.ts).toBe(Date.parse('2026-03-14T09:30:01.100Z'));
    expect(r.timeZone.kind).toBe('utc');
    expect(row.values).toMatchObject({
      method: 'POST',
      host: 'shop.example.test',
      uri: '/api/orders/42',
      query: 'expand=lines&v=2',
      status: 500,
      subStatus: 19,
      timeTaken: 125,
      level: 'Error',
      failureReason: 'STATUS_CODE',
      module: 'ConfigurationValidationModule',
      notification: 'BEGIN_REQUEST',
      bytesSent: 1208,
      bytesReceived: 412,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Example/1.0',
      appPool: 'ShopApi',
      userName: 'alice',
      events: 5,
    });
  });

  it('gives the request the usual roles, so filters and endpoint stats work', () => {
    const role = (key: string) => r.schema.find((c) => c.key === key)?.role;
    expect([role('method'), role('uri'), role('status'), role('timeTaken'), role('level'), role('message')]).toEqual([
      'method',
      'uri',
      'status',
      'duration',
      'level',
      'message',
    ]);
  });

  it('explains the failure in the message', () => {
    expect(row.values.message).toBe(
      'ConfigurationValidationModule set 500.19 Internal Server Error in BEGIN_REQUEST: The data is invalid. (0x8007000d)\n' +
        '\\\\?\\C:\\inetpub\\shop\\web.config ( 12) :Cannot read configuration file due to insufficient permissions',
    );
  });

  it('keeps a readable event timeline as the raw text', () => {
    const lines = row.raw.split('\n');
    expect(lines[0]).toBe('09:30:01.100 +0 ms  GENERAL_REQUEST_START');
    expect(row.raw).toContain('09:30:01.200 +100 ms  MODULE_SET_RESPONSE_ERROR_STATUS [Error]');
    // Descriptions replace numeric codes; multi-line values stay indented; ContextId is left out.
    expect(row.raw).toContain('    Notification: BEGIN_REQUEST');
    expect(row.raw).toContain('    Headers: Host: shop.example.test\n      User-Agent:');
    expect(row.raw).not.toContain('ContextId');
  });

  it('reports a trace with no closing tag as malformed', () => {
    const cut = sample.slice(0, sample.indexOf('</failedRequest>'));
    const t = parseText(cut, 'freb');
    expect(t.rows).toHaveLength(0);
    expect(t.malformed).toEqual([expect.objectContaining({ lineNo: 4, reason: expect.stringContaining('Incomplete') })]);
  });

  it('decodes XML entities', () => {
    expect(decodeXml('a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#x27;')).toBe('a <b> & "c" \'d\'');
  });
});

describe('FREB files in the stream', () => {
  it('opens a folder of traces as one row per request', async () => {
    const { summary, rows } = await run([
      { name: 'fr000002.xml', blob: new Blob([trace('http://x.test/b', '404', '2026-03-14T10:00:00.000Z')]) },
      { name: 'fr000001.xml', blob: new Blob([trace('http://x.test/a', '401.2', '2026-03-14T09:00:00.000Z')]) },
    ]);
    expect(summary.format).toBe('freb');
    expect(rows.map((r) => [r.values.sourceFile, r.values.uri, r.values.status, r.values.subStatus])).toEqual([
      ['fr000001.xml', '/a', 401, 2],
      ['fr000002.xml', '/b', 404, null],
    ]);
  });

  it('rejects XML that is not a failed request trace', async () => {
    const xml = '<?xml version="1.0"?>\n<config>\n  <add key="a" value="b" />\n</config>\n';
    await expect(run([{ name: 'web.xml', blob: new Blob([xml]) }])).rejects.toThrow(ParseError);
    await expect(run([{ name: 'web.xml', blob: new Blob([xml]) }])).rejects.toThrow(/neither an IIS failed request trace/);
  });
});
