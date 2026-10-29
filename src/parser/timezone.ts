/**
 * The time zone a log's timestamps were written in, as far as the file tells us.
 * `offsetMin` is minutes east of UTC (UTC+04:00 → 240); it is 0 for every kind except 'offset'.
 */
export interface LogTimeZone {
  kind: 'utc' | 'offset' | 'mixed' | 'unspecified';
  offsetMin: number;
  /** Short explanation shown next to the zone, e.g. "IIS logs are always UTC". */
  source: string;
  /**
   * Set when lines had a time but no date: the date(s) assumed for them ("2026-10-29", or a
   * range across midnight), taken from the file's modified date or, for pasted text, today.
   */
  assumedDate?: string;
}

export const IIS_TIME_ZONE: LogTimeZone = { kind: 'utc', offsetMin: 0, source: 'IIS logs are always UTC' };

const ZONE_SUFFIX_RE = /(?:(Z)|([+-])(\d{2}):?(\d{2}))\s*$/i;

/** Offset of a trailing "Z", "+04:00" or "-0530" in minutes east of UTC, or null if the string has none. */
export function parseZoneSuffix(s: string): number | null {
  const m = ZONE_SUFFIX_RE.exec(s);
  if (!m) return null;
  if (m[1]) return 0;
  const min = +m[3]! * 60 + +m[4]!;
  return m[2] === '-' ? -min : min;
}

/** Summarises the zone offsets seen on a log's timestamps. */
export class OffsetTracker {
  private first: number | null = null;
  private mixed = false;
  private sawNaive = false;

  /** `offsetMin` null means the timestamp was written without a zone. */
  observe(offsetMin: number | null): void {
    if (offsetMin === null) this.sawNaive = true;
    else if (this.first === null) this.first = offsetMin;
    else if (offsetMin !== this.first) this.mixed = true;
  }

  result(): LogTimeZone {
    if (this.first === null) {
      return { kind: 'unspecified', offsetMin: 0, source: this.sawNaive ? 'no zone in timestamps, assumed UTC' : 'no timestamps' };
    }
    if (this.mixed) return { kind: 'mixed', offsetMin: 0, source: 'timestamps use several offsets' };
    if (this.first === 0) return { kind: 'utc', offsetMin: 0, source: 'from timestamps' };
    return { kind: 'offset', offsetMin: this.first, source: 'from timestamps' };
  }
}
