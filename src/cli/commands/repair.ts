import { repairInstall } from '../../install/repair.js';
import type { CliOutput } from '../output.js';

export const repairUsage =
  'pappra repair [--root <workspace>] [--runtime-version <v>] [--install-id <uuid>] [--apply] [--json]\n' +
  'Preview incomplete install journals, or explicitly recover them with --apply.\n' +
  'Runtime recovery targets the machine data directory for the selected version.\n' +
  'Live/unknown lock owners and modified or unproven files are preserved.\n';

export async function runRepairCommand(
  options: {
    readonly root: string;
    readonly runtimeVersion?: string;
    readonly installId?: string;
    readonly apply: boolean;
    readonly json: boolean;
  },
  output: CliOutput,
): Promise<number> {
  const result = await repairInstall(options);
  if (options.json)
    output.stdout(`${JSON.stringify({ command: 'repair', ...result })}\n`);
  else {
    output.stdout(
      `Install repair ${result.mode}: ${result.entries.length} incomplete journal(s).\n`,
    );
    for (const entry of result.entries)
      output.stdout(
        `  ${entry.installId} ${entry.operation}: ${entry.status}\n`,
      );
    for (const file of result.locks) output.stdout(`Install lock: ${file}\n`);
    for (const file of result.repaired) output.stdout(`Recovered: ${file}\n`);
    for (const error of result.errors)
      output.stderr(`pappra repair: ${error}\n`);
    if (
      result.ok &&
      result.mode === 'plan' &&
      (result.entries.length > 0 || result.locks.length > 0)
    ) {
      output.stdout(
        'Rerun with --apply to recover the listed install state.\n',
      );
    }
  }
  return result.ok ? 0 : 1;
}
