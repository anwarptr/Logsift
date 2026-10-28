import { useEffect, useRef, useState } from 'react';
import { compileSearch } from '../filters/applyFilters';
import { useLogStore } from '../store/logStore';

const DEBOUNCE_MS = 200;

export function SearchBox() {
  const search = useLogStore((s) => s.filters.search);
  const regex = useLogStore((s) => s.filters.regex);
  const setFilters = useLogStore((s) => s.setFilters);
  const [text, setText] = useState(search);
  const timer = useRef<number | undefined>(undefined);

  // Sync when the filter changes elsewhere (chip removed, URL changed, clear all).
  useEffect(() => {
    setText(search);
  }, [search]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function onChange(v: string) {
    setText(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFilters({ search: v }), DEBOUNCE_MS);
  }

  const error = regex ? compileSearch(text, true).error : null;

  return (
    <div className="search-box">
      <label htmlFor="global-search" className="visually-hidden">
        Search all fields
      </label>
      <input
        id="global-search"
        type="search"
        placeholder="Search…  ( / )"
        value={text}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'search-error' : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            window.clearTimeout(timer.current);
            setFilters({ search: text });
          } else if (e.key === 'Escape' && text) {
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      <button
        type="button"
        className="btn small regex-toggle"
        aria-pressed={regex}
        title="Treat search as a regular expression"
        onClick={() => setFilters({ regex: !regex })}
      >
        .*
      </button>
      {error && (
        <span id="search-error" className="search-error" role="alert">
          Invalid regex: {error}
        </span>
      )}
    </div>
  );
}
