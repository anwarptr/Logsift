import { FORMAT_LABELS, type LogFormat, type LogTimeZone } from '../parser';
import { useLogStore } from '../store/logStore';
import { useLogIndex } from '../store/useView';
import { formatBytes, formatDuration, formatNumber } from '../utils/format';
import { differsFromLocal, formatOffset, localZoneName, logDisplayZone, zoneOffsetAt } from '../utils/timezone';

const FORMATS = Object.keys(FORMAT_LABELS) as LogFormat[];

function zoneText(tz: LogTimeZone): string {
  switch (tz.kind) {
    case 'utc':
      return 'UTC';
    case 'offset':
      return formatOffset(tz.offsetMin);
    case 'mixed':
      return 'Mixed offsets (shown in UTC)';
    case 'unspecified':
      return 'Not stated (assumed UTC)';
  }
}

/** The log's detected zone, plus a log/local switch when local time differs from it. */
function TimeZoneInfo({ tz, expanded }: { tz: LogTimeZone; expanded: boolean }) {
  const index = useLogIndex();
  const display = useLogStore((s) => s.timeDisplay);
  const setDisplay = useLogStore((s) => s.setTimeDisplay);
  const minTs = index?.minTs ?? null;
  const maxTs = index?.maxTs ?? null;
  const differs = differsFromLocal(tz, minTs, maxTs);
  const at = minTs ?? Date.now();
  const logLabel = formatOffset(zoneOffsetAt(logDisplayZone(tz), at));
  const name = localZoneName();
  const localLabel = formatOffset(zoneOffsetAt({ kind: 'local' }, at)) + (name ? ` · ${name}` : '');
  return (
    <div>
      <dt>Time zone</dt>
      <dd className="tz-info">
        <span title={tz.source}>{zoneText(tz)}</span>
        {expanded && tz.kind !== 'mixed' && tz.kind !== 'unspecified' && (
          <span className="muted tz-source">{tz.source}</span>
        )}
        {differs ? (
          <span className="tz-switch" role="radiogroup" aria-label="Show times in">
            <button
              type="button"
              role="radio"
              className="btn small"
              aria-checked={display === 'log'}
              onClick={() => setDisplay('log')}
            >
              Log time ({logLabel})
            </button>
            <button
              type="button"
              role="radio"
              className="btn small"
              aria-checked={display === 'local'}
              onClick={() => setDisplay('local')}
            >
              Local ({localLabel})
            </button>
          </span>
        ) : (
          expanded && index && <span className="muted tz-source">same as your local time</span>
        )}
      </dd>
    </div>
  );
}

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
  const tz = useLogStore((s) => s.logTimeZone);
  const files = useLogStore((s) => s.files);
  const expanded = useLogStore((s) => s.fileInfoExpanded);
  const setExpanded = useLogStore((s) => s.setFileInfoExpanded);

  if (!file) return null;

  // Compact: one line with what you act on (file, rows, format, time zone); "Details" adds the rest.
  return (
    <section className={'file-info' + (expanded ? '' : ' compact')} aria-label="File information">
      <dl className="file-info-grid">
        <div>
          <dt>File</dt>
          <dd className="file-name" title={file.name}>
            {file.name}
          </dd>
        </div>
        {expanded && (
          <div>
            <dt>Size</dt>
            <dd>{formatBytes(file.size)}</dd>
          </div>
        )}
        <div>
          <dt>Parsed</dt>
          <dd>{formatNumber(rowCount)}</dd>
        </div>
        {(expanded || malformedCount > 0) && (
          <div>
            <dt>Skipped</dt>
            <dd className={malformedCount ? 'warn-text' : undefined}>{formatNumber(malformedCount)}</dd>
          </div>
        )}
        {expanded && parseMs !== null && (
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
        {tz && <TimeZoneInfo tz={tz} expanded={expanded} />}
      </dl>
      {(files.length > 1 || (files.length === 1 && files[0] !== file.name)) && (
        <details className="file-meta">
          <summary>
            {files.length} log file{files.length > 1 ? 's' : ''}
            {files.length > 1 && ', merged in time order'}
          </summary>
          <ul className="file-list">
            {files.map((f) => (
              <li key={f} className="mono">
                {f}
              </li>
            ))}
          </ul>
        </details>
      )}
      {expanded && meta.length > 0 && (
        <details className="file-meta">
          <summary>{meta.length} metadata lines</summary>
          <pre>{meta.slice(0, 200).join('\n')}</pre>
          {meta.length > 200 && <p className="muted">…and {formatNumber(meta.length - 200)} more</p>}
        </details>
      )}
      <button
        type="button"
        className="btn small ghost file-info-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? 'Less' : 'Details'} <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
      </button>
    </section>
  );
}
