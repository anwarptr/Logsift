import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseText } from '../../src/parser';
import { sortIndices } from '../../src/utils/sort';

const { rows, schema } = parseText(readFileSync('fixtures/sample-iis.log', 'utf8'));
const all = Uint32Array.from(rows.map((_, i) => i));
const col = (k: string) => schema.find((c) => c.key === k)!;

describe('sortIndices', () => {
  it('sorts numbers ascending and descending (stable)', () => {
    const asc = [...sortIndices(rows, all, col('time-taken'), 'asc')].map((i) => rows[i]!.values['time-taken']);
    expect(asc).toEqual([...asc].sort((a, b) => (a as number) - (b as number)));
    const desc = sortIndices(rows, all, col('time-taken'), 'desc');
    expect(rows[desc[0]!]!.values['time-taken']).toBe(4414);
  });

  it('puts nulls last for strings', () => {
    const s = [...sortIndices(rows, all, col('cs(User-Agent)'), 'asc')].map((i) => rows[i]!.values['cs(User-Agent)']);
    expect(s.slice(0, 6).every((v) => v === 'AlwaysOn')).toBe(true);
    expect(s.slice(6).every((v) => v === null)).toBe(true);
  });

  it('does not mutate the input', () => {
    const copy = Uint32Array.from(all);
    sortIndices(rows, all, col('c-ip'), 'desc');
    expect(all).toEqual(copy);
  });
});
