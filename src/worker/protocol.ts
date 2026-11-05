import type { LogFormat, LogTimeZone } from '../parser';
import type { LogSource, StreamBatch } from './streamParse';

export type WorkerRequest =
  | {
      type: 'parse';
      jobId: number;
      sources: LogSource[];
      format?: LogFormat;
      pattern?: string;
      /** Keep the parser so lines appended to the files later can be added ('append'). */
      live?: boolean;
      /** Rows get a source file column even for one file. */
      multi?: boolean;
    }
  /** New bytes of a file of the live job (from its last read offset), or a new file; `final` once it stopped growing (`'lines'`: keep an unfinished last line). */
  | { type: 'append'; jobId: number; name: string; blob: Blob; modified: number; final?: boolean | 'lines' }
  | { type: 'cancel'; jobId: number };

export type WorkerResponse =
  | { type: 'start'; jobId: number; format: LogFormat; detected: LogFormat; files: string[] }
  | ({ type: 'batch'; jobId: number } & StreamBatch)
  | { type: 'progress'; jobId: number; bytesRead: number; totalBytes: number; lines: number }
  | {
      type: 'done';
      jobId: number;
      lines: number;
      elapsedMs: number;
      timeZone: LogTimeZone;
      /** Live: bytes at the end of each file not read yet (an unfinished last line). */
      held?: Record<string, number>;
    }
  /** An append was read: `consumed` bytes (whole lines); its rows came as batches before this. */
  | { type: 'appended'; jobId: number; name: string; consumed: number; timeZone: LogTimeZone | null }
  | { type: 'error'; jobId: number; message: string };
