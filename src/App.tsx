import { DropZone, ParseProgress } from './components/DropZone';
import { FileInfo } from './components/FileInfo';
import { useLogStore } from './store/logStore';
import { formatNumber } from './utils/format';

export default function App() {
  const status = useLogStore((s) => s.status);
  const error = useLogStore((s) => s.error);
  const hasFile = useLogStore((s) => s.file !== null && s.rows.length + s.malformed.length > 0);
  const rowCount = useLogStore((s) => s.rows.length);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Log Viewer</h1>
        <div className="header-actions">{hasFile && <DropZone compact />}</div>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {status === 'loading' && <ParseProgress />}
      {hasFile ? (
        <main className="app-main">
          <FileInfo />
          <p>{formatNumber(rowCount)} rows loaded.</p>
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
