import { describe, expect, it } from 'vitest';
import {
  cleanKuduPath,
  getKuduFilterFn,
  isEventLogName,
  isIisLogName,
  isKuduLogFolder,
  isKuduLogPath,
  KUDU_ORIGIN_RE,
  KuduBridge,
  KuduDirHandle,
} from '../../src/live/kudu';
import { kuduBookmarklet, kuduScript } from '../../src/live/kuduBookmarklet';
import { listFolder, LiveWatcher } from '../../src/live/watcher';

const LOGSIFT = 'https://logsift.ayzo.app';
const KUDU = 'https://shop-api.scm.azurewebsites.net';

type Listener = (e: { source: unknown; origin: string; data: unknown }) => void;

/**
 * Two "tabs" in memory: the Kudu tab runs the real bookmarklet script, with a fake Kudu VFS behind
 * fetch; the Logsift tab gets a real KuduBridge. Messages go between them as postMessage would deliver
 * them (with the sender's origin and window).
 */
function twoTabs(files: Record<string, string>, opts: { range?: boolean; host?: string } = {}) {
  const kuduListeners: Listener[] = [];
  const logsiftListeners: Listener[] = [];
  const alerts: string[] = [];
  const fetched: { url: string; range?: string }[] = [];
  const now = Date.UTC(2026, 10, 5, 12);

  const kuduWindow: Record<string, unknown> = {};
  const logsiftWindow = {
    closed: false,
    focus() {},
    // Kudu → Logsift
    postMessage(data: unknown, target: string) {
      if (target !== LOGSIFT) return;
      const copy = data instanceof Object ? structuredClone(data) : data;
      queueMicrotask(() => logsiftListeners.forEach((l) => l({ source: opener, origin: KUDU, data: copy })));
    },
  };
  // What Logsift sees as window.opener: messages go to the Kudu tab.
  const opener = {
    closed: false,
    postMessage(data: unknown) {
      const copy = structuredClone(data);
      queueMicrotask(() => kuduListeners.forEach((l) => l({ source: logsiftWindow, origin: LOGSIFT, data: copy })));
    },
  };
  let openedUrl: string | null = null;
  Object.assign(kuduWindow, {
    open: (url: string) => {
      openedUrl = url;
      return logsiftWindow;
    },
    addEventListener: (type: string, l: Listener) => type === 'message' && kuduListeners.push(l),
  });

  const enc = new TextEncoder();
  const vfs = async (url: string, init?: { headers?: Record<string, string> }) => {
    const range = init?.headers?.Range;
    fetched.push({ url, range });
    const path = decodeURIComponent(url.replace(/^\/api\/vfs\//, ''));
    if (path.endsWith('/')) {
      const dir = path.slice(0, -1);
      const names = new Map<string, boolean>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(dir + '/')) continue;
        const rest = p.slice(dir.length + 1);
        const [first, ...more] = rest.split('/');
        names.set(first!, more.length > 0);
      }
      if (names.size === 0) return new Response('not found', { status: 404 });
      const list = [...names].map(([name, isDir]) => ({
        name,
        size: isDir ? 0 : enc.encode(files[`${dir}/${name}`]!).length,
        mtime: new Date(now).toISOString().replace('Z', '1234+00:00'),
        mime: isDir ? 'inode/directory' : 'text/plain',
      }));
      return new Response(JSON.stringify(list), { status: 200 });
    }
    const text = files[path];
    if (text === undefined) return new Response('not found', { status: 404 });
    const bytes = enc.encode(text);
    const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    if (m && opts.range !== false) return new Response(bytes.slice(+m[1]!, +m[2]! + 1), { status: 206 });
    return new Response(bytes, { status: 200 });
  };

  const run = () =>
    new Function('window', 'location', 'fetch', 'document', 'alert', kuduScript(LOGSIFT))(
      kuduWindow,
      { hostname: opts.host ?? 'shop-api.scm.azurewebsites.net' },
      vfs,
      { createElement: () => ({ style: {} }), body: { appendChild() {} } },
      (msg: string) => alerts.push(msg),
    );

  const logsift = {
    addEventListener: (type: string, l: Listener) => type === 'message' && logsiftListeners.push(l),
    removeEventListener: () => {},
  };
  return { run, alerts, fetched, opener, logsift, openedUrl: () => openedUrl, files, now };
}

describe('Kudu bookmarklet', () => {
  it('is a javascript: link with the script', () => {
    const link = kuduBookmarklet(LOGSIFT);
    expect(link.startsWith('javascript:')).toBe(true);
    expect(() => new Function(decodeURIComponent(link.slice('javascript:'.length)))).not.toThrow();
  });

  it('only runs on a Kudu site', () => {
    const t = twoTabs({}, { host: 'portal.azure.com' });
    t.run();
    expect(t.alerts[0]).toMatch(/Kudu site/);
    expect(t.openedUrl()).toBeNull();
  });

  it('opens Logsift and lists and reads files for it', async () => {
    const line = '2026-11-05 10:00:00.000 +00:00 [INF] started\n';
    const t = twoTabs({
      'LogFiles/Application/app-20261105.txt': line,
      'LogFiles/Application/sub/older.txt': 'x\n',
    });
    t.run();
    expect(t.openedUrl()).toBe(`${LOGSIFT}/?source=kudu&app=shop-api`);
    const bridge = new KuduBridge(t.opener, t.logsift as unknown as Window);
    expect(await bridge.connect(2000)).toBe(true);
    expect(bridge.app).toBe('shop-api');
    expect(bridge.origin).toBe(KUDU);

    const entries = await bridge.list('LogFiles/Application');
    expect(entries).toEqual([
      { name: 'app-20261105.txt', size: line.length, mtime: t.now, dir: false },
      { name: 'sub', size: 0, mtime: t.now, dir: true },
    ]);
    const at = line.indexOf('[INF]');
    const part = new TextDecoder().decode(await bridge.read('LogFiles/Application/app-20261105.txt', at, line.length));
    expect(part).toBe('[INF] started\n');
    expect(t.fetched.at(-1)).toEqual({ url: '/api/vfs/LogFiles/Application/app-20261105.txt', range: `bytes=${at}-${line.length - 1}` });
  });

  it('reads the right part when Kudu ignores the Range header', async () => {
    const t = twoTabs({ 'LogFiles/a.log': 'hello world\n' }, { range: false });
    t.run();
    const bridge = new KuduBridge(t.opener, t.logsift as unknown as Window);
    await bridge.connect(2000);
    expect(new TextDecoder().decode(await bridge.read('LogFiles/a.log', 6, 11))).toBe('world');
  });

  it('refuses paths outside the site and reports Kudu errors', async () => {
    const t = twoTabs({ 'LogFiles/a.log': 'x\n' });
    t.run();
    const bridge = new KuduBridge(t.opener, t.logsift as unknown as Window);
    await bridge.connect(2000);
    await expect(bridge.list('../../etc')).rejects.toThrow(/bad path/);
    await expect(bridge.list('LogFiles/missing')).rejects.toThrow(/Kudu answered 404/);
    expect(t.fetched.some((f) => f.url.includes('..'))).toBe(false);
  });

  it('ignores messages from other windows or sites', async () => {
    const t = twoTabs({ 'LogFiles/a.log': 'x\n' });
    t.run();
    const listeners: ((e: unknown) => void)[] = [];
    const win = { addEventListener: (_: string, l: (e: unknown) => void) => listeners.push(l), removeEventListener() {} };
    const bridge = new KuduBridge({ postMessage() {} }, win as unknown as Window);
    const connecting = bridge.connect(300);
    // A hello from another site, or from a window that isn't the opener, is not taken.
    listeners.forEach((l) => l({ source: {}, origin: KUDU, data: { type: 'logsift-hello', app: 'x' } }));
    listeners.forEach((l) => l({ source: undefined, origin: 'https://evil.example', data: { type: 'logsift-hello' } }));
    expect(await connecting).toBe(false);
  });
});

describe('Kudu bookmarklet reads log files only', () => {
  const PATHS: [path: string, isLog: boolean][] = [
    ['site/wwwroot/Logs/log-20261105.log', true],
    ['site/wwwroot/Logs/log-20261105.json', true],
    ['site/wwwroot/App_Data/logs/app.txt', true],
    ['LogFiles/http/RawLogs/u_ex261105.log', true],
    ['LogFiles/eventlog.xml', true],
    ['LogFiles/Application/diag.txt', true],
    ['LogFiles/kudu/trace/2026-10-01T07-06-30_0efc6b_001_Startup_GET__0s.xml', false],
    ['LogFiles/Git/trace.log', false],
    ['LogFiles/CrashDumps/w3wp_2740_2025-06-03T09_09_50.log', false],
    ['LogFiles/crashdump/w3wp.log', false],
    ['LogFiles/DetailedErrors/ErrorPage.htm', false],
    ['site/wwwroot/Logs/catalina.out', true],
    ['site/wwwroot/Logs/error.err', true],
    ['site/wwwroot/Logs/trace.log.1', true],
    ['site/wwwroot/Logs/app.out.bak', true],
    ['site/wwwroot/appsettings.json', false],
    ['site/wwwroot/appsettings.Production.json', false],
    ['site/wwwroot/web.config', false],
    ['site/wwwroot/Logs/web.config', false],
    ['site/wwwroot/Logs/appsettings.json', false],
    ['site/wwwroot/Logs/secrets.txt', false],
    ['site/wwwroot/Logs/.env', false],
    ['site/wwwroot/data.json', false],
    ['site/wwwroot/logo.png', false],
    ['site/wwwroot/Logs/app.dll', false],
    ['LogFiles/../site/wwwroot/appsettings.json', false],
    // Found in the security review: folders that only contain "log", key files, dot-and-space segments.
    ['site/wwwroot/app-logs/2026.log', true],
    ['site/wwwroot/App_Log/trace.txt', true],
    ['site/wwwroot/blog/serviceAccount.json', false],
    ['site/wwwroot/catalog/db-export.csv', false],
    ['site/wwwroot/node_modules/winston-logger/package.json', false],
    ['site/wwwroot/Logging/config.json', false],
    ['site/wwwroot/Logs/keys.json', false],
    ['site/wwwroot/Logs/api-key.txt', false],
    ['site/wwwroot/Logs/connection-strings.json', false],
    ['site/wwwroot/Logs/local.settings.json', false],
    ['LogFiles/.. /site/wwwroot/local.settings.json', false],
    ['LogFiles/... /site/wwwroot/firebase.json', false],
    ['LogFiles/./Application/diag.txt', false],
    ['site/wwwroot/Logs/monkeys.log', true],
  ];

  const FOLDERS: [path: string, listable: boolean][] = [
    ['LogFiles', true],
    ['LogFiles/http/RawLogs', true],
    ['site/wwwroot/Logs', true],
    ['site/wwwroot/RawLogs', true],
    ['site/wwwroot/App_Data/logs/2026', true],
    ['', false],
    ['site/wwwroot', false],
    ['site/wwwroot/blog', false],
    ['data/Functions/secrets', false],
    ['LogFiles/.. /site/wwwroot', false],
  ];

  it.each(FOLDERS)('lists %s → %s', async (path, listable) => {
    expect(isKuduLogFolder(path)).toBe(listable);
    const t = twoTabs({ [`${path}/a.log`]: 'x\n' });
    t.run();
    const bridge = new KuduBridge(t.opener, t.logsift as unknown as Window);
    await bridge.connect(2000);
    const list = bridge.list(path);
    if (listable) await expect(list).resolves.toBeInstanceOf(Array);
    else {
      await expect(list).rejects.toThrow(/not a log folder|bad path/);
      expect(t.fetched).toEqual([]);
    }
  });

  it.each(PATHS)('%s → %s', async (path, isLog) => {
    expect(isKuduLogPath(path)).toBe(isLog);
    const t = twoTabs({ [path]: 'content\n' });
    t.run();
    const bridge = new KuduBridge(t.opener, t.logsift as unknown as Window);
    await bridge.connect(2000);
    const read = bridge.read(path, 0, 8);
    if (isLog) expect(new TextDecoder().decode(await read)).toBe('content\n');
    else await expect(read).rejects.toThrow(/not a log file|bad path/);
    // A refused read never reaches Kudu.
    if (!isLog) expect(t.fetched.filter((f) => !f.url.endsWith('/'))).toEqual([]);
  });

  it('hides files that are not logs from folder listings', async () => {
    const t = twoTabs({
      'site/wwwroot/Logs/log-20261105.log': 'one\n',
      'site/wwwroot/Logs/appsettings.json': '{"ConnectionStrings":{}}',
    });
    t.run();
    const bridge = new KuduBridge(t.opener, t.logsift as unknown as Window);
    await bridge.connect(2000);
    const entries = await listFolder(new KuduDirHandle(bridge, 'site/wwwroot/Logs'), () => true);
    expect(entries.map((e) => e.path)).toEqual(['log-20261105.log']);
  });
});

describe('Kudu folders in live tail', () => {
  it('lists, opens and follows a growing file through the bridge', async () => {
    const t = twoTabs({
      'site/wwwroot/Logs/log-20261105.log': 'one\n',
      'site/wwwroot/Logs/readme.md': 'not a log',
    });
    t.run();
    const bridge = new KuduBridge(t.opener, t.logsift as unknown as Window);
    await bridge.connect(2000);
    const dir = new KuduDirHandle(bridge, 'site/wwwroot/Logs', 'shop-api: site/wwwroot/Logs');
    const entries = await listFolder(dir, (n) => n.endsWith('.log'));
    expect(entries.map((e) => e.path)).toEqual(['log-20261105.log']);
    const file = await entries[0]!.handle.getFile();
    expect(file.size).toBe(4);
    expect(new TextDecoder().decode(await file.arrayBuffer())).toBe('one\n');

    const sent: string[] = [];
    const w = new LiveWatcher({
      dir: null,
      targets: [{ path: 'log-20261105.log', handle: entries[0]!.handle, offset: 4, lastSize: 4 }],
      accept: () => true,
      delayMs: () => 1_000_000,
      send: async (_p, blob) => {
        sent.push(await blob.text());
        return blob.size;
      },
      onCheck: () => {},
    });
    w.start();
    t.files['site/wwwroot/Logs/log-20261105.log'] += 'two\n';
    await new Promise((r) => setTimeout(r, 2100)); // past the listing cache
    await w.check();
    expect(sent).toEqual(['two\n']);
    w.stop();
  });
});

describe('Kudu paths', () => {
  it('cleans typed folder paths', () => {
    expect(cleanKuduPath(' \\site\\wwwroot\\Logs\\ ')).toBe('site/wwwroot/Logs');
    expect(cleanKuduPath('LogFiles//Application/')).toBe('LogFiles/Application');
    expect(cleanKuduPath('http/RawLogs')).toBe('LogFiles/http/RawLogs');
    expect(cleanKuduPath('RawLogs')).toBe('LogFiles/http/RawLogs');
    expect(cleanKuduPath('Application')).toBe('LogFiles/Application');
    expect(cleanKuduPath('../secrets')).toBeNull();
    expect(cleanKuduPath('a/<script>')).toBeNull();
  });

  it('recognises Kudu sites', () => {
    expect(KUDU_ORIGIN_RE.test('https://shop-api.scm.azurewebsites.net')).toBe(true);
    expect(KUDU_ORIGIN_RE.test('https://shop-api-a1b2.scm.westeurope-01.azurewebsites.net')).toBe(true);
    expect(KUDU_ORIGIN_RE.test('https://shop-api.azurewebsites.net')).toBe(false);
    expect(KUDU_ORIGIN_RE.test('https://evil.example/scm.azurewebsites.net')).toBe(false);
    expect(KUDU_ORIGIN_RE.test('http://shop-api.scm.azurewebsites.net')).toBe(false);
  });
});

describe('Kudu log filters (handling eventlog)', () => {
  const dummyAccept = (n: string) => n.endsWith('.log') || n.endsWith('.txt') || n.endsWith('.xml') || n.endsWith('.json');

  it('detects eventlog file names', () => {
    expect(isEventLogName('eventlog.xml')).toBe(true);
    expect(isEventLogName('eventlog_20261108.xml')).toBe(true);
    expect(isEventLogName('app-eventlog.log')).toBe(true);
    expect(isEventLogName('app.log')).toBe(false);
    expect(isEventLogName('u_ex261108.log')).toBe(false);
  });

  it('detects IIS log file names', () => {
    expect(isIisLogName('u_ex261108.log')).toBe(true);
    expect(isIisLogName('W3SVC1/u_ex261108.log')).toBe(true);
    expect(isIisLogName('app.log')).toBe(false);
    expect(isIisLogName('eventlog.xml')).toBe(false);
  });

  it('filters out eventlog.xml when no-eventlog is selected', () => {
    const fn = getKuduFilterFn('no-eventlog', dummyAccept);
    expect(fn('eventlog.xml')).toBe(false);
    expect(fn('u_ex261108.log')).toBe(true);
    expect(fn('diag.txt')).toBe(true);
  });

  it('filters by app-only, iis-only, and eventlog-only', () => {
    const appFn = getKuduFilterFn('app-only', dummyAccept);
    expect(appFn('diag.txt')).toBe(true);
    expect(appFn('u_ex261108.log')).toBe(false);
    expect(appFn('eventlog.xml')).toBe(false);

    const iisFn = getKuduFilterFn('iis-only', dummyAccept);
    expect(iisFn('u_ex261108.log')).toBe(true);
    expect(iisFn('diag.txt')).toBe(false);
    expect(iisFn('eventlog.xml')).toBe(false);

    const evtFn = getKuduFilterFn('eventlog-only', dummyAccept);
    expect(evtFn('eventlog.xml')).toBe(true);
    expect(evtFn('u_ex261108.log')).toBe(false);
    expect(evtFn('diag.txt')).toBe(false);
  });
});
