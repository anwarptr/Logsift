/**
 * Synthetic IIS W3C log generator, used by the performance test and runnable as a CLI:
 *   node scripts/gen-iis.ts 500000 big-iis.log
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const FIELDS =
  'date time s-sitename cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) cs(Cookie) cs(Referer) cs-host sc-status sc-substatus sc-win32-status sc-bytes cs-bytes time-taken';

const METHODS = ['GET', 'GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE'];
const STEMS = ['/', '/api/products', '/api/products/123', '/api/users', '/health', '/api/reports/daily', '/login', '/static/app.js'];
const STATUSES = [200, 200, 200, 200, 200, 201, 204, 301, 304, 400, 401, 403, 404, 404, 500, 502, 503];
const UAS = ['-', 'AlwaysOn', 'Mozilla/5.0+(Windows+NT+10.0;+Win64;+x64)', 'curl/8.4.0', 'okhttp/4.12.0'];

/** Deterministic PRNG so runs are comparable. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number) => (n < 10 ? '0' : '') + n;
const hex = (rnd: () => number, n: number) => {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(rnd() * 16).toString(16);
  return s;
};

export function generateIisLog(lines: number, seed = 42): string {
  const rnd = mulberry32(seed);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const out: string[] = ['#Software: Microsoft Internet Information Services 10.0', `#Fields: ${FIELDS}`];
  let t = Date.UTC(2026, 9, 27, 0, 0, 0);
  for (let i = 0; i < lines; i++) {
    t += Math.floor(rnd() * 400);
    const d = new Date(t);
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    const scm = rnd() < 0.05;
    const ua = pick(UAS);
    const ip = ua === 'AlwaysOn' && rnd() < 0.5 ? '127.0.0.1' : `10.140.${Math.floor(rnd() * 4)}.${Math.floor(rnd() * 60)}`;
    const query = scm ? '-' : `X-ARR-LOG-ID=${hex(rnd, 8)}-${hex(rnd, 4)}-${hex(rnd, 4)}-${hex(rnd, 4)}-${hex(rnd, 12)}`;
    const slow = rnd() < 0.02;
    out.push(
      [
        date,
        time,
        (scm ? '~1' : '') + 'APP-SYNTH-PROD',
        pick(METHODS),
        pick(STEMS),
        query,
        scm ? 80 : 443,
        '-',
        ip,
        ua,
        '-',
        '-',
        'synthetic.example.com',
        pick(STATUSES),
        0,
        0,
        200 + Math.floor(rnd() * 20000),
        300 + Math.floor(rnd() * 900),
        slow ? 1000 + Math.floor(rnd() * 9000) : Math.floor(rnd() * 300),
      ].join(' '),
    );
  }
  return out.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = Number(process.argv[2] ?? 500_000);
  const file = process.argv[3] ?? 'synthetic-iis.log';
  const text = generateIisLog(n);
  writeFileSync(file, text);
  console.log(`Wrote ${n.toLocaleString()} lines (${(text.length / 1048576).toFixed(1)} MB) to ${file}`);
}
