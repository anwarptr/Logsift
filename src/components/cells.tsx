import type { ReactNode } from 'react';
import type { CellValue, ColumnDef } from '../parser';
import { formatTimestamp } from '../utils/format';

export function statusClass(v: CellValue): string {
  if (typeof v !== 'number') return '';
  if (v >= 500) return 's5xx';
  if (v >= 400) return 's4xx';
  if (v >= 300) return 's3xx';
  if (v >= 200) return 's2xx';
  return '';
}

export function levelClass(v: CellValue): string {
  if (typeof v !== 'string') return '';
  switch (v.toUpperCase()) {
    case 'FATAL':
    case 'CRITICAL':
      return 'lv-fatal';
    case 'ERROR':
    case 'ERR':
      return 'lv-error';
    case 'WARN':
    case 'WARNING':
      return 'lv-warn';
    case 'INFO':
    case 'INFORMATION':
      return 'lv-info';
    case 'DEBUG':
    case 'TRACE':
      return 'lv-debug';
    default:
      return '';
  }
}

/** Plain-text representation of a cell, used for display, search and export. */
export function cellText(col: ColumnDef, v: CellValue): string {
  if (v === null || v === undefined) return '';
  if (col.type === 'timestamp' && typeof v === 'number') return formatTimestamp(v);
  return String(v);
}

/** Wrap regex matches in <mark>. The regex must have the global flag. */
export function highlight(text: string, re: RegExp | null): ReactNode {
  if (!re || text.length === 0) return text;
  re.lastIndex = 0;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) !== null && guard++ < 100) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<mark key={m.index}>{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  if (out.length === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderCell(col: ColumnDef, v: CellValue, re: RegExp | null): ReactNode {
  if (v === null || v === undefined) return <span className="null">-</span>;
  if (col.type === 'boolean') return v ? <span className="bool-true">yes</span> : <span className="muted">no</span>;
  const text = cellText(col, v);
  if (col.role === 'status') return <span className={`pill ${statusClass(v)}`}>{highlight(text, re)}</span>;
  if (col.role === 'level') return <span className={`pill ${levelClass(v)}`}>{highlight(text, re)}</span>;
  if (col.role === 'message') return highlight(text.split('\n', 1)[0] ?? '', re);
  return highlight(text, re);
}
