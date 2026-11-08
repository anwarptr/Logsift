import { describe, expect, it } from 'vitest';
import { detectFormat, parseText, splitLines } from '../../src/parser';
import { parseAlbRequest, splitQuotedSpaces } from '../../src/parser/alb';

const SAMPLE_ALB_LINE =
  'https 2026-11-07T05:00:00.123456Z app/my-alb/50dc6c495c0c9188 192.168.131.39:2817 10.0.0.1:80 0.001 0.024 0.002 200 200 34 366 "GET https://api.example.com:443/orders/102?promo=fall HTTP/2.0" "curl/7.29.0" ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2 arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067 "Root=1-58337262-36d228c1b681380d34164b3c" "api.example.com" "arn:aws:acm:..." 0 2026-11-07T04:59:59.999000Z "forward" "-" "-" "10.0.0.1:80" "200" "-" "-"';

const SAMPLE_CLASSIC_ELB_LINE =
  '2026-11-07T05:00:00.123456Z my-loadbalancer 192.168.131.39:2817 10.0.0.1:80 0.001 0.024 0.002 200 200 34 366 "GET http://example.com/items HTTP/1.1" "curl/7.29.0" - -';

describe('AWS ALB and ELB parser', () => {
  it('detects ALB format', () => {
    expect(detectFormat(splitLines(SAMPLE_ALB_LINE))).toBe('alb');
  });

  it('detects Classic ELB format', () => {
    expect(detectFormat(splitLines(SAMPLE_CLASSIC_ELB_LINE))).toBe('alb');
  });

  it('parses ALB log lines into columns with semantic roles', () => {
    const r = parseText(SAMPLE_ALB_LINE, 'alb');
    expect(r.malformed).toHaveLength(0);
    expect(r.rows).toHaveLength(1);

    const row = r.rows[0]!;
    expect(row.values.type).toBe('https');
    expect(row.values.elb).toBe('app/my-alb/50dc6c495c0c9188');
    expect(row.values['c-ip']).toBe('192.168.131.39');
    expect(row.values['c-port']).toBe(2817);
    expect(row.values.target).toBe('10.0.0.1:80');
    expect(row.values['sc-status']).toBe(200);
    expect(row.values['target-status']).toBe(200);
    // (0.001 + 0.024 + 0.002) * 1000 = 27 ms
    expect(row.values['time-taken']).toBe(27);
    expect(row.values['cs-method']).toBe('GET');
    expect(row.values['cs-uri-stem']).toBe('/orders/102');
    expect(row.values['cs-uri-query']).toBe('promo=fall');
    expect(row.values['cs(User-Agent)']).toBe('curl/7.29.0');
    expect(row.values['domain-name']).toBe('api.example.com');
    expect(row.values['cs-bytes']).toBe(34);
    expect(row.values['sc-bytes']).toBe(366);

    const roles = Object.fromEntries(r.schema.filter((c) => c.role).map((c) => [c.role, c.key]));
    expect(roles).toMatchObject({
      status: 'sc-status',
      duration: 'time-taken',
      clientIp: 'c-ip',
      method: 'cs-method',
      uri: 'cs-uri-stem',
      uriQuery: 'cs-uri-query',
      bytesReceived: 'cs-bytes',
      bytesSent: 'sc-bytes',
      userAgent: 'cs(User-Agent)',
      host: 'domain-name',
    });
  });

  it('parses Classic ELB lines', () => {
    const r = parseText(SAMPLE_CLASSIC_ELB_LINE, 'alb');
    expect(r.malformed).toHaveLength(0);
    expect(r.rows).toHaveLength(1);

    const row = r.rows[0]!;
    expect(row.values.type).toBe('http');
    expect(row.values.elb).toBe('my-loadbalancer');
    expect(row.values['c-ip']).toBe('192.168.131.39');
    expect(row.values['sc-status']).toBe(200);
    expect(row.values['time-taken']).toBe(27);
    expect(row.values['cs-method']).toBe('GET');
    expect(row.values['cs-uri-stem']).toBe('/items');
  });

  it('handles dash requests when TLS handshake fails', () => {
    const req = parseAlbRequest('- - - ');
    expect(req).toEqual({ method: null, stem: null, query: null, version: null });
  });

  it('splits quoted tokens with escaped characters', () => {
    const tokens = splitQuotedSpaces('one "two with spaces" three "quote \\"inside\\""');
    expect(tokens).toEqual(['one', 'two with spaces', 'three', 'quote "inside"']);
  });

  it('records malformed rows for incomplete lines', () => {
    const r = parseText('short line here\n', 'alb');
    expect(r.rows).toHaveLength(0);
    expect(r.malformed).toHaveLength(1);
    expect(r.malformed[0]!.reason).toContain('too few fields');
  });
});
