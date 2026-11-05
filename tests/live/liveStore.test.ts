import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogFormat } from '../../src/parser';
import type { WorkerResponse } from '../../src/worker/protocol';
import type { LiveSession, LogSource } from '../../src/worker/streamParse';
import { FakeDir, FakeFile } from './fakeFs';

// Run the worker's work in-process: a parse keeps its live session, appends go to it.
vi.mock('../../src/worker/client', () => {
  let handler: ((m: WorkerResponse) => void) | null = null;
  let session: LiveSession | null = null;
  return {
    startParse: (
      sources: LogSource[],
      format: LogFormat | undefined,
      pattern: string | undefined,
      onMessage: (m: WorkerResponse) => void,
      live?: { multi: boolean },
    ) => {
      handler = onMessage;
      void (async () => {
        const { streamParseSources } = await import('../../src/worker/streamParse');
        const summary = await streamParseSources(sources, {
          format,
          pattern,
          live: live !== undefined,
          multi: live?.multi,
          onStart: (fmt, detected, files) => onMessage({ type: 'start', jobId: 1, format: fmt, detected, files }),
          onBatch: (batch) => onMessage({ type: 'batch', jobId: 1, ...batch }),
        });
        session = summary.session ?? null;
        onMessage({ type: 'done', jobId: 1, lines: summary.lines, elapsedMs: 1, timeZone: summary.timeZone, held: summary.held });
      })();
    },
    appendLive: (name: string, blob: Blob, modified: number, final = false) => {
      void (async () => {
        const { appendToSession } = await import('../../src/worker/streamParse');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const r = appendToSession(session!, name, bytes, modified, (b) => handler?.({ type: 'batch', jobId: 1, ...b }), final);
        handler?.({ type: 'appended', jobId: 1, name, consumed: r.consumed, timeZone: r.timeZone });
      })();
    },
  };
});

const line = (sec: number, level: string, msg: string) => `2026-10-27 04:42:${String(sec).padStart(2, '0')} ${level} ${msg}\n`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(async () => {
  const { useLogStore } = await import('../../src/store/logStore');
  useLogStore.getState().stopLive();
  vi.useRealTimers();
});

async function openFolder(dir: FakeDir) {
  const { useLogStore } = await import('../../src/store/logStore');
  await useLogStore.getState().openFolder(dir);
  await vi.waitFor(() => expect(useLogStore.getState().status).toBe('ready'));
  return useLogStore;
}

describe('live folder', () => {
  it('opens a folder, then adds lines written to its files and new files, in time order', async () => {
    const dir = new FakeDir('logs');
    const a = dir.add(new FakeFile('a.log', line(1, 'INFO', 'a1') + line(5, 'INFO', 'a2')));
    const store = await openFolder(dir);
    expect(store.getState().live).toMatchObject({ kind: 'folder', label: 'logs', files: 1, following: true, paused: false });
    expect(store.getState().file?.name).toBe('logs/ (1 file)');
    expect(store.getState().rows.map((r) => r.values.message)).toEqual(['a1', 'a2']);
    expect(store.getState().schema.some((c) => c.key === 'sourceFile')).toBe(true);

    a.append(line(7, 'ERROR', 'a3'));
    dir.add(new FakeFile('b.log', line(3, 'WARN', 'b1')));
    await vi.advanceTimersByTimeAsync(2200);
    await vi.waitFor(() => expect(store.getState().rows).toHaveLength(4));
    const s = store.getState();
    expect(s.rows.map((r) => r.values.message)).toEqual(['a1', 'b1', 'a2', 'a3']);
    expect(s.rows.map((r) => r.id)).toEqual([0, 1, 2, 3]);
    expect(s.live).toMatchObject({ files: 2, newRows: 2 });
    expect(s.live!.updatedAt).not.toBeNull();
  });

  it('keeps an unfinished line until it is complete', async () => {
    const dir = new FakeDir('logs');
    const a = dir.add(new FakeFile('a.log', line(1, 'INFO', 'a1') + '2026-10-27 04:42:02 ERR'));
    const store = await openFolder(dir);
    expect(store.getState().rows).toHaveLength(1);
    a.append('OR finished\n');
    await vi.advanceTimersByTimeAsync(2200);
    await vi.waitFor(() => expect(store.getState().rows).toHaveLength(2));
    expect(store.getState().rows[1]!.values).toMatchObject({ level: 'ERROR', message: 'finished' });
  });

  it('pauses, resumes and stops', async () => {
    const dir = new FakeDir('logs');
    const a = dir.add(new FakeFile('a.log', line(1, 'INFO', 'a1')));
    const store = await openFolder(dir);
    store.getState().setLivePaused(true);
    a.append(line(2, 'INFO', 'a2'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.getState().rows).toHaveLength(1);
    store.getState().setLivePaused(false);
    await vi.advanceTimersByTimeAsync(2200);
    await vi.waitFor(() => expect(store.getState().rows).toHaveLength(2));

    store.getState().stopLive();
    expect(store.getState().live).toBeNull();
    a.append(line(3, 'INFO', 'a3'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.getState().rows).toHaveLength(2);
  });

  it('keeps watching after the format is changed', async () => {
    const dir = new FakeDir('logs');
    const a = dir.add(new FakeFile('a.log', line(1, 'INFO', 'a1')));
    const store = await openFolder(dir);
    store.getState().setFormatOverride('generic');
    await vi.waitFor(() => expect(store.getState().status).toBe('ready'));
    expect(store.getState().live).not.toBeNull();
    a.append(line(2, 'INFO', 'a2'));
    await vi.advanceTimersByTimeAsync(2200);
    await vi.waitFor(() => expect(store.getState().rows).toHaveLength(2));
  });

  it('stops watching when other files are opened', async () => {
    const dir = new FakeDir('logs');
    dir.add(new FakeFile('a.log', line(1, 'INFO', 'a1')));
    const store = await openFolder(dir);
    store.getState().loadText(line(1, 'INFO', 'pasted'));
    expect(store.getState().live).toBeNull();
  });

  it('explains an empty folder', async () => {
    const { useLogStore } = await import('../../src/store/logStore');
    const dir = new FakeDir('empty');
    dir.add(new FakeFile('notes.md', 'hi'));
    dir.add(new FakeFile('blank.log', ''));
    await useLogStore.getState().openFolder(dir);
    expect(useLogStore.getState().error).toMatch(/has no log files/);
  });
});
