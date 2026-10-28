import { useEffect } from 'react';
import { useLogStore } from '../store/logStore';

export function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/** Global shortcuts: "/" focuses search, "Esc" clears the selection / closes the detail panel. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/' && !isEditable(document.activeElement)) {
        const input = document.getElementById('global-search') as HTMLInputElement | null;
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      } else if (e.key === 'Escape') {
        const { selectedId, select } = useLogStore.getState();
        if (selectedId !== null) {
          select(null);
          // Return focus to the table so keyboard navigation continues where it was.
          if (isEditable(document.activeElement) || document.activeElement?.closest('.detail-panel')) {
            (document.querySelector('.table-scroll') as HTMLElement | null)?.focus();
          }
        } else if (document.activeElement === document.getElementById('global-search')) {
          (document.activeElement as HTMLElement).blur();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
