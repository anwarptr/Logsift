import { EMPTY_FILTERS, STATUS_CLASSES, type FilterState, type Range, type StatusClass, type UriMode } from './types';

/** Compact wire format: short keys, defaults omitted. */
interface Wire {
  q?: string;
  rx?: 1;
  tf?: number;
  tt?: number;
  f?: Record<string, string[]>;
  sc?: string[];
  r?: Record<string, [number | null, number | null]>;
  um?: UriMode;
  u?: string;
  ep?: string;
  pt?: string;
  hh?: 1;
  hs?: 1;
  oe?: 1;
  os?: 1;
}

const HASH_PREFIX = '#f=';

export function serializeFilters(f: FilterState): string {
  const w: Wire = {};
  if (f.search) w.q = f.search;
  if (f.regex) w.rx = 1;
  if (f.timeFrom !== null) w.tf = f.timeFrom;
  if (f.timeTo !== null) w.tt = f.timeTo;
  const facets = Object.entries(f.facets).filter(([, v]) => v.length > 0);
  if (facets.length) w.f = Object.fromEntries(facets);
  if (f.statusClasses.length) w.sc = [...f.statusClasses];
  const ranges = Object.entries(f.ranges).filter(([, r]) => r[0] !== null || r[1] !== null);
  if (ranges.length) w.r = Object.fromEntries(ranges);
  if (f.uri) {
    w.u = f.uri;
    if (f.uriMode !== 'contains') w.um = f.uriMode;
  }
  if (f.endpoint) w.ep = f.endpoint;
  if (f.pattern) w.pt = f.pattern;
  if (f.hideHealthChecks) w.hh = 1;
  if (f.hideScm) w.hs = 1;
  if (f.onlyErrors) w.oe = 1;
  if (f.onlySlow) w.os = 1;
  if (Object.keys(w).length === 0) return '';
  return HASH_PREFIX + encodeURIComponent(JSON.stringify(w));
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNumOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parse a location hash. Anything malformed is ignored rather than thrown. */
export function parseFilters(hash: string): FilterState {
  const out: FilterState = { ...EMPTY_FILTERS, facets: {}, ranges: {}, statusClasses: [] };
  if (!hash.startsWith(HASH_PREFIX)) return out;
  let w: unknown;
  try {
    w = JSON.parse(decodeURIComponent(hash.slice(HASH_PREFIX.length)));
  } catch {
    return out;
  }
  if (!isObj(w)) return out;
  if (isStr(w.q)) out.search = w.q;
  out.regex = w.rx === 1;
  if (typeof w.tf === 'number' && Number.isFinite(w.tf)) out.timeFrom = w.tf;
  if (typeof w.tt === 'number' && Number.isFinite(w.tt)) out.timeTo = w.tt;
  if (isObj(w.f)) {
    for (const [k, v] of Object.entries(w.f)) {
      if (Array.isArray(v)) {
        const vals = v.filter(isStr);
        if (vals.length) out.facets[k] = vals;
      }
    }
  }
  if (Array.isArray(w.sc)) {
    out.statusClasses = w.sc.filter((c): c is StatusClass => (STATUS_CLASSES as string[]).includes(c as string) || c === '1xx');
  }
  if (isObj(w.r)) {
    for (const [k, v] of Object.entries(w.r)) {
      if (Array.isArray(v) && v.length === 2 && isNumOrNull(v[0]) && isNumOrNull(v[1])) out.ranges[k] = [v[0], v[1]] as Range;
    }
  }
  if (isStr(w.u)) out.uri = w.u;
  if (isStr(w.ep)) out.endpoint = w.ep;
  if (isStr(w.pt)) out.pattern = w.pt;
  if (w.um === 'startsWith' || w.um === 'equals' || w.um === 'contains') out.uriMode = w.um;
  out.hideHealthChecks = w.hh === 1;
  out.hideScm = w.hs === 1;
  out.onlyErrors = w.oe === 1;
  out.onlySlow = w.os === 1;
  return out;
}

export function hasActiveFilters(f: FilterState): boolean {
  return serializeFilters(f) !== '';
}
