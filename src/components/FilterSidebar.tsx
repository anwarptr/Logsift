import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FilterEval } from '../filters/applyFilters';
import { facetCounts, statusClassCounts, topUris } from '../filters/facets';
import type { FacetColumn, LogIndex, RangeColumn } from '../filters/logIndex';
import { STATUS_CLASSES, type Range, type StatusClass, type UriMode } from '../filters/types';
import { useLogStore } from '../store/logStore';
import { useDisplayZone, useFilterEval, useLogIndex } from '../store/useView';
import { formatNumber, formatTimestamp } from '../utils/format';
import { displayZoneLabel, fromZonedInput, toZonedInput } from '../utils/timezone';

const FACET_PREVIEW = 8;

function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="filter-section" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="filter-section-body">{children}</div>
    </details>
  );
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange(v: boolean): void; hint?: string }) {
  return (
    <label className="toggle" title={hint}>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function QuickToggles({ index }: { index: LogIndex }) {
  const f = useLogStore((s) => s.filters);
  const setFilters = useLogStore((s) => s.setFilters);
  const slowMs = useLogStore((s) => s.slowThresholdMs);
  const canErrors = index.hasStatus || index.hasLevel;
  if (!index.hasHealthCheck && !index.hasScm && !canErrors && !index.duration) return null;
  return (
    <Section title="Quick filters">
      <div className="toggles">
        {index.hasHealthCheck && (
          <Toggle
            label="Hide health checks"
            hint="Hide AlwaysOn and 127.0.0.1 requests"
            checked={f.hideHealthChecks}
            onChange={(v) => setFilters({ hideHealthChecks: v })}
          />
        )}
        {index.hasScm && (
          <Toggle
            label="Hide SCM/Kudu"
            hint="Hide requests to the ~1 (SCM) site"
            checked={f.hideScm}
            onChange={(v) => setFilters({ hideScm: v })}
          />
        )}
        {canErrors && (
          <Toggle
            label={index.hasStatus ? 'Only errors (≥ 400)' : 'Only errors (ERROR/FATAL)'}
            checked={f.onlyErrors}
            onChange={(v) => setFilters({ onlyErrors: v })}
          />
        )}
        {index.duration && (
          <Toggle
            label={`Only slow (> ${formatNumber(slowMs)} ms)`}
            checked={f.onlySlow}
            onChange={(v) => setFilters({ onlySlow: v })}
          />
        )}
      </div>
    </Section>
  );
}

function TimeRange({ index }: { index: LogIndex }) {
  const from = useLogStore((s) => s.filters.timeFrom);
  const to = useLogStore((s) => s.filters.timeTo);
  const setFilters = useLogStore((s) => s.setFilters);
  const zone = useDisplayZone();
  if (index.minTs === null || index.maxTs === null) return null;
  const min = index.minTs;
  const max = index.maxTs;
  const preset = (a: number | null, b: number | null) => setFilters({ timeFrom: a, timeTo: b });
  const FIVE_MIN = 5 * 60_000;
  const toInput = (ms: number) => toZonedInput(ms, zone);
  const fromInput = (v: string) => fromZonedInput(v, zone);
  return (
    <Section title={`Time range (${displayZoneLabel(zone, min)})`}>
      <div className="time-range">
        <label>
          <span>From</span>
          <input
            type="datetime-local"
            step={1}
            min={toInput(min)}
            max={toInput(max)}
            value={from === null ? '' : toInput(from)}
            onChange={(e) => setFilters({ timeFrom: fromInput(e.target.value) })}
          />
        </label>
        <label>
          <span>To</span>
          <input
            type="datetime-local"
            step={1}
            min={toInput(min)}
            max={toInput(max)}
            value={to === null ? '' : toInput(to)}
            onChange={(e) => {
              const t = fromInput(e.target.value);
              // Make the "to" bound inclusive of the whole selected second.
              setFilters({ timeTo: t === null ? null : t + 999 });
            }}
          />
        </label>
      </div>
      <div className="preset-row">
        <button type="button" className="btn small" onClick={() => preset(min, min + FIVE_MIN)}>
          First 5 min
        </button>
        <button type="button" className="btn small" onClick={() => preset(max - FIVE_MIN, max)}>
          Last 5 min
        </button>
        <button type="button" className="btn small" onClick={() => preset(max - 3_600_000, max)}>
          Last 1 h
        </button>
        <button type="button" className="btn small" onClick={() => preset(null, null)}>
          All
        </button>
      </div>
      <p className="muted small-text">
        File spans {formatTimestamp(min, zone)} – {formatTimestamp(max, zone)}
      </p>
    </Section>
  );
}

function StatusChips({ index, ev }: { index: LogIndex; ev: FilterEval }) {
  const selected = useLogStore((s) => s.filters.statusClasses);
  const setFilters = useLogStore((s) => s.setFilters);
  const counts = useMemo(() => statusClassCounts(index, ev), [index, ev]);
  const toggle = (c: StatusClass) =>
    setFilters({ statusClasses: selected.includes(c) ? selected.filter((x) => x !== c) : [...selected, c] });
  return (
    <div className="status-chips" role="group" aria-label="Status classes">
      {STATUS_CLASSES.map((c) => (
        <button
          key={c}
          type="button"
          className={`chip-toggle s${c}`}
          aria-pressed={selected.includes(c)}
          onClick={() => toggle(c)}
        >
          {c} <span className="count">{formatNumber(counts[c])}</span>
        </button>
      ))}
    </div>
  );
}

function FacetList({ col, ev }: { col: FacetColumn; ev: FilterEval }) {
  const selected = useLogStore((s) => s.filters.facets[col.key]);
  const setFilters = useLogStore((s) => s.setFilters);
  const facets = useLogStore((s) => s.filters.facets);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const all = useMemo(() => facetCounts(col, ev), [col, ev]);
  const selectedSet = useMemo(() => new Set(selected ?? []), [selected]);

  const q = query.trim().toLowerCase();
  const filtered = q ? all.filter((e) => e.label.toLowerCase().includes(q)) : all;
  const shown = expanded || q ? filtered : filtered.slice(0, FACET_PREVIEW);
  const max = all.reduce((m, e) => Math.max(m, e.count), 0) || 1;

  function toggle(key: string, on: boolean) {
    const next = on ? [...selectedSet, key] : [...selectedSet].filter((k) => k !== key);
    const copy = { ...facets };
    if (next.length) copy[col.key] = next;
    else delete copy[col.key];
    setFilters({ facets: copy });
  }

  const searchId = `facet-search-${col.key}`;
  return (
    <div className="facet">
      {all.length > FACET_PREVIEW && (
        <>
          <label htmlFor={searchId} className="visually-hidden">
            Search {col.label} values
          </label>
          <input
            id={searchId}
            type="search"
            className="facet-search"
            placeholder={`Filter ${all.length} values…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </>
      )}
      <ul className="facet-list" aria-label={`${col.label} values`}>
        {shown.map((e) => (
          <li key={e.key} className={e.count === 0 && !selectedSet.has(e.key) ? 'zero' : undefined}>
            <label>
              <input type="checkbox" checked={selectedSet.has(e.key)} onChange={(x) => toggle(e.key, x.target.checked)} />
              <span className="facet-label" title={e.label}>
                {e.label}
              </span>
              <span className="facet-count">{formatNumber(e.count)}</span>
              <span className="facet-bar" style={{ width: `${(e.count / max) * 100}%` }} aria-hidden="true" />
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="muted small-text">No matching values</li>}
      </ul>
      {!q && filtered.length > FACET_PREVIEW && (
        <button type="button" className="btn small ghost" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer' : `Show all ${filtered.length}`}
        </button>
      )}
    </div>
  );
}

function niceStep(span: number): number {
  if (span <= 0) return 1;
  const raw = span / 200;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  return Math.max(1, Math.round(raw / pow) * pow);
}

function RangeFilter({ col }: { col: RangeColumn }) {
  const value = useLogStore((s) => s.filters.ranges[col.key]);
  const ranges = useLogStore((s) => s.filters.ranges);
  const setFilters = useLogStore((s) => s.setFilters);
  const [lo, setLo] = useState<number>(value?.[0] ?? col.min);
  const [hi, setHi] = useState<number>(value?.[1] ?? col.max);
  const timer = useRef<number | undefined>(undefined);
  const step = niceStep(col.max - col.min);

  useEffect(() => {
    setLo(value?.[0] ?? col.min);
    setHi(value?.[1] ?? col.max);
  }, [value, col.min, col.max]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function commit(a: number, b: number) {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r: Range = [a <= col.min ? null : a, b >= col.max ? null : b];
      const copy = { ...ranges };
      if (r[0] === null && r[1] === null) delete copy[col.key];
      else copy[col.key] = r;
      setFilters({ ranges: copy });
    }, 150);
  }

  function update(a: number, b: number) {
    if (Number.isNaN(a) || Number.isNaN(b)) return;
    const na = Math.min(a, b);
    const nb = Math.max(a, b);
    setLo(na);
    setHi(nb);
    commit(na, nb);
  }

  const span = col.max - col.min || 1;
  const left = ((lo - col.min) / span) * 100;
  const right = ((hi - col.min) / span) * 100;

  return (
    <div className="range-filter">
      <div className="range-head">
        <span>{col.label}</span>
        <span className="muted small-text">
          {formatNumber(col.min)} – {formatNumber(col.max)}
        </span>
      </div>
      <div className="dual-range">
        <div className="dual-range-track" aria-hidden="true">
          <div className="dual-range-fill" style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }} />
        </div>
        <input
          type="range"
          min={col.min}
          max={col.max}
          step={step}
          value={lo}
          aria-label={`${col.label} minimum`}
          onChange={(e) => update(Math.min(e.target.valueAsNumber, hi), hi)}
        />
        <input
          type="range"
          min={col.min}
          max={col.max}
          step={step}
          value={hi}
          aria-label={`${col.label} maximum`}
          onChange={(e) => update(lo, Math.max(e.target.valueAsNumber, lo))}
        />
      </div>
      <div className="range-inputs">
        <input
          type="number"
          aria-label={`${col.label} minimum value`}
          value={lo}
          min={col.min}
          max={col.max}
          onChange={(e) => update(e.target.valueAsNumber, hi)}
        />
        <span aria-hidden="true">–</span>
        <input
          type="number"
          aria-label={`${col.label} maximum value`}
          value={hi}
          min={col.min}
          max={col.max}
          onChange={(e) => update(lo, e.target.valueAsNumber)}
        />
      </div>
    </div>
  );
}

function UriFilter({ index, ev }: { index: LogIndex; ev: FilterEval }) {
  const uri = useLogStore((s) => s.filters.uri);
  const mode = useLogStore((s) => s.filters.uriMode);
  const setFilters = useLogStore((s) => s.setFilters);
  const [text, setText] = useState(uri);
  const timer = useRef<number | undefined>(undefined);
  const top = useMemo(() => topUris(index, ev, 10), [index, ev]);
  const max = top[0]?.count ?? 1;

  useEffect(() => setText(uri), [uri]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <Section title={`URI (${index.uriKey})`}>
      <div className="uri-filter">
        <label className="visually-hidden" htmlFor="uri-mode">
          URI match mode
        </label>
        <select id="uri-mode" value={mode} onChange={(e) => setFilters({ uriMode: e.target.value as UriMode })}>
          <option value="contains">contains</option>
          <option value="startsWith">starts with</option>
          <option value="equals">equals</option>
        </select>
        <label className="visually-hidden" htmlFor="uri-text">
          URI
        </label>
        <input
          id="uri-text"
          type="search"
          placeholder="/api/…"
          value={text}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setFilters({ uri: v }), 200);
          }}
        />
      </div>
      {top.length > 0 && (
        <>
          <div className="muted small-text sub-head">Top paths</div>
          <ul className="facet-list top-paths">
            {top.map((e) => (
              <li key={e.key}>
                <button
                  type="button"
                  className="link-row"
                  title={`Filter to ${e.label}`}
                  onClick={() => setFilters({ uri: e.key, uriMode: 'equals' })}
                >
                  <span className="facet-label">{e.label}</span>
                  <span className="facet-count">{formatNumber(e.count)}</span>
                  <span className="facet-bar" style={{ width: `${(e.count / max) * 100}%` }} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

export function FilterSidebar() {
  const index = useLogIndex();
  const ev = useFilterEval();
  const schema = useLogStore((s) => s.schema);

  if (!index || !ev) {
    return (
      <aside className="sidebar" aria-label="Filters">
        <p className="muted small-text sidebar-loading">Filters are available once parsing finishes.</p>
      </aside>
    );
  }

  const statusKey = schema.find((c) => c.role === 'status')?.key;
  const statusFacet = index.facets.find((f) => f.key === statusKey);
  const otherFacets = index.facets.filter((f) => f.key !== statusKey);

  return (
    <aside className="sidebar" aria-label="Filters">
      <QuickToggles index={index} />
      <TimeRange index={index} />
      {index.status && (
        <Section title={statusKey ?? 'Status'}>
          <StatusChips index={index} ev={ev} />
          {statusFacet && <FacetList col={statusFacet} ev={ev} />}
        </Section>
      )}
      {otherFacets.map((f) => (
        <Section key={f.key} title={f.label}>
          <FacetList col={f} ev={ev} />
        </Section>
      ))}
      {index.ranges.length > 0 && (
        <Section title="Numeric ranges">
          {index.ranges.map((r) => (
            <RangeFilter key={r.key} col={r} />
          ))}
        </Section>
      )}
      {index.uri && <UriFilter index={index} ev={ev} />}
    </aside>
  );
}
