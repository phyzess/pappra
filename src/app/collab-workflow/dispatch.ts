import path from 'node:path';
import { lstatSync } from 'node:fs';
import {
  isAssignment,
  isCard,
  type CapabilityCard,
} from '../../collab/contracts.js';
import { preflight } from '../../collab/preflight.js';
import {
  evaluateWorkPlan,
  validateWorkPlan,
  type WorkPlanEvaluation,
} from '../../collab/work-plan.js';
import { deriveCapabilityCard } from '../capability-evidence/index.js';
import { ACTIVE_STATES, findAttempt } from '../../collab/lifecycle.js';
import {
  createHerdrWorkExecutionAdapter,
  type WorkExecutionAdapter,
} from '../collab-work-execution.js';
import { submitMessage } from '../../collab/messages.js';
import {
  buildMessage,
  contentDigest,
  isSafeMessageId,
  readRegisteredMessage,
  validateEnvelope,
} from '../../collab/envelope.js';
import { activeClaims, claimResources } from '../../collab/resources.js';
import { claimCovers } from '../../collab/admission.js';
import { describeResource } from '../../collab/canonical.js';
import { readRecord } from '../../collab/store.js';
import type { Message } from '../../collab/types.js';
import {
  workflowAssignmentPath,
  workflowBindingPath,
  workflowIntentsDir,
  workflowManifestPath,
  workflowWorkPlanPath,
  type WorkflowDispatchRequest,
  type WorkflowDispatchTarget,
} from '../../schemas/collab-workflow.js';
import {
  digestFile,
  assertRealChain,
  openWorkflowTask,
  readBoundedDocument,
  readBoundedJson,
  revalidateWorkflowTask,
  sameCoordinator,
  writeJsonExclusive,
} from './context.js';
import {
  emptyResult,
  workflowFailure,
  type WorkflowBlocker,
  type WorkflowOutcome,
  type WorkflowResult,
} from './types.js';
import type { TaskRecord } from '../../collab/types.js';

/**
 * Dispatch: notify one registered assignment through its observed binding.
 *
 * Dispatch never starts, adopts or trusts an execution. It re-derives the ACTUAL current
 * capability card immediately before notification, refuses a card whose recorded evidence
 * no longer matches the bytes on disk, and records one durable intent per attempt so an
 * unknown delivery is reconciled instead of replayed.
 */

interface DispatchNodeState {
  readonly subtask_id: string;
  readonly attempt: number;
  readonly state: string;
  readonly assignee: {
    readonly agent_id: string;
    readonly session_id: string;
    readonly harness: string;
  };
  readonly card: CapabilityCard | null;
  readonly card_file: string | null;
  readonly card_state: string;
  readonly blockers: readonly WorkflowBlocker[];
  readonly evidence_checked: number;
}

interface DeclaredResource {
  readonly path: string;
  readonly access: string;
  readonly scope?: 'file' | 'tree';
  readonly resource_epoch?: number;
}

/**
 * Exact live coverage for one registered attempt.
 *
 * Counting any active claim would let an unrelated claim authorize a different resource or
 * a stale epoch, so every declared resource must be covered by a live claim of that same
 * holder/subtask/attempt, and a write footprint must carry the very epoch the sealed
 * document pinned. The coverage relation itself is the shared `claimCovers` validator the
 * launch admission path uses; no second admission engine is introduced here.
 */
function claimCoverageBlockers(
  record: TaskRecord,
  subtaskId: string,
  attempt: number,
  assignee: { readonly agent_id: string; readonly session_id: string },
  resources: readonly DeclaredResource[],
): WorkflowBlocker[] {
  const blockers: WorkflowBlocker[] = [];
  const live = activeClaims(record).filter(
    (claim) =>
      claim.subtask_id === subtaskId &&
      claim.attempt === attempt &&
      claim.holder?.agent_id === assignee.agent_id &&
      claim.holder?.session_id === assignee.session_id,
  );
  for (const resource of resources) {
    // `describeResource` is the same canonical descriptor the claim engine persists, so
    // `claimCovers` compares like with like instead of a hand-built key.
    const requested = describeResource({
      kind: 'path',
      path: resource.path,
      ...(resource.scope === 'file' ? { scope: 'file' } : {}),
    });
    const covering = live.filter((claim) => claimCovers(claim, requested));
    const usable = covering.filter(
      (claim) =>
        resource.access !== 'write' ||
        (claim.access === 'write' &&
          Number.isSafeInteger(claim.resource_epoch) &&
          resource.resource_epoch !== undefined &&
          claim.resource_epoch === resource.resource_epoch),
    );
    if (usable.length === 0) {
      blockers.push({
        code:
          covering.length === 0
            ? 'claim_coverage_missing'
            : 'claim_coverage_epoch_mismatch',
        detail:
          covering.length === 0
            ? `${subtaskId}#${attempt} holds no live claim covering ${resource.path} (${resource.access}).`
            : `${subtaskId}#${attempt} holds no live ${resource.access} claim for ${resource.path} at the sealed epoch ${String(resource.resource_epoch ?? 'unpinned')}.`,
        next_action:
          'Re-run workflow prepare apply so the attempt owns exactly the declared footprint and epoch; a different live claim never stands in for it.',
      });
    }
  }
  return blockers;
}

function resolveCardTarget(
  target: WorkflowDispatchTarget,
  assignmentFile: string,
  assignee: { readonly harness: string | null | undefined },
  now: number,
  maxAgeMinutes: number,
): {
  card: CapabilityCard | null;
  state: string;
  blockers: WorkflowBlocker[];
  resources: DeclaredResource[];
} {
  const blockers: WorkflowBlocker[] = [];
  const assignmentRead = readBoundedJson(assignmentFile, 'sealed assignment');
  if (!assignmentRead.ok)
    return {
      card: null,
      state: 'unreadable-assignment',
      resources: [],
      blockers: [
        {
          code: 'sealed_assignment_unreadable',
          detail: assignmentRead.message,
          next_action:
            'Re-run workflow prepare apply so the sealed assignment exists.',
        },
      ],
    };
  if (!isAssignment(assignmentRead.value))
    return {
      card: null,
      state: 'invalid-assignment',
      resources: [],
      blockers: [
        {
          code: 'sealed_assignment_invalid',
          detail:
            'The sealed assignment does not satisfy harness-collab/assignment/1.',
          next_action:
            'Inspect the sealed assignment; dispatch never repairs it.',
        },
      ],
    };
  const contract = assignmentRead.value;
  const declaredResources: DeclaredResource[] = contract.resources.map(
    (resource) => ({
      path: String(resource.path),
      access: resource.access === 'write' ? 'write' : 'read',
      ...(Number.isSafeInteger(resource.resource_epoch) &&
      (resource.resource_epoch ?? 0) > 0
        ? { resource_epoch: resource.resource_epoch }
        : {}),
    }),
  );

  let card: CapabilityCard | null = null;
  let state = 'absent';
  if (target.capabilities_file !== null) {
    const read = readBoundedJson(target.capabilities_file, 'capability card');
    if (!read.ok)
      blockers.push({
        code: 'capability_card_unreadable',
        detail: read.message,
        next_action: 'Re-derive the card or fix the supplied path.',
      });
    else if (!isCard(read.value))
      blockers.push({
        code: 'capability_card_invalid',
        detail:
          'The supplied card does not satisfy the capability card contract.',
        next_action: 'Re-derive the card from observed native evidence.',
      });
    else {
      card = read.value;
      state = 'explicit';
    }
  } else {
    // Fresh derivation from the declared observed native source. Never reuse an old card
    // and call it re-derived: the derivation reads the source bytes right now. The harness
    // is the assignee's, and the documented source form decides the derivation mode: a Pi
    // `session_file` with no execution record is live native evidence, while Codex and
    // Claude need their real `execution_file` exactly as the shared validator requires.
    const harness =
      assignee.harness === 'pi' ||
      assignee.harness === 'codex' ||
      assignee.harness === 'claude'
        ? assignee.harness
        : null;
    if (harness === null)
      return {
        card: null,
        state: 'unsupported-harness',
        resources: declaredResources,
        blockers: [
          {
            code: 'capability_harness_unsupported',
            detail: `The registered assignee harness ${String(assignee.harness ?? '(unset)')} has no capability deriver.`,
            next_action:
              'Register the attempt with a supported harness (pi, codex or claude), or pass an explicit capabilities_file.',
          },
        ],
      };
    const derived = deriveCapabilityCard({
      harness,
      assignmentFile,
      templateFile: target.template_file as string,
      ...(target.session_file === null
        ? {}
        : { sessionFile: target.session_file }),
      ...(target.events_file === null
        ? {}
        : { eventsFile: target.events_file }),
      ...(target.execution_file === null
        ? {}
        : { executionFile: target.execution_file }),
      live: harness === 'pi' && target.execution_file === null,
    });
    if (!derived.ok || derived.card === undefined) {
      const detail = (
        derived.errors ??
        derived.blockers ?? ['derivation_failed']
      ).join(', ');
      blockers.push({
        code: 'capability_derivation_unavailable',
        detail: `Cannot derive a current card for ${target.subtask_id}#${target.attempt}: ${detail}.`,
        next_action:
          harness === 'pi'
            ? 'Pass template_file with the observed session_file for a Pi assignee, or supply an explicit capabilities_file that passes preflight.'
            : `Pass template_file with the observed events_file and a real execution_file for a ${harness} assignee, or supply an explicit capabilities_file that passes preflight.`,
      });
    } else {
      card = derived.card;
      state = 'derived';
    }
  }
  if (card === null)
    return { card: null, state, blockers, resources: declaredResources };

  if (assignee.harness != null && card.harness !== assignee.harness)
    blockers.push({
      code: 'capability_card_harness_mismatch',
      detail: `Card harness ${card.harness} does not match the registered assignee harness ${assignee.harness}.`,
      next_action: 'Derive the card with the assignee harness.',
    });
  const verdict = preflight(contract, card, { now, maxAgeMinutes });
  if (verdict.status !== 'ready') {
    for (const check of verdict.blockers)
      blockers.push({
        code: check.code,
        detail: `Preflight blocked ${target.subtask_id}#${target.attempt}${check.capability === undefined ? '' : ` on ${check.capability}`}.`,
        next_action:
          check.code === 'capabilities_stale' ||
          check.code === 'capabilities_from_future' ||
          check.code === 'runtime_capabilities_unconfirmed'
            ? 'Re-run capability derivation from the current native session before dispatch.'
            : 'Resolve the preflight blocker, then re-derive the card.',
      });
    if (verdict.blockers.length === 0)
      for (const error of verdict.errors)
        blockers.push({
          code: 'capability_preflight_invalid',
          detail: error,
          next_action:
            'Fix the card or the sealed assignment; preflight cannot judge them.',
        });
  }
  return { card, state, blockers, resources: declaredResources };
}

/**
 * Authoritative acceptance state for a cohort.
 *
 * The work plan is the only source of node identity, dependencies and acceptance. Activation
 * re-derives its evaluation from the sealed plan, the current record and the registered
 * decision envelopes, so a finished report or a released claim never unlocks dependent work.
 */
function evaluateCohortPlan(
  taskRoot: string,
  record: TaskRecord,
): { evaluation: WorkPlanEvaluation | null; blockers: WorkflowBlocker[] } {
  const blockers: WorkflowBlocker[] = [];
  const read = readBoundedJson(workflowWorkPlanPath(taskRoot), 'work plan');
  if (!read.ok) {
    blockers.push({
      code: 'work_plan_missing',
      detail: read.message,
      next_action:
        'Re-run workflow prepare apply so the derived work plan is sealed; activation never infers it.',
    });
    return { evaluation: null, blockers };
  }
  const validated = validateWorkPlan(read.value);
  if (!validated.ok) {
    blockers.push({
      code: 'work_plan_invalid',
      detail: validated.diagnostics.map((item) => item.code).join(', '),
      next_action: 'Inspect the sealed work plan; activation never repairs it.',
    });
    return { evaluation: null, blockers };
  }
  const messages: Message[] = [];
  for (const entry of record.messages ?? []) {
    if (entry.state !== 'applied') continue;
    const envelope = readRegisteredMessage(taskRoot, entry.message_id);
    if (envelope === null) {
      blockers.push({
        code: 'decision_envelope_missing',
        detail: `Registered decision ${entry.message_id} has no readable envelope.`,
        next_action:
          'Restore or re-register the missing envelope; an unverifiable decision never unlocks work.',
      });
      return { evaluation: null, blockers };
    }
    messages.push(envelope);
  }
  const result = evaluateWorkPlan({ plan: validated.plan, record, messages });
  if (!result.ok) {
    blockers.push({
      code: 'work_plan_evaluation_refused',
      detail:
        result.diagnostics.map((item) => item.code).join(', ') || 'refused',
      next_action:
        'Reconcile the plan and the record before activating dependent work.',
    });
    return { evaluation: null, blockers };
  }
  return { evaluation: result, blockers };
}

export interface DispatchPlanReport {
  readonly nodes: readonly DispatchNodeState[];
  readonly blockers: readonly WorkflowBlocker[];
  readonly deferred: readonly {
    readonly subtask_id: string;
    readonly reason: string;
  }[];
}

function collectNodes(
  request: WorkflowDispatchRequest,
  record: TaskRecord,
  now: number,
): DispatchPlanReport {
  const blockers: WorkflowBlocker[] = [];
  const nodes: DispatchNodeState[] = [];
  const deferred: { subtask_id: string; reason: string }[] = [];
  if (!sameCoordinator(record.coordinator, request.caller))
    blockers.push({
      code: 'dispatch_not_coordinator',
      detail: `Dispatch is a coordinator action; caller is ${request.caller.agent_id}/${request.caller.session_id}.`,
      next_action:
        'Only the current coordinator identity may dispatch; a participant never dispatches its own work.',
    });
  const wanted =
    request.subtasks.length === 0
      ? record.attempts.map((item) => item.subtask_id)
      : request.subtasks;
  const unique = [...new Set(wanted)];
  const activating = request.activate_deferred
    ? new Set(
        readManifestDeferred(record.task_root, record, true).map(
          (entry) => entry.subtask_id,
        ),
      )
    : new Set<string>();
  for (const subtaskId of unique) {
    const attempt = record.attempts.find(
      (item) => item.subtask_id === subtaskId,
    );
    if (attempt === undefined || activating.has(subtaskId)) {
      deferred.push({
        subtask_id: subtaskId,
        reason:
          'no attempt is registered; a deferred reviewer is activated only after accepted writers release',
      });
      continue;
    }
    const cardTarget = request.capability_targets.find(
      (item) =>
        item.subtask_id === subtaskId && item.attempt === attempt.attempt,
    );
    const nodeBlockers: WorkflowBlocker[] = [];
    if (!ACTIVE_STATES.includes(attempt.state))
      nodeBlockers.push({
        code: 'attempt_not_dispatchable',
        detail: `${subtaskId}#${attempt.attempt} is ${attempt.state}.`,
        next_action:
          'Dispatch only assigned, accepted, running or unknown attempts.',
      });
    // One bounded, no-follow read gives both the document and the digest of those exact
    // bytes. The attempt pin and the registered ASSIGN body pin must both equal it before
    // any card, preflight, intent or notification is produced: a byte-only edit (even one
    // that leaves resources and epochs intact) is refused here, not just by coverage.
    const sealedDoc = readBoundedDocument(
      workflowAssignmentPath(record.task_root, subtaskId),
      'sealed assignment',
    );
    if (!sealedDoc.ok)
      nodeBlockers.push({
        code: sealedDoc.code,
        detail: sealedDoc.message,
        next_action: sealedDoc.nextAction,
      });
    else if (!isAssignment(sealedDoc.value.value))
      nodeBlockers.push({
        code: 'sealed_assignment_invalid',
        detail:
          'The sealed assignment does not satisfy harness-collab/assignment/1.',
        next_action:
          'Inspect the sealed assignment; dispatch never repairs it.',
      });
    else {
      const sealedAssignment = sealedDoc.value.value;
      if (
        !attempt.assignment_digest ||
        sealedDoc.value.digest !== attempt.assignment_digest
      )
        nodeBlockers.push({
          code: 'assignment_digest_mismatch',
          detail: `${subtaskId}#${attempt.attempt} sealed bytes do not match the registered attempt pin.`,
          next_action:
            'Inspect the sealed assignment; dispatch never repairs or re-pins it.',
        });
      const registeredAssign = readRegisteredMessage(
        record.task_root,
        attempt.assignment_message_id ?? `assign-${subtaskId}`,
      );
      if (registeredAssign === null)
        nodeBlockers.push({
          code: 'assignment_message_missing',
          detail: `${subtaskId}#${attempt.attempt} has no registered ASSIGN envelope.`,
          next_action: 'Re-run workflow prepare apply for this attempt.',
        });
      else if (
        registeredAssign.body?.assignment_digest !== attempt.assignment_digest
      )
        nodeBlockers.push({
          code: 'assignment_message_digest_mismatch',
          detail: `${subtaskId}#${attempt.attempt} ASSIGN body does not carry the registered attempt pin.`,
          next_action:
            'Inspect the registered ASSIGN; a mismatch is never rewritten.',
        });
      nodeBlockers.push(
        ...claimCoverageBlockers(
          record,
          subtaskId,
          attempt.attempt,
          {
            agent_id: attempt.assignee.agent_id,
            session_id: attempt.assignee.session_id,
          },
          sealedAssignment.resources.map((resource) => ({
            path: String(resource.path),
            access: resource.access === 'write' ? 'write' : 'read',
            ...(resource.scope === 'file' || resource.scope === 'tree'
              ? { scope: resource.scope }
              : {}),
            ...(Number.isSafeInteger(resource.resource_epoch) &&
            (resource.resource_epoch ?? 0) > 0
              ? { resource_epoch: resource.resource_epoch }
              : {}),
          })),
        ),
      );
    }
    let card: CapabilityCard | null = null;
    let cardFile: string | null = null;
    let cardState = 'absent';
    let evidence = 0;
    if (cardTarget === undefined)
      nodeBlockers.push({
        code: 'capability_target_missing',
        detail: `No capability target was supplied for ${subtaskId}#${attempt.attempt}.`,
        next_action:
          'Declare a capability target: template_file plus the observed session_file, or an explicit capabilities_file.',
      });
    else {
      const resolved = resolveCardTarget(
        cardTarget,
        workflowAssignmentPath(record.task_root, subtaskId),
        { harness: attempt.assignee.harness },
        now,
        request.max_age_minutes,
      );
      card = resolved.card;
      cardFile = cardTarget.capabilities_file ?? cardTarget.session_file;
      cardState = resolved.state;
      nodeBlockers.push(...resolved.blockers);
    }
    nodes.push({
      subtask_id: subtaskId,
      attempt: attempt.attempt,
      state: attempt.state,
      assignee: {
        agent_id: attempt.assignee.agent_id,
        session_id: attempt.assignee.session_id,
        harness: attempt.assignee.harness ?? '',
      },
      card,
      card_file: cardFile,
      card_state: cardState,
      blockers: nodeBlockers,
      evidence_checked: evidence,
    });
    blockers.push(...nodeBlockers);
  }
  return { nodes, blockers, deferred };
}

export function planDispatch(
  request: WorkflowDispatchRequest,
): WorkflowOutcome<DispatchPlanReport> {
  const record = readRecord(request.task_root);
  if (record === null)
    return workflowFailure(
      'task_record_missing',
      `No task record at ${request.task_root}.`,
      'Prepare the task first; dispatch never creates one.',
    );
  return {
    ok: true,
    value: collectNodes(request, record, Date.now()),
  };
}

interface ManifestDeferredEntry {
  readonly subtask_id: string;
  readonly role: string;
  readonly attempt: number;
  readonly assignment_digest: string;
  readonly resources: readonly {
    readonly path: string;
    readonly access: string;
  }[];
}

/** Re-enter claim acquisition only before any possible native delivery or consumption. */
function canRetryReviewClaims(
  taskRoot: string,
  record: TaskRecord,
  entry: ManifestDeferredEntry,
): boolean {
  const attempt = findAttempt(record, entry.subtask_id, entry.attempt);
  if (
    entry.role !== 'reviewer' ||
    attempt === null ||
    attempt.state !== 'assigned' ||
    attempt.closed_at ||
    attempt.cancel_requested_at ||
    attempt.awaiting ||
    record.attempts.some(
      (other) =>
        other.subtask_id === entry.subtask_id && other.attempt > entry.attempt,
    ) ||
    attempt.native.observation !== 'unknown' ||
    Object.entries(attempt.native).some(
      ([key, value]) => key !== 'observation' && value != null,
    ) ||
    record.results.some(
      (result) =>
        result.subtask_id === entry.subtask_id &&
        result.attempt === entry.attempt,
    ) ||
    record.messages.some(
      (message) =>
        message.subtask_id === entry.subtask_id &&
        message.attempt === entry.attempt &&
        ['ACK', 'REPORT', 'BLOCK', 'CANCEL', 'CANCELLED', 'HANDOFF'].includes(
          message.type,
        ),
    )
  )
    return false;
  for (const file of [
    path.join(
      workflowIntentsDir(taskRoot),
      `dispatch-${entry.subtask_id}-${entry.attempt}.json`,
    ),
    path.join(taskRoot, 'notifications', `assign-${entry.subtask_id}.json`),
  ]) {
    if (assertRealChain(taskRoot, file) !== null) return false;
    try {
      lstatSync(file);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  const sealed = readBoundedDocument(
    workflowAssignmentPath(taskRoot, entry.subtask_id),
    'sealed review assignment',
  );
  if (
    !sealed.ok ||
    !isAssignment(sealed.value.value) ||
    sealed.value.digest !== entry.assignment_digest ||
    sealed.value.digest !== attempt.assignment_digest
  )
    return false;
  const assignment = sealed.value.value;
  if (!isSafeMessageId(attempt.assignment_message_id)) return false;
  const assignDoc = readBoundedDocument(
    path.join(taskRoot, 'messages', `${attempt.assignment_message_id}.json`),
    'registered reviewer ASSIGN',
  );
  if (!assignDoc.ok) return false;
  let registered: Message;
  try {
    registered = validateEnvelope(assignDoc.value.value);
  } catch {
    return false;
  }
  if (
    record.coordinator === null ||
    assignment.task_id !== record.task_id ||
    assignment.assignment_id !== entry.subtask_id ||
    assignment.attempt !== entry.attempt ||
    !assignment.roles.includes('reviewer') ||
    assignment.roles.includes('writer') ||
    attempt.owner_epoch !== record.coordinator.owner_epoch ||
    assignment.coordinator.owner_epoch !== attempt.owner_epoch ||
    assignment.assignee.agent_id !== attempt.assignee.agent_id ||
    assignment.assignee.session_id !== attempt.assignee.session_id ||
    assignment.assignee.harness !== attempt.assignee.harness ||
    assignment.coordinator.agent_id !== record.coordinator.agent_id ||
    assignment.coordinator.session_id !== record.coordinator.session_id ||
    attempt.input_revision !== record.input_revision ||
    assignment.inputs[0]?.digest !== record.input_revision ||
    registered.type !== 'ASSIGN' ||
    registered.body.assignment_digest !== sealed.value.digest ||
    registered.subtask_id !== entry.subtask_id ||
    registered.attempt !== entry.attempt ||
    registered.to?.agent_id !== attempt.assignee.agent_id ||
    registered.to?.session_id !== attempt.assignee.session_id ||
    registered.to?.harness !== attempt.assignee.harness ||
    registered.owner_epoch !== attempt.owner_epoch ||
    registered.from.agent_id !== record.coordinator.agent_id ||
    registered.from.session_id !== record.coordinator.session_id ||
    registered.body.input_revision !== record.input_revision ||
    !record.messages.some(
      (entry) =>
        entry.message_id === registered.message_id &&
        entry.content_digest === contentDigest(registered),
    ) ||
    assignment.resources.some((resource) => resource.access !== 'read')
  )
    return false;
  return (
    claimCoverageBlockers(
      record,
      entry.subtask_id,
      entry.attempt,
      attempt.assignee,
      assignment.resources.map((resource) => ({
        path: String(resource.path),
        access: 'read',
        ...(resource.scope === 'file' || resource.scope === 'tree'
          ? { scope: resource.scope }
          : {}),
      })),
    ).length > 0
  );
}

function readManifestDeferred(
  taskRoot: string,
  record: TaskRecord,
  includeClaimRetries = false,
): ManifestDeferredEntry[] {
  const read = readBoundedJson(
    workflowManifestPath(taskRoot),
    'workflow manifest',
  );
  if (!read.ok) return [];
  const value = read.value as {
    assignments?: {
      subtask_id?: string;
      role?: string;
      attempt?: number;
      deferred?: boolean;
      assignment_digest?: string;
      resources?: { path?: string; access?: string; scope?: string }[];
    }[];
  };
  return (
    (value.assignments ?? [])
      .filter((item) => item.deferred === true)
      .map((item) => ({
        subtask_id: String(item.subtask_id ?? ''),
        role: String(item.role ?? 'reviewer'),
        attempt: Number(item.attempt ?? 1),
        assignment_digest: String(item.assignment_digest ?? ''),
        resources: (item.resources ?? []).map((resource) => ({
          path: String(resource.path ?? ''),
          access: String(resource.access ?? 'read'),
          ...(resource.scope === 'file' || resource.scope === 'tree'
            ? { scope: resource.scope }
            : {}),
        })),
      }))
      // Registration alone does not complete activation: a read-claim conflict can
      // leave an assigned reviewer with neither dispatch intent nor delivery evidence.
      .filter(
        (entry) =>
          findAttempt(record, entry.subtask_id, entry.attempt) === null ||
          (includeClaimRetries &&
            canRetryReviewClaims(taskRoot, record, entry)),
      )
  );
}

export async function applyDispatch(
  request: WorkflowDispatchRequest,
  options: {
    readonly clock?: number;
    readonly apply?: boolean;
    /**
     * Existing work-execution adapter seam. Production defaults to the guarded Herdr
     * adapter, whose `dispatch` runs `finalAuthorityCheck` inside its transport wrapper;
     * tests pass a no-model adapter that must invoke the same callback.
     */
    readonly adapter?: WorkExecutionAdapter;
  } = {},
): Promise<
  WorkflowResult<{
    notified: readonly string[];
    intents: readonly string[];
    activation_only: readonly string[];
  }>
> {
  const type = {
    notified: [] as string[],
    intents: [] as string[],
    activation_only: [] as string[],
  };
  const opened = await openWorkflowTask(request.task_root);
  if (!opened.ok) {
    const base = emptyResult<typeof type>('dispatch', true);
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
  }
  const task = opened.value;
  const writing = options.apply !== false;
  const planned = collectNodes(
    request,
    task.record,
    options.clock ?? Date.now(),
  );
  const base = emptyResult<typeof type>('dispatch', writing);
  if (planned.blockers.length > 0)
    return {
      ...base,
      status: 'blocked',
      task_id: task.record.task_id,
      task_root: task.taskRoot,
      domain_root: task.record.domain_root,
      state_revision: task.record.state_revision,
      principal: { ...request.caller, role: 'coordinator' },
      blockers: planned.blockers,
      next_action: planned.blockers[0]?.next_action ?? null,
      detail: {
        ...type,
        intents: planned.deferred.map((item) => item.subtask_id),
      },
    };

  if (!writing)
    return {
      ...base,
      status: planned.blockers.length === 0 ? 'planned' : 'blocked',
      ok: planned.blockers.length === 0,
      task_id: task.record.task_id,
      task_root: task.taskRoot,
      domain_root: task.record.domain_root,
      state_revision: task.record.state_revision,
      principal: { ...request.caller, role: 'coordinator' },
      native: planned.nodes.map((node) => ({
        subtask_id: node.subtask_id,
        attempt: node.attempt,
        observation: 'unknown',
        card: node.card_state,
      })),
      blockers: planned.blockers,
      next_action:
        planned.blockers[0]?.next_action ??
        'Plan only: no intent was recorded and nothing was notified.',
      detail: {
        ...type,
        intents: planned.deferred.map((item) => item.subtask_id),
      },
    };

  const blockers: WorkflowBlocker[] = [];
  const warnings: string[] = [];
  const notified: string[] = [];
  const intents: string[] = [];
  const activationOnly: string[] = [];
  const messages: WorkflowResult['messages'][number][] = [];
  const native: WorkflowResult['native'][number][] = [];

  const deliverNode = async (node: {
    readonly subtask_id: string;
    readonly attempt: number;
    readonly card: CapabilityCard | null;
    readonly card_file: string | null;
    readonly card_state: string;
    readonly evidence_checked: number;
  }): Promise<void> => {
    const intentFile = path.join(
      workflowIntentsDir(task.taskRoot),
      `dispatch-${node.subtask_id}-${node.attempt}.json`,
    );
    const intent = {
      schema: 'pappra/collab-workflow-dispatch-intent/1',
      subtask_id: node.subtask_id,
      attempt: node.attempt,
      message_id: `assign-${node.subtask_id}`,
      card_file: node.card_file,
      card_digest: node.card_file === null ? null : digestFile(node.card_file),
      card_state: node.card_state,
      evidence_checked: node.evidence_checked,
      caller_pane: request.caller_pane,
      created_at: new Date(options.clock ?? Date.now()).toISOString(),
    };
    const write = writeJsonExclusive(task.taskRoot, intentFile, intent);
    if (write.status === 'conflict') {
      blockers.push({
        code: 'dispatch_intent_conflict',
        detail: `A different dispatch intent already exists for ${node.subtask_id}#${node.attempt}.`,
        next_action:
          'Reconcile the existing delivery; an unknown notification effect is never replayed.',
      });
      return;
    }
    if (write.status === 'unsafe') {
      blockers.push({
        code: 'dispatch_intent_unsafe',
        detail: `Cannot record the dispatch intent: ${write.detail}.`,
        next_action:
          'Inspect the workflow intents directory; nothing was notified.',
      });
      return;
    }
    intents.push(intentFile);
    if (write.status === 'identical') {
      // The intent is durable evidence that a delivery was already attempted here.
      blockers.push({
        code: 'dispatch_already_attempted',
        detail: `A dispatch intent for ${node.subtask_id}#${node.attempt} already exists.`,
        next_action:
          'Inspect the recorded delivery; dispatch never replays a possibly delivered notification.',
      });
      return;
    }

    const changed = await revalidateWorkflowTask(task);
    if (!changed.ok) {
      blockers.push({
        code: changed.code,
        detail: changed.message,
        next_action: changed.nextAction,
      });
      return;
    }
    const adapter = options.adapter ?? createHerdrWorkExecutionAdapter();
    // Re-verify THIS node against a fresh record inside the existing notifier seam: revoked
    // claims, changed epochs, a changed sealed pin or a lost coordinator stop the transport
    // instead of delivering on stale evidence. Shared validators only.
    const finalAuthorityCheck = async (): Promise<{
      readonly ok: boolean;
      readonly reason: string;
    }> => {
      const fresh = readRecord(task.taskRoot);
      if (fresh === null) return { ok: false, reason: 'record_unreadable' };
      if (
        fresh.coordinator === null ||
        fresh.coordinator.agent_id !== request.caller.agent_id ||
        fresh.coordinator.session_id !== request.caller.session_id
      )
        return { ok: false, reason: 'coordinator_changed' };
      const attempt = findAttempt(fresh, node.subtask_id, node.attempt);
      if (attempt === null) return { ok: false, reason: 'attempt_missing' };
      const sealedDoc = readBoundedDocument(
        workflowAssignmentPath(task.taskRoot, node.subtask_id),
        'sealed assignment',
      );
      if (!sealedDoc.ok) return { ok: false, reason: sealedDoc.code };
      if (sealedDoc.value.digest !== attempt.assignment_digest)
        return { ok: false, reason: 'assignment_digest_mismatch' };
      if (
        fresh.coordinator?.owner_epoch !== attempt.owner_epoch ||
        (isAssignment(sealedDoc.value.value) &&
          sealedDoc.value.value.coordinator.owner_epoch !== attempt.owner_epoch)
      )
        return { ok: false, reason: 'owner_epoch_changed' };
      if (
        isAssignment(sealedDoc.value.value) &&
        (sealedDoc.value.value.inputs[0]?.digest ?? null) !==
          (fresh.input_revision ?? null)
      )
        return { ok: false, reason: 'input_revision_changed' };
      if (attempt.state === 'unknown')
        return { ok: false, reason: 'attempt_state_reconciliation_required' };
      // Reuse the same scoped admission projection instead of a third, weaker variant:
      // it re-derives this node's state, assignee, raw pin, card and coverage on the
      // fresh record.
      const scoped = collectNodes(
        { ...request, subtasks: [node.subtask_id] },
        fresh,
        options.clock ?? Date.now(),
      );
      if (scoped.blockers.length > 0)
        return { ok: false, reason: scoped.blockers[0]!.code };
      const scopedNode = scoped.nodes.find(
        (candidate) =>
          candidate.subtask_id === node.subtask_id &&
          candidate.attempt === node.attempt,
      );
      if (scopedNode === undefined)
        return { ok: false, reason: 'attempt_not_dispatchable' };
      const resources: DeclaredResource[] = isAssignment(sealedDoc.value.value)
        ? sealedDoc.value.value.resources.map((resource) => ({
            path: String(resource.path),
            access: resource.access === 'write' ? 'write' : 'read',
            ...(resource.scope === 'file' || resource.scope === 'tree'
              ? { scope: resource.scope }
              : {}),
            ...(Number.isSafeInteger(resource.resource_epoch) &&
            (resource.resource_epoch ?? 0) > 0
              ? { resource_epoch: resource.resource_epoch }
              : {}),
          }))
        : [];
      const coverage = claimCoverageBlockers(
        fresh,
        node.subtask_id,
        node.attempt,
        {
          agent_id: attempt.assignee.agent_id,
          session_id: attempt.assignee.session_id,
        },
        resources,
      );
      return coverage.length === 0
        ? { ok: true, reason: 'ok' }
        : { ok: false, reason: coverage[0]!.code };
    };
    const delivered = await adapter.dispatch({
      taskRoot: task.taskRoot,
      messageId: intent.message_id,
      bindingFile: workflowBindingPath(task.taskRoot),
      callerPane: request.caller_pane,
      finalAuthorityCheck,
    });
    messages.push({
      message_id: intent.message_id,
      type: 'ASSIGN',
      registration: null,
      duplicate: false,
      delivery: delivered.status,
      digest: delivered.message_digest ?? null,
    });
    native.push({
      subtask_id: node.subtask_id,
      attempt: node.attempt,
      // `submitted` proves a delivery submission, never native execution/consumption.
      observation: 'unknown',
      card: node.card_state,
    });
    if (delivered.ok && delivered.status === 'submitted')
      notified.push(node.subtask_id);
    else
      blockers.push({
        code: `delivery_${delivered.status}`,
        detail: `Delivery for ${node.subtask_id} reported ${delivered.status}: ${String(delivered.detail ?? '')}.`,
        next_action:
          'Reconcile the recorded delivery record; an unknown or blocked delivery is not retried automatically.',
      });
  };

  for (const node of planned.nodes) await deliverNode(node);

  // Reviewer activation stays explicit and gated: sealed reviewer assignments become real
  // only after every writer released its claims and reached a final applied result.
  // Only deferred entries inside this request's scope may affect its outcome; an unrelated
  // reviewer that stays deferred is normal and never turns a successful phase into failure.
  const requested = new Set(request.subtasks);
  const deferred = readManifestDeferred(
    task.taskRoot,
    task.record,
    request.activate_deferred,
  );
  const inScope = deferred.filter(
    (entry) => requested.size === 0 || requested.has(entry.subtask_id),
  );
  for (const entry of deferred.filter((item) => !inScope.includes(item)))
    warnings.push(
      `${entry.subtask_id} stays deferred outside this request's scope; activate it with an explicit dispatch for that subtask after its writers are accepted and released.`,
    );
  void activationOnly;
  if (request.activate_deferred) {
    for (const entry of inScope) {
      const changed = await revalidateWorkflowTask(task);
      const activationRecord = readRecord(task.taskRoot);
      if (
        !changed.ok ||
        activationRecord === null ||
        !sameCoordinator(activationRecord.coordinator, request.caller)
      ) {
        blockers.push({
          code: 'review_activation_authority_changed',
          detail:
            'Reviewer activation lost its current coordinator or task namespace.',
          next_action:
            'Reconcile authority before retrying; no reviewer claims were acquired.',
        });
        continue;
      }
      const existingAttempt = findAttempt(
        activationRecord,
        entry.subtask_id,
        entry.attempt,
      );
      if (
        existingAttempt !== null &&
        !canRetryReviewClaims(task.taskRoot, activationRecord, entry)
      ) {
        blockers.push({
          code: 'review_activation_not_retryable',
          detail: `Reviewer ${entry.subtask_id} no longer has a known-no-delivery claim acquisition to retry.`,
          next_action:
            'Inspect the existing attempt and delivery evidence; it is not reopened.',
        });
        continue;
      }
      const cohort = evaluateCohortPlan(task.taskRoot, activationRecord);
      if (cohort.evaluation === null) {
        blockers.push(...cohort.blockers);
        continue;
      }
      const pending = cohort.evaluation.nodes.filter(
        (node) =>
          node.node_id !== entry.subtask_id && node.status !== 'accepted',
      );
      if (pending.length > 0) {
        blockers.push({
          code: 'writers_not_accepted',
          detail: `Reviewer ${entry.subtask_id} cannot be activated: ${pending
            .map((node) => `${node.node_id}=${node.status}`)
            .join(', ')}.`,
          next_action:
            'Accept every writer node with workflow accept first; a completed report or a released claim is not acceptance.',
        });
        continue;
      }
      const writerIds = new Set(
        cohort.evaluation.nodes
          .filter((node) => node.role === 'writer')
          .map((node) => node.node_id),
      );
      if (
        activeClaims(activationRecord).some(
          (claim) =>
            claim.subtask_id !== null && writerIds.has(claim.subtask_id),
        )
      ) {
        blockers.push({
          code: 'writers_not_released',
          detail: `Reviewer ${entry.subtask_id} cannot activate while an accepted writer still holds claims.`,
          next_action:
            'Have each writer release its own claims after acceptance before activating the reviewer.',
        });
        continue;
      }
      const sealedFile = workflowAssignmentPath(
        task.taskRoot,
        entry.subtask_id,
      );
      const sealed = readBoundedJson(sealedFile, 'sealed review assignment');
      // One expression serves dispatch and the launch admission engine: the pin is the
      // SHA-256 of the exact sealed bytes, including the real resource epochs.
      if (
        !sealed.ok ||
        digestFile(sealedFile) !== entry.assignment_digest ||
        !isAssignment(sealed.value)
      ) {
        blockers.push({
          code: 'sealed_review_assignment_mismatch',
          detail: `Sealed assignment for ${entry.subtask_id} does not match the manifest digest.`,
          next_action:
            'Inspect the sealed assignment; it is never rewritten during activation.',
        });
        continue;
      }
      const unpinnedWrite = isAssignment(sealed.value)
        ? sealed.value.resources.filter(
            (resource) =>
              resource.access === 'write' &&
              !(
                Number.isSafeInteger(resource.resource_epoch) &&
                (resource.resource_epoch ?? 0) > 0
              ),
          )
        : [];
      if (unpinnedWrite.length > 0) {
        blockers.push({
          code: 'deferred_write_epoch_unpinnable',
          detail: `Reviewer ${entry.subtask_id} declares a write footprint (${unpinnedWrite
            .map((resource) => String(resource.path))
            .join(
              ', ',
            )}) but its sealed document carries no real resource epoch.`,
          next_action:
            'Declare the reviewer read-only, or prepare it as a writer assignment so its write claims exist before the bytes are sealed; activation never invents an epoch or rewrites sealed bytes.',
        });
        continue;
      }
      const record = readRecord(task.taskRoot);
      const manifest = readBoundedJson(
        workflowManifestPath(task.taskRoot),
        'manifest',
      );
      const assignee = (() => {
        if (!manifest.ok) return null;
        const value = manifest.value as {
          assignments?: {
            subtask_id?: string;
            assignee?: {
              agent_id?: string;
              session_id?: string;
              harness?: string;
            };
          }[];
        };
        const match = (value.assignments ?? []).find(
          (item) => item.subtask_id === entry.subtask_id,
        );
        return match?.assignee ?? null;
      })();
      if (record === null || assignee === null || record.coordinator === null) {
        blockers.push({
          code: 'review_activation_incomplete',
          detail: `Cannot resolve the reviewer identity for ${entry.subtask_id} from the sealed manifest.`,
          next_action:
            'Inspect the manifest; activation never infers an identity.',
        });
        continue;
      }
      if (
        !sameCoordinator(record.coordinator, request.caller) ||
        sealed.value.assignee.agent_id !== assignee.agent_id ||
        sealed.value.assignee.session_id !== assignee.session_id ||
        sealed.value.assignee.harness !== assignee.harness ||
        sealed.value.coordinator.owner_epoch !== record.coordinator.owner_epoch
      ) {
        blockers.push({
          code: 'review_activation_identity_mismatch',
          detail:
            'The sealed reviewer identity or coordinator epoch no longer matches activation.',
          next_action:
            'Inspect the sealed assignment and manifest; neither is rewritten.',
        });
        continue;
      }
      if (
        findAttempt(record, entry.subtask_id, entry.attempt) !== null &&
        !canRetryReviewClaims(task.taskRoot, record, entry)
      ) {
        blockers.push({
          code: 'review_activation_not_retryable',
          detail: `Reviewer ${entry.subtask_id} changed before claim acquisition.`,
          next_action:
            'Inspect the current attempt and delivery evidence; no claim repair was attempted.',
        });
        continue;
      }
      const message = buildMessage({
        type: 'ASSIGN',
        task_id: record.task_id,
        from: {
          agent_id: record.coordinator.agent_id,
          session_id: record.coordinator.session_id,
          harness: record.coordinator.harness,
        },
        to: {
          agent_id: String(assignee.agent_id),
          session_id: String(assignee.session_id),
          harness: String(assignee.harness),
        },
        message_id: `assign-${entry.subtask_id}`,
        subtask_id: entry.subtask_id,
        attempt: entry.attempt,
        owner_epoch: record.coordinator.owner_epoch,
        body: {
          assignment_ref: sealedFile,
          assignment_digest: entry.assignment_digest,
          input_revision: record.input_revision ?? null,
        },
      });
      const submitted = submitMessage(task.taskRoot, message, {
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
      messages.push({
        message_id: message.message_id,
        type: 'ASSIGN',
        registration: submitted.ok
          ? String(submitted.registration?.status ?? '')
          : null,
        duplicate: submitted.ok && submitted.duplicate === true,
        delivery: 'persisted-not-notified',
        digest: message.content_digest ?? null,
      });
      if (!submitted.ok) {
        blockers.push({
          code: 'review_assignment_refused',
          detail: `Reviewer ASSIGN for ${entry.subtask_id} was refused: ${String(submitted.reason)}.`,
          next_action:
            'Inspect the record; a refusal is preserved, never rewritten.',
        });
        continue;
      }
      const batches = new Map<
        'read' | 'write',
        { path: string; scope?: 'file' | 'tree' }[]
      >();
      for (const resource of sealed.value.resources) {
        if (
          claimCoverageBlockers(
            record,
            entry.subtask_id,
            entry.attempt,
            {
              agent_id: String(assignee.agent_id),
              session_id: String(assignee.session_id),
            },
            [
              {
                path: String(resource.path),
                access: resource.access,
                ...(resource.scope === 'file' || resource.scope === 'tree'
                  ? { scope: resource.scope }
                  : {}),
                ...(resource.resource_epoch === undefined
                  ? {}
                  : { resource_epoch: resource.resource_epoch }),
              },
            ],
          ).length === 0
        )
          continue;
        const access = resource.access === 'write' ? 'write' : 'read';
        const bucket = batches.get(access) ?? [];
        bucket.push({
          path: String(resource.path),
          ...(resource.scope === 'file' || resource.scope === 'tree'
            ? { scope: resource.scope }
            : {}),
        });
        batches.set(access, bucket);
      }
      for (const [access, resources] of batches) {
        const claimed = claimResources(task.taskRoot, {
          resources,
          access,
          holder: {
            agent_id: String(assignee.agent_id),
            session_id: String(assignee.session_id),
            harness: String(assignee.harness),
          },
          subtaskId: entry.subtask_id,
          attempt: entry.attempt,
          requireAssignedHolder: true,
          note: 'workflow deferred activation',
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        });
        if (!claimed.ok)
          blockers.push({
            code: String(claimed.reason),
            detail: `Reviewer ${entry.subtask_id} could not claim its ${access} footprint: ${String(claimed.reason)}.`,
            next_action:
              'Re-run dispatch after the holding claim is gone; the ASSIGN is reused.',
          });
      }
      const afterClaim = readRecord(task.taskRoot);
      if (afterClaim === null) {
        blockers.push({
          code: 'review_activation_gate_unreadable',
          detail: `Cannot re-read the task record after claiming ${entry.subtask_id} its footprint.`,
          next_action:
            'Inspect the task root; activation never delivers on an unverified record.',
        });
        continue;
      }
      if (isAssignment(sealed.value)) {
        blockers.push(
          ...claimCoverageBlockers(
            afterClaim,
            entry.subtask_id,
            entry.attempt,
            {
              agent_id: String(assignee.agent_id),
              session_id: String(assignee.session_id),
            },
            sealed.value.resources.map((resource) => ({
              path: String(resource.path),
              access: resource.access === 'write' ? 'write' : 'read',
              ...(resource.scope === 'file' || resource.scope === 'tree'
                ? { scope: resource.scope }
                : {}),
              ...(Number.isSafeInteger(resource.resource_epoch) &&
              (resource.resource_epoch ?? 0) > 0
                ? { resource_epoch: resource.resource_epoch }
                : {}),
            })),
          ),
        );
      }
      if (blockers.length > 0) continue;
      intents.push(sealedFile);
      // B6: activation registers the attempt and claims; it delivers only when this call
      // also supplies a capability target for the reviewer, reusing the same delivery path
      // as a writer node (intent -> single notification, unknown never replayed).
      const reviewTarget = request.capability_targets.find(
        (item) =>
          item.subtask_id === entry.subtask_id &&
          item.attempt === entry.attempt,
      );
      if (reviewTarget === undefined) {
        activationOnly.push(entry.subtask_id);
        warnings.push(
          `${entry.subtask_id}: attempt and claims were registered only; nothing was delivered. Call dispatch again with a capability target (template_file plus the observed native source, or capabilities_file) to derive the card and notify once.`,
        );
      } else {
        const resolvedReview = resolveCardTarget(
          reviewTarget,
          sealedFile,
          { harness: String(assignee.harness) },
          options.clock ?? Date.now(),
          request.max_age_minutes,
        );
        if (resolvedReview.blockers.length > 0)
          blockers.push(...resolvedReview.blockers);
        else
          await deliverNode({
            subtask_id: entry.subtask_id,
            attempt: entry.attempt,
            card: resolvedReview.card,
            card_file:
              reviewTarget.capabilities_file ?? reviewTarget.session_file,
            card_state: resolvedReview.state,
            evidence_checked: 0,
          });
      }
    }
  } else {
    for (const entry of inScope) {
      if (requested.size > 0)
        blockers.push({
          code: 'reviewer_deferred',
          detail: `Reviewer ${entry.subtask_id} is sealed but not activated in this scoped request.`,
          next_action:
            'Call dispatch again with activate_deferred and this reviewer in subtasks once every writer is accepted and has released its claims.',
        });
      else
        warnings.push(
          `${entry.subtask_id} stays deferred: a reviewer ASSIGN and its claims activate only after every writer is accepted and has released its claims.`,
        );
    }
  }

  const current = readRecord(task.taskRoot);
  const status =
    blockers.length === 0
      ? 'applied'
      : notified.length > 0 || intents.length > 0
        ? 'needs-reconciliation'
        : 'blocked';
  return {
    ...base,
    status,
    ok: status === 'applied',
    task_id: task.record.task_id,
    task_root: task.taskRoot,
    domain_root: task.record.domain_root,
    state_revision: current?.state_revision ?? task.record.state_revision,
    principal: { ...request.caller, role: 'coordinator' },
    messages,
    native,
    blockers,
    warnings,
    detail: { ...type, notified, intents, activation_only: activationOnly },
    // A real blocker keeps its own recovery guidance; the generic text never replaces it.
    next_action:
      blockers[0]?.next_action ??
      (status !== 'applied'
        ? null
        : activationOnly.length > 0
          ? 'Only attempt and claims were registered for the listed reviewer(s); nothing was delivered. Run dispatch again with a capability target for them to derive the card and notify once.'
          : 'Delivery is recorded; consumption, execution and acceptance remain unproven.'),
  };
}
