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

/** Start parsing files in the worker, cancelling any job in flight. */
export function startParse(sources: LogSource[], format: LogFormat | undefined, onMessage: Handler): void {
  const w = getWorker();
  if (currentJob) w.postMessage({ type: 'cancel', jobId: currentJob } satisfies WorkerRequest);
  currentJob++;
  currentHandler = onMessage;
  w.postMessage({ type: 'parse', jobId: currentJob, sources, format } satisfies WorkerRequest);
}
