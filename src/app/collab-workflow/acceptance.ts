import {
  buildMessage,
  contentDigest,
  readRegisteredMessage,
} from '../../collab/envelope.js';
import {
  type CoordinatorLineage,
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
import { currentBindingFile, unadoptedWarning } from './binding-generation.js';
import { validateWorkPlan } from '../../collab/work-plan.js';
import {
  type WorkflowCaller,
  workflowWorkPlanPath,
} from '../../schemas/collab-workflow.js';
import { digestText, readRecord } from '../../collab/store.js';
import type { Message, TaskRecord } from '../../collab/types.js';
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
 * What a worker can do when the coordinator recorded the decision but could not deliver it, for
 * example a sandboxed coordinator with no route to the Herdr socket. It is a plain additive object:
 * it changes neither the decision nor how it is recorded, and it grants nothing.
 */
export interface AcceptDeliveryFallback {
  readonly reason: string;
  readonly worker_next_action: string;
}

export interface AcceptDetail {
  readonly report_message_id: string;
  readonly report_digest: string;
  readonly pane_reclaim: readonly PaneReclaimEntry[];
  readonly delivery_fallback?: AcceptDeliveryFallback;
}

/**
 * Coordinator acceptance.
 *
 * Acceptance is a separate, explicit decision and never follows from a report. The emitted
 * ANSWER envelope carries the exact payload the work-plan evaluator already re-derives:
 * plan id, node id, assignment id, attempt, input revision, the digest of the accepted
 * report and the decision. A writer cannot accept its own report, and a non-coordinator
 * caller is refused before any envelope is built.
 *
 * After a succession the decision id is `accept-<subtask>-<attempt>`, qualified with the current
 * epoch only when a message under that id exists for another epoch and never became a valid
 * applied decision. When the exclusive create loses a race with such a message, the call takes the
 * qualified id once instead of reporting a conflict that a re-run would resolve, provided the
 * record as it is then still has this caller as the coordinator at the same epoch; after a
 * succession in between the call is refused and registers nothing. A decision whose
 * notification fails is still recorded; the result then names the worker-side step that needs no
 * coordinator channel.
 */
export async function applyAccept(
  request: import('../../schemas/collab-workflow.js').WorkflowAcceptRequest,
  options: {
    readonly clock?: number;
    readonly apply?: boolean;
    readonly notify?: typeof notifyRegisteredMessage;
    readonly reclaimOps?: PaneReclaimOptions['ops'];
  } = {},
): Promise<WorkflowResult<AcceptDetail>> {
  const writing = options.apply !== false;
  const base = emptyResult<AcceptDetail>('accept', writing);
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
  const unadopted = unadoptedWarning(task.taskRoot);
  if (unadopted !== null) warnings.push(unadopted);
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
    const decided = finalDecisionBlocker(
      record,
      task.taskRoot,
      lineage,
      report.message_id,
    );
    if (decided !== null) blockers.push(decided);
  }

  // One refusal for every stop before a write, whether the check ran at the start or just before a
  // second write: nothing was registered, and the blockers say why.
  const refuse = (current: TaskRecord): WorkflowResult<AcceptDetail> => ({
    ...base,
    status: 'refused',
    task_id: current.task_id,
    task_root: task.taskRoot,
    domain_root: current.domain_root,
    state_revision: current.state_revision,
    principal: { ...request.caller, role: 'coordinator' },
    blockers,
    next_action: blockers[0]?.next_action ?? null,
  });

  if (
    blockers.length > 0 ||
    attempt === null ||
    report === null ||
    record.coordinator === null
  ) {
    return refuse(record);
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
  const coordinator = record.coordinator;
  const baseId = `accept-${request.subtask_id}-${request.attempt}`;
  const qualifiedId = `${baseId}-e${coordinator.owner_epoch}`;
  // The only collision a succession causes is a message with the base id registered under another
  // epoch that never became a valid applied decision (its coordinator stopped between register and
  // apply). Only then is the id epoch-qualified; with no succession it never is.
  const underOtherEpoch = (registered: Message | null) =>
    registered !== null && registered.owner_epoch !== coordinator.owner_epoch;
  const registeredBase = succession
    ? readRegisteredMessage(task.taskRoot, baseId)
    : null;
  const messageId = underOtherEpoch(registeredBase) ? qualifiedId : baseId;
  const decide = (id: string): Message =>
    buildMessage({
      type: 'ANSWER',
      task_id: record.task_id,
      from: {
        agent_id: coordinator.agent_id,
        session_id: coordinator.session_id,
        harness: coordinator.harness,
      },
      to: {
        agent_id: attempt.assignee.agent_id,
        session_id: attempt.assignee.session_id,
        harness: attempt.assignee.harness,
      },
      reply_to: report.message_id,
      message_id: id,
      subtask_id: request.subtask_id,
      attempt: request.attempt,
      owner_epoch: coordinator.owner_epoch,
      body: {
        status: 'completed',
        reason: request.reason,
        acceptance: {
          plan_id: planId,
          node_id: nodeId,
          assignment_id: request.subtask_id,
          attempt: request.attempt,
          input_revision:
            attempt.input_revision ?? record.input_revision ?? null,
          report_digest: reportDigest,
          decision: 'accepted',
        },
      },
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
  const submit = (decision: Message) =>
    submitMessage(task.taskRoot, decision, {
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
  let message = decide(messageId);
  let submitted = writing
    ? submit(message)
    : {
        ok: true as const,
        registration: { status: 'planned' },
        duplicate: false,
      };
  // The id was chosen from what was registered a moment ago. If the exclusive create still loses to
  // a message under the base id that appeared in between, and that message sits under another
  // epoch, it is the collision handled above: take the epoch-qualified id once instead of leaving
  // a re-run to do it. Only the epoch triggers this. A content-only difference at the current
  // epoch, a winner that cannot be read, a one-entry lineage and a winner that already is a valid
  // applied decision all keep `content_conflict`.
  if (
    writing &&
    succession &&
    messageId === baseId &&
    !submitted.ok &&
    submitted.reason === 'content_conflict' &&
    submitted.registration.status === 'content_conflict' &&
    underOtherEpoch(readRegisteredMessage(task.taskRoot, baseId))
  ) {
    // This is a second write: revalidate first, and read the record as it is now, because a
    // decision that is final may have been applied, or the coordinator may have changed, while
    // this call was running.
    const stale = await revalidateWorkflowTask(task);
    if (!stale.ok)
      blockers.push({
        code: stale.code,
        detail: stale.message,
        next_action: stale.nextAction,
      });
    else {
      const fresh = readRecord(task.taskRoot);
      if (fresh !== null) {
        // Authority is derived again from this record, never carried over from the start of the
        // call: after a succession that completed in between, this caller or its epoch no longer
        // decides, and a qualified id would hold a decision nobody may make. Nothing is registered.
        const lineageNow = coordinatorLineage(fresh);
        const moved = authorityBlocker(
          fresh,
          lineageNow,
          request.caller,
          coordinator.owner_epoch,
        );
        if (moved !== null) {
          blockers.push(moved);
          return refuse(fresh);
        }
        const decided = finalDecisionBlocker(
          fresh,
          task.taskRoot,
          lineageNow,
          report.message_id,
        );
        if (decided !== null) blockers.push(decided);
        else {
          message = decide(qualifiedId);
          submitted = submit(message);
        }
      }
    }
  }
  // Acceptance must reach the assignee through the durable notification reservation; a
  // persisted decision that nobody delivers is exactly the gap this loop exists to close.
  // A plan is read-only: the synthetic planned submission is not a duplicate, so without
  // this guard a plan would fall through into a real notification.
  let delivery = 'not-attempted';
  let deliveryFallback: AcceptDeliveryFallback | null = null;
  if (writing && submitted.ok && !(submitted.duplicate === true)) {
    const notify = options.notify ?? notifyRegisteredMessage;
    const delivered = await notify({
      taskRoot: task.taskRoot,
      messageId: message.message_id,
      bindingFile: currentBindingFile(task.taskRoot),
      apply: true,
      retry: false,
      callerPane: request.caller_pane,
    });
    delivery = delivered.ok ? delivered.value.status : 'not-notified';
    const undelivered = delivered.ok
      ? delivered.value.status === 'submitted'
        ? null
        : `delivery_${delivered.value.status}: ${String(delivered.value.detail ?? '')}`
      : `${delivered.code}: ${delivered.message}`;
    if (undelivered !== null) {
      warnings.push(undelivered);
      // The decision stays recorded as it is; this only tells the worker how to learn of it
      // without the coordinator's channel.
      deliveryFallback = {
        reason: undelivered,
        worker_next_action: workerAwaitAction(
          task.taskRoot,
          request.subtask_id,
          request.attempt,
          message.message_id,
        ),
      };
    }
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
      ...(deliveryFallback === null
        ? {}
        : { delivery_fallback: deliveryFallback }),
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
    const fallback = result.detail?.delivery_fallback;
    items.push({
      ...item,
      status: result.status,
      ok: result.ok,
      ...(fallback === undefined ? {} : { delivery_fallback: fallback }),
    });
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
  readonly delivery_fallback?: AcceptDeliveryFallback;
}

/**
 * After a succession a valid applied decision for a report is final: the successor does not decide
 * it again, and an applied decision that fails the evidence rules does not count. Decisions are
 * found by `reply_to`, never by constructed id, so an epoch-qualified one is found like any other.
 * Returns the blocker that keeps the successor from deciding, or `null`.
 */
function finalDecisionBlocker(
  record: TaskRecord,
  taskRoot: string,
  lineage: CoordinatorLineage,
  reportMessageId: string,
): WorkflowBlocker | null {
  for (const entry of record.messages) {
    if (
      entry.type !== 'ANSWER' ||
      entry.state !== 'applied' ||
      entry.reply_to !== reportMessageId
    )
      continue;
    const decided = readRegisteredMessage(taskRoot, entry.message_id);
    if (decided === null)
      return {
        code: 'acceptance_decision_unreadable',
        detail: `Applied decision ${entry.message_id} has no readable registered envelope.`,
        next_action:
          'Inspect the registered decision set before deciding again.',
      };
    if (
      (decided.body as Record<string, unknown> | undefined)?.['acceptance'] ===
      undefined
    )
      continue;
    if (
      typeof entry.owner_epoch === 'number' &&
      judgeEvidence(lineage, {
        epoch: entry.owner_epoch,
        signer: entry.from,
        appliedAt: entry.applied_at,
      }).valid
    )
      return {
        code: 'acceptance_already_decided',
        detail: `Report ${reportMessageId} already has the valid applied decision ${entry.message_id}.`,
        next_action:
          'A valid decision made under an earlier coordinator stands; the successor does not decide it again.',
      };
  }
  return null;
}

/**
 * What a second write must still find on the record: the caller as the current coordinator, at the
 * epoch the decision is stamped with, in a lineage that still shows the succession. Returns the
 * refusal that stops the write, using the codes and next actions of the checks at the start, or
 * `null`.
 */
function authorityBlocker(
  record: TaskRecord,
  lineage: CoordinatorLineage,
  caller: WorkflowCaller,
  epoch: number,
): WorkflowBlocker | null {
  const current = record.coordinator;
  if (current === null || !sameCoordinator(current, caller))
    return {
      code: 'accept_not_coordinator',
      detail:
        'Only the current coordinator identity may accept a report; the coordinator changed while this decision was being recorded, so nothing was registered.',
      next_action:
        'Acceptance comes from the coordinator, never from a writer or a peer.',
    };
  if (current.owner_epoch !== epoch || !hasSuccession(lineage))
    return {
      code: 'acceptance_stale',
      detail:
        current.owner_epoch !== epoch
          ? `This accept began under epoch ${epoch} and the record is now at epoch ${current.owner_epoch}, so nothing was registered.`
          : 'The coordinator lineage no longer shows the succession this accept began under, so nothing was registered.',
      next_action:
        'Reconcile ownership before accepting; a stale acceptance unlocks nothing.',
    };
  return null;
}

/**
 * The worker-side step that needs no coordinator channel: a read-only bounded wait on the persisted
 * record for this attempt's decision, then the worker's own release. Waiting writes nothing, grants
 * nothing and is not acceptance.
 */
function workerAwaitAction(
  taskRoot: string,
  subtaskId: string,
  attempt: number,
  decisionId: string,
): string {
  return (
    'As the assignee, run `collab workflow await` (request document ' +
    `pappra/collab-workflow-await-request/1 for ${taskRoot}, ${subtaskId}#${attempt}) until it ` +
    `reports decision ${decisionId}, then run \`collab workflow release\` correlating to ` +
    `${decisionId}.`
  );
}
