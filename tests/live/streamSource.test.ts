import { describe, expect, it } from 'vitest';
import { openStream, streamParams } from '../../src/live/streamSource';

const TOKEN = 'ab'.repeat(24);

/** A fetch that answers with a stream the test writes to. */
function fakeFetch() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  const enc = new TextEncoder();
  return {
    fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
    write: (s: string) => ctl.enqueue(enc.encode(s)),
    close: () => ctl.close(),
    fail: () => ctl.error(new Error('connection reset')),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('streamParams', () => {
  it('accepts the launcher address only', () => {
    const search = `?stream=${encodeURIComponent(`/stream?token=${TOKEN}`)}&name=${encodeURIComponent('my-api (App Service)')}`;
    expect(streamParams({ hostname: '127.0.0.1', search })).toEqual({ path: `/stream?token=${TOKEN}`, fileName: 'my-api (App Service).log' });
    expect(streamParams({ hostname: 'localhost', search })).not.toBeNull();
    // Not on the public site, and only the server's own /stream path.
    expect(streamParams({ hostname: 'logsift.ayzo.app', search })).toBeNull();
    expect(streamParams({ hostname: '127.0.0.1', search: '?stream=https://evil.example/x' })).toBeNull();
    expect(streamParams({ hostname: '127.0.0.1', search: '?stream=//evil.example/stream?token=abababababababab' })).toBeNull();
    expect(streamParams({ hostname: '127.0.0.1', search: '' })).toBeNull();
  });

  it('makes a safe file name', () => {
    const p = streamParams({ hostname: '127.0.0.1', search: `?stream=${encodeURIComponent(`/stream?token=${TOKEN}`)}&name=a/b:c` });
    expect(p!.fileName).toBe('a-b-c.log');
    expect(streamParams({ hostname: '127.0.0.1', search: `?stream=${encodeURIComponent(`/stream?token=${TOKEN}`)}` })!.fileName).toBe('stream.log');
  });
});

describe('openStream', () => {
  it('collects the stream behind a growing file', async () => {
    const f = fakeFetch();
    const s = openStream(`/stream?token=${TOKEN}`, 'api.log', f.fetch);
    expect(s.state).toBe('waiting');
    f.write('line 1\n');
    await s.firstData;
    expect(s.state).toBe('streaming');
    expect(await (await s.handle.getFile()).text()).toBe('line 1\n');
    f.write('line 2\n');
    await tick();
    const file = await s.handle.getFile();
    expect(await file.text()).toBe('line 1\nline 2\n');
    expect(file.name).toBe('api.log');
    const ends: string[] = [];
    s.onEnd((state) => ends.push(state));
    f.close();
    await tick();
    expect(s.state).toBe('ended');
    expect(ends).toEqual(['ended']);
  });

  it('reports a failed connection', async () => {
    const f = fakeFetch();
    const s = openStream(`/stream?token=${TOKEN}`, 'api.log', f.fetch);
    const ends: [string, string | undefined][] = [];
    s.onEnd((state, err) => ends.push([state, err]));
    f.write('x\n');
    await s.firstData;
    f.fail();
    await tick();
    expect(ends).toEqual([['failed', 'connection reset']]);
  });

  it('reports an error answer before any data', async () => {
    const s = openStream(`/stream?token=${TOKEN}`, 'api.log', (async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch);
    await s.firstData;
    expect(s.state).toBe('failed');
    expect(s.bytes).toBe(0);
  });
});
