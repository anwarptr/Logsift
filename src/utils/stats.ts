/** Percentile (0–100) of an ascending-sorted array, linear interpolation between ranks. NaN for empty input. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0]!;
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  return a + (b - a) * (rank - lo);
}

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

/** Bucket sizes a human would pick for a time axis. */
export const NICE_BUCKETS_MS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  S, 2 * S, 5 * S, 10 * S, 15 * S, 30 * S,
  M, 2 * M, 5 * M, 10 * M, 15 * M, 30 * M,
  H, 2 * H, 3 * H, 6 * H, 12 * H,
  D, 2 * D, 7 * D, 14 * D, 30 * D,
];

/** Smallest "nice" bucket size that splits `rangeMs` into at most `targetBuckets` buckets. */
export function autoBucketSize(rangeMs: number, targetBuckets = 60): number {
  if (!(rangeMs > 0)) return S;
  for (const b of NICE_BUCKETS_MS) {
    if (rangeMs / b <= targetBuckets) return b;
  }
  const last = NICE_BUCKETS_MS[NICE_BUCKETS_MS.length - 1]!;
  return Math.ceil(rangeMs / targetBuckets / last) * last;
}

export interface Histogram {
  /** Start of the first bucket (aligned to bucketMs). */
  start: number;
  bucketMs: number;
  counts: Uint32Array;
}

/**
 * Count values into fixed-size buckets aligned to multiples of bucketMs.
 * Values outside [min, max] and NaN are ignored.
 */
/** `alignMs` shifts bucket boundaries so they fall on wall-clock multiples in a zone (its offset in ms). */
export function histogram(values: ArrayLike<number>, min: number, max: number, bucketMs: number, alignMs = 0): Histogram {
  const start = Math.floor((min + alignMs) / bucketMs) * bucketMs - alignMs;
  const n = Math.max(1, Math.floor((max - start) / bucketMs) + 1);
  const counts = new Uint32Array(n);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!(v >= min && v <= max)) continue;
    const b = Math.floor((v - start) / bucketMs);
    counts[Math.min(n - 1, b)]!++;
  }
  return { start, bucketMs, counts };
}

export interface NumberSummary {
  count: number;
  sum: number;
  avg: number;
  p95: number;
  max: number;
}

/** Summary over the finite values in `values` (NaN = missing). */
export function summarize(values: ArrayLike<number>): NumberSummary {
  const finite: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (Number.isFinite(v)) {
      finite.push(v);
      sum += v;
    }
  }
  const sorted = Float64Array.from(finite).sort();
  const count = sorted.length;
  return {
    count,
    sum,
    avg: count ? sum / count : Number.NaN,
    p95: percentile(sorted, 95),
    max: count ? sorted[count - 1]! : Number.NaN,
  };
}
