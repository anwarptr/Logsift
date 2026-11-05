import { beforeEach, describe, expect, it } from 'vitest';
import { clearLayout, insertWithLayout, layoutKey, loadLayout, MAX_LAYOUT_COLUMNS, saveLayout } from '../../src/store/columnLayouts';

// Node has no localStorage: a small in-memory one.
beforeEach(() => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
});

describe('column layouts', () => {
  it('are kept per format, and per pattern for the custom format', () => {
    expect(layoutKey('iis', 'x')).toBe('iis');
    expect(layoutKey('custom', '{time} {message}')).toBe('custom:{time} {message}');
    expect(layoutKey(null, '')).toBeNull();
  });

  it('save and load order, hidden columns and widths', () => {
    saveLayout('iis', ['b', 'a', 'c'], { c: true }, { a: 100, b: 200 });
    expect(loadLayout('iis')).toMatchObject({ order: ['b', 'a', 'c'], hidden: ['c'], widths: { a: 100, b: 200 } });
    expect(loadLayout('jsonl')).toBeNull();
    clearLayout('iis');
    expect(loadLayout('iis')).toBeNull();
  });

  it('keep columns of earlier logs that the current one does not have', () => {
    saveLayout('jsonl', ['level', 'appA', 'message'], { appA: true }, { appA: 50 });
    saveLayout('jsonl', ['message', 'level', 'appB'], {}, { appB: 70 });
    const l = loadLayout('jsonl')!;
    expect(l.order).toEqual(['message', 'level', 'appB', 'appA']);
    expect(l.hidden).toEqual(['appA']);
    expect(l.widths).toMatchObject({ appA: 50, appB: 70 });
  });

  it('place new columns as saved, without moving the ones already shown', () => {
    const layout = { order: ['c', 'a', 'x', 'b'], hidden: [], widths: {}, at: 0 };
    // First batch: the saved order, unknown columns after.
    expect(insertWithLayout([], ['a', 'b', 'c', 'd'], layout)).toEqual(['c', 'a', 'b', 'd']);
    // Later columns go after their saved neighbour; the user's current order is kept.
    expect(insertWithLayout(['a', 'c', 'b'], ['x', 'e'], layout)).toEqual(['a', 'x', 'c', 'b', 'e']);
    expect(insertWithLayout(['a', 'b'], ['c'], layout)).toEqual(['c', 'a', 'b']);
    expect(insertWithLayout(['a'], ['b'], null)).toEqual(['a', 'b']);
  });

  it('ignore or clean up broken saved layouts', () => {
    localStorage.setItem(
      'logsift:column-layouts',
      JSON.stringify({
        iis: { order: [], hidden: [], widths: null },
        jsonl: { order: ['a', 3], hidden: [], widths: {} },
        csv: { order: ['a'], hidden: ['a'], widths: { a: 120, b: 'wide', c: -5 } },
      }),
    );
    expect(loadLayout('iis')).toMatchObject({ widths: {} });
    expect(loadLayout('jsonl')).toBeNull();
    expect(loadLayout('csv')!.widths).toEqual({ a: 120 });
    expect(() => saveLayout('iis', ['a'], {}, { a: 99 })).not.toThrow();
    expect(loadLayout('iis')!.widths).toEqual({ a: 99 });
  });

  it(`remember at most ${MAX_LAYOUT_COLUMNS} columns per layout, this log's first`, () => {
    const old = Array.from({ length: MAX_LAYOUT_COLUMNS }, (_, i) => `old${i}`);
    saveLayout('jsonl', old, {}, {});
    saveLayout('jsonl', ['new1', 'new2'], {}, {});
    const l = loadLayout('jsonl')!;
    expect(l.order).toHaveLength(MAX_LAYOUT_COLUMNS);
    expect(l.order.slice(0, 3)).toEqual(['new1', 'new2', 'old0']);
  });

  it('forget the oldest layouts beyond the limit, and ignore broken storage', () => {
    for (let i = 0; i < 35; i++) saveLayout(`custom:${i}`, ['a'], {}, {});
    expect(loadLayout('custom:0')).toBeNull();
    expect(loadLayout('custom:34')).not.toBeNull();
    localStorage.setItem('logsift:column-layouts', '{not json');
    expect(loadLayout('iis')).toBeNull();
    expect(() => saveLayout('iis', ['a'], {}, {})).not.toThrow();
  });
});
