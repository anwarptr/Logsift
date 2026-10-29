// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Histogram } from '../../src/components/Histogram';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // jsdom has no PointerEvent; without it fireEvent.pointerMove drops clientX.
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent;
});

afterEach(cleanup);

const timeline = (n: number) => ({
  counts: Uint32Array.from({ length: n }, (_, i) => i + 1),
  errors: new Uint32Array(n),
  start: Date.UTC(2026, 2, 14, 9, 0, 0),
  bucketMs: 1000,
});

describe('Histogram', () => {
  it('shows a tooltip for the hovered bar', () => {
    const data = timeline(10);
    const { container, rerender } = render(<Histogram data={data} onSelect={() => {}} />);
    // Width defaults to 600 in jsdom: bars span x 40..592, ~55 px each; x = 560 is the last bar.
    fireEvent.pointerMove(container.querySelector('svg')!, { clientX: 560 });
    expect(screen.getByRole('status').textContent).toContain('10 rows');
    // Re-rendering with the same data keeps the tooltip.
    rerender(<Histogram data={data} onSelect={() => {}} />);
    expect(screen.getByRole('status').textContent).toContain('10 rows');
  });

  it('does not crash when the data shrinks under a hovered bar (e.g. after a drag-to-filter)', () => {
    const onSelect = vi.fn();
    const { container, rerender } = render(<Histogram data={timeline(10)} onSelect={onSelect} />);
    fireEvent.pointerMove(container.querySelector('svg')!, { clientX: 560 });
    expect(screen.getByRole('status')).toBeTruthy();

    rerender(<Histogram data={timeline(3)} onSelect={onSelect} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelectorAll('.bar')).toHaveLength(3);
  });
});
