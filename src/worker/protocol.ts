import type { LogFormat, LogTimeZone } from '../parser';
import type { LogSource, StreamBatch } from './streamParse';

export type WorkerRequest =
  | { type: 'parse'; jobId: number; sources: LogSource[]; format?: LogFormat }
  | { type: 'cancel'; jobId: number };

export type WorkerResponse =
  | { type: 'start'; jobId: number; format: LogFormat; detected: LogFormat; files: string[] }
  | ({ type: 'batch'; jobId: number } & StreamBatch)
  | { type: 'progress'; jobId: number; bytesRead: number; totalBytes: number; lines: number }
  | { type: 'done'; jobId: number; lines: number; elapsedMs: number; timeZone: LogTimeZone }
  | { type: 'error'; jobId: number; message: string };
