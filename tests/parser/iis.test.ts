import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseText } from '../../src/parser';

const sample = readFileSync('fixtures/sample-iis.log', 'utf8');

const HEADER = [
  '#Software: Microsoft Internet Information Services 8.0',
  '#Fields: date time s-sitename cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) cs(Cookie) cs(Referer) cs-host sc-status sc-substatus sc-win32-status sc-bytes cs-bytes time-taken',
].join('\n');

describe('IIS parser', () => {
  const result = parseText(sample);

  it('detects IIS and parses all 16 rows, keeping # lines as metadata', () => {
    expect(result.format).toBe('iis');
    expect(result.rows).toHaveLength(16);
    expect(result.malformed).toHaveLength(0);
    expect(result.meta).toHaveLength(2);
    expect(result.meta[0]).toMatch(/^#Software:/);
  });

  it('reads the schema from #Fields, replacing date+time with a timestamp column', () => {
    const keys = result.schema.map((c) => c.key);
    expect(keys.slice(0, 4)).toEqual(['timestamp', 's-sitename', 'cs-method', 'cs-uri-stem']);
    expect(keys).toContain('time-taken');
    expect(keys).not.toContain('date');
    expect(keys).toEqual(expect.arrayContaining(['isScm', 'arrLogId', 'isHealthCheck']));
    expect(result.schema.find((c) => c.key === 'sc-status')?.role).toBe('status');
  });

  it('combines date and time into a UTC timestamp', () => {
    const r = result.rows[0]!;
    expect(r.ts).toBe(Date.UTC(2026, 2, 14, 9, 12, 2));
    expect(r.values.timestamp).toBe(r.ts);
    expect(new Date(r.ts!).toISOString()).toBe('2026-03-14T09:12:02.000Z');
  });

  it('turns "-" into null', () => {
    const r = result.rows[0]!;
    expect(r.values['cs-username']).toBeNull();
    expect(r.values['cs(User-Agent)']).toBeNull();
    expect(result.rows[4]!.values['cs-uri-query']).toBeNull();
  });

  it('converts numeric fields to numbers', () => {
    const r = result.rows[0]!.values;
    expect(r['s-port']).toBe(443);
    expect(r['sc-status']).toBe(404);
    expect(r['sc-substatus']).toBe(0);
    expect(r['sc-win32-status']).toBe(0);
    expect(r['sc-bytes']).toBe(639);
    expect(r['cs-bytes']).toBe(796);
    expect(r['time-taken']).toBe(2);
    expect(result.rows[11]!.values['time-taken']).toBe(4414);
  });

  it('strips the ~1 site prefix and flags isScm', () => {
    const scm = result.rows[4]!.values;
    expect(scm['s-sitename']).toBe('DEMO-API-PROD');
    expect(scm.isScm).toBe(true);
    expect(result.rows[0]!.values.isScm).toBe(false);
    expect(result.rows.filter((r) => r.values.isScm)).toHaveLength(3);
  });

  it('extracts X-ARR-LOG-ID into arrLogId', () => {
    expect(result.rows[0]!.values.arrLogId).toBe('95d6c588-90a6-4936-b1b2-2b81d97b67aa');
    expect(result.rows[4]!.values.arrLogId).toBeNull();
  });

  it('flags health checks (AlwaysOn UA or 127.0.0.1)', () => {
    const hc = result.rows.filter((r) => r.values.isHealthCheck);
    expect(hc).toHaveLength(6);
    expect(result.rows[3]!.values.isHealthCheck).toBe(true); // 127.0.0.1 + AlwaysOn
    expect(result.rows[4]!.values.isHealthCheck).toBe(true); // AlwaysOn from 10.30.0.5
    expect(result.rows[0]!.values.isHealthCheck).toBe(false);

    const ipOnly = parseText(`${HEADER}\n2026-10-27 04:42:02 SITE GET / - 80 - 127.0.0.1 curl - - h 200 0 0 1 1 1`);
    expect(ipOnly.rows[0]!.values.isHealthCheck).toBe(true);
  });

  it('keeps the raw line on each row', () => {
    expect(result.rows[0]!.raw).toBe(sample.split('\n')[2]);
  });

  it('switches schema on a mid-file #Fields change', () => {
    const text = [
      '#Fields: date time cs-method cs-uri-stem sc-status',
      '2026-10-27 01:00:00 GET /a 200',
      '#Fields: date time c-ip cs-method cs-uri-stem sc-status time-taken',
      '2026-10-27 01:00:01 10.0.0.1 POST /b 500 123',
    ].join('\n');
    const r = parseText(text);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]!.values).toMatchObject({ 'cs-method': 'GET', 'cs-uri-stem': '/a', 'sc-status': 200 });
    expect(r.rows[1]!.values).toMatchObject({
      'c-ip': '10.0.0.1',
      'cs-method': 'POST',
      'cs-uri-stem': '/b',
      'sc-status': 500,
      'time-taken': 123,
    });
    const keys = r.schema.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['c-ip', 'time-taken', 'cs-method']));
  });

  it('keeps a line with the wrong field count as a malformed row', () => {
    const r = parseText(`${HEADER}\n2026-10-27 04:42:02 SITE GET / - 443 - 10.1.1.1 - - - host 404 0 0 639\n`);
    expect(r.rows).toHaveLength(0);
    expect(r.malformed).toHaveLength(1);
    expect(r.malformed[0]!.raw).toContain('host 404 0 0 639');
    expect(r.malformed[0]!.reason).toMatch(/Expected 19 fields, found 17/);
    expect(r.malformed[0]!.lineNo).toBe(3);
  });

  it('ignores blank lines and CRLF line endings', () => {
    const crlf = sample.replace(/\n/g, '\r\n').replace('#Fields', '\r\n\r\n#Fields') + '\r\n\r\n   \r\n';
    const r = parseText(crlf);
    expect(r.rows).toHaveLength(16);
    expect(r.malformed).toHaveLength(0);
    expect(r.rows[0]!.values['time-taken']).toBe(2);
  });
});
