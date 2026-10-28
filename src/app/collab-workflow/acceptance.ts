import {
  buildMessage,
  contentDigest,
  readRegisteredMessage,
} from '../../collab/envelope.js';
import {
  coordinatorLineage,
  hasSuccession,
  judgeEvidence,
  lineageContains,
} from '../../collab/lineage.js';
import { submitMessage } from '../../collab/messages.js';
import { notifyRegisteredMessage } from '../collab-notify.js';
import {
  reclaimOwnedPanes,
  type PaneReclaimEntry,
  type PaneReclaimOptions,
} from '../collab-pane-reclaim.js';
import { workflowBindingPath } from '../../schemas/collab-workflow.js';
import { validateWorkPlan } from '../../collab/work-plan.js';
import { workflowWorkPlanPath } from '../../schemas/collab-workflow.js';
import { digestText, readRecord } from '../../collab/store.js';
import {
  openWorkflowTask,
  readBoundedJson,
  revalidateWorkflowTask,
  resolveAttempt,
  sameCoordinator,
  sameIdentity,
} from './context.js';
import {
  emptyResult,
  type WorkflowBlocker,
  type WorkflowResult,
} from './types.js';

/**
 * Coordinator acceptance.
 *
 * Acceptance is a separate, explicit decision and never follows from a report. The emitted
 * ANSWER envelope carries the exact payload the work-plan evaluator already re-derives:
 * plan id, node id, assignment id, attempt, input revision, the digest of the accepted
 * report and the decision. A writer cannot accept its own report, and a non-coordinator
 * caller is refused before any envelope is built.
 */
export async function applyAccept(
  request: import('../../schemas/collab-workflow.js').WorkflowAcceptRequest,
  options: {
    readonly clock?: number;
    readonly apply?: boolean;
    readonly notify?: typeof notifyRegisteredMessage;
    readonly reclaimOps?: PaneReclaimOptions['ops'];
  } = {},
): Promise<
  WorkflowResult<{
    report_message_id: string;
    report_digest: string;
    pane_reclaim: readonly PaneReclaimEntry[];
  }>
> {
  type Detail = {
    report_message_id: string;
    report_digest: string;
    pane_reclaim: readonly PaneReclaimEntry[];
  };
  const writing = options.apply !== false;
  const base = emptyResult<Detail>('accept', writing);
  const opened = await openWorkflowTask(request.task_root);
  if (!opened.ok)
    return {
      ...base,
      status: 'invalid',
      blockers: [
        {
          code: opened.code,
          detail: opened.message,
          next_action: opened.nextAction,
        },
      ],
      next_action: opened.nextAction,
    };
  const task = opened.value;
  const record = task.record;
  const blockers: WorkflowBlocker[] = [];
  // Delivery is reported separately: an undelivered decision is still recorded, never rolled back.
  const warnings: string[] = [];
  const attempt = resolveAttempt(record, request.subtask_id, request.attempt);
  if (attempt === null)
    blockers.push({
      code: 'attempt_not_registered',
      detail: `${request.subtask_id}#${request.attempt} is not a registered attempt.`,
      next_action:
        'Inspect the record; acceptance never addresses an attempt that does not exist.',
    });
  // After a coordinator succession the epochs of the same authority line are all current evidence
  // (docs/mid-cohort-succession-spec.md); without one, every check below is today's equality.
  const lineage = coordinatorLineage(record);
  const succession = hasSuccession(lineage);
  if (!sameCoordinator(record.coordinator, request.caller))
    blockers.push({
      code: 'accept_not_coordinator',
      detail: 'Only the current coordinator identity may accept a report.',
      next_action:
        'Acceptance comes from the coordinator, never from a writer or a peer.',
    });
  if (attempt !== null && sameIdentity(attempt.assignee, request.caller))
    blockers.push({
      code: 'acceptance_self_review',
      detail: 'A writer cannot accept its own report.',
      next_action: 'Ask the coordinator to accept it.',
    });
  if (attempt !== null && record.coordinator !== null) {
    const epoch = record.coordinator.owner_epoch;
    if (
      attempt.owner_epoch !== null &&
      (succession
        ? !lineageContains(lineage, attempt.owner_epoch)
        : attempt.owner_epoch !== epoch)
    )
      blockers.push({
        code: 'acceptance_stale',
        detail: `Attempt was registered under epoch ${attempt.owner_epoch}, current epoch is ${epoch}.`,
        next_action:
          'Reconcile ownership before accepting; a stale acceptance unlocks nothing.',
      });
  }

  // The plan is the only source of node identity. A caller cannot name a node the sealed
  // plan does not contain, and acceptance never targets an invented plan id.
  const planRead = readBoundedJson(
    workflowWorkPlanPath(task.taskRoot),
    'work plan',
  );
  let planId: string | null = null;
  let nodeId: string | null = null;
  if (!planRead.ok)
    blockers.push({
      code: 'work_plan_missing',
      detail: planRead.message,
      next_action:
        'Re-run workflow prepare apply so the derived work plan exists; acceptance needs the real node.',
    });
  else {
    const validated = validateWorkPlan(planRead.value);
    if (!validated.ok)
      blockers.push({
        code: 'work_plan_invalid',
        detail: validated.diagnostics.map((item) => item.code).join(', '),
        next_action:
          'Inspect the sealed work plan; acceptance never repairs it.',
      });
    else {
      const node = validated.plan.nodes.find(
        (item) =>
          item.assignment_id === request.subtask_id &&
          item.attempt === request.attempt,
      );
      if (node === undefined)
        blockers.push({
          code: 'plan_node_unknown',
          detail: `The sealed plan has no node for ${request.subtask_id}#${request.attempt}.`,
          next_action:
            'Accept only a node the sealed plan declares; the plan is derived by prepare, not by the request.',
        });
      else if (
        succession
          ? !lineageContains(lineage, validated.plan.owner_epoch)
          : validated.plan.owner_epoch !==
            (record.coordinator?.owner_epoch ?? 0)
      )
        blockers.push({
          code: 'plan_epoch_stale',
          detail: `Plan epoch ${validated.plan.owner_epoch} is not the current owner epoch.`,
          next_action: 'Re-prepare under the current coordinator epoch.',
        });
      else {
        planId = validated.plan.plan_id;
        nodeId = node.node_id;
      }
    }
  }

  const report =
    attempt === null
      ? null
      : readRegisteredMessage(task.taskRoot, request.report_message_id);
  if (report === null)
    blockers.push({
      code: 'report_not_registered',
      detail: `Report ${request.report_message_id} is not a registered envelope.`,
      next_action:
        'Accept exactly the report that is registered for this attempt.',
    });
  else {
    if (report.type !== 'REPORT')
      blockers.push({
        code: 'report_not_a_report',
        detail: `${report.message_id} is a ${report.type}, not a REPORT.`,
        next_action: 'Acceptance targets a report, not an arbitrary message.',
      });
    if (
      report.subtask_id !== request.subtask_id ||
      report.attempt !== request.attempt
    )
      blockers.push({
        code: 'acceptance_mismatch',
        detail: `Report ${report.message_id} belongs to ${String(report.subtask_id)}#${String(report.attempt)}.`,
        next_action: 'Match the acceptance to the attempt it decides.',
      });
    if (report.body?.status !== 'completed')
      blockers.push({
        code: 'report_not_acceptable',
        detail: `Report status is ${String(report.body?.status)}; only completed reports can be accepted.`,
        next_action:
          'A needs_input, failed or cancelled report is reported honestly and never accepted as a pass.',
      });
  }

  // A valid applied decision for a report is final after a succession: the successor does not
  // re-decide it, and a decision that fails the evidence rules does not count.
  if (succession && report !== null) {
    for (const entry of record.messages) {
      if (
        entry.type !== 'ANSWER' ||
        entry.state !== 'applied' ||
        entry.reply_to !== report.message_id
      )
        continue;
      const decided = readRegisteredMessage(task.taskRoot, entry.message_id);
      if (decided === null) {
        blockers.push({
          code: 'acceptance_decision_unreadable',
          detail: `Applied decision ${entry.message_id} has no readable registered envelope.`,
          next_action:
            'Inspect the registered decision set before deciding again.',
        });
        break;
      }
      if (
        (decided.body as Record<string, unknown> | undefined)?.[
          'acceptance'
        ] === undefined
      )
        continue;
      if (
        typeof entry.owner_epoch === 'number' &&
        judgeEvidence(lineage, {
          epoch: entry.owner_epoch,
          signer: entry.from,
          appliedAt: entry.applied_at,
        }).valid
      ) {
        blockers.push({
          code: 'acceptance_already_decided',
          detail: `Report ${report.message_id} already has the valid applied decision ${entry.message_id}.`,
          next_action:
            'A valid decision made under an earlier coordinator stands; the successor does not decide it again.',
        });
        break;
      }
    }
  }

  if (
    blockers.length > 0 ||
    attempt === null ||
    report === null ||
    record.coordinator === null
  ) {
    return {
      ...base,
      status: 'refused',
      task_id: record.task_id,
      task_root: task.taskRoot,
      domain_root: record.domain_root,
      state_revision: record.state_revision,
      principal: { ...request.caller, role: 'coordinator' },
      blockers,
      next_action: blockers[0]?.next_action ?? null,
    };
  }

  const changed = await revalidateWorkflowTask(task);
  if (!changed.ok)
    return {
      ...base,
      status: 'invalid',
      blockers: [
        {
          code: changed.code,
          detail: changed.message,
          next_action: changed.nextAction,
        },
      ],
      next_action: changed.nextAction,
    };

  const reportDigest = contentDigest(report);
  const baseId = `accept-${request.subtask_id}-${request.attempt}`;
  // The only collision a succession causes is a message with the base id registered under another
  // epoch that never became a valid applied decision (its coordinator stopped between register and
  // apply). Only then is the id epoch-qualified; with no succession it never is.
  const registeredBase = succession
    ? readRegisteredMessage(task.taskRoot, baseId)
    : null;
  const messageId =
    registeredBase !== null &&
    registeredBase.owner_epoch !== record.coordinator.owner_epoch
      ? `${baseId}-e${record.coordinator.owner_epoch}`
      : baseId;
  const message = buildMessage({
    type: 'ANSWER',
    task_id: record.task_id,
    from: {
      agent_id: record.coordinator.agent_id,
      session_id: record.coordinator.session_id,
      harness: record.coordinator.harness,
    },
    to: {
      agent_id: attempt.assignee.agent_id,
      session_id: attempt.assignee.session_id,
      harness: attempt.assignee.harness,
    },
    reply_to: report.message_id,
    message_id: messageId,
    subtask_id: request.subtask_id,
    attempt: request.attempt,
    owner_epoch: record.coordinator.owner_epoch,
    body: {
      status: 'completed',
      reason: request.reason,
      acceptance: {
        plan_id: planId,
        node_id: nodeId,
        assignment_id: request.subtask_id,
        attempt: request.attempt,
        input_revision: attempt.input_revision ?? record.input_revision ?? null,
        report_digest: reportDigest,
        decision: 'accepted',
      },
    },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const submitted = writing
    ? submitMessage(task.taskRoot, message, {
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      })
    : {
        ok: true as const,
        registration: { status: 'planned' },
        duplicate: false,
      };
  // Acceptance must reach the assignee through the durable notification reservation; a
  // persisted decision that nobody delivers is exactly the gap this loop exists to close.
  // A plan is read-only: the synthetic planned submission is not a duplicate, so without
  // this guard a plan would fall through into a real notification.
  let delivery = 'not-attempted';
  if (writing && submitted.ok && !(submitted.duplicate === true)) {
    const notify = options.notify ?? notifyRegisteredMessage;
    const delivered = await notify({
      taskRoot: task.taskRoot,
      messageId: message.message_id,
      bindingFile: workflowBindingPath(task.taskRoot),
      apply: true,
      retry: false,
      callerPane: request.caller_pane,
    });
    delivery = delivered.ok ? delivered.value.status : 'not-notified';
    if (!delivered.ok) warnings.push(`${delivered.code}: ${delivered.message}`);
    else if (delivered.value.status !== 'submitted')
      warnings.push(
        `delivery_${delivered.value.status}: ${String(delivered.value.detail ?? '')}`,
      );
  } else if (writing && submitted.ok) delivery = 'already-recorded';
  // A worker normally releases its claims after acceptance, so this usually keeps the pane;
  // a later dispatch or reclaim closes it. Eligibility is re-derived, never assumed.
  const paneReclaim =
    writing && submitted.ok
      ? await reclaimOwnedPanes({
          taskRoot: task.taskRoot,
          subtaskId: request.subtask_id,
          attempt: request.attempt,
          callerPane: request.caller_pane,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          ...(options.reclaimOps === undefined
            ? {}
            : { ops: options.reclaimOps }),
        })
      : [];
  const current = readRecord(task.taskRoot);
  if (!submitted.ok)
    blockers.push({
      code: String(submitted.reason),
      detail: `The protocol refused the acceptance: ${String(submitted.reason)}.`,
      next_action:
        'Inspect the registered decision set; acceptance is never force-written.',
    });
  return {
    ...base,
    status:
      blockers.length === 0 ? (writing ? 'applied' : 'planned') : 'blocked',
    ok: blockers.length === 0,
    task_id: record.task_id,
    task_root: task.taskRoot,
    domain_root: record.domain_root,
    state_revision: current?.state_revision ?? record.state_revision,
    principal: { ...request.caller, role: 'coordinator' },
    messages: [
      {
        message_id: message.message_id,
        type: 'ANSWER',
        registration: submitted.ok
          ? String(submitted.registration?.status ?? '')
          : null,
        duplicate: submitted.ok && submitted.duplicate === true,
        delivery,
        digest: message.content_digest ?? digestText(''),
      },
    ],
    blockers,
    warnings,
    next_action:
      blockers[0]?.next_action ??
      'Acceptance recorded; dependent work is unlocked only when the work plan re-derives this decision.',
    detail: {
      report_message_id: report.message_id,
      report_digest: reportDigest,
      pane_reclaim: paneReclaim,
    },
  };
}

/**
 * Applies each entry of a batch through the single-accept path, in order. There is no batch
 * authority: every entry is validated, written and notified on its own, a refused entry never
 * blocks or rewrites its neighbours, and the aggregate is `ok` only when every entry is.
 *
 * An unexpected throw is not a refusal: decisions already recorded stay recorded, the
 * remaining entries are reported as `not-attempted`, and the aggregate needs reconciliation
 * instead of losing the per-entry account.
 */
export async function applyAcceptBatch(
  request: import('../../schemas/collab-workflow.js').WorkflowAcceptBatchRequest,
  options: Parameters<typeof applyAccept>[1] = {},
): Promise<WorkflowResult<{ items: readonly AcceptBatchItem[] }>> {
  const writing = options.apply !== false;
  const base = emptyResult<{ items: readonly AcceptBatchItem[] }>(
    'accept',
    writing,
  );
  if (request.accepts.length === 0)
    return {
      ...base,
      status: 'invalid',
      blockers: [
        {
          code: 'accept_batch_empty',
          detail: 'An accept batch must name at least one report.',
          next_action: 'Name each report to decide; nothing is inferred.',
        },
      ],
      next_action: 'Name each report to decide; nothing is inferred.',
    };
  const label = (entry: { subtask_id: string; attempt: number }) =>
    `${entry.subtask_id}#${String(entry.attempt)}`;
  const items: AcceptBatchItem[] = [];
  const results: Awaited<ReturnType<typeof applyAccept>>[] = [];
  const blockers: WorkflowBlocker[] = [];
  const warnings: string[] = [];
  let threw = false;
  for (const entry of request.accepts) {
    const item = {
      subtask_id: entry.subtask_id,
      attempt: entry.attempt,
      report_message_id: entry.report_message_id,
    };
    if (threw) {
      items.push({ ...item, status: 'not-attempted', ok: false });
      continue;
    }
    // Only the four entry fields are taken from the entry; identity and root always come
    // from the batch, so no entry can substitute a different caller.
    let result: Awaited<ReturnType<typeof applyAccept>>;
    try {
      result = await applyAccept(
        {
          schema: 'pappra/collab-workflow-accept-request/1',
          task_root: request.task_root,
          caller: request.caller,
          caller_pane: request.caller_pane,
          subtask_id: entry.subtask_id,
          attempt: entry.attempt,
          report_message_id: entry.report_message_id,
          reason: entry.reason,
        },
        options,
      );
    } catch (error) {
      threw = true;
      items.push({ ...item, status: 'needs-reconciliation', ok: false });
      blockers.push({
        code: 'accept_entry_threw',
        detail: `${label(entry)}: ${error instanceof Error ? error.message : String(error)}`,
        next_action:
          'Inspect the task record; earlier entries may already be recorded and notified, and later entries were not attempted.',
      });
      continue;
    }
    results.push(result);
    items.push({ ...item, status: result.status, ok: result.ok });
    for (const blocker of result.blockers)
      blockers.push({
        ...blocker,
        detail: `${label(entry)}: ${blocker.detail}`,
      });
    for (const warning of result.warnings)
      warnings.push(`${label(entry)}: ${warning}`);
  }
  const first = results[0];
  const last = results[results.length - 1];
  const allOk = !threw && results.every((item) => item.ok);
  return {
    ...base,
    status: threw
      ? 'needs-reconciliation'
      : allOk
        ? writing
          ? 'applied'
          : 'planned'
        : 'blocked',
    ok: allOk,
    task_id: last?.task_id ?? null,
    task_root: last?.task_root ?? null,
    domain_root: last?.domain_root ?? null,
    state_revision: last?.state_revision ?? null,
    principal: first?.principal ?? null,
    messages: results.flatMap((item) => item.messages),
    blockers,
    warnings,
    next_action:
      blockers[0]?.next_action ??
      results.find((item) => !item.ok)?.next_action ??
      null,
    detail: { items },
  };
}

export interface AcceptBatchItem {
  readonly subtask_id: string;
  readonly attempt: number;
  readonly report_message_id: string;
  readonly status: string;
  readonly ok: boolean;
}
