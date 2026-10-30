import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLogIndex } from '../../src/filters/logIndex';
import { parseText } from '../../src/parser';
import { durationBins, heatmap, OTHER_KEY, requestFlow, responseTimes } from '../../src/utils/charts';
import { frebWaterfall } from '../../src/utils/frebSpans';
import { UTC_ZONE } from '../../src/utils/timezone';

const all = (n: number) => Uint32Array.from({ length: n }, (_, i) => i);

const HEADER = '#Software: Microsoft Internet Information Services 10.0\n#Fields: date time c-ip cs-method cs-uri-stem sc-status time-taken\n';
/** IIS lines: [date, time, client ip, uri, status, time-taken]. */
const iis = (lines: [string, string, string, string, number, number][]) =>
  parseText(HEADER + lines.map(([d, t, ip, uri, st, ms]) => `${d} ${t} ${ip} GET ${uri} ${st} ${ms}`).join('\n') + '\n');

describe('response times', () => {
  const r = iis([
    ['2026-03-14', '09:00:00', '10.0.0.1', '/a', 200, 5],
    ['2026-03-14', '09:00:00', '10.0.0.1', '/a', 200, 15],
    ['2026-03-14', '09:00:00', '10.0.0.2', '/b', 500, 2500],
    ['2026-03-14', '09:59:00', '10.0.0.2', '/b', 200, 40],
  ]);
  const index = buildLogIndex(r.rows, r.schema);

  it('buckets durations over time with p50 / p95 / max', () => {
    const t = responseTimes(index, all(r.rows.length), UTC_ZONE)!;
    expect(t.total).toBe(4);
    expect([t.minMs, t.maxMs]).toEqual([5, 2500]);
    expect(t.count.reduce((a, b) => a + b, 0)).toBe(4);
    expect(t.max[0]).toBe(2500);
    expect(t.p50[0]).toBe(15);
    expect(t.max[t.count.length - 1]).toBe(40);
  });

  it('counts requests and errors per duration range', () => {
    const bins = durationBins(index, all(r.rows.length))!;
    const byLabel = Object.fromEntries(bins.map((b) => [b.short, [b.count, b.errors]]));
    expect(byLabel).toMatchObject({ '<10': [1, 0], '10–50': [2, 0], '2–5s': [1, 1] });
    expect(bins.at(-1)!.to).toBe(Infinity);
  });

  it('returns null without a duration column', () => {
    const g = parseText('2026-03-14 09:00:00 INFO started\n');
    const gi = buildLogIndex(g.rows, g.schema);
    expect(responseTimes(gi, all(1), UTC_ZONE)).toBeNull();
    expect(durationBins(gi, all(1))).toBeNull();
  });
});

describe('heatmap', () => {
  it('counts rows by day and hour in the display zone, with clickable hour ranges', () => {
    const r = iis([
      ['2026-03-14', '09:10:00', 'a', '/', 200, 1],
      ['2026-03-14', '09:20:00', 'a', '/', 500, 1],
      ['2026-03-15', '23:30:00', 'a', '/', 200, 1],
    ]);
    const index = buildLogIndex(r.rows, r.schema);
    const h = heatmap(index, all(3), UTC_ZONE)!;
    expect(h.mode).toBe('days');
    expect(h.rows.map((x) => x.label)).toEqual(['2026-03-14', '2026-03-15']);
    expect(h.counts[0 * 24 + 9]).toBe(2);
    expect(h.errors[0 * 24 + 9]).toBe(1);
    expect(h.counts[1 * 24 + 23]).toBe(1);
    expect(h.rows[1]!.start).toBe(Date.UTC(2026, 2, 15));
    // In UTC+4 the late line moves to the next day.
    const shifted = heatmap(index, all(3), { kind: 'fixed', offsetMin: 240 })!;
    expect(shifted.rows.map((x) => x.label)).toEqual(['2026-03-14', '2026-03-15', '2026-03-16']);
    expect(shifted.counts[0 * 24 + 13]).toBe(2);
    expect(shifted.rows[0]!.start).toBe(Date.UTC(2026, 2, 14) - 4 * 3_600_000);
  });

  it('falls back to weekdays when the log spans more than a month', () => {
    const r = iis([
      ['2026-01-05', '10:00:00', 'a', '/', 200, 1], // Monday
      ['2026-03-14', '10:00:00', 'a', '/', 200, 1], // Saturday
    ]);
    const index = buildLogIndex(r.rows, r.schema);
    const h = heatmap(index, all(2), UTC_ZONE)!;
    expect(h.mode).toBe('weekdays');
    expect(h.rows[0]).toEqual({ label: 'Mon', start: null });
    expect(h.counts[0 * 24 + 10]).toBe(1);
    expect(h.counts[5 * 24 + 10]).toBe(1);
  });
});

describe('request flow', () => {
  it('links callers to endpoint patterns to status classes, folding the tail into Other', () => {
    const lines: [string, string, string, string, number, number][] = [];
    for (let i = 0; i < 12; i++) lines.push(['2026-03-14', '09:00:00', `10.0.0.${i}`, `/api/orders/${i}`, i < 3 ? 500 : 200, 1]);
    lines.push(['2026-03-14', '09:00:01', '10.0.0.0', '/health', 200, 1]);
    const r = iis(lines);
    const index = buildLogIndex(r.rows, r.schema);
    const f = requestFlow(r.rows, r.schema, index, all(r.rows.length), { callers: 4, endpoints: 10 })!;
    expect(f.callerKey).toBe('c-ip');
    expect(f.callers.map((c) => c.key)).toEqual(['10.0.0.0', '10.0.0.1', '10.0.0.2', '10.0.0.3', OTHER_KEY]);
    expect(f.callers[0]!.count).toBe(2);
    expect(f.callers.at(-1)).toMatchObject({ label: 'Other', count: 8 });
    expect(f.endpoints.map((e) => e.key)).toEqual(['/api/orders/{id}', '/health']);
    expect(f.statuses.map((s) => [s.label, s.count, s.errors])).toEqual([
      ['2xx', 10, 0],
      ['5xx', 3, 3],
    ]);
    // Every request appears once in each link set.
    expect([...f.callerToEndpoint.values()].reduce((a, b) => a + b, 0)).toBe(13);
    expect(f.endpointToStatus.get('0,1')).toBe(3); // /api/orders/{id} → 5xx
    expect(f.endpointToStatus.get('1,0')).toBe(1); // /health → 2xx
  });

  it('counts only request lines, and starts at the endpoints when there is no caller column', () => {
    const r = parseText(readFileSync('fixtures/sample-serilog.log', 'utf8'));
    const index = buildLogIndex(r.rows, r.schema);
    const f = requestFlow(r.rows, r.schema, index, all(r.rows.length))!;
    const requests = r.rows.filter((x) => x.values.RequestPath != null).length;
    expect(requests).toBeLessThan(r.rows.length); // the log also has non-request lines
    expect(f.callers).toEqual([]);
    expect(f.callerToEndpoint.size).toBe(0);
    expect(f.endpoints.reduce((s, e) => s + e.count, 0)).toBe(requests);
    expect(f.endpoints.some((e) => e.label === '(empty)')).toBe(false);
    expect(f.statuses.some((s) => s.cls === null)).toBe(false);
  });

  it('needs both a URI and a status', () => {
    const g = parseText('2026-03-14 09:00:00 INFO started\n');
    expect(requestFlow(g.rows, g.schema, buildLogIndex(g.rows, g.schema), all(1))).toBeNull();
  });
});

describe('FREB waterfall', () => {
  it('pairs module start and end events into timed steps and marks the error module', () => {
    const r = parseText(readFileSync('fixtures/sample-freb.xml', 'utf8'));
    const w = frebWaterfall(r.rows[0]!.raw);
    expect(w.events).toBe(5);
    expect(w.totalMs).toBe(125);
    expect(w.errorModule).toBe('ConfigurationValidationModule');
    // The fixture's module start has no matching end, so no timed step.
    expect(w.spans).toEqual([]);
  });

  it('reads offsets and nested module steps from the timeline text', () => {
    const timeline = [
      '09:30:01.100 +0 ms  GENERAL_REQUEST_START',
      '09:30:01.110 +10 ms  NOTIFY_MODULE_START',
      '    ModuleName: AuthModule',
      '    Notification: AUTHENTICATE_REQUEST',
      '09:30:01.140 +40 ms  NOTIFY_MODULE_END',
      '    ModuleName: AuthModule',
      '    Notification: AUTHENTICATE_REQUEST',
      '09:30:01.150 +50 ms  NOTIFY_MODULE_START',
      '    ModuleName: AspNetCoreModuleV2',
      '    Notification: EXECUTE_REQUEST_HANDLER',
      '09:30:01.900 +800 ms  MODULE_SET_RESPONSE_ERROR_STATUS [Warning]',
      '    ModuleName: AspNetCoreModuleV2',
      '09:30:02.100 +1000 ms  NOTIFY_MODULE_END',
      '    ModuleName: AspNetCoreModuleV2',
      '    Notification: EXECUTE_REQUEST_HANDLER',
    ].join('\n');
    const w = frebWaterfall(timeline);
    expect(w.spans).toEqual([
      { module: 'AuthModule', notification: 'AUTHENTICATE_REQUEST', start: 10, end: 40 },
      { module: 'AspNetCoreModuleV2', notification: 'EXECUTE_REQUEST_HANDLER', start: 50, end: 1000 },
    ]);
    expect(w.totalMs).toBe(1000);
    expect(w.errorModule).toBe('AspNetCoreModuleV2');
  });
});
