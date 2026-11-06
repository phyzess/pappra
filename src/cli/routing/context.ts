import type { getPackageInfo } from '../../package-info.js';
import type { ParsedCliOptions } from '../options.js';
import type { CliOutput } from '../output.js';

export interface CliRoutingContext {
  readonly parsed: ParsedCliOptions;
  readonly info: ReturnType<typeof getPackageInfo>;
  readonly json: boolean;
  readonly interactive: boolean;
  readonly output: CliOutput;
}

export type CliRouteResult = number | Promise<number> | null;
