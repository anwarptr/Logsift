export interface CliOptions {
  azure?: string;
  group?: string;
  slot?: string;
  subscription?: string;
  name?: string;
  port?: number;
  open: boolean;
  help: boolean;
  version: boolean;
}

export declare function parseArgs(argv: string[]): CliOptions;
