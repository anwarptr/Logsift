export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx';
export const STATUS_CLASSES: StatusClass[] = ['2xx', '3xx', '4xx', '5xx'];

export type UriMode = 'contains' | 'startsWith' | 'equals';

export type Range = [min: number | null, max: number | null];

export interface FilterState {
  /** Global search over the raw line, case-insensitive. */
  search: string;
  regex: boolean;
  /** Inclusive time range in epoch ms. */
  timeFrom: number | null;
  timeTo: number | null;
  /** Selected facet values per column (OR within a column, AND across columns). */
  facets: Record<string, string[]>;
  statusClasses: StatusClass[];
  /** Numeric ranges per column (inclusive). */
  ranges: Record<string, Range>;
  uriMode: UriMode;
  uri: string;
  /** URI pattern from the Endpoints view (see uriPattern); '' = off. */
  endpoint: string;
  /** Message pattern from the Patterns view (see messagePatterns); '' = off. */
  pattern: string;
  hideHealthChecks: boolean;
  hideScm: boolean;
  onlyErrors: boolean;
  onlySlow: boolean;
}

export const EMPTY_FILTERS: FilterState = {
  search: '',
  regex: false,
  timeFrom: null,
  timeTo: null,
  facets: {},
  statusClasses: [],
  ranges: {},
  uriMode: 'contains',
  uri: '',
  endpoint: '',
  pattern: '',
  hideHealthChecks: false,
  hideScm: false,
  onlyErrors: false,
  onlySlow: false,
};

/** Facet values are compared as strings; null gets a sentinel key. */
export const NULL_KEY = '∅';

export function facetKey(v: unknown): string {
  return v === null || v === undefined ? NULL_KEY : String(v);
}

export function facetLabel(key: string): string {
  return key === NULL_KEY ? '(empty)' : key;
}
