import { describe, expect, it } from 'vitest';
import type { LogTimeZone } from '../../src/parser';
import { formatIsoWithOffset, formatTimestamp } from '../../src/utils/format';
import { histogram } from '../../src/utils/stats';
import {
  differsFromLocal,
  displayZoneLabel,
  formatOffset,
  fromZonedInput,
  logDisplayZone,
  toZonedInput,
  type DisplayZone,
} from '../../src/utils/timezone';

const T = Date.UTC(2026, 9, 27, 4, 42, 2, 120); // 2026-10-27 04:42:02.120Z
const fixed = (offsetMin: number): DisplayZone => ({ kind: 'fixed', offsetMin });
const local: DisplayZone = { kind: 'local' };
const tz = (kind: LogTimeZone['kind'], offsetMin = 0): LogTimeZone => ({ kind, offsetMin, source: '' });

describe('formatting in a zone', () => {
  it('defaults to UTC', () => {
    expect(formatTimestamp(T)).toBe('2026-10-27 04:42:02.120');
  });

  it('shifts to fixed offsets, including day rollover', () => {
    expect(formatTimestamp(T, fixed(240))).toBe('2026-10-27 08:42:02.120');
    expect(formatTimestamp(T, fixed(-330))).toBe('2026-10-26 23:12:02.120');
  });

  it('uses the browser zone for local (tests run in Asia/Dubai)', () => {
    expect(formatTimestamp(T, local)).toBe('2026-10-27 08:42:02.120');
  });

  it('writes ISO strings with an explicit offset', () => {
    expect(formatIsoWithOffset(T)).toBe('2026-10-27T04:42:02.120Z');
    expect(formatIsoWithOffset(T, fixed(240))).toBe('2026-10-27T08:42:02.120+04:00');
    expect(formatIsoWithOffset(T, fixed(-330))).toBe('2026-10-26T23:12:02.120-05:30');
  });

  it('labels offsets', () => {
    expect(formatOffset(0)).toBe('UTC');
    expect(formatOffset(240)).toBe('UTC+04:00');
    expect(formatOffset(-330)).toBe('UTC-05:30');
    expect(displayZoneLabel(local, T)).toBe('local, UTC+04:00');
  });
});

describe('datetime-local inputs', () => {
  it('round-trip in fixed and local zones', () => {
    const t = Date.UTC(2026, 9, 27, 4, 42, 2);
    for (const z of [fixed(0), fixed(240), fixed(-330), local]) {
      expect(fromZonedInput(toZonedInput(t, z), z)).toBe(t);
    }
    expect(toZonedInput(t, fixed(240))).toBe('2026-10-27T08:42:02');
    expect(fromZonedInput('2026-10-27T08:42', fixed(240))).toBe(Date.UTC(2026, 9, 27, 4, 42));
    expect(fromZonedInput('', local)).toBeNull();
  });
});

describe('log vs local zone', () => {
  it('log display zone uses the offset only when there is a single one', () => {
    expect(logDisplayZone(tz('offset', 240))).toEqual(fixed(240));
    expect(logDisplayZone(tz('mixed'))).toEqual(fixed(0));
    expect(logDisplayZone(null)).toEqual(fixed(0));
  });

  it('detects a difference from the local zone (Asia/Dubai)', () => {
    expect(differsFromLocal(tz('utc'), T, T)).toBe(true);
    expect(differsFromLocal(tz('offset', 240), T, T)).toBe(false);
    expect(differsFromLocal(tz('offset', -420), T, T)).toBe(true);
    expect(differsFromLocal(tz('unspecified'), T, T)).toBe(true);
  });
});

describe('histogram alignment', () => {
  it('aligns hourly buckets to wall-clock hours in the zone', () => {
    const H = 3_600_000;
    const min = Date.UTC(2026, 9, 27, 4, 10);
    expect(histogram([min], min, min + 2 * H, H).start).toBe(Date.UTC(2026, 9, 27, 4, 0));
    // In UTC+05:30 the hour starts at :30 UTC.
    expect(histogram([min], min, min + 2 * H, H, 330 * 60_000).start).toBe(Date.UTC(2026, 9, 27, 3, 30));
  });
});
