import type { FacetEntry } from '../filters/facets';
import { useLogStore } from '../store/logStore';
import { useDisplayZone, useInsights } from '../store/useView';
import { formatBytes, formatNumber, formatTimestamp } from '../utils/format';
import { levelClass, statusClass } from './cells';
import { Histogram } from './Histogram';

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      {sub && <div className="card-sub muted">{sub}</div>}
    </div>
  );
}

function BarList({
  title,
  entries,
  onPick,
  pillClass,
  mono = true,
}: {
  title: string;
  entries: FacetEntry[];
  onPick?(key: string): void;
  pillClass?(key: string): string;
  mono?: boolean;
}) {
  const max = entries[0]?.count ?? 1;
  return (
    <div className="bar-list">
      <div className="chart-title">{title}</div>
      {entries.length === 0 ? (
        <p className="muted small-text">No data</p>
      ) : (
        <ul>
          {entries.map((e) => (
            <li key={e.key}>
              <button
                type="button"
                className="bar-row"
                disabled={!onPick}
                title={onPick ? `Filter to ${e.label}` : e.label}
                onClick={() => onPick?.(e.key)}
              >
                <span className={`bar-label${mono ? ' mono' : ''}`}>
                  {pillClass ? <span className={`pill ${pillClass(e.key)}`}>{e.label}</span> : e.label}
                </span>
                <span className="bar-track" aria-hidden="true">
                  <span className="bar-fill" style={{ width: `${(e.count / max) * 100}%` }} />
                </span>
                <span className="bar-count">{formatNumber(e.count)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const fmtMs = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? '–' : `${formatNumber(Math.round(v))} ms`);

export function InsightsPanel() {
  const ins = useInsights();
  const schema = useLogStore((s) => s.schema);
  const rows = useLogStore((s) => s.rows);
  const filters = useLogStore((s) => s.filters);
  const setFilters = useLogStore((s) => s.setFilters);
  const select = useLogStore((s) => s.select);
  const setTab = useLogStore((s) => s.setTab);
  const zone = useDisplayZone();

  if (!ins) return <div className="insights muted small-text">Insights are available once parsing finishes.</div>;

  const statusKey = schema.find((c) => c.role === 'status')?.key;
  const levelKey = schema.find((c) => c.role === 'level')?.key;
  const ipKey = schema.find((c) => c.role === 'clientIp')?.key;
  const uriKey = schema.find((c) => c.role === 'uri')?.key;
  const durationKey = schema.find((c) => c.role === 'duration')?.key;
  const distKey = statusKey ?? levelKey;

  const addFacet = (key: string | undefined) => (value: string) => {
    if (!key) return;
    const current = filters.facets[key] ?? [];
    if (!current.includes(value)) setFilters({ facets: { ...filters.facets, [key]: [...current, value] } });
  };

  const errorRate = ins.total ? (ins.errors / ins.total) * 100 : 0;
  const noun = statusKey ? 'requests' : 'entries';

  return (
    <div className="insights" aria-label="Insights for the filtered rows">
      <div className="cards">
        <Card label={`Total ${noun}`} value={formatNumber(ins.total)} />
        {ins.errorBasis && (
          <Card
            label="Error rate"
            value={`${errorRate.toFixed(errorRate > 0 && errorRate < 10 ? 1 : 0)}%`}
            sub={`${formatNumber(ins.errors)} ${ins.errorBasis === 'status' ? '≥ 400' : 'ERROR/FATAL'}`}
          />
        )}
        {ins.duration && (
          <Card
            label={`${durationKey} avg / p95 / max`}
            value={`${fmtMs(ins.duration.avg)}`}
            sub={`p95 ${fmtMs(ins.duration.p95)} · max ${fmtMs(ins.duration.max)}`}
          />
        )}
        {ins.bytesSent !== null && <Card label="Bytes sent" value={formatBytes(ins.bytesSent)} sub={`${formatNumber(ins.bytesSent)} B`} />}
      </div>

      {ins.timeline && (
        <Histogram data={ins.timeline} onSelect={(from, to) => setFilters({ timeFrom: from, timeTo: to })} />
      )}

      <div className="insight-grid">
        {ins.distributionKind && (
          <BarList
            title={ins.distributionKind === 'status' ? 'Status codes' : 'Levels'}
            entries={ins.distribution}
            onPick={addFacet(distKey)}
            pillClass={(k) => (ins.distributionKind === 'status' ? statusClass(Number(k)) : levelClass(k))}
          />
        )}
        {uriKey && (
          <BarList title="Top URIs" entries={ins.topUris} onPick={(u) => setFilters({ uri: u, uriMode: 'equals' })} />
        )}
        {ipKey && <BarList title="Top client IPs" entries={ins.topIps} onPick={addFacet(ipKey)} />}
        {ins.slowest.length > 0 && (
          <div className="bar-list">
            <div className="chart-title">Slowest {noun}</div>
            <ol className="slowest">
              {ins.slowest.map((s) => {
                const row = rows[s.id]!;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="bar-row"
                      title="Jump to this row"
                      onClick={() => {
                        setTab('rows');
                        select(s.id);
                      }}
                    >
                      <span className="slow-ms">{formatNumber(s.duration)} ms</span>
                      <span className="bar-label mono">{uriKey ? String(row.values[uriKey] ?? '') : `line ${row.lineNo}`}</span>
                      <span className="bar-count mono">{formatTimestamp(row.ts, zone).slice(11)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
