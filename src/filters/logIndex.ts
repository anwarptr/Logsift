import type { ColumnDef, ColumnRole, LogRow } from '../parser';
import { uriPattern } from '../utils/uriPattern';
import { facetKey, NULL_KEY } from './types';

/** A column is a facet if it has fewer than this many distinct values. */
export const FACET_MAX_DISTINCT = 200;
/** Facet bits share a 32-bit mask with the other predicates. */
const MAX_FACETS = 24;

/** Roles that have dedicated filters (or no useful facet), so they never become facet lists. */
const NON_FACET_ROLES = new Set<ColumnRole>([
  'timestamp',
  'message',
  'uri',
  'uriQuery',
  'duration',
  'bytesSent',
  'bytesReceived',
  'healthCheck',
  'scm',
]);
const NON_FACET_KEYS = new Set(['arrLogId', 'cs(Cookie)', 'timestamp_raw']);
/** Numeric roles that always get a range slider. */
const RANGE_ROLES = new Set<ColumnRole>(['duration', 'bytesSent', 'bytesReceived']);

export interface FacetColumn {
  key: string;
  label: string;
  /** Dictionary code per row. */
  codes: Uint16Array;
  /** Distinct value keys (see facetKey), indexed by code. */
  values: string[];
}

export interface RangeColumn {
  key: string;
  label: string;
  values: Float64Array;
  min: number;
  max: number;
}

/**
 * Columnar, typed view of the rows built once per load. Filtering reads these
 * arrays instead of the row objects, so applying a filter never re-parses.
 */
export interface LogIndex {
  n: number;
  ts: Float64Array;
  minTs: number | null;
  maxTs: number | null;
  facets: FacetColumn[];
  ranges: RangeColumn[];
  status: Float64Array | null;
  duration: Float64Array | null;
  durationKey: string | null;
  uri: (string | null)[] | null;
  uriKey: string | null;
  /** Column with the message role; message patterns (see messagePatterns) are built from it on demand. */
  messageKey: string | null;
  /** URI pattern per row (see uriPattern), dictionary-coded; NULL_KEY for rows without a URI. */
  uriPattern: { codes: Uint32Array; values: string[] } | null;
  /** Bit flags per row: 1 = health check, 2 = SCM, 4 = error level. */
  flags: Uint8Array;
  hasHealthCheck: boolean;
  hasScm: boolean;
  hasStatus: boolean;
  hasLevel: boolean;
}

export const FLAG_HEALTH = 1;
export const FLAG_SCM = 2;
export const FLAG_ERROR_LEVEL = 4;

/**
 * A row is an error when its HTTP status is ≥ 400; rows without a status (application lines mixed
 * in with request lines, as in Serilog text logs) fall back to an ERROR/FATAL level.
 */
export function isErrorRow(index: LogIndex, r: number): boolean {
  const st = index.status ? index.status[r]! : Number.NaN;
  return Number.isNaN(st) ? (index.flags[r]! & FLAG_ERROR_LEVEL) !== 0 : st >= 400;
}

export type ErrorBasis = 'status' | 'level' | 'status+level' | null;

export function errorBasisOf(index: LogIndex): ErrorBasis {
  if (index.hasStatus) return index.hasLevel ? 'status+level' : 'status';
  return index.hasLevel ? 'level' : null;
}

/** Short description of what counts as an error, for labels. */
export const ERROR_BASIS_LABELS: Record<NonNullable<ErrorBasis>, string> = {
  status: '≥ 400',
  level: 'ERROR/FATAL',
  'status+level': '≥ 400 or ERROR',
};

function byRole(schema: ColumnDef[], role: ColumnRole): ColumnDef | undefined {
  return schema.find((c) => c.role === role);
}

function numericColumn(rows: readonly LogRow[], key: string): Float64Array {
  const out = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i]!.values[key];
    out[i] = typeof v === 'number' ? v : Number.NaN;
  }
  return out;
}

function tryFacet(rows: readonly LogRow[], col: ColumnDef): FacetColumn | null {
  const codes = new Uint16Array(rows.length);
  const dict = new Map<string, number>();
  const values: string[] = [];
  const key = col.key;
  for (let i = 0; i < rows.length; i++) {
    const k = facetKey(rows[i]!.values[key]);
    let code = dict.get(k);
    if (code === undefined) {
      if (values.length >= FACET_MAX_DISTINCT) return null;
      code = values.length;
      dict.set(k, code);
      values.push(k);
    }
    codes[i] = code;
  }
  // A column that is entirely empty is not useful as a filter.
  if (values.length === 1 && values[0] === NULL_KEY) return null;
  return { key, label: col.label, codes, values };
}

export function buildLogIndex(rows: readonly LogRow[], schema: ColumnDef[]): LogIndex {
  const n = rows.length;
  const ts = new Float64Array(n);
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = rows[i]!.ts;
    if (t === null) {
      ts[i] = Number.NaN;
    } else {
      ts[i] = t;
      if (t < minTs) minTs = t;
      if (t > maxTs) maxTs = t;
    }
  }

  const facets: FacetColumn[] = [];
  const ranges: RangeColumn[] = [];
  for (const col of schema) {
    if (col.type === 'timestamp') continue;
    const forcedRange = col.role !== undefined && RANGE_ROLES.has(col.role);
    const facetable =
      !forcedRange && !(col.role && NON_FACET_ROLES.has(col.role)) && !NON_FACET_KEYS.has(col.key) && col.type !== 'boolean';
    const facet = facetable && facets.length < MAX_FACETS ? tryFacet(rows, col) : null;
    if (facet) {
      facets.push(facet);
    } else if (col.type === 'number') {
      const values = numericColumn(rows, col.key);
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = values[i]!;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min <= max) ranges.push({ key: col.key, label: col.label, values, min, max });
    }
  }

  const statusCol = byRole(schema, 'status');
  const durationCol = byRole(schema, 'duration');
  const uriCol = byRole(schema, 'uri');
  const levelCol = byRole(schema, 'level');
  const healthCol = byRole(schema, 'healthCheck');
  const scmCol = byRole(schema, 'scm');

  const flags = new Uint8Array(n);
  if (healthCol || scmCol || levelCol) {
    for (let i = 0; i < n; i++) {
      const v = rows[i]!.values;
      let f = 0;
      if (healthCol && v[healthCol.key] === true) f |= FLAG_HEALTH;
      if (scmCol && v[scmCol.key] === true) f |= FLAG_SCM;
      if (levelCol) {
        const lv = v[levelCol.key];
        if (typeof lv === 'string' && /^(error|err|fatal|critical|crit|emerg|emergency|alert)$/i.test(lv)) f |= FLAG_ERROR_LEVEL;
      }
      flags[i] = f;
    }
  }

  let uri: (string | null)[] | null = null;
  let uriPatternIdx: LogIndex['uriPattern'] = null;
  if (uriCol) {
    uri = new Array<string | null>(n);
    const codes = new Uint32Array(n);
    const values: string[] = [];
    const byPattern = new Map<string, number>();
    // Distinct URIs are few compared to rows, so normalise each once.
    const byUri = new Map<string | null, number>();
    for (let i = 0; i < n; i++) {
      const v = rows[i]!.values[uriCol.key];
      const u = v === null || v === undefined ? null : String(v);
      uri[i] = u;
      let code = byUri.get(u);
      if (code === undefined) {
        const p = u === null ? NULL_KEY : uriPattern(u);
        code = byPattern.get(p);
        if (code === undefined) {
          code = values.length;
          values.push(p);
          byPattern.set(p, code);
        }
        byUri.set(u, code);
      }
      codes[i] = code;
    }
    uriPatternIdx = { codes, values };
  }

  return {
    n,
    ts,
    minTs: minTs <= maxTs ? minTs : null,
    maxTs: minTs <= maxTs ? maxTs : null,
    facets,
    ranges,
    status: statusCol ? numericColumn(rows, statusCol.key) : null,
    duration: durationCol ? numericColumn(rows, durationCol.key) : null,
    durationKey: durationCol?.key ?? null,
    uri,
    uriKey: uriCol?.key ?? null,
    messageKey: byRole(schema, 'message')?.key ?? null,
    uriPattern: uriPatternIdx,
    flags,
    hasHealthCheck: !!healthCol,
    hasScm: !!scmCol,
    hasStatus: !!statusCol,
    hasLevel: !!levelCol,
  };
}
