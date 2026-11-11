import { useEffect, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { facetKey } from '../filters/types';
import { hasActiveFilters } from '../filters/urlState';
import { useDisplayZone, useLogIndex } from '../store/useView';
import { copyText } from '../utils/clipboard';
import { rowToJson } from '../utils/export';
import { cellText, levelClass, statusClass } from './cells';
import { FrebWaterfall } from './FrebWaterfall';
import { IpInfo } from './IpInfo';

const TRACE_KEYS = [
  'trace-id',
  'traceid',
  'trace_id',
  'x-amzn-trace-id',
  'requestid',
  'request_id',
  'correlationid',
  'correlation_id',
  'spanid',
  'span_id',
];

export function RowDetailPanel() {
  const selectedId = useLogStore((s) => s.selectedId);
  const rows = useLogStore((s) => s.rows);
  const row = useLogStore((s) => {
    if (s.selectedId === null) return undefined;
    const direct = s.rows[s.selectedId];
    if (direct && direct.id === s.selectedId) return direct;
    return s.rows.find((r) => r.id === s.selectedId) ?? direct;
  });
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

  const traceEntry = Object.entries(row.values).find(
    ([k, v]) => TRACE_KEYS.includes(k.toLowerCase()) && typeof v === 'string' && v.trim().length > 0,
  );

  /** Filter or exclude by this field value. Uses facets when available, else search syntax. */
  function filterByField(key: string, role: string | undefined, v: unknown, exclude = false) {
    if (v === null || v === undefined) return;
    if (index?.facets.some((c) => c.key === key) && !exclude) {
      setFilters({ facets: { ...useLogStore.getState().filters.facets, [key]: [facetKey(v)] } });
      return;
    }
    if (role === 'uri' && key === index?.uriKey && !exclude) {
      setFilters({ uriMode: 'equals', uri: String(v) });
      return;
    }
    const strVal = String(v);
    const token = `${exclude ? '-' : ''}${key}:"${strVal.replace(/"/g, '\\"')}"`;
    const cur = useLogStore.getState().filters.search.trim();
    setFilters({ search: cur ? `${cur} ${token}` : token });
  }

  async function copy(kind: 'json' | 'raw') {
    if (!row) return;
    const text = kind === 'json' ? JSON.stringify(rowToJson(row, schema, zone), null, 2) : row.raw;
    const ok = await copyText(text);
    setCopied(ok ? (kind === 'json' ? 'Copied JSON' : isTrace ? 'Copied timeline' : 'Copied raw line') : 'Copy failed');
  }

  const rowIndex = rows.findIndex((r) => r.id === row.id);
  const currentIdx = rowIndex >= 0 ? rowIndex : row.id;
  const startIdx = Math.max(0, currentIdx - 3);
  const endIdx = Math.min(rows.length - 1, currentIdx + 3);
  const surroundings = rows.slice(startIdx, endIdx + 1);

  return (
    <aside className="detail-panel" aria-label={`Details for line ${row.lineNo}`}>
      <div className="detail-head">
        <h2>
          Line {row.lineNo.toLocaleString()}
          {typeof row.values.sourceFile === 'string' && <span className="detail-file"> · {row.values.sourceFile}</span>}
          {typeof row.values.logFormat === 'string' && <span className="detail-format"> · {row.values.logFormat}</span>}
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
        {traceEntry && (
          <button
            type="button"
            className="btn small"
            title={`Filter to all log lines for ${traceEntry[0]}: ${traceEntry[1]}`}
            onClick={() => setFilters({ search: `${traceEntry[0]}:"${traceEntry[1]}"` })}
          >
            Trace transaction
          </button>
        )}
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
          return (
            <div key={c.key} className="detail-field">
              <dt>
                {c.label}
                {c.derived && <span className="tag">derived</span>}
              </dt>
              <dd className={v === null ? 'null' : undefined}>
                {v === null ? '-' : c.role === 'message' ? <pre>{cellText(c, v, zone)}</pre> : cellText(c, v, zone)}
                {(c.role === 'clientIp' || c.key === 'c-ip') && typeof v === 'string' && <IpInfo ip={v} />}
                {v !== null && c.type !== 'timestamp' && c.role !== 'message' && (
                  <span className="field-actions">
                    <button
                      type="button"
                      className="only-this"
                      title={`Show only rows with this ${c.label}`}
                      onClick={() => filterByField(c.key, c.role, v, false)}
                    >
                      Only this
                    </button>
                    <button
                      type="button"
                      className="only-this exclude-this"
                      title={`Exclude rows with this ${c.label}`}
                      onClick={() => filterByField(c.key, c.role, v, true)}
                    >
                      Exclude
                    </button>
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {isTrace && <FrebWaterfall timeline={row.raw} />}
      {surroundings.length > 1 && (
        <div className="detail-surroundings">
          <h3>Surrounding lines ({surroundings.length} lines)</h3>
          <div className="surroundings-list">
            {surroundings.map((nr) => {
              const isSelected = nr.id === row.id;
              const statusVal = nr.values['sc-status'] ?? nr.values.status ?? nr.values['target-status'];
              const levelVal = nr.values.level ?? nr.values.severity ?? nr.values.lvl;
              const stCls = statusClass(statusVal ?? null);
              const lvCls = levelClass(levelVal ?? null);
              const pillCls = stCls || lvCls;
              const badgeText =
                statusVal !== undefined && statusVal !== null
                  ? String(statusVal)
                  : typeof levelVal === 'string'
                    ? levelVal
                    : null;

              return (
                <div
                  key={nr.id}
                  className={`surroundings-item ${isSelected ? 'active' : ''}`}
                  onClick={() => select(nr.id)}
                  title={`View details of line ${nr.lineNo}`}
                >
                  <span className="surroundings-line">L{nr.lineNo}</span>
                  {badgeText && <span className={`pill small ${pillCls}`}>{badgeText}</span>}
                  <span className="surroundings-text">{nr.raw}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <h3>{isTrace ? 'Event timeline' : 'Raw'}</h3>
      <pre className="detail-raw">{row.raw}</pre>
    </aside>
  );
}
