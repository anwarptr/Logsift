import { describe, expect, it } from 'vitest';
import { evaluateFilters } from '../../src/filters/applyFilters';
import { buildLogIndex } from '../../src/filters/logIndex';
import { EMPTY_FILTERS } from '../../src/filters/types';
import { parseText } from '../../src/parser';
import { changedPatterns, compareRanges, compareRows, perMinute, worseEndpoints } from '../../src/utils/compare';
import { getPatternIndex } from '../../src/utils/messagePatterns';

const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);
const MIN = 60_000;

/** A Serilog text log: 10:00–10:30 healthy; 10:30–11:00 orders fail and slow down, a new error appears. */
function sampleLog(): string {
  const lines: string[] = [];
  const at = (ms: number) => {
    const d = new Date(ms);
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 23)} +00:00`;
  };
  for (let m = 0; m < 60; m++) {
    const t = T0 + m * MIN;
    const late = m >= 30;
    lines.push(`${at(t)} [INF] HTTP GET /api/products/${m} responded 200 in ${10 + (m % 5)}.0 ms`);
    lines.push(`${at(t + 1000)} [INF] HTTP POST /api/orders responded ${late ? 500 : 200} in ${late ? 900 : 40}.0 ms`);
    if (late) lines.push(`${at(t + 2000)} [ERR] Payment gateway timeout for order ${1000 + m}`);
    if (late && m % 10 === 0) lines.push(`${at(t + 3000)} [INF] HTTP GET /api/reports/new responded 200 in 5.0 ms`);
  }
  return lines.join('\n') + '\n';
}

function setup() {
  const r = parseText(sampleLog());
  const index = buildLogIndex(r.rows, r.schema);
  const ev = evaluateFilters(r.rows, index, EMPTY_FILTERS, { slowThresholdMs: 1000 });
  const pidx = getPatternIndex(r.rows, index.messageKey!);
  return { r, index, ev, pidx };
}

describe('compareRanges', () => {
  const min = T0;
  const max = T0 + 60 * MIN;

  it('splits in halves by default, and at a chosen time', () => {
    expect(compareRanges({ preset: 'halves', splitAt: null }, min, max)).toEqual({
      a: { from: min, to: T0 + 30 * MIN },
      b: { from: T0 + 30 * MIN, to: max + 1 },
    });
    expect(compareRanges({ preset: 'split', splitAt: T0 + 50 * MIN }, min, max)!.b.from).toBe(T0 + 50 * MIN);
    // A split outside the log is kept inside it.
    expect(compareRanges({ preset: 'split', splitAt: T0 - MIN }, min, max)!.a).toEqual({ from: min, to: min + 1 });
  });

  it('ends "last …" presets at the newest row', () => {
    expect(compareRanges({ preset: 'last15m', splitAt: null }, min, max)).toEqual({
      a: { from: max + 1 - 30 * MIN, to: max + 1 - 15 * MIN },
      b: { from: max + 1 - 15 * MIN, to: max + 1 },
    });
  });

  it('needs a time span', () => {
    expect(compareRanges({ preset: 'halves', splitAt: null }, null, null)).toBeNull();
    expect(compareRanges({ preset: 'halves', splitAt: null }, T0, T0)).toBeNull();
  });
});

describe('compareRows', () => {
  it('compares rates per minute, error rate and p95', () => {
    const { index, ev, pidx } = setup();
    const ranges = compareRanges({ preset: 'halves', splitAt: null }, index.minTs, index.maxTs)!;
    const c = compareRows(index, ev.matched, ranges, pidx);
    expect(c.a.rows + c.b.rows).toBe(ev.matched.length);
    expect(c.a.errors).toBe(0);
    expect(c.b.errors).toBeGreaterThanOrEqual(60); // 30 failed orders + 30 ERR lines
    expect(c.b.p95).toBeGreaterThan(c.a.p95);
    expect(c.a.minutes).toBeCloseTo(c.b.minutes, 0);
  });

  it('finds the endpoint that got worse, and the new one', () => {
    const { index, ev, pidx } = setup();
    const c = compareRows(index, ev.matched, compareRanges({ preset: 'halves', splitAt: null }, index.minTs, index.maxTs)!, pidx);
    const worse = worseEndpoints(c, 'errors');
    expect(worse[0]!.pattern).toBe('/api/orders');
    expect(worse[0]!.a).toMatchObject({ errors: 0 });
    expect(worse[0]!.b.errors).toBe(30);
    expect(worseEndpoints(c, 'slower')[0]!.pattern).toBe('/api/orders');
    const traffic = worseEndpoints(c, 'traffic');
    expect(traffic.map((e) => e.pattern)).toContain('/api/reports/new');
    expect(traffic.find((e) => e.pattern === '/api/reports/new')!.a.count).toBe(0);
  });

  it('lists new messages first, with an example row', () => {
    const { r, index, ev, pidx } = setup();
    const c = compareRows(index, ev.matched, compareRanges({ preset: 'halves', splitAt: null }, index.minTs, index.maxTs)!, pidx);
    const changed = changedPatterns(c);
    expect(changed[0]).toMatchObject({ isNew: true, a: 0, b: 30, errorsB: 30 });
    expect(changed[0]!.pattern).toMatch(/^Payment gateway timeout for order/);
    expect(String(r.rows[changed[0]!.sampleId]!.values.message)).toMatch(/^Payment gateway timeout/);
    expect(perMinute(changed[0]!.b, c.b)).toBeGreaterThan(0.9);
  });

  it('lists values only in the later range (a new status code)', () => {
    const { index, ev, pidx } = setup();
    const c = compareRows(index, ev.matched, compareRanges({ preset: 'halves', splitAt: null }, index.minTs, index.maxTs)!, pidx);
    const status = c.newValues.find((v) => v.key === 'StatusCode');
    expect(status?.values.map((v) => v.value)).toEqual(['500']);
    const level = c.newValues.find((v) => v.key === 'level');
    expect(level?.values.map((v) => v.value)).toEqual(['ERROR']);
  });

  it('says nothing changed when both ranges are alike', () => {
    const { index, ev, pidx } = setup();
    // 10:00–10:15 vs 10:15–10:30: both before the trouble.
    const c = compareRows(index, ev.matched, { a: { from: T0, to: T0 + 15 * MIN }, b: { from: T0 + 15 * MIN, to: T0 + 30 * MIN } }, pidx);
    expect(worseEndpoints(c, 'errors')).toEqual([]);
    expect(changedPatterns(c)).toEqual([]);
    expect(c.newValues).toEqual([]);
  });
});
