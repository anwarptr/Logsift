import { useState } from 'react';
import { useLogStore } from '../../store/logStore';
import type { DurationBin } from '../../utils/charts';
import { formatNumber } from '../../utils/format';
import { useWidth } from './useWidth';

const HEIGHT = 200;
const M = { top: 8, right: 6, bottom: 34, left: 40 };
const GAP = 2;

/** Bar path with rounded top corners, flat on the baseline. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * How many requests fall in each response-time range (errors stacked at the base).
 * Click a bar to filter the rows to that range.
 */
export function DurationBars({ bins, durationKey }: { bins: DurationBin[]; durationKey: string }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>(360, 160);
  const setFilters = useLogStore((s) => s.setFilters);
  const ranges = useLogStore((s) => s.filters.ranges);
  const [hover, setHover] = useState<number | null>(null);

  const innerW = width - M.left - M.right;
  const innerH = HEIGHT - M.top - M.bottom;
  const max = Math.max(1, ...bins.map((b) => b.count));
  const bw = innerW / bins.length;
  const h = (v: number) => (v / max) * innerH;
  const pick = (b: DurationBin) =>
    setFilters({ ranges: { ...ranges, [durationKey]: [b.from, b.to === Infinity ? null : b.to] } });
  const total = bins.reduce((s, b) => s + b.count, 0);
  const hovered = hover === null ? null : bins[hover];

  return (
    <div className="chart-block" ref={wrapRef}>
      <div className="chart-head">
        <span className="chart-title">Response time distribution</span>
        <span className="muted small-text">click a bar to filter</span>
      </div>
      <div className="chart-plot" style={{ height: HEIGHT }}>
        <svg width={width} height={HEIGHT} role="img" aria-label={`Requests by response time, ${formatNumber(total)} requests`}>
          <g transform={`translate(${M.left},${M.top})`}>
            <line className="grid" x1={0} x2={innerW} y1={0} y2={0} />
            <line className="grid" x1={0} x2={innerW} y1={innerH / 2} y2={innerH / 2} />
            <line className="axis" x1={0} x2={innerW} y1={innerH} y2={innerH} />
            {bins.map((b, i) => {
              const bx = i * bw + GAP / 2;
              const w = Math.max(1, bw - GAP);
              const errH = h(b.errors);
              const okH = h(b.count - b.errors);
              const gap = b.errors > 0 && b.count > b.errors ? Math.min(GAP, okH) : 0;
              return (
                <g
                  key={b.label}
                  className={hover === i ? 'bar hovered' : 'bar'}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onClick={() => b.count > 0 && pick(b)}
                  style={{ cursor: b.count > 0 ? 'pointer' : 'default' }}
                >
                  {/* Taller hit target than the bar itself. */}
                  <rect x={i * bw} y={0} width={bw} height={innerH} fill="transparent" />
                  {b.errors > 0 && <path className="bar-err" d={barPath(bx, innerH - errH, w, errH, b.count > b.errors ? 0 : 3)} />}
                  {b.count > b.errors && <path className="bar-ok" d={barPath(bx, innerH - errH - okH, w, okH - gap, 3)} />}
                  <text className="tick" x={i * bw + bw / 2} y={innerH + 12} textAnchor="middle">
                    {i % (bw < 34 ? 2 : 1) === 0 ? b.short : ''}
                  </text>
                </g>
              );
            })}
          </g>
          <text className="tick" x={M.left - 6} y={M.top + 4} textAnchor="end">
            {formatNumber(max)}
          </text>
          <text className="tick" x={M.left - 6} y={M.top + innerH} textAnchor="end">
            0
          </text>
          <text className="tick" x={M.left + innerW / 2} y={HEIGHT - 4} textAnchor="middle">
            milliseconds (s = seconds)
          </text>
        </svg>
        {hovered && hover !== null && (
          <div className="chart-tooltip" style={{ left: Math.min(width - 190, Math.max(0, M.left + (hover + 0.5) * bw - 95)) }} role="status">
            <div>
              <strong>{hovered.label}</strong>
            </div>
            <div>
              {formatNumber(hovered.count)} requests ({total ? Math.round((hovered.count / total) * 100) : 0}%)
            </div>
            {hovered.errors > 0 && <div className="err-text">{formatNumber(hovered.errors)} errors</div>}
          </div>
        )}
      </div>
    </div>
  );
}
