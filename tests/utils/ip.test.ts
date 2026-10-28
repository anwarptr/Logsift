import { describe, expect, it } from 'vitest';
import { classifyIp, ipLookupUrl } from '../../src/utils/ip';

describe('classifyIp', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['20.50.2.1', 'public'],
    ['10.20.0.12', 'private'],
    ['172.15.0.1', 'public'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.10', 'private'],
    ['127.0.0.1', 'loopback'],
    ['169.254.0.5', 'link-local'],
    ['100.63.0.1', 'public'],
    ['100.64.0.1', 'shared'],
    ['0.0.0.0', 'unspecified'],
  ])('IPv4 %s → %s', (ip, kind) => {
    expect(classifyIp(ip)).toBe(kind);
  });

  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fd00::1', 'private'],
    ['fc12:3456::1', 'private'],
    ['fe80::1c2:3', 'link-local'],
    ['2001:4860:4860::8888', 'public'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:8.8.8.8', 'public'],
  ])('IPv6 %s → %s', (ip, kind) => {
    expect(classifyIp(ip)).toBe(kind);
  });

  it('accepts brackets, ports and surrounding spaces', () => {
    expect(classifyIp('[::1]')).toBe('loopback');
    expect(classifyIp('[2001:db8::1]:443')).toBe('public');
    expect(classifyIp('8.8.8.8:443')).toBe('public');
    expect(classifyIp(' 10.0.0.1 ')).toBe('private');
  });

  it.each(['', '-', 'localhost', '256.1.1.1', '1.2.3', '1.2.3.4.5', 'abc', 'g::1'])('%j is invalid', (ip) => {
    expect(classifyIp(ip)).toBe('invalid');
  });
});

describe('ipLookupUrl', () => {
  it('builds an ipinfo.io link for the bare address', () => {
    expect(ipLookupUrl('8.8.8.8')).toBe('https://ipinfo.io/8.8.8.8');
    expect(ipLookupUrl(' 2001:4860::8888 ')).toBe('https://ipinfo.io/2001:4860::8888');
    expect(ipLookupUrl('[2001:db8::1]:443')).toBe('https://ipinfo.io/2001:db8::1');
    expect(ipLookupUrl('8.8.8.8:443')).toBe('https://ipinfo.io/8.8.8.8');
    expect(ipLookupUrl('a/b?c')).toBe('https://ipinfo.io/a%2Fb%3Fc');
  });
});
