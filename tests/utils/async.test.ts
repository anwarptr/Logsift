import { describe, expect, it } from 'vitest';
import { mapConcurrent } from '../../src/utils/async';

describe('mapConcurrent', () => {
  it('handles empty input array', async () => {
    const res = await mapConcurrent([], 4, async (x) => x);
    expect(res).toEqual([]);
  });

  it('preserves order while respecting concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;
    const items = [10, 20, 30, 40, 50, 60, 70];

    const results = await mapConcurrent(items, 3, async (val) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      // Small simulated delay
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return val * 2;
    });

    expect(results).toEqual([20, 40, 60, 80, 100, 120, 140]);
    expect(maxRunning).toBeLessThanOrEqual(3);
  });

  it('passes index to mapping function', async () => {
    const items = ['a', 'b', 'c'];
    const results = await mapConcurrent(items, 2, async (val, i) => `${i}:${val}`);
    expect(results).toEqual(['0:a', '1:b', '2:c']);
  });
});
