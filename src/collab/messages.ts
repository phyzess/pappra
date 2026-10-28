import type {
  TaskRecord,
  Message,
  MessageEffect,
  Mutation,
  Failure,
  Identity,
} from './types.js';
import {
  contentDigest,
  readRegisteredMessage,
  registerMessage,
  validateEnvelope,
} from './envelope.js';
import {
  bindNative,
  checkOwnerEpoch,
  findAttempt,
  openUncertainty,
  recordResult,
  resolveUncertainty,
  transitionAttempt,
  upsertAssignment,
  writeResultEvidence,
} from './lifecycle.js';
import { beginHandoff } from './handoff.js';
import {
  coordinatorLineage,
  hasSuccession,
  lineageContains,
  lineageEntry,
} from './lineage.js';
import { nowIso, readRecord, transact } from './store.js';

// Applying a registered message to the record. Registration is atomic and separate;
// this step is a transaction. A message never restarts native work and never releases
// resources on its own.

export type MessageType =
  | 'ASSIGN'
  | 'ACK'
  | 'ASK'
  | 'ANSWER'
  | 'REPORT'
  | 'STATUS_QUERY'
  | 'STATUS'
  | 'HANDOFF'
  | 'BLOCK'
  | 'CANCEL'
  | 'CANCELLED';

/**
 * Who a message type comes from, and whether applying it checks the epoch it carries.
 *
 * `origin` is `coordinator`, `participant`, or `either`; a decision `ANSWER` comes from the
 * coordinator and a clarification `ANSWER` from the asked party, so it is `either`. This table is
 * the single source for the epoch gate below: a new message type must be given an entry (a test
 * fails otherwise) so nobody adds a type without deciding how a coordinator succession treats it
 * (docs/mid-cohort-succession-spec.md, section 6).
 *
 * An ANSWER to a clarification is a reply, not a dispatch: it must already correlate with a stored
 * ASK or BLOCK, so it carries no owner_epoch of its own.
 */
export const MESSAGE_ROLES: Readonly<
  Record<
    MessageType,
    {
      readonly origin: 'coordinator' | 'participant' | 'either';
      readonly epochGated: boolean;
    }
  >
> = Object.freeze({
  ASSIGN: { origin: 'coordinator', epochGated: true },
  CANCEL: { origin: 'coordinator', epochGated: true },
  HANDOFF: { origin: 'either', epochGated: true },
  CANCELLED: { origin: 'participant', epochGated: true },
  ACK: { origin: 'participant', epochGated: false },
  BLOCK: { origin: 'participant', epochGated: false },
  REPORT: { origin: 'participant', epochGated: false },
  ANSWER: { origin: 'either', epochGated: false },
  ASK: { origin: 'either', epochGated: false },
  STATUS: { origin: 'either', epochGated: false },
  STATUS_QUERY: { origin: 'either', epochGated: false },
});

const DISPATCH_TYPES: ReadonlySet<string> = new Set(
  Object.entries(MESSAGE_ROLES)
    .filter(([, role]) => role.epochGated)
    .map(([type]) => type),
);

/**
 * A participant's message answers an attempt it was given, so after a coordinator succession it
 * legitimately carries the epoch that attempt was registered under. Of the participant types only
 * `CANCELLED` is epoch-gated today. It is accepted under an earlier epoch when, and only when, a
 * succession is on record: the epoch is in the lineage and below the current one, the attempt it
 * names exists and was registered under exactly that epoch, and the sender is that attempt's
 * assignee. With no succession on record this never applies, so behaviour is unchanged.
 */
function participantEpochAccepted(
  record: TaskRecord,
  message: Message,
): boolean {
  if (message.type !== 'CANCELLED') return false;
  const lineage = coordinatorLineage(record);
  if (!hasSuccession(lineage)) return false;
  const epoch = message.owner_epoch;
  if (typeof epoch !== 'number' || epoch >= lineage.current!) return false;
  if (!lineageContains(lineage, epoch)) return false;
  if (!message.subtask_id || !message.attempt) return false;
  const attempt = findAttempt(record, message.subtask_id, message.attempt);
  return (
    attempt !== null &&
    attempt.owner_epoch === epoch &&
    sameSender(message.from, attempt.assignee)
  );
}

function alreadyApplied(record: TaskRecord, message: Message) {
  const previous = (record.messages ?? []).find(
    (item) => item.message_id === message.message_id,
  );
  return previous ?? null;
}

function recordMessage(
  record: TaskRecord,
  message: Message,
  state: string,
  detail: string,
  clock: number,
) {
  record.messages = record.messages ?? [];
  record.messages.push({
    message_id: message.message_id,
    type: message.type,
    subtask_id: message.subtask_id ?? null,
    attempt: message.attempt ?? null,
    from: message.from,
    to: message.to ?? null,
    reply_to: message.reply_to ?? null,
    owner_epoch: message.owner_epoch ?? null,
    content_digest: contentDigest(message),
    at: message.created_at ?? nowIso(clock),
    applied_at: nowIso(clock),
    state,
    detail,
    body_kind: message.body?.kind ?? null,
  });
}

function findMessage(record: TaskRecord, messageId: string) {
  return (
    (record.messages ?? []).find((item) => item.message_id === messageId) ??
    null
  );
}

const TO_ONLY_DUPLICATE_TYPES: ReadonlySet<string> = new Set([
  'ACK',
  'REPORT',
  'STATUS',
]);

/**
 * After a coordinator succession a worker re-sending an identical ACK, REPORT or release STATUS
 * stamps `to` with the coordinator of the moment, so the bytes differ from the registered copy in
 * `to` alone. That is a protocol duplicate, not a conflict, when the registered copy was addressed
 * to the coordinator of its own epoch and both were sent by the attempt's assignee. Scope is
 * deliberately narrow: other types, other fields and other recipients stay `content_conflict`.
 * Without a succession it is never true.
 */
export function isToOnlyDuplicate(
  record: TaskRecord,
  existing: Message,
  message: Message,
): boolean {
  if (
    !TO_ONLY_DUPLICATE_TYPES.has(message.type) ||
    existing.type !== message.type ||
    existing.message_id !== message.message_id
  )
    return false;
  const lineage = coordinatorLineage(record);
  if (!hasSuccession(lineage)) return false;
  if (
    existing.subtask_id === null ||
    existing.subtask_id === undefined ||
    existing.attempt === null ||
    existing.attempt === undefined
  )
    return false;
  const attempt = record.attempts.find(
    (item) =>
      item.subtask_id === existing.subtask_id &&
      item.attempt === existing.attempt,
  );
  if (
    attempt === undefined ||
    !sameSender(existing.from, attempt.assignee) ||
    !sameSender(message.from, attempt.assignee)
  )
    return false;
  const entry =
    typeof existing.owner_epoch === 'number'
      ? lineageEntry(lineage, existing.owner_epoch)
      : null;
  if (entry === null || existing.to === null || existing.to === undefined)
    return false;
  // The re-send must address the coordinator of the moment, which is all the participant flow
  // ever stamps; any other address is not this duplicate.
  if (!sameSender(message.to, record.coordinator)) return false;
  if (
    existing.to.agent_id !== entry.identity.agent_id ||
    existing.to.session_id !== entry.identity.session_id
  )
    return false;
  return (
    contentDigest({ ...existing, to: message.to }) === contentDigest(message)
  );
}

function sameSender(sender: Identity, expected: Identity | null | undefined) {
  return (
    expected?.agent_id === sender.agent_id &&
    expected.session_id === sender.session_id
  );
}

/** An epoch identifies the generation of authority, not the agent holding it. */
function authorizeSender(record: TaskRecord, message: Message): Failure | null {
  let expected: Identity | null | undefined;
  switch (message.type) {
    case 'ASSIGN':
    case 'CANCEL':
      expected = record.coordinator;
      break;
    case 'HANDOFF': {
      if (message.body.phase !== 'request') {
        const handoff = record.handoffs.find(
          (item) => item.handoff_id === message.body.handoff_id,
        );
        if (
          handoff &&
          (sameSender(message.from, handoff.from) ||
            sameSender(message.from, handoff.to))
        )
          return null;
        return { ok: false, reason: 'unauthorized_sender' };
      }
      if (message.body.kind === 'coordinator') {
        expected = record.coordinator;
        break;
      }
      expected = findAttempt(
        record,
        message.subtask_id,
        message.attempt,
      )?.assignee;
      break;
    }
    case 'ACK':
    case 'BLOCK':
    case 'CANCELLED': {
      const referenced = message.reply_to
        ? findMessage(record, message.reply_to)
        : null;
      const subtaskId = message.subtask_id ?? referenced?.subtask_id ?? null;
      const attempt = message.attempt ?? referenced?.attempt ?? null;
      const target = findAttempt(record, subtaskId, attempt);
      if (message.type === 'ACK') {
        const handoff = record.handoffs.find(
          (item) =>
            (item.handoff_id === message.body.handoff_id ||
              item.handoff_id === message.reply_to) &&
            (item.kind === 'coordinator' ||
              (item.subtask_id === subtaskId && item.attempt === attempt)) &&
            !['completed', 'aborted'].includes(item.state) &&
            sameSender(
              item.from,
              item.kind === 'coordinator'
                ? record.coordinator
                : target?.assignee,
            ) &&
            sameSender(message.from, item.to),
        );
        if (handoff) return null;
      }
      if (!target) return { ok: false, reason: 'unknown_attempt' };
      if (
        message.type === 'BLOCK' &&
        sameSender(message.from, record.coordinator)
      )
        return null;
      expected = target.assignee;
      break;
    }
    case 'ANSWER': {
      const referenced = message.reply_to
        ? findMessage(record, message.reply_to)
        : null;
      if (!referenced) return { ok: false, reason: 'unknown_question' };
      // Coordinator decisions and instructions are evidence consumed by work-plan
      // and recovery validation. They are not clarification state transitions.
      if (!['ASK', 'BLOCK'].includes(referenced.type)) {
        return sameSender(message.from, record.coordinator)
          ? null
          : { ok: false, reason: 'unauthorized_sender' };
      }
      if (referenced.type === 'BLOCK' && referenced.body_kind === 'approval')
        return { ok: false, reason: 'approval_not_auto_answerable' };
      if (referenced.subtask_id && referenced.attempt) {
        const target = findAttempt(
          record,
          referenced.subtask_id,
          referenced.attempt,
        );
        if (
          (referenced.type === 'BLOCK' && referenced.state !== 'applied') ||
          !(
            sameSender(referenced.from, target?.assignee) ||
            (sameSender(referenced.from, record.coordinator) &&
              referenced.to !== null &&
              sameSender(referenced.to, target?.assignee))
          )
        )
          return { ok: false, reason: 'stale_question' };
      }
      if (
        (message.subtask_id && message.subtask_id !== referenced.subtask_id) ||
        (message.attempt && message.attempt !== referenced.attempt) ||
        !sameSender(message.to, referenced.from)
      )
        return { ok: false, reason: 'reply_identity_mismatch' };
      expected = referenced.to;
      break;
    }
    // REPORT classifies a previous owner's result as evidence without changing the
    // current attempt. Questions and status exchanges confer no execution authority.
    default:
      return null;
  }
  return sameSender(message.from, expected)
    ? null
    : { ok: false, reason: 'unauthorized_sender' };
}

/**
 * Pure-ish apply function for `transact`: returns the outcome object or `{ok:false,...}`.
 */
export function applyMessage(
  record: TaskRecord,
  message: Message,
  {
    clock = Date.now(),
    nativeDir: _nativeDirectory = null,
  }: { clock?: number; nativeDir?: string | null } = {},
): Mutation<MessageEffect> | Failure {
  validateEnvelope(message);
  const previous = alreadyApplied(record, message);
  if (previous) {
    if (previous.content_digest !== contentDigest(message)) {
      return {
        ok: false as const,
        reason: 'content_conflict',
        message_id: message.message_id,
      };
    }
    return {
      ok: false as const,
      reason: 'duplicate_applied',
      message_id: message.message_id,
      state: previous.state,
    };
  }
  if (message.task_id !== record.task_id)
    return {
      ok: false as const,
      reason: 'task_mismatch',
      expected: record.task_id,
    };

  const authorization = authorizeSender(record, message);
  if (authorization) return authorization;

  if (DISPATCH_TYPES.has(message.type)) {
    if (record.dispatch_frozen && message.type === 'ASSIGN') {
      return {
        ok: false as const,
        reason: 'dispatch_frozen',
        detail: 'coordinator handoff is in progress',
      };
    }
    if (message.owner_epoch === null || message.owner_epoch === undefined) {
      return {
        ok: false as const,
        reason: 'epoch_required',
        detail: `${message.type} must carry the owner_epoch it acts under`,
      };
    }
    const epoch = checkOwnerEpoch(record, message.owner_epoch);
    if (!epoch.ok && !participantEpochAccepted(record, message)) {
      openUncertainty(record, {
        kind: 'stale_epoch',
        subtaskId: message.subtask_id ?? null,
        attempt: message.attempt ?? null,
        detail: `${message.type} carried epoch ${message.owner_epoch}, current is ${record.coordinator?.owner_epoch ?? null}`,
        clock,
      });
      // The refusal is recorded so an old owner's attempt to dispatch is visible later.
      return {
        ok: false as const,
        reason: 'stale_epoch',
        expected: epoch.expected,
        actual: epoch.actual,
        commit: true,
        record,
        op: 'stale-epoch',
        summary: { type: message.type },
        result: {
          ok: false as const,
          reason: 'stale_epoch',
          expected: epoch.expected,
          actual: epoch.actual,
        },
      };
    }
  }

  switch (message.type) {
    case 'ASSIGN': {
      const outcome = upsertAssignment(record, {
        message,
        assignmentRef: message.body.assignment_ref ?? null,
        assignmentDigest: message.body.assignment_digest ?? null,
        inputRevision: message.body.input_revision ?? null,
        clock,
      });
      if (!outcome.ok) return outcome;
      recordMessage(record, message, 'applied', 'attempt registered', clock);
      openUncertainty(record, {
        kind: 'registered_not_started',
        subtaskId: message.subtask_id,
        attempt: message.attempt,
        detail:
          'assignment registered; no native launch has been confirmed yet',
        resolutionHint:
          'bind the native run id, or record that nothing started',
        clock,
      });
      return {
        record,
        op: 'assign',
        summary: { subtask_id: message.subtask_id, attempt: message.attempt },
        result: outcome,
      };
    }
    case 'ACK': {
      const referenced = message.reply_to
        ? findMessage(record, message.reply_to)
        : null;
      const subtaskId = message.subtask_id ?? referenced?.subtask_id ?? null;
      const attempt = message.attempt ?? referenced?.attempt ?? null;
      if (!subtaskId || !attempt) {
        recordMessage(
          record,
          message,
          'recorded',
          'acknowledgement without a resolvable assignment',
          clock,
        );
        return {
          record,
          op: 'ack',
          summary: { correlated: false },
          result: { ok: true as const, correlated: false },
        };
      }
      const target = findAttempt(record, subtaskId, attempt);
      if (!target)
        return {
          ok: false as const,
          reason: 'unknown_attempt',
          subtask_id: subtaskId,
          attempt,
        };
      const transition =
        target.state === 'assigned' && sameSender(message.from, target.assignee)
          ? transitionAttempt(record, {
              subtaskId,
              attempt,
              to: 'accepted',
              actor: message.from.agent_id,
              reason: `ack ${message.message_id}`,
              evidence: message.reply_to,
              clock,
            })
          : {
              ok: false as const,
              reason: 'not_awaiting_ack',
              state: target.state,
            };
      recordMessage(
        record,
        message,
        'applied',
        `acknowledgement for ${subtaskId}#${attempt}`,
        clock,
      );
      return {
        record,
        op: 'ack',
        summary: { subtask_id: subtaskId, attempt },
        result: transition,
      };
    }
    case 'ASK': {
      // A question is evidence, not a transition. Blocking a clarification stays
      // BLOCK(kind=clarification); ANSWER resolves only that state. This branch completes
      // the advertised envelope vocabulary without adding authority or execution.
      const subtaskId = message.subtask_id ?? null;
      const attempt = message.attempt ?? null;
      recordMessage(
        record,
        message,
        'recorded',
        'question recorded; no task state change',
        clock,
      );
      return {
        record,
        op: 'ask',
        summary: { subtask_id: subtaskId, attempt },
        result: {
          ok: true as const,
          awaiting: 'response',
          state_changed: false,
        },
      };
    }
    case 'ANSWER': {
      const referenced = message.reply_to
        ? findMessage(record, message.reply_to)
        : null;
      if (referenced?.type === 'BLOCK' && referenced.body_kind === 'approval') {
        return {
          ok: false as const,
          reason: 'approval_not_auto_answerable',
          detail:
            'an approval block is answered by the user, not by another agent',
        };
      }
      const subtaskId = message.subtask_id ?? referenced?.subtask_id ?? null;
      const attempt = message.attempt ?? referenced?.attempt ?? null;
      const target =
        subtaskId && attempt ? findAttempt(record, subtaskId, attempt) : null;
      const transition =
        referenced !== null &&
        ['ASK', 'BLOCK'].includes(referenced.type) &&
        target &&
        target.state === 'needs_input' &&
        target.awaiting === 'clarification'
          ? transitionAttempt(record, {
              subtaskId,
              attempt,
              to: 'running',
              actor: message.from.agent_id,
              reason: `clarification answered by ${message.message_id}`,
              evidence: message.reply_to,
              clock,
            })
          : {
              ok: false as const,
              reason: 'no_open_clarification',
              state: target?.state ?? null,
            };
      recordMessage(
        record,
        message,
        'applied',
        referenced && ['ASK', 'BLOCK'].includes(referenced.type)
          ? 'clarification answer'
          : 'coordinator decision recorded; no task state change',
        clock,
      );
      return {
        record,
        op: 'answer',
        summary: { subtask_id: subtaskId, attempt },
        result: transition,
      };
    }
    case 'REPORT': {
      if (!message.subtask_id || !message.attempt || !message.body.status)
        throw new Error('Invalid report identity or status');
      const reportTarget = findAttempt(
        record,
        message.subtask_id,
        message.attempt,
      );
      if (!reportTarget)
        return { ok: false as const, reason: 'unknown_attempt' };
      const owner = reportTarget.assignee ?? {};
      const senderIsOwner =
        owner.agent_id === message.from.agent_id &&
        owner.session_id === message.from.session_id;
      if (!senderIsOwner) {
        // A previous owner's receipt is evidence, never a state change for the current owner.
        const stale = {
          schema: 'harness-collab/result/1',
          subtask_id: message.subtask_id,
          attempt: message.attempt,
          status: message.body.status,
          message_id: message.message_id,
          input_revision: message.body.input_revision ?? null,
          outputs: message.body.outputs ?? [],
          native_ref: message.body.native_ref ?? null,
          recorded_at: nowIso(clock),
          evidence_ref: message.body.evidence_ref ?? null,
          classification: 'stale_sender',
          reason: `report sent by ${message.from.agent_id}/${message.from.session_id}, current owner is ${owner.agent_id ?? 'unknown'}/${owner.session_id ?? 'unknown'}`,
        };
        record.results = record.results ?? [];
        record.results.push(stale);
        openUncertainty(record, {
          kind: 'late_result',
          subtaskId: message.subtask_id,
          attempt: message.attempt,
          detail: stale.reason,
          evidenceRef: message.body.evidence_ref ?? null,
          resolutionHint:
            'confirm which instance still owns the execution before using this result',
          clock,
        });
        recordMessage(
          record,
          message,
          'applied',
          'report classified stale_sender',
          clock,
        );
        return {
          record,
          op: 'report',
          summary: {
            subtask_id: message.subtask_id,
            attempt: message.attempt,
            classification: 'stale_sender',
          },
          result: {
            ok: true as const,
            classification: 'stale_sender',
            entry: stale,
          },
        };
      }
      const outcome = recordResult(record, {
        subtaskId: message.subtask_id,
        attempt: message.attempt,
        status: message.body.status,
        messageId: message.message_id,
        inputRevision: message.body.input_revision ?? null,
        outputs: message.body.outputs ?? [],
        nativeRef: message.body.native_ref ?? null,
        evidenceRef: message.body.evidence_ref ?? null,
        clock,
      });
      if (!outcome.ok) return outcome;
      recordMessage(
        record,
        message,
        'applied',
        `report classified ${outcome.classification}`,
        clock,
      );
      return {
        record,
        op: 'report',
        summary: {
          subtask_id: message.subtask_id,
          attempt: message.attempt,
          classification: outcome.classification,
        },
        result: outcome,
      };
    }
    case 'STATUS_QUERY':
    case 'STATUS': {
      recordMessage(
        record,
        message,
        'recorded',
        'status exchange; no task state change',
        clock,
      );
      return {
        record,
        op: 'status',
        summary: { type: message.type },
        result: {
          ok: true as const,
          state_revision: record.state_revision,
          attempts: (record.attempts ?? []).map((item) => ({
            subtask_id: item.subtask_id,
            attempt: item.attempt,
            state: item.state,
            native: item.native?.observation ?? 'unknown',
          })),
        },
      };
    }
    case 'BLOCK': {
      const subtaskId = message.subtask_id ?? null;
      const attempt = message.attempt ?? null;
      const kind = message.body.kind;
      if (!kind) throw new Error('Invalid block kind');
      if (!subtaskId || !attempt)
        return { ok: false as const, reason: 'block_requires_attempt' };
      const target = findAttempt(record, subtaskId, attempt);
      if (!target) return { ok: false as const, reason: 'unknown_attempt' };
      target.awaiting = kind;
      const transition = transitionAttempt(record, {
        subtaskId,
        attempt,
        to: 'needs_input',
        actor: message.from.agent_id,
        reason: `blocked: ${kind}`,
        evidence: message.body.evidence_ref ?? null,
        clock,
      });
      if (!transition.ok && transition.reason !== 'already_in_state') {
        delete target.awaiting;
        return transition;
      }
      recordMessage(record, message, 'applied', `block (${kind})`, clock);
      return {
        record,
        op: 'block',
        summary: { subtask_id: subtaskId, attempt, kind },
        result: {
          ok: true as const,
          awaiting: kind,
          human_required: kind === 'approval',
        },
      };
    }
    case 'CANCEL': {
      const subtaskId = message.subtask_id;
      const attempt = message.attempt;
      const target = findAttempt(record, subtaskId, attempt);
      if (!target) return { ok: false as const, reason: 'unknown_attempt' };
      const at = nowIso(clock);
      target.cancel_requested_at = at;
      // The request must use the same predicate as the confirmed cancellation: agent AND
      // session, plus the recorded subtask/attempt. Marking another session's claim would
      // block its later release with a permanent cancel_unconfirmed.
      const cancelHolder = target.assignee ?? {};
      const marked = [];
      for (const claim of record.claims ?? []) {
        if (claim.released_at) continue;
        if (claim.holder?.agent_id !== cancelHolder.agent_id) continue;
        if (
          !cancelHolder.session_id ||
          claim.holder?.session_id !== cancelHolder.session_id
        )
          continue;
        if (claim.subtask_id && claim.subtask_id !== subtaskId) continue;
        if (
          claim.attempt !== null &&
          claim.attempt !== undefined &&
          claim.attempt !== attempt
        )
          continue;
        claim.cancel_pending = true;
        marked.push(claim.claim_id);
      }
      openUncertainty(record, {
        kind: 'cancel_unconfirmed',
        subtaskId,
        attempt,
        detail:
          'cancellation was requested; the native process state is not confirmed',
        resolutionHint:
          'query the native runner; release resources only after a confirmed stop',
        clock,
      });
      recordMessage(
        record,
        message,
        'applied',
        'cancellation requested',
        clock,
      );
      return {
        record,
        op: 'cancel-request',
        summary: { subtask_id: subtaskId, attempt },
        result: {
          ok: true as const,
          cancel_pending: true,
          resources_released: false,
          marked_claims: marked,
        },
      };
    }
    case 'CANCELLED': {
      const subtaskId = message.subtask_id;
      const attempt = message.attempt;
      const target = findAttempt(record, subtaskId, attempt);
      if (!target) return { ok: false as const, reason: 'unknown_attempt' };
      if (!message.body.stop_evidence) {
        return {
          ok: false as const,
          reason: 'stop_evidence_required',
          detail:
            'a cancellation is only recorded as final with evidence that the process stopped',
        };
      }
      const transition = transitionAttempt(record, {
        subtaskId,
        attempt,
        to: 'cancelled',
        actor: message.from.agent_id,
        reason: `cancellation confirmed by ${message.message_id}`,
        evidence: message.body.stop_evidence,
        clock,
      });
      if (!transition.ok && transition.reason !== 'already_in_state')
        return transition;
      // Only the claims this execution actually holds, matched on the full holder identity
      // (agent AND session) and, when recorded, on the same subtask and attempt. A
      // same-named agent in another session keeps its resources.
      const holder = target.assignee ?? {};
      const released: string[] = [];
      for (const claim of record.claims ?? []) {
        if (claim.released_at) continue;
        if (claim.holder?.agent_id !== holder.agent_id) continue;
        if (
          !holder.session_id ||
          claim.holder?.session_id !== holder.session_id
        )
          continue;
        if (claim.subtask_id && claim.subtask_id !== subtaskId) continue;
        if (
          claim.attempt !== null &&
          claim.attempt !== undefined &&
          claim.attempt !== attempt
        )
          continue;
        claim.cancel_pending = false;
        claim.released_at = nowIso(clock);
        claim.released_by = message.from.agent_id;
        claim.release_reason = `cancelled by ${message.message_id}`;
        released.push(claim.claim_id);
      }
      const untouched = (record.claims ?? [])
        .filter(
          (item) =>
            !item.released_at &&
            item.holder?.agent_id === holder.agent_id &&
            !released.includes(item.claim_id),
        )
        .map((item) => item.claim_id);
      for (const entry of record.uncertainty ?? []) {
        if (
          !entry.resolved_at &&
          entry.kind === 'cancel_unconfirmed' &&
          entry.subtask_id === subtaskId &&
          entry.attempt === attempt
        ) {
          resolveUncertainty(record, {
            uncertaintyId: entry.uncertainty_id,
            resolution: 'stop confirmed by the cancellation report',
            resolutionEvidence: message.body.stop_evidence,
            actor: message.from.agent_id,
            clock,
          });
        }
      }
      recordMessage(
        record,
        message,
        'applied',
        'cancellation confirmed; resources released',
        clock,
      );
      return {
        record,
        op: 'cancelled',
        summary: { subtask_id: subtaskId, attempt },
        result: {
          ok: true as const,
          resources_released: true,
          released_claims: released,
          claims_left_untouched: untouched,
        },
      };
    }
    case 'HANDOFF': {
      if (!message.body.handoff_id || message.owner_epoch === null)
        throw new Error('Invalid handoff identity or epoch');
      if (message.body.phase !== 'request') {
        recordMessage(
          record,
          message,
          'recorded',
          `handoff notification (${message.body.phase})`,
          clock,
        );
        return {
          record,
          op: 'handoff-note',
          summary: { phase: message.body.phase },
          result: {
            ok: true as const,
            note: 'notification only; it does not move ownership',
          },
        };
      }
      const outcome = beginHandoff(record, {
        handoffId: message.body.handoff_id,
        kind: message.body.kind ?? 'writer',
        subtaskId: message.subtask_id,
        attempt: message.attempt ?? null,
        from: message.from,
        to: message.to,
        resources: message.body.resources ?? [],
        ownerEpoch: message.owner_epoch,
        reason: message.body.reason ?? null,
        clock,
      });
      if (!outcome.ok) return outcome;
      recordMessage(record, message, 'applied', 'handoff requested', clock);
      return {
        record,
        op: 'handoff-request',
        summary: { handoff_id: message.body.handoff_id },
        result: outcome,
      };
    }
    default:
      return {
        ok: false as const,
        reason: 'unsupported_message_type',
        type: message.type,
      };
  }
}

/**
 * Register and apply one message. Returns the registration result plus the applied
 * outcome; a duplicate registration produces no second side effect.
 */
export function submitMessage(
  taskRoot: string,
  message: Message,
  {
    clock = Date.now(),
    expectRevision,
    waitMs = 5000,
  }: { clock?: number; expectRevision?: number; waitMs?: number } = {},
) {
  const registered = registerMessage(taskRoot, message, { clock });
  if (registered.status === 'content_conflict') {
    const record = readRecord(taskRoot);
    const existing = readRegisteredMessage(taskRoot, message.message_id);
    if (
      record !== null &&
      existing !== null &&
      isToOnlyDuplicate(record, existing, message)
    )
      return {
        ok: true as const,
        registration: {
          status: 'registered-to-earlier-coordinator',
          message_id: message.message_id,
          content_digest: contentDigest(existing),
        },
        duplicate: true,
      };
    return {
      ok: false as const,
      reason: 'content_conflict',
      registration: registered,
    };
  }
  const outcome = transact<MessageEffect>(taskRoot, {
    actor: message.from?.agent_id ?? 'unattributed',
    purpose: `message:${message.type}`,
    expectRevision,
    waitMs,
    clock,
    apply: (record) =>
      applyMessage(record, message, { clock, nativeDir: taskRoot }),
  });
  if (!outcome.ok && outcome.reason === 'duplicate_applied') {
    return {
      ok: true as const,
      registration: registered,
      duplicate: true,
      applied: outcome,
    };
  }
  if (!outcome.ok)
    return {
      ok: false as const,
      reason: outcome.reason,
      registration: registered,
      applied: outcome,
      recorded: outcome.committed === true,
    };
  const result = outcome.result ?? {};
  if (result.entry) {
    try {
      writeResultEvidence(taskRoot, result.entry);
    } catch {
      // Evidence retention failure is reported through doctor, not silently ignored here.
    }
  }
  return {
    ok: true as const,
    registration: registered,
    state_revision: outcome.state_revision,
    applied: outcome,
  };
}

export { bindNative };
