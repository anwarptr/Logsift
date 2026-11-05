import { useEffect, useState } from 'react';
import { useLogStore } from '../store/logStore';
import { formatNumber } from '../utils/format';

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
  const sorted = useLogStore((s) => s.sort !== null);
  const setPaused = useLogStore((s) => s.setLivePaused);
  const setFollowing = useLogStore((s) => s.setLiveFollowing);
  const stop = useLogStore((s) => s.stopLive);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [live !== null]);

  if (!live) return null;
  const what = live.kind === 'folder' ? `folder ${live.label}` : live.label;
  return (
    <section className={'live-bar' + (live.paused ? ' paused' : '')} aria-label="Live updates">
      <span className="live-dot" aria-hidden="true" />
      <span className="live-status" aria-live="polite">
        <b>{live.paused ? 'Paused' : 'Live'}</b> · watching {what}
        {live.kind === 'folder' && ` (${formatNumber(live.files)} file${live.files === 1 ? '' : 's'})`}
        {live.newRows > 0 && ` · ${formatNumber(live.newRows)} new row${live.newRows === 1 ? '' : 's'}`}
        {live.updatedAt !== null && <span className="muted"> · updated {ago(now - live.updatedAt)}</span>}
      </span>
      {live.notice && <span className="muted live-notice">{live.notice}</span>}
      {live.error && <span className="warn-text">{live.error}</span>}
      <span className="live-actions">
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
        <button type="button" className="btn small" title="Stop watching (the rows stay)" onClick={stop}>
          Stop
        </button>
      </span>
    </section>
  );
}
