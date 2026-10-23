import path from 'node:path';
import {
  COLLAB_STATE_SCHEMA,
  checkTaskEpoch,
  doctorTaskState,
  showTaskState,
  type StateAction,
} from '../../app/collab-state.js';
import type { TaskStoreFailure } from '../../app/collab-task-store.js';
import type { CliOutput } from '../output.js';

export const collaborationStateUsage =
  'pappra collab state <show|doctor|epoch-check> --task-root <abs> [options]\n' +
  '  show         --task-root <abs> [--json]\n' +
  '  doctor       --task-root <abs> [--json]\n' +
  '  epoch-check  --task-root <abs> --owner-epoch <positive integer> [--json]\n\n' +
  'Read-only task-state projections over the existing record/lock/transaction\n' +
  'primitives. Nothing is repaired, released, restarted or launched. Exit 0 ready,\n' +
  '1 needs_input/uncertainty, 2 invalid request/options.';

export interface CollaborationStateOptions {
  readonly action: StateAction | null;
  readonly taskRoot: string | null;
  readonly ownerEpoch: string | null;
  readonly json: boolean;
}

function invalid(
  output: CliOutput,
  options: CollaborationStateOptions,
  errors: readonly string[],
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: COLLAB_STATE_SCHEMA,
        ok: false,
        status: 'invalid',
        action: options.action,
        errors,
      })}\n`,
    );
  } else {
    output.stdout(`State request invalid.\n`);
    for (const error of errors) output.stdout(`  - ${error}\n`);
  }
  return 2;
}

function failure(
  output: CliOutput,
  options: CollaborationStateOptions,
  value: TaskStoreFailure,
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: COLLAB_STATE_SCHEMA,
        ok: false,
        status: 'needs_input',
        action: options.action,
        code: value.code,
        message: value.message,
        nextAction: value.nextAction,
      })}\n`,
    );
  } else {
    output.stdout(`State needs input: ${value.message}\n`);
    if (value.nextAction) output.stdout(`  ${value.nextAction}\n`);
  }
  return 1;
}

function emitHuman(
  value: Record<string, unknown>,
  action: StateAction,
  output: CliOutput,
): void {
  if (action === 'show') {
    output.stdout(
      `Task ${String(value.task_id)} revision ${String(value.state_revision)}.\n`,
    );
    output.stdout(
      `  attempts: ${String((value.counts as Record<string, unknown>).attempts)}; claims: ${String((value.counts as Record<string, unknown>).claims)}; messages: ${String(value.messages)}\n`,
    );
    const lock = value.lock as Record<string, unknown>;
    output.stdout(
      `  lock: ${lock.held === true ? 'held' : 'not held'}; transactions: ${String(lock.transaction_count)}\n`,
    );
  } else if (action === 'doctor') {
    const findings = value.findings as {
      severity: string;
      code: string;
    }[];
    const counts = value.counts as {
      findings: number;
      blocking: number;
      uncertain: number;
      active: number;
    };
    output.stdout(
      `Doctor ${value.ok === true ? 'ready' : 'needs input'}: ${String(counts.findings)} finding(s), ${String(counts.blocking)} blocking, ${String(counts.uncertain)} uncertain, ${String(counts.active)} active lock observation(s).\n`,
    );
    for (const finding of findings)
      output.stdout(`  - ${finding.severity}: ${finding.code}\n`);
  } else {
    output.stdout(
      `Owner epoch ${value.ok === true ? 'matches' : 'does not match'}: expected ${String(value.expected)}, actual ${String(value.actual)}.\n`,
    );
  }
}

export async function runCollaborationStateCommand(
  options: CollaborationStateOptions,
  output: CliOutput,
): Promise<number> {
  if (options.action === null)
    return invalid(output, options, [
      'state requires show, doctor or epoch-check.',
    ]);
  if (options.taskRoot === null)
    return invalid(output, options, ['--task-root is required.']);
  if (!path.isAbsolute(options.taskRoot))
    return invalid(output, options, ['--task-root must be absolute.']);
  let ownerEpoch: number | null = null;
  if (options.action === 'epoch-check') {
    if (options.ownerEpoch === null)
      return invalid(output, options, ['epoch-check requires --owner-epoch.']);
    const parsed = Number(options.ownerEpoch.trim());
    if (!Number.isSafeInteger(parsed) || parsed <= 0)
      return invalid(output, options, [
        '--owner-epoch must be a positive integer.',
      ]);
    ownerEpoch = parsed;
  }
  const result =
    options.action === 'show'
      ? await showTaskState(options.taskRoot)
      : options.action === 'doctor'
        ? await doctorTaskState(options.taskRoot)
        : await checkTaskEpoch(options.taskRoot, ownerEpoch!);
  if (!result.ok) return failure(output, options, result);
  if (options.json) output.stdout(`${JSON.stringify(result.value)}\n`);
  else emitHuman(result.value, options.action, output);
  return result.value.ok === true ? 0 : 1;
}
