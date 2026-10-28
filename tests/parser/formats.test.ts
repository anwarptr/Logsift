import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectFormat, parseText, splitLines } from '../../src/parser';
import { parseApacheTimestamp } from '../../src/parser/apache';
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
