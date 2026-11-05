import { describe, expect, it } from 'vitest';
import { redactLine } from '../../src/utils/redact';

describe('redactLine', () => {
  it('masks IPs, e-mails, GUIDs and tokens but keeps timestamps and the line shape', () => {
    const line =
      '2026-10-27 04:42:03.120 GET /api/users?token=abc123&page=2 from 203.0.113.7 [fe80::1] ' +
      'user=jane.doe@contoso.com req=3f2504e0-4f89-11d3-9a0c-0305e82c3301 Authorization: Bearer abc.def-ghi_123456';
    expect(redactLine(line)).toBe(
      '2026-10-27 04:42:03.120 GET /api/users?token=<redacted>&page=2 from 192.0.2.1 [2001:db8::1] ' +
        'user=user@example.com req=00000000-0000-0000-0000-000000000000 Authorization: Bearer <token>',
    );
  });

  it('masks JWTs, full IPv6 addresses and long opaque tokens', () => {
    expect(redactLine('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_x-1')).toBe('jwt <jwt>');
    expect(redactLine('ip 2001:0db8:85a3:0000:0000:8a2e:0370:7334 end')).toBe('ip 2001:db8::1 end');
    expect(redactLine('k=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8 ok')).toBe('k=<token> ok');
    expect(redactLine('password=hunter2 next')).toBe('password=<redacted> next');
  });

  it('leaves ordinary text, times and paths alone', () => {
    const line = '[11:54:02 INF] HTTP GET /api/products/123 responded 200 in 12.5 ms';
    expect(redactLine(line)).toBe(line);
    expect(redactLine('Basic authentication failed for user')).toBe('Basic authentication failed for user');
    expect(redactLine('Bearer validation succeeded')).toBe('Bearer validation succeeded');
    expect(redactLine('Authorization: Basic dXNlcjpwYXNz')).toBe('Authorization: Basic <token>');
  });
});
