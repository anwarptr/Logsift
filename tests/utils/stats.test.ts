import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLogIndex } from '../../src/filters/logIndex';
import { parseText } from '../../src/parser';
import { csvEscape, toCsvParts, toJsonParts } from '../../src/utils/export';
import { computeInsights } from '../../src/utils/insights';
import { autoBucketSize, histogram, percentile, summarize } from '../../src/utils/stats';

describe('percentile', () => {
  it('interpolates linearly between ranks', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 0)).toBe(1);
    expect(percentile(s, 100)).toBe(10);
    expect(percentile(s, 50)).toBeCloseTo(5.5);
    expect(percentile(s, 95)).toBeCloseTo(9.55);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 50)).toBeNaN();
  });

  it('summarize ignores NaN', () => {
    const r = summarize([10, Number.NaN, 30, 20]);
    expect(r).toMatchObject({ count: 3, sum: 60, avg: 20, max: 30 });
    expect(r.p95).toBeCloseTo(29);
  });
});

describe('histogram bucketing', () => {
  it('picks nice bucket sizes', () => {
    expect(autoBucketSize(90_000, 60)).toBe(2_000); // 90 s → 2 s buckets (45)
    expect(autoBucketSize(3_600_000, 60)).toBe(60_000); // 1 h → 1 min
    expect(autoBucketSize(86_400_000, 60)).toBe(30 * 60_000); // 1 day → 30 min
    expect(autoBucketSize(0)).toBe(1000);
  });

  it('aligns buckets and counts values, including the max', () => {
    const h = histogram([1000, 1500, 2999, 3000, 9999], 1000, 9999, 2000);
    expect(h.start).toBe(0);
    expect(Array.from(h.counts)).toEqual([2, 2, 0, 0, 1]);
    const total = Array.from(h.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(5);
  });

  it('ignores NaN and out-of-range values', () => {
    const h = histogram([Number.NaN, 5, 15, 25], 10, 20, 10);
    expect(Array.from(h.counts)).toEqual([1, 0]);
  });
});

describe('insights + export on the sample', () => {
  const { rows, schema } = parseText(readFileSync('fixtures/sample-iis.log', 'utf8'));
  const index = buildLogIndex(rows, schema);
  const all = Uint32Array.from(rows.map((_, i) => i));

  it('computes summary cards', () => {
    const ins = computeInsights(rows, schema, index, all);
    expect(ins.total).toBe(16);
    expect(ins.errors).toBe(13);
    expect(ins.duration?.max).toBe(4414);
    expect(ins.bytesSent).toBe(13 * 639 + 3262 + 3260 * 2);
    expect(ins.slowest[0]).toEqual({ id: 11, duration: 4414 });
    expect(ins.slowest).toHaveLength(10);
    expect(ins.distribution.map((d) => [d.key, d.count])).toEqual([
      ['404', 13],
      ['200', 3],
    ]);
    expect(ins.topIps[0]).toMatchObject({ key: '10.20.0.12', count: 6 });
    const counts = Array.from(ins.timeline!.counts);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(16);
  });

  it('exports CSV with quoting and JSON', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape(null)).toBe('');
    const cols = schema.filter((c) => ['timestamp', 'c-ip', 'sc-status'].includes(c.key));
    const csv = toCsvParts(rows, [0, 1], cols).join('');
    expect(csv).toBe('timestamp,c-ip,sc-status\r\n2026-03-14T09:12:02.000Z,10.20.0.11,404\r\n2026-03-14T09:12:04.000Z,10.20.0.12,404\r\n');
    const json = JSON.parse(toJsonParts(rows, [4], schema).join('')) as Record<string, unknown>[];
    expect(json[0]).toMatchObject({ lineNo: 7, 's-sitename': 'DEMO-API-PROD', isScm: true, 'cs-uri-query': null });
  });
});
