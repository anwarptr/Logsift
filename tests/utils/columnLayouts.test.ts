import { beforeEach, describe, expect, it } from 'vitest';
import { clearLayout, layoutKey, loadLayout, orderWithLayout, saveLayout } from '../../src/store/columnLayouts';

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

  it('order known columns as saved and keep new ones after them', () => {
    const layout = { order: ['c', 'a'], hidden: [], widths: {}, at: 0 };
    expect(orderWithLayout(['a', 'b', 'c', 'd'], layout)).toEqual(['c', 'a', 'b', 'd']);
    expect(orderWithLayout(['a', 'b'], null)).toEqual(['a', 'b']);
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
