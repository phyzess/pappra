import type { TaskRecord, Identity, Message, Handoff } from './types.js';
import { text } from './validation.js';
import { coordinatorLineage } from './lineage.js';
import { createNonce, nowIso } from './store.js';
import {
  ACTIVE_STATES,
  CLOSED_STATES,
  TERMINAL_STATES,
  findAttempt,
  openUncertainty,
} from './lifecycle.js';

// Writer and coordinator handoff.
//
// A handoff is a recorded sequence, not a message: stop the old writer, capture what
// exists, get the receiver's confirmation, then move ownership and bump the epoch.
// Overlapping resources are never handed over while the old writer's stop is unknown.

export const HANDOFF_KINDS = Object.freeze(['writer', 'coordinator']);
export const HANDOFF_STATES = Object.freeze([
  'requested',
  'old_writer_stopped',
  'transferring',
  'receiver_confirmed',
  'completed',
  'aborted',
]);

const SEQUENCE: Record<string, string | null> = {
  requested: 'old_writer_stopped',
  old_writer_stopped: 'transferring',
  transferring: 'receiver_confirmed',
  receiver_confirmed: 'completed',
  completed: null,
  aborted: null,
};

export function findHandoff(record: TaskRecord, handoffId: string) {
  return (
    (record.handoffs ?? []).find((item) => item.handoff_id === handoffId) ??
    null
  );
}

export function beginHandoff(
  record: TaskRecord,
  {
    handoffId,
    kind,
    subtaskId = null,
    attempt = null,
    from,
    to,
    resources = [],
    ownerEpoch,
    clock = Date.now(),
    reason = null,
  }: {
    handoffId: string;
    kind: string;
    subtaskId?: string | null;
    attempt?: number | null;
    from: Identity;
    to: Identity;
    resources?: string[];
    ownerEpoch: number;
    clock?: number;
    reason?: string | null;
  },
) {
  if (!HANDOFF_KINDS.includes(kind))
    return { ok: false as const, reason: 'invalid_handoff_kind' };
  if (!text(handoffId))
    return { ok: false as const, reason: 'handoff_id_required' };
  if (findHandoff(record, handoffId))
    return { ok: false as const, reason: 'handoff_exists' };
  // Two open handoffs over the same resources (or the same writer attempt) would let the
  // second one reuse the first one's stop evidence.
  const open = (record.handoffs ?? []).filter(
    (item) => !['completed', 'aborted'].includes(item.state),
  );
  for (const other of open) {
    const sharedResources = (other.resources ?? []).filter((id) =>
      (resources ?? []).includes(id),
    );
    const sameAttempt =
      kind === 'writer' &&
      other.kind === 'writer' &&
      other.subtask_id === subtaskId &&
      other.attempt === attempt;
    if (sharedResources.length || sameAttempt) {
      return {
        ok: false as const,
        reason: 'overlapping_handoff',
        other_handoff: other.handoff_id,
        other_state: other.state,
        shared_resources: sharedResources,
      };
    }
  }
  if (kind === 'coordinator') {
    const otherCoordinator = open.find((item) => item.kind === 'coordinator');
    if (otherCoordinator)
      return {
        ok: false as const,
        reason: 'overlapping_handoff',
        other_handoff: otherCoordinator.handoff_id,
        other_state: otherCoordinator.state,
      };
  }
  if (ownerEpoch !== record.coordinator?.owner_epoch) {
    return {
      ok: false as const,
      reason: 'stale_epoch',
      expected: record.coordinator?.owner_epoch ?? null,
      actual: ownerEpoch ?? null,
    };
  }
  const target =
    kind === 'writer' ? findAttempt(record, subtaskId, attempt) : null;
  if (kind === 'writer' && !target)
    return { ok: false as const, reason: 'unknown_attempt' };
  const authority = kind === 'writer' ? target?.assignee : record.coordinator;
  if (
    !authority ||
    authority.agent_id !== from.agent_id ||
    authority.session_id !== from.session_id
  )
    return { ok: false as const, reason: 'unauthorized_sender' };
  const seen = new Set<string>();
  for (const claimId of resources) {
    if (seen.has(claimId))
      return {
        ok: false as const,
        reason: 'duplicate_handoff_resource',
        claim_id: claimId,
      };
    seen.add(claimId);
    const matches = (record.claims ?? []).filter(
      (claim) => claim.claim_id === claimId,
    );
    if (matches.length !== 1)
      return {
        ok: false as const,
        reason: matches.length ? 'ambiguous_claim_id' : 'unknown_claim',
        claim_id: claimId,
      };
    const claim = matches[0]!;
    if (
      claim.released_at ||
      claim.holder?.agent_id !== from.agent_id ||
      claim.holder?.session_id !== from.session_id ||
      (kind === 'writer' &&
        ((claim.subtask_id !== null && claim.subtask_id !== subtaskId) ||
          (claim.attempt !== null && claim.attempt !== attempt)))
    )
      return {
        ok: false as const,
        reason: 'handoff_resource_not_owned',
        claim_id: claimId,
      };
  }
  // Validate the entire inventory before reserving an attempt or freezing dispatch.
  if (target) target.ownership = 'transferring';
  const at = nowIso(clock);
  const entry = {
    schema: 'harness-collab/handoff/1',
    handoff_id: handoffId,
    kind,
    subtask_id: subtaskId,
    attempt,
    from,
    to,
    resources,
    ownership_snapshot: (resources ?? []).map((claimId) => {
      const claim = (record.claims ?? []).find(
        (item) => item.claim_id === claimId,
      );
      return claim
        ? {
            claim_id: claimId,
            holder: claim.holder ?? null,
            resource_epoch: claim.resource_epoch ?? null,
            released_at: claim.released_at ?? null,
          }
        : { claim_id: claimId, missing: true };
    }),
    state: 'requested',
    owner_epoch: ownerEpoch,
    created_at: at,
    updated_at: at,
    reason,
    steps: [
      { state: 'requested', at, actor: from?.agent_id ?? 'unattributed' },
    ],
    partial_outputs: [],
    inflight: [],
    pending_approvals: [],
    confirmation_message_id: null,
  };
  record.handoffs = record.handoffs ?? [];
  record.handoffs.push(entry);
  if (kind === 'coordinator') record.dispatch_frozen = true;
  return { ok: true as const, handoff_id: handoffId, state: 'requested' };
}

function advance(
  entry: Handoff,
  state: string,
  step: { actor: string; [key: string]: unknown },
  clock: number,
) {
  let expected = SEQUENCE[entry.state];
  // A coordinator handoff has no writer process to stop: the freeze plus the captured
  // inventory is the barrier, so `old_writer_stopped` is skipped for that kind.
  if (
    entry.kind === 'coordinator' &&
    entry.state === 'requested' &&
    state === 'transferring'
  ) {
    expected = 'transferring';
  }
  if (expected !== state)
    return {
      ok: false as const,
      reason: 'invalid_handoff_transition',
      from: entry.state,
      to: state,
      expected,
    };
  const at = nowIso(clock);
  entry.state = state;
  entry.updated_at = at;
  entry.steps.push({ state, at, ...step });
  return { ok: true as const, state, at };
}

/**
 * Record that the previous writer stopped. An `unknown` observation is refused: without
 * confirmed stopping, overlapping resources stay where they are.
 */
export function markOldWriterStopped(
  record: TaskRecord,
  {
    handoffId,
    observation,
    evidenceRef = null,
    detail = null,
    actor,
    clock = Date.now(),
  }: {
    handoffId: string;
    observation: string;
    evidenceRef?: string | null;
    detail?: string | null;
    actor?: string;
    clock?: number;
  },
) {
  const entry = findHandoff(record, handoffId);
  if (!entry) return { ok: false as const, reason: 'unknown_handoff' };
  if (observation !== 'confirmed') {
    openUncertainty(record, {
      kind: 'cancel_unconfirmed',
      subtaskId: entry.subtask_id,
      attempt: entry.attempt,
      detail:
        detail ??
        'old writer stop was not confirmed; resources are not transferred',
      evidenceRef,
      resolutionHint:
        'query the native runner for the process/run state before retrying the handoff',
      clock,
    });
    return { ok: false as const, reason: 'old_writer_not_stopped' };
  }
  if (!text(evidenceRef))
    return { ok: false as const, reason: 'stop_evidence_required' };
  return advance(
    entry,
    'old_writer_stopped',
    { actor: actor ?? 'unattributed', evidence: evidenceRef, observation },
    clock,
  );
}

/**
 * Bind the receiver's real identity once its native session is observed. A handoff may be
 * requested before the receiver session exists; the identity is then a placeholder and the
 * confirmation would not correlate. Rebinding requires native evidence and is recorded.
 */
export function rebindReceiver(
  record: TaskRecord,
  {
    handoffId,
    to,
    evidenceRef,
    actor,
    clock = Date.now(),
  }: {
    handoffId: string;
    to: Identity;
    evidenceRef: string;
    actor?: string;
    clock?: number;
  },
) {
  const entry = findHandoff(record, handoffId);
  if (!entry) return { ok: false as const, reason: 'unknown_handoff' };
  if (['completed', 'aborted'].includes(entry.state))
    return { ok: false as const, reason: 'handoff_closed', state: entry.state };
  if (entry.state === 'receiver_confirmed') {
    // The confirmation belongs to the receiver that gave it. Rebinding after confirmation
    // would let one party's acknowledgement authorise a transfer to another party.
    return {
      ok: false as const,
      reason: 'already_confirmed',
      detail:
        'abort this handoff and open a new one instead of rebinding a confirmed receiver',
      confirmed_receiver: entry.to,
    };
  }
  if (!to?.agent_id || !to?.session_id)
    return { ok: false as const, reason: 'invalid_receiver' };
  if (!text(evidenceRef))
    return { ok: false as const, reason: 'receiver_evidence_required' };
  const previous = entry.to;
  entry.to = {
    agent_id: to.agent_id,
    session_id: to.session_id,
    harness: to.harness ?? entry.to?.harness ?? null,
  };
  entry.updated_at = nowIso(clock);
  entry.steps.push({
    state: entry.state,
    at: entry.updated_at,
    actor: actor ?? 'unattributed',
    rebind_receiver: entry.to,
    previous_receiver: previous,
    evidence: evidenceRef,
  });
  return { ok: true as const, to: entry.to, previous };
}

export function markTransferring(
  record: TaskRecord,
  {
    handoffId,
    partialOutputs = [],
    inflight = [],
    pendingApprovals = [],
    actor,
    clock = Date.now(),
  }: {
    handoffId: string;
    partialOutputs?: unknown[];
    inflight?: unknown[];
    pendingApprovals?: unknown[];
    actor?: string;
    clock?: number;
  },
) {
  const entry = findHandoff(record, handoffId);
  if (!entry) return { ok: false as const, reason: 'unknown_handoff' };
  if (
    !Array.isArray(partialOutputs) ||
    !Array.isArray(inflight) ||
    !Array.isArray(pendingApprovals)
  ) {
    return { ok: false as const, reason: 'invalid_inventory' };
  }
  const result = advance(
    entry,
    'transferring',
    {
      actor: actor ?? 'unattributed',
      partial_outputs: partialOutputs.length,
      inflight: inflight.length,
    },
    clock,
  );
  if (!result.ok) return result;
  entry.partial_outputs = partialOutputs;
  entry.inflight = inflight;
  entry.pending_approvals = pendingApprovals;
  // Freeze the ownership this transfer is based on; completion must find the same state.
  entry.ownership_snapshot = (entry.resources ?? []).map((claimId) => {
    const claim = (record.claims ?? []).find(
      (item) => item.claim_id === claimId,
    );
    return claim
      ? {
          claim_id: claimId,
          holder: claim.holder ?? null,
          resource_epoch: claim.resource_epoch ?? null,
          released_at: claim.released_at ?? null,
        }
      : { claim_id: claimId, missing: true };
  });
  entry.snapshot_at = entry.updated_at;
  return result;
}

/** The receiver's acknowledgement must be a stored message that replies to this handoff. */
export function confirmReceiver(
  record: TaskRecord,
  {
    handoffId,
    message,
    clock = Date.now(),
  }: { handoffId: string; message: Message | null; clock?: number },
) {
  const entry = findHandoff(record, handoffId);
  if (!entry) return { ok: false as const, reason: 'unknown_handoff' };
  if (!message)
    return { ok: false as const, reason: 'confirmation_message_required' };
  if (!['ACK', 'HANDOFF'].includes(message.type))
    return {
      ok: false as const,
      reason: 'confirmation_type_invalid',
      type: message.type,
    };
  if (
    message.from?.agent_id !== entry.to?.agent_id ||
    message.from?.session_id !== entry.to?.session_id
  ) {
    return { ok: false as const, reason: 'confirmation_identity_mismatch' };
  }
  if (message.body?.handoff_id && message.body.handoff_id !== handoffId)
    return { ok: false as const, reason: 'confirmation_handoff_mismatch' };
  const result = advance(
    entry,
    'receiver_confirmed',
    { actor: message.from.agent_id, message_id: message.message_id },
    clock,
  );
  if (!result.ok) return result;
  entry.confirmation_message_id = message.message_id;
  return result;
}

/**
 * Complete the handoff: move ownership and raise the epoch. Old-epoch commands are
 * rejected by the epoch check, so the previous owner cannot keep dispatching.
 */
export function completeHandoff(
  record: TaskRecord,
  {
    handoffId,
    actor,
    clock = Date.now(),
  }: { handoffId: string; actor?: string; clock?: number },
) {
  const entry = findHandoff(record, handoffId);
  if (!entry) return { ok: false as const, reason: 'unknown_handoff' };
  // The transfer must be based on the ownership it snapshotted, not on whatever the record
  // says now. A handoff completed by anyone else, a released claim or a moved resource epoch
  // all invalidate this one.
  const snapshot = entry.ownership_snapshot ?? [];
  const drift = [];
  for (const expected of snapshot) {
    const claim = (record.claims ?? []).find(
      (item) => item.claim_id === expected.claim_id,
    );
    if (!claim || expected.missing)
      drift.push({ claim_id: expected.claim_id, reason: 'claim_missing' });
    else if (claim.released_at)
      drift.push({ claim_id: expected.claim_id, reason: 'claim_released' });
    else if (
      (claim.resource_epoch ?? null) !== (expected.resource_epoch ?? null)
    )
      drift.push({
        claim_id: expected.claim_id,
        reason: 'resource_epoch_changed',
        expected: expected.resource_epoch,
        actual: claim.resource_epoch,
      });
    else if (
      !expected.holder ||
      claim.holder?.agent_id !== expected.holder.agent_id ||
      claim.holder?.session_id !== expected.holder.session_id
    ) {
      drift.push({
        claim_id: expected.claim_id,
        reason: 'holder_changed',
        expected: expected.holder,
        actual: claim.holder,
      });
    } else if (
      entry.from &&
      (claim.holder?.agent_id !== entry.from.agent_id ||
        claim.holder?.session_id !== entry.from.session_id)
    ) {
      // The handoff claims to move a resource away from `from`; if `from` is not the holder,
      // this handoff is reusing someone else's ownership state.
      drift.push({
        claim_id: expected.claim_id,
        reason: 'holder_is_not_from',
        from: entry.from,
        actual: claim.holder,
      });
    }
  }
  if (drift.length) {
    entry.updated_at = nowIso(clock);
    entry.steps.push({
      state: entry.state,
      at: entry.updated_at,
      actor: actor ?? 'unattributed',
      refused: 'ownership_changed',
      drift,
    });
    openUncertainty(record, {
      kind: 'late_result',
      subtaskId: entry.subtask_id,
      attempt: entry.attempt,
      detail: `handoff ${handoffId} refused: the ownership it snapshotted changed`,
      resolutionHint:
        'reconcile the current holder before opening a new handoff',
      clock,
    });
    return { ok: false as const, reason: 'ownership_changed', drift };
  }
  // A handoff is an act of the coordinator that requested it, so a coordinator change
  // invalidates writer handoffs too, not just coordinator transfers.
  if (record.coordinator?.owner_epoch !== entry.owner_epoch) {
    return {
      ok: false as const,
      reason: 'stale_epoch',
      expected: entry.owner_epoch,
      actual: record.coordinator?.owner_epoch ?? null,
    };
  }
  const result = advance(
    entry,
    'completed',
    { actor: actor ?? 'unattributed' },
    clock,
  );
  if (!result.ok) return result;
  const at = nowIso(clock);
  if (entry.kind === 'coordinator') {
    const previous = record.coordinator;
    record.coordinator = {
      ...entry.to,
      owner_epoch: (previous?.owner_epoch ?? 0) + 1,
      since: at,
      previous: previous
        ? {
            agent_id: previous.agent_id,
            session_id: previous.session_id,
            owner_epoch: previous.owner_epoch,
          }
        : null,
    };
    entry.previous_coordinator = previous ?? null;
    entry.owner_epoch = record.coordinator.owner_epoch;
    // Dispatch stays frozen until the new coordinator explicitly releases it.
    record.dispatch_frozen = true;
  } else {
    entry.resource_transfers = [];
    for (const claimId of entry.resources) {
      const claim = (record.claims ?? []).find(
        (item) => item.claim_id === claimId,
      );
      if (!claim) continue;
      const from = claim.holder;
      claim.holder = {
        agent_id: entry.to.agent_id,
        session_id: entry.to.session_id,
        harness: entry.to.harness ?? null,
      };
      claim.resource_epoch = (claim.resource_epoch ?? 0) + 1;
      claim.transferred_from = from;
      claim.transferred_at = at;
      entry.resource_transfers.push({
        claim_id: claimId,
        resource_epoch: claim.resource_epoch,
        from,
      });
    }
    const target = findAttempt(record, entry.subtask_id, entry.attempt);
    if (target) {
      target.ownership = 'transferred';
      target.assignee = {
        agent_id: entry.to.agent_id,
        session_id: entry.to.session_id,
        harness: entry.to.harness ?? null,
      };
      target.updated_at = at;
      target.transitions = target.transitions ?? [];
      target.transitions.push({
        from: target.state,
        to: target.state,
        at,
        actor: actor ?? 'unattributed',
        reason: `ownership transferred by ${handoffId}`,
        evidence: entry.confirmation_message_id,
      });
    }
  }
  return result;
}

export function abortHandoff(
  record: TaskRecord,
  {
    handoffId,
    actor,
    reason,
    clock = Date.now(),
  }: { handoffId: string; actor?: string; reason?: string; clock?: number },
) {
  const entry = findHandoff(record, handoffId);
  if (!entry) return { ok: false as const, reason: 'unknown_handoff' };
  if (entry.state === 'completed')
    return { ok: false as const, reason: 'already_completed' };
  const at = nowIso(clock);
  entry.state = 'aborted';
  entry.updated_at = at;
  entry.steps.push({
    state: 'aborted',
    at,
    actor: actor ?? 'unattributed',
    reason: reason ?? null,
  });
  const target = findAttempt(record, entry.subtask_id, entry.attempt);
  if (target && target.ownership === 'transferring') {
    // Ownership returns to the previous holder: nothing moved.
    target.ownership = 'retained';
    target.updated_at = at;
  }
  return { ok: true as const, state: 'aborted' };
}

export function releaseDispatchFreeze(
  record: TaskRecord,
  {
    actor,
    ownerEpoch,
    clock = Date.now(),
  }: { actor?: string; ownerEpoch: number; clock?: number },
) {
  if (ownerEpoch !== record.coordinator?.owner_epoch)
    return {
      ok: false as const,
      reason: 'stale_epoch',
      expected: record.coordinator?.owner_epoch ?? null,
      actual: ownerEpoch ?? null,
    };
  record.dispatch_frozen = false;
  record.dispatch_released_at = nowIso(clock);
  record.dispatch_released_by = actor ?? 'unattributed';
  return { ok: true as const, dispatch_frozen: false };
}

/** Snapshot of what a handing-over owner must account for. */
export function handoffInventory(
  record: TaskRecord,
  {
    subtaskId = null,
    attempt = null,
  }: { subtaskId?: string | null; attempt?: number | null },
) {
  const attempts = (record.attempts ?? []).filter(
    (item) =>
      (subtaskId === null || item.subtask_id === subtaskId) &&
      (attempt === null || item.attempt === attempt),
  );
  return {
    inflight: attempts
      .filter((item) => ACTIVE_STATES.includes(item.state))
      .map((item) => ({
        subtask_id: item.subtask_id,
        attempt: item.attempt,
        state: item.state,
        native: item.native ?? null,
      })),
    closed: attempts
      .filter((item) => TERMINAL_STATES.includes(item.state))
      .map((item) => ({
        subtask_id: item.subtask_id,
        attempt: item.attempt,
        state: item.state,
      })),
    pending_approvals: (record.attempts ?? [])
      .filter(
        (item) => item.state === 'needs_input' && item.awaiting === 'approval',
      )
      .map((item) => ({ subtask_id: item.subtask_id, attempt: item.attempt })),
    uncertainty: (record.uncertainty ?? [])
      .filter((item) => !item.resolved_at)
      .map((item) => ({
        uncertainty_id: item.uncertainty_id,
        kind: item.kind,
        subtask_id: item.subtask_id,
        attempt: item.attempt,
      })),
    resources: (record.claims ?? [])
      .filter((item) => !item.released_at)
      .map((item) => ({
        claim_id: item.claim_id,
        key: item.key,
        holder: item.holder,
        resource_epoch: item.resource_epoch,
      })),
    // Admitted results with their output digests, so a receiver can see what exists.
    results: (record.results ?? []).map((item) => ({
      subtask_id: item.subtask_id,
      attempt: item.attempt,
      status: item.status,
      classification: item.classification,
      message_id: item.message_id,
      outputs: item.outputs ?? [],
    })),
    handoffs: (record.handoffs ?? []).map((item) => ({
      handoff_id: item.handoff_id,
      kind: item.kind,
      state: item.state,
    })),
    coordinator: record.coordinator ?? null,
    epoch_semantics: {
      owner_epoch:
        'coordinator authority counter; only a coordinator handoff raises it',
      state_revision: record.state_revision,
      resource_epoch:
        'per-resource claim counter; a writer handoff or a new claim raises it',
      note: 'owner_epoch and resource_epoch are independent counters and do not have to match each other',
    },
  };
}

export function newHandoffId(prefix = 'handoff') {
  return `${prefix}-${createNonce()}`;
}

export interface HandoffReadinessFinding {
  readonly code: string;
  readonly detail: string;
  readonly next_action: string;
}

export interface CoordinatorHandoffReadiness {
  readonly ready: boolean;
  readonly blockers: readonly HandoffReadinessFinding[];
  readonly warnings: readonly HandoffReadinessFinding[];
}

/**
 * Read-only: is the task at a cohort boundary where the coordinator can change safely?
 *
 * A coordinator handoff raises `owner_epoch`, and nothing re-stamps attempts or the sealed
 * work plan afterwards, so a successor cannot accept work registered under the old epoch.
 * Anything still in progress therefore blocks the handoff. This function judges the record
 * only; for a task driven by the typed workflow the caller adds the authoritative plan
 * evaluation, because acceptance is decided by the work plan and never by a message name.
 */
export function coordinatorHandoffReadiness(
  record: TaskRecord,
  options: {
    /** The handoff being driven right now must not block itself. */
    readonly ignoreHandoffId?: string;
  } = {},
): CoordinatorHandoffReadiness {
  const blockers: HandoffReadinessFinding[] = [];
  const warnings: HandoffReadinessFinding[] = [];
  const coordinator = record.coordinator ?? null;
  if (coordinator === null)
    blockers.push({
      code: 'no_coordinator',
      detail: 'The task record names no coordinator.',
      next_action: 'Inspect the task record; there is nothing to hand off.',
    });
  const label = (item: { subtask_id: string; attempt: number }) =>
    `${item.subtask_id}#${String(item.attempt)}`;
  const open = (record.handoffs ?? []).filter(
    (item) =>
      !['completed', 'aborted'].includes(item.state) &&
      item.handoff_id !== options.ignoreHandoffId,
  );
  if (open.length > 0)
    blockers.push({
      code: 'handoff_open',
      detail: `Open handoff(s): ${open.map((item) => `${item.handoff_id} (${item.state})`).join(', ')}.`,
      next_action: 'Complete or abort the open handoff first.',
    });
  const attempts = record.attempts ?? [];
  const live = attempts.filter((item) => ACTIVE_STATES.includes(item.state));
  if (live.length > 0)
    blockers.push({
      code: 'attempt_in_flight',
      detail: `Still running or awaiting a result: ${live.map(label).join(', ')}.`,
      next_action:
        'Wait for each attempt to finish and be decided, or cancel it, before handing off.',
    });
  const blocked = attempts.filter((item) => item.state === 'needs_input');
  if (blocked.length > 0)
    blockers.push({
      code: 'attempt_needs_input',
      detail: `Waiting for input: ${blocked.map(label).join(', ')}.`,
      next_action: 'Resolve or cancel the blocked attempt before handing off.',
    });
  const held = (record.claims ?? []).filter((item) => !item.released_at);
  const heldBySource = held.filter(
    (item) =>
      coordinator !== null &&
      item.holder?.agent_id === coordinator.agent_id &&
      item.holder?.session_id === coordinator.session_id,
  );
  if (heldBySource.length > 0)
    blockers.push({
      code: 'source_holds_claims',
      detail: `The current coordinator itself holds ${String(heldBySource.length)} unreleased claim(s).`,
      next_action:
        'Release them first; a protocol-only handoff does not stop the old session, so it must not keep write authority.',
    });
  const heldByOthers = held.length - heldBySource.length;
  if (heldByOthers > 0)
    blockers.push({
      code: 'claims_unreleased',
      detail: `${String(heldByOthers)} claim(s) held by other participants are not released.`,
      next_action:
        'Wait for the holders to release, or reconcile the claims, before handing off.',
    });
  for (const item of (record.uncertainty ?? []).filter(
    (entry) => !entry.resolved_at,
  )) {
    const target =
      item.subtask_id !== null && item.attempt !== null
        ? findAttempt(record, item.subtask_id, item.attempt)
        : null;
    const finding = {
      code:
        target !== null && CLOSED_STATES.includes(target.state)
          ? 'uncertainty_on_closed_attempt'
          : 'uncertainty_open',
      detail: `${item.uncertainty_id} (${item.kind})${
        item.subtask_id === null
          ? ''
          : ` on ${item.subtask_id}#${String(item.attempt)}`
      } is unresolved.`,
      next_action: 'Reconcile the uncertainty with actual evidence.',
    };
    // An unresolved ledger entry on an attempt that already ended is residue, not live risk.
    (finding.code === 'uncertainty_open' ? blockers : warnings).push(finding);
  }
  if (record.dispatch_frozen === true)
    warnings.push({
      code: 'dispatch_frozen',
      detail: 'Dispatch is already frozen by an earlier handoff.',
      next_action: 'The incoming coordinator must release it explicitly.',
    });
  return { ready: blockers.length === 0, blockers, warnings };
}

export interface AttemptTransferability {
  readonly subtask_id: string;
  readonly attempt: number;
  readonly state: string;
  readonly transferable: boolean;
  readonly next_action: string | null;
}

export interface MidCohortHandoffReadiness extends CoordinatorHandoffReadiness {
  readonly attempts: readonly AttemptTransferability[];
  /** Every blocker of the boundary check that this mode does not enforce, and why. */
  readonly relaxed: readonly HandoffReadinessFinding[];
}

/**
 * Classifies an attempt for a coordinator handoff made while it is still in flight
 * (docs/mid-cohort-succession-spec.md, section 7). A worker can carry on without the outgoing
 * coordinator when it has acknowledged (`accepted`) or is `running`; a finished attempt is
 * decided by the successor. An attempt that was only assigned, whose state is unknown, or that
 * waits for an answer addressed to the outgoing coordinator cannot be handed over.
 */
function classifyAttempt(
  record: TaskRecord,
  attempt: TaskRecord['attempts'][number],
): AttemptTransferability {
  const base = {
    subtask_id: attempt.subtask_id,
    attempt: attempt.attempt,
    state: attempt.state,
  };
  // An acknowledgement alone does not prove the worker runs: until a native observation answers
  // "registered but not started", the successor would inherit an attempt nobody can prove alive.
  if (
    (attempt.state === 'accepted' || attempt.state === 'running') &&
    (record.uncertainty ?? []).some(
      (item) =>
        !item.resolved_at &&
        item.kind === 'registered_not_started' &&
        item.subtask_id === attempt.subtask_id &&
        item.attempt === attempt.attempt,
    )
  )
    return {
      ...base,
      transferable: false,
      next_action:
        'Bind native evidence for the attempt, or resolve its registered_not_started uncertainty, before handing off.',
    };
  switch (attempt.state) {
    case 'accepted':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return { ...base, transferable: true, next_action: null };
    case 'assigned':
      return {
        ...base,
        transferable: false,
        next_action:
          'Deliver and acknowledge the assignment, or cancel the attempt, before handing off: its delivery depends on the outgoing coordinator.',
      };
    case 'needs_input':
      return {
        ...base,
        transferable: false,
        next_action:
          'Answer or cancel the blocked attempt: an answer is authorized against the coordinator the question was addressed to.',
      };
    default:
      return {
        ...base,
        transferable: false,
        next_action:
          'Reconcile the attempt state with native evidence before handing off.',
      };
  }
}

/**
 * Read-only: can the coordinator change safely NOW, with workers still running?
 *
 * It starts from the boundary check and relaxes only what a successor can take over: attempts in
 * flight that are transferable, and claims those attempts hold under their own subtask and
 * attempt. Everything else keeps blocking, and every relaxed item is reported with its reason.
 * Cohort acceptance is relaxed by the caller, which owns the plan evaluation.
 */
export function midCohortHandoffReadiness(
  record: TaskRecord,
  options: { readonly ignoreHandoffId?: string } = {},
): MidCohortHandoffReadiness {
  const base = coordinatorHandoffReadiness(record, options);
  const attempts = (record.attempts ?? []).map((item) =>
    classifyAttempt(record, item),
  );
  const transferable = new Set(
    attempts
      .filter((item) => item.transferable)
      .map((item) => `${item.subtask_id}#${String(item.attempt)}`),
  );
  const blockers: HandoffReadinessFinding[] = [];
  const relaxed: HandoffReadinessFinding[] = [];
  const lineage = coordinatorLineage(record);
  if (!lineage.valid)
    blockers.push({
      code: 'lineage_invalid',
      detail: `The coordinator lineage cannot be established: ${lineage.detail}`,
      next_action:
        'Inspect the coordinator handoff history; a task with an invalid lineage keeps the boundary check.',
    });
  for (const item of attempts.filter(
    (entry) =>
      !entry.transferable &&
      // needs_input keeps its own boundary blocker below.
      entry.state !== 'needs_input',
  ))
    blockers.push({
      code: 'attempt_not_transferable',
      detail: `${item.subtask_id}#${String(item.attempt)} is ${item.state} and cannot be carried over by a successor.`,
      next_action: item.next_action ?? 'Resolve the attempt first.',
    });
  const held = (record.claims ?? []).filter((item) => !item.released_at);
  const tiedToTransferable = held.filter(
    (item) =>
      item.subtask_id !== null &&
      item.attempt !== null &&
      transferable.has(`${item.subtask_id}#${String(item.attempt)}`) &&
      sameHolder(
        findAttempt(record, item.subtask_id, item.attempt)?.assignee,
        item.holder,
      ),
  );
  for (const finding of base.blockers) {
    if (finding.code === 'attempt_in_flight') {
      relaxed.push({
        code: finding.code,
        detail: 'Transferable attempts may be in flight.',
        next_action:
          'The successor decides their reports; non-transferable ones block separately.',
      });
      continue;
    }
    if (finding.code === 'claims_unreleased') {
      const source = coordinator_(record);
      const remaining = held.filter(
        (item) =>
          !tiedToTransferable.includes(item) &&
          !(
            source !== null &&
            item.holder?.agent_id === source.agent_id &&
            item.holder?.session_id === source.session_id
          ),
      );
      if (remaining.length > 0)
        blockers.push({
          ...finding,
          detail: `${String(remaining.length)} claim(s) are not tied to a transferable attempt of their holder and are not released.`,
          next_action:
            'Release them, or claim them tied to the attempt (subtask and attempt) that holds them.',
        });
      if (tiedToTransferable.length > 0)
        relaxed.push({
          code: finding.code,
          detail: `${String(tiedToTransferable.length)} claim(s) held by transferable attempts under their own subtask and attempt.`,
          next_action: 'The workers release them after the successor decides.',
        });
      continue;
    }
    // Already reported once per attempt as `attempt_not_transferable`.
    if (
      finding.code === 'uncertainty_open' &&
      /\(registered_not_started\)/.test(finding.detail)
    )
      continue;
    blockers.push(finding);
  }
  return {
    ready: blockers.length === 0,
    blockers,
    warnings: base.warnings,
    attempts,
    relaxed,
  };
}

function sameHolder(
  left: Identity | null | undefined,
  right: Identity | null | undefined,
): boolean {
  return (
    left != null &&
    right != null &&
    left.agent_id === right.agent_id &&
    left.session_id === right.session_id
  );
}

function coordinator_(record: TaskRecord) {
  return record.coordinator ?? null;
}
