import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLogIndex, isErrorRow } from '../../src/filters/logIndex';
import { detectFormat, parseText, splitLines } from '../../src/parser';
import { isCsv, parseCsvTime, splitRecord } from '../../src/parser/csv';

const sample = readFileSync('fixtures/sample.csv', 'utf8');

describe('CSV / TSV parser', () => {
  const r = parseText(sample);

  it('is detected from a header row and matching records', () => {
    expect(detectFormat(splitLines(sample))).toBe('csv');
    expect(r.format).toBe('csv');
  });

  it('reads records, including quoted commas, quotes and line breaks', () => {
    expect(r.malformed).toHaveLength(0);
    expect(r.rows.map((x) => x.lineNo)).toEqual([2, 3, 4, 6]);
    expect(r.rows[1]!.values.Message).toBe('Slow query, 2 retries');
    expect(r.rows[2]!.values.Message).toBe('Payment failed: "card declined"\n   at Payments.Charge()');
    expect(r.rows[2]!.raw).toContain('\n   at Payments.Charge()",500');
  });

  it('turns the time column into the timestamp, and numbers into numbers', () => {
    expect(r.rows.map((x) => x.ts)).toEqual([
      Date.UTC(2026, 2, 14, 9, 30, 1, 100),
      Date.UTC(2026, 2, 14, 9, 30, 2, 250),
      Date.UTC(2026, 2, 14, 21, 30, 5),
      Date.UTC(2026, 2, 14, 21, 31, 0),
    ]);
    expect(r.timeZone.kind).toBe('utc'); // the header says [UTC]
    expect(r.rows[0]!.values).toMatchObject({ ResultCode: 200, DurationMs: 12.5, client_IP: '10.0.0.7' });
    expect(r.rows[3]!.values.client_IP).toBeNull();
  });

  it('guesses roles from the header names, so filters and insights work', () => {
    const role = (k: string) => r.schema.find((c) => c.key === k)?.role;
    expect([role('timestamp'), role('Level'), role('Message'), role('ResultCode'), role('DurationMs'), role('Url'), role('client_IP')]).toEqual([
      'timestamp',
      'level',
      'message',
      'status',
      'duration',
      'uri',
      'clientIp',
    ]);
    const index = buildLogIndex(r.rows, r.schema);
    expect(r.rows.map((_, i) => isErrorRow(index, i))).toEqual([false, false, true, true]);
  });

  it('reads tab-separated files and reports records with the wrong field count', () => {
    const t = parseText(
      'time\tseverityLevel\tmessage\n2026-03-14T09:30:01Z\t3\tboom\n2026-03-14T09:30:02Z\t1\n' +
        '2026-03-14T09:30:03Z\t1\tok\t\n2026-03-14T09:30:04Z\t0\tdetail\n2026-03-14T09:30:05Z\t2\tslow\n',
    );
    expect(t.format).toBe('csv');
    expect(t.rows.map((x) => [x.values.severityLevel, x.values.message])).toEqual([
      ['Error', 'boom'],
      ['Information', 'ok'], // trailing delimiter tolerated
      ['Verbose', 'detail'],
      ['Warning', 'slow'],
    ]);
    expect(t.malformed).toEqual([expect.objectContaining({ lineNo: 3, reason: 'Expected 3 fields, found 2' })]);
  });

  it('works without a time column', () => {
    const t = parseText('name\tcount\nalpha\t1\nbeta\t2\n');
    expect(t.format).toBe('csv');
    expect(t.rows.map((x) => [x.ts, x.values.name, x.values.count])).toEqual([
      [null, 'alpha', 1],
      [null, 'beta', 2],
    ]);
  });

  it('parses time cells in the usual export formats', () => {
    expect(parseCsvTime('10/30/2026, 4:48:28.868 AM')).toBe(Date.UTC(2026, 9, 30, 4, 48, 28, 868));
    expect(parseCsvTime('30/10/2026 16:48:28')).toBe(Date.UTC(2026, 9, 30, 16, 48, 28));
    expect(parseCsvTime('12/1/2026 12:05 AM')).toBe(Date.UTC(2026, 11, 1, 0, 5));
    expect(parseCsvTime('2026-10-30T04:48:28Z')).toBe(Date.UTC(2026, 9, 30, 4, 48, 28));
    expect(parseCsvTime('1793336010')).toBe(1793336010000);
  });

  it('splits records per RFC 4180', () => {
    expect(splitRecord('a,"b,c","d ""e""",', ',')).toEqual(['a', 'b,c', 'd "e"', '']);
  });

  it('does not take other logs for CSV', () => {
    for (const f of ['sample-iis.log', 'sample-apache.log', 'sample-jsonl.log', 'sample-generic.log', 'sample-serilog.log', 'sample-syslog.log']) {
      expect(isCsv(splitLines(readFileSync(`fixtures/${f}`, 'utf8')).filter((l) => l.trim()).slice(0, 50))).toBe(false);
    }
    expect(isCsv(['Started app, version 2', 'Listening, port 80', 'Ready, ok'])).toBe(false);
  });
});
