import type { ColumnDef, LogRow } from '../parser';
import { formatIsoWithOffset } from './format';
import { UTC_ZONE, type DisplayZone } from './timezone';

function exportValue(col: ColumnDef, v: unknown, zone: DisplayZone): unknown {
  if (v === undefined) return null;
  return col.type === 'timestamp' && typeof v === 'number' ? formatIsoWithOffset(v, zone) : v;
}

/** All fields of a row as a plain object (timestamps as ISO strings with the offset of `zone`). */
export function rowToJson(row: LogRow, schema: ColumnDef[], zone: DisplayZone = UTC_ZONE): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of schema) {
    if (c.key in row.values) out[c.key] = exportValue(c, row.values[c.key], zone);
  }
  return out;
}

/** RFC 4180 quoting: wrap in quotes when the value has a comma, quote, CR or LF. */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV of the given rows/columns, returned as string parts (cheap to turn into a Blob). */
export function toCsvParts(
  rows: readonly LogRow[],
  indices: ArrayLike<number>,
  columns: ColumnDef[],
  zone: DisplayZone = UTC_ZONE,
): string[] {
  const parts: string[] = [columns.map((c) => csvEscape(c.label)).join(',') + '\r\n'];
  for (let i = 0; i < indices.length; i++) {
    const row = rows[indices[i]!]!;
    parts.push(columns.map((c) => csvEscape(exportValue(c, row.values[c.key], zone))).join(',') + '\r\n');
  }
  return parts;
}

/** JSON array of objects with every schema field plus the source line number. */
export function toJsonParts(
  rows: readonly LogRow[],
  indices: ArrayLike<number>,
  schema: ColumnDef[],
  zone: DisplayZone = UTC_ZONE,
): string[] {
  const parts: string[] = ['['];
  for (let i = 0; i < indices.length; i++) {
    const row = rows[indices[i]!]!;
    parts.push((i ? ',\n' : '\n') + JSON.stringify({ lineNo: row.lineNo, ...rowToJson(row, schema, zone) }));
  }
  parts.push('\n]\n');
  return parts;
}

export function exportFileName(source: string | undefined, ext: string): string {
  const base = (source ?? 'logs').replace(/\.[^.]+$/, '').replace(/\s+/g, '-');
  return `${base}-filtered.${ext}`;
}
