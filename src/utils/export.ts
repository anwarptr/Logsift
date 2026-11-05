import type { ColumnDef, LogRow } from '../parser';
import { formatIsoWithOffset, formatNumber, formatTimestamp } from './format';
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

/** Rows included in a Markdown copy (it is for pasting into a ticket or chat, not a full export). */
export const MARKDOWN_MAX_ROWS = 50;
const MARKDOWN_CELL_CHARS = 200;

function markdownCell(col: ColumnDef, v: unknown, zone: DisplayZone): string {
  if (v === null || v === undefined) return '';
  let s = col.type === 'timestamp' && typeof v === 'number' ? formatTimestamp(v, zone) : String(v);
  const nl = s.indexOf('\n');
  if (nl >= 0) s = `${s.slice(0, nl)} …`; // stack traces: first line only
  if (s.length > MARKDOWN_CELL_CHARS) s = `${s.slice(0, MARKDOWN_CELL_CHARS)}…`;
  return markdownEscape(s);
}

/** Backslash-escape characters that would break a Markdown table cell or start formatting. */
const markdownEscape = (s: string) => s.replace(/[\\|`*_]/g, (c) => `\\${c}`);

export interface MarkdownSummary {
  fileName: string;
  totalRows: number;
  /** Active filters, as the chips say them. */
  filters: string[];
  /** Matched rows that are errors, when the log has a notion of errors. */
  errors?: number;
  /** "first → last" of the matched rows, already formatted. */
  timeRange?: string;
}

/**
 * The first rows (in display order, visible columns) as a Markdown table under a short summary,
 * for pasting into an issue, a pull request or chat.
 */
export function toMarkdown(
  rows: readonly LogRow[],
  indices: ArrayLike<number>,
  columns: ColumnDef[],
  summary: MarkdownSummary,
  zone: DisplayZone = UTC_ZONE,
): string {
  const n = indices.length;
  const count = n === summary.totalRows ? `${formatNumber(n)} rows` : `${formatNumber(n)} of ${formatNumber(summary.totalRows)} rows`;
  const errors = summary.errors ? ` · ${formatNumber(summary.errors)} errors` : '';
  const lines = [`**${markdownEscape(summary.fileName)}** · ${count}${errors}`];
  if (summary.filters.length) lines.push(`Filters: ${summary.filters.map(markdownEscape).join(' · ')}`);
  if (summary.timeRange) lines.push(`Time: ${summary.timeRange}`);
  lines.push('');
  lines.push(`| ${columns.map((c) => markdownCell(c, c.label, zone)).join(' | ')} |`);
  lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
  const shown = Math.min(n, MARKDOWN_MAX_ROWS);
  for (let i = 0; i < shown; i++) {
    const row = rows[indices[i]!]!;
    lines.push(`| ${columns.map((c) => markdownCell(c, row.values[c.key], zone)).join(' | ')} |`);
  }
  if (n > shown) lines.push('', `…and ${formatNumber(n - shown)} more rows.`);
  return lines.join('\n') + '\n';
}
