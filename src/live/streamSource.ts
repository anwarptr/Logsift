import type { LiveFileHandle } from './watcher';

/**
 * A log stream from the `npx logsift` launcher: it serves this app on 127.0.0.1 and opens it with
 * `?stream=/stream?token=…&name=…`. The lines received so far are kept in memory behind something that
 * looks like a file handle that keeps growing, so live tail reads the stream like a log file.
 */

export interface StreamParams {
  /** Same-origin path of the stream (with its token). */
  path: string;
  /** File name for the stream (shown in the file bar and live bar). */
  fileName: string;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The stream to read, from the page address. Only on the launcher's local server and only its own
 * same-origin /stream path, so a link elsewhere can't point the app at another source.
 */
export function streamParams(loc: { hostname: string; search: string }): StreamParams | null {
  if (!LOCAL_HOSTS.has(loc.hostname)) return null;
  const q = new URLSearchParams(loc.search);
  const path = q.get('stream');
  if (!path || !/^\/stream\?token=[0-9a-f]{16,}$/.test(path)) return null;
  const name = (q.get('name') ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim().slice(0, 100) || 'stream';
  return { path, fileName: /\.(log|txt)$/i.test(name) ? name : `${name}.log` };
}

export type StreamState = 'waiting' | 'streaming' | 'ended' | 'failed';

export interface LogStream {
  handle: LiveFileHandle;
  /** Resolves once the first bytes arrived (or the stream ended or failed before any). */
  firstData: Promise<void>;
  readonly state: StreamState;
  readonly bytes: number;
  /** Called when the stream ends or fails. */
  onEnd(cb: (state: 'ended' | 'failed', error?: string) => void): void;
  cancel(): void;
}

export function openStream(path: string, fileName: string, fetchImpl: typeof fetch = fetch): LogStream {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let modified = Date.now();
  let state: StreamState = 'waiting';
  let resolveFirst!: () => void;
  const firstData = new Promise<void>((r) => (resolveFirst = r));
  const endListeners: ((s: 'ended' | 'failed', error?: string) => void)[] = [];
  const controller = new AbortController();

  const finish = (s: 'ended' | 'failed', error?: string) => {
    if (state === 'ended' || state === 'failed') return;
    state = s;
    resolveFirst();
    for (const cb of endListeners) cb(s, error);
  };

  void (async () => {
    try {
      const res = await fetchImpl(path, { cache: 'no-store', signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`the stream answered ${res.status}`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        chunks.push(value);
        bytes += value.length;
        modified = Date.now();
        if (state === 'waiting') {
          state = 'streaming';
          resolveFirst();
        }
      }
      finish('ended');
    } catch (e) {
      finish('failed', e instanceof Error ? e.message : String(e));
    }
  })();

  return {
    handle: {
      kind: 'file',
      name: fileName,
      getFile: async () => new File(chunks as BlobPart[], fileName, { lastModified: modified }),
    },
    firstData,
    get state() {
      return state;
    },
    get bytes() {
      return bytes;
    },
    onEnd(cb) {
      endListeners.push(cb);
    },
    cancel() {
      controller.abort();
    },
  };
}
