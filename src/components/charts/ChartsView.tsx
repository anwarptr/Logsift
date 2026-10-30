import { useLogStore } from '../../store/logStore';
import { useChartData, useDisplayZone, useLogIndex } from '../../store/useView';
import { formatNumber } from '../../utils/format';
import { displayZoneLabel } from '../../utils/timezone';
import { DurationBars } from './DurationBars';
import { RequestFlow } from './RequestFlow';
import { ResponseTimeChart } from './ResponseTimeChart';
import { TrafficHeatmap } from './TrafficHeatmap';

/**
 * Diagrams of the filtered rows. Each section appears only when the log has what it needs
 * (durations, timestamps, URIs and statuses), and nothing is computed until this tab is open.
 */
export function ChartsView() {
  const data = useChartData();
  const index = useLogIndex();
  const zone = useDisplayZone();
  const schema = useLogStore((s) => s.schema);
  if (!data || !index) return <div className="table-empty">Charts are available once parsing finishes.</div>;
  if (data.matched.length === 0) return <div className="table-empty">No rows match the filters.</div>;
  const { times, bins, heat, flow } = data;
  const durationKey = schema.find((c) => c.role === 'duration')?.key;
  if (!times && !bins && !heat && !flow) {
    return <div className="table-empty">This log has no timestamps, durations or URLs to chart.</div>;
  }
  return (
    <div className="charts-view">
      <p className="muted small-text charts-note">
        Charts of the {formatNumber(data.matched.length)} rows matching the current filters; clicking or dragging in a chart adds a filter.
      </p>
      {(times || bins) && (
        <section className="chart-card" aria-label="Response times">
          <div className="chart-row">
            {times && <ResponseTimeChart data={times} index={index} matched={data.matched} />}
            {bins && durationKey && <DurationBars bins={bins} durationKey={durationKey} />}
          </div>
        </section>
      )}
      {heat && (
        <section className="chart-card" aria-label="Traffic by hour">
          <TrafficHeatmap data={heat} zoneLabel={displayZoneLabel(zone, index.minTs ?? Date.now())} />
        </section>
      )}
      {flow && (
        <section className="chart-card" aria-label="Request flow">
          <RequestFlow flow={flow} callerIsFacet={index.facets.some((f) => f.key === flow.callerKey)} />
        </section>
      )}
    </div>
  );
}
