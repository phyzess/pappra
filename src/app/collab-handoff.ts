import { lstatSync } from 'node:fs';
import path from 'node:path';
import {
  collaborationHandoffRequestSchema,
  type CollaborationHandoffRequest,
} from '../schemas/collaboration.js';
import { contentDigest } from '../collab/envelope.js';
import {
  abortHandoff,
  coordinatorHandoffReadiness,
  type HandoffReadinessFinding,
  type MidCohortHandoffReadiness,
  midCohortHandoffReadiness,
  beginHandoff,
  completeHandoff,
  confirmReceiver,
  findHandoff,
  handoffInventory,
  markOldWriterStopped,
  markTransferring,
  rebindReceiver,
  releaseDispatchFreeze,
} from '../collab/handoff.js';
import { checkOwnerEpoch } from '../collab/lifecycle.js';
import {
  workflowManifestPath,
  workflowWorkPlanPath,
} from '../schemas/collab-workflow.js';
import { evaluateCohortPlan } from './collab-workflow/dispatch.js';
import { unsupportedSurfaces } from './collab-workflow/succession-surfaces.js';
import { transact } from '../collab/store.js';
import type { Identity, Message, TaskRecord } from '../collab/types.js';
import {
  readRegisteredMessageSafe,
  type OpenedMessageTask,
} from './collab-messages.js';
import {
  assertTaskStoreCurrent,
  openTaskStore,
  type TaskStoreFailure,
  type TaskStoreResult,
} from './collab-task-store.js';
import { readBoundedFile } from './bounded-file.js';

export const COLLAB_HANDOFF_SCHEMA = 'pappra/collaboration-handoff/1';
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_INVENTORY_ROWS = 50;

export type HandoffAction =
  | 'begin'
  | 'stopped'
  | 'rebind'
  | 'transfer'
  | 'confirm'
  | 'complete'
  | 'abort'
  | 'release-dispatch';

const ACCEPTED_MESSAGE_STATES = new Set(['applied', 'recorded']);

export interface LoadedHandoffRequest {
  readonly request: CollaborationHandoffRequest;
  readonly path: string;
}

function invalidRequest(message: string, nextAction: string): TaskStoreFailure {
  return {
    ok: false,
    code: 'invalid_request',
    message,
    nextAction,
  };
}

export function loadHandoffRequest(
  file: string,
  expectedAction: HandoffAction,
): TaskStoreResult<LoadedHandoffRequest> {
  if (!path.isAbsolute(file)) {
    return invalidRequest(
      'Handoff request path must be absolute.',
      'Pass an absolute request JSON path.',
    );
  }
  const read = readBoundedFile(file, MAX_REQUEST_BYTES);
  if (!read.ok) {
    return invalidRequest(
      'Handoff request must be a readable regular JSON file no larger than 1 MiB.',
      'Inspect the request path and file kind; nothing was written.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return invalidRequest(
      'Handoff request is not valid JSON.',
      'Rewrite the request as strict JSON; nothing was written.',
    );
  }
  const validated = collaborationHandoffRequestSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .slice(0, 8)
      .map((issue) => {
        const field = issue.path.length ? issue.path.join('.') : '(root)';
        return `${field}:${issue.code}`;
      })
      .join(', ');
    return invalidRequest(
      `Handoff request does not match the strict schema (${issues || 'invalid shape'}).`,
      'Fix the request schema; nothing was written.',
    );
  }
  const request = validated.data;
  if (request.action !== expectedAction) {
    return invalidRequest(
      'Handoff request action does not match the invoked handoff command.',
      `Use a ${expectedAction} request; nothing was written.`,
    );
  }
  if (
    request.action === 'begin' &&
    request.kind === 'writer' &&
    (!request.subtask_id || !request.attempt)
  ) {
    return invalidRequest(
      'A writer handoff begin request requires subtask_id and attempt.',
      'Identify the writer attempt being handed over; nothing was written.',
    );
  }
  return { ok: true, value: { request, path: file } };
}

function identity(value: {
  agent_id: string;
  session_id: string;
  harness?: string | null | undefined;
}): Identity {
  return {
    agent_id: value.agent_id,
    session_id: value.session_id,
    harness: value.harness ?? null,
  };
}

function requestSummary(request: CollaborationHandoffRequest) {
  const common = {
    actor: request.actor,
    owner_epoch: request.owner_epoch,
    ...(request.expect_revision === undefined
      ? {}
      : { expect_revision: request.expect_revision }),
  };
  switch (request.action) {
    case 'begin':
      return {
        ...common,
        action: request.action,
        handoff_id: request.handoff_id,
        kind: request.kind,
        from: identity(request.from),
        to: identity(request.to),
        resource_count: request.resources?.length ?? 0,
        subtask_id: request.subtask_id ?? null,
        attempt: request.attempt ?? null,
      };
    case 'stopped':
      return {
        ...common,
        action: request.action,
        handoff_id: request.handoff_id,
        observation: request.observation,
        evidence_ref: request.evidence_ref,
      };
    case 'rebind':
      return {
        ...common,
        action: request.action,
        handoff_id: request.handoff_id,
        to: identity(request.to),
        evidence_ref: request.evidence_ref,
      };
    case 'transfer':
      return {
        ...common,
        action: request.action,
        handoff_id: request.handoff_id,
        partial_outputs: request.partial_outputs?.length ?? 0,
        inflight: request.inflight?.length ?? 0,
        pending_approvals: request.pending_approvals?.length ?? 0,
      };
    case 'confirm':
      return {
        ...common,
        action: request.action,
        handoff_id: request.handoff_id,
        confirmation_message_id: request.confirmation_message_id,
      };
    case 'complete':
      return {
        ...common,
        action: request.action,
        handoff_id: request.handoff_id,
      };
    case 'abort':
      return {
        ...common,
        action: request.action,
        handoff_id: request.handoff_id,
      };
    case 'release-dispatch':
      return { ...common, action: request.action };
  }
}

function identityMatches(
  actual: Identity | undefined,
  expected: Identity | null,
): boolean {
  if (!actual || !expected) return false;
  if (
    actual.agent_id !== expected.agent_id ||
    actual.session_id !== expected.session_id
  )
    return false;
  if (expected.harness !== null && actual.harness !== expected.harness)
    return false;
  return true;
}

/**
 * Additional public boundary checks for a receiver confirmation. Core
 * confirmReceiver still validates type/from and advances the sequence; this
 * function requires the message to be stored as an accepted/recorded protocol
 * entry and explicitly correlated to this handoff.
 */
function validateConfirmation(
  record: TaskRecord,
  message: Message,
  request: Extract<CollaborationHandoffRequest, { action: 'confirm' }>,
): TaskStoreFailure | null {
  const entry = findHandoff(record, request.handoff_id);
  if (!entry)
    return {
      ok: false,
      code: 'confirmation_handoff_unknown',
      message: 'The handoff is not present in the task record.',
      nextAction: 'Read the handoff inventory; nothing was transferred.',
    };
  if (message.task_id !== record.task_id)
    return {
      ok: false,
      code: 'confirmation_task_mismatch',
      message: 'The confirmation message belongs to another task.',
      nextAction:
        'Use a confirmation registered for this task; nothing was transferred.',
    };
  if (!['ACK', 'HANDOFF'].includes(message.type))
    return {
      ok: false,
      code: 'confirmation_type_invalid',
      message: 'The confirmation must be an ACK or HANDOFF message.',
      nextAction:
        'Register an explicit receiver confirmation; nothing was transferred.',
    };
  if (
    message.type === 'HANDOFF' &&
    (typeof message.body?.phase !== 'string' ||
      message.body.phase === 'request')
  )
    return {
      ok: false,
      code: 'confirmation_phase_invalid',
      message: 'A HANDOFF confirmation must use a non-request phase.',
      nextAction:
        'Use a HANDOFF confirmation phase such as confirmation; nothing was transferred.',
    };
  const bodyHandoffId = message.body?.handoff_id;
  if (
    bodyHandoffId !== undefined &&
    bodyHandoffId !== null &&
    bodyHandoffId !== request.handoff_id
  )
    return {
      ok: false,
      code: 'confirmation_handoff_mismatch',
      message: 'The confirmation references a different handoff.',
      nextAction:
        'Use a confirmation for this handoff; nothing was transferred.',
    };
  if (
    (bodyHandoffId === undefined || bodyHandoffId === null) &&
    message.reply_to !== request.handoff_id
  )
    return {
      ok: false,
      code: 'confirmation_correlation_missing',
      message: 'The confirmation does not explicitly reference this handoff.',
      nextAction:
        'Set body.handoff_id or reply_to to the handoff id; nothing was transferred.',
    };
  if (!identityMatches(message.from, entry.to))
    return {
      ok: false,
      code: 'confirmation_identity_mismatch',
      message: 'The confirmation sender is not the handoff receiver.',
      nextAction: 'Use the receiver identity; nothing was transferred.',
    };
  const coordinator = record.coordinator ?? null;
  if (!identityMatches(message.to, coordinator))
    return {
      ok: false,
      code: 'confirmation_recipient_mismatch',
      message: 'The confirmation is not addressed to the current coordinator.',
      nextAction:
        'Use the current coordinator recipient; nothing was transferred.',
    };
  if (
    message.owner_epoch === null ||
    message.owner_epoch === undefined ||
    message.owner_epoch !== request.owner_epoch ||
    record.coordinator?.owner_epoch !== request.owner_epoch
  )
    return {
      ok: false,
      code: 'confirmation_epoch_mismatch',
      message: 'The confirmation does not carry the current owner epoch.',
      nextAction:
        'Use a confirmation from the current epoch; nothing was transferred.',
    };
  const recorded = (record.messages ?? []).find(
    (item) => item.message_id === message.message_id,
  );
  if (!recorded || !ACCEPTED_MESSAGE_STATES.has(recorded.state))
    return {
      ok: false,
      code: 'confirmation_not_recorded',
      message: 'The confirmation is not an accepted/recorded protocol entry.',
      nextAction:
        'Register and apply the confirmation through the product message route first.',
    };
  if (
    recorded.type !== message.type ||
    recorded.content_digest !== contentDigest(message)
  )
    return {
      ok: false,
      code: 'confirmation_not_recorded',
      message:
        'The confirmation file does not match its stored protocol entry.',
      nextAction:
        'Re-register the exact confirmation; nothing was transferred.',
    };
  return null;
}

function asTransactionFailure(failure: TaskStoreFailure) {
  return {
    ok: false as const,
    reason: failure.code,
    code: failure.code,
    message: failure.message,
    nextAction: failure.nextAction,
  };
}

function applyPrimitive(
  record: TaskRecord,
  request: CollaborationHandoffRequest,
  confirmation: Message | null,
) {
  switch (request.action) {
    case 'begin':
      return beginHandoff(record, {
        handoffId: request.handoff_id,
        kind: request.kind,
        subtaskId: request.subtask_id ?? null,
        attempt: request.attempt ?? null,
        from: identity(request.from),
        to: identity(request.to),
        resources: request.resources ?? [],
        ownerEpoch: request.owner_epoch,
        reason: request.reason ?? null,
      });
    case 'stopped':
      return markOldWriterStopped(record, {
        handoffId: request.handoff_id,
        observation: request.observation,
        evidenceRef: request.evidence_ref,
        detail: request.detail ?? null,
        actor: request.actor,
      });
    case 'rebind':
      return rebindReceiver(record, {
        handoffId: request.handoff_id,
        to: identity(request.to),
        evidenceRef: request.evidence_ref,
        actor: request.actor,
      });
    case 'transfer':
      return markTransferring(record, {
        handoffId: request.handoff_id,
        partialOutputs: request.partial_outputs ?? [],
        inflight: request.inflight ?? [],
        pendingApprovals: request.pending_approvals ?? [],
        actor: request.actor,
      });
    case 'confirm':
      if (!confirmation)
        return {
          ok: false as const,
          reason: 'confirmation_message_required',
        };
      return confirmReceiver(record, {
        handoffId: request.handoff_id,
        message: confirmation,
      });
    case 'complete':
      return completeHandoff(record, {
        handoffId: request.handoff_id,
        actor: request.actor,
      });
    case 'abort':
      return abortHandoff(record, {
        handoffId: request.handoff_id,
        actor: request.actor,
        ...(request.reason === undefined || request.reason === null
          ? {}
          : { reason: request.reason }),
      });
    case 'release-dispatch':
      return releaseDispatchFreeze(record, {
        actor: request.actor,
        ownerEpoch: request.owner_epoch,
      });
  }
}

export async function planHandoffRequest(
  taskRoot: string,
  request: CollaborationHandoffRequest,
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok) return opened;
  return {
    ok: true,
    value: {
      schema: COLLAB_HANDOFF_SCHEMA,
      ok: true,
      action: request.action,
      applied: false,
      status: 'planned',
      task_root: opened.value.taskRoot,
      task_id: opened.value.record.task_id,
      request: requestSummary(request),
      limits: ['plan_validates_request_and_namespace_only', 'no_reservation'],
    },
  };
}

export async function applyHandoffRequest(
  taskRoot: string,
  request: CollaborationHandoffRequest,
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok) return opened;
  let confirmation: Message | null = null;
  let current: OpenedMessageTask = opened.value;
  if (request.action === 'confirm') {
    const loaded = await readRegisteredMessageSafe(
      current,
      request.confirmation_message_id,
    );
    if (!loaded.ok) return loaded;
    confirmation = loaded.value.message;
    const boundary = validateConfirmation(
      current.record,
      confirmation,
      request,
    );
    if (boundary) return boundary;
  }
  const changed = await assertTaskStoreCurrent(current);
  if (changed !== null) return changed;
  if (request.action === 'confirm') {
    const fresh = await openTaskStore(taskRoot);
    if (!fresh.ok) return fresh;
    current = fresh.value;
    const loaded = await readRegisteredMessageSafe(
      current,
      request.confirmation_message_id,
    );
    if (!loaded.ok) return loaded;
    confirmation = loaded.value.message;
    const boundary = validateConfirmation(
      current.record,
      confirmation,
      request,
    );
    if (boundary) return boundary;
  }

  let outcome: Awaited<ReturnType<typeof transact>>;
  try {
    outcome = transact(current.taskRoot, {
      actor: request.actor,
      purpose: `handoff:${request.action}`,
      expectRevision: request.expect_revision,
      apply: (record) => {
        const epoch = checkOwnerEpoch(record, request.owner_epoch);
        if (!epoch.ok)
          return {
            ok: false as const,
            reason: 'stale_epoch',
            expected: epoch.expected,
            actual: epoch.actual,
          };
        if (request.action === 'confirm') {
          const boundary = validateConfirmation(record, confirmation!, request);
          if (boundary) return asTransactionFailure(boundary);
        }
        const result = applyPrimitive(record, request, confirmation);
        if (!result.ok) return result;
        return {
          record,
          op: `handoff:${request.action}`,
          summary: {
            handoff_id: 'handoff_id' in request ? request.handoff_id : null,
          },
          result,
        };
      },
    });
  } catch {
    return {
      ok: false,
      code: 'handoff_operation_failed',
      message: 'The handoff operation could not be completed.',
      nextAction:
        'Inspect the task and handoff state; no transfer is promised.',
    };
  }
  const { state_revision, result, ...rest } = outcome;
  return {
    ok: true,
    value: {
      schema: COLLAB_HANDOFF_SCHEMA,
      ok: outcome.ok === true,
      action: request.action,
      applied: outcome.ok === true,
      status: outcome.ok === true ? 'applied' : 'refused',
      task_root: current.taskRoot,
      task_id: current.record.task_id,
      ...(outcome.ok === true
        ? { state_revision, result: result ?? null }
        : rest),
      limits: ['cooperative_record_mutation_only', 'no_native_control'],
    },
  };
}

function bounded<T>(items: readonly T[]) {
  return {
    rows: items.slice(0, MAX_INVENTORY_ROWS),
    total: items.length,
    omitted: Math.max(0, items.length - MAX_INVENTORY_ROWS),
    truncated: items.length > MAX_INVENTORY_ROWS,
  };
}

export async function readHandoffInventory(
  taskRoot: string,
  subtaskId: string | null,
  attempt: number | null,
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok) return opened;
  const inventory = handoffInventory(opened.value.record, {
    subtaskId,
    attempt,
  });
  const inflight = bounded(
    inventory.inflight.map((item) => ({
      subtask_id: item.subtask_id,
      attempt: item.attempt,
      state: item.state,
    })),
  );
  const closed = bounded(inventory.closed);
  const approvals = bounded(inventory.pending_approvals);
  const uncertainty = bounded(inventory.uncertainty);
  const resources = bounded(inventory.resources);
  const results = bounded(
    inventory.results.map((item) => ({
      subtask_id: item.subtask_id,
      attempt: item.attempt,
      status: item.status,
      classification: item.classification,
      message_id: item.message_id,
      output_count: Array.isArray(item.outputs) ? item.outputs.length : 0,
    })),
  );
  const handoffs = bounded(inventory.handoffs);
  return {
    ok: true,
    value: {
      schema: COLLAB_HANDOFF_SCHEMA,
      ok: true,
      action: 'inventory',
      task_root: opened.value.taskRoot,
      task_id: opened.value.record.task_id,
      subtask_id: subtaskId,
      attempt,
      coordinator: inventory.coordinator,
      epoch_semantics: inventory.epoch_semantics,
      inflight: inflight.rows,
      closed: closed.rows,
      pending_approvals: approvals.rows,
      uncertainty: uncertainty.rows,
      resources: resources.rows,
      results: results.rows,
      handoffs: handoffs.rows,
      counts: {
        inflight: inflight.total,
        closed: closed.total,
        pending_approvals: approvals.total,
        uncertainty: uncertainty.total,
        resources: resources.total,
        results: results.total,
        handoffs: handoffs.total,
      },
      omitted: {
        inflight: inflight.omitted,
        closed: closed.omitted,
        pending_approvals: approvals.omitted,
        uncertainty: uncertainty.omitted,
        resources: resources.omitted,
        results: results.omitted,
        handoffs: handoffs.omitted,
      },
      truncated:
        inflight.truncated ||
        closed.truncated ||
        approvals.truncated ||
        uncertainty.truncated ||
        resources.truncated ||
        results.truncated ||
        handoffs.truncated,
      limits: ['stored_state_only', 'no_native_query', 'no_message_bodies'],
    },
  };
}

/**
 * Read-only boundary check for a coordinator handoff. It reads stored state only and never
 * queries the native session, so it can say the task is at a boundary but never that the
 * outgoing session has stopped.
 */
export async function readCoordinatorHandoffCheck(
  taskRoot: string,
  options: {
    readonly ignoreHandoffId?: string;
    /** `mid_cohort` judges a handoff made while transferable attempts are still in flight. */
    readonly mode?: 'boundary' | 'mid_cohort';
  } = {},
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok) return opened;
  const record = opened.value.record;
  // A task is workflow-driven when a sealed plan OR manifest exists. Presence is judged with
  // lstat so a dangling or redirected link still counts; the authoritative read below then
  // refuses it. A missing artifact never downgrades the task to "not workflow-driven".
  const present = (file: string) => {
    try {
      lstatSync(file);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  };
  const workflowDriven =
    present(workflowWorkPlanPath(opened.value.taskRoot)) ||
    present(workflowManifestPath(opened.value.taskRoot));
  const midCohort = options.mode === 'mid_cohort';
  const readiness = midCohort
    ? midCohortHandoffReadiness(record, options)
    : coordinatorHandoffReadiness(record, options);
  const blockers: HandoffReadinessFinding[] = [...readiness.blockers];
  const relaxed: HandoffReadinessFinding[] = midCohort
    ? [...(readiness as MidCohortHandoffReadiness).relaxed]
    : [];
  if (midCohort)
    for (const finding of unsupportedSurfaces(record, opened.value.taskRoot))
      blockers.push({
        code: finding.code,
        detail: finding.detail,
        next_action: finding.next_action,
      });
  if (workflowDriven) {
    // Reuse the dispatch evaluator: acceptance is the sealed plan's decision over verified
    // envelopes, not a message id. Every node must be accepted for the cohort to be finished.
    const cohort = evaluateCohortPlan(opened.value.taskRoot, record);
    if (cohort.evaluation === null)
      for (const item of cohort.blockers)
        blockers.push({
          code: item.code,
          detail: item.detail,
          next_action:
            item.next_action ??
            'Reconcile the cohort; an unverifiable cohort is never treated as finished.',
        });
    else {
      const open = cohort.evaluation.nodes.filter(
        (node) => node.status !== 'accepted',
      );
      if (open.length > 0 && midCohort)
        relaxed.push({
          code: 'cohort_node_not_accepted',
          detail: `Not yet accepted by the sealed work plan: ${open.map((node) => `${node.node_id} (${node.status})`).join(', ')}.`,
          next_action:
            'The successor decides these; the plan still names every node.',
        });
      else if (open.length > 0)
        blockers.push({
          code: 'cohort_node_not_accepted',
          detail: `Not accepted by the sealed work plan: ${open.map((node) => `${node.node_id} (${node.status})`).join(', ')}.`,
          next_action:
            'Finish, accept or dispatch each node first; a successor cannot accept work registered under the old epoch.',
        });
    }
  }
  const ready = blockers.length === 0;
  const coordinator = record.coordinator ?? null;
  return {
    ok: true,
    value: {
      schema: COLLAB_HANDOFF_SCHEMA,
      ok: ready,
      action: 'check',
      status: ready ? 'ready' : 'blocked',
      task_root: opened.value.taskRoot,
      task_id: record.task_id,
      coordinator:
        coordinator === null
          ? null
          : {
              agent_id: coordinator.agent_id,
              session_id: coordinator.session_id,
              harness: coordinator.harness ?? null,
              owner_epoch: coordinator.owner_epoch,
            },
      workflow_driven: workflowDriven,
      mode: midCohort ? 'mid_cohort' : 'boundary',
      ...(midCohort
        ? {
            attempts: (readiness as MidCohortHandoffReadiness).attempts,
            relaxed,
          }
        : {}),
      blockers,
      warnings: readiness.warnings,
      fence: {
        kind: 'protocol_fenced',
        process_quiescence: 'unavailable',
        detail:
          'The handoff raises owner_epoch so the old coordinator is refused; it does not stop or observe the old session.',
      },
      next_steps: ready
        ? [
            'collab handoff begin (kind coordinator, current owner_epoch)',
            'collab handoff transfer (stored inventory)',
            'collab handoff confirm (successor ACK or HANDOFF message)',
            'collab handoff complete',
            'collab handoff release-dispatch (by the successor, new epoch)',
            ...(midCohort
              ? [
                  'collab workflow adopt (by the successor, writes the binding generation)',
                ]
              : []),
          ]
        : [],
      limits: ['stored_state_only', 'no_native_query', 'read_only'],
    },
  };
}
