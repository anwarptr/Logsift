import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectFormat, parseText, splitLines } from '../../src/parser';
import { parseApacheTimestamp } from '../../src/parser/apache';
import { buildLogIndex, isErrorRow } from '../../src/filters/logIndex';
import { parseLooseIso } from '../../src/parser/generic';
import { renderTemplate } from '../../src/parser/jsonl';

const read = (name: string) => readFileSync(`fixtures/${name}`, 'utf8');

describe('detectFormat', () => {
  it.each([
    ['sample-iis.log', 'iis'],
    ['sample-apache.log', 'apache'],
    ['sample-jsonl.log', 'jsonl'],
    ['sample-generic.log', 'generic'],
  ])('%s → %s', (file, expected) => {
    expect(detectFormat(splitLines(read(file)))).toBe(expected);
    expect(parseText(read(file)).format).toBe(expected);
  });

  it('falls back to generic for empty input', () => {
    expect(detectFormat([])).toBe('generic');
    expect(detectFormat(['', '  '])).toBe('generic');
  });
});

describe('Apache parser', () => {
  const r = parseText(read('sample-apache.log'));

  it('parses every line', () => {
    expect(r.rows).toHaveLength(6);
    expect(r.malformed).toHaveLength(0);
  });

  it('splits the request and converts fields', () => {
    expect(r.rows[1]!.values).toMatchObject({
      'c-ip': '192.168.1.11',
      'cs-username': 'alice',
      'cs-method': 'POST',
      'cs-uri-stem': '/api/login',
      'cs-uri-query': 'next=%2Fhome',
      'sc-status': 302,
      'sc-bytes': 312,
      'cs(Referer)': 'https://example.com/login',
    });
    expect(r.rows[5]!.values['sc-bytes']).toBeNull();
  });

  it('parses timestamps with offsets', () => {
    expect(parseApacheTimestamp('10/Oct/2000:13:55:36 -0700')).toBe(Date.UTC(2000, 9, 10, 20, 55, 36));
    expect(r.rows[0]!.ts).toBe(Date.UTC(2026, 9, 27, 4, 42, 2));
  });

  it('flags non-matching lines as malformed', () => {
    const bad = parseText('not an access log line', 'apache');
    expect(bad.malformed).toHaveLength(1);
  });
});

describe('JSON lines parser', () => {
  const r = parseText(read('sample-jsonl.log'));

  it('builds columns from keys and maps the timestamp', () => {
    expect(r.rows).toHaveLength(5);
    const keys = r.schema.map((c) => c.key);
    expect(keys).toEqual(['timestamp', 'level', 'logger', 'message', 'path', 'durationMs']);
    expect(r.schema.find((c) => c.key === 'level')?.role).toBe('level');
    expect(r.schema.find((c) => c.key === 'durationMs')?.type).toBe('number');
    expect(r.rows[0]!.ts).toBe(Date.parse('2026-10-27T04:42:02.120Z'));
  });

  it('keeps invalid JSON as malformed', () => {
    const bad = parseText('{"a":1}\n{oops\nplain', 'jsonl');
    expect(bad.rows).toHaveLength(1);
    expect(bad.malformed.map((m) => m.lineNo)).toEqual([2, 3]);
  });
});

describe('generic parser', () => {
  const r = parseText(read('sample-generic.log'));

  it('extracts timestamp, level, logger and message', () => {
    expect(r.rows).toHaveLength(6);
    expect(r.rows[0]!.values).toMatchObject({ level: 'INFO', logger: 'Startup' });
    expect(r.rows[0]!.values.message).toBe('Application starting, version 1.4.2');
    expect(r.rows[2]!.ts).toBe(Date.UTC(2026, 9, 27, 4, 42, 3));
    expect(r.rows[5]!.values.level).toBe('FATAL');
  });

  it('appends lines without a timestamp to the previous entry', () => {
    const err = r.rows[3]!;
    expect(err.values.level).toBe('ERROR');
    expect(String(err.values.message).split('\n')).toHaveLength(4);
    expect(err.raw).toContain('Service.cs:line 88');
    expect(r.malformed).toHaveLength(0);
  });

  it('treats leading orphan lines as malformed', () => {
    const x = parseText('orphan line\n2026-01-01 00:00:00 INFO ok', 'generic');
    expect(x.malformed).toHaveLength(1);
    expect(x.rows).toHaveLength(1);
  });

  it('parses loose ISO timestamps', () => {
    expect(parseLooseIso('2026-10-27 04:42:02,120')).toBe(Date.UTC(2026, 9, 27, 4, 42, 2, 120));
    expect(parseLooseIso('2026-10-27T04:42:02.1234567+04:00')).toBe(Date.UTC(2026, 9, 27, 0, 42, 2, 123));
    expect(parseLooseIso('2026-10-27 04:42:02 +0400')).toBe(Date.UTC(2026, 9, 27, 0, 42, 2));
  });
});

describe('Serilog text logs', () => {
  const r = parseText(read('sample-serilog.log'));

  it('is read by the generic parser, with stack traces kept on their entry', () => {
    expect(r.format).toBe('generic');
    expect(r.rows).toHaveLength(14);
    expect(r.malformed).toHaveLength(0);
    expect(r.timeZone).toMatchObject({ kind: 'offset', offsetMin: 240 });
    expect(r.rows[0]!.ts).toBe(Date.UTC(2026, 2, 14, 5, 30, 1, 102));
    const err = r.rows.find((x) => x.values.StatusCode === 500)!;
    expect(err.values.level).toBe('ERROR');
    expect(String(err.values.message)).toContain('SupplierClient.cs:line 41');
  });

  it('turns request log lines into method, path, status and duration columns', () => {
    expect(r.schema.map((c) => [c.key, c.role])).toEqual([
      ['timestamp', 'timestamp'],
      ['level', 'level'],
      ['RequestMethod', 'method'],
      ['RequestPath', 'uri'],
      ['StatusCode', 'status'],
      ['Elapsed', 'duration'],
      ['message', 'message'],
    ]);
    expect(r.rows[3]!.values).toMatchObject({
      RequestMethod: 'GET',
      RequestPath: '/api/orders',
      StatusCode: 200,
      Elapsed: 142.3381,
    });
    // Application lines keep no request fields.
    const login = r.rows.find((x) => String(x.values.message).includes('logged in'))!;
    expect(login.values.StatusCode).toBeUndefined();
  });

  it('counts failed requests and ERROR lines without a status as errors', () => {
    const index = buildLogIndex(r.rows, r.schema);
    const errors = r.rows.filter((_, i) => isErrorRow(index, i)).map((x) => String(x.values.message).split('\n')[0]);
    expect(errors).toEqual([
      'HTTP GET /api/suppliers/search responded 500 in 412.7740 ms',
      'Unhandled exception processing GET /api/suppliers/search',
      'HTTP POST /api/auth/refresh responded 401 in 0.4664 ms',
    ]);
  });

  it('does not take request fields from lines that only mention a request', () => {
    const x = parseText('2026-03-14 09:30:01 [INF] Retrying HTTP GET /a responded 200 in 5 ms', 'generic');
    expect(x.schema.some((c) => c.role === 'status')).toBe(false);
  });
});

describe('time-only lines (Serilog console: "[HH:mm:ss INF] message")', () => {
  // Indented, as when copied from a terminal.
  const LOG = [
    '  [11:54:02 INF] Now listening on: http://localhost:5100',
    '  [11:54:02 INF] Application started. Press Ctrl+C to shut down.',
    '  [11:54:03 INF] HTTP GET /swagger responded 301 in 6.1034 ms',
    '  [11:55:14 INF] HTTP GET /api/app/version responded 200 in 7866.6915 ms',
    '  [11:55:15 ERR] HTTP GET /api/x responded 500 in 12.5 ms',
    'System.InvalidOperationException: boom',
    '   at X.Y()',
  ].join('\n');
  const FILE_DATE = new Date(2026, 9, 29, 18, 0).getTime(); // local 29 Oct 2026, 18:00

  it('takes the date from the given default date and reads the rest like any text log', () => {
    const r = parseText(LOG, undefined, FILE_DATE);
    expect(r.format).toBe('generic');
    expect(r.rows).toHaveLength(5);
    expect(r.malformed).toHaveLength(0);
    expect(r.rows[0]!.ts).toBe(Date.UTC(2026, 9, 29, 11, 54, 2));
    expect(r.rows[3]!.values).toMatchObject({ level: 'INFO', RequestPath: '/api/app/version', StatusCode: 200, Elapsed: 7866.6915 });
    expect(String(r.rows[4]!.values.message)).toContain('at X.Y()');
    expect(r.timeZone).toMatchObject({ kind: 'unspecified', assumedDate: '2026-10-29' });
  });

  it('moves to the next day when the time wraps past midnight', () => {
    const r = parseText(
      ['[23:59:58 INF] a', '[23:59:59.500 WRN] b', '[00:00:01 INF] c', '[00:00:00 INF] slightly out of order'].join('\n'),
      'generic',
      FILE_DATE,
    );
    expect(r.rows.map((x) => x.ts)).toEqual([
      Date.UTC(2026, 9, 29, 23, 59, 58),
      Date.UTC(2026, 9, 29, 23, 59, 59, 500),
      Date.UTC(2026, 9, 30, 0, 0, 1),
      Date.UTC(2026, 9, 30, 0, 0, 0),
    ]);
    expect(r.timeZone.assumedDate).toBe('2026-10-29 – 2026-10-30');
  });

  it('needs a level, so text that merely starts with a time is not an entry', () => {
    const r = parseText('[10:00:00 INF] start\n12:30 lunch break notes', 'generic', FILE_DATE);
    expect(r.rows).toHaveLength(1);
    expect(String(r.rows[0]!.values.message)).toContain('lunch break');
  });

  it('dated logs report no assumed date', () => {
    expect(parseText(read('sample-serilog.log')).timeZone.assumedDate).toBeUndefined();
  });
});

describe('Serilog JSON', () => {
  it('reads compact JSON (CLEF): time, level, rendered message, exception and request columns', () => {
    const r = parseText(read('sample-serilog.clef'));
    expect(r.format).toBe('jsonl');
    expect(r.rows).toHaveLength(8);
    expect(r.malformed).toHaveLength(0);
    expect(r.timeZone.kind).toBe('utc');
    const roles = Object.fromEntries(r.schema.filter((c) => c.role).map((c) => [c.role, c.key]));
    expect(roles).toMatchObject({
      timestamp: 'timestamp',
      level: 'level',
      message: 'message',
      uri: 'RequestPath',
      method: 'RequestMethod',
      status: 'StatusCode',
      duration: 'Elapsed',
      logger: 'SourceContext',
    });
    expect(r.rows[0]!.ts).toBe(Date.UTC(2026, 2, 14, 5, 30, 1, 102));
    expect(r.rows[0]!.values).toMatchObject({ level: 'Information', message: 'Now listening on: https://localhost:5001' });
    expect(r.rows[1]!.values.message).toBe('HTTP GET /api/orders responded 200 in 142.3381 ms');
    expect(r.rows[1]!.values.MessageTemplate).toBe(
      'HTTP {RequestMethod} {RequestPath} responded {StatusCode} in {Elapsed:0.0000} ms',
    );
    const err = r.rows[5]!.values;
    expect(err).toMatchObject({ level: 'Error', StatusCode: 500, TraceId: '4bf92f3577b34da6a3ce929d0e0e4736' });
    expect(String(err.Exception)).toContain('SupplierClient.cs:line 41');
    // The "@" keys themselves are not columns.
    expect(r.schema.some((c) => c.key.startsWith('@'))).toBe(false);
  });

  it('flattens JsonFormatter "Properties" and uses RenderedMessage as the message', () => {
    const line = JSON.stringify({
      Timestamp: '2026-03-14T09:30:14.3100000+04:00',
      Level: 'Error',
      MessageTemplate: 'Failed for {Path}',
      RenderedMessage: 'Failed for "/api/x"',
      Exception: 'System.Exception: boom',
      Properties: { Path: '/api/x', SourceContext: 'Demo.Api' },
    });
    const r = parseText(line);
    expect(r.rows[0]!.values).toMatchObject({ Level: 'Error', Path: '/api/x', SourceContext: 'Demo.Api' });
    expect(r.rows[0]!.values.Properties).toBeUndefined();
    expect(r.schema.find((c) => c.role === 'message')!.key).toBe('RenderedMessage');
    expect(r.timeZone).toMatchObject({ kind: 'offset', offsetMin: 240 });
  });

  it('renders message templates like Serilog', () => {
    const props = { Name: 'Ann', Count: 3, Items: [1, 2] };
    expect(renderTemplate('Hi {Name}, {Count:000} new {@Items} {$Name}', props)).toBe('Hi Ann, 3 new [1,2] Ann');
    expect(renderTemplate('{{literal}} {Missing} {Name,10}', props)).toBe('{literal} {Missing} Ann');
  });
});
