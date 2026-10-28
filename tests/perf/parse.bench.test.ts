import { describe, expect, it } from 'vitest';
import { generateIisLog } from '../../scripts/gen-iis';
import { evaluateFilters } from '../../src/filters/applyFilters';
import { buildLogIndex } from '../../src/filters/logIndex';
import { EMPTY_FILTERS } from '../../src/filters/types';
import { parseText } from '../../src/parser';
import { computeInsights } from '../../src/utils/insights';
import { sortIndices } from '../../src/utils/sort';

const LINES = 500_000;
const TARGET_MS = 5_000;

function time<T>(label: string, fn: () => T): { result: T; ms: number } {
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(28)} ${ms.toFixed(0).padStart(6)} ms`);
  return { result, ms };
}

describe(`performance (${LINES.toLocaleString()} IIS lines)`, () => {
  it('parses, indexes and filters within budget', () => {
    const { result: text } = time('generate', () => generateIisLog(LINES));
    console.log(`input size                   ${(text.length / 1048576).toFixed(1)} MB`);

    const { result: parsed, ms: parseMs } = time('parse', () => parseText(text));
    expect(parsed.format).toBe('iis');
    expect(parsed.rows.length).toBe(LINES);
    expect(parsed.malformed.length).toBe(0);

    const { result: index } = time('build index', () => buildLogIndex(parsed.rows, parsed.schema));
    const opts = { slowThresholdMs: 1000 };
    time('filter: none', () => evaluateFilters(parsed.rows, index, EMPTY_FILTERS, opts));
    const { result: ev } = time('filter: combined', () =>
      evaluateFilters(
        parsed.rows,
        index,
        {
          ...EMPTY_FILTERS,
          search: 'api',
          hideHealthChecks: true,
          onlyErrors: true,
          facets: { 'cs-method': ['GET'] },
          ranges: { 'time-taken': [50, null] },
        },
        opts,
      ),
    );
    time('filter: regex search', () =>
      evaluateFilters(parsed.rows, index, { ...EMPTY_FILTERS, search: 'products/\\d+', regex: true }, opts),
    );
    time('insights (all rows)', () => computeInsights(parsed.rows, parsed.schema, index, Uint32Array.from(parsed.rows.keys())));
    expect(ev.matched.length).toBeGreaterThan(0);
    const all = Uint32Array.from(parsed.rows.keys());
    const col = (k: string) => parsed.schema.find((c) => c.key === k)!;
    time('sort: string column', () => sortIndices(parsed.rows, all, col('cs-uri-stem'), 'asc'));
    time('sort: number column', () => sortIndices(parsed.rows, all, col('time-taken'), 'desc'));
    globalThis.gc?.();
    console.log(`heap used after parse       ${(process.memoryUsage().heapUsed / 1048576).toFixed(0).padStart(6)} MB`);

    if (parseMs > TARGET_MS) console.warn(`Parse took ${parseMs.toFixed(0)} ms, above the ${TARGET_MS} ms target`);
    // Hard ceiling with headroom for slow CI machines; the target itself is logged above.
    expect(parseMs).toBeLessThan(TARGET_MS * 2);
  });
});
