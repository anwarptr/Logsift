// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TraceWaterfall } from '../../src/components/TraceWaterfall';
import { useLogStore } from '../../src/store/logStore';
import type { LogRow } from '../../src/parser';

afterEach(cleanup);

const mockRow = (id: number, ts: number | null, values: Record<string, unknown>, raw = ''): LogRow => ({
  id,
  lineNo: id + 1,
  ts,
  values: values as Record<string, string | number | boolean | null>,
  raw: raw || `Raw log line ${id}`,
});

describe('TraceWaterfall component', () => {
  it('renders trace waterfall list for rows sharing a trace ID', () => {
    const traceId = 'trace-xyz-999';
    const rows: LogRow[] = [
      mockRow(0, 1000, {
        trace_id: traceId,
        service: 'api-gateway',
        'cs-method': 'GET',
        'cs-uri-stem': '/orders/42',
        'time-taken': 150,
        status: 200,
      }),
      mockRow(1, 1050, {
        trace_id: traceId,
        service: 'database',
        message: 'Query executed SELECT * FROM orders',
        durationMs: 40,
      }),
      mockRow(2, 1150, {
        trace_id: traceId,
        service: 'api-gateway',
        message: 'Request fulfilled',
      }),
    ];

    useLogStore.setState({ rows });

    render(<TraceWaterfall traceKey="trace_id" traceVal={traceId} />);

    expect(screen.getByText('Distributed Trace Waterfall')).toBeTruthy();
    expect(screen.getAllByText(/150 ms/).length).toBeGreaterThan(0);
    expect(screen.getByText('GET /orders/42')).toBeTruthy();
    expect(screen.getByText('Query executed SELECT * FROM orders')).toBeTruthy();

    // Expand button exists
    const expandBtn = screen.getByRole('button', { name: /Expand/ });
    expect(expandBtn).toBeTruthy();

    // Clicking Expand opens modal
    act(() => {
      fireEvent.click(expandBtn);
    });

    expect(screen.getByRole('dialog', { name: 'Distributed Trace Waterfall' })).toBeTruthy();
    expect(screen.getByText('Filter log to trace')).toBeTruthy();

    // Close modal
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    });

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
