import type { LogTimeZone } from '../parser';

/** Zone timestamps are displayed in: a fixed offset (the log's own) or the browser's local zone. */
export type DisplayZone = { kind: 'fixed'; offsetMin: number } | { kind: 'local' };

export const UTC_ZONE: DisplayZone = { kind: 'fixed', offsetMin: 0 };

const MIN = 60_000;

/** Offset in minutes east of UTC at instant `ms` (local zones vary with DST). */
export function zoneOffsetAt(zone: DisplayZone, ms: number): number {
  return zone.kind === 'fixed' ? zone.offsetMin : -new Date(ms).getTimezoneOffset();
}

/** "UTC", "UTC+04:00", "UTC-05:30". */
export function formatOffset(offsetMin: number): string {
  if (offsetMin === 0) return 'UTC';
  const a = Math.abs(offsetMin);
  const hh = String(Math.floor(a / 60)).padStart(2, '0');
  const mm = String(a % 60).padStart(2, '0');
  return `UTC${offsetMin < 0 ? '-' : '+'}${hh}:${mm}`;
}

/** IANA name of the browser's zone, e.g. "Asia/Dubai" (empty if unavailable). */
export function localZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** Short label for headings: "UTC", "UTC+04:00", "local, UTC+04:00" (local offset taken at `ms`). */
export function displayZoneLabel(zone: DisplayZone, ms: number): string {
  const off = formatOffset(zoneOffsetAt(zone, ms));
  return zone.kind === 'local' ? `local, ${off}` : off;
}

/** Display zone for "log time": the log's own offset; mixed or unstated zones show as UTC. */
export function logDisplayZone(tz: LogTimeZone | null): DisplayZone {
  return tz?.kind === 'offset' ? { kind: 'fixed', offsetMin: tz.offsetMin } : UTC_ZONE;
}

/** True if local time differs from the log's time anywhere in the file's span (checked at both ends for DST). */
export function differsFromLocal(tz: LogTimeZone | null, minTs: number | null, maxTs: number | null): boolean {
  const own = logDisplayZone(tz);
  const local: DisplayZone = { kind: 'local' };
  const at = [minTs ?? Date.now(), maxTs ?? minTs ?? Date.now()];
  return at.some((ms) => zoneOffsetAt(local, ms) !== zoneOffsetAt(own, ms));
}

/** Wall-clock ISO string "YYYY-MM-DDTHH:MM:SS.sss" of `ms` in `zone` (no zone suffix). */
export function wallClockIso(ms: number, zone: DisplayZone): string {
  return new Date(ms + zoneOffsetAt(zone, ms) * MIN).toISOString().slice(0, 23);
}

/** Value for an <input type="datetime-local" step="1"> showing `ms` in `zone`. */
export function toZonedInput(ms: number, zone: DisplayZone): string {
  return wallClockIso(ms, zone).slice(0, 19);
}

/** Inverse of toZonedInput; returns null for an empty or invalid value. */
export function fromZonedInput(value: string, zone: DisplayZone): number | null {
  if (!value) return null;
  if (value.length === 16) value += ':00'; // browsers omit ":00" seconds
  if (zone.kind === 'local') {
    const t = new Date(value).getTime(); // no zone suffix → parsed as local time
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(value + 'Z');
  return Number.isNaN(t) ? null : t - zone.offsetMin * MIN;
}

/** Offset (ms) to align histogram buckets to wall-clock boundaries in `zone`. */
export function alignOffsetMs(zone: DisplayZone, ms: number): number {
  return zoneOffsetAt(zone, ms) * MIN;
}
