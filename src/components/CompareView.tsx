import { useMemo, useState } from 'react';
import { facetLabel } from '../filters/types';
import { useLogStore } from '../store/logStore';
import { useComparison, useDisplayZone, useLogIndex } from '../store/useView';
import {
  changedPatterns,
  perMinute,
  worseEndpoints,
  type ComparePreset,
  type Comparison,
  type EndpointSort,
  type SideStats,
  type TimeRange,
} from '../utils/compare';
import { formatNumber, formatTimestamp } from '../utils/format';
import { fromZonedInput, toZonedInput } from '../utils/timezone';

const PRESETS: { value: ComparePreset; label: string }[] = [
  { value: 'halves', label: 'Second half vs first half' },
  { value: 'last15m', label: 'Last 15 minutes vs the 15 before' },
  { value: 'last1h', label: 'Last hour vs the hour before' },
  { value: 'last1d', label: 'Last day vs the day before' },
  { value: 'split', label: 'Before / after a time…' },
];

const fmtRate = (v: number) => (v >= 100 ? formatNumber(Math.round(v)) : v >= 10 ? v.toFixed(1) : v >= 0.01 ? v.toFixed(2) : v > 0 ? '<0.01' : '0');
const fmtPct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%` : '–');
const fmtMs = (v: number) => (Number.isFinite(v) ? formatNumber(Math.round(v)) : '–');

/** "before → after" with the after value marked when it got worse (higher) or better. */
function Change({ a, b, format, worseWhenHigher = true }: { a: number; b: number; format: (v: number) => string; worseWhenHigher?: boolean }) {
  const dir = !Number.isFinite(a) || !Number.isFinite(b) || a === b ? 0 : b > a ? 1 : -1;
  const cls = dir === 0 ? '' : (dir > 0) === worseWhenHigher ? ' cmp-worse' : ' cmp-better';
  return (
    <span className="cmp-change">
      <span className="muted">{format(a)}</span> <span aria-hidden="true">→</span>
      <span className="visually-hidden"> to </span> <span className={'cmp-after' + cls}>{format(b)}</span>
    </span>
  );
}

function Summary({ c, hasDuration, hasErrors }: { c: Comparison; hasDuration: boolean; hasErrors: boolean }) {
  const rate = (s: SideStats) => (s.rows ? s.errors / s.rows : Number.NaN);
  return (
    <div className="cmp-cards">
      <div className="cmp-card">
        <div className="cmp-card-label">Rows per minute</div>
        <Change a={perMinute(c.a.rows, c.a)} b={perMinute(c.b.rows, c.b)} format={fmtRate} worseWhenHigher={false} />
      </div>
      {hasErrors && (
        <div className="cmp-card">
          <div className="cmp-card-label">Error rate</div>
          <Change a={rate(c.a)} b={rate(c.b)} format={fmtPct} />
        </div>
      )}
      {hasErrors && (
        <div className="cmp-card">
          <div className="cmp-card-label">Errors per minute</div>
          <Change a={perMinute(c.a.errors, c.a)} b={perMinute(c.b.errors, c.b)} format={fmtRate} />
        </div>
      )}
      {hasDuration && (
        <div className="cmp-card">
          <div className="cmp-card-label">p95 ms</div>
          <Change a={c.a.p95} b={c.b.p95} format={fmtMs} />
        </div>
      )}
    </div>
  );
}

/**
 * "What changed?": two time ranges of the log side by side (with the current filters, except time):
 * overall rates, endpoints that got worse, new or growing message patterns, and values that only
 * appear in the later range. Click a line to see those rows of the later range.
 */
export function CompareView() {
  const cmp = useComparison();
  const setting = useLogStore((s) => s.compare);
  const setCompare = useLogStore((s) => s.setCompare);
  const setFilters = useLogStore((s) => s.setFilters);
  const setTab = useLogStore((s) => s.setTab);
  const select = useLogStore((s) => s.select);
  const hasDuration = useLogStore((s) => s.schema.some((c) => c.role === 'duration'));
  const index = useLogIndex();
  const zone = useDisplayZone();
  const [sort, setSort] = useState<EndpointSort>('errors');
  const hasErrors = !!index && (index.hasStatus || index.hasLevel);

  const endpoints = useMemo(() => (cmp ? worseEndpoints(cmp.result, sort) : []), [cmp, sort]);
  const patterns = useMemo(() => (cmp ? changedPatterns(cmp.result) : []), [cmp]);

  if (!index) return <div className="table-empty">The comparison is available once parsing finishes.</div>;
  if (!cmp) return <div className="table-empty">This log has no time span to compare (its rows have no timestamps, or all the same one).</div>;

  const { ranges, result } = cmp;
  const time = (ms: number) => formatTimestamp(ms, zone);
  const rangeText = (r: TimeRange) => `${time(Math.max(r.from, index.minTs!))} – ${time(Math.min(r.to - 1, index.maxTs!))}`;
  /** Show the later range's rows, narrowed by `patch`. */
  const showAfter = (patch: Parameters<typeof setFilters>[0]) => {
    setFilters({ timeFrom: ranges.b.from, timeTo: ranges.b.to - 1, ...patch });
    setTab('rows');
  };
  const notEnough = result.a.rows === 0 || result.b.rows === 0;

  return (
    <div className="compare">
      <div className="cmp-head">
        <label htmlFor="cmp-preset">Compare</label>
        <select
          id="cmp-preset"
          value={setting.preset}
          onChange={(e) => setCompare({ ...setting, preset: e.target.value as ComparePreset })}
        >
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        {setting.preset === 'split' && (
          <>
            <label htmlFor="cmp-split" className="visually-hidden">
              After starts at
            </label>
            <input
              id="cmp-split"
              type="datetime-local"
              step="1"
              min={toZonedInput(index.minTs!, zone)}
              max={toZonedInput(index.maxTs!, zone)}
              value={toZonedInput(ranges.b.from, zone)}
              onChange={(e) => {
                const at = fromZonedInput(e.target.value, zone);
                if (at !== null) setCompare({ preset: 'split', splitAt: at });
              }}
            />
          </>
        )}
        <span className="muted small-text">Uses your filters, except the time range.</span>
      </div>
      <dl className="cmp-ranges">
        <div>
          <dt>Before</dt>
          <dd>
            {rangeText(ranges.a)} · {formatNumber(result.a.rows)} rows
          </dd>
        </div>
        <div>
          <dt>After</dt>
          <dd>
            {rangeText(ranges.b)} · {formatNumber(result.b.rows)} rows
          </dd>
        </div>
      </dl>

      {notEnough ? (
        <div className="table-empty">
          {result.a.rows === 0
            ? 'No rows in the "before" range: the log does not go back that far (choose a shorter range, or another preset).'
            : 'No rows in the "after" range.'}
        </div>
      ) : (
        <>
          <Summary c={result} hasDuration={hasDuration} hasErrors={hasErrors} />

          {index.uriPattern && (
            <section className="cmp-section" aria-labelledby="cmp-endpoints">
              <div className="cmp-section-head">
                <h3 id="cmp-endpoints">Endpoints that got worse</h3>
                <div className="seg" role="group" aria-label="Rank endpoints by">
                  {(
                    [
                      ['errors', 'More errors', hasErrors],
                      ['slower', 'Slower', hasDuration],
                      ['traffic', 'More traffic', true],
                    ] as const
                  )
                    .filter(([, , show]) => show)
                    .map(([value, label]) => (
                      <button key={value} type="button" aria-pressed={sort === value} className="btn small" onClick={() => setSort(value)}>
                        {label}
                      </button>
                    ))}
                </div>
              </div>
              {endpoints.length === 0 ? (
                <p className="muted">No endpoint got worse by this measure.</p>
              ) : (
                <table className="endpoints-table cmp-table">
                  <thead>
                    <tr>
                      <th scope="col">Endpoint</th>
                      <th scope="col" className="num">
                        Requests/min
                      </th>
                      {hasErrors && (
                        <th scope="col" className="num">
                          Error %
                        </th>
                      )}
                      {hasDuration && (
                        <th scope="col" className="num">
                          p95 ms
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {endpoints.map((e) => (
                      <tr key={e.pattern}>
                        <td className="endpoint-cell">
                          <button type="button" className="link-button mono" title="Show these rows of the later range" onClick={() => showAfter({ endpoint: e.pattern })}>
                            {facetLabel(e.pattern)}
                          </button>
                          {e.a.count === 0 && <span className="tag cmp-new">new</span>}
                        </td>
                        <td className="num">
                          <Change a={perMinute(e.a.count, result.a)} b={perMinute(e.b.count, result.b)} format={fmtRate} worseWhenHigher={false} />
                        </td>
                        {hasErrors && (
                          <td className="num">
                            <Change a={e.a.count ? e.a.errors / e.a.count : Number.NaN} b={e.b.count ? e.b.errors / e.b.count : Number.NaN} format={fmtPct} />
                          </td>
                        )}
                        {hasDuration && (
                          <td className="num">
                            <Change a={e.a.p95} b={e.b.p95} format={fmtMs} />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          {index.messageKey && (
            <section className="cmp-section" aria-labelledby="cmp-patterns">
              <div className="cmp-section-head">
                <h3 id="cmp-patterns">New or growing messages</h3>
              </div>
              {patterns.length === 0 ? (
                <p className="muted">No message is new or at least twice as frequent.</p>
              ) : (
                <table className="endpoints-table cmp-table">
                  <thead>
                    <tr>
                      <th scope="col">Message pattern</th>
                      <th scope="col" className="num">
                        Per min
                      </th>
                      {hasErrors && (
                        <th scope="col" className="num">
                          Errors after
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {patterns.map((p) => (
                      <tr key={p.pattern}>
                        <td className="endpoint-cell">
                          <button
                            type="button"
                            className="link-button mono cmp-pattern"
                            title="Show these rows of the later range"
                            onClick={() => {
                              showAfter({ pattern: p.pattern });
                              select(p.sampleId);
                            }}
                          >
                            {p.pattern}
                          </button>
                          {p.isNew && <span className="tag cmp-new">new</span>}
                        </td>
                        <td className="num">
                          <Change a={perMinute(p.a, result.a)} b={perMinute(p.b, result.b)} format={fmtRate} />
                        </td>
                        {hasErrors && <td className={'num' + (p.errorsB ? ' err-text' : '')}>{formatNumber(p.errorsB)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          {result.newValues.length > 0 && (
            <section className="cmp-section" aria-labelledby="cmp-values">
              <div className="cmp-section-head">
                <h3 id="cmp-values">Only in the later range</h3>
              </div>
              <dl className="cmp-values">
                {result.newValues.map((col) => (
                  <div key={col.key}>
                    <dt>{col.label}</dt>
                    <dd>
                      {col.values.map((v) => (
                        <button
                          key={v.value}
                          type="button"
                          className="chip-button"
                          title="Show these rows of the later range"
                          onClick={() => showAfter({ facets: { ...useLogStore.getState().filters.facets, [col.key]: [v.value] } })}
                        >
                          <span className="mono">{facetLabel(v.value)}</span> <span className="muted">{formatNumber(v.count)}</span>
                        </button>
                      ))}
                      {col.more > 0 && <span className="muted small-text">+{formatNumber(col.more)} more</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </>
      )}
    </div>
  );
}
