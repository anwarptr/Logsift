import { describe, expect, it } from 'vitest';
import { parseText } from '../../src/parser';
import { parseLatencyMs } from '../../src/parser/jsonl';

describe('Google Cloud Logging JSON normalization', () => {
  it('parses latency strings into numeric milliseconds', () => {
    expect(parseLatencyMs('0.125s')).toBe(125);
    expect(parseLatencyMs('1.5s')).toBe(1500);
    expect(parseLatencyMs('45ms')).toBe(45);
    expect(parseLatencyMs(250)).toBe(250);
  });

  it('normalizes GCP jsonPayload and httpRequest with latency and severity', () => {
    const log = JSON.stringify({
      insertId: '12345',
      timestamp: '2026-11-07T05:00:00.500Z',
      severity: 'WARNING',
      jsonPayload: {
        message: 'High memory usage',
        cluster: 'prod-us',
        pod: 'api-7d99f',
      },
      httpRequest: {
        requestMethod: 'GET',
        requestUrl: '/api/v1/metrics',
        status: 200,
        remoteIp: '10.0.1.20',
        userAgent: 'Prometheus/2.45',
        latency: '0.045s',
      },
    });

    const r = parseText(log, 'jsonl');
    expect(r.malformed).toHaveLength(0);
    expect(r.rows).toHaveLength(1);

    const row = r.rows[0]!;
    // severity kept as logged
    expect(row.values.severity).toBe('WARNING');
    // jsonPayload fields flattened
    expect(row.values.message).toBe('High memory usage');
    expect(row.values.cluster).toBe('prod-us');
    expect(row.values.pod).toBe('api-7d99f');
    // httpRequest fields flattened and latency converted to ms
    expect(row.values['httpRequest.requestMethod']).toBe('GET');
    expect(row.values['httpRequest.requestUrl']).toBe('/api/v1/metrics');
    expect(row.values['httpRequest.status']).toBe(200);
    expect(row.values['httpRequest.remoteIp']).toBe('10.0.1.20');
    expect(row.values['httpRequest.latency']).toBe(45);

    const roles = Object.fromEntries(r.schema.filter((c) => c.role).map((c) => [c.role, c.key]));
    expect(roles.level).toBe('severity');
    expect(roles.message).toBe('message');
    expect(roles.method).toBe('httpRequest.requestMethod');
    expect(roles.uri).toBe('httpRequest.requestUrl');
    expect(roles.status).toBe('httpRequest.status');
    expect(roles.clientIp).toBe('httpRequest.remoteIp');
    expect(roles.duration).toBe('httpRequest.latency');
  });

  it('maps GCP textPayload to message when no jsonPayload is present', () => {
    const log = JSON.stringify({
      timestamp: '2026-11-07T05:00:00Z',
      severity: 'ERROR',
      textPayload: 'Failed to bind port 8080: address already in use',
    });

    const r = parseText(log, 'jsonl');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.values.message).toBe('Failed to bind port 8080: address already in use');
    expect(r.rows[0]!.values.severity).toBe('ERROR');
  });
});

describe('AWS CloudWatch Logs Insights JSON normalization', () => {
  it('unpacks nested JSON inside @message', () => {
    const line = JSON.stringify({
      '@timestamp': '2026-11-07 05:00:00.123',
      '@logStream': '2026/11/07/[$LATEST]abcd1234',
      '@message': JSON.stringify({
        level: 'info',
        msg: 'Payment processed successfully',
        orderId: 9001,
        durationMs: 42,
      }),
    });

    const r = parseText(line, 'jsonl');
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row.values.msg).toBe('Payment processed successfully');
    expect(row.values.orderId).toBe(9001);
    expect(row.values.durationMs).toBe(42);
    expect(row.values['@logStream']).toBe('2026/11/07/[$LATEST]abcd1234');
  });

  it('extracts level and message from structured text in @message', () => {
    const line = JSON.stringify({
      '@timestamp': '2026-11-07 05:00:00.123',
      '@logStream': 'app-stream',
      '@message': '2026-11-07T05:00:00.123Z [ERROR] [order-service] Failed to charge card',
    });

    const r = parseText(line, 'jsonl');
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row.values.level).toBe('ERROR');
    expect(row.values.logger).toBe('order-service');
    expect(row.values.message).toBe('Failed to charge card');
  });
});
