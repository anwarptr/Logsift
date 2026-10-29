import { useMemo, useState } from 'react';
import { ERROR_BASIS_LABELS, errorBasisOf } from '../filters/logIndex';
import { facetLabel } from '../filters/types';
import { useLogStore } from '../store/logStore';
import { useEndpoints, useLogIndex } from '../store/useView';
import type { EndpointStat } from '../utils/endpoints';
import { formatNumber } from '../utils/format';

type SortKey = 'pattern' | 'count' | 'errors' | 'errorRate' | 'avgMs' | 'p50Ms' | 'p95Ms' | 'maxMs';

const MAX_SHOWN = 1000;

const errorRate = (e: EndpointStat) => (e.count ? e.errors / e.count : 0);
const value = (e: EndpointStat, k: SortKey): number | string => (k === 'errorRate' ? errorRate(e) : e[k]);
const ms = (v: number) => (Number.isNaN(v) ? '–' : formatNumber(Math.round(v)));

/** Requests grouped by URI pattern (/api/products/{id}), over the current filters. Click one to filter to it. */
export function EndpointsTable() {
  const stats = useEndpoints();
  const selected = useLogStore((s) => s.filters.endpoint);
  const setFilters = useLogStore((s) => s.setFilters);
  const setTab = useLogStore((s) => s.setTab);
  const hasDuration = useLogStore((s) => s.schema.some((c) => c.role === 'duration'));
  const index = useLogIndex();
  const basis = index ? errorBasisOf(index) : null;
  const errorBasis = basis ? (basis === 'level' ? '' : 'status ') + ERROR_BASIS_LABELS[basis] : null;
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'count', dir: -1 });
  const [query, setQuery] = useState('');

  const sorted = useMemo(() => {
    if (!stats) return [];
    const q = query.trim().toLowerCase();
    const list = q ? stats.filter((e) => e.pattern.includes(q)) : [...stats];
    const { key, dir } = sort;
    return list.sort((a, b) => {
      const va = value(a, key);
      const vb = value(b, key);
      // NaN (no durations) always sorts last.
      if (typeof va === 'number' && typeof vb === 'number') {
        if (Number.isNaN(va) || Number.isNaN(vb)) return Number.isNaN(va) ? (Number.isNaN(vb) ? 0 : 1) : -1;
        return (va - vb) * dir || b.count - a.count;
      }
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [stats, sort, query]);

  if (!stats) return <div className="table-empty">Endpoints are available once parsing finishes.</div>;

  const columns: { key: SortKey; label: string; title?: string; show: boolean }[] = [
    { key: 'pattern', label: 'Endpoint', show: true },
    { key: 'count', label: 'Requests', show: true },
    { key: 'errors', label: 'Errors', title: errorBasis ?? undefined, show: !!errorBasis },
    { key: 'errorRate', label: 'Error %', show: !!errorBasis },
    { key: 'avgMs', label: 'Avg ms', show: hasDuration },
    { key: 'p50Ms', label: 'p50 ms', show: hasDuration },
    { key: 'p95Ms', label: 'p95 ms', show: hasDuration },
    { key: 'maxMs', label: 'Max ms', show: hasDuration },
  ];
  const shown = columns.filter((c) => c.show);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'pattern' ? 1 : -1 }));

  const pick = (pattern: string) => {
    setFilters({ endpoint: pattern });
    setTab('rows');
  };

  return (
    <div className="endpoints">
      <div className="endpoints-head">
        <label htmlFor="endpoint-search" className="visually-hidden">
          Filter endpoints
        </label>
        <input
          id="endpoint-search"
          type="search"
          className="facet-search"
          placeholder={`Filter ${formatNumber(stats.length)} endpoints…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted small-text">
          URIs grouped by pattern: numbers → {'{id}'}, GUIDs → {'{guid}'}, dates → {'{date}'}, long hex/tokens →{' '}
          {'{hash}'}/{'{token}'}. Click an endpoint to filter the rows to it.
        </span>
      </div>
      <div className="endpoints-scroll">
        <table className="endpoints-table" aria-label="Endpoints">
          <thead>
            <tr>
              {shown.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={c.key === 'pattern' ? undefined : 'num'}
                  aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                >
                  <button type="button" className="th-button" title={c.title} onClick={() => toggleSort(c.key)}>
                    {c.label}
                    {sort.key === c.key && <span aria-hidden="true">{sort.dir === 1 ? ' ▲' : ' ▼'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, MAX_SHOWN).map((e) => {
              const rate = errorRate(e);
              return (
                <tr key={e.pattern} className={e.pattern === selected ? 'selected' : undefined}>
                  <td className="endpoint-cell">
                    <button type="button" className="link-button mono" title="Show these rows" onClick={() => pick(e.pattern)}>
                      {facetLabel(e.pattern)}
                    </button>
                    {e.methods.length > 0 && <span className="endpoint-methods">{e.methods.slice(0, 3).join(' ')}</span>}
                  </td>
                  <td className="num">{formatNumber(e.count)}</td>
                  {errorBasis && <td className={'num' + (e.errors ? ' err-text' : '')}>{formatNumber(e.errors)}</td>}
                  {errorBasis && (
                    <td className={'num' + (rate >= 0.05 ? ' err-text' : '')}>
                      {(rate * 100).toFixed(rate > 0 && rate < 0.1 ? 1 : 0)}%
                    </td>
                  )}
                  {hasDuration && (
                    <>
                      <td className="num">{ms(e.avgMs)}</td>
                      <td className="num">{ms(e.p50Ms)}</td>
                      <td className="num">{ms(e.p95Ms)}</td>
                      <td className="num">{ms(e.maxMs)}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {sorted.length === 0 && <div className="table-empty">No endpoints match.</div>}
        {sorted.length > MAX_SHOWN && (
          <p className="muted small-text endpoints-more">
            Showing the first {formatNumber(MAX_SHOWN)} of {formatNumber(sorted.length)}; filter to narrow down.
          </p>
        )}
      </div>
    </div>
  );
}
