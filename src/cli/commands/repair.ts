import { repairInstall } from '../../install/repair.js';
import type { CliOutput } from '../output.js';
import {
  clackProgress,
  clackWizardUi,
  confirmApply,
  type ProgressUi,
  type WizardUi,
} from '../interactive.js';

export const repairUsage =
  'pappra repair [--root <workspace>] [--runtime-version <v>] [--install-id <uuid>] [--apply] [--quarantine-unowned-locks] [--reset-local --all-writers-stopped] [--json]\n' +
  'Preview incomplete install journals, or explicitly recover them with --apply. On a\n' +
  'terminal the preview asks one confirmation to recover; --apply never asks.\n' +
  'Also inspect/recover provably dead knowledge and checkpoint writer locks.\n' +
  'Runtime recovery targets the machine data directory for the selected version.\n' +
  'Live/unknown lock owners and modified or unproven files are preserved.\n' +
  '--quarantine-unowned-locks is an explicit operator assertion that ALL affected writers are stopped;\n' +
  'with --apply it moves unknown lock evidence into private quarantine without claiming owner death.\n' +
  'Never use this flag against a live or paused writer. Live verified owners are always refused.\n' +
  '--reset-local explicitly archives all old private local state without migration; --apply also requires\n' +
  '--all-writers-stopped. Existing bytes remain under ignored .pappra/local-archive; fresh init is separate.\n';

export interface RepairCommandDeps {
  readonly ui?: WizardUi;
  readonly progress?: ProgressUi;
}

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
    readonly interactive?: boolean;
  },
  output: CliOutput,
  deps: RepairCommandDeps = {},
): Promise<number> {
  const result = await repairInstall(options);
  const printResult = (
    value: Awaited<ReturnType<typeof repairInstall>>,
    planOnlyGuidance: boolean,
  ): void => {
    if (options.json) {
      output.stdout(`${JSON.stringify({ command: 'repair', ...value })}\n`);
      return;
    }
    output.stdout(
      `State repair ${value.mode}: ${value.entries.length} incomplete install journal(s).\n`,
    );
    for (const entry of value.entries)
      output.stdout(
        `  ${entry.installId} ${entry.operation}: ${entry.status}\n`,
      );
    for (const file of value.locks) output.stdout(`Writer lock: ${file}\n`);
    for (const state of value.lockStates)
      output.stdout(`Lock owner ${state.state}: ${state.file}\n`);
    for (const file of value.preserved)
      output.stdout(`Preserved unproven file: ${file}\n`);
    for (const file of value.quarantined)
      output.stdout(`Quarantined unowned lock evidence: ${file}\n`);
    if (value.reset !== null)
      output.stdout(
        `Local reset ${value.reset.status}; archive: ${value.reset.archive ?? '(none)'}\n`,
      );
    for (const file of value.repaired) output.stdout(`Recovered: ${file}\n`);
    for (const error of value.errors)
      output.stderr(`pappra repair: ${error}\n`);
    if (
      planOnlyGuidance &&
      value.ok &&
      value.mode === 'plan' &&
      (value.entries.length > 0 || value.locks.length > 0)
    ) {
      output.stdout(
        'Rerun with --apply to recover the listed install state.\n',
      );
    }
  };
  const preview =
    options.interactive === true &&
    options.json !== true &&
    !options.apply &&
    result.ok &&
    result.mode === 'plan' &&
    (result.entries.length > 0 || result.locks.length > 0);
  printResult(result, !preview);
  if (!preview) return result.ok ? 0 : 1;
  const apply = await confirmApply(
    deps.ui ?? clackWizardUi,
    'Recover this interrupted state now?',
    false,
  );
  if (!apply) {
    output.stdout('Nothing was applied.\n');
    return 0;
  }
  const progress = deps.progress ?? clackProgress();
  progress.start('Recovering interrupted state...');
  const applied = await repairInstall({ ...options, apply: true });
  progress.stop(`State repair ${applied.mode}.`);
  printResult(applied, false);
  return applied.ok ? 0 : 1;
}
