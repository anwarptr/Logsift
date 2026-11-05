import type { LiveFileHandle } from './live/watcher';

/**
 * Demo logs for first-time visitors, made up on the spot (nothing is downloaded): a two-hour
 * ASP.NET Core / Serilog log of an online shop's API where payments start failing half an hour
 * before now, so the Compare tab has something to find; and a live version that keeps writing
 * lines, to show live tail without opening a folder.
 */

const MIN = 60_000;
/** History before "now" in the demo log. */
export const DEMO_HISTORY_MS = 120 * MIN;
/** The incident starts this long before "now". */
export const DEMO_INCIDENT_MS = 30 * MIN;

/** Small deterministic PRNG (mulberry32), so the demo looks the same each time. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "2026-11-05 10:57:59.762 +04:00" in the browser's local time, as Serilog writes it. */
export function serilogTime(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const GUIDS = ['7d3f1c2a-5b8e-4f6a-9c1d-2e4b6a8c0f13', 'a1b2c3d4-0000-4e5f-8a9b-112233445566', '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9'];

/** Lines for one moment of the demo log; `incident` once payments are failing. */
function linesAt(ms: number, rand: () => number, incident: boolean, order: { n: number }): string[] {
  const t = serilogTime(ms);
  const req = (method: string, path: string, status: number, durMs: number) =>
    `${t} [INF] HTTP ${method} ${path} responded ${status} in ${durMs.toFixed(4)} ms`;
  const r = rand();
  if (r < 0.3) return [req('GET', '/api/products', 200, 20 + rand() * 60)];
  if (r < 0.45) return [req('GET', `/api/products/${GUIDS[Math.floor(rand() * GUIDS.length)]}`, rand() < 0.04 ? 404 : 200, 10 + rand() * 40)];
  if (r < 0.55) return [req(rand() < 0.5 ? 'GET' : 'POST', '/api/cart', 200, 15 + rand() * 30)];
  if (r < 0.62) return [req('GET', '/health', 200, 0.5 + rand())];
  if (r < 0.66) return [`${t} [INF] Order ${1000 + order.n} shipped`];
  // POST /api/payments: fine before the incident; mostly timing out during it.
  order.n++;
  if (!incident) return [req('POST', '/api/payments', rand() < 0.01 ? 500 : 201, 60 + rand() * 120)];
  if (rand() < 0.55) {
    const wait = 2500 + rand() * 1000;
    return [
      `${t} [ERR] Payment gateway timeout after ${Math.round(wait)} ms (order ${1000 + order.n})`,
      req('POST', '/api/payments', 504, wait + 15),
    ];
  }
  if (rand() < 0.3) return [`${t} [WRN] Retrying payment for order ${1000 + order.n} (attempt 2)`, req('POST', '/api/payments', 201, 900 + rand() * 600)];
  return [req('POST', '/api/payments', 201, 300 + rand() * 400)];
}

/** The demo log from two hours before `now` up to `now`, with the incident in its last half hour. */
export function generateIncidentLog(now: number, seed = 7): string {
  const rand = rng(seed);
  const order = { n: 0 };
  const start = now - DEMO_HISTORY_MS;
  const lines = [`${serilogTime(start)} [INF] Now listening on: https://localhost:5001`, `${serilogTime(start + 20)} [INF] Application started.`];
  for (let ms = start + 1000; ms <= now; ms += 2500 + rand() * 5000) {
    lines.push(...linesAt(ms, rand, ms >= now - DEMO_INCIDENT_MS, order));
  }
  return lines.join('\r\n') + '\r\n';
}

export const DEMO_FILE = 'payments-api.log';

/**
 * A log "file" kept in memory that keeps growing: the demo history, then a few lines every second or
 * two, still during the incident. It looks like a file handle, so live tail reads it like a real
 * file. `stop()` ends the writing.
 */
export function createLiveDemo(now = Date.now()): { handle: LiveFileHandle; stop(): void } {
  let content = generateIncidentLog(now);
  let modified = now;
  const rand = rng(99);
  const order = { n: 500 };
  const timer = setInterval(() => {
    const t = Date.now();
    const lines = linesAt(t, rand, true, order);
    if (rand() < 0.5) lines.push(...linesAt(t + 300, rand, true, order));
    content += lines.join('\r\n') + '\r\n';
    modified = t;
  }, 1500);
  const handle: LiveFileHandle = {
    kind: 'file',
    name: DEMO_FILE,
    getFile: async () => new File([content], DEMO_FILE, { lastModified: modified }),
  };
  return { handle, stop: () => clearInterval(timer) };
}
