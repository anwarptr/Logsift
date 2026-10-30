import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BIT_PATTERN, evaluateFilters } from '../../src/filters/applyFilters';
import { buildLogIndex } from '../../src/filters/logIndex';
import { EMPTY_FILTERS } from '../../src/filters/types';
import { parseText } from '../../src/parser';
import { computePatterns, getPatternIndex, messagePattern } from '../../src/utils/messagePatterns';

describe('messagePattern', () => {
  it.each([
    ['Order 123 took 45.6 ms', 'Order {n} took {n} ms'],
    ['User 3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab signed in', 'User {guid} signed in'],
    ['Request from 10.0.0.7:5050 failed', 'Request from {ip} failed'],
    ["Application 'C:\\home\\site\\wwwroot\\' started successfully.", "Application '{…}' started successfully."],
    ['Retry at 2026-10-27T04:42:03.120Z (attempt -2)', 'Retry at {time} (attempt {n})'],
    ['Exit code 0xe0434352, hash 9f86d081884c7d65', 'Exit code {hex}, hash {hex}'],
    ['Line one 1\n   at Stack.Trace() 2', 'Line one {n}'],
  ])('%j → %j', (msg, pattern) => {
    expect(messagePattern(msg)).toBe(pattern);
  });

  it('keeps numbers that are part of names', () => {
    expect(messagePattern('Http2 connection on v1.2 to dw0mdwk00002X')).toBe('Http2 connection on v1.2 to dw0mdwk00002X');
  });
});

describe('patterns over a log', () => {
  const r = parseText(readFileSync('fixtures/sample-serilog.log', 'utf8'));
  const index = buildLogIndex(r.rows, r.schema);
  const levelKey = r.schema.find((c) => c.role === 'level')?.key;

  it('is built once per rows array and groups similar messages', () => {
    const pidx = getPatternIndex(r.rows, index.messageKey!);
    expect(getPatternIndex(r.rows, index.messageKey!)).toBe(pidx);
    const all = evaluateFilters(r.rows, index, EMPTY_FILTERS, { slowThresholdMs: 1000 });
    const stats = computePatterns(r.rows, index, pidx, all.mask, BIT_PATTERN, levelKey);
    expect(stats.reduce((n, p) => n + p.count, 0)).toBe(r.rows.length);
    expect(stats.length).toBeLessThan(r.rows.length);
    // Sorted by count, each with an example row and a time span.
    expect(stats[0]!.count).toBeGreaterThanOrEqual(stats.at(-1)!.count);
    expect(r.rows[stats[0]!.sampleId]).toBeDefined();
    expect(stats[0]!.firstTs).not.toBeNull();
  });

  it('filters rows to one pattern, and the stats can ignore that filter', () => {
    const pidx = getPatternIndex(r.rows, index.messageKey!);
    const top = computePatterns(r.rows, index, pidx, new Uint32Array(r.rows.length), 0, levelKey)[0]!;
    const ev = evaluateFilters(r.rows, index, { ...EMPTY_FILTERS, pattern: top.pattern }, { slowThresholdMs: 1000 });
    expect(ev.matched.length).toBe(top.count);
    const ignoring = computePatterns(r.rows, index, pidx, ev.mask, BIT_PATTERN, levelKey);
    expect(ignoring.reduce((n, p) => n + p.count, 0)).toBe(r.rows.length);
  });
});
