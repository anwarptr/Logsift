import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveDemo, DEMO_HISTORY_MS, DEMO_INCIDENT_MS, generateIncidentLog, serilogTime } from '../../src/demo';
import { evaluateFilters } from '../../src/filters/applyFilters';
import { buildLogIndex } from '../../src/filters/logIndex';
import { EMPTY_FILTERS } from '../../src/filters/types';
import { parseText } from '../../src/parser';
import { SAMPLES } from '../../src/samples';
import { changedPatterns, compareRows, worseEndpoints } from '../../src/utils/compare';
import { getPatternIndex } from '../../src/utils/messagePatterns';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

afterEach(() => {
  vi.useRealTimers();
});

describe('incident demo log', () => {
  const r = parseText(generateIncidentLog(NOW));
  const index = buildLogIndex(r.rows, r.schema);

  it('is a Serilog log of two hours with request columns', () => {
    expect(r.format).toBe('generic');
    expect(r.malformed).toEqual([]);
    expect(r.rows.length).toBeGreaterThan(1000);
    expect(index.maxTs! - index.minTs!).toBeGreaterThan(DEMO_HISTORY_MS - 10 * 60_000);
    expect(r.schema.map((c) => c.key)).toEqual(expect.arrayContaining(['RequestMethod', 'RequestPath', 'StatusCode', 'Elapsed']));
  });

  it('is the same each time', () => {
    expect(generateIncidentLog(NOW)).toBe(generateIncidentLog(NOW));
  });

  it('lets Compare find the failing payments', () => {
    const ev = evaluateFilters(r.rows, index, EMPTY_FILTERS, { slowThresholdMs: 1000 });
    const split = NOW - DEMO_INCIDENT_MS;
    const c = compareRows(
      index,
      ev.matched,
      { a: { from: index.minTs!, to: split }, b: { from: split, to: index.maxTs! + 1 } },
      getPatternIndex(r.rows, index.messageKey!),
    );
    expect(worseEndpoints(c, 'errors')[0]!.pattern).toBe('/api/payments');
    expect(worseEndpoints(c, 'slower')[0]!.pattern).toBe('/api/payments');
    expect(changedPatterns(c)[0]!.pattern).toMatch(/^Payment gateway timeout/);
    expect(c.newValues.find((v) => v.key === 'StatusCode')?.values.map((v) => v.value)).toContain('504');
  });

  it('writes times like Serilog, in local time with the offset', () => {
    expect(serilogTime(NOW)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2}$/);
  });
});

describe('live demo', () => {
  it('keeps writing lines until stopped', async () => {
    vi.useFakeTimers();
    const demo = createLiveDemo(NOW);
    const size0 = (await demo.handle.getFile()).size;
    vi.advanceTimersByTime(4600);
    const f = await demo.handle.getFile();
    expect(f.size).toBeGreaterThan(size0);
    expect(f.name).toBe('payments-api.log');
    demo.stop();
    vi.advanceTimersByTime(5000);
    expect((await demo.handle.getFile()).size).toBe(f.size);
  });
});

describe('bundled samples', () => {
  it.each(SAMPLES.map((s) => [s.label, s] as const))('%s opens without malformed lines', (_label, s) => {
    const r = parseText(s.text);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.malformed).toEqual([]);
  });
});
