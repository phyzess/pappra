import type { CliOutput } from '../output.js';
import type { CliValues } from '../options.js';
import type { getPackageInfo } from '../../package-info.js';

/** Everything a collaboration command-family handler needs from one parsed command line. */
export interface RoutingContext {
  readonly values: CliValues;
  readonly action: string | null;
  readonly args: readonly string[];
  readonly info: ReturnType<typeof getPackageInfo>;
  readonly rpcRequestTimeout: string | undefined;
  readonly rpcOperationTimeout: string | undefined;
  readonly output: CliOutput;
  readonly json: boolean;
}
