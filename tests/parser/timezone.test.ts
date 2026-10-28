import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseText, parseZoneSuffix } from '../../src/parser';
import { parseApacheTimestamp } from '../../src/parser/apache';
import { toEpochMs } from '../../src/parser/jsonl';

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');

describe('parseZoneSuffix', () => {
  it('reads Z and numeric offsets', () => {
    expect(parseZoneSuffix('2026-10-27T04:42:02Z')).toBe(0);
    expect(parseZoneSuffix('2026-10-27T04:42:02.120+04:00')).toBe(240);
    expect(parseZoneSuffix('2026-10-27 04:42:02 +0530')).toBe(330);
    expect(parseZoneSuffix('10/Oct/2000:13:55:36 -0700')).toBe(-420);
    expect(parseZoneSuffix('2026-10-27 04:42:02')).toBeNull();
  });
});

describe('log time zone detection', () => {
  it('IIS logs are UTC', () => {
    expect(parseText(fixture('sample-iis.log')).timeZone).toMatchObject({ kind: 'utc', offsetMin: 0 });
  });

  it('Apache uses the offset in the timestamps', () => {
    const text = '127.0.0.1 - - [10/Oct/2000:13:55:36 -0700] "GET / HTTP/1.0" 200 2326\n';
    expect(parseText(text, 'apache').timeZone).toMatchObject({ kind: 'offset', offsetMin: -420 });
    expect(parseApacheTimestamp('10/Oct/2000:13:55:36 -0700')).toBe(Date.UTC(2000, 9, 10, 20, 55, 36));
  });

  it('generic text: offsets, Z, zone-less and mixed', () => {
    expect(parseText('2026-10-27 08:42:02 +04:00 INFO a\n2026-10-27 08:43:02 +04:00 INFO b\n', 'generic').timeZone).toMatchObject({
      kind: 'offset',
      offsetMin: 240,
    });
    expect(parseText('2026-10-27T04:42:02Z INFO a\n', 'generic').timeZone.kind).toBe('utc');
    expect(parseText('2026-10-27 04:42:02 INFO a\n', 'generic').timeZone.kind).toBe('unspecified');
    expect(parseText('2026-10-27T04:42:02Z INFO a\n2026-10-27T08:42:02+04:00 INFO b\n', 'generic').timeZone.kind).toBe('mixed');
  });

  it('JSON lines: string timestamps count, epoch numbers do not', () => {
    expect(parseText('{"time":"2026-10-27T08:42:02+04:00","msg":"a"}\n', 'jsonl').timeZone).toMatchObject({
      kind: 'offset',
      offsetMin: 240,
    });
    expect(parseText('{"time":1793076122000,"msg":"a"}\n', 'jsonl').timeZone.kind).toBe('unspecified');
  });

  it('zone-less JSON timestamps are read as UTC, not local time', () => {
    expect(toEpochMs('2026-10-27T04:42:02')).toBe(Date.UTC(2026, 9, 27, 4, 42, 2));
    expect(toEpochMs('2026-10-27T08:42:02+04:00')).toBe(Date.UTC(2026, 9, 27, 4, 42, 2));
  });
});
