import { EMPTY_FILTERS, facetLabel, type FilterState } from '../filters/types';
import { useLogStore } from '../store/logStore';
import { useDisplayZone, useMatchedIndices } from '../store/useView';
import { formatNumber, formatTimestamp } from '../utils/format';
import { UTC_ZONE, type DisplayZone } from '../utils/timezone';

interface Chip {
  id: string;
  label: string;
  remove: Partial<FilterState>;
}

function summarize(values: string[], max = 3): string {
  const labels = values.map(facetLabel);
  return labels.length <= max ? labels.join(', ') : `${labels.slice(0, max).join(', ')} +${labels.length - max}`;
}

export function buildChips(f: FilterState, slowMs: number, zone: DisplayZone = UTC_ZONE): Chip[] {
  const chips: Chip[] = [];
  if (f.search) chips.push({ id: 'search', label: `${f.regex ? 'Regex' : 'Search'}: ${f.search}`, remove: { search: '' } });
  if (f.timeFrom !== null || f.timeTo !== null) {
    const a = f.timeFrom !== null ? formatTimestamp(f.timeFrom, zone) : '…';
    const b = f.timeTo !== null ? formatTimestamp(f.timeTo, zone) : '…';
    chips.push({ id: 'time', label: `Time: ${a} → ${b}`, remove: { timeFrom: null, timeTo: null } });
  }
  if (f.statusClasses.length) {
    chips.push({ id: 'status', label: `Status: ${f.statusClasses.join(', ')}`, remove: { statusClasses: [] } });
  }
  for (const [key, values] of Object.entries(f.facets)) {
    if (!values.length) continue;
    const rest = { ...f.facets };
    delete rest[key];
    chips.push({ id: `facet:${key}`, label: `${key}: ${summarize(values)}`, remove: { facets: rest } });
  }
  for (const [key, [lo, hi]] of Object.entries(f.ranges)) {
    if (lo === null && hi === null) continue;
    const rest = { ...f.ranges };
    delete rest[key];
    const label =
      lo !== null && hi !== null
        ? `${formatNumber(lo)} – ${formatNumber(hi)}`
        : lo !== null
          ? `≥ ${formatNumber(lo)}`
          : `≤ ${formatNumber(hi!)}`;
    chips.push({ id: `range:${key}`, label: `${key}: ${label}`, remove: { ranges: rest } });
  }
  if (f.uri) {
    const mode = f.uriMode === 'startsWith' ? 'starts with' : f.uriMode;
    chips.push({ id: 'uri', label: `URI ${mode} ${f.uri}`, remove: { uri: '' } });
  }
  if (f.pattern) chips.push({ id: 'pattern', label: `Pattern: ${facetLabel(f.pattern)}`, remove: { pattern: '' } });
  if (f.endpoint) chips.push({ id: 'endpoint', label: `Endpoint: ${facetLabel(f.endpoint)}`, remove: { endpoint: '' } });
  if (f.hideHealthChecks) chips.push({ id: 'hh', label: 'No health checks', remove: { hideHealthChecks: false } });
  if (f.hideScm) chips.push({ id: 'hs', label: 'No SCM/Kudu', remove: { hideScm: false } });
  if (f.onlyErrors) chips.push({ id: 'oe', label: 'Only errors', remove: { onlyErrors: false } });
  if (f.onlySlow) chips.push({ id: 'os', label: `Only slow (> ${formatNumber(slowMs)} ms)`, remove: { onlySlow: false } });
  return chips;
}

export function FilterChips() {
  const filters = useLogStore((s) => s.filters);
  const setFilters = useLogStore((s) => s.setFilters);
  const clear = useLogStore((s) => s.clearFilters);
  const slowMs = useLogStore((s) => s.slowThresholdMs);
  const total = useLogStore((s) => s.rows.length);
  const matched = useMatchedIndices().length;
  const zone = useDisplayZone();
  const paused = useLogStore((s) => s.paused);
  const restore = useLogStore((s) => s.restoreFilters);
  const chips = buildChips(filters, slowMs, zone);

  return (
    <div className="filter-chips" aria-label="Active filters">
      <span className="row-count" role="status" aria-live="polite">
        <strong>{formatNumber(matched)}</strong> of {formatNumber(total)} rows
      </span>
      {chips.map((c) => (
        <span key={c.id} className="chip">
          <span className="chip-label" title={c.label}>
            {c.label}
          </span>
          <button type="button" className="chip-x" aria-label={`Remove filter ${c.label}`} onClick={() => setFilters(c.remove)}>
            ×
          </button>
        </span>
      ))}
      {paused && (
        <span className="paused-note">
          Filters paused to show line {formatNumber(paused.lineNo)} in the full log.{' '}
          <button type="button" className="btn small" onClick={restore}>
            Restore filters
          </button>
        </span>
      )}
      {chips.length > 0 && (
        <button type="button" className="btn small ghost" onClick={() => clear()} disabled={filters === EMPTY_FILTERS}>
          Clear all
        </button>
      )}
    </div>
  );
}
