import { isDeepStrictEqual } from 'node:util';
import { hasPendingCancellation } from '../../collab/admission.js';
import {
  contentDigest,
  isSafeMessageId,
  messageFile,
  validateEnvelope,
} from '../../collab/envelope.js';
import {
  ACTIVE_STATES,
  CLOSED_STATES,
  attemptsFor,
} from '../../collab/lifecycle.js';
import type {
  AppliedMessage,
  Attempt,
  Identity,
  Message,
} from '../../collab/types.js';
import { WORKFLOW_MAX_STRING } from '../../schemas/collab-workflow.js';
import {
  anchorTaskNamespace,
  readRecordSafe,
  verifyTaskNamespace,
} from '../collab-recovery-projection.js';
import { readBoundedJson, type OpenedWorkflowTask } from './context.js';

interface MessageEvidence {
  readonly message_id: string;
  readonly content_digest: string;
}

type UnknownReason =
  | 'attempt_not_found'
  | 'attempt_ambiguous'
  | 'attempt_inactive'
  | 'owner_epoch_mismatch'
  | 'snapshot_unavailable'
  | 'assignment_unverified'
  | 'conflicting_gates'
  | 'no_supported_gate'
  | 'approval_evidence_unverified'
  | 'cancel_evidence_unverified';

type InterruptionFinding =
  | {
      readonly kind: 'unknown';
      readonly reason: UnknownReason;
      readonly evidence: null;
    }
  | {
      readonly kind: 'approval_wait';
      readonly reason: 'applied_approval_block';
      readonly evidence: MessageEvidence;
    }
  | {
      readonly kind: 'cancel_requested';
      readonly reason: 'applied_cancel_with_open_uncertainty';
      readonly evidence: MessageEvidence & { readonly uncertainty_id: string };
    };

export type Interruption = InterruptionFinding & {
  readonly scope: 'persisted_history';
  readonly native_status: 'unknown';
  readonly native_cause: 'unknown';
  readonly state_revision: number;
  readonly subtask_id: string;
  readonly attempt: number | null;
  readonly input_revision: string | null;
  readonly owner_epoch: number | null;
  readonly assignment_evidence: MessageEvidence | null;
};

function sameIdentity(left: Identity | null, right: Identity): boolean {
  return (
    left?.agent_id === right.agent_id &&
    left.session_id === right.session_id &&
    left.harness === right.harness
  );
}

function verifiedEnvelope(
  task: OpenedWorkflowTask,
  attempt: Attempt,
  entry: AppliedMessage,
): Message | null {
  const { message_id: id } = entry;
  if (
    !isSafeMessageId(id) ||
    task.record.messages.filter((item) => item.message_id === id).length !== 1
  )
    return null;
  const read = readBoundedJson(
    messageFile(task.taskRoot, id),
    'registered envelope',
  );
  if (!read.ok) return null;
  try {
    const message = validateEnvelope(read.value);
    const digest = contentDigest(message);
    return message.message_id === id &&
      message.type === entry.type &&
      message.task_id === task.record.task_id &&
      message.subtask_id === attempt.subtask_id &&
      message.attempt === attempt.attempt &&
      message.owner_epoch === entry.owner_epoch &&
      message.reply_to === entry.reply_to &&
      sameIdentity(entry.from, message.from) &&
      sameIdentity(entry.to, message.to) &&
      (message.body.kind ?? null) === entry.body_kind &&
      (message.body.input_revision === undefined ||
        message.body.input_revision === attempt.input_revision) &&
      message.content_digest === digest &&
      entry.content_digest === digest
      ? message
      : null;
  } catch {
    return null;
  }
}

function evidenceOf(entry: AppliedMessage): MessageEvidence {
  return { message_id: entry.message_id, content_digest: entry.content_digest };
}

/** Join at most the current ASSIGN and one gate envelope against the same task revision. */
export function projectInterruption(
  task: OpenedWorkflowTask,
  subtaskId: string,
): Interruption {
  const { record } = task;
  const attempts = attemptsFor(record, subtaskId);
  const latest = attempts.at(-1);
  const ambiguous =
    latest !== undefined &&
    attempts
      .slice(0, -1)
      .some(
        (entry) =>
          entry.attempt === latest.attempt ||
          !CLOSED_STATES.includes(entry.state),
      );
  const attempt = ambiguous ? undefined : latest;
  const pinnedInput = attempt?.input_revision;
  const common = {
    scope: 'persisted_history',
    native_status: 'unknown',
    native_cause: 'unknown',
    state_revision: record.state_revision,
    subtask_id: subtaskId,
    attempt: attempt?.attempt ?? null,
    input_revision:
      pinnedInput && pinnedInput.length <= WORKFLOW_MAX_STRING
        ? pinnedInput
        : null,
    owner_epoch: attempt?.owner_epoch ?? null,
  } as const;
  const unknown = (reason: UnknownReason): Interruption => ({
    ...common,
    kind: 'unknown',
    reason,
    assignment_evidence: null,
    evidence: null,
  });
  if (ambiguous) return unknown('attempt_ambiguous');
  if (attempt === undefined) return unknown('attempt_not_found');
  if (!ACTIVE_STATES.includes(attempt.state) && attempt.state !== 'needs_input')
    return unknown('attempt_inactive');

  const coordinator = record.coordinator;
  if (
    coordinator === null ||
    coordinator.owner_epoch <= 0 ||
    coordinator.owner_epoch !== attempt.owner_epoch
  )
    return unknown('owner_epoch_mismatch');

  const scoped = <
    T extends { subtask_id: string | null; attempt: number | null },
  >(
    entry: T,
  ) => entry.subtask_id === subtaskId && entry.attempt === attempt.attempt;
  const applied = record.messages.filter(
    (entry) => scoped(entry) && entry.state === 'applied',
  );
  if (
    applied.some((entry) => entry.type === 'CANCELLED') ||
    attempt.transitions.some((transition) =>
      CLOSED_STATES.includes(transition.to),
    ) ||
    ['transferring', 'transferred', 'cancelled'].includes(
      attempt.ownership ?? '',
    ) ||
    record.handoffs.some(
      (entry) =>
        scoped(entry) &&
        entry.kind === 'writer' &&
        entry.steps.some((step) => step.state === 'old_writer_stopped'),
    )
  )
    return unknown('attempt_inactive');

  // Use the same revision as the ordinary inspect output, even if a writer races the read.
  const namespace = anchorTaskNamespace(task.taskRoot);
  const initial = readRecordSafe(task.taskRoot);
  if (
    namespace === null ||
    ![
      task.opened.identity.taskRoot,
      task.opened.identity.messagesDirectory,
    ].every((identity) =>
      namespace.entries.some(
        (entry) =>
          entry.path === identity.path &&
          entry.dev === identity.dev &&
          entry.ino === identity.ino,
      ),
    ) ||
    !initial.ok ||
    !isDeepStrictEqual(initial.record, record)
  )
    return unknown('snapshot_unavailable');

  const assignmentIndex = applied.findIndex(
    (entry) =>
      entry.type === 'ASSIGN' &&
      entry.message_id === attempt.assignment_message_id,
  );
  const assignment = applied[assignmentIndex];
  const assignMessage = assignment
    ? verifiedEnvelope(task, attempt, assignment)
    : null;
  if (
    !assignment ||
    assignMessage === null ||
    common.input_revision === null ||
    assignMessage.owner_epoch !== coordinator.owner_epoch ||
    !sameIdentity(assignMessage.from, coordinator) ||
    !sameIdentity(assignMessage.to, attempt.assignee) ||
    !/^sha256:[a-f0-9]{64}$/.test(attempt.assignment_digest ?? '') ||
    assignMessage.body.assignment_digest !== attempt.assignment_digest ||
    (assignMessage.body.assignment_ref ?? null) !== attempt.assignment_ref ||
    assignMessage.body.input_revision !== common.input_revision
  )
    return unknown('assignment_unverified');

  const gateFinding = (): InterruptionFinding => {
    const unresolved = (reason: UnknownReason): InterruptionFinding => ({
      kind: 'unknown',
      reason,
      evidence: null,
    });
    // These are current state markers. A prior BLOCK or CANCEL is never a fallback candidate.
    const pending = record.uncertainty.filter(
      (entry) =>
        scoped(entry) &&
        entry.kind === 'cancel_unconfirmed' &&
        entry.resolved_at === null,
    );
    const cancelAt = attempt.cancel_requested_at;
    const cancelGate =
      cancelAt !== undefined ||
      hasPendingCancellation(record, subtaskId, attempt.attempt);
    const blocked =
      attempt.state === 'needs_input' || attempt.awaiting !== undefined;
    if (cancelGate && blocked) return unresolved('conflicting_gates');
    if (attempt.state === 'needs_input' && attempt.awaiting === 'approval') {
      const index = applied.findLastIndex((entry) => entry.type === 'BLOCK');
      const candidate = applied[index];
      // Native observation records can be self-transitions within the same gate.
      const transition = attempt.transitions.findLast(
        (entry) => entry.from !== entry.to,
      );
      if (
        !candidate ||
        index <= assignmentIndex ||
        transition?.to !== 'needs_input' ||
        candidate.applied_at !== transition.at ||
        attempt.transitions.filter((entry) => entry.at === transition.at)
          .length !== 1 ||
        applied.filter(
          (entry) =>
            entry.type === 'BLOCK' && entry.applied_at === transition.at,
        ).length !== 1
      )
        return unresolved('approval_evidence_unverified');
      const block = verifiedEnvelope(task, attempt, candidate);
      if (
        block === null ||
        block.body.kind !== 'approval' ||
        (block.owner_epoch !== null &&
          block.owner_epoch !== coordinator.owner_epoch) ||
        block.from.agent_id !== transition.actor ||
        (block.body.evidence_ref ?? null) !== (transition.evidence ?? null) ||
        !(
          (sameIdentity(block.from, attempt.assignee) &&
            sameIdentity(block.to, coordinator)) ||
          (sameIdentity(block.from, coordinator) &&
            sameIdentity(block.to, attempt.assignee))
        )
      )
        return unresolved('approval_evidence_unverified');
      return {
        kind: 'approval_wait',
        reason: 'applied_approval_block',
        evidence: evidenceOf(candidate),
      };
    }
    if (!cancelGate) return unresolved('no_supported_gate');

    const index = applied.findLastIndex((entry) => entry.type === 'CANCEL');
    const candidate = applied[index];
    const uncertainty = pending[0];
    if (
      !candidate ||
      index <= assignmentIndex ||
      cancelAt === undefined ||
      candidate.applied_at !== cancelAt ||
      pending.length !== 1 ||
      !uncertainty ||
      !isSafeMessageId(uncertainty.uncertainty_id) ||
      // Repeated CANCEL can leave the first request's uncertainty open.
      !(Date.parse(uncertainty.opened_at) <= Date.parse(cancelAt))
    )
      return unresolved('cancel_evidence_unverified');
    const cancel = verifiedEnvelope(task, attempt, candidate);
    if (
      cancel === null ||
      cancel.owner_epoch !== coordinator.owner_epoch ||
      !sameIdentity(cancel.from, coordinator) ||
      !sameIdentity(cancel.to, attempt.assignee)
    )
      return unresolved('cancel_evidence_unverified');
    return {
      kind: 'cancel_requested',
      reason: 'applied_cancel_with_open_uncertainty',
      evidence: {
        ...evidenceOf(candidate),
        uncertainty_id: uncertainty.uncertainty_id,
      },
    };
  };

  const gate = gateFinding();
  const final = readRecordSafe(task.taskRoot);
  if (
    !final.ok ||
    final.digest !== initial.digest ||
    !verifyTaskNamespace(namespace)
  )
    return unknown('snapshot_unavailable');
  return { ...common, ...gate, assignment_evidence: evidenceOf(assignment) };
}
