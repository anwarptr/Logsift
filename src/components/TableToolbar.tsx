import type { ReactNode } from 'react';
import { useLogStore } from '../store/logStore';
import { formatNumber } from '../utils/format';
import { ColumnChooser } from './ColumnChooser';
import { ExportMenu } from './ExportMenu';

export function TableToolbar({ children }: { children?: ReactNode }) {
  const tab = useLogStore((s) => s.tab);
  const setTab = useLogStore((s) => s.setTab);
  const rowCount = useLogStore((s) => s.rows.length);
  const malformedCount = useLogStore((s) => s.malformed.length);
  const density = useLogStore((s) => s.density);
  const setDensity = useLogStore((s) => s.setDensity);
  const slowMs = useLogStore((s) => s.slowThresholdMs);
  const setSlow = useLogStore((s) => s.setSlowThreshold);
  const hasDuration = useLogStore((s) => s.schema.some((c) => c.role === 'duration'));
  const hasUri = useLogStore((s) => s.schema.some((c) => c.role === 'uri'));
  const hasMessage = useLogStore((s) => s.schema.some((c) => c.role === 'message'));
  const hasCharts = useLogStore((s) => s.schema.some((c) => c.role === 'timestamp' || c.role === 'duration' || c.role === 'uri'));
  const focusMode = useLogStore((s) => s.focusMode);
  const setFocusMode = useLogStore((s) => s.setFocusMode);

  return (
    <div className="table-toolbar">
      <div className="tabs" role="tablist" aria-label="Row views">
        <button
          type="button"
          role="tab"
          id="tab-rows"
          aria-selected={tab === 'rows'}
          aria-controls="panel-rows"
          className="tab"
          onClick={() => setTab('rows')}
        >
          Rows <span className="count">{formatNumber(rowCount)}</span>
        </button>
        {hasUri && (
          <button
            type="button"
            role="tab"
            id="tab-endpoints"
            aria-selected={tab === 'endpoints'}
            aria-controls="panel-endpoints"
            className="tab"
            onClick={() => setTab('endpoints')}
          >
            Endpoints
          </button>
        )}
        {hasMessage && (
          <button
            type="button"
            role="tab"
            id="tab-patterns"
            aria-selected={tab === 'patterns'}
            aria-controls="panel-patterns"
            className="tab"
            title="Similar messages grouped together"
            onClick={() => setTab('patterns')}
          >
            Patterns
          </button>
        )}
        {hasCharts && (
          <button
            type="button"
            role="tab"
            id="tab-charts"
            aria-selected={tab === 'charts'}
            aria-controls="panel-charts"
            className="tab"
            title="Response times, traffic by hour and request flow"
            onClick={() => setTab('charts')}
          >
            Charts
          </button>
        )}
        <button
          type="button"
          role="tab"
          id="tab-malformed"
          aria-selected={tab === 'malformed'}
          aria-controls="panel-malformed"
          className={`tab${malformedCount ? ' has-warn' : ''}`}
          onClick={() => setTab('malformed')}
        >
          Malformed <span className="count">{formatNumber(malformedCount)}</span>
        </button>
      </div>
      {children}
      <div className="toolbar-right">
        {hasDuration && (
          <label className="inline-field" title="Rows whose duration exceeds this are highlighted as slow">
            Slow &gt;
            <input
              type="number"
              min={0}
              step={100}
              value={slowMs}
              onChange={(e) => setSlow(e.target.valueAsNumber)}
              style={{ width: 80 }}
            />
            ms
          </label>
        )}
        <button
          type="button"
          className="btn small"
          aria-pressed={density === 'comfortable'}
          title="Toggle row density"
          onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
        >
          {density === 'compact' ? 'Compact' : 'Comfortable'}
        </button>
        <ColumnChooser />
        {tab === 'rows' && <ExportMenu />}
        <button
          type="button"
          className="btn small"
          aria-pressed={focusMode}
          title={focusMode ? 'Show the header, file bar, filters and insights again (F or Esc)' : 'Give the table the whole window (F)'}
          onClick={() => setFocusMode(!focusMode)}
        >
          <span aria-hidden="true">{focusMode ? '⤡' : '⤢'}</span> Focus
        </button>
      </div>
    </div>
  );
}
