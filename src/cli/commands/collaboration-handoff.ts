import path from 'node:path';
import {
  COLLAB_HANDOFF_SCHEMA,
  applyHandoffRequest,
  loadHandoffRequest,
  planHandoffRequest,
  readHandoffInventory,
  type HandoffAction,
} from '../../app/collab-handoff.js';
import type { TaskStoreFailure } from '../../app/collab-task-store.js';
import type { CliOutput } from '../output.js';

export const collaborationHandoffUsage =
  'pappra collab handoff inventory --task-root <abs> [--subtask-id <id>] [--attempt <positive integer>] [--json]\n' +
  'pappra collab handoff <begin|stopped|rebind|transfer|confirm|complete|abort|release-dispatch> --task-root <abs> --request <abs request.json> [--apply] [--json]\n\n' +
  'Recorded ownership handoff over the existing store/lifecycle primitives. Plan is\n' +
  'namespace/request validation only; --apply performs a cooperative record\n' +
  'mutation and never stops, launches, adopts or resumes an execution. Confirmation\n' +
  'requires an accepted/recorded, explicitly correlated receiver message.';

export interface CollaborationHandoffOptions {
  readonly action: HandoffAction | 'inventory' | null;
  readonly taskRoot: string | null;
  readonly requestFile: string | null;
  readonly subtaskId: string | null;
  readonly attempt: string | null;
  readonly apply: boolean;
  readonly json: boolean;
}

function invalid(
  output: CliOutput,
  options: CollaborationHandoffOptions,
  errors: readonly string[],
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: COLLAB_HANDOFF_SCHEMA,
        ok: false,
        status: 'invalid',
        action: options.action,
        errors,
      })}\n`,
    );
  } else {
    output.stdout(`Handoff request invalid.\n`);
    for (const error of errors) output.stdout(`  - ${error}\n`);
  }
  return 2;
}

function failure(
  output: CliOutput,
  options: CollaborationHandoffOptions,
  value: TaskStoreFailure,
  exitCode: number,
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: COLLAB_HANDOFF_SCHEMA,
        ok: false,
        status: exitCode === 2 ? 'invalid' : 'needs_input',
        action: options.action,
        code: value.code,
        message: value.message,
        nextAction: value.nextAction,
      })}\n`,
    );
  } else {
    output.stdout(`Handoff needs input: ${value.message}\n`);
    if (value.nextAction) output.stdout(`  ${value.nextAction}\n`);
  }
  return exitCode;
}

function emitInventory(
  value: Record<string, unknown>,
  output: CliOutput,
): void {
  const counts = value.counts as Record<string, number>;
  output.stdout(
    `Handoff inventory: ${String(counts.handoffs)} handoff(s), ${String(counts.inflight)} inflight, ${String(counts.uncertainty)} uncertainty.\n`,
  );
  if (value.truncated === true)
    output.stdout('  Some inventory rows are omitted (bounded summary).\n');
}

function emitHuman(
  value: Record<string, unknown>,
  action: HandoffAction,
  output: CliOutput,
): void {
  if (value.applied === false) {
    output.stdout(`Handoff ${action} plan validated; nothing was persisted.\n`);
  } else {
    output.stdout(
      `Handoff ${action} ${value.ok === true ? 'applied' : 'refused'}: ${String(value.reason ?? 'completed')}.\n`,
    );
  }
}

export async function runCollaborationHandoffCommand(
  options: CollaborationHandoffOptions,
  output: CliOutput,
): Promise<number> {
  if (options.action === null)
    return invalid(output, options, ['handoff requires an action.']);
  if (options.taskRoot === null)
    return invalid(output, options, ['--task-root is required.']);
  if (!path.isAbsolute(options.taskRoot))
    return invalid(output, options, ['--task-root must be absolute.']);

  if (options.action === 'inventory') {
    let attempt: number | null = null;
    if (options.attempt !== null) {
      const parsed = Number(options.attempt.trim());
      if (!Number.isSafeInteger(parsed) || parsed <= 0)
        return invalid(output, options, [
          '--attempt must be a positive integer.',
        ]);
      attempt = parsed;
    }
    const result = await readHandoffInventory(
      options.taskRoot,
      options.subtaskId,
      attempt,
    );
    if (!result.ok) return failure(output, options, result, 1);
    if (options.json) output.stdout(`${JSON.stringify(result.value)}\n`);
    else emitInventory(result.value, output);
    return 0;
  }

  if (options.requestFile === null)
    return invalid(output, options, [`${options.action} requires --request.`]);
  if (!path.isAbsolute(options.requestFile))
    return invalid(output, options, ['--request must be absolute.']);
  const loaded = loadHandoffRequest(options.requestFile, options.action);
  if (!loaded.ok) return failure(output, options, loaded, 2);
  const result = options.apply
    ? await applyHandoffRequest(options.taskRoot, loaded.value.request)
    : await planHandoffRequest(options.taskRoot, loaded.value.request);
  if (!result.ok) return failure(output, options, result, 1);
  if (options.json) output.stdout(`${JSON.stringify(result.value)}\n`);
  else emitHuman(result.value, options.action, output);
  return result.value.ok === true ? 0 : 1;
}
