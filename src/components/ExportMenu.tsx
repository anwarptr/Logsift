import { useEffect, useRef, useState } from 'react';
import { isErrorRow } from '../filters/logIndex';
import { useLogStore } from '../store/logStore';
import { useDisplayIndices, useDisplayZone, useLogIndex, useVisibleColumns } from '../store/useView';
import { copyText } from '../utils/clipboard';
import { downloadParts } from '../utils/download';
import { exportFileName, MARKDOWN_MAX_ROWS, toCsvParts, toJsonParts, toMarkdown } from '../utils/export';
import { formatTimestamp } from '../utils/format';
import { buildChips } from './FilterChips';

/**
 * Export the filtered rows (in the current sort order). CSV uses visible columns; JSON includes every
 * field; Markdown copies a summary and the first rows as a table, for a ticket, pull request or chat.
 */
export function ExportMenu() {
  const rows = useLogStore((s) => s.rows);
  const schema = useLogStore((s) => s.schema);
  const fileName = useLogStore((s) => s.file?.name);
  const filters = useLogStore((s) => s.filters);
  const slowMs = useLogStore((s) => s.slowThresholdMs);
  const indices = useDisplayIndices();
  const columns = useVisibleColumns();
  const zone = useDisplayZone();
  const index = useLogIndex();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  function run(kind: 'csv' | 'json') {
    setBusy(true);
    // Let the button state paint before the (possibly large) synchronous export.
    setTimeout(() => {
      try {
        if (kind === 'csv') downloadParts(toCsvParts(rows, indices, columns, zone), exportFileName(fileName, 'csv'), 'text/csv');
        else downloadParts(toJsonParts(rows, indices, schema, zone), exportFileName(fileName, 'json'), 'application/json');
      } finally {
        setBusy(false);
      }
    }, 0);
  }

  async function copyMarkdown() {
    let errors: number | undefined;
    let minTs = Infinity;
    let maxTs = -Infinity;
    if (index) errors = 0;
    for (let i = 0; i < indices.length; i++) {
      const r = indices[i]!;
      if (index && isErrorRow(index, r)) errors!++;
      const t = rows[r]!.ts;
      if (t !== null) {
        if (t < minTs) minTs = t;
        if (t > maxTs) maxTs = t;
      }
    }
    const md = toMarkdown(
      rows,
      indices,
      columns,
      {
        fileName: fileName ?? 'logs',
        totalRows: rows.length,
        filters: buildChips(filters, slowMs, zone).map((c) => c.label),
        errors,
        timeRange: minTs <= maxTs ? `${formatTimestamp(minTs, zone)} → ${formatTimestamp(maxTs, zone)}` : undefined,
      },
      zone,
    );
    const ok = await copyText(md);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setCopied(ok ? 'ok' : 'failed');
    resetTimer.current = setTimeout(() => setCopied(null), 2000);
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
      <button
        type="button"
        className="btn small"
        disabled={disabled}
        title={`Copy a summary and the first ${MARKDOWN_MAX_ROWS} rows as a Markdown table`}
        onClick={() => void copyMarkdown()}
      >
        {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Markdown'}
      </button>
    </div>
  );
}
