import { useMemo, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { useDisplayZone } from '../store/useView';
import { copyText } from '../utils/clipboard';
import { formatNumber } from '../utils/format';
import { buildTraceWaterfallData, traceToMarkdown, type TraceSpan, type TraceWaterfallData } from '../utils/traceWaterfall';

interface TraceWaterfallProps {
  traceKey: string;
  traceVal: string;
  onSelectRow?: (rowId: number) => void;
}

export function TraceWaterfall({ traceKey, traceVal, onSelectRow }: TraceWaterfallProps) {
  const rows = useLogStore((s) => s.rows);
  const select = useLogStore((s) => s.select);
  const selectedId = useLogStore((s) => s.selectedId);
  const setFilters = useLogStore((s) => s.setFilters);
  const zone = useDisplayZone();

  const [modalOpen, setModalOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const data = useMemo(() => buildTraceWaterfallData(rows, traceVal, traceKey), [rows, traceVal, traceKey]);

  if (!data || data.spans.length === 0) return null;

  const total = Math.max(1, data.totalDurationMs);

  const handleRowClick = (span: TraceSpan) => {
    if (onSelectRow) onSelectRow(span.rowId);
    else select(span.rowId);
  };

  const copyMarkdown = async () => {
    const md = traceToMarkdown(data, zone);
    const ok = await copyText(md);
    setCopied(ok ? 'Copied Markdown' : 'Copy failed');
    setTimeout(() => setCopied(null), 2500);
  };

  return (
    <section className="waterfall trace-waterfall-section" aria-label="Distributed Trace Waterfall">
      <div className="waterfall-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>Distributed Trace Waterfall</h3>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <button
            type="button"
            className="btn small ghost"
            title="Expand trace into full visual timeline modal"
            onClick={() => setModalOpen(true)}
          >
            Expand ↗
          </button>
        </div>
      </div>
      <p className="muted small-text">
        <b>{formatNumber(data.totalDurationMs)} ms</b> total · {data.spans.length} event{data.spans.length === 1 ? '' : 's'} across {data.services.length} service{data.services.length === 1 ? '' : 's'}
        {data.errorCount > 0 && <span className="tag err-tag" style={{ marginLeft: '6px' }}>{data.errorCount} error{data.errorCount === 1 ? '' : 's'}</span>}
      </p>

      <ol className="waterfall-list trace-waterfall-list">
        {data.spans.slice(0, 30).map((span) => {
          const isSelected = selectedId === span.rowId;
          const leftPercent = Math.min(99, Math.max(0, (span.startOffsetMs / total) * 100));
          const widthPercent = span.isPointInTime
            ? 0
            : Math.min(100 - leftPercent, Math.max(1.5, (span.durationMs / total) * 100));

          return (
            <li
              key={span.rowId}
              className={`${span.isError ? 'err' : ''}${isSelected ? ' active-span' : ''}`}
              style={{ cursor: 'pointer' }}
              title={`Line ${span.lineNo} (+${span.startOffsetMs} ms): ${span.action}`}
              onClick={() => handleRowClick(span)}
            >
              <span className="waterfall-label">
                <span className="tag small-tag service-tag" style={{ marginRight: '5px' }}>
                  {span.service}
                </span>
                <span className="action-text">{span.action}</span>
                {span.status && <span className={`status-tag ${span.isError ? 'err-tag' : ''}`}> {span.status}</span>}
                {span.level && !span.status && <span className="level-tag"> {span.level}</span>}
              </span>
              <span className="waterfall-track">
                {span.isPointInTime ? (
                  <span
                    className="waterfall-point"
                    style={{
                      left: `${leftPercent}%`,
                      position: 'absolute',
                      top: '1px',
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      background: span.isError ? 'var(--err)' : 'var(--accent)',
                      transform: 'translateX(-50%)',
                    }}
                  />
                ) : (
                  <span
                    className="waterfall-bar"
                    style={{
                      left: `${leftPercent}%`,
                      width: `${widthPercent}%`,
                      background: span.isError ? 'var(--err)' : undefined,
                    }}
                  />
                )}
              </span>
              <span className="waterfall-ms mono">
                {span.durationMs > 0 ? `${formatNumber(span.durationMs)} ms` : `+${formatNumber(span.startOffsetMs)} ms`}
              </span>
            </li>
          );
        })}
      </ol>
      {data.spans.length > 30 && (
        <button
          type="button"
          className="btn small ghost"
          style={{ marginTop: '6px', width: '100%' }}
          onClick={() => setModalOpen(true)}
        >
          View all {data.spans.length} events in full timeline…
        </button>
      )}

      {modalOpen && (
        <TraceWaterfallModal
          data={data}
          onClose={() => setModalOpen(false)}
          onFilterTrace={() => {
            setFilters({ search: `${traceKey}:"${traceVal}"` });
            setModalOpen(false);
          }}
          onCopyMarkdown={copyMarkdown}
          copiedStatus={copied}
        />
      )}
    </section>
  );
}

interface TraceWaterfallModalProps {
  data: TraceWaterfallData;
  onClose: () => void;
  onFilterTrace: () => void;
  onCopyMarkdown: () => void;
  copiedStatus: string | null;
}

export function TraceWaterfallModal({
  data,
  onClose,
  onFilterTrace,
  onCopyMarkdown,
  copiedStatus,
}: TraceWaterfallModalProps) {
  const select = useLogStore((s) => s.select);
  const selectedId = useLogStore((s) => s.selectedId);
  const [filterText, setFilterText] = useState('');
  const [activeSpanId, setActiveSpanId] = useState<number>(selectedId ?? data.spans[0]?.rowId ?? 0);

  const filteredSpans = useMemo(() => {
    if (!filterText.trim()) return data.spans;
    const q = filterText.toLowerCase();
    return data.spans.filter(
      (s) =>
        s.service.toLowerCase().includes(q) ||
        s.action.toLowerCase().includes(q) ||
        (s.level && s.level.toLowerCase().includes(q)) ||
        (s.status && String(s.status).includes(q)),
    );
  }, [data.spans, filterText]);

  const activeSpan = data.spans.find((s) => s.rowId === activeSpanId) ?? data.spans[0];
  const total = Math.max(1, data.totalDurationMs);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal trace-waterfall-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trace-modal-title"
        style={{ maxWidth: '960px', width: '92vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
          <div>
            <h2 id="trace-modal-title" style={{ margin: '0 0 4px', fontSize: '18px' }}>
              Distributed Trace Waterfall
            </h2>
            <div className="muted mono" style={{ fontSize: '12px', wordBreak: 'break-all' }}>
              {data.traceKey}: <b>{data.traceId}</b>
            </div>
          </div>
          <button type="button" className="btn small ghost" aria-label="Close dialog" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Metrics Bar */}
        <div className="trace-metrics-bar" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <span className="pill">
            Duration: <b>{formatNumber(data.totalDurationMs)} ms</b>
          </span>
          <span className="pill">
            Events: <b>{data.spans.length}</b>
          </span>
          <span className="pill">
            Services: <b>{data.services.join(', ')}</b>
          </span>
          {data.errorCount > 0 ? (
            <span className="pill err-pill">
              Errors: <b>{data.errorCount}</b>
            </span>
          ) : (
            <span className="pill ok-pill">Status: OK</span>
          )}
        </div>

        {/* Action Controls */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', marginBottom: '12px' }}>
          <input
            type="search"
            placeholder="Filter trace events…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            style={{ maxWidth: '280px', padding: '4px 8px', fontSize: '13px' }}
          />
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {copiedStatus && <span className="muted small-text">{copiedStatus}</span>}
            <button type="button" className="btn small" onClick={onCopyMarkdown}>
              Copy Markdown
            </button>
            <button type="button" className="btn small primary" onClick={onFilterTrace}>
              Filter log to trace
            </button>
          </div>
        </div>

        {/* Time Axis Ruler */}
        <div className="trace-ruler" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--muted)', padding: '0 80px 4px 180px', borderBottom: '1px solid var(--border)' }}>
          <span>0 ms</span>
          <span>{formatNumber(Math.round(total * 0.25))} ms</span>
          <span>{formatNumber(Math.round(total * 0.5))} ms</span>
          <span>{formatNumber(Math.round(total * 0.75))} ms</span>
          <span>{formatNumber(total)} ms</span>
        </div>

        {/* Waterfall Spans Scrollable Body */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: '200px', borderBottom: '1px solid var(--border)' }}>
          <ol className="waterfall-list" style={{ padding: '4px 0' }}>
            {filteredSpans.map((span) => {
              const isSelected = activeSpanId === span.rowId;
              const leftPercent = Math.min(99, Math.max(0, (span.startOffsetMs / total) * 100));
              const widthPercent = span.isPointInTime
                ? 0
                : Math.min(100 - leftPercent, Math.max(2, (span.durationMs / total) * 100));

              return (
                <li
                  key={span.rowId}
                  className={`${span.isError ? 'err' : ''}${isSelected ? ' active-span' : ''}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '180px minmax(0, 1fr) 80px',
                    gridTemplateRows: 'auto',
                    alignItems: 'center',
                    padding: '6px 4px',
                    cursor: 'pointer',
                    background: isSelected ? 'var(--selection)' : undefined,
                  }}
                  onClick={() => {
                    setActiveSpanId(span.rowId);
                    select(span.rowId);
                  }}
                >
                  <span className="waterfall-service" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: '8px' }}>
                    <span className="tag small-tag">{span.service}</span>
                    <span className="muted small-text" style={{ marginLeft: '4px' }}>L{span.lineNo}</span>
                  </span>

                  <div style={{ position: 'relative', width: '100%', height: '20px', display: 'flex', alignItems: 'center' }}>
                    <div style={{ position: 'relative', width: '100%', height: '8px', background: 'var(--surface-2)', borderRadius: '3px' }}>
                      {span.isPointInTime ? (
                        <span
                          style={{
                            position: 'absolute',
                            left: `${leftPercent}%`,
                            top: '-2px',
                            width: '12px',
                            height: '12px',
                            borderRadius: '50%',
                            background: span.isError ? 'var(--err)' : 'var(--accent)',
                            transform: 'translateX(-50%)',
                            boxShadow: '0 0 2px rgba(0,0,0,0.4)',
                          }}
                        />
                      ) : (
                        <span
                          style={{
                            position: 'absolute',
                            left: `${leftPercent}%`,
                            width: `${widthPercent}%`,
                            height: '100%',
                            background: span.isError ? 'var(--err)' : 'var(--chart-bar)',
                            borderRadius: '3px',
                          }}
                        />
                      )}
                    </div>
                    <span
                      style={{
                        position: 'absolute',
                        left: `${Math.min(75, leftPercent)}%`,
                        top: '-14px',
                        fontSize: '11px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: '260px',
                      }}
                    >
                      {span.action}
                    </span>
                  </div>

                  <span className="waterfall-ms mono" style={{ textAlign: 'right', fontSize: '11px' }}>
                    {span.durationMs > 0 ? `${formatNumber(span.durationMs)} ms` : `+${formatNumber(span.startOffsetMs)} ms`}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        {/* Selected Event Detail Footer */}
        {activeSpan && (
          <div style={{ paddingTop: '10px', fontSize: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
              <b>
                Line {activeSpan.lineNo} · {activeSpan.service} · +{formatNumber(activeSpan.startOffsetMs)} ms
                {activeSpan.durationMs > 0 && ` (${formatNumber(activeSpan.durationMs)} ms)`}
              </b>
              <button
                type="button"
                className="btn small ghost"
                onClick={() => {
                  select(activeSpan.rowId);
                  onClose();
                }}
              >
                Jump to row in table →
              </button>
            </div>
            <pre style={{ margin: 0, padding: '6px', background: 'var(--surface-2)', borderRadius: '4px', maxHeight: '70px', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {activeSpan.raw}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
