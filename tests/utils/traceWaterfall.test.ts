import { describe, expect, it } from 'vitest';
import type { LogRow } from '../../src/parser';
import {
  buildTraceWaterfallData,
  extractRowDuration,
  extractTraceEntry,
  isRowError,
  normalizeTraceId,
  traceToMarkdown,
} from '../../src/utils/traceWaterfall';

describe('normalizeTraceId', () => {
  it('extracts 32-hex trace ID from W3C traceparent header', () => {
    const raw = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    expect(normalizeTraceId(raw)).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('extracts Root ID from AWS X-Ray trace header', () => {
    const raw = 'Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995cbe316dec55;Sampled=1';
    expect(normalizeTraceId(raw)).toBe('1-5759e988-bd862e3fe1be46a994272793');
  });

  it('extracts trace ID from Jaeger header', () => {
    const raw = '4bf92f3577b34da6:00f067aa0ba902b7:0:1';
    expect(normalizeTraceId(raw)).toBe('4bf92f3577b34da6');
  });

  it('preserves clean raw trace / request ID strings', () => {
    expect(normalizeTraceId('req-abc-123')).toBe('req-abc-123');
    expect(normalizeTraceId('   txn_7788   ')).toBe('txn_7788');
  });
});

describe('extractTraceEntry', () => {
  it('identifies trace keys regardless of case', () => {
    expect(extractTraceEntry({ TRACE_ID: 'tx-1' })).toEqual(['TRACE_ID', 'tx-1']);
    expect(extractTraceEntry({ operation_Id: 'op-999' })).toEqual(['operation_Id', 'op-999']);
    expect(extractTraceEntry({ '@tr': '4bf92f3577b34da6a3ce929d0e0e4736' })).toEqual(['@tr', '4bf92f3577b34da6a3ce929d0e0e4736']);
    expect(extractTraceEntry({ 'x-amzn-trace-id': 'Root=1-abc' })).toEqual(['x-amzn-trace-id', 'Root=1-abc']);
    expect(extractTraceEntry({ traceparent: '00-abc-def-01' })).toEqual(['traceparent', '00-abc-def-01']);
    expect(extractTraceEntry({ requestId: 'r-100' })).toEqual(['requestId', 'r-100']);
    expect(extractTraceEntry({ requestId: 1042 })).toEqual(['requestId', '1042']);
    expect(extractTraceEntry({ other: 'val' })).toBeNull();
  });

  it('prioritizes root trace ID over secondary span IDs', () => {
    // When both span_id and trace_id appear, trace_id is selected regardless of object key order
    expect(extractTraceEntry({ span_id: 'span-99', trace_id: 'root-42' })).toEqual(['trace_id', 'root-42']);
    expect(extractTraceEntry({ operation_parentid: 'parent-1', operation_id: 'op-root' })).toEqual([
      'operation_id',
      'op-root',
    ]);
    expect(extractTraceEntry({ span_id: 'span-only' })).toEqual(['span_id', 'span-only']);
  });
});

describe('buildTraceWaterfallData', () => {
  const row = (id: number, ts: number | null, values: Record<string, unknown>, raw = ''): LogRow => ({
    id,
    lineNo: id + 1,
    ts,
    values: values as Record<string, string | number | boolean | null>,
    raw: raw || String(id),
  });

  it('builds a visual timeline from rows across multiple services and formats', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const rows: LogRow[] = [
      row(0, 1000, {
        traceparent: `00-${traceId}-0000000000000001-01`,
        service: 'gateway',
        'cs-method': 'POST',
        'cs-uri-stem': '/checkout',
        'time-taken': 250,
        status: 500,
      }),
      row(1, 1020, {
        trace_id: traceId,
        service: 'order-api',
        message: 'Validating cart items for user 42',
      }),
      row(2, 1080, {
        trace_id: traceId,
        service: 'payment-svc',
        message: 'Invoking Stripe charge API',
        durationMs: 140,
        level: 'INFO',
      }),
      row(3, 1220, {
        trace_id: traceId,
        service: 'payment-svc',
        message: 'PaymentGatewayTimeoutException: Stripe timed out',
        level: 'ERROR',
      }),
      row(4, 1500, {
        trace_id: 'other-unrelated-trace',
        message: 'Unrelated log',
      }),
    ];

    const data = buildTraceWaterfallData(rows, traceId, 'trace_id');
    expect(data).not.toBeNull();
    expect(data!.spans).toHaveLength(4);
    expect(data!.services).toEqual(['gateway', 'order-api', 'payment-svc']);
    expect(data!.errorCount).toBe(2); // row 0 (status 500) and row 3 (level ERROR)

    // Check span timing and properties
    const [s0, s1, s2, s3] = data!.spans;
    expect(s0).toMatchObject({
      rowId: 0,
      service: 'gateway',
      action: 'POST /checkout',
      startOffsetMs: 0,
      durationMs: 250,
      status: 500,
      isError: true,
    });
    expect(s1).toMatchObject({
      rowId: 1,
      service: 'order-api',
      action: 'Validating cart items for user 42',
      startOffsetMs: 20,
      durationMs: 0,
      isPointInTime: true,
      isError: false,
    });
    expect(s2).toMatchObject({
      rowId: 2,
      service: 'payment-svc',
      action: 'Invoking Stripe charge API',
      startOffsetMs: 80,
      durationMs: 140,
      isError: false,
    });
    expect(s3).toMatchObject({
      rowId: 3,
      service: 'payment-svc',
      action: 'PaymentGatewayTimeoutException: Stripe timed out',
      startOffsetMs: 220,
      isError: true,
    });

    expect(data!.totalDurationMs).toBe(250); // span 0 ended at 1250ms (1000 + 250)
  });

  it('correlates Azure Application Insights rows using operation_Id', () => {
    const opId = 'd4c8a2e1f0b3';
    const rows: LogRow[] = [
      row(0, 1000, { operation_Id: opId, cloud_RoleName: 'frontend-app', name: 'GET /checkout', duration: 300, resultCode: '200' }),
      row(1, 1050, { operation_Id: opId, cloud_RoleName: 'order-api', name: 'POST /orders', duration: 120, resultCode: '500', success: false }),
    ];
    const data = buildTraceWaterfallData(rows, opId, 'operation_Id');
    expect(data).not.toBeNull();
    expect(data!.services).toEqual(['frontend-app', 'order-api']);
    expect(data!.spans[0]!.action).toBe('GET /checkout');
    expect(data!.spans[1]!.action).toBe('POST /orders');
    expect(data!.spans[1]!.isError).toBe(true);
    expect(data!.spans[1]!.status).toBe(500);
  });

  it('correctly extracts row duration and error status helpers', () => {
    expect(extractRowDuration(row(0, 1000, { 'time-taken': 45 }))).toBe(45);
    expect(extractRowDuration(row(1, 1000, { duration: '120ms' }))).toBe(120);
    expect(extractRowDuration(row(2, 1000, { elapsed_ms: '85' }))).toBe(85);
    expect(extractRowDuration(row(3, 1000, {}))).toBeNull();

    expect(isRowError(row(0, 1000, { level: 'ERROR' }))).toBe(true);
    expect(isRowError(row(1, 1000, { status: '500' }))).toBe(true);
    expect(isRowError(row(2, 1000, { level: 'INFO', status: 200 }))).toBe(false);
  });

  it('formats trace as markdown table for tickets and sharing', () => {
    const traceId = 'tx-test-123';
    const rows: LogRow[] = [
      row(0, 1000, { trace_id: traceId, service: 'api', message: 'req received', durationMs: 50 }),
      row(1, 1050, { trace_id: traceId, service: 'api', message: 'req completed', status: 200 }),
    ];
    const data = buildTraceWaterfallData(rows, traceId, 'trace_id')!;
    const md = traceToMarkdown(data);
    expect(md).toContain('### Distributed Trace: `tx-test-123`');
    expect(md).toContain('| +0 ms | 50 ms | api | req received | - | 1 |');
    expect(md).toContain('| +50 ms | - | api | req completed | 200 | 2 |');
  });
});
