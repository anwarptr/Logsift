import { useEffect, useRef, useState } from 'react';
import type { ColumnDef, LogRow } from '../parser';
import { useLogStore } from '../store/logStore';
import { copyText } from '../utils/clipboard';
import { cellText } from './cells';

export function rowToJson(row: LogRow, schema: ColumnDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of schema) {
    if (!(c.key in row.values)) continue;
    const v = row.values[c.key] ?? null;
    out[c.key] = c.type === 'timestamp' && typeof v === 'number' ? new Date(v).toISOString() : v;
  }
  return out;
}

export function RowDetailPanel() {
  const selectedId = useLogStore((s) => s.selectedId);
  const row = useLogStore((s) => (s.selectedId === null ? undefined : s.rows[s.selectedId]));
  const schema = useLogStore((s) => s.schema);
  const select = useLogStore((s) => s.select);
  const [copied, setCopied] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setCopied(null);
  }, [selectedId]);

  if (!row) return null;

  async function copy(kind: 'json' | 'raw') {
    if (!row) return;
    const text = kind === 'json' ? JSON.stringify(rowToJson(row, schema), null, 2) : row.raw;
    const ok = await copyText(text);
    setCopied(ok ? (kind === 'json' ? 'Copied JSON' : 'Copied raw line') : 'Copy failed');
  }

  return (
    <aside className="detail-panel" aria-label={`Details for line ${row.lineNo}`}>
      <div className="detail-head">
        <h2>Line {row.lineNo.toLocaleString()}</h2>
        <button
          ref={closeRef}
          type="button"
          className="btn small ghost"
          aria-label="Close details (Esc)"
          onClick={() => select(null)}
        >
          ✕
        </button>
      </div>
      <div className="detail-actions">
        <button type="button" className="btn small" onClick={() => copy('json')}>
          Copy as JSON
        </button>
        <button type="button" className="btn small" onClick={() => copy('raw')}>
          Copy raw line
        </button>
        <span className="muted small-text" role="status" aria-live="polite">
          {copied}
        </span>
      </div>
      <dl className="detail-fields">
        {schema.map((c) => {
          if (!(c.key in row.values)) return null;
          const v = row.values[c.key] ?? null;
          return (
            <div key={c.key} className="detail-field">
              <dt>
                {c.label}
                {c.derived && <span className="tag">derived</span>}
              </dt>
              <dd className={v === null ? 'null' : undefined}>
                {v === null ? '-' : c.role === 'message' ? <pre>{cellText(c, v)}</pre> : cellText(c, v)}
              </dd>
            </div>
          );
        })}
      </dl>
      <h3>Raw</h3>
      <pre className="detail-raw">{row.raw}</pre>
    </aside>
  );
}
