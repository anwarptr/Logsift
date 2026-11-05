import { describe, expect, it } from 'vitest';
import type { LogRow } from '../../src/parser';
import { mergeAppend, mergeByTime } from '../../src/store/logStore';

const row = (ts: number | null, name: string): LogRow => ({ id: -1, lineNo: 1, ts, values: { name }, raw: name });
const names = (rows: LogRow[]) => rows.map((r) => r.values.name);

describe('mergeAppend', () => {
  it('appends new rows that are all newer', () => {
    const rows = [row(1, 'a'), row(2, 'b')];
    rows.forEach((r, i) => (r.id = i));
    const out = mergeAppend(rows, [row(3, 'c'), row(4, 'd')]);
    expect(names(out)).toEqual(['a', 'b', 'c', 'd']);
    expect(out.map((r) => r.id)).toEqual([0, 1, 2, 3]);
  });

  it('merges older new rows in from their time on, stably, and renumbers from there', () => {
    const rows = [row(1, 'a'), row(3, 'b'), row(5, 'c'), row(null, 'z')];
    rows.forEach((r, i) => (r.id = i));
    const out = mergeAppend(rows, [row(6, 'f'), row(3, 'b2'), row(2, 'x'), row(null, 'z2')]);
    expect(names(out)).toEqual(['a', 'x', 'b', 'b2', 'c', 'f', 'z', 'z2']);
    expect(out.map((r) => r.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Rows before the merge point are the same objects, untouched.
    expect(out[0]).toBe(rows[0]);
  });

  it('gives the same order as a full sort', () => {
    const rows = mergeByTime(Array.from({ length: 50 }, (_, i) => row((i * 7) % 23, `r${i}`)));
    const added = Array.from({ length: 20 }, (_, i) => row((i * 5) % 31, `n${i}`));
    const expected = names(mergeByTime([...rows, ...added]));
    expect(names(mergeAppend(rows, added))).toEqual(expected);
  });
});
