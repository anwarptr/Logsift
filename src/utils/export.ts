import type { ColumnDef, LogRow } from '../parser';

function exportValue(col: ColumnDef, v: unknown): unknown {
  if (v === undefined) return null;
  return col.type === 'timestamp' && typeof v === 'number' ? new Date(v).toISOString() : v;
}

/** All fields of a row as a plain object (timestamps as ISO strings). */
export function rowToJson(row: LogRow, schema: ColumnDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of schema) {
    if (c.key in row.values) out[c.key] = exportValue(c, row.values[c.key]);
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
export function toCsvParts(rows: readonly LogRow[], indices: ArrayLike<number>, columns: ColumnDef[]): string[] {
  const parts: string[] = [columns.map((c) => csvEscape(c.label)).join(',') + '\r\n'];
  for (let i = 0; i < indices.length; i++) {
    const row = rows[indices[i]!]!;
    parts.push(columns.map((c) => csvEscape(exportValue(c, row.values[c.key]))).join(',') + '\r\n');
  }
  return parts;
}

/** JSON array of objects with every schema field plus the source line number. */
export function toJsonParts(rows: readonly LogRow[], indices: ArrayLike<number>, schema: ColumnDef[]): string[] {
  const parts: string[] = ['['];
  for (let i = 0; i < indices.length; i++) {
    const row = rows[indices[i]!]!;
    parts.push((i ? ',\n' : '\n') + JSON.stringify({ lineNo: row.lineNo, ...rowToJson(row, schema) }));
  }
  parts.push('\n]\n');
  return parts;
}

export function exportFileName(source: string | undefined, ext: string): string {
  const base = (source ?? 'logs').replace(/\.[^.]+$/, '');
  return `${base}-filtered.${ext}`;
}
