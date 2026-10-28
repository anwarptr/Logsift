import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('fixtures', () => {
  it('sample-iis.log has 16 data lines', () => {
    const text = readFileSync('fixtures/sample-iis.log', 'utf8');
    const data = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
    expect(data).toHaveLength(16);
  });
});
