/** What kind of address an IP is. Only 'public' addresses have useful details (country, owner) to look up. */
export type IpKind = 'public' | 'private' | 'loopback' | 'link-local' | 'shared' | 'unspecified' | 'invalid';

export const IP_KIND_LABELS: Record<Exclude<IpKind, 'public' | 'invalid'>, string> = {
  private: 'Private network',
  loopback: 'Loopback',
  'link-local': 'Link-local',
  shared: 'Carrier-grade NAT',
  unspecified: 'Unspecified',
};

function parseIpv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = +p;
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function classifyIpv4([a, b]: number[]): IpKind {
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 100 && b! >= 64 && b! <= 127) return 'shared';
  return 'public';
}

/** Strips surrounding spaces, IPv6 brackets and a port: "[::1]:443" → "::1", "1.2.3.4:443" → "1.2.3.4". */
export function normalizeIp(input: string): string {
  const s = input.trim();
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return end > 0 ? s.slice(1, end) : s.slice(1);
  }
  return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s) ? s.slice(0, s.lastIndexOf(':')) : s;
}

/** Classifies an IPv4 or IPv6 address (offline, from the reserved ranges). Accepts "[::1]" and "1.2.3.4:443". */
export function classifyIp(input: string): IpKind {
  const s = normalizeIp(input);
  const v4 = parseIpv4(s);
  if (v4) return classifyIpv4(v4);

  if (!s.includes(':') || !/^[0-9a-f:.]+$/i.test(s)) return 'invalid';
  const lower = s.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) {
    const m = parseIpv4(mapped[1]!);
    return m ? classifyIpv4(m) : 'invalid';
  }
  if (lower === '::') return 'unspecified';
  if (lower === '::1') return 'loopback';
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  return 'public';
}

/** External page with details (country, ASN/owner) for a public IP. Opened only when the user clicks. */
export function ipLookupUrl(ip: string): string {
  const s = normalizeIp(ip);
  // Valid addresses contain only URL-safe characters; encode anything else defensively.
  return `https://ipinfo.io/${/^[0-9a-f:.]+$/i.test(s) ? s : encodeURIComponent(s)}`;
}
