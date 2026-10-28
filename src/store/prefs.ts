export type Density = 'compact' | 'comfortable';
export type ThemePref = 'system' | 'light' | 'dark';
/** Show timestamps in the log's own zone or the browser's local zone. */
export type TimeDisplay = 'log' | 'local';

export interface Prefs {
  density: Density;
  theme: ThemePref;
  slowThresholdMs: number;
  insightsOpen: boolean;
  timeDisplay: TimeDisplay;
}

const KEY = 'log-viewer:prefs';
const DEFAULTS: Prefs = { density: 'compact', theme: 'system', slowThresholdMs: 1000, insightsOpen: true, timeDisplay: 'log' };

/** Per-browser UI preferences. Storage may be unavailable (private mode), so every access is guarded. */
export function loadPrefs(): Prefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      density: p.density === 'comfortable' ? 'comfortable' : 'compact',
      theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'system',
      slowThresholdMs:
        typeof p.slowThresholdMs === 'number' && p.slowThresholdMs >= 0 ? p.slowThresholdMs : DEFAULTS.slowThresholdMs,
      insightsOpen: p.insightsOpen !== false,
      timeDisplay: p.timeDisplay === 'local' ? 'local' : 'log',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(patch: Partial<Prefs>): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    // ignore
  }
}
