import { describe, expect, it } from 'vitest';
import { buildLogIndex, isErrorRow } from '../../src/filters/logIndex';
import { parseText } from '../../src/parser';
import { compilePattern } from '../../src/parser/custom';

const parse = (text: string, pattern: string, defaultDate?: number) => parseText(text, 'custom', defaultDate, pattern);
const roleOf = (r: ReturnType<typeof parseText>, role: string) => r.schema.find((c) => c.role === role)?.key;

describe('custom pattern', () => {
  it('reads fields, padded levels and roles', () => {
    const r = parse(
      '2026-10-27 04:42:03.120 [main] ERROR com.acme.Svc - boom\n2026-10-27 04:42:04.120 [worker-1] INFO  com.acme.Svc - ok\n',
      '{time} [{thread}] {level} {logger} - {message}',
    );
    expect(r.format).toBe('custom');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.ts).toBe(Date.UTC(2026, 9, 27, 4, 42, 3, 120));
    expect(r.rows[1]!.values).toMatchObject({ thread: 'worker-1', level: 'INFO', logger: 'com.acme.Svc', message: 'ok' });
    expect(r.schema.map((c) => c.key)).toEqual(['timestamp', 'thread', 'level', 'logger', 'message']);
    expect(roleOf(r, 'level')).toBe('level');
    expect(roleOf(r, 'logger')).toBe('logger');
    expect(roleOf(r, 'message')).toBe('message');
  });

  it('appends lines that do not match to the previous entry, and reports leading ones', () => {
    const r = parse('junk first\n2026-10-27 04:42:03 ERROR boom\n  at x.y()\n  at z()\n', '{time} {level} {message}');
    expect(r.malformed).toHaveLength(1);
    expect(r.malformed[0]!.reason).toMatch(/custom pattern/);
    expect(String(r.rows[0]!.values.message).split('\n')).toHaveLength(3);
    const index = buildLogIndex(r.rows, r.schema);
    expect(isErrorRow(index, 0)).toBe(true);
  });

  it('turns numbers into numbers, maps request fields and skips {_}', () => {
    const r = parse(
      '2026-10-27T04:42:03Z 203.0.113.7 GET /api/x 500 12.5ms req-7\n',
      '{time} {ip} {method} {path} {status} {duration}ms {_}',
    );
    expect(r.rows[0]!.values).toMatchObject({ ip: '203.0.113.7', method: 'GET', path: '/api/x', status: 500, duration: 12.5 });
    expect(r.schema.map((c) => c.key)).not.toContain('_');
    expect(roleOf(r, 'status')).toBe('status');
    expect(roleOf(r, 'uri')).toBe('path');
    expect(roleOf(r, 'method')).toBe('method');
    expect(roleOf(r, 'clientIp')).toBe('ip');
    expect(roleOf(r, 'duration')).toBe('duration');
    expect(r.timeZone.kind).toBe('utc');
  });

  it('joins separate date and time fields, and reads other timestamp layouts', () => {
    const at = Date.UTC(2026, 9, 27, 4, 42, 3);
    const ts = (text: string, pattern: string) => parse(text, pattern).rows[0]!.ts;
    expect(ts('2026-10-27 | 04:42:03 | hi\n', '{date} | {time} | {message}')).toBe(at);
    expect(ts('[27/Oct/2026:04:42:03 +0000] hi\n', '[{time}] {message}')).toBe(at);
    expect(ts('1793076123 hi\n', '{ts} {message}')).toBe(1793076123000);
    expect(ts('Oct 27 2026 04:42:03 hi there\n', '{time} {message}')).toBe(at);
    expect(ts('27/10/2026 04:42:03 hi\n', '{time} {message}')).toBe(at);
    expect(ts('10/27/2026 4:42:03 AM hi\n', '{time} {message}')).toBe(at);
    expect(ts('2026-10-27T04:42:03+04:00 INFO hi\n', '{time} {level} {message}')).toBe(at - 4 * 3_600_000);
    expect(parse('Oct 27 2026 04:42:03 hi there\n', '{time} {message}').rows[0]!.values.message).toBe('hi there');
  });

  it('dates time-only fields from the default date', () => {
    const r = parse('23:59:58 INFO a\n00:00:01 INFO b\n', '{time} {level} {message}', Date.UTC(2026, 9, 27, 12));
    expect(r.rows.map((x) => x.ts)).toEqual([Date.UTC(2026, 9, 27, 23, 59, 58), Date.UTC(2026, 9, 28, 0, 0, 1)]);
    expect(r.timeZone.assumedDate).toBe('2026-10-27 – 2026-10-28');
  });

  it('accepts a regular expression with named groups', () => {
    const r = parse('<E> 2026-10-27T04:42:03Z :: boom\n', '^<(?<level>\\w)> (?<time>\\S+) :: (?<message>.*)$');
    expect(r.rows[0]!.values).toMatchObject({ level: 'E', message: 'boom' });
    expect(r.rows[0]!.ts).toBe(Date.UTC(2026, 9, 27, 4, 42, 3));
  });

  it('explains invalid patterns', () => {
    expect(compilePattern('')).toMatchObject({ ok: false });
    expect(compilePattern('no fields here')).toMatchObject({ ok: false, error: expect.stringMatching(/at least one field/) });
    expect(compilePattern('{a} {a}')).toMatchObject({ ok: false, error: expect.stringMatching(/twice/) });
    expect(compilePattern('{bad name}')).toMatchObject({ ok: false });
    expect(compilePattern('{time} {level')).toMatchObject({ ok: false, error: expect.stringMatching(/not paired/) });
    expect(compilePattern('{_}')).toMatchObject({ ok: false });
    expect(compilePattern('^(unclosed')).toMatchObject({ ok: false, error: expect.stringMatching(/Invalid regular expression/) });
    expect(compilePattern('^\\d+')).toMatchObject({ ok: false, error: expect.stringMatching(/named groups/) });
    expect(compilePattern('{time} {message}')).toMatchObject({ ok: true });
  });

  it('escapes literal regex characters in the pattern', () => {
    const r = parse('(1.5) x+y? done\n', '({n}) {a}+{b}? {message}');
    expect(r.rows[0]!.values).toMatchObject({ n: 1.5, a: 'x', b: 'y', message: 'done' });
  });
});
