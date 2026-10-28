import type { WorkerRequest, WorkerResponse } from './protocol';
import { CancelledError, ParseError, streamParse } from './streamParse';

const ctx = self as unknown as {
  postMessage(msg: WorkerResponse): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};
const cancelled = new Set<number>();

const post = (msg: WorkerResponse) => ctx.postMessage(msg);

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.jobId);
    return;
  }
  const { jobId, file, format } = msg;
  const started = performance.now();
  try {
    const summary = await streamParse(file, {
      format,
      isCancelled: () => cancelled.has(jobId),
      onStart: (fmt, detected) => post({ type: 'start', jobId, format: fmt, detected }),
      onBatch: (batch) => post({ type: 'batch', jobId, ...batch }),
      onProgress: (bytesRead, totalBytes, lines) => post({ type: 'progress', jobId, bytesRead, totalBytes, lines }),
    });
    post({ type: 'done', jobId, lines: summary.lines, elapsedMs: performance.now() - started });
  } catch (err) {
    if (err instanceof CancelledError) return;
    const message =
      err instanceof ParseError ? err.message : `Could not read the file: ${err instanceof Error ? err.message : String(err)}`;
    post({ type: 'error', jobId, message });
  } finally {
    cancelled.delete(jobId);
  }
};
