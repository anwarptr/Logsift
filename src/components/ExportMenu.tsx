import { useState } from 'react';
import { useLogStore } from '../store/logStore';
import { useDisplayIndices, useVisibleColumns } from '../store/useView';
import { downloadParts } from '../utils/download';
import { exportFileName, toCsvParts, toJsonParts } from '../utils/export';

/** Export the filtered rows (in the current sort order). CSV uses visible columns; JSON includes every field. */
export function ExportMenu() {
  const rows = useLogStore((s) => s.rows);
  const schema = useLogStore((s) => s.schema);
  const fileName = useLogStore((s) => s.file?.name);
  const indices = useDisplayIndices();
  const columns = useVisibleColumns();
  const [busy, setBusy] = useState(false);

  function run(kind: 'csv' | 'json') {
    setBusy(true);
    // Let the button state paint before the (possibly large) synchronous export.
    setTimeout(() => {
      try {
        if (kind === 'csv') downloadParts(toCsvParts(rows, indices, columns), exportFileName(fileName, 'csv'), 'text/csv');
        else downloadParts(toJsonParts(rows, indices, schema), exportFileName(fileName, 'json'), 'application/json');
      } finally {
        setBusy(false);
      }
    }, 0);
  }

  const disabled = busy || indices.length === 0;
  return (
    <div className="btn-group" role="group" aria-label={`Export ${indices.length} filtered rows`}>
      <span className="btn-group-label">Export</span>
      <button type="button" className="btn small" disabled={disabled} onClick={() => run('csv')}>
        CSV
      </button>
      <button type="button" className="btn small" disabled={disabled} onClick={() => run('json')}>
        JSON
      </button>
    </div>
  );
}
