import {
  applyAccept,
  applyDispatch,
  applyParticipant,
  applyPrepare,
  inspectWorkflow,
  acceptRequestKind,
  applyAcceptBatch,
  loadAcceptBatchRequest,
  loadAcceptRequest,
  loadDispatchRequest,
  loadParticipantRequest,
  loadPrepareRequest,
  loadAdoptRequest,
  loadReclaimRequest,
  applyAdopt,
  applyReclaim,
  planPrepare,
  type WorkflowPlan,
  type WorkflowResult,
} from '../../app/collab-workflow.js';
import type { CliOutput } from '../output.js';

/**
 * `pappra collab workflow ...`
 *
 * This family parses its own argv. Workflow requests are documents with a declared schema,
 * so the family does not add flags to the global parser and does not re-validate a document
 * through the global parser's unrelated options. The route is installed before `parseOptions`, exactly
 * like the `docs review` route.
 */

export const collaborationWorkflowUsage =
  'pappra collab workflow <prepare|dispatch|ack|report|accept|release|reclaim|adopt|inspect> [options]\n' +
  '  prepare  --request <abs prepare.json> [--apply] [--json]\n' +
  '  dispatch --request <abs dispatch.json> [--apply] [--json]\n' +
  '  ack      --request <abs participant.json> [--apply] [--json]\n' +
  '  report   --request <abs participant.json> [--apply] [--json]\n' +
  '  release  --request <abs participant.json> [--apply] [--json]\n' +
  '  accept   --request <abs accept.json|accept-batch.json> [--apply] [--json]\n' +
  '  reclaim  --request <abs reclaim.json> [--apply] [--json]\n' +
  '  adopt    --request <abs adopt.json> [--apply] [--json]\n' +
  '  inspect  --task-root <abs task root> [--limit <1-500>] [--json]\n\n' +
  'Without --apply every action is a zero-write, zero-notification plan. Prepare derives one\n' +
  'cohort from the declared goal, seals deterministic assignment documents and registers the\n' +
  'derived ASSIGN messages and claims for writers only; reviewer ASSIGN and claims stay\n' +
  'deferred until accepted writers release. Dispatch re-derives the current capability card\n' +
  'immediately before notifying, and records one durable intent per attempt so an unknown\n' +
  'delivery is reconciled instead of replayed. Ack, report and release are self-call only:\n' +
  'the caller must equal the registered attempt assignee. Accept is a separate coordinator\n' +
  'decision and a writer can never accept its own report. Reclaim closes only panes Pappra\n' +
  'created for accepted, released work after re-checking live pane identity; accept and\n' +
  'dispatch run the same check automatically. Nothing here launches a session,\n' +
  'consumes a notification, or proves execution.';

export const WORKFLOW_ACTIONS = [
  'prepare',
  'dispatch',
  'ack',
  'report',
  'accept',
  'release',
  'reclaim',
  'adopt',
  'inspect',
] as const;

export type WorkflowCliAction = (typeof WORKFLOW_ACTIONS)[number];

export interface CollaborationWorkflowOptions {
  readonly action: WorkflowCliAction | null;
  readonly requestFile: string | null;
  readonly taskRoot: string | null;
  readonly limit: number | null;
  readonly apply: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

export interface CollaborationWorkflowParse {
  readonly options: CollaborationWorkflowOptions;
  readonly errors: readonly string[];
}

export function parseCollaborationWorkflowArgs(
  argv: readonly string[],
): CollaborationWorkflowParse {
  const errors: string[] = [];
  let action: WorkflowCliAction | null = null;
  let requestFile: string | null = null;
  let taskRoot: string | null = null;
  let limit: number | null = null;
  let apply = false;
  let json = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--apply') {
      if (apply) errors.push('--apply may be given only once.');
      apply = true;
      continue;
    }
    if (arg === '--json') {
      if (json) errors.push('--json may be given only once.');
      json = true;
      continue;
    }
    if (arg === '--request' || arg === '--goal') {
      if (requestFile !== null)
        errors.push('--request (or its --goal alias) may be given only once.');
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--'))
        errors.push(`${arg} requires an absolute request path.`);
      else {
        requestFile = value;
        index += 1;
      }
      continue;
    }
    if (arg === '--task-root') {
      if (taskRoot !== null) errors.push('--task-root may be given only once.');
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--'))
        errors.push('--task-root requires an absolute task root.');
      else {
        taskRoot = value;
        index += 1;
      }
      continue;
    }
    if (arg === '--limit') {
      if (limit !== null) errors.push('--limit may be given only once.');
      const value = argv[index + 1];
      const parsedLimit = value === undefined ? NaN : Number(value);
      if (
        !Number.isInteger(parsedLimit) ||
        parsedLimit < 1 ||
        parsedLimit > 500
      )
        errors.push('--limit requires an integer from 1 to 500.');
      else {
        limit = parsedLimit;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('-')) {
      errors.push(`unknown option: ${arg}`);
      continue;
    }
    if (action !== null) {
      errors.push(`unexpected argument: ${arg}`);
      continue;
    }
    if (!WORKFLOW_ACTIONS.includes(arg as WorkflowCliAction)) {
      errors.push(
        `unknown workflow action: ${arg} (expected ${WORKFLOW_ACTIONS.join(', ')})`,
      );
      continue;
    }
    action = arg as WorkflowCliAction;
  }
  return {
    options: { action, requestFile, taskRoot, limit, apply, json, help },
    errors,
  };
}

function invalid(
  output: CliOutput,
  json: boolean,
  errors: readonly string[],
): number {
  if (json)
    output.stdout(
      `${JSON.stringify({ schema: 'pappra/collab-workflow-result/1', ok: false, status: 'invalid', action: null, errors })}\n`,
    );
  else {
    output.stdout('Collaboration workflow request invalid.\n');
    for (const error of errors) output.stdout(`  - ${error}\n`);
    output.stdout(`\n${collaborationWorkflowUsage}\n`);
  }
  return 2;
}

function emitPlan(
  output: CliOutput,
  json: boolean,
  plan: WorkflowPlan,
): number {
  if (json) output.stdout(`${JSON.stringify(plan)}\n`);
  else {
    output.stdout(`Workflow ${plan.action} plan: ${plan.status}\n`);
    output.stdout(
      `  task ${plan.task_id ?? 'unknown'} at ${plan.task_root ?? 'unknown'}\n`,
    );
    for (const item of plan.assignments)
      output.stdout(
        `  ${item.role} ${item.subtask_id}#${item.attempt} -> ${item.assignee.agent_id} (${item.deferred ? 'deferred' : 'active'}) assignment ${item.assignment_digest === null ? '(unsealed; declaration ' + item.declaration_digest.slice(0, 19) + '…)' : item.assignment_digest.slice(0, 19) + '…'}\n`,
      );
    for (const blocker of plan.blockers)
      output.stdout(`  blocker ${blocker.code}: ${blocker.detail}\n`);
    for (const warning of plan.warnings) output.stdout(`  note: ${warning}\n`);
    output.stdout('  plan only: nothing was sealed, claimed or notified.\n');
  }
  // Exit status follows the honest `ok`/status pair, not `status` alone: a plan is a
  // success only when it is genuinely planned.
  return plan.status === 'planned' ? 0 : 1;
}

function emitResult(
  output: CliOutput,
  json: boolean,
  result: WorkflowResult,
): number {
  if (json) output.stdout(`${JSON.stringify(result)}\n`);
  else {
    output.stdout(
      `Workflow ${result.action} ${result.apply ? 'apply' : 'plan'}: ${result.status}${result.task_id === null ? '' : ` (${result.task_id})`}\n`,
    );
    if (result.state_revision !== null)
      output.stdout(`  record revision ${result.state_revision}\n`);
    if (result.principal !== null)
      output.stdout(
        `  caller ${result.principal.agent_id}/${result.principal.session_id} as ${result.principal.role}\n`,
      );
    for (const message of result.messages)
      output.stdout(
        `  ${message.type} ${message.message_id}: ${message.registration ?? 'unknown'}${message.duplicate ? ' (duplicate)' : ''}, delivery ${message.delivery}\n`,
      );
    for (const claim of result.claims)
      output.stdout(`  claim ${claim.action} ${claim.claim_id}\n`);
    for (const native of result.native)
      output.stdout(
        `  ${native.subtask_id}#${native.attempt}: native observation ${native.observation}, card ${native.card}\n`,
      );
    for (const blocker of result.blockers)
      output.stdout(`  blocker ${blocker.code}: ${blocker.detail}\n`);
    for (const warning of result.warnings)
      output.stdout(`  note: ${warning}\n`);
    if (result.next_action !== null)
      output.stdout(`  next: ${result.next_action}\n`);
  }
  // The JSON body carries `ok`, the human line carries `status`; the exit code must agree
  // with both. `ok` is the authority here, so `status:"applied"` with `ok:false` is a
  // failure and a `status:"needs-reconciliation"` result can never exit 0.
  return result.ok ? 0 : 1;
}

export async function runCollaborationWorkflowCli(
  argv: readonly string[],
  output: CliOutput,
): Promise<number> {
  const parsed = parseCollaborationWorkflowArgs(argv);
  const { options, errors } = parsed;
  if (options.help) {
    output.stdout(`${collaborationWorkflowUsage}\n`);
    return 0;
  }
  if (errors.length > 0) return invalid(output, options.json, errors);
  if (options.action === null)
    return invalid(output, options.json, ['a workflow action is required']);

  if (options.action === 'inspect') {
    if (options.taskRoot === null)
      return invalid(output, options.json, ['inspect requires --task-root']);
    if (options.requestFile !== null)
      return invalid(output, options.json, [
        'inspect takes no --request; pass --task-root.',
      ]);
    const result = await inspectWorkflow(
      options.taskRoot,
      options.limit === null ? {} : { limit: options.limit },
    );
    return emitResult(output, options.json, result);
  }

  if (options.limit !== null)
    return invalid(output, options.json, [
      '--limit is accepted only by inspect.',
    ]);
  if (options.requestFile === null)
    return invalid(output, options.json, [
      `${options.action} requires --request <absolute request file>`,
    ]);
  if (options.taskRoot !== null)
    return invalid(output, options.json, [
      '--task-root is not accepted here; the request declares task_root.',
    ]);

  if (options.action === 'prepare') {
    const request = loadPrepareRequest(options.requestFile);
    if (!request.ok) return invalid(output, options.json, [request.message]);
    if (!options.apply) {
      const planned = planPrepare(request.value);
      if (!planned.ok) return invalid(output, options.json, [planned.message]);
      return emitPlan(output, options.json, planned.value.plan);
    }
    const result = await applyPrepare(request.value);
    return emitResult(output, options.json, result);
  }

  if (options.action === 'dispatch') {
    const request = loadDispatchRequest(options.requestFile);
    if (!request.ok) return invalid(output, options.json, [request.message]);
    const result = await applyDispatch(request.value, { apply: options.apply });
    return emitResult(output, options.json, result);
  }

  if (options.action === 'accept') {
    if (acceptRequestKind(options.requestFile) === 'batch') {
      const batch = loadAcceptBatchRequest(options.requestFile);
      if (!batch.ok) return invalid(output, options.json, [batch.message]);
      return emitResult(
        output,
        options.json,
        await applyAcceptBatch(batch.value, { apply: options.apply }),
      );
    }
    const request = loadAcceptRequest(options.requestFile);
    if (!request.ok) return invalid(output, options.json, [request.message]);
    const result = await applyAccept(request.value, { apply: options.apply });
    return emitResult(output, options.json, result);
  }

  if (options.action === 'adopt') {
    const request = loadAdoptRequest(options.requestFile);
    if (!request.ok) return invalid(output, options.json, [request.message]);
    const result = await applyAdopt(request.value, {
      apply: options.apply,
      callerCodexThread: process.env['CODEX_THREAD_ID'] ?? null,
    });
    return emitResult(output, options.json, result);
  }

  if (options.action === 'reclaim') {
    const request = loadReclaimRequest(options.requestFile);
    if (!request.ok) return invalid(output, options.json, [request.message]);
    const result = await applyReclaim(request.value, { apply: options.apply });
    return emitResult(output, options.json, result);
  }

  const request = loadParticipantRequest(options.requestFile);
  if (!request.ok) return invalid(output, options.json, [request.message]);
  if (request.value.action !== options.action)
    return invalid(output, options.json, [
      `request action ${request.value.action} does not match the invoked action ${options.action}`,
    ]);
  const result = await applyParticipant(request.value, {
    apply: options.apply,
  });
  return emitResult(output, options.json, result);
}
