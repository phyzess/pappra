import path from 'node:path';
import {
  COLLAB_RECOVERY_SCHEMA,
  applyRecovery,
  inspectRecovery,
  loadRecoveryRequest,
  planRecovery,
  type RecoveryAction,
} from '../../app/collab-recovery.js';
import type { TaskStoreFailure } from '../../app/collab-task-store.js';
import type { CliOutput } from '../output.js';

export const collaborationRecoveryUsage =
  'pappra collab recovery inspect --task-root <abs> [--json]\n' +
  'pappra collab recovery <reconcile|lock-break> --task-root <abs> --request <abs request.json> [--apply] [--json]\n\n' +
  'Read-only recovery inspection or explicit recorded recovery. Reconcile resolves\n' +
  'one uncertainty (and optionally applies an existing state transition) atomically.\n' +
  'Lock-break archives one task write lock only after an operator stop assertion and\n' +
  'an exact inspected fingerprint. No native execution is queried or controlled.';

export interface CollaborationRecoveryOptions {
  readonly action: RecoveryAction | null;
  readonly taskRoot: string | null;
  readonly requestFile: string | null;
  readonly apply: boolean;
  readonly json: boolean;
}

function invalid(
  output: CliOutput,
  options: CollaborationRecoveryOptions,
  errors: readonly string[],
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: COLLAB_RECOVERY_SCHEMA,
        ok: false,
        status: 'invalid',
        action: options.action,
        errors,
      })}\n`,
    );
  } else {
    output.stdout(`Recovery request invalid.\n`);
    for (const error of errors) output.stdout(`  - ${error}\n`);
  }
  return 2;
}

function failure(
  output: CliOutput,
  options: CollaborationRecoveryOptions,
  value: TaskStoreFailure,
  exitCode: number,
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: COLLAB_RECOVERY_SCHEMA,
        ok: false,
        status: exitCode === 2 ? 'invalid' : 'needs_input',
        action: options.action,
        code: value.code,
        message: value.message,
        nextAction: value.nextAction,
      })}\n`,
    );
  } else {
    output.stdout(`Recovery needs input: ${value.message}\n`);
    if (value.nextAction) output.stdout(`  ${value.nextAction}\n`);
  }
  return exitCode;
}

function emitInspect(value: Record<string, unknown>, output: CliOutput): void {
  const uncertainty = value.uncertainty as {
    counts: { open: number; resolved: number };
  };
  const lock = value.lock as {
    held: boolean;
    holder_process_alive: boolean;
    transaction_count: number;
    fingerprint_status: string;
  };
  output.stdout(
    `Recovery ${value.ok === true ? 'ready' : 'needs input'}: ${String(uncertainty.counts.open)} open uncertainty, ${String(uncertainty.counts.resolved)} resolved.\n`,
  );
  output.stdout(
    `  lock: ${lock.held ? (lock.holder_process_alive ? 'held (holder alive)' : 'held (holder liveness unconfirmed)') : 'not held'}; transactions: ${String(lock.transaction_count)}; fingerprint: ${lock.fingerprint_status}\n`,
  );
}

function emitHuman(
  value: Record<string, unknown>,
  action: RecoveryAction,
  output: CliOutput,
): void {
  if (value.status === 'planned' && value.applied === false) {
    output.stdout(
      action === 'reconcile'
        ? 'Reconcile plan validates the request and task namespace; nothing was written.\n'
        : 'Lock-break plan validates the request and task namespace; nothing was archived.\n',
    );
    return;
  }
  if (action === 'reconcile') {
    output.stdout(
      value.ok === true
        ? `Reconcile applied: resolution recorded; state transition ${String((value.result as Record<string, unknown> | null)?.state_transition ?? 'none')}.\n`
        : `Reconcile refused: ${String(value.reason ?? 'unknown')}.\n`,
    );
  } else if (value.ok === true) {
    output.stdout(
      `Lock-break archived ${String(value.archived_lock ?? 'the task lock')}.\n`,
    );
  } else {
    output.stdout(
      `Lock-break refused: ${String(value.reason ?? 'unknown')}.\n`,
    );
  }
}

export async function runCollaborationRecoveryCommand(
  options: CollaborationRecoveryOptions,
  output: CliOutput,
): Promise<number> {
  if (options.action === null)
    return invalid(output, options, ['recovery requires an action.']);
  if (options.taskRoot === null)
    return invalid(output, options, ['--task-root is required.']);
  if (!path.isAbsolute(options.taskRoot))
    return invalid(output, options, ['--task-root must be absolute.']);

  if (options.action === 'inspect') {
    const result = await inspectRecovery(options.taskRoot);
    if (!result.ok) return failure(output, options, result, 1);
    if (options.json) output.stdout(`${JSON.stringify(result.value)}\n`);
    else emitInspect(result.value, output);
    return result.value.ok === true ? 0 : 1;
  }

  if (options.requestFile === null)
    return invalid(output, options, [`${options.action} requires --request.`]);
  if (!path.isAbsolute(options.requestFile))
    return invalid(output, options, ['--request must be absolute.']);
  const loaded = loadRecoveryRequest(options.requestFile, options.action);
  if (!loaded.ok) return failure(output, options, loaded, 2);
  const result = options.apply
    ? await applyRecovery(options.taskRoot, loaded.value.request)
    : await planRecovery(options.taskRoot, loaded.value.request);
  if (!result.ok) return failure(output, options, result, 1);
  if (options.json) output.stdout(`${JSON.stringify(result.value)}\n`);
  else emitHuman(result.value, options.action, output);
  return result.value.ok === true ? 0 : 1;
}
