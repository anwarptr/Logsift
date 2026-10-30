import { useState } from 'react';
import { useLogStore } from '../../store/logStore';
import { OTHER_KEY, type Flow, type FlowNode } from '../../utils/charts';
import { formatNumber } from '../../utils/format';
import { useWidth } from './useWidth';

const NODE_W = 10;
const PAD = 8;
const LEFT_LABELS = 150;
const RIGHT_LABELS = 96;

const STATUS_VAR: Record<string, string> = { '2xx': '--ok', '3xx': '--info', '4xx': '--warn', '5xx': '--err' };
const statusColor = (cls: string | null) => `var(${(cls && STATUS_VAR[cls]) ?? '--fg-muted'})`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

interface Placed {
  node: FlowNode;
  x: number;
  y: number;
  h: number;
}

/** Stack a column's nodes top to bottom (vertically centred), heights proportional to count. */
function place(nodes: FlowNode[], x: number, k: number, height: number): Placed[] {
  const used = nodes.reduce((s, n) => s + n.count * k, 0) + PAD * (nodes.length - 1);
  let y = (height - used) / 2;
  return nodes.map((node) => {
    const p = { node, x, y, h: Math.max(1, node.count * k) };
    y += p.h + PAD;
    return p;
  });
}

interface Link {
  key: string;
  from: [col: number, i: number];
  to: [col: number, i: number];
  d: string;
  color: string;
  count: number;
}

/** Ribbons between two columns: each node's links stacked in the order of the nodes at the other end. */
function ribbons(src: Placed[], dst: Placed[], counts: Map<string, number>, k: number, col: number, color: (j: number) => string): Link[] {
  const pairs = [...counts].map(([key, count]) => {
    const [a, b] = key.split(',').map(Number) as [number, number];
    return { a, b, count };
  });
  const out = new Map<string, { sy: number; ty: number }>();
  const sOff = src.map((p) => p.y);
  for (const p of [...pairs].sort((x, y) => x.a - y.a || x.b - y.b)) {
    out.set(`${p.a},${p.b}`, { sy: sOff[p.a]!, ty: 0 });
    sOff[p.a]! += p.count * k;
  }
  const tOff = dst.map((p) => p.y);
  for (const p of [...pairs].sort((x, y) => x.b - y.b || x.a - y.a)) {
    out.get(`${p.a},${p.b}`)!.ty = tOff[p.b]!;
    tOff[p.b]! += p.count * k;
  }
  return pairs.map((p) => {
    const { sy, ty } = out.get(`${p.a},${p.b}`)!;
    const t = Math.max(1, p.count * k);
    const x0 = src[p.a]!.x + NODE_W;
    const x1 = dst[p.b]!.x;
    const xm = (x0 + x1) / 2;
    const d = `M${x0},${sy}C${xm},${sy} ${xm},${ty} ${x1},${ty}L${x1},${ty + t}C${xm},${ty + t} ${xm},${sy + t} ${x0},${sy + t}Z`;
    return { key: `${col}:${p.a},${p.b}`, from: [col, p.a], to: [col + 1, p.b], d, color: color(p.b), count: p.count };
  });
}

/**
 * Who calls which endpoints and how those calls end: callers → endpoint patterns → status classes,
 * ribbon width = requests. Logs without a caller column start at the endpoints. Hover a box to highlight its flows; click it to filter the rows.
 */
export function RequestFlow({ flow, callerIsFacet }: { flow: Flow; callerIsFacet: boolean }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>(800, 420);
  const setFilters = useLogStore((s) => s.setFilters);
  const facets = useLogStore((s) => s.filters.facets);
  const [hover, setHover] = useState<[number, number] | null>(null);

  const cols = [flow.callers, flow.endpoints, flow.statuses];
  const maxN = Math.max(...cols.map((c) => c.length));
  const height = Math.max(220, maxN * 28);
  const hasCallers = flow.callers.length > 0;
  const total = flow.endpoints.reduce((s, n) => s + n.count, 0);
  const k = (height - PAD * (maxN - 1)) / Math.max(1, total);
  const xs = [LEFT_LABELS, hasCallers ? Math.round((width - NODE_W) / 2) : 8, width - RIGHT_LABELS - NODE_W];
  const placed = cols.map((nodes, c) => place(nodes, xs[c]!, k, height));
  const links = [
    ...ribbons(placed[0]!, placed[1]!, flow.callerToEndpoint, k, 0, () => 'var(--fg-muted)'),
    ...ribbons(placed[1]!, placed[2]!, flow.endpointToStatus, k, 1, (j) => statusColor(flow.statuses[j]!.cls)),
  ];
  const touches = (l: Link) => !!hover && ((l.from[0] === hover[0] && l.from[1] === hover[1]) || (l.to[0] === hover[0] && l.to[1] === hover[1]));

  const pick = (col: number, node: FlowNode) => {
    if (node.key === OTHER_KEY) return;
    if (col === 0 && callerIsFacet) setFilters({ facets: { ...facets, [flow.callerKey]: [node.key] } });
    if (col === 1) setFilters({ endpoint: node.key });
    if (col === 2 && flow.statuses.find((s) => s.key === node.key)?.cls) {
      setFilters({ statusClasses: [flow.statuses.find((s) => s.key === node.key)!.cls!] });
    }
  };
  const canPick = (col: number, node: FlowNode) =>
    node.key !== OTHER_KEY && (col === 1 || (col === 0 && callerIsFacet) || (col === 2 && !!flow.statuses.find((s) => s.key === node.key)?.cls));
  const hovered = hover ? placed[hover[0]]![hover[1]]! : null;

  return (
    <div className="chart-block" ref={wrapRef}>
      <div className="chart-head">
        <span className="chart-title">Request flow</span>
        <span className="muted small-text">
          {hasCallers ? `${flow.callerLabel} → ` : ''}endpoint → status · width = requests · click a box to filter
        </span>
      </div>
      <div className="chart-plot" style={{ height }}>
        <svg width={width} height={height} role="img" aria-label={`Request flow from ${flow.callers.length} callers through ${flow.endpoints.length} endpoints to ${flow.statuses.length} status classes`}>
          {links.map((l) => (
            <path
              key={l.key}
              d={l.d}
              className={'flow-link' + (hover ? (touches(l) ? ' on' : ' off') : '')}
              style={{ fill: l.color }}
            />
          ))}
          {placed.map((col, c) =>
            col.map((p, i) => (
              <g
                key={`${c}:${p.node.key}`}
                className="flow-node"
                onPointerEnter={() => setHover([c, i])}
                onPointerLeave={() => setHover(null)}
                onClick={() => pick(c, p.node)}
                style={{ cursor: canPick(c, p.node) ? 'pointer' : 'default' }}
              >
                <rect x={p.x} y={p.y} width={NODE_W} height={p.h} rx={2} style={{ fill: c === 2 ? statusColor(flow.statuses[i]!.cls) : 'var(--chart-bar)' }} />
                {/* Wider hit target than the thin box. */}
                <rect x={p.x - 4} y={p.y - 2} width={NODE_W + 8} height={p.h + 4} fill="transparent" />
                <text
                  className="flow-label"
                  x={c === 0 ? p.x - 6 : p.x + NODE_W + 6}
                  y={p.y + p.h / 2 + 4}
                  textAnchor={c === 0 ? 'end' : 'start'}
                >
                  {clip(p.node.label, c === 0 ? 22 : c === 1 ? Math.max(12, Math.floor((xs[2]! - xs[1]! - 30) / 7)) : 12)}
                </text>
              </g>
            )),
          )}
        </svg>
        {hovered && hover && (
          <div
            className="chart-tooltip"
            style={{ left: Math.min(width - 190, Math.max(0, hovered.x - 90)), top: Math.min(height - 40, hovered.y + hovered.h + 6) }}
            role="status"
          >
            <div className="mono" style={{ overflowWrap: 'anywhere' }}>
              {hovered.node.label}
            </div>
            <div>
              <strong>{formatNumber(hovered.node.count)}</strong> requests ({Math.round((hovered.node.count / Math.max(1, total)) * 100)}%)
            </div>
            {hovered.node.errors > 0 && <div className="err-text">{formatNumber(hovered.node.errors)} errors</div>}
          </div>
        )}
      </div>
    </div>
  );
}
