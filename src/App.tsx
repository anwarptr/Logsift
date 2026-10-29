import { useState } from 'react';
import { DropZone, ParseProgress } from './components/DropZone';
import { EndpointsTable } from './components/EndpointsTable';
import { FileInfo } from './components/FileInfo';
import { FilterChips } from './components/FilterChips';
import { FilterSidebar } from './components/FilterSidebar';
import { InsightsPanel } from './components/InsightsPanel';
import { LogTable } from './components/LogTable';
import { MalformedList } from './components/MalformedList';
import { RowDetailPanel } from './components/RowDetailPanel';
import { SearchBox } from './components/SearchBox';
import { TableToolbar } from './components/TableToolbar';
import { ThemeToggle } from './components/ThemeToggle';
import { useUrlSync } from './filters/useUrlSync';
import { useLogStore } from './store/logStore';
import { useDisplayIndices, useSearchHighlight, useVisibleColumns } from './store/useView';
import { useShortcuts } from './utils/useShortcuts';

const NARROW = '(max-width: 900px)';
const isNarrow = () => typeof window !== 'undefined' && window.matchMedia?.(NARROW).matches;

export default function App() {
  const status = useLogStore((s) => s.status);
  const error = useLogStore((s) => s.error);
  const setError = useLogStore((s) => s.setError);
  const rows = useLogStore((s) => s.rows);
  const hasData = useLogStore((s) => s.rows.length + s.malformed.length > 0);
  const tab = useLogStore((s) => s.tab);
  const panelOpen = useLogStore((s) => s.selectedId !== null);
  const columns = useVisibleColumns();
  const indices = useDisplayIndices();
  const highlight = useSearchHighlight();
  const [sidebarOpen, setSidebarOpen] = useState(() => !isNarrow());
  const insightsOpen = useLogStore((s) => s.insightsOpen);
  const setInsightsOpen = useLogStore((s) => s.setInsightsOpen);

  useUrlSync();
  useShortcuts();

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Log Viewer</h1>
        <div className="header-actions">
          {hasData && (
            <button
              type="button"
              className="btn small"
              aria-pressed={sidebarOpen}
              aria-controls="filter-sidebar"
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              Filters
            </button>
          )}
          {hasData && <DropZone compact />}
          <ThemeToggle />
        </div>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" className="btn small ghost" aria-label="Dismiss error" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}
      {status === 'loading' && <ParseProgress />}
      {hasData ? (
        <main className="app-main">
          <FileInfo />
          <div className="workspace">
            {sidebarOpen && (
              <div id="filter-sidebar" className="sidebar-wrap">
                <button
                  type="button"
                  className="btn small ghost sidebar-close"
                  aria-label="Close filters"
                  onClick={() => setSidebarOpen(false)}
                >
                  ✕
                </button>
                <FilterSidebar />
              </div>
            )}
            <section className="table-area" aria-label="Log table">
              <TableToolbar>
                <SearchBox />
              </TableToolbar>
              <FilterChips />
              <section className={'insights-wrap' + (insightsOpen ? ' open' : '')} aria-label="Insights">
                <button
                  type="button"
                  className="insights-toggle"
                  aria-expanded={insightsOpen}
                  aria-controls="insights-body"
                  onClick={() => setInsightsOpen(!insightsOpen)}
                >
                  <span aria-hidden="true">{insightsOpen ? '▾' : '▸'}</span> Insights
                </button>
                {insightsOpen && (
                  <div id="insights-body">
                    <InsightsPanel />
                  </div>
                )}
              </section>
              {tab === 'rows' ? (
                <div role="tabpanel" id="panel-rows" aria-labelledby="tab-rows" className="tab-panel">
                  <LogTable rows={rows} indices={indices} columns={columns} highlight={highlight} />
                </div>
              ) : tab === 'endpoints' ? (
                <div role="tabpanel" id="panel-endpoints" aria-labelledby="tab-endpoints" className="tab-panel">
                  <EndpointsTable />
                </div>
              ) : (
                <div role="tabpanel" id="panel-malformed" aria-labelledby="tab-malformed" className="tab-panel">
                  <MalformedList />
                </div>
              )}
            </section>
            {panelOpen && <RowDetailPanel />}
          </div>
        </main>
      ) : (
        status !== 'loading' && (
          <main className="app-main empty">
            <DropZone />
          </main>
        )
      )}
    </div>
  );
}
