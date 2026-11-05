export declare const DEFAULT_MAX_BYTES: number;

export interface LogServer {
  readonly port: number;
  /** Bytes kept for browsers that connect later. */
  readonly bytes: number;
  /** Older bytes dropped to stay within the limit. */
  readonly dropped: number;
  push(chunk: Uint8Array): void;
  /** The input ended: browsers get the end of the stream. */
  end(): void;
  close(): Promise<void>;
}

export declare function createLogServer(opts: { appDir: string; token: string; port?: number; maxBytes?: number }): Promise<LogServer>;
