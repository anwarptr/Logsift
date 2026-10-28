import { useMemo } from 'react';
import { DropZone, ParseProgress } from './components/DropZone';
import { FileInfo } from './components/FileInfo';
import { LogTable } from './components/LogTable';
import { MalformedList } from './components/MalformedList';
import { RowDetailPanel } from './components/RowDetailPanel';
import { TableToolbar } from './components/TableToolbar';
import { useLogStore } from './store/logStore';
import { useSortedIndices, useVisibleColumns } from './store/useView';

export default function App() {
  const status = useLogStore((s) => s.status);
  const error = useLogStore((s) => s.error);
  const setError = useLogStore((s) => s.setError);
  const rows = useLogStore((s) => s.rows);
  const hasData = useLogStore((s) => s.rows.length + s.malformed.length > 0);
  const tab = useLogStore((s) => s.tab);
  const panelOpen = useLogStore((s) => s.selectedId !== null);
  const columns = useVisibleColumns();

  const all = useMemo(() => {
    const a = new Uint32Array(rows.length);
    for (let i = 0; i < a.length; i++) a[i] = i;
    return a;
  }, [rows]);
  const indices = useSortedIndices(all);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Log Viewer</h1>
        <div className="header-actions">{hasData && <DropZone compact />}</div>
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
            <section className="table-area" aria-label="Log table">
              <TableToolbar />
              {tab === 'rows' ? (
                <div role="tabpanel" id="panel-rows" aria-labelledby="tab-rows" className="tab-panel">
                  <LogTable rows={rows} indices={indices} columns={columns} highlight={null} />
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
