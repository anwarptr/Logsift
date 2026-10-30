import { useState } from 'react';
import { useLogStore } from '../../store/logStore';
import type { Heatmap } from '../../utils/charts';
import { formatNumber } from '../../utils/format';
import { useWidth } from './useWidth';

const LABEL_W = 84;
const ROW_H = 18;
const HEAD_H = 16;
/** Steps of the sequential ramp (CSS --seq-1…--seq-7, or --seqe-* for errors). */
const STEPS = 7;
const HOUR = 3_600_000;

/** Ramp step for a value: square-root scale so a few busy hours don't wash out the rest. */
const step = (v: number, max: number) => (v <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil(Math.sqrt(v / max) * STEPS)));

/**
 * Requests (or errors) per hour of day, one row per day in the display zone (weekdays when the
 * log spans more than a month). Click a cell to filter to that hour.
 */
export function TrafficHeatmap({ data, zoneLabel }: { data: Heatmap; zoneLabel: string }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>(700, 320);
  const setFilters = useLogStore((s) => s.setFilters);
  const [metric, setMetric] = useState<'requests' | 'errors'>('requests');
  const [hover, setHover] = useState<{ row: number; hour: number } | null>(null);
  const hasErrors = data.maxErrors > 0;
  const shown = metric === 'errors' && hasErrors ? 'errors' : 'requests';
  const values = shown === 'errors' ? data.errors : data.counts;
  const max = shown === 'errors' ? data.maxErrors : data.maxCount;
  const ramp = shown === 'errors' ? 'seqe' : 'seq';

  const cellW = (width - LABEL_W) / 24;
  const height = HEAD_H + data.rows.length * ROW_H;
  const clickable = data.mode === 'days';
  const pick = (row: number, hour: number) => {
    const s = data.rows[row]!.start;
    if (s !== null) setFilters({ timeFrom: s + hour * HOUR, timeTo: s + (hour + 1) * HOUR - 1 });
  };
  const hv = hover ? { ...hover, i: hover.row * 24 + hover.hour } : null;

  return (
    <div className="chart-block" ref={wrapRef}>
      <div className="chart-head">
        <span className="chart-title">Traffic by hour</span>
        <span className="muted small-text">
          {data.mode === 'days' ? 'per day' : 'by weekday (log spans over a month)'} · {zoneLabel}
          {clickable && ' · click a cell to filter'}
        </span>
        {hasErrors && (
          <span className="seg" role="group" aria-label="Heatmap shows">
            <button type="button" className="btn small" aria-pressed={shown === 'requests'} onClick={() => setMetric('requests')}>
              Requests
            </button>
            <button type="button" className="btn small" aria-pressed={shown === 'errors'} onClick={() => setMetric('errors')}>
              Errors
            </button>
          </span>
        )}
      </div>
      <div className="chart-plot" style={{ height }}>
        <svg width={width} height={height} role="img" aria-label={`${shown === 'errors' ? 'Errors' : 'Requests'} by hour of day, ${data.rows.length} rows`}>
          {Array.from({ length: 24 }, (_, h) =>
            h % (cellW < 22 ? 3 : 1) === 0 ? (
              <text key={h} className="tick" x={LABEL_W + (h + 0.5) * cellW} y={11} textAnchor="middle">
                {String(h).padStart(2, '0')}
              </text>
            ) : null,
          )}
          {data.rows.map((r, row) => (
            <g key={r.label} transform={`translate(0,${HEAD_H + row * ROW_H})`}>
              <text className="tick" x={LABEL_W - 6} y={ROW_H / 2 + 4} textAnchor="end">
                {r.label}
              </text>
              {Array.from({ length: 24 }, (_, hour) => {
                const v = values[row * 24 + hour]!;
                const s = step(v, max);
                return (
                  <rect
                    key={hour}
                    className={'heat-cell' + (hv?.i === row * 24 + hour ? ' hovered' : '')}
                    x={LABEL_W + hour * cellW + 1}
                    y={1}
                    width={Math.max(1, cellW - 2)}
                    height={ROW_H - 2}
                    rx={2}
                    style={{ fill: s === 0 ? 'var(--heat-empty)' : `var(--${ramp}-${s})`, cursor: clickable && v > 0 ? 'pointer' : 'default' }}
                    onPointerEnter={() => setHover({ row, hour })}
                    onPointerLeave={() => setHover(null)}
                    onClick={() => clickable && data.counts[row * 24 + hour]! > 0 && pick(row, hour)}
                  />
                );
              })}
            </g>
          ))}
        </svg>
        {hv && (
          <div
            className="chart-tooltip"
            style={{
              left: Math.min(width - 190, Math.max(0, LABEL_W + (hv.hour + 0.5) * cellW - 95)),
              top: HEAD_H + (hv.row + 1) * ROW_H + 4,
            }}
            role="status"
          >
            <div className="mono">
              {data.rows[hv.row]!.label} {String(hv.hour).padStart(2, '0')}:00–{String(hv.hour + 1).padStart(2, '0')}:00
            </div>
            <div>
              <strong>{formatNumber(data.counts[hv.i]!)}</strong> requests
            </div>
            {data.errors[hv.i]! > 0 && <div className="err-text">{formatNumber(data.errors[hv.i]!)} errors</div>}
          </div>
        )}
      </div>
      <div className="heat-legend" aria-hidden="true">
        <span>0</span>
        {Array.from({ length: STEPS }, (_, i) => (
          <span key={i} className="heat-swatch" style={{ background: `var(--${ramp}-${i + 1})` }} />
        ))}
        <span>{formatNumber(max)} {shown === 'errors' ? 'errors' : 'requests'} per hour</span>
      </div>
    </div>
  );
}
