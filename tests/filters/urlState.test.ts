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
      endpoint: '/api/products/{id}',
      pattern: 'Order {n} took {n} ms',
      hideHealthChecks: true,
      hideScm: true,
      onlyErrors: true,
      onlySlow: true,
    };
    const hash = serializeFilters(f);
    expect(hash.startsWith('#f=')).toBe(true);
    expect(parseFilters(hash)).toEqual(f);
  });

  it('searches a link regex that could freeze the tab as plain text', () => {
    const fromLink = (q: string) => parseFilters('#f=' + encodeURIComponent(JSON.stringify({ q, rx: 1 })));
    for (const q of ['(a+)+$', '(\\w*\\s?)*x', '(a|ab)*c', '((a+)b)+', '(x+){2,}', '(?:a*)*'])
      expect(fromLink(q), q).toMatchObject({ search: q, regex: false });
    for (const q of ['(\\d{1,3}\\.){3}\\d{1,3}', 'timeout|refused', '(GET|POST) /api', '\\(a+\\)+', '[(a+)]+', 'error \\d+ms'])
      expect(fromLink(q), q).toMatchObject({ search: q, regex: true });
  });

  it('ignores garbage instead of throwing', () => {
    expect(parseFilters('#f=%7Bnot-json')).toEqual(EMPTY_FILTERS);
    expect(parseFilters('#something-else')).toEqual(EMPTY_FILTERS);
    expect(parseFilters('#f=' + encodeURIComponent('[1,2]'))).toEqual(EMPTY_FILTERS);
    const partial = parseFilters('#f=' + encodeURIComponent(JSON.stringify({ q: 5, sc: ['9xx', '2xx'], r: { a: [1] }, hh: 1 })));
    expect(partial).toEqual({ ...EMPTY_FILTERS, statusClasses: ['2xx'], hideHealthChecks: true });
  });
});
