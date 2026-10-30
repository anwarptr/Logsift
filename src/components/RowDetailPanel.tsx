import { useEffect, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { facetKey } from '../filters/types';
import { hasActiveFilters } from '../filters/urlState';
import { useDisplayZone, useLogIndex } from '../store/useView';
import { copyText } from '../utils/clipboard';
import { rowToJson } from '../utils/export';
import { cellText } from './cells';
import { FrebWaterfall } from './FrebWaterfall';
import { IpInfo } from './IpInfo';

export function RowDetailPanel() {
  const selectedId = useLogStore((s) => s.selectedId);
  const row = useLogStore((s) => (s.selectedId === null ? undefined : s.rows[s.selectedId]));
  const schema = useLogStore((s) => s.schema);
  const select = useLogStore((s) => s.select);
  // A failed request trace's raw text is its event timeline, not a line from the file.
  const isTrace = useLogStore((s) => s.format === 'freb');
  const zone = useDisplayZone();
  const index = useLogIndex();
  const setFilters = useLogStore((s) => s.setFilters);
  const showInFullLog = useLogStore((s) => s.showInFullLog);
  const filtered = useLogStore((s) => hasActiveFilters(s.filters));
  const [copied, setCopied] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setCopied(null);
  }, [selectedId]);

  if (!row) return null;

  /** Show only rows with this value, when the column has a filter that can express it. */
  function onlyThis(key: string, role: string | undefined, v: unknown): (() => void) | null {
    if (v === null || v === undefined) return null;
    if (index?.facets.some((c) => c.key === key)) {
      return () => setFilters({ facets: { ...useLogStore.getState().filters.facets, [key]: [facetKey(v)] } });
    }
    if (role === 'uri' && key === index?.uriKey) return () => setFilters({ uriMode: 'equals', uri: String(v) });
    return null;
  }

  async function copy(kind: 'json' | 'raw') {
    if (!row) return;
    const text = kind === 'json' ? JSON.stringify(rowToJson(row, schema, zone), null, 2) : row.raw;
    const ok = await copyText(text);
    setCopied(ok ? (kind === 'json' ? 'Copied JSON' : isTrace ? 'Copied timeline' : 'Copied raw line') : 'Copy failed');
  }

  return (
    <aside className="detail-panel" aria-label={`Details for line ${row.lineNo}`}>
      <div className="detail-head">
        <h2>
          Line {row.lineNo.toLocaleString()}
          {typeof row.values.sourceFile === 'string' && <span className="detail-file"> · {row.values.sourceFile}</span>}
        </h2>
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
          {isTrace ? 'Copy timeline' : 'Copy raw line'}
        </button>
        {filtered && (
          <button
            type="button"
            className="btn small"
            title="Clear the filters for now to see the rows around this one"
            onClick={() => showInFullLog(row.id)}
          >
            Show in full log
          </button>
        )}
        <span className="muted small-text" role="status" aria-live="polite">
          {copied}
        </span>
      </div>
      <dl className="detail-fields">
        {schema.map((c) => {
          if (!(c.key in row.values)) return null;
          const v = row.values[c.key] ?? null;
          const filter = onlyThis(c.key, c.role, v);
          return (
            <div key={c.key} className="detail-field">
              <dt>
                {c.label}
                {c.derived && <span className="tag">derived</span>}
              </dt>
              <dd className={v === null ? 'null' : undefined}>
                {v === null ? '-' : c.role === 'message' ? <pre>{cellText(c, v, zone)}</pre> : cellText(c, v, zone)}
                {(c.role === 'clientIp' || c.key === 'c-ip') && typeof v === 'string' && <IpInfo ip={v} />}
                {filter && (
                  <button type="button" className="only-this" title={`Show only rows with this ${c.label}`} onClick={filter}>
                    Only this
                  </button>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {isTrace && <FrebWaterfall timeline={row.raw} />}
      <h3>{isTrace ? 'Event timeline' : 'Raw'}</h3>
      <pre className="detail-raw">{row.raw}</pre>
    </aside>
  );
}
