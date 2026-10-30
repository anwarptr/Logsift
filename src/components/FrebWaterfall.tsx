import { useMemo } from 'react';
import { formatNumber } from '../utils/format';
import { frebWaterfall } from '../utils/frebSpans';

/** Longest spans shown; the rest are summarised in one line. */
const MAX_SPANS = 25;

/**
 * Where an IIS failed request spent its time: one bar per module step (module + pipeline stage),
 * placed by when it started and sized by how long it took. The module that set the error status
 * is marked. Read from the row's event timeline when the row is opened.
 */
export function FrebWaterfall({ timeline }: { timeline: string }) {
  const w = useMemo(() => frebWaterfall(timeline), [timeline]);
  if (w.events === 0) return null;
  const timed = w.spans.filter((s) => s.end > s.start);
  if (w.totalMs < 1 || timed.length === 0) {
    return (
      <section className="waterfall" aria-label="Where the time went">
        <h3>Where the time went</h3>
        <p className="muted small-text">
          {w.totalMs < 1
            ? `All ${formatNumber(w.events)} events happened within the same millisecond, so there is no time breakdown`
            : `${formatNumber(w.events)} events over ${formatNumber(w.totalMs)} ms, but no module steps with both a start and an end`}
          {w.errorModule ? `; ${w.errorModule} set the error status` : ''}.
        </p>
      </section>
    );
  }
  // Longest steps first when trimming, then shown in the order they ran.
  const shown = [...timed].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, MAX_SPANS).sort((a, b) => a.start - b.start);
  const total = Math.max(1, w.totalMs);
  return (
    <section className="waterfall" aria-label="Where the time went">
      <h3>Where the time went</h3>
      <p className="muted small-text">
        {formatNumber(total)} ms from first to last event · {timed.length} timed module step{timed.length === 1 ? '' : 's'}
        {timed.length > shown.length && ` (longest ${shown.length} shown)`}
      </p>
      <ol className="waterfall-list">
        {shown.map((s, i) => {
          const err = s.module === w.errorModule;
          return (
            <li key={i} className={err ? 'err' : undefined} title={`${s.module} · ${s.notification}: +${s.start} ms → +${s.end} ms`}>
              <span className="waterfall-label">
                <span className="mono">{s.module}</span>
                <span className="muted"> · {s.notification}</span>
                {err && <span className="tag err-tag">set error</span>}
              </span>
              <span className="waterfall-track">
                <span
                  className="waterfall-bar"
                  style={{ left: `${(s.start / total) * 100}%`, width: `max(2px, ${((s.end - s.start) / total) * 100}%)` }}
                />
              </span>
              <span className="waterfall-ms mono">{formatNumber(s.end - s.start)} ms</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
