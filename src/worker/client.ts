import type { LogFormat } from '../parser';
import type { WorkerRequest, WorkerResponse } from './protocol';
import type { LogSource } from './streamParse';

type Handler = (msg: WorkerResponse) => void;

let worker: Worker | null = null;
let currentJob = 0;
let currentHandler: Handler | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      // Ignore stale messages from a job that was superseded.
      if (e.data.jobId === currentJob) currentHandler?.(e.data);
    };
    worker.onerror = (e) => {
      currentHandler?.({ type: 'error', jobId: currentJob, message: e.message || 'Parser worker crashed.' });
    };
  }
  return worker;
}

export interface LiveParseOptions {
  /** Rows get a source file column even for one file (a folder may get more files). */
  multi?: boolean;
}

/**
 * Start parsing files in the worker, cancelling any job in flight. With `live`, the worker keeps
 * the parser so `appendLive` can add lines written to the files later.
 */
export function startParse(
  sources: LogSource[],
  format: LogFormat | undefined,
  pattern: string | undefined,
  onMessage: Handler,
  live?: LiveParseOptions,
): void {
  const w = getWorker();
  if (currentJob) w.postMessage({ type: 'cancel', jobId: currentJob } satisfies WorkerRequest);
  currentJob++;
  currentHandler = onMessage;
  w.postMessage({
    type: 'parse',
    jobId: currentJob,
    sources,
    format,
    pattern,
    live: live !== undefined,
    multi: live?.multi,
  } satisfies WorkerRequest);
}

/** Send bytes appended to a file of the current live job; the reply is an 'appended' message. */
export function appendLive(name: string, blob: Blob, modified: number, final = false): void {
  getWorker().postMessage({ type: 'append', jobId: currentJob, name, blob, modified, final } satisfies WorkerRequest);
}
