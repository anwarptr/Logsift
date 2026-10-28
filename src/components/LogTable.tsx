import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { ColumnDef, LogRow } from '../parser';
import { useLogStore } from '../store/logStore';
import { useDisplayZone } from '../store/useView';
import type { DisplayZone } from '../utils/timezone';
import { renderCell } from './cells';

export const ROW_HEIGHT = { compact: 24, comfortable: 34 } as const;

interface LogTableProps {
  rows: LogRow[];
  /** Row indices to show, in display order (already filtered and sorted). */
  indices: Uint32Array;
  columns: ColumnDef[];
  highlight: RegExp | null;
}

interface RowProps {
  row: LogRow;
  columns: ColumnDef[];
  widths: Record<string, number>;
  highlight: RegExp | null;
  zone: DisplayZone;
  selected: boolean;
  active: boolean;
  slow: boolean;
  top: number;
  height: number;
  ariaIndex: number;
  onClick(id: number, viewIndex: number): void;
  viewIndex: number;
}

const Row = memo(function Row(p: RowProps) {
  const cls = ['tr', p.selected && 'selected', p.active && 'active', p.slow && 'slow'].filter(Boolean).join(' ');
  return (
    <div
      id={`row-${p.row.id}`}
      role="row"
      aria-rowindex={p.ariaIndex}
      aria-selected={p.selected}
      className={cls}
      style={{ transform: `translateY(${p.top}px)`, height: p.height }}
      onClick={() => p.onClick(p.row.id, p.viewIndex)}
    >
      {p.columns.map((c) => (
        <div key={c.key} role="gridcell" className={`td t-${c.type}`} style={{ width: p.widths[c.key] }}>
          {renderCell(c, p.row.values[c.key] ?? null, p.highlight, p.zone)}
        </div>
      ))}
    </div>
  );
});

export function LogTable({ rows, indices, columns, highlight }: LogTableProps) {
  const widths = useLogStore((s) => s.columnWidths);
  const sort = useLogStore((s) => s.sort);
  const toggleSort = useLogStore((s) => s.toggleSort);
  const setColumnWidth = useLogStore((s) => s.setColumnWidth);
  const selectedId = useLogStore((s) => s.selectedId);
  const select = useLogStore((s) => s.select);
  const density = useLogStore((s) => s.density);
  const slowMs = useLogStore((s) => s.slowThresholdMs);
  const schema = useLogStore((s) => s.schema);
  const durationKey = schema.find((c) => c.role === 'duration')?.key;
  const zone = useDisplayZone();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(0);
  const rowHeight = ROW_HEIGHT[density];
  const totalWidth = columns.reduce((sum, c) => sum + (widths[c.key] ?? 120), 0);

  const virtualizer = useVirtualizer({
    count: indices.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 15,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  // Keep the cursor in range when the view shrinks.
  useEffect(() => {
    if (cursor >= indices.length) setCursor(Math.max(0, indices.length - 1));
  }, [indices.length, cursor]);

  // When the selection changes from elsewhere (e.g. "jump to row" in insights), scroll it into view.
  useEffect(() => {
    if (selectedId === null) return;
    const current = indices[cursor];
    if (current === selectedId) return;
    const pos = indices.indexOf(selectedId);
    if (pos >= 0) {
      setCursor(pos);
      virtualizer.scrollToIndex(pos, { align: 'center' });
    }
  }, [selectedId, indices]);

  const onRowClick = useCallback(
    (id: number, viewIndex: number) => {
      setCursor(viewIndex);
      select(id);
    },
    [select],
  );

  function moveCursor(to: number) {
    if (indices.length === 0) return;
    const next = Math.max(0, Math.min(indices.length - 1, to));
    setCursor(next);
    virtualizer.scrollToIndex(next, { align: 'auto' });
    if (selectedId !== null) select(indices[next]!);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / rowHeight) - 1);
    switch (e.key) {
      case 'ArrowDown':
        moveCursor(cursor + 1);
        break;
      case 'ArrowUp':
        moveCursor(cursor - 1);
        break;
      case 'PageDown':
        moveCursor(cursor + page);
        break;
      case 'PageUp':
        moveCursor(cursor - page);
        break;
      case 'Home':
        moveCursor(0);
        break;
      case 'End':
        moveCursor(indices.length - 1);
        break;
      case 'Enter':
      case ' ': {
        const id = indices[cursor];
        if (id !== undefined) select(id);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }

  function startResize(e: PointerEvent<HTMLSpanElement>, key: string) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[key] ?? 120;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: globalThis.PointerEvent) => setColumnWidth(key, startW + ev.clientX - startX);
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  }

  const items = virtualizer.getVirtualItems();
  const activeId = indices[cursor];

  return (
    <div
      ref={scrollRef}
      className={`table-scroll density-${density}`}
      role="grid"
      aria-label="Log rows"
      aria-rowcount={indices.length + 1}
      aria-colcount={columns.length}
      aria-activedescendant={activeId !== undefined ? `row-${activeId}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="thead" role="rowgroup" style={{ width: totalWidth }}>
        <div className="tr header" role="row" aria-rowindex={1}>
          {columns.map((c) => {
            const sorted = sort?.key === c.key ? sort.dir : null;
            return (
              <div
                key={c.key}
                role="columnheader"
                className="th"
                style={{ width: widths[c.key] }}
                aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
              >
                <button
                  type="button"
                  className="th-btn"
                  title={`Sort by ${c.label}${c.derived ? ' (derived)' : ''}`}
                  onClick={() => toggleSort(c.key)}
                >
                  <span className="th-label">{c.label}</span>
                  <span className="sort-ind" aria-hidden="true">
                    {sorted === 'asc' ? '▲' : sorted === 'desc' ? '▼' : ''}
                  </span>
                </button>
                <span
                  className="col-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${c.label}`}
                  onPointerDown={(e) => startResize(e, c.key)}
                  onDoubleClick={() => setColumnWidth(c.key, 120)}
                />
              </div>
            );
          })}
        </div>
      </div>
      <div className="tbody" role="rowgroup" style={{ height: virtualizer.getTotalSize(), width: totalWidth }}>
        {items.map((vi) => {
          const idx = indices[vi.index]!;
          const row = rows[idx]!;
          const dur = durationKey ? row.values[durationKey] : null;
          return (
            <Row
              key={row.id}
              row={row}
              columns={columns}
              widths={widths}
              highlight={highlight}
              zone={zone}
              selected={row.id === selectedId}
              active={vi.index === cursor}
              slow={typeof dur === 'number' && dur > slowMs}
              top={vi.start}
              height={rowHeight}
              ariaIndex={vi.index + 2}
              onClick={onRowClick}
              viewIndex={vi.index}
            />
          );
        })}
      </div>
      {indices.length === 0 && <div className="table-empty">No rows match the current filters.</div>}
    </div>
  );
}
