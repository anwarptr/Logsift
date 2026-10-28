import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Insights } from '../utils/insights';
import { formatDuration, formatNumber, formatTimestamp } from '../utils/format';

type Timeline = NonNullable<Insights['timeline']>;

const HEIGHT = 132;
const M = { top: 8, right: 8, bottom: 20, left: 40 };
const GAP = 2;

function axisLabel(ms: number, spanMs: number): string {
  const s = formatTimestamp(ms);
  return spanMs > 86_400_000 ? s.slice(5, 16) : s.slice(11, 19);
}

/** Bar path with rounded top corners, flat on the baseline. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * Requests-over-time histogram. Errors are stacked at the base in the reserved
 * error colour; drag across it (or click a bar) to set the time filter.
 */
export function Histogram({ data, onSelect }: { data: Timeline; onSelect(from: number, to: number): void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { counts, errors, start, bucketMs } = data;
  const n = counts.length;
  const innerW = width - M.left - M.right;
  const innerH = HEIGHT - M.top - M.bottom;
  const max = Math.max(1, ...counts);
  const bw = innerW / n;
  const span = n * bucketMs;
  const y = (v: number) => innerH - (v / max) * innerH;
  const hasErrors = errors.some((e) => e > 0);

  const xToBucket = (x: number) => Math.max(0, Math.min(n - 1, Math.floor((x - M.left) / bw)));
  const localX = (e: PointerEvent<SVGSVGElement>) => e.clientX - e.currentTarget.getBoundingClientRect().left;

  function onDown(e: PointerEvent<SVGSVGElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const x = localX(e);
    setDrag({ x0: x, x1: x });
  }
  function onMove(e: PointerEvent<SVGSVGElement>) {
    const x = localX(e);
    if (drag) setDrag({ ...drag, x1: x });
    setHover(x >= M.left && x <= width - M.right ? xToBucket(x) : null);
  }
  function onUp() {
    if (!drag) return;
    const a = xToBucket(Math.min(drag.x0, drag.x1));
    const b = xToBucket(Math.max(drag.x0, drag.x1));
    setDrag(null);
    onSelect(start + a * bucketMs, start + (b + 1) * bucketMs - 1);
  }

  const hovered = hover !== null ? { i: hover, total: counts[hover]!, err: errors[hover]! } : null;
  const dragX = drag ? Math.min(drag.x0, drag.x1) : 0;
  const dragW = drag ? Math.abs(drag.x1 - drag.x0) : 0;

  return (
    <div className="histogram" ref={wrapRef}>
      <div className="chart-head">
        <span className="chart-title">Requests over time</span>
        <span className="muted small-text">{formatDuration(bucketMs)} buckets · drag to filter</span>
        {hasErrors && (
          <span className="legend" aria-hidden="true">
            <span className="legend-swatch ok" /> OK <span className="legend-swatch err" /> Errors
          </span>
        )}
      </div>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Histogram of ${formatNumber(counts.reduce((a, b) => a + b, 0))} rows over time, ${n} buckets`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={() => setHover(null)}
      >
        <g transform={`translate(${M.left},${M.top})`}>
          <line className="grid" x1={0} x2={innerW} y1={0} y2={0} />
          <line className="grid" x1={0} x2={innerW} y1={innerH / 2} y2={innerH / 2} />
          <line className="axis" x1={0} x2={innerW} y1={innerH} y2={innerH} />
          {Array.from(counts, (c, i) => {
            if (c === 0) return null;
            const e = errors[i]!;
            const x = i * bw + (bw > 4 ? 1 : 0);
            const w = Math.max(1, bw - (bw > 4 ? GAP : 0));
            const okH = innerH - y(c - e);
            const errH = innerH - y(e);
            const gap = e > 0 && c - e > 0 ? Math.min(GAP, okH) : 0;
            return (
              <g key={i} className={hover === i ? 'bar hovered' : 'bar'}>
                {e > 0 && <path className="bar-err" d={barPath(x, innerH - errH, w, errH, c - e > 0 ? 0 : 2)} />}
                {c - e > 0 && <path className="bar-ok" d={barPath(x, innerH - errH - okH, w, okH - gap, 2)} />}
              </g>
            );
          })}
          {hovered && <rect className="hover-col" x={hovered.i * bw} y={0} width={bw} height={innerH} />}
        </g>
        <text className="tick" x={M.left - 6} y={M.top + 4} textAnchor="end">
          {formatNumber(max)}
        </text>
        <text className="tick" x={M.left - 6} y={M.top + innerH} textAnchor="end">
          0
        </text>
        <text className="tick" x={M.left} y={HEIGHT - 4}>
          {axisLabel(start, span)}
        </text>
        <text className="tick" x={M.left + innerW / 2} y={HEIGHT - 4} textAnchor="middle">
          {axisLabel(start + span / 2, span)}
        </text>
        <text className="tick" x={width - M.right} y={HEIGHT - 4} textAnchor="end">
          {axisLabel(start + span, span)}
        </text>
        {drag && dragW > 0 && <rect className="drag-sel" x={dragX} y={M.top} width={dragW} height={innerH} />}
      </svg>
      {hovered && !drag && (
        <div
          className="chart-tooltip"
          style={{ left: Math.min(width - 190, Math.max(0, M.left + (hovered.i + 0.5) * bw - 95)) }}
          role="status"
        >
          <div className="mono">{formatTimestamp(start + hovered.i * bucketMs)}</div>
          <div>
            <strong>{formatNumber(hovered.total)}</strong> rows
            {hovered.err > 0 && <span className="err-text"> · {formatNumber(hovered.err)} errors</span>}
          </div>
        </div>
      )}
    </div>
  );
}
