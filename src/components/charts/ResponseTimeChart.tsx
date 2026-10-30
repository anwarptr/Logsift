import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { LogIndex } from '../../filters/logIndex';
import { isErrorRow } from '../../filters/logIndex';
import { useLogStore } from '../../store/logStore';
import { useDisplayZone } from '../../store/useView';
import type { ResponseTimes } from '../../utils/charts';
import { formatDuration, formatNumber, formatTimestamp } from '../../utils/format';
import { cssVar, useWidth } from './useWidth';

const HEIGHT = 200;
/** A p95 of fewer requests than this says little, so the line skips such buckets. */
const MIN_FOR_P95 = 5;
const M = { top: 8, right: 10, bottom: 20, left: 52 };

const msText = (ms: number) => (Number.isNaN(ms) ? '–' : ms >= 1000 ? `${formatNumber(Math.round(ms / 100) / 10)} s` : `${formatNumber(Math.round(ms))} ms`);

/**
 * Every request's duration over time (log scale; errors drawn last, in the error colour), with the
 * p95 per time bucket as a line. Drawn on a canvas so hundreds of thousands of dots stay fast;
 * axes, the p95 line and the hover layer are SVG on top. Drag across it to filter to a time range.
 */
export function ResponseTimeChart({ data, index, matched }: { data: ResponseTimes; index: LogIndex; matched: Uint32Array }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const zone = useDisplayZone();
  const theme = useLogStore((s) => s.theme);
  const setFilters = useLogStore((s) => s.setFilters);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);

  const innerW = width - M.left - M.right;
  const innerH = HEIGHT - M.top - M.bottom;
  const { start, bucketMs, count, p95 } = data;
  const n = count.length;
  const span = n * bucketMs;
  // Log scale from 1 ms (or less) to the next power of ten above the slowest request.
  const top = Math.max(1, Math.ceil(Math.log10(Math.max(1, data.maxMs))));
  const x = (t: number) => ((t - start) / span) * innerW;
  const y = (ms: number) => innerH - (Math.log10(Math.max(1, ms)) / top) * innerH;
  const ticks = Array.from({ length: top + 1 }, (_, i) => 10 ** i);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerW * dpr;
    canvas.height = innerH * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerW, innerH);
    const dur = index.duration!;
    // Few requests: bigger, stronger dots; many: small, faint ones so dense areas still read.
    const size = matched.length > 5000 ? 3 : 5;
    const draw = (errors: boolean, color: string, alpha: number) => {
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      for (let k = 0; k < matched.length; k++) {
        const r = matched[k]!;
        const t = index.ts[r]!;
        const d = dur[r]!;
        if (!Number.isFinite(t) || !Number.isFinite(d) || isErrorRow(index, r) !== errors) continue;
        ctx.fillRect(x(t) - size / 2, y(d) - size / 2, size, size);
      }
    };
    draw(false, cssVar('--chart-bar'), matched.length > 20_000 ? 0.15 : matched.length > 5000 ? 0.35 : 0.6);
    draw(true, cssVar('--err'), 0.8);
    ctx.globalAlpha = 1;
    // x and y depend only on data and the plot size; theme changes the colours.
  }, [data, index, matched, innerW, innerH, theme]);

  const bw = innerW / n;
  const toBucket = (px: number) => Math.max(0, Math.min(n - 1, Math.floor((px - M.left) / bw)));
  const localX = (e: PointerEvent<SVGSVGElement>) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  useEffect(() => setHover(null), [data]);

  // p95 line through the centres of non-empty buckets; gaps where a bucket is empty.
  let path = '';
  let pen = false;
  for (let b = 0; b < n; b++) {
    const v = p95[b]!;
    if (Number.isNaN(v) || count[b]! < MIN_FOR_P95) {
      pen = false;
      continue;
    }
    path += `${pen ? 'L' : 'M'}${((b + 0.5) * bw).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  }

  const hovered = hover !== null && hover < n && count[hover]! > 0 ? hover : null;
  const dragX = drag ? Math.min(drag.x0, drag.x1) : 0;
  const dragW = drag ? Math.abs(drag.x1 - drag.x0) : 0;

  return (
    <div className="chart-block" ref={wrapRef}>
      <div className="chart-head">
        <span className="chart-title">Response time over time</span>
        <span className="muted small-text">log scale · drag to filter</span>
        <span className="legend" aria-hidden="true">
          <span className="legend-dot ok" /> Requests <span className="legend-dot err" /> Errors {path && (<><span className="legend-line" /> p95</>)}
        </span>
      </div>
      <div className="chart-plot" style={{ height: HEIGHT }}>
        <canvas
          ref={canvasRef}
          style={{ position: 'absolute', left: M.left, top: M.top, width: innerW, height: innerH }}
          aria-hidden="true"
        />
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`Response times of ${formatNumber(data.total)} requests over time; slowest ${msText(data.maxMs)}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrag({ x0: localX(e), x1: localX(e) });
          }}
          onPointerMove={(e) => {
            const px = localX(e);
            if (drag) setDrag({ ...drag, x1: px });
            setHover(px >= M.left && px <= width - M.right ? toBucket(px) : null);
          }}
          onPointerUp={() => {
            if (!drag) return;
            const a = toBucket(Math.min(drag.x0, drag.x1));
            const b = toBucket(Math.max(drag.x0, drag.x1));
            setDrag(null);
            setFilters({ timeFrom: start + a * bucketMs, timeTo: start + (b + 1) * bucketMs - 1 });
          }}
          onPointerLeave={() => setHover(null)}
        >
          <g transform={`translate(${M.left},${M.top})`}>
            {ticks.map((t) => (
              <line key={t} className={t === 1 ? 'axis' : 'grid'} x1={0} x2={innerW} y1={y(t)} y2={y(t)} />
            ))}
            <path className="p95-line" d={path} />
            {hovered !== null && <rect className="hover-col" x={hovered * bw} y={0} width={bw} height={innerH} />}
          </g>
          {ticks.map((t) => (
            <text key={t} className="tick" x={M.left - 6} y={M.top + y(t) + 3} textAnchor="end">
              {t >= 1000 ? `${t / 1000} s` : `${t} ms`}
            </text>
          ))}
          <text className="tick" x={M.left} y={HEIGHT - 4}>
            {axisLabel(start, span, zone)}
          </text>
          <text className="tick" x={M.left + innerW / 2} y={HEIGHT - 4} textAnchor="middle">
            {axisLabel(start + span / 2, span, zone)}
          </text>
          <text className="tick" x={width - M.right} y={HEIGHT - 4} textAnchor="end">
            {axisLabel(start + span, span, zone)}
          </text>
          {drag && dragW > 0 && <rect className="drag-sel" x={dragX} y={M.top} width={dragW} height={innerH} />}
        </svg>
        {hovered !== null && !drag && (
          <div className="chart-tooltip" style={{ left: Math.min(width - 190, Math.max(0, M.left + (hovered + 0.5) * bw - 95)) }} role="status">
            <div className="mono">{formatTimestamp(start + hovered * bucketMs, zone)}</div>
            <div className="small-text muted">{formatDuration(bucketMs)} from here</div>
            <div>
              <strong>{formatNumber(count[hovered]!)}</strong> requests
            </div>
            <div>
              p50 {msText(data.p50[hovered]!)} · p95 <strong>{msText(p95[hovered]!)}</strong>
            </div>
            <div>max {msText(data.max[hovered]!)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function axisLabel(ms: number, spanMs: number, zone: Parameters<typeof formatTimestamp>[1]): string {
  const s = formatTimestamp(ms, zone);
  return spanMs > 86_400_000 ? s.slice(5, 16) : s.slice(11, 19);
}
