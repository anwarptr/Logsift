import { useEffect, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { formatNumber } from '../utils/format';
import { playAlertChime, requestNotificationPermission } from '../utils/sound';

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** Status and controls while files are watched for new lines. */
export function LiveBar() {
  const live = useLogStore((s) => s.live);
  const files = useLogStore((s) => s.files);
  const sorted = useLogStore((s) => s.sort !== null);
  const setPaused = useLogStore((s) => s.setLivePaused);
  const setFollowing = useLogStore((s) => s.setLiveFollowing);
  const setAlertErrors = useLogStore((s) => s.setLiveAlertErrors);
  const clearBuffer = useLogStore((s) => s.clearLiveBuffer);
  const stop = useLogStore((s) => s.stopLive);
  const alertErrors = live?.alertErrors === true;
  const [now, setNow] = useState(() => Date.now());
  const [showFiles, setShowFiles] = useState(false);
  const [rate, setRate] = useState<number | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const prevRowsRef = useRef<{ rows: number; time: number }>({ rows: 0, time: Date.now() });

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [live !== null]);

  useEffect(() => {
    if (!live) return;
    const nowMs = Date.now();
    const dt = (nowMs - prevRowsRef.current.time) / 1000;
    const dRows = live.newRows - prevRowsRef.current.rows;
    if (dt >= 1.5) {
      if (dRows > 0) {
        setRate(Math.max(1, Math.round(dRows / dt)));
      } else if (dt >= 6) {
        setRate(null);
      }
      prevRowsRef.current = { rows: live.newRows, time: nowMs };
    }
  }, [live?.newRows]);

  useEffect(() => {
    if (!showFiles) return;
    const onDown = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setShowFiles(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowFiles(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showFiles]);

  if (!live) return null;
  const what = live.kind === 'folder' ? `folder ${live.label}` : live.label;
  return (
    <section className={'live-bar' + (live.paused ? ' paused' : '')} aria-label="Live updates" style={{ position: 'relative' }}>
      <span className="live-dot" aria-hidden="true" />
      <span className="live-status" aria-live="polite">
        <b>{live.paused ? 'Paused' : 'Live'}</b> · watching {what}
        {live.files > 0 && (
          <button
            type="button"
            className="btn small live-files-btn"
            aria-expanded={showFiles}
            title="Click to view files currently being watched"
            onClick={() => setShowFiles(!showFiles)}
          >
            {formatNumber(live.files)} file{live.files === 1 ? '' : 's'} ▾
          </button>
        )}
        {live.newRows > 0 && ` · ${formatNumber(live.newRows)} new row${live.newRows === 1 ? '' : 's'}`}
        {rate !== null && !live.paused && <span className="live-rate"> · {rate} lines/s</span>}
        {live.updatedAt !== null && <span className="muted"> · updated {ago(now - live.updatedAt)}</span>}
      </span>
      {live.notice && <span className="muted live-notice">{live.notice}</span>}
      {live.error && <span className="warn-text">{live.error}</span>}
      <span className="live-actions">
        <button
          type="button"
          className={`btn small live-alert-btn${alertErrors ? ' active' : ''}`}
          aria-pressed={alertErrors}
          title={alertErrors ? 'Alert on error: ON (click to mute)' : 'Alert on error: OFF (click to enable chime & notifications)'}
          onClick={async () => {
            if (!alertErrors) {
              await requestNotificationPermission();
              playAlertChime();
              setAlertErrors(true);
            } else {
              setAlertErrors(false);
            }
          }}
        >
          {alertErrors ? '🔔 Alerts ON' : '🔕 Alerts'}
        </button>
        <button
          type="button"
          className="btn small"
          aria-pressed={live.following}
          disabled={sorted}
          title={sorted ? 'Following works in file order: clear the sort first' : 'Keep the newest row in view'}
          onClick={() => setFollowing(!live.following)}
        >
          Follow
        </button>
        <button type="button" className="btn small" onClick={() => setPaused(!live.paused)}>
          {live.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className="btn small"
          title="Clear displayed lines without stopping the watch"
          onClick={clearBuffer}
        >
          Clear
        </button>
        <button type="button" className="btn small" title="Stop watching (the rows stay)" onClick={stop}>
          Stop
        </button>
        <button
          type="button"
          className="btn small ghost"
          title="Stop watching and return to home page"
          onClick={() => useLogStore.getState().closeLog()}
        >
          Close
        </button>
      </span>
      {showFiles && (
        <div ref={popoverRef} className="live-files-popover popover" role="dialog" aria-label="Watched files">
          <div className="live-files-header">
            <b>Watched files ({files.length})</b>
            <button type="button" className="btn small" style={{ padding: '0 4px' }} onClick={() => setShowFiles(false)}>
              ✕
            </button>
          </div>
          <ul className="live-files-list">
            {files.map((f) => (
              <li key={f} title={f}>
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
