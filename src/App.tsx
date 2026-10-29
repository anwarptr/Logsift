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
  const sidebarOpen = useLogStore((s) => s.sidebarOpen);
  const setSidebarOpen = useLogStore((s) => s.setSidebarOpen);
  const insightsOpen = useLogStore((s) => s.insightsOpen);
  const setInsightsOpen = useLogStore((s) => s.setInsightsOpen);
  // Focus mode only makes sense with data on screen.
  const focus = useLogStore((s) => s.focusMode) && hasData;

  useUrlSync();
  useShortcuts();

  return (
    <div className={'app' + (focus ? ' focus-mode' : '')}>
      {/* Hidden by CSS in focus mode rather than unmounted: its DropZone owns the window-wide drop/paste handlers. */}
      <header className="app-header">
        <h1 className="app-title">Log Viewer</h1>
        <div className="header-actions">
          {hasData && (
            <button
              type="button"
              className="btn small"
              aria-pressed={sidebarOpen}
              aria-controls="filter-sidebar"
              title="Show or hide the filter panel ( [ )"
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
          {!focus && <FileInfo />}
          <div className="workspace">
            {!focus &&
              (sidebarOpen ? (
                <div id="filter-sidebar" className="sidebar-wrap">
                  <div className="sidebar-head">
                    <span>Filters</span>
                    <button
                      type="button"
                      className="btn small ghost"
                      aria-label="Hide filters"
                      title="Hide filters ( [ )"
                      onClick={() => setSidebarOpen(false)}
                    >
                      <span aria-hidden="true">«</span>
                    </button>
                  </div>
                  <FilterSidebar />
                </div>
              ) : (
                <button
                  type="button"
                  className="sidebar-rail"
                  aria-label="Show filters"
                  aria-controls="filter-sidebar"
                  aria-expanded={false}
                  title="Show filters ( [ )"
                  onClick={() => setSidebarOpen(true)}
                >
                  <span aria-hidden="true">»</span>
                  <span className="sidebar-rail-label" aria-hidden="true">
                    Filters
                  </span>
                </button>
              ))}
            <section className="table-area" aria-label="Log table">
              <TableToolbar>
                <SearchBox />
              </TableToolbar>
              <FilterChips />
              {!focus && (
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
              )}
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
