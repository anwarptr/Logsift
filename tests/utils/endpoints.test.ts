import { describe, expect, it } from 'vitest';
import { BIT_ENDPOINT, evaluateFilters } from '../../src/filters/applyFilters';
import { buildLogIndex } from '../../src/filters/logIndex';
import { EMPTY_FILTERS, NULL_KEY } from '../../src/filters/types';
import { parseText } from '../../src/parser';
import { computeEndpoints, uriPattern } from '../../src/utils/endpoints';

describe('uriPattern', () => {
  it.each([
    ['/', '/'],
    ['/api/products/123', '/api/products/{id}'],
    ['/API/Products/123/', '/api/products/{id}'],
    ['/api/users/3f2504e0-4f89-11d3-9a0c-0305e82c3301/orders/42', '/api/users/{guid}/orders/{id}'],
    ['/reports/2026-10-27/daily', '/reports/{date}/daily'],
    ['/blobs/9f86d081884c7d659a2feaa0c55ad015', '/blobs/{hash}'],
    ['/reset/eyJhbGciOiJIUzI1NiJ9abc123XYZ', '/reset/{token}'],
    ['/static/app.js', '/static/app.js'],
    ['/static/main.3b8f9c2a1d4e5f60.bundle.js', '/static/main.3b8f9c2a1d4e5f60.bundle.js'],
    ['/api/v2/items', '/api/v2/items'],
    ['/health', '/health'],
    ['https://shop.example.test/api/Orders/42?x=1', '/api/orders/{id}'],
    ['https://shop.example.test', '/'],
  ])('%s → %s', (uri, pattern) => {
    expect(uriPattern(uri)).toBe(pattern);
  });

  it('does not treat ordinary long words as tokens', () => {
    expect(uriPattern('/internationalization-settings')).toBe('/internationalization-settings');
  });
});

const LOG = [
  '#Fields: date time cs-method cs-uri-stem sc-status time-taken',
  '2026-10-27 10:00:00 GET /api/products/1 200 10',
  '2026-10-27 10:00:01 GET /api/products/2 200 30',
  '2026-10-27 10:00:02 PUT /api/products/3 500 200',
  '2026-10-27 10:00:03 GET /api/products/4 404 20',
  '2026-10-27 10:00:04 GET /health 200 1',
  '2026-10-27 10:00:05 GET - 200 5',
].join('\n');

function setup(filters = EMPTY_FILTERS) {
  const r = parseText(LOG);
  const index = buildLogIndex(r.rows, r.schema);
  const ev = evaluateFilters(r.rows, index, filters, { slowThresholdMs: 1000 });
  return { r, index, ev };
}

describe('endpoint index and stats', () => {
  it('codes each row with its pattern', () => {
    const { index } = setup();
    expect(index.uriPattern!.values).toEqual(['/api/products/{id}', '/health', NULL_KEY]);
  });

  it('computes counts, errors, methods and duration percentiles', () => {
    const { r, index, ev } = setup();
    const stats = computeEndpoints(r.rows, index, ev.mask, BIT_ENDPOINT, 'cs-method');
    expect(stats.map((s) => [s.pattern, s.count, s.errors])).toEqual([
      ['/api/products/{id}', 4, 2],
      ['/health', 1, 0],
      [NULL_KEY, 1, 0],
    ]);
    const products = stats[0]!;
    expect(products.methods).toEqual(['GET', 'PUT']);
    expect(products.avgMs).toBe(65);
    expect(products.p50Ms).toBe(25);
    expect(products.maxMs).toBe(200);
    expect(products.p95Ms).toBeCloseTo(174.5);
  });

  it('the endpoint filter narrows rows but the stats still list every endpoint', () => {
    const { r, index, ev } = setup({ ...EMPTY_FILTERS, endpoint: '/api/products/{id}' });
    expect(ev.matched.length).toBe(4);
    const stats = computeEndpoints(r.rows, index, ev.mask, BIT_ENDPOINT, 'cs-method');
    expect(stats).toHaveLength(3);
  });

  it('other filters still apply to the stats', () => {
    const { r, index, ev } = setup({ ...EMPTY_FILTERS, onlyErrors: true });
    const stats = computeEndpoints(r.rows, index, ev.mask, BIT_ENDPOINT, 'cs-method');
    expect(stats.map((s) => [s.pattern, s.count])).toEqual([['/api/products/{id}', 2]]);
  });
});
