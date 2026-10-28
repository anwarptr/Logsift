import { type DisplayZone, UTC_ZONE, formatOffset, wallClockIso, zoneOffsetAt } from './timezone';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/** "2026-10-27 04:42:02.120" as wall-clock time in `zone` (UTC by default). */
export function formatTimestamp(ms: number | null, zone: DisplayZone = UTC_ZONE): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  const iso = wallClockIso(ms, zone);
  const frac = iso.slice(19, 23);
  return iso.slice(0, 10) + ' ' + iso.slice(11, 19) + (frac === '.000' ? '' : frac);
}

/** "2026-10-27T08:42:02.120+04:00" (or "…Z" for UTC): unambiguous, in `zone`'s wall-clock time. */
export function formatIsoWithOffset(ms: number, zone: DisplayZone = UTC_ZONE): string {
  const off = zoneOffsetAt(zone, ms);
  return wallClockIso(ms, zone) + (off === 0 ? 'Z' : formatOffset(off).slice(3));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}
