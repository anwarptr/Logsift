import type { WorkerRequest, WorkerResponse } from './protocol';
import { appendToSession, CancelledError, ParseError, streamParseSources, type LiveSession } from './streamParse';

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};
const cancelled = new Set<number>();
/** The parser of the last live job, kept to read lines appended to its files. */
let live: { jobId: number; session: LiveSession } | null = null;

const post = (msg: WorkerResponse) => ctx.postMessage(msg);

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.jobId);
    if (live?.jobId === msg.jobId) live = null;
    return;
  }
  if (msg.type === 'append') {
    const { jobId, name } = msg;
    if (live?.jobId !== jobId) {
      post({ type: 'appended', jobId, name, consumed: 0, timeZone: null });
      return;
    }
    const session = live.session;
    try {
      const bytes = new Uint8Array(await msg.blob.arrayBuffer());
      const { consumed, timeZone } = appendToSession(session, name, bytes, msg.modified, (batch) =>
        post({ type: 'batch', jobId, ...batch }),
        msg.final,
      );
      post({ type: 'appended', jobId, name, consumed, timeZone });
    } catch (err) {
      post({ type: 'appended', jobId, name, consumed: 0, timeZone: null });
      console.warn(`Logsift: could not read new lines of ${name}`, err);
    }
    return;
  }
  const { jobId, sources, format, pattern } = msg;
  live = null;
  const started = performance.now();
  try {
    const summary = await streamParseSources(sources, {
      format,
      pattern,
      live: msg.live,
      multi: msg.multi,
      isCancelled: () => cancelled.has(jobId),
      onStart: (fmt, detected, files) => post({ type: 'start', jobId, format: fmt, detected, files }),
      onBatch: (batch) => post({ type: 'batch', jobId, ...batch }),
      onProgress: (bytesRead, totalBytes, lines) => post({ type: 'progress', jobId, bytesRead, totalBytes, lines }),
    });
    if (summary.session) live = { jobId, session: summary.session };
    post({
      type: 'done',
      jobId,
      lines: summary.lines,
      elapsedMs: performance.now() - started,
      timeZone: summary.timeZone,
      format: summary.format,
      detected: summary.detected,
      held: summary.held,
    });
  } catch (err) {
    if (err instanceof CancelledError) return;
    const message =
      err instanceof ParseError ? err.message : `Could not read the file: ${err instanceof Error ? err.message : String(err)}`;
    post({ type: 'error', jobId, message });
  } finally {
    cancelled.delete(jobId);
  }
};
