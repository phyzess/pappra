import { repairInstall } from '../../install/repair.js';
import type { CliOutput } from '../output.js';

export const repairUsage =
  'pappra repair [--root <workspace>] [--runtime-version <v>] [--install-id <uuid>] [--apply] [--quarantine-unowned-locks] [--reset-local --all-writers-stopped] [--json]\n' +
  'Preview incomplete install journals, or explicitly recover them with --apply.\n' +
  'Also inspect/recover provably dead knowledge and checkpoint writer locks.\n' +
  'Runtime recovery targets the machine data directory for the selected version.\n' +
  'Live/unknown lock owners and modified or unproven files are preserved.\n' +
  '--quarantine-unowned-locks is an explicit operator assertion that ALL affected writers are stopped;\n' +
  'with --apply it moves unknown lock evidence into private quarantine without claiming owner death.\n' +
  'Never use this flag against a live or paused writer. Live verified owners are always refused.\n' +
  '--reset-local explicitly archives all old private local state without migration; --apply also requires\n' +
  '--all-writers-stopped. Existing bytes remain under ignored .pappra/local-archive; fresh init is separate.\n';

export async function runRepairCommand(
  options: {
    readonly root: string;
    readonly runtimeVersion?: string;
    readonly installId?: string;
    readonly apply: boolean;
    readonly json: boolean;
    readonly quarantineUnownedLocks?: boolean;
    readonly resetLocal?: boolean;
    readonly allWritersStopped?: boolean;
  },
  output: CliOutput,
): Promise<number> {
  const result = await repairInstall(options);
  if (options.json)
    output.stdout(`${JSON.stringify({ command: 'repair', ...result })}\n`);
  else {
    output.stdout(
      `State repair ${result.mode}: ${result.entries.length} incomplete install journal(s).\n`,
    );
    for (const entry of result.entries)
      output.stdout(
        `  ${entry.installId} ${entry.operation}: ${entry.status}\n`,
      );
    for (const file of result.locks) output.stdout(`Writer lock: ${file}\n`);
    for (const state of result.lockStates)
      output.stdout(`Lock owner ${state.state}: ${state.file}\n`);
    for (const file of result.preserved)
      output.stdout(`Preserved unproven file: ${file}\n`);
    for (const file of result.quarantined)
      output.stdout(`Quarantined unowned lock evidence: ${file}\n`);
    if (result.reset !== null)
      output.stdout(
        `Local reset ${result.reset.status}; archive: ${result.reset.archive ?? '(none)'}\n`,
      );
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
