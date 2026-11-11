import { useEffect, useRef, useState, type MouseEvent } from 'react';

export interface SavedSearch {
  id: string;
  name: string;
  query: string;
}

const STORAGE_KEY = 'logsift:saved_searches';

const DEFAULT_PRESETS = [
  { label: 'Errors (4xx & 5xx)', query: 'status:>=400', icon: '🚨' },
  { label: 'Server Errors (5xx)', query: 'status:5xx', icon: '💥' },
  { label: 'Slow Requests (>1s)', query: 'duration:>1s', icon: '⏳' },
  { label: 'Error / Fatal logs', query: 'level:error', icon: '❌' },
  { label: 'Auth (401 & 403)', query: 'status:401 status:403', icon: '🛡️' },
  { label: 'Exclude Healthchecks', query: '!health !ping !probe', icon: '🏥' },
];

function loadSaved(): SavedSearch[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function persistSaved(items: SavedSearch[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // quota exceeded or storage disabled
  }
}

export function SearchPresets({
  currentQuery,
  onSelect,
}: {
  currentQuery: string;
  onSelect(query: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<SavedSearch[]>(loadSaved);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const saveCurrent = () => {
    const q = currentQuery.trim();
    if (!q) return;
    const item: SavedSearch = {
      id: String(Date.now()),
      name: q.length > 25 ? `${q.slice(0, 25)}…` : q,
      query: q,
    };
    const next = [item, ...saved.filter((s) => s.query !== q)].slice(0, 15);
    setSaved(next);
    persistSaved(next);
  };

  const removeSaved = (id: string, e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const next = saved.filter((s) => s.id !== id);
    setSaved(next);
    persistSaved(next);
  };

  return (
    <div className="search-presets-wrap" ref={popoverRef}>
      <button
        type="button"
        className="btn small presets-btn"
        aria-expanded={open}
        aria-haspopup="true"
        title="Saved searches and quick query presets"
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">🔖</span> Presets
      </button>

      {open && (
        <div className="search-presets-popover popover" role="menu" aria-label="Query presets and saved searches">
          <div className="presets-section-title">Quick presets</div>
          <div className="presets-list">
            {DEFAULT_PRESETS.map((p) => (
              <button
                key={p.query}
                type="button"
                className="presets-item"
                role="menuitem"
                onClick={() => {
                  onSelect(p.query);
                  setOpen(false);
                }}
              >
                <span className="preset-icon">{p.icon}</span>
                <span className="preset-label">{p.label}</span>
                <code className="preset-query mono">{p.query}</code>
              </button>
            ))}
          </div>

          <div className="presets-divider" />

          <div className="presets-head-row">
            <span className="presets-section-title">Saved searches</span>
            {currentQuery.trim() && (
              <button type="button" className="btn small ghost save-query-btn" onClick={saveCurrent}>
                + Save current
              </button>
            )}
          </div>

          {saved.length === 0 ? (
            <div className="presets-empty muted small-text">No saved searches yet. Click "+ Save current" to save one.</div>
          ) : (
            <div className="presets-list saved-list">
              {saved.map((s) => (
                <div
                  key={s.id}
                  className="presets-item saved-item"
                  role="menuitem"
                  tabIndex={0}
                  onClick={() => {
                    onSelect(s.query);
                    setOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      onSelect(s.query);
                      setOpen(false);
                    }
                  }}
                >
                  <span className="preset-label" title={s.query}>
                    {s.name}
                  </span>
                  <code className="preset-query mono" title={s.query}>
                    {s.query}
                  </code>
                  <button
                    type="button"
                    className="preset-del-btn"
                    title="Delete saved search"
                    onClick={(e) => removeSaved(s.id, e)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
