import { useEffect } from 'react';
import { useLogStore } from '../store/logStore';

export function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/**
 * Global shortcuts: "/" focuses search, "[" shows/hides the filter panel, "F" toggles focus mode,
 * "Esc" closes the detail panel, then leaves the search box, then leaves focus mode.
 */
export function useShortcuts(): void {
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
