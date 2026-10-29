import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyFilters, compileSearch, evaluateFilters } from '../../src/filters/applyFilters';
import { facetCounts, statusClassCounts, topUris } from '../../src/filters/facets';
import { buildLogIndex } from '../../src/filters/logIndex';
import { EMPTY_FILTERS, NULL_KEY, type FilterState } from '../../src/filters/types';
import { parseText } from '../../src/parser';

const { rows, schema } = parseText(readFileSync('fixtures/sample-iis.log', 'utf8'));
const index = buildLogIndex(rows, schema);
const opts = { slowThresholdMs: 1000 };

const run = (patch: Partial<FilterState>, o = opts) => applyFilters(rows, index, { ...EMPTY_FILTERS, ...patch }, o);
const count = (patch: Partial<FilterState>, o = opts) => run(patch, o).length;
const ts = (hms: string) => Date.parse(`2026-03-14T${hms}Z`);

describe('buildLogIndex', () => {
  it('picks low-cardinality columns as facets and numeric columns as ranges', () => {
    const facetKeys = index.facets.map((f) => f.key);
    expect(facetKeys).toEqual(
      expect.arrayContaining(['s-sitename', 'cs-method', 's-port', 'c-ip', 'cs-host', 'sc-status', 'cs(User-Agent)']),
    );
    expect(facetKeys).not.toContain('cs-username'); // entirely empty
    expect(facetKeys).not.toContain('time-taken');
    expect(index.ranges.map((r) => r.key)).toEqual(expect.arrayContaining(['time-taken', 'sc-bytes', 'cs-bytes']));
    const tt = index.ranges.find((r) => r.key === 'time-taken')!;
    expect([tt.min, tt.max]).toEqual([2, 4414]);
    expect(index.minTs).toBe(ts('09:12:02'));
    expect(index.maxTs).toBe(ts('09:13:32'));
  });
});

describe('applyFilters: individual filters', () => {
  it('no filters → all rows', () => {
    expect(count({})).toBe(16);
  });

  it('global search is case-insensitive', () => {
    expect(count({ search: '10.20.0.11' })).toBe(4);
    expect(count({ search: 'alwayson' })).toBe(6);
    expect(count({ search: 'nope-nothing' })).toBe(0);
  });

  it('plain search escapes regex characters', () => {
    expect(count({ search: '10.20.0.1.' })).toBe(0);
    expect(count({ search: '(' })).toBe(0);
  });

  it('regex search', () => {
    expect(count({ search: '^2026-03-14 09:13', regex: true })).toBe(8);
    expect(count({ search: '\\s200\\s', regex: true })).toBe(3);
  });

  it('invalid regex does not crash and does not filter', () => {
    expect(() => count({ search: '([a-', regex: true })).not.toThrow();
    const ev = evaluateFilters(rows, index, { ...EMPTY_FILTERS, search: '([a-', regex: true }, opts);
    expect(ev.searchError).toBeTruthy();
    expect(ev.matched.length).toBe(16);
    expect(compileSearch('(', true).error).toBeTruthy();
  });

  it('time range (inclusive)', () => {
    expect(count({ timeFrom: ts('09:13:00'), timeTo: ts('09:13:20') })).toBe(5);
    expect(count({ timeFrom: ts('09:13:22') })).toBe(3);
    expect(count({ timeTo: ts('09:12:04') })).toBe(2);
  });

  it('facets (OR within a column)', () => {
    expect(count({ facets: { 'c-ip': ['10.30.0.5'] } })).toBe(3);
    expect(count({ facets: { 'c-ip': ['10.30.0.5', '127.0.0.1'] } })).toBe(6);
    expect(count({ facets: { 'sc-status': ['200'] } })).toBe(3);
    expect(count({ facets: { 'cs(User-Agent)': [NULL_KEY] } })).toBe(10);
    expect(count({ facets: { 'c-ip': [] } })).toBe(16);
  });

  it('status classes', () => {
    expect(count({ statusClasses: ['2xx'] })).toBe(3);
    expect(count({ statusClasses: ['4xx'] })).toBe(13);
    expect(count({ statusClasses: ['5xx'] })).toBe(0);
    expect(count({ statusClasses: ['2xx', '4xx'] })).toBe(16);
  });

  it('numeric ranges', () => {
    expect(count({ ranges: { 'time-taken': [10, null] } })).toBe(6);
    expect(count({ ranges: { 'time-taken': [null, 2] } })).toBe(7);
    expect(count({ ranges: { 'sc-bytes': [3000, 4000] } })).toBe(3);
  });

  it('URI stem modes', () => {
    expect(count({ uri: '/', uriMode: 'equals' })).toBe(16);
    expect(count({ uri: '/api', uriMode: 'startsWith' })).toBe(0);
    expect(count({ uri: '/', uriMode: 'contains' })).toBe(16);
    expect(count({ uri: 'x', uriMode: 'contains' })).toBe(0);
  });

  it('quick toggles', () => {
    expect(count({ hideHealthChecks: true })).toBe(10);
    expect(count({ hideScm: true })).toBe(13);
    expect(count({ onlyErrors: true })).toBe(13);
    expect(count({ onlySlow: true })).toBe(1);
    expect(count({ onlySlow: true }, { slowThresholdMs: 20 })).toBe(3);
  });

  it('hide health checks removes every AlwaysOn / 127.0.0.1 row', () => {
    const idx = run({ hideHealthChecks: true });
    for (const i of idx) {
      const v = rows[i]!.values;
      expect(v['cs(User-Agent)']).not.toBe('AlwaysOn');
      expect(v['c-ip']).not.toBe('127.0.0.1');
    }
  });
});

describe('applyFilters: combined', () => {
  it('ANDs filters together', () => {
    expect(count({ hideHealthChecks: true, facets: { 'c-ip': ['10.20.0.12'] } })).toBe(6);
    expect(count({ hideHealthChecks: true, onlyErrors: true, search: '09:13' })).toBe(4);
    expect(
      count({
        facets: { 'c-ip': ['10.30.0.5'] },
        statusClasses: ['2xx'],
        ranges: { 'time-taken': [20, null] },
        timeFrom: ts('09:12:00'),
        timeTo: ts('09:13:20'),
      }),
    ).toBe(2);
    expect(count({ hideScm: true, statusClasses: ['2xx'] })).toBe(0);
  });

  it('returns indices in file order', () => {
    const idx = [...run({ onlyErrors: true })];
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });
});

describe('facet counts', () => {
  it('count over rows matching all other filters, ignoring the facet itself', () => {
    const ev = evaluateFilters(rows, index, { ...EMPTY_FILTERS, facets: { 'c-ip': ['10.30.0.5'] } }, opts);
    expect(ev.matched.length).toBe(3);
    const ipCol = index.facets.find((f) => f.key === 'c-ip')!;
    const ips = Object.fromEntries(facetCounts(ipCol, ev).map((e) => [e.key, e.count]));
    expect(ips).toEqual({ '10.20.0.12': 6, '10.20.0.11': 4, '127.0.0.1': 3, '10.30.0.5': 3 });
    const statusCol = index.facets.find((f) => f.key === 'sc-status')!;
    const statuses = Object.fromEntries(facetCounts(statusCol, ev).map((e) => [e.key, e.count]));
    expect(statuses).toEqual({ '200': 3, '404': 0 });
  });

  it('status class counts ignore the status class filter', () => {
    const ev = evaluateFilters(rows, index, { ...EMPTY_FILTERS, statusClasses: ['2xx'], hideScm: true }, opts);
    expect(statusClassCounts(index, ev)).toMatchObject({ '2xx': 0, '4xx': 13 });
  });

  it('top URIs', () => {
    const ev = evaluateFilters(rows, index, EMPTY_FILTERS, opts);
    expect(topUris(index, ev)).toEqual([{ key: '/', label: '/', count: 16 }]);
  });
});
