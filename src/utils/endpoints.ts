import { isErrorRow, type LogIndex } from '../filters/logIndex';
import type { LogRow } from '../parser';
import { percentile } from './stats';

export { uriPattern } from './uriPattern';

export interface EndpointStat {
  /** Pattern key (as in index.uriPattern.values). */
  pattern: string;
  count: number;
  errors: number;
  /** Most common methods first. */
  methods: string[];
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/**
 * Per-endpoint request counts, errors and duration percentiles over the rows whose filter
 * `mask` is 0 once `ignoreBits` are cleared (so the endpoint filter itself can be ignored).
 */
export function computeEndpoints(
  rows: readonly LogRow[],
  index: LogIndex,
  mask: Uint32Array,
  ignoreBits: number,
  methodKey: string | undefined,
): EndpointStat[] {
  const pat = index.uriPattern;
  if (!pat) return [];
  const keep = ~ignoreBits;
  let n = 0;
  for (let i = 0; i < mask.length; i++) if ((mask[i]! & keep) === 0) n++;
  const matched = new Uint32Array(n);
  for (let i = 0, j = 0; i < mask.length; i++) if ((mask[i]! & keep) === 0) matched[j++] = i;
  const g = pat.values.length;
  const counts = new Uint32Array(g);
  const errors = new Uint32Array(g);
  const methods: (Map<string, number> | undefined)[] = new Array(g);
  const dur = index.duration;

  for (let i = 0; i < matched.length; i++) {
    const r = matched[i]!;
    const c = pat.codes[r]!;
    counts[c]!++;
    if (isErrorRow(index, r)) errors[c]!++;
    if (methodKey) {
      const m = rows[r]!.values[methodKey];
      if (typeof m === 'string') {
        const map = (methods[c] ??= new Map());
        map.set(m, (map.get(m) ?? 0) + 1);
      }
    }
  }

  // Durations bucketed per group in one typed array (counting sort), then sorted per group.
  const offsets = new Uint32Array(g + 1);
  let durByGroup: Float64Array | null = null;
  const filled = new Uint32Array(g);
  if (dur) {
    for (let c = 0; c < g; c++) offsets[c + 1] = offsets[c]! + counts[c]!;
    durByGroup = new Float64Array(matched.length);
    for (let i = 0; i < matched.length; i++) {
      const r = matched[i]!;
      const d = dur[r]!;
      if (!Number.isFinite(d)) continue;
      const c = pat.codes[r]!;
      durByGroup[offsets[c]! + filled[c]!++] = d;
    }
  }

  const out: EndpointStat[] = [];
  for (let c = 0; c < g; c++) {
    if (counts[c] === 0) continue;
    let avgMs = Number.NaN;
    let p50Ms = Number.NaN;
    let p95Ms = Number.NaN;
    let maxMs = Number.NaN;
    if (durByGroup && filled[c]! > 0) {
      const d = durByGroup.subarray(offsets[c]!, offsets[c]! + filled[c]!).sort();
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i]!;
      avgMs = sum / d.length;
      p50Ms = percentile(d, 50);
      p95Ms = percentile(d, 95);
      maxMs = d[d.length - 1]!;
    }
    const m = methods[c];
    out.push({
      pattern: pat.values[c]!,
      count: counts[c]!,
      errors: errors[c]!,
      methods: m ? [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k) : [],
      avgMs,
      p50Ms,
      p95Ms,
      maxMs,
    });
  }
  return out.sort((a, b) => b.count - a.count || (a.pattern < b.pattern ? -1 : 1));
}
