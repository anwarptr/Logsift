// @ts-check
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

/**
 * The local server behind `npx logsift`: it serves the Logsift app and streams the log lines
 * received so far, then new ones as they arrive, to the browser. It listens on 127.0.0.1 only, the
 * stream needs a random token, and requests for any other host name are refused (DNS rebinding), so
 * other machines and other web sites can't read the log.
 */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Compare the token in constant time, so how long a wrong guess takes says nothing about how much of
 * it was right.
 * @param {string | null} given
 * @param {string} token
 */
function sameToken(given, token) {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Text kept for a browser that connects (or reloads) later; older text is dropped beyond this. */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * @param {{ appDir: string; token: string; port?: number; maxBytes?: number }} opts
 * @returns {Promise<{ port: number; push(chunk: Buffer): void; end(): void; close(): Promise<void>; readonly bytes: number; readonly dropped: number }>}
 */
export async function createLogServer({ appDir, token, port = 0, maxBytes = DEFAULT_MAX_BYTES }) {
  const root = resolve(appDir);
  /** @type {Buffer[]} */
  const chunks = [];
  let bytes = 0;
  let dropped = 0;
  let ended = false;
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  let actualPort = port;

  const server = createServer((req, res) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const common = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

    if (url.pathname === '/stream') {
      if (!sameToken(url.searchParams.get('token'), token)) {
        res.writeHead(403, common).end('Forbidden');
        return;
      }
      res.writeHead(200, { ...common, 'content-type': 'text/plain; charset=utf-8' });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      for (const c of chunks) res.write(c);
      if (ended) {
        res.end();
        return;
      }
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // The app's service worker would cache it per port; the launcher serves it fresh instead.
    if (url.pathname === '/sw.js') {
      res.writeHead(404, common).end();
      return;
    }

    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, common).end();
      return;
    }
    const file = resolve(join(root, rel === '/' ? 'index.html' : rel));
    if (!file.startsWith(root + sep)) {
      res.writeHead(403, common).end('Forbidden');
      return;
    }
    let stat;
    try {
      stat = statSync(file);
    } catch {
      stat = null;
    }
    if (!stat?.isFile()) {
      res.writeHead(404, common).end('Not found');
      return;
    }
    res.writeHead(200, {
      ...common,
      'content-type': TYPES[/** @type {keyof typeof TYPES} */ (extname(file).toLowerCase())] ?? 'application/octet-stream',
      'content-length': stat.size,
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  });

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok(undefined));
  });
  const addr = server.address();
  actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    port: actualPort,
    get bytes() {
      return bytes;
    },
    get dropped() {
      return dropped;
    },
    push(chunk) {
      if (ended || chunk.length === 0) return;
      chunks.push(chunk);
      bytes += chunk.length;
      // Keep the newest text within the limit (whole chunks; the browser already has the older ones).
      while (bytes > maxBytes && chunks.length > 1) {
        const old = /** @type {Buffer} */ (chunks.shift());
        bytes -= old.length;
        dropped += old.length;
      }
      for (const c of clients) c.write(chunk);
    },
    end() {
      ended = true;
      for (const c of clients) c.end();
      clients.clear();
    },
    close() {
      for (const c of clients) c.end();
      clients.clear();
      return new Promise((ok) => server.close(() => ok(undefined)));
    },
  };
}
