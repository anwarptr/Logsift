import { describe, expect, it } from 'vitest';
import { parseText } from '../../src/parser';
import { firstForwardedIp } from '../../src/parser/iis';

const fields = (extra: string) => `#Fields: date time cs-method cs-uri-stem c-ip ${extra} sc-status`;

describe('firstForwardedIp', () => {
  it('takes the first address of the chain, without port or brackets', () => {
    expect(firstForwardedIp('203.0.113.7')).toBe('203.0.113.7');
    expect(firstForwardedIp('203.0.113.7,+10.0.0.4')).toBe('203.0.113.7'); // IIS writes spaces as "+"
    expect(firstForwardedIp('203.0.113.7:51234,10.0.0.4')).toBe('203.0.113.7');
    expect(firstForwardedIp('[2001:db8::7]:443')).toBe('2001:db8::7');
    expect(firstForwardedIp('2001:db8::7,+10.0.0.4')).toBe('2001:db8::7');
  });

  it('returns null for empty or unusable values', () => {
    expect(firstForwardedIp('-')).toBeNull();
    expect(firstForwardedIp('unknown')).toBeNull();
    expect(firstForwardedIp(',')).toBeNull();
  });
});

describe('IIS real client IP', () => {
  it('derives clientIp from X-Forwarded-For and moves the client IP role off c-ip', () => {
    const r = parseText(
      [
        fields('X-Forwarded-For'),
        '2026-10-27 04:42:02 GET / 10.0.0.4 203.0.113.7,+10.0.0.4 200',
        '2026-10-27 04:42:03 GET / 10.0.0.4 - 200',
        '2026-10-27 04:42:04 GET / 10.0.0.4 garbage 200',
      ].join('\n'),
    );
    expect(r.rows.map((x) => x.values.clientIp)).toEqual(['203.0.113.7', '10.0.0.4', '10.0.0.4']);
    expect(r.schema.find((c) => c.key === 'clientIp')).toMatchObject({ role: 'clientIp', derived: true });
    expect(r.schema.find((c) => c.key === 'c-ip')!.role).toBeUndefined();
    expect(r.schema.filter((c) => c.role === 'clientIp')).toHaveLength(1);
  });

  it('recognises cs(...) custom fields and prefers single-address headers', () => {
    const r = parseText(
      [fields('cs(X-Forwarded-For) cs(X-Azure-ClientIP)'), '2026-10-27 04:42:02 GET / 10.0.0.4 198.51.100.1 203.0.113.9 200'].join(
        '\n',
      ),
    );
    expect(r.rows[0]!.values.clientIp).toBe('203.0.113.9');
  });

  it('keeps c-ip as the client IP when no forwarded header is logged', () => {
    const r = parseText([fields(''), '2026-10-27 04:42:02 GET / 10.0.0.4 200'].join('\n'));
    expect(r.rows[0]!.values).not.toHaveProperty('clientIp');
    expect(r.schema.find((c) => c.key === 'c-ip')!.role).toBe('clientIp');
  });

  it('moves the role when a later #Fields block adds the header', () => {
    const r = parseText(
      [
        fields(''),
        '2026-10-27 04:42:02 GET / 10.0.0.4 200',
        fields('X-Forwarded-For'),
        '2026-10-27 04:42:03 GET / 10.0.0.4 203.0.113.7 200',
      ].join('\n'),
    );
    expect(r.schema.filter((c) => c.role === 'clientIp').map((c) => c.key)).toEqual(['clientIp']);
    expect(r.rows[1]!.values.clientIp).toBe('203.0.113.7');
  });

  it('health checks still use the proxy address in c-ip', () => {
    const r = parseText([fields('X-Forwarded-For'), '2026-10-27 04:42:02 GET / 127.0.0.1 203.0.113.7 200'].join('\n'));
    expect(r.rows[0]!.values.isHealthCheck).toBe(true);
  });
});
