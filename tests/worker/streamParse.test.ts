import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseText } from '../../src/parser';
import { ParseError, streamParse, type StreamBatch } from '../../src/worker/streamParse';

const sample = readFileSync('fixtures/sample-iis.log', 'utf8');

async function collect(blob: Blob, chunkBytes: number, batchRows = 5) {
  const batches: StreamBatch[] = [];
  const summary = await streamParse(blob, { chunkBytes, batchRows, onBatch: (b) => batches.push(b) });
  return { summary, rows: batches.flatMap((b) => b.rows), malformed: batches.flatMap((b) => b.malformed), batches };
}

describe('streamParse', () => {
  it('matches the one-shot parser regardless of chunk size', async () => {
    const expected = parseText(sample);
    for (const chunk of [7, 64, 1000, 1 << 20]) {
      const { summary, rows } = await collect(new Blob([sample]), chunk);
      expect(summary.format).toBe('iis');
      expect(rows).toEqual(expected.rows);
    }
  });

  it('emits rows in batches', async () => {
    const { batches } = await collect(new Blob([sample]), 1 << 20, 5);
    expect(batches.filter((b) => b.rows.length > 0).length).toBeGreaterThan(1);
  });

  it('handles multi-byte characters split across chunks', async () => {
    const text = '2026-01-01 00:00:00 INFO héllo wörld ✓\n2026-01-01 00:00:01 INFO ünïcode ✓';
    const { rows } = await collect(new Blob([text]), 3);
    expect(rows.map((r) => r.values.message)).toEqual(['héllo wörld ✓', 'ünïcode ✓']);
  });

  it('honours a forced format', async () => {
    const { summary } = await collect(new Blob([sample]), 1 << 20);
    expect(summary.detected).toBe('iis');
    const forced = await streamParse(new Blob([sample]), { format: 'generic', onBatch: () => {} });
    expect(forced.format).toBe('generic');
    expect(forced.detected).toBe('iis');
  });

  it('rejects empty and binary files', async () => {
    await expect(collect(new Blob([]), 10)).rejects.toBeInstanceOf(ParseError);
    await expect(collect(new Blob(['\n\n  \n']), 10)).rejects.toThrow(/No log entries/);
    await expect(collect(new Blob([new Uint8Array(500)]), 1000)).rejects.toThrow(/binary/);
  });
});
