import path from 'node:path';
import {
  COLLAB_HANDOFF_SCHEMA,
  applyHandoffRequest,
  loadHandoffRequest,
  planHandoffRequest,
  readCoordinatorHandoffCheck,
  readHandoffInventory,
  type HandoffAction,
} from '../../app/collab-handoff.js';
import type { TaskStoreFailure } from '../../app/collab-task-store.js';
import { applySuccessorAck } from '../../app/collab-successor/ack.js';
import { discoverCodexThread } from '../../hosts/codex/thread-discovery.js';
import {
  runSuccessorLaunch,
  type SuccessorLaunchResult,
} from '../../app/collab-successor/launch.js';
import type { CliOutput } from '../output.js';

export const collaborationHandoffUsage =
  'pappra collab handoff inventory --task-root <abs> [--subtask-id <id>] [--attempt <positive integer>] [--json]\n' +
  'pappra collab handoff check --task-root <abs> [--json]\n' +
  'pappra collab handoff check-mid-cohort --task-root <abs> [--json]\n' +
  'pappra collab handoff successor --request <abs successor.json> [--apply] [--json]\n' +
  'pappra collab handoff ack --task-root <abs> --request <successor request id> [--apply] [--json]\n' +
  'pappra collab handoff <begin|stopped|rebind|transfer|confirm|complete|abort|release-dispatch> --task-root <abs> --request <abs request.json> [--apply] [--json]\n\n' +
  'Recorded ownership handoff over the existing store/lifecycle primitives. Plan is\n' +
  'namespace/request validation only; --apply performs a cooperative record\n' +
  'mutation and never stops, launches, adopts or resumes an execution. Confirmation\n' +
  'requires an accepted/recorded, explicitly correlated receiver message.';

export interface CollaborationHandoffOptions {
  readonly action:
    | HandoffAction
    | 'inventory'
    | 'check'
    | 'check-mid-cohort'
    | 'successor'
    | 'ack'
    | null;
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
  unreadableStatus = false,
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: COLLAB_HANDOFF_SCHEMA,
        ok: false,
        status:
          exitCode === 2
            ? 'invalid'
            : unreadableStatus
              ? 'unreadable'
              : 'needs_input',
        action: options.action,
        code: value.code,
        message: value.message,
        nextAction: value.nextAction,
      })}\n`,
    );
  } else {
    output.stdout(
      unreadableStatus
        ? `Handoff check could not read the task: ${value.message}\n`
        : `Handoff needs input: ${value.message}\n`,
    );
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

function emitSuccessor(result: SuccessorLaunchResult, output: CliOutput): void {
  output.stdout(
    `Successor launch ${result.action}: ${result.status}${result.request_id === null ? '' : ` (${result.request_id})`}.\n`,
  );
  for (const blocker of result.blockers)
    output.stdout(`  blocker ${blocker.code}: ${blocker.detail}\n`);
  for (const warning of result.warnings) output.stdout(`  note: ${warning}\n`);
  if (result.pane_id !== null) output.stdout(`  pane ${result.pane_id}\n`);
  if (result.identity !== null)
    output.stdout(
      `  successor ${result.identity.agent_id}/${result.identity.session_id} (${result.identity.harness})\n`,
    );
  if (result.evidence !== null)
    output.stdout(`  evidence: ${result.evidence.detail}\n`);
  for (const step of result.next_steps) output.stdout(`  next: ${step}\n`);
  output.stdout(
    '  The old session is neither stopped nor observed; identity is observed evidence, not authentication.\n',
  );
}

async function runSuccessor(
  options: CollaborationHandoffOptions,
  output: CliOutput,
): Promise<number> {
  if (options.requestFile === null)
    return invalid(output, options, ['successor requires --request.']);
  const result = await runSuccessorLaunch(
    options.requestFile,
    { apply: options.apply },
    {
      // One bounded read of the shared Codex daemon; it only ever lists and reads threads.
      discoverCodex: (criteria) => discoverCodexThread(criteria),
    },
  );
  if (options.json) output.stdout(`${JSON.stringify(result)}\n`);
  else emitSuccessor(result, output);
  return result.status === 'invalid' ? 2 : result.ok ? 0 : 1;
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The successor's one command. `--request` carries the successor request id here, and the pane
 * comes only from the inherited Herdr context, never from an argument.
 */
async function runAck(
  options: CollaborationHandoffOptions,
  output: CliOutput,
): Promise<number> {
  if (options.requestFile === null || !REQUEST_ID.test(options.requestFile))
    return invalid(output, options, [
      'ack requires --request <successor request id>.',
    ]);
  const result = await applySuccessorAck({
    taskRoot: options.taskRoot!,
    requestId: options.requestFile,
    callerPane: process.env['HERDR_PANE_ID'] ?? null,
    callerCodexThread: process.env['CODEX_THREAD_ID'] ?? null,
    apply: options.apply,
  });
  if (!result.ok) return failure(output, options, result, 1);
  if (options.json) output.stdout(`${JSON.stringify(result.value)}\n`);
  else emitAck(result.value, output);
  return 0;
}

function emitAck(value: Record<string, unknown>, output: CliOutput): void {
  const briefing = value['briefing'] as
    | {
        checkpoint: { file: string; digest: string; text: string };
        next: string;
      }
    | undefined;
  output.stdout(
    `Successor handoff ack: ${String(value['status'])} (${String(value['handoff_id'])}).\n`,
  );
  if (briefing !== undefined) {
    output.stdout(`--- briefing (${briefing.checkpoint.digest}) ---\n`);
    output.stdout(`${briefing.checkpoint.text}\n`);
    output.stdout('--- end briefing ---\n');
    output.stdout(`${briefing.next}\n`);
  }
}

function emitCheck(value: Record<string, unknown>, output: CliOutput): void {
  const findings = (key: string) =>
    value[key] as { code: string; detail: string; next_action: string }[];
  output.stdout(
    `Coordinator handoff check: ${String(value.status)} (${String(value.task_id)}${value.workflow_driven === true ? ', workflow-driven' : ''}).\n`,
  );
  for (const item of findings('blockers'))
    output.stdout(
      `  blocker ${item.code}: ${item.detail}\n    next: ${item.next_action}\n`,
    );
  for (const item of findings('warnings'))
    output.stdout(
      `  note ${item.code}: ${item.detail}\n    next: ${item.next_action}\n`,
    );
  const steps = value.next_steps as string[];
  if (steps.length > 0) {
    output.stdout('  next steps, in order:\n');
    for (const step of steps) output.stdout(`    - ${step}\n`);
  }
  output.stdout(
    '  fence: protocol only; the outgoing session is neither stopped nor observed.\n',
  );
  output.stdout(`  limits: ${(value.limits as string[]).join(', ')}\n`);
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
  if (options.action === 'successor') return runSuccessor(options, output);
  if (options.taskRoot === null)
    return invalid(output, options, ['--task-root is required.']);
  if (!path.isAbsolute(options.taskRoot))
    return invalid(output, options, ['--task-root must be absolute.']);

  if (options.action === 'check' || options.action === 'check-mid-cohort') {
    const result = await readCoordinatorHandoffCheck(
      options.taskRoot,
      options.action === 'check-mid-cohort' ? { mode: 'mid_cohort' } : {},
    );
    if (!result.ok) return failure(output, options, result, 1, true);
    if (options.json) output.stdout(`${JSON.stringify(result.value)}\n`);
    else emitCheck(result.value, output);
    return result.value.ok === true ? 0 : 1;
  }

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

  if (options.action === 'ack') return runAck(options, output);
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
