import { useEffect, useRef } from 'react';
import { isErrorRow, type LogIndex } from '../filters/logIndex';
import { useLogStore } from '../store/logStore';

export function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/**
 * The next (dir 1) or previous (dir -1) error row after the selected one, in display order,
 * wrapping around; from the top (or bottom) when nothing is selected. null when there are no errors.
 */
export function nextErrorRow(indices: Uint32Array, index: LogIndex, selectedId: number | null, dir: 1 | -1): number | null {
  const n = indices.length;
  if (n === 0) return null;
  const pos = selectedId === null ? -1 : indices.indexOf(selectedId);
  const start = pos < 0 ? (dir === 1 ? -1 : n) : pos;
  for (let k = 1; k <= n; k++) {
    const id = indices[(((start + dir * k) % n) + n) % n]!;
    if (isErrorRow(index, id)) return id;
  }
  return null;
}

/**
 * Global shortcuts: "/" focuses search, "[" shows/hides the filter panel, "F" toggles focus mode,
 * "Esc" closes the detail panel, then leaves the search box, then leaves focus mode,
 * "n" / "Shift+N" select the next / previous error row of the current view (`indices`, display order).
 */
export function useShortcuts(indices: Uint32Array, index: LogIndex | null): void {
  const view = useRef({ indices, index });
  view.current = { indices, index };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const typing = isEditable(document.activeElement);
      const state = useLogStore.getState();
      const hasData = state.rows.length + state.malformed.length > 0;
      if (e.key === '[' && !typing && hasData) {
        e.preventDefault();
        if (state.focusMode) state.setFocusMode(false);
        state.setSidebarOpen(state.focusMode || !state.sidebarOpen);
      } else if ((e.key === 'f' || e.key === 'F') && !typing && hasData) {
        e.preventDefault();
        state.setFocusMode(!state.focusMode);
      } else if ((e.key === 'n' || e.key === 'N') && !typing && view.current.index && state.tab === 'rows') {
        const id = nextErrorRow(view.current.indices, view.current.index, state.selectedId, e.shiftKey ? -1 : 1);
        if (id !== null) {
          e.preventDefault();
          state.select(id);
        }
      } else if (e.key === '/' && !typing) {
        const input = document.getElementById('global-search') as HTMLInputElement | null;
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      } else if (e.key === 'Escape') {
        const { selectedId, select } = state;
        if (selectedId !== null) {
          select(null);
          // Return focus to the table so keyboard navigation continues where it was.
          if (isEditable(document.activeElement) || document.activeElement?.closest('.detail-panel')) {
            (document.querySelector('.table-scroll') as HTMLElement | null)?.focus();
          }
        } else if (document.activeElement === document.getElementById('global-search')) {
          (document.activeElement as HTMLElement).blur();
        } else if (state.focusMode && !typing && !document.activeElement?.closest('.popover')) {
          state.setFocusMode(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
