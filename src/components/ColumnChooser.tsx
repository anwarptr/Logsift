import { useEffect, useRef, useState } from 'react';
import { useLogStore } from '../store/logStore';

/** Popover listing every column: toggle visibility, drag (or use ↑/↓ buttons) to reorder. */
export function ColumnChooser() {
  const schema = useLogStore((s) => s.schema);
  const order = useLogStore((s) => s.columnOrder);
  const hidden = useLogStore((s) => s.hiddenColumns);
  const setVisible = useLogStore((s) => s.setColumnVisible);
  const moveColumn = useLogStore((s) => s.moveColumn);
  const resetColumns = useLogStore((s) => s.resetColumns);
  const [open, setOpen] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const byKey = new Map(schema.map((c) => [c.key, c]));
  const visibleCount = order.filter((k) => !hidden[k]).length;

  return (
    <div className="popover-root" ref={rootRef}>
      <button type="button" className="btn small" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        Columns ({visibleCount}/{order.length})
      </button>
      {open && (
        <div className="popover column-chooser" role="dialog" aria-label="Choose columns">
          <div className="popover-head">
            <strong>Columns</strong>
            <button type="button" className="btn small ghost" onClick={resetColumns}>
              Reset
            </button>
          </div>
          <p className="muted small-text">Drag to reorder. Drag a header edge in the table to resize.</p>
          <ul className="col-list">
            {order.map((key, i) => {
              const col = byKey.get(key);
              if (!col) return null;
              return (
                <li
                  key={key}
                  draggable
                  className={`col-item${dragKey === key ? ' dragging' : ''}${overIndex === i && dragKey !== key ? ' drop-target' : ''}`}
                  onDragStart={(e) => {
                    setDragKey(key);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', key);
                  }}
                  onDragOver={(e) => {
                    if (!dragKey) return;
                    e.preventDefault();
                    setOverIndex(i);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragKey) moveColumn(dragKey, i);
                    setDragKey(null);
                    setOverIndex(null);
                  }}
                  onDragEnd={() => {
                    setDragKey(null);
                    setOverIndex(null);
                  }}
                >
                  <span className="drag-handle" aria-hidden="true">
                    ⋮⋮
                  </span>
                  <label>
                    <input type="checkbox" checked={!hidden[key]} onChange={(e) => setVisible(key, e.target.checked)} />
                    <span>{col.label}</span>
                    {col.derived && <span className="tag">derived</span>}
                  </label>
                  <span className="col-move">
                    <button
                      type="button"
                      className="btn small ghost"
                      aria-label={`Move ${col.label} up`}
                      disabled={i === 0}
                      onClick={() => moveColumn(key, i - 1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn small ghost"
                      aria-label={`Move ${col.label} down`}
                      disabled={i === order.length - 1}
                      onClick={() => moveColumn(key, i + 1)}
                    >
                      ↓
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
