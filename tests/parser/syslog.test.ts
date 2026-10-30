import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLogIndex, isErrorRow } from '../../src/filters/logIndex';
import { detectFormat, parseText, splitLines } from '../../src/parser';

const sample = readFileSync('fixtures/sample-syslog.log', 'utf8');
/** The file's date, which supplies the year BSD syslog lines leave out. */
const FILE_DATE = Date.UTC(2026, 2, 20);

describe('syslog parser', () => {
  const r = parseText(sample, undefined, FILE_DATE);

  it('is detected from BSD syslog lines', () => {
    expect(detectFormat(splitLines(sample))).toBe('syslog');
    expect(r.format).toBe('syslog');
  });

  it('reads host, app, pid and message, and appends continuation lines', () => {
    expect(r.malformed).toHaveLength(0);
    expect(r.rows.map((x) => [x.lineNo, x.values.app, x.values.pid])).toEqual([
      [1, 'systemd', 1],
      [2, 'shop-api', 4242],
      [3, 'shop-api', 4242],
      [6, 'sudo', null],
      [7, 'kernel', null],
      [8, 'nginx', 88],
    ]);
    expect(r.rows[0]!.values).toMatchObject({ host: 'web01', message: 'Started Shop API service.' });
    expect(r.rows[2]!.values.message).toBe('Unhandled exception: connection refused\n    at Db.Connect (db.js:42)\n    at Startup.Run (startup.js:7)');
    expect(r.rows[4]!.values.message).toBe('[ 1234.567890] eth0: link up');
  });

  it('takes the year from the file date and says so; times are zone-less', () => {
    expect(r.rows[0]!.ts).toBe(Date.UTC(2026, 2, 14, 9, 30, 1));
    expect(r.rows[5]!.ts).toBe(Date.UTC(2026, 2, 4, 9, 31, 10)); // "Mar  4": day padded with a space
    expect(r.timeZone.kind).toBe('unspecified');
    expect(r.timeZone.assumedDate).toContain('2026');
  });

  it('puts December lines in a January file in the year before', () => {
    const t = parseText('Dec 31 23:59:59 h app: last\nJan  1 00:00:01 h app: first\n', 'syslog', Date.UTC(2027, 0, 1, 12));
    expect(t.rows.map((x) => new Date(x.ts!).toISOString())).toEqual(['2026-12-31T23:59:59.000Z', '2027-01-01T00:00:01.000Z']);
  });

  it('turns the priority into a level and facility; emergency to error count as errors', () => {
    expect(r.rows.map((x) => x.values.level ?? null)).toEqual([null, null, 'ERROR', 'NOTICE', null, 'WARN']);
    expect(r.rows[2]!.values.facility).toBe('user');
    expect(r.rows[3]!.values.facility).toBe('authpriv');
    const index = buildLogIndex(r.rows, r.schema);
    expect(r.rows.map((_, i) => isErrorRow(index, i))).toEqual([false, false, true, false, false, false]);
    expect(parseText('<8>Mar 14 09:30:01 h app: down\n', 'syslog').rows[0]!.values.level).toBe('EMERG');
  });

  it('reads RFC 5424 lines with structured data', () => {
    const t = parseText(
      '<165>1 2026-03-14T09:30:01.120Z web01 shop 4242 ID47 [meta@1 user="a b" n="1"] Order placed\n' +
        '<14>1 2026-03-14T09:30:02+04:00 web01 - - - - ﻿Plain message\n',
    );
    expect(t.format).toBe('syslog');
    expect(t.rows[0]!.values).toMatchObject({
      level: 'NOTICE',
      facility: 'local4',
      host: 'web01',
      app: 'shop',
      pid: 4242,
      msgid: 'ID47',
      message: '[meta@1 user="a b" n="1"] Order placed',
    });
    expect(t.rows[0]!.ts).toBe(Date.UTC(2026, 2, 14, 9, 30, 1, 120));
    expect(t.rows[1]!.values).toMatchObject({ app: null, pid: null, message: 'Plain message' });
    expect(t.rows[1]!.ts).toBe(Date.UTC(2026, 2, 14, 5, 30, 2));
    expect(t.timeZone.kind).toBe('mixed');
  });

  it('reads rsyslog lines with ISO timestamps', () => {
    const t = parseText('2026-03-14T09:30:01.120+04:00 web01 nginx[88]: worker started\n2026-03-14T09:30:02.000+04:00 web01 cron[9]: job ran\n');
    expect(t.format).toBe('syslog');
    expect(t.rows[0]!.values).toMatchObject({ host: 'web01', app: 'nginx', pid: 88, message: 'worker started' });
    expect(t.timeZone).toMatchObject({ kind: 'offset', offsetMin: 240 });
  });

  it('leaves ISO-stamped application logs to the generic parser', () => {
    expect(parseText(readFileSync('fixtures/sample-generic.log', 'utf8')).format).toBe('generic');
    expect(detectFormat(['2026-10-27T04:42:03Z WARN [Db] Pool nearly exhausted', '2026-10-27T04:42:04Z ERROR Db: down'])).toBe('generic');
  });
});
