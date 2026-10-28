import { useEffect } from 'react';
import { useLogStore } from '../store/logStore';
import type { ThemePref } from '../store/prefs';

const NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<ThemePref, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };
const ICON: Record<ThemePref, string> = { system: '◐', light: '☀', dark: '☾' };

/** Cycles system → light → dark. "System" follows prefers-color-scheme via CSS. */
export function ThemeToggle() {
  const theme = useLogStore((s) => s.theme);
  const setTheme = useLogStore((s) => s.setTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);

  return (
    <button
      type="button"
      className="btn small"
      title={`${LABEL[theme]} (click to change)`}
      aria-label={`${LABEL[theme]}. Switch to ${NEXT[theme]}`}
      onClick={() => setTheme(NEXT[theme])}
    >
      <span aria-hidden="true">{ICON[theme]}</span> {theme[0]!.toUpperCase() + theme.slice(1)}
    </button>
  );
}
