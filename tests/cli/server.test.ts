import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../../cli/lib/args.mjs';
import { createLogServer, type LogServer } from '../../cli/lib/server.mjs';

const TOKEN = 'ab'.repeat(24);
let dir: string;
let server: LogServer;
const base = () => `http://127.0.0.1:${server.port}`;

/** A raw request, to send a Host header that fetch won't let us set. */
function get(path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'logsift-cli-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Logsift</title>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'sw.js'), 'self.x = 1');
  writeFileSync(join(tmpdir(), 'logsift-secret.txt'), 'secret');
  server = await createLogServer({ appDir: dir, token: TOKEN, maxBytes: 1000 });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('logsift launcher server', () => {
  it('serves the app on 127.0.0.1', async () => {
    const page = await fetch(`${base()}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<title>Logsift</title>');
    const js = await fetch(`${base()}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect((await fetch(`${base()}/missing.js`)).status).toBe(404);
  });

  it('does not serve the service worker, files outside the app, or other host names', async () => {
    expect((await fetch(`${base()}/sw.js`)).status).toBe(404);
    expect((await get('/..%2Flogsift-secret.txt', `127.0.0.1:${server.port}`)).status).toBe(403);
    expect((await get('/', `evil.example:${server.port}`)).status).toBe(403);
    expect((await get('/', `localhost:${server.port}`)).status).toBe(200);
    expect((await fetch(`${base()}/`, { method: 'POST' })).status).toBe(405);
  });

  it('needs the token for the stream', async () => {
    expect((await fetch(`${base()}/stream`)).status).toBe(403);
    expect((await fetch(`${base()}/stream?token=wrong`)).status).toBe(403);
  });

  it('streams what arrived before the page connected, then new lines, then the end', async () => {
    server.push(Buffer.from('line 1\n'));
    const res = await fetch(`${base()}/stream?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    server.push(Buffer.from('line 2\n'));
    while (!text.includes('line 2')) text += decoder.decode((await reader.read()).value);
    server.end();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toBe('line 1\nline 2\n');
    // A page that connects after the end gets everything at once.
    expect(await (await fetch(`${base()}/stream?token=${TOKEN}`)).text()).toBe('line 1\nline 2\n');
  });

  it('keeps only the newest text within the limit', async () => {
    const s = await createLogServer({ appDir: dir, token: TOKEN, maxBytes: 10 });
    try {
      s.push(Buffer.from('aaaaaa\n'));
      s.push(Buffer.from('bbbbbb\n'));
      s.end();
      expect(s.dropped).toBe(7);
      expect(await (await fetch(`http://127.0.0.1:${s.port}/stream?token=${TOKEN}`)).text()).toBe('bbbbbb\n');
    } finally {
      await s.close();
    }
  });
});

describe('logsift options', () => {
  it('reads the Azure App Service options', () => {
    expect(parseArgs(['--azure', 'my-api', '-g', 'my-rg', '--slot', 'staging', '--no-open'])).toMatchObject({
      azure: 'my-api',
      group: 'my-rg',
      slot: 'staging',
      open: false,
    });
    expect(parseArgs([])).toMatchObject({ open: true, help: false });
    expect(parseArgs(['--port', '5050', '--name', 'api logs']).port).toBe(5050);
  });

  it('explains bad options and refuses names that a shell could run', () => {
    expect(() => parseArgs(['--azure', 'my-api'])).toThrow(/resource group/);
    expect(() => parseArgs(['--azure'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--port', 'x'])).toThrow(/--port/);
    expect(() => parseArgs(['--what'])).toThrow(/Unknown option/);
    expect(() => parseArgs(['--azure', 'api&calc', '-g', 'rg'])).toThrow(/not a valid name/);
    expect(() => parseArgs(['--azure', 'api', '-g', 'rg|whoami'])).toThrow(/not a valid name/);
  });
});
