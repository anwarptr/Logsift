import { useMemo, useState } from 'react';
import { facetLabel } from '../filters/types';
import { useLogStore } from '../store/logStore';
import { useDisplayZone, useLogIndex, usePatterns } from '../store/useView';
import { formatNumber, formatTimestamp } from '../utils/format';
import type { PatternStat } from '../utils/messagePatterns';
import { levelClass } from './cells';

type SortKey = 'pattern' | 'count' | 'errors' | 'level' | 'firstTs' | 'lastTs';

const MAX_SHOWN = 1000;

/** Messages grouped by pattern ("Order {n} took {n} ms"), over the current filters. Click one to filter to it. */
export function PatternsTable() {
  const stats = usePatterns();
  const selected = useLogStore((s) => s.filters.pattern);
  const setFilters = useLogStore((s) => s.setFilters);
  const setTab = useLogStore((s) => s.setTab);
  const hasLevel = useLogStore((s) => s.schema.some((c) => c.role === 'level'));
  const index = useLogIndex();
  const zone = useDisplayZone();
  const hasErrors = !!index && (index.hasStatus || index.hasLevel);
  const hasTime = index?.minTs !== null && index?.minTs !== undefined;
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'count', dir: -1 });
  const [query, setQuery] = useState('');

  const sorted = useMemo(() => {
    if (!stats) return [];
    const q = query.trim().toLowerCase();
    const list = q ? stats.filter((p) => p.pattern.toLowerCase().includes(q)) : [...stats];
    const { key, dir } = sort;
    // Missing times sort as oldest, missing levels as empty text.
    const val = (p: PatternStat): number | string =>
      key === 'pattern' ? p.pattern : key === 'level' ? (p.level ?? '') : (p[key] ?? -Infinity);
    return list.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir || b.count - a.count;
      return String(va).localeCompare(String(vb)) * dir || b.count - a.count;
    });
  }, [stats, sort, query]);

  if (!stats) return <div className="table-empty">Patterns are available once parsing finishes.</div>;

  const columns: { key: SortKey; label: string; show: boolean }[] = [
    { key: 'pattern', label: 'Message pattern', show: true },
    { key: 'count', label: 'Rows', show: true },
    { key: 'errors', label: 'Errors', show: hasErrors },
    { key: 'level', label: 'Level', show: hasLevel },
    { key: 'firstTs', label: 'First seen', show: hasTime },
    { key: 'lastTs', label: 'Last seen', show: hasTime },
  ];
  const shown = columns.filter((c) => c.show);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'pattern' || key === 'level' ? 1 : -1 }));

  const pick = (pattern: string) => {
    setFilters({ pattern });
    setTab('rows');
  };

  return (
    <div className="endpoints">
      <div className="endpoints-head">
        <label htmlFor="pattern-search" className="visually-hidden">
          Filter patterns
        </label>
        <input
          id="pattern-search"
          type="search"
          className="facet-search"
          placeholder={`Filter ${formatNumber(stats.length)} patterns…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted small-text">
          Messages that differ only in numbers, IDs, times or quoted values are grouped. Click one to see its rows.
        </span>
      </div>
      <div className="endpoints-scroll">
        <table className="endpoints-table" aria-label="Message patterns">
          <thead>
            <tr>
              {shown.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={c.key === 'pattern' || c.key === 'level' ? undefined : 'num'}
                  aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                >
                  <button type="button" className="th-button" onClick={() => toggleSort(c.key)}>
                    {c.label}
                    {sort.key === c.key && <span aria-hidden="true">{sort.dir === 1 ? ' ▲' : ' ▼'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, MAX_SHOWN).map((p) => (
              <tr key={p.pattern} className={p.pattern === selected ? 'selected' : undefined}>
                <td className="endpoint-cell">
                  <button type="button" className="link-button mono" title={`Show these rows: ${facetLabel(p.pattern)}`} onClick={() => pick(p.pattern)}>
                    {facetLabel(p.pattern)}
                  </button>
                </td>
                <td className="num">{formatNumber(p.count)}</td>
                {hasErrors && <td className={'num' + (p.errors ? ' err-text' : '')}>{formatNumber(p.errors)}</td>}
                {hasLevel && <td>{p.level && <span className={`pill ${levelClass(p.level)}`}>{p.level}</span>}</td>}
                {hasTime && <td className="num mono">{p.firstTs === null ? '–' : formatTimestamp(p.firstTs, zone)}</td>}
                {hasTime && <td className="num mono">{p.lastTs === null ? '–' : formatTimestamp(p.lastTs, zone)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && <div className="table-empty">No patterns match.</div>}
        {sorted.length > MAX_SHOWN && (
          <p className="muted small-text endpoints-more">
            Showing the first {formatNumber(MAX_SHOWN)} of {formatNumber(sorted.length)}; filter to narrow down.
          </p>
        )}
      </div>
    </div>
  );
}
