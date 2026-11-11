import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canOpenFilesWithHandles, pickFilesToWatch } from '../../src/live/savedFolder';
import { type LiveFileHandle } from '../../src/live/watcher';
import { isAcceptedFile, useLogStore } from '../../src/store/logStore';
import { FakeDir, FakeFile } from './fakeFs';

// Run the worker's work in-process
vi.mock('../../src/worker/client', () => {
  return {
    startParse: (
      sources: Array<{ name: string; blob: Blob }>,
      format: unknown,
      pattern: unknown,
      onMessage: (m: unknown) => void,
      live?: { multi: boolean },
    ) => {
      void (async () => {
        const { streamParseSources } = await import('../../src/worker/streamParse');
        const summary = await streamParseSources(sources as never, {
          format: format as never,
          pattern: pattern as never,
          live: live !== undefined,
          multi: live?.multi,
          onStart: (fmt, detected, files) => onMessage({ type: 'start', jobId: 1, format: fmt, detected, files }),
          onBatch: (batch) => onMessage({ type: 'batch', jobId: 1, ...batch }),
        });
        onMessage({ type: 'done', jobId: 1, lines: summary.lines, elapsedMs: 1, timeZone: summary.timeZone, held: summary.held });
      })();
    },
    appendLive: () => {},
  };
});

describe('isAcceptedFile', () => {
  it('accepts standard log extensions and new types (.out, .err, .trace)', () => {
    expect(isAcceptedFile('app.log')).toBe(true);
    expect(isAcceptedFile('server.txt')).toBe(true);
    expect(isAcceptedFile('data.json')).toBe(true);
    expect(isAcceptedFile('events.ndjson')).toBe(true);
    expect(isAcceptedFile('audit.clef')).toBe(true);
    expect(isAcceptedFile('iis.xml')).toBe(true);
    expect(isAcceptedFile('metrics.csv')).toBe(true);
    expect(isAcceptedFile('access.tsv')).toBe(true);
    expect(isAcceptedFile('catalina.out')).toBe(true);
    expect(isAcceptedFile('stderr.err')).toBe(true);
    expect(isAcceptedFile('app.trace')).toBe(true);
    expect(isAcceptedFile('archive.gz')).toBe(true);
    expect(isAcceptedFile('bundle.zip')).toBe(true);
  });

  it('accepts rotated and dated log files', () => {
    expect(isAcceptedFile('app.log.1')).toBe(true);
    expect(isAcceptedFile('access.log.20261108')).toBe(true);
    expect(isAcceptedFile('catalina.out.bak')).toBe(true);
    expect(isAcceptedFile('service.err.old')).toBe(true);
    expect(isAcceptedFile('debug.trace.1')).toBe(true);
  });

  it('rejects unsupported and binary extensions', () => {
    expect(isAcceptedFile('program.exe')).toBe(false);
    expect(isAcceptedFile('library.dll')).toBe(false);
    expect(isAcceptedFile('image.png')).toBe(false);
    expect(isAcceptedFile('bundle.js')).toBe(false);
    expect(isAcceptedFile('style.css')).toBe(false);
    expect(isAcceptedFile('page.html')).toBe(false);
  });
});

describe('file watching handles', () => {
  it('checks for showOpenFilePicker availability', () => {
    expect(typeof canOpenFilesWithHandles()).toBe('boolean');
  });

  it('picks files using showOpenFilePicker and returns handles', async () => {
    const fakeHandle: LiveFileHandle = {
      kind: 'file',
      name: 'app.log',
      getFile: async () => new File(['line 1\n'], 'app.log'),
    };
    const showOpenFilePicker = vi.fn().mockResolvedValue([fakeHandle]);
    vi.stubGlobal('showOpenFilePicker', showOpenFilePicker);

    const result = await pickFilesToWatch();
    expect(result).toEqual([fakeHandle]);
    expect(showOpenFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: true,
        mode: 'read',
      }),
    );
    vi.unstubAllGlobals();
  });

  it('returns null when user cancels showOpenFilePicker', async () => {
    const showOpenFilePicker = vi.fn().mockRejectedValue(new DOMException('User cancelled', 'AbortError'));
    vi.stubGlobal('showOpenFilePicker', showOpenFilePicker);

    const result = await pickFilesToWatch();
    expect(result).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('openFolder options and custom limits', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    useLogStore.getState().stopLive();
    vi.useRealTimers();
  });

  it('respects custom maxFiles when opening a folder', async () => {
    const dir = new FakeDir('many-logs');
    const f1 = dir.add(new FakeFile('log1.log', '2026-11-08 10:00:00 INFO row1\n'));
    f1.modified = 100;
    const f2 = dir.add(new FakeFile('log2.log', '2026-11-08 10:00:01 INFO row2\n'));
    f2.modified = 200;
    const f3 = dir.add(new FakeFile('log3.log', '2026-11-08 10:00:02 INFO row3\n'));
    f3.modified = 300;
    const f4 = dir.add(new FakeFile('log4.log', '2026-11-08 10:00:03 INFO row4\n'));
    f4.modified = 400;

    await useLogStore.getState().openFolder(dir, { maxFiles: 2 });
    await vi.waitFor(() => expect(useLogStore.getState().status).toBe('ready'));

    const state = useLogStore.getState();
    expect(state.live?.files).toBe(2);
    expect(state.live?.notice).toContain('2 older files were left out');
  });

  it('supports custom accept filter for folder watching', async () => {
    const dir = new FakeDir('mixed-logs');
    dir.add(new FakeFile('web.log', '2026-11-08 10:00:00 INFO web request\n'));
    dir.add(new FakeFile('error.err', '2026-11-08 10:00:01 ERROR crash report\n'));

    // Only accept .err files
    await useLogStore.getState().openFolder(dir, { accept: (name) => name.endsWith('.err') });
    await vi.waitFor(() => expect(useLogStore.getState().status).toBe('ready'));

    const state = useLogStore.getState();
    expect(state.live?.files).toBe(1);
    expect(state.files).toEqual(['error.err']);
    expect(state.rows.map((r) => r.values.message)).toEqual(['crash report']);
  });

  it('allows opening explicitly selected handles with non-standard extensions', async () => {
    const customHandle: LiveFileHandle = {
      kind: 'file',
      name: 'my-custom-output',
      getFile: async () => new File(['2026-11-08 10:00:00 INFO custom\n'], 'my-custom-output'),
    };

    await useLogStore.getState().openFileHandles([customHandle]);
    await vi.waitFor(() => expect(useLogStore.getState().status).toBe('ready'));

    const state = useLogStore.getState();
    expect(state.live?.kind).toBe('files');
    expect(state.rows.map((r) => r.values.message)).toEqual(['custom']);
  });
});
