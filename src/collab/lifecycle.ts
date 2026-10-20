import type { TaskRecord, Message, ResultEntry } from './types.js';
import { text, object } from './validation.js';
import fs from 'node:fs';
import path from 'node:path';
import { createNonce, digestText, nowIso, resultsDir } from './store.js';
import { canonicalJson } from './envelope.js';

// Attempt lifecycle, native binding, result admission and the uncertainty ledger.
//
// The record never claims more than it knows: an attempt whose native execution could
// not be confirmed stays `unknown`, keeps its resources, and is reconciled later using
// evidence. Late or superseded results are preserved as evidence and never overwrite a
// newer conclusion.

export const ATTEMPT_STATES = Object.freeze([
  'assigned',
  'accepted',
  'running',
  'completed',
  'needs_input',
  'failed',
  'cancelled',
  'unknown',
]);
export const ACTIVE_STATES = Object.freeze([
  'assigned',
  'accepted',
  'running',
  'unknown',
]);
export const TERMINAL_STATES = Object.freeze([
  'completed',
  'needs_input',
  'failed',
  'cancelled',
]);
/** Outcomes that genuinely end an execution. `needs_input` is a recoverable block, so it is
 *  terminal for transitions but NOT closed for the purpose of starting a new attempt. */
export const CLOSED_STATES = Object.freeze([
  'completed',
  'failed',
  'cancelled',
]);

const TRANSITIONS: Record<string, string[]> = {
  assigned: ['accepted', 'running', 'needs_input', 'failed', 'cancelled'],
  accepted: ['running', 'needs_input', 'failed', 'cancelled'],
  running: ['completed', 'needs_input', 'failed', 'cancelled', 'unknown'],
  unknown: ['running', 'completed', 'needs_input', 'failed', 'cancelled'],
  needs_input: ['running', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export const UNCERTAINTY_KINDS = Object.freeze([
  'registered_not_started',
  'started_unregistered',
  'executed_unwritten',
  'notification_lost',
  'cancel_unconfirmed',
  'session_identity_drift',
  'session_unobserved',
  'session_unverified',
  'late_result',
  'stale_epoch',
]);

export function attemptKey(subtaskId: string, attempt: number) {
  return `${subtaskId}#${attempt}`;
}

export function findAttempt(
  record: TaskRecord,
  subtaskId: string | null,
  attempt: number | null,
) {
  return (
    (record.attempts ?? []).find(
      (item) => item.subtask_id === subtaskId && item.attempt === attempt,
    ) ?? null
  );
}

export function attemptsFor(record: TaskRecord, subtaskId: string) {
  return (record.attempts ?? [])
    .filter((item) => item.subtask_id === subtaskId)
    .sort((a, b) => a.attempt - b.attempt);
}

export function latestAttemptNumber(record: TaskRecord, subtaskId: string) {
  const all = attemptsFor(record, subtaskId);
  return all.at(-1)?.attempt ?? 0;
}

export function checkOwnerEpoch(record: TaskRecord, epoch: number) {
  if (!Number.isSafeInteger(epoch) || epoch <= 0)
    return { ok: false as const, reason: 'invalid_epoch' };
  const current = record.coordinator?.owner_epoch ?? 0;
  if (epoch !== current)
    return {
      ok: false as const,
      reason: 'stale_epoch',
      expected: current,
      actual: epoch,
    };
  return { ok: true as const, owner_epoch: current };
}

/** Every state change is appended as a transition record; history is never rewritten. */
export function transitionAttempt(
  record: TaskRecord,
  {
    subtaskId,
    attempt,
    to,
    actor,
    reason,
    evidence = null,
    clock = Date.now(),
    force = false,
  }: {
    subtaskId: string | null;
    attempt: number | null;
    to: string;
    actor?: string;
    reason?: string;
    evidence?: unknown;
    clock?: number;
    force?: boolean;
  },
) {
  const target = findAttempt(record, subtaskId, attempt);
  if (!target)
    return {
      ok: false as const,
      reason: 'unknown_attempt',
      subtask_id: subtaskId,
      attempt,
    };
  if (!ATTEMPT_STATES.includes(to))
    return { ok: false as const, reason: 'unknown_state', state: to };
  if (target.state === to)
    return { ok: false as const, reason: 'already_in_state', state: to };
  const allowed = TRANSITIONS[target.state] ?? [];
  if (!allowed.includes(to))
    return {
      ok: false as const,
      reason: 'invalid_transition',
      from: target.state,
      to,
    };
  if (
    target.state === 'needs_input' &&
    to === 'running' &&
    target.awaiting === 'approval' &&
    !(object(evidence) && evidence.authorization)
  ) {
    return {
      ok: false as const,
      reason: 'approval_required',
      detail: 'an approval block is answered by the user, not by another agent',
    };
  }
  const at = nowIso(clock);
  target.state = to;
  target.updated_at = at;
  target.transitions = target.transitions ?? [];
  target.transitions.push({
    from: target.transitions.at(-1)?.to ?? null,
    to,
    at,
    actor: actor ?? 'unattributed',
    reason: reason ?? null,
    evidence,
    forced: force || undefined,
  });
  if (TERMINAL_STATES.includes(to)) target.closed_at = at;
  return { ok: true as const, state: to, at };
}

export function upsertAssignment(
  record: TaskRecord,
  {
    message,
    assignmentRef = null,
    assignmentDigest = null,
    inputRevision = null,
    clock = Date.now(),
  }: {
    message: Message;
    assignmentRef?: string | null;
    assignmentDigest?: string | null;
    inputRevision?: string | null;
    clock?: number;
  },
) {
  const { subtask_id: subtaskId, attempt } = message;
  if (!subtaskId || !attempt)
    return { ok: false as const, reason: 'assignment_requires_attempt' };
  const existing = findAttempt(record, subtaskId, attempt);
  if (existing) {
    if (existing.assignment_message_id === message.message_id) {
      return {
        ok: false as const,
        reason: 'duplicate_assignment',
        subtask_id: subtaskId,
        attempt,
      };
    }
    if (
      ACTIVE_STATES.includes(existing.state) ||
      TERMINAL_STATES.includes(existing.state)
    ) {
      return {
        ok: false as const,
        reason: 'attempt_in_flight',
        state: existing.state,
        subtask_id: subtaskId,
        attempt,
      };
    }
  }
  const latest = latestAttemptNumber(record, subtaskId);
  if (attempt > latest + 1) {
    return {
      ok: false as const,
      reason: 'attempt_skips_sequence',
      latest,
      requested: attempt,
    };
  }
  if (latest > 0 && attempt > latest) {
    const approval = message.body?.approval;
    if (!approval) {
      return {
        ok: false as const,
        reason: 'attempt_requires_approval',
        detail:
          'a new attempt for an existing subtask needs an explicit approval record',
      };
    }
    // An approval authorises a retry; it does not prove the previous execution stopped. The
    // record itself must show every earlier attempt closed, by a transition or by reconcile.
    // Text in the approval is deliberately not accepted as a stop proof.
    // Anything without a closed outcome still owns its execution: `needs_input` is a
    // recoverable block, not proof that the previous writer stopped.
    const stillActive = attemptsFor(record, subtaskId).filter(
      (item) => !CLOSED_STATES.includes(item.state),
    );
    if (stillActive.length) {
      return {
        ok: false as const,
        reason: 'previous_attempt_not_stopped',
        detail:
          'every earlier attempt must reach a closed outcome (completed, failed or cancelled with stop evidence) before a new attempt is registered',
        still_active: stillActive.map(
          (item) => `${item.subtask_id}#${item.attempt}:${item.state}`,
        ),
      };
    }
  }
  const at = nowIso(clock);
  record.attempts = record.attempts ?? [];
  record.attempts.push({
    subtask_id: subtaskId,
    attempt,
    state: 'assigned',
    owner_epoch: record.coordinator?.owner_epoch ?? null,
    assignee: message.to,
    assignment_message_id: message.message_id,
    assignment_ref: assignmentRef,
    assignment_digest: assignmentDigest,
    input_revision: inputRevision ?? record.input_revision ?? null,
    created_at: at,
    updated_at: at,
    native: {
      runner: null,
      session_id: null,
      run_id: null,
      mission_id: null,
      observation: 'unknown',
      observed_at: null,
      evidence_ref: null,
    },
    approval: message.body?.approval ?? null,
    transitions: [
      {
        from: null,
        to: 'assigned',
        at,
        actor: message.from?.agent_id ?? 'unattributed',
        reason: 'assignment registered',
        evidence: null,
      },
    ],
  });
  if (inputRevision) record.input_revision = inputRevision;
  return {
    ok: true as const,
    subtask_id: subtaskId,
    attempt,
    state: 'assigned',
  };
}

/**
 * Record native evidence for an attempt. `observation: confirmed` requires an evidence
 * reference; `unknown` is a first-class observation and never means failure.
 */
export function bindNative(
  record: TaskRecord,
  {
    subtaskId,
    attempt,
    runner,
    sessionId = null,
    runId = null,
    missionId = null,
    observation,
    evidenceRef = null,
    observedAt = null,
    clock = Date.now(),
  }: {
    subtaskId: string;
    attempt: number;
    runner?: string | null;
    sessionId?: string | null;
    runId?: string | null;
    missionId?: string | null;
    observation: string;
    evidenceRef?: string | null;
    observedAt?: string | null;
    clock?: number;
  },
) {
  const target = findAttempt(record, subtaskId, attempt);
  if (!target) return { ok: false as const, reason: 'unknown_attempt' };
  if (!['confirmed', 'unknown'].includes(observation))
    return { ok: false as const, reason: 'invalid_observation' };
  if (observation === 'confirmed' && !text(evidenceRef))
    return { ok: false as const, reason: 'evidence_required' };
  const at = observedAt ?? nowIso(clock);
  target.native = {
    runner: runner ?? null,
    session_id: sessionId,
    run_id: runId,
    mission_id: missionId,
    observation,
    observed_at: at,
    evidence_ref: evidenceRef,
    // A native runner owns its own execution; the shared layer only records pointers.
    manager: 'native',
  };
  target.updated_at = nowIso(clock);
  target.transitions = target.transitions ?? [];
  target.transitions.push({
    from: target.state,
    to: target.state,
    at: target.updated_at,
    actor: 'native-binding',
    reason: `native observation ${observation}`,
    evidence: evidenceRef,
  });
  let reconciled = null;
  if (observation === 'confirmed') {
    // A confirmed native observation answers the "registered but not started" question.
    const open = (record.uncertainty ?? []).find(
      (item) =>
        !item.resolved_at &&
        item.kind === 'registered_not_started' &&
        item.subtask_id === subtaskId &&
        item.attempt === attempt,
    );
    if (open) {
      open.resolved_at = target.updated_at;
      open.resolution = 'native execution confirmed';
      open.resolution_evidence = evidenceRef;
      open.resolved_by = 'native-binding';
      open.resolution_source = 'automatic-on-confirmed-binding';
      reconciled = open.uncertainty_id;
    }
  }
  return {
    ok: true as const,
    native: target.native,
    reconciled_uncertainty: reconciled,
  };
}

// Only these close an attempt for good. `needs_input` is a recoverable block and `running`
// is progress: neither may prevent the later final conclusion from being admitted.
const RESULT_FINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * Admit a reported result. Classification:
 *   applied      the attempt is active and its input revision still matches
 *   late         the attempt already has a different admitted result: evidence only
 *   superseded   a newer attempt or a different input revision is authoritative
 *   duplicate    the same message was already admitted
 */
export function recordResult(
  record: TaskRecord,
  {
    subtaskId,
    attempt,
    status,
    messageId,
    inputRevision = null,
    outputs = [],
    nativeRef = null,
    clock = Date.now(),
    evidenceRef = null,
  }: {
    subtaskId: string;
    attempt: number;
    status: string;
    messageId: string;
    inputRevision?: string | null;
    outputs?: unknown[];
    nativeRef?: unknown;
    clock?: number;
    evidenceRef?: string | null;
  },
) {
  const target = findAttempt(record, subtaskId, attempt);
  if (!target) return { ok: false as const, reason: 'unknown_attempt' };
  const at = nowIso(clock);
  const entry = {
    schema: 'harness-collab/result/1',
    subtask_id: subtaskId,
    attempt,
    status,
    message_id: messageId,
    input_revision: inputRevision ?? target.input_revision ?? null,
    outputs,
    native_ref: nativeRef,
    recorded_at: at,
    evidence_ref: evidenceRef,
  };
  record.results = record.results ?? [];
  const forAttempt = record.results.filter(
    (item) =>
      item.subtask_id === subtaskId &&
      item.attempt === attempt &&
      item.classification === 'applied',
  );
  const incomingIsTerminal = RESULT_FINAL.has(status);
  // Progress reports and recoverable blocks are steps, not conclusions: only a previous
  // *final* admitted result can make a final result late.
  const existingForAttempt = incomingIsTerminal
    ? forAttempt.filter((item) => RESULT_FINAL.has(item.status))
    : [];
  const duplicate = record.results.find(
    (item) => item.message_id === messageId,
  );
  if (duplicate) {
    return { ok: true as const, classification: 'duplicate', entry: duplicate };
  }
  const latest = latestAttemptNumber(record, subtaskId);
  let classification = 'applied';
  let reason = null;
  if (attempt < latest) {
    classification = 'superseded';
    reason = `attempt ${attempt} was superseded by attempt ${latest}`;
  } else if (
    entry.input_revision &&
    target.input_revision &&
    entry.input_revision !== target.input_revision
  ) {
    // The attempt's own pinned input is the baseline: the record-level revision changes as
    // other subtasks are dispatched and must not invalidate a correct report.
    classification = 'superseded';
    reason = `result belongs to input revision ${entry.input_revision}, this attempt is pinned to ${target.input_revision}`;
  } else if (existingForAttempt.length) {
    classification = 'late';
    reason =
      'the attempt already has an admitted result; this one is retained as evidence';
  }
  const stored: ResultEntry = { ...entry, classification, reason };
  record.results.push(stored);
  if (classification !== 'applied') {
    openUncertainty(record, {
      kind: 'late_result',
      subtaskId,
      attempt,
      detail: reason,
      evidenceRef,
      resolutionHint:
        'compare with the admitted result; do not overwrite the newer conclusion',
      clock,
    });
    return { ok: true as const, classification, entry: stored };
  }
  if (!incomingIsTerminal) {
    // A progress report may still record a recoverable block without closing the attempt.
    const steps = [];
    const target2 = findAttempt(record, subtaskId, attempt);
    if (
      status === 'needs_input' &&
      target2 &&
      !TERMINAL_STATES.includes(target2.state)
    ) {
      steps.push(
        transitionAttempt(record, {
          subtaskId,
          attempt,
          to: 'needs_input',
          actor: 'result-admission',
          reason: `progress block ${messageId}`,
          evidence: evidenceRef,
          clock,
        }),
      );
    } else if (
      status === 'running' &&
      target2 &&
      ['assigned', 'accepted'].includes(target2.state)
    ) {
      steps.push(
        transitionAttempt(record, {
          subtaskId,
          attempt,
          to: 'running',
          actor: 'result-admission',
          reason: `progress report ${messageId}`,
          evidence: evidenceRef,
          clock,
        }),
      );
    }
    return {
      ok: true as const,
      classification,
      entry: stored,
      note: 'progress report retained without closing the attempt',
      transitions: steps,
    };
  }
  // A terminal report means the attempt executed: walk it through `running` so the
  // recorded history matches reality instead of skipping a state.
  const steps = [];
  // `needs_input` is a recoverable block: a final result may pass through it, but the
  // approval guard in transitionAttempt still refuses to leave an unanswered approval block.
  if (['assigned', 'accepted', 'needs_input'].includes(target.state)) {
    steps.push(
      transitionAttempt(record, {
        subtaskId,
        attempt,
        to: 'running',
        actor: 'result-admission',
        reason: `report ${messageId} implies execution`,
        evidence: evidenceRef,
        clock,
      }),
    );
  }
  steps.push(
    transitionAttempt(record, {
      subtaskId,
      attempt,
      to: status,
      actor: 'result-admission',
      reason: `report ${messageId}`,
      evidence: evidenceRef,
      clock,
    }),
  );
  const finalTransition = steps.at(-1);
  if (
    finalTransition &&
    finalTransition.ok === false &&
    finalTransition.reason !== 'already_in_state'
  ) {
    // The conclusion could not be recorded, so it must not count as this attempt's admitted
    // result: otherwise a later, legitimate completion would be judged `late`.
    stored.classification = 'withheld';
    stored.reason = `final transition refused: ${finalTransition.reason}`;
    openUncertainty(record, {
      kind: 'late_result',
      subtaskId,
      attempt,
      detail: `a final report could not be admitted (${finalTransition.reason}); it is retained as evidence only`,
      evidenceRef,
      resolutionHint:
        'resolve the blocking state (for example an approval block) and report again',
      clock,
    });
    return {
      ok: true as const,
      classification: 'withheld',
      entry: stored,
      transitions: steps,
      transition: finalTransition,
    };
  }
  return {
    ok: true as const,
    classification,
    entry: stored,
    transition: finalTransition,
    transitions: steps,
  };
}

export function writeResultEvidence(taskRoot: string, entry: ResultEntry) {
  fs.mkdirSync(resultsDir(taskRoot), { recursive: true, mode: 0o700 });
  const name = `${entry.subtask_id}-a${entry.attempt}-${entry.message_id ?? createNonce()}.json`;
  const file = path.join(
    resultsDir(taskRoot),
    name.replace(/[^A-Za-z0-9._-]/g, '_'),
  );
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return file;
}

export function openUncertainty(
  record: TaskRecord,
  {
    kind,
    subtaskId = null,
    attempt = null,
    detail = null,
    evidenceRef = null,
    resolutionHint = null,
    clock = Date.now(),
  }: {
    kind: string;
    subtaskId?: string | null;
    attempt?: number | null;
    detail?: string | null;
    evidenceRef?: string | null;
    resolutionHint?: string | null;
    clock?: number;
  },
) {
  if (!UNCERTAINTY_KINDS.includes(kind))
    return { ok: false as const, reason: 'unknown_uncertainty_kind', kind };
  const existing = (record.uncertainty ?? []).find(
    (item) =>
      !item.resolved_at &&
      item.kind === kind &&
      item.subtask_id === subtaskId &&
      item.attempt === attempt &&
      item.detail === detail,
  );
  if (existing)
    return {
      ok: true as const,
      uncertainty_id: existing.uncertainty_id,
      duplicate: true,
    };
  const entry = {
    uncertainty_id: `unc-${createNonce()}`,
    kind,
    subtask_id: subtaskId,
    attempt,
    detail,
    evidence_ref: evidenceRef,
    resolution_hint: resolutionHint,
    opened_at: nowIso(clock),
    resolved_at: null,
    resolution: null,
    resolution_evidence: null,
    // Never auto-restart: the native runner owns execution, the shared layer only reports.
    auto_restart: false,
  };
  record.uncertainty = record.uncertainty ?? [];
  record.uncertainty.push(entry);
  return { ok: true as const, uncertainty_id: entry.uncertainty_id };
}

export function resolveUncertainty(
  record: TaskRecord,
  {
    uncertaintyId,
    resolution,
    resolutionEvidence,
    actor,
    clock = Date.now(),
  }: {
    uncertaintyId: string;
    resolution: string;
    resolutionEvidence?: unknown;
    actor?: string;
    clock?: number;
  },
) {
  const entry = (record.uncertainty ?? []).find(
    (item) => item.uncertainty_id === uncertaintyId,
  );
  if (!entry) return { ok: false as const, reason: 'unknown_uncertainty' };
  if (entry.resolved_at)
    return {
      ok: false as const,
      reason: 'already_resolved',
      resolved_at: entry.resolved_at,
    };
  if (!text(resolution))
    return { ok: false as const, reason: 'resolution_required' };
  entry.resolved_at = nowIso(clock);
  entry.resolution = resolution;
  entry.resolution_evidence = resolutionEvidence ?? null;
  entry.resolved_by = actor ?? 'unattributed';
  return { ok: true as const, uncertainty_id: uncertaintyId, resolution };
}

export function recordDigest(record: TaskRecord) {
  return digestText(canonicalJson(record));
}
