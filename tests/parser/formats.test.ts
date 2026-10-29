import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectFormat, parseText, splitLines } from '../../src/parser';
import { parseApacheTimestamp } from '../../src/parser/apache';
import { buildLogIndex, isErrorRow } from '../../src/filters/logIndex';
import { parseLooseIso } from '../../src/parser/generic';

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

