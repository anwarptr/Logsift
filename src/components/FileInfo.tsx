import { FORMAT_LABELS, type LogFormat } from '../parser';
import { useLogStore } from '../store/logStore';
import { formatBytes, formatDuration, formatNumber } from '../utils/format';

const FORMATS = Object.keys(FORMAT_LABELS) as LogFormat[];

export function FileInfo() {
  const file = useLogStore((s) => s.file);
  const format = useLogStore((s) => s.format);
  const detected = useLogStore((s) => s.detectedFormat);
  const override = useLogStore((s) => s.formatOverride);
  const setOverride = useLogStore((s) => s.setFormatOverride);
  const rowCount = useLogStore((s) => s.rows.length);
  const malformedCount = useLogStore((s) => s.malformed.length);
  const meta = useLogStore((s) => s.meta);
  const parseMs = useLogStore((s) => s.parseMs);
  const status = useLogStore((s) => s.status);

  if (!file) return null;

  return (
    <section className="file-info" aria-label="File information">
      <dl className="file-info-grid">
        <div>
          <dt>File</dt>
          <dd className="file-name" title={file.name}>
            {file.name}
          </dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(file.size)}</dd>
        </div>
        <div>
          <dt>Parsed</dt>
          <dd>{formatNumber(rowCount)}</dd>
        </div>
        <div>
          <dt>Skipped</dt>
          <dd className={malformedCount ? 'warn-text' : undefined}>{formatNumber(malformedCount)}</dd>
        </div>
        {parseMs !== null && (
          <div>
            <dt>Parse time</dt>
            <dd>{formatDuration(parseMs)}</dd>
          </div>
        )}
        <div>
          <dt>
            <label htmlFor="format-select">Format</label>
          </dt>
          <dd>
            <select
              id="format-select"
              value={override}
              disabled={status === 'loading'}
              onChange={(e) => setOverride(e.target.value as LogFormat | 'auto')}
            >
              <option value="auto">Auto{detected ? ` (${FORMAT_LABELS[detected]})` : ''}</option>
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
            {format && override === 'auto' && <span className="visually-hidden">Detected {FORMAT_LABELS[format]}</span>}
          </dd>
        </div>
      </dl>
      {meta.length > 0 && (
        <details className="file-meta">
          <summary>{meta.length} metadata lines</summary>
          <pre>{meta.slice(0, 200).join('\n')}</pre>
          {meta.length > 200 && <p className="muted">…and {formatNumber(meta.length - 200)} more</p>}
        </details>
      )}
    </section>
  );
}
