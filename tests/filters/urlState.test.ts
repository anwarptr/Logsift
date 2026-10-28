import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, type FilterState } from '../../src/filters/types';
import { hasActiveFilters, parseFilters, serializeFilters } from '../../src/filters/urlState';

describe('urlState', () => {
  it('serializes empty filters to an empty string', () => {
    expect(serializeFilters(EMPTY_FILTERS)).toBe('');
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it('round-trips every filter type', () => {
    const f: FilterState = {
      search: 'GET /api?x=1&y=2 #frag',
      regex: true,
      timeFrom: 1_700_000_000_000,
      timeTo: 1_700_000_360_000,
      facets: { 'c-ip': ['10.0.0.1', '∅'], 'cs-method': ['GET'] },
      statusClasses: ['4xx', '5xx'],
      ranges: { 'time-taken': [100, null], 'sc-bytes': [null, 5000] },
      uriMode: 'startsWith',
      uri: '/api',
      hideHealthChecks: true,
      hideScm: true,
      onlyErrors: true,
      onlySlow: true,
    };
    const hash = serializeFilters(f);
    expect(hash.startsWith('#f=')).toBe(true);
    expect(parseFilters(hash)).toEqual(f);
  });

  it('ignores garbage instead of throwing', () => {
    expect(parseFilters('#f=%7Bnot-json')).toEqual(EMPTY_FILTERS);
    expect(parseFilters('#something-else')).toEqual(EMPTY_FILTERS);
    expect(parseFilters('#f=' + encodeURIComponent('[1,2]'))).toEqual(EMPTY_FILTERS);
    const partial = parseFilters('#f=' + encodeURIComponent(JSON.stringify({ q: 5, sc: ['9xx', '2xx'], r: { a: [1] }, hh: 1 })));
    expect(partial).toEqual({ ...EMPTY_FILTERS, statusClasses: ['2xx'], hideHealthChecks: true });
  });
});
