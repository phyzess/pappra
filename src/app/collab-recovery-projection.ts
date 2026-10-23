import fs from 'node:fs';
import path from 'node:path';

import { readBoundedFile } from './bounded-file.js';
import { inspectWorkPlan } from './collab-work-plan.js';
import {
  contentDigest,
  messageFile,
  validateEnvelope,
} from '../collab/envelope.js';
import { messagesDir, RECORD_FILE } from '../collab/store.js';
import { isTaskRecord } from '../collab/validation.js';
import {
  validateWorkPlan,
  type WorkNodeEvaluation,
  type WorkPlan,
} from '../collab/work-plan.js';
import type {
  AppliedMessage,
  Attempt,
  Claim,
  Coordinator,
  Identity,
  Message,
  ResultEntry,
  TaskRecord,
} from '../collab/types.js';

/**
 * Bounded, read-only recovery analysis over the existing typed task-record, work-plan and
 * registered-message contracts.
 *
 * `inspectRecoveryProjection` reads one consistent persisted snapshot and reuses the shipped bounded
 * work-plan evaluation to project the unresolved message-driven actions a recovery executor would still
 * owe: continue an interrupted accepted attempt, progress a completed report into coordinator review, or
 * observe an ambiguous effect. It NEVER acknowledges, claims, reserves, notifies, starts a model, mutates
 * no file, and grants no authority: it computes an advisory projection and returns it.
 *
 * It is not an executor and not an authorization. Every answer reflects the persisted record at read time
 * only; concurrent mutation (detected by revalidating the record/plan/namespace after all evidence reads),
 * a truncated or refused read, a missing join or an unverifiable registered envelope yields an explicit
 * incomplete/unknown coverage with a complete-evidence prerequisite rather than a quiet completion or an
 * unqualified actionable recommendation.
 */
export const COLLAB_RECOVERY_PROJECTION_SCHEMA =
  'pappra/collab-recovery-projection/1';

const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_ENVELOPE_BYTES = 128 * 1024;
const MAX_REGISTERED_MESSAGES = 4096;
const MAX_NODES = 512;
const MAX_ENVELOPE_READS = 1024;

const LIMITS: readonly string[] = Object.freeze([
  'persisted_snapshot_only',
  'advisory_read_only_projection',
  'no_ack_claim_reserve_notify_or_dispatch',
  'not_an_authorization',
  'no_native_query_or_model',
  'r1_does_not_accept_caller_action_evidence',
]);

const ROLES: ReadonlySet<string> = new Set([
  'writer',
  'coordinator',
  'reviewer',
]);
const FINAL_RESULT_STATES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
]);
/** Routine lifecycle uncertainty that is not an unknown external effect and does not block continuation. */
const ROUTINE_UNCERTAINTY: ReadonlySet<string> = new Set([
  'registered_not_started',
]);

export type RecoveryRole = 'writer' | 'coordinator' | 'reviewer';

export interface RecoveryPolicy {
  readonly role: RecoveryRole;
  /** When present, only these subtask ids are projected; everything else is ignored. */
  readonly authorizedSubtasks?: readonly string[];
}

export type RecoveryActionStatus =
  'pending' | 'blocked' | 'observed' | 'complete' | 'unknown';

export type RecoveryActionKind =
  | 'resume_work'
  | 'answer_supersedes_wait'
  | 'progress_report_to_review'
  | 'report_unadmitted'
  | 'blocked_awaiting_gate'
  | 'ambiguous_effect'
  | 'verified_completion'
  | 'none';

export interface RecoveryAction {
  /** Stable, unambiguous encoding of the action identity for a later reservation/executor. */
  readonly key: string;
  readonly kind: RecoveryActionKind;
  readonly subtask_id: string | null;
  readonly attempt: number | null;
  readonly prerequisites: readonly string[];
  readonly evidence: readonly string[];
  readonly status: RecoveryActionStatus;
}

export interface RecoveryProjection {
  readonly schema: typeof COLLAB_RECOVERY_PROJECTION_SCHEMA;
  readonly self: Identity;
  readonly task_root: string;
  readonly task_id: string | null;
  readonly plan_digest: string | null;
  readonly record_revision: number;
  readonly coverage: 'complete' | 'incomplete';
  readonly coordinator_verified: boolean;
  readonly actions: readonly RecoveryAction[];
  readonly notes: readonly string[];
  readonly limits: readonly string[];
}

export type RecoveryProjectionResult =
  | { readonly ok: true; readonly value: RecoveryProjection }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly message: string;
      readonly next_action: string | null;
    };

export interface RecoveryInspectionOptions {
  readonly taskRoot: string;
  readonly planFile: string;
  readonly self: Identity;
  readonly policy: RecoveryPolicy;
}

function fail(
  reason: string,
  message: string,
  nextAction: string | null = null,
): RecoveryProjectionResult {
  return { ok: false, reason, message, next_action: nextAction };
}

function isIdentity(value: unknown): value is Identity {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Identity).agent_id === 'string' &&
    typeof (value as Identity).session_id === 'string' &&
    typeof (value as Identity).harness === 'string'
  );
}

/** Two identities match on agent id and session id; harness is compared when both carry one. */
export function idEq(
  a:
    | { agent_id?: string; session_id?: string; harness?: string | null }
    | null
    | undefined,
  b:
    | { agent_id?: string; session_id?: string; harness?: string | null }
    | null
    | undefined,
): boolean {
  return (
    a !== null &&
    a !== undefined &&
    b !== null &&
    b !== undefined &&
    a.agent_id === b.agent_id &&
    a.session_id === b.session_id &&
    (a.harness === undefined ||
      a.harness === null ||
      b.harness === undefined ||
      b.harness === null ||
      a.harness === b.harness)
  );
}

function copyIdentity(id: Identity): Identity {
  return {
    agent_id: id.agent_id,
    session_id: id.session_id,
    harness: id.harness,
  };
}

export type SafeRecordRead =
  | { readonly ok: true; readonly record: TaskRecord; readonly digest: string }
  | { readonly ok: false; readonly code: string };

/**
 * Read the task record through the bounded, no-follow regular-file reader anchored at the task namespace,
 * returning a structured refusal instead of throwing on a missing, oversized, redirected or corrupt record.
 */
export function readRecordSafe(taskRoot: string): SafeRecordRead {
  const file = path.join(taskRoot, RECORD_FILE);
  const read = readBoundedFile(file, MAX_RECORD_BYTES);
  if (!read.ok) return { ok: false, code: `record_${read.code}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { ok: false, code: 'record_unparseable' };
  }
  if (!isTaskRecord(parsed)) return { ok: false, code: 'record_invalid' };
  return { ok: true, record: parsed, digest: read.digest };
}

export interface TaskNamespaceAnchor {
  readonly entries: readonly {
    readonly path: string;
    readonly dev: number;
    readonly ino: number;
  }[];
}

/**
 * Pin the task root, its messages directory and two ancestors by device/inode so a same-revision
 * replacement or a redirected task-root/messages namespace is detected across the whole inspection. A
 * symlinked component makes the anchor unavailable (null).
 */
export function anchorTaskNamespace(
  taskRoot: string,
): TaskNamespaceAnchor | null {
  const targets = [
    taskRoot,
    messagesDir(taskRoot),
    path.dirname(taskRoot),
    path.dirname(path.dirname(taskRoot)),
  ];
  const entries: { path: string; dev: number; ino: number }[] = [];
  for (const target of targets) {
    try {
      const st = fs.lstatSync(target);
      if (st.isSymbolicLink()) return null;
      entries.push({ path: target, dev: st.dev, ino: st.ino });
    } catch {
      entries.push({ path: target, dev: -1, ino: -1 });
    }
  }
  return { entries };
}

/** True when every pinned namespace entry still resolves to the same device/inode (no redirect). */
export function verifyTaskNamespace(
  anchor: TaskNamespaceAnchor | null,
): boolean {
  if (anchor === null) return false;
  for (const entry of anchor.entries) {
    try {
      const st = fs.lstatSync(entry.path);
      if (st.isSymbolicLink()) return false;
      if (st.dev !== entry.dev || st.ino !== entry.ino) return false;
    } catch {
      if (entry.dev !== -1 || entry.ino !== -1) return false;
    }
  }
  return true;
}

/** Read and validate one registered envelope through the bounded no-follow reader. */
function readEnvelope(taskRoot: string, messageId: string): Message | null {
  let file: string;
  try {
    file = messageFile(taskRoot, messageId);
  } catch {
    return null;
  }
  const read = readBoundedFile(file, MAX_ENVELOPE_BYTES);
  if (!read.ok) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return null;
  }
  try {
    return validateEnvelope(parsed);
  } catch {
    return null;
  }
}

/**
 * The attempt is held by an approval, cancellation or a CURRENT revocation gate. A historical released
 * claim never vetoes a later valid current grant: only a current held claim marked cancel_pending (held by
 * the attempt owner) or, when no current valid grant exists, a pending revocation, gates recovery.
 */
function gateReason(attempt: Attempt, record: TaskRecord): string | null {
  if (attempt.state === 'needs_input')
    return attempt.awaiting ? `awaiting_${attempt.awaiting}` : 'needs_input';
  if (typeof attempt.awaiting === 'string' && attempt.awaiting.length > 0)
    return `awaiting_${attempt.awaiting}`;
  if (typeof attempt.cancel_requested_at === 'string')
    return 'cancel_requested';
  if (attempt.ownership === 'cancelled' || attempt.state === 'cancelled')
    return 'cancelled';
  const forSubtask = (record.claims ?? []).filter(
    (c: Claim) => c.subtask_id === attempt.subtask_id,
  );
  const currentHeld = forSubtask.filter(
    (c) => c.released_at === null && idEq(c.holder, attempt.assignee),
  );
  for (const claim of currentHeld)
    if (claim.cancel_pending === true) return 'claim_cancel_pending';
  if (currentHeld.length === 0) {
    // No current valid grant: a pending revocation on a (now released) owner claim still gates.
    for (const claim of forSubtask)
      if (claim.cancel_pending === true && idEq(claim.holder, attempt.assignee))
        return 'claim_revoked';
  }
  return null;
}

/** Any unresolved non-routine persisted uncertainty for this attempt is an unknown external effect. */
function unresolvedUncertainty(
  record: TaskRecord,
  subtaskId: string,
  attempt: number,
): string | null {
  for (const item of record.uncertainty ?? []) {
    if (item.resolved_at !== null) continue;
    if (
      item.subtask_id === subtaskId &&
      item.attempt === attempt &&
      !ROUTINE_UNCERTAINTY.has(item.kind)
    ) {
      return item.kind;
    }
  }
  return null;
}

interface RegistryMatch {
  readonly ok: boolean;
  readonly message_id?: string;
  readonly digest?: string;
  readonly candidate: boolean;
  readonly reason?: string;
}

/**
 * The newest admissible continuation ANSWER. Admissible means a registered envelope, re-read and
 * digest-verified against the authoritative record registry, that is a current-coordinator -> self reply for
 * exactly this task/subtask/attempt/input/epoch. The registry is in authoritative application order, so the
 * last admissible entry is the newest correction; a recipient match, a foreign sender, a wrong attempt or
 * input, or an unverifiable digest is not permission.
 */
function correlatedAnswer(
  record: TaskRecord,
  registry: readonly AppliedMessage[],
  taskRoot: string,
  self: Identity,
  coord: Coordinator | null,
  coordEpoch: number | null,
  subtaskId: string,
  attempt: number,
  input: string | null,
): RegistryMatch {
  let candidate = false;
  let newest: { message_id: string; digest: string; order: number } | null =
    null;
  for (let index = 0; index < registry.length; index += 1) {
    const entry = registry[index]!;
    if (entry.type !== 'ANSWER' || entry.subtask_id !== subtaskId) continue;
    candidate = true;
    if (entry.attempt !== attempt) continue;
    if (coord === null || !idEq(entry.from, coord)) continue;
    if (!idEq(entry.to, self)) continue;
    if (entry.owner_epoch !== coordEpoch) continue;
    const envelope = readEnvelope(taskRoot, entry.message_id);
    if (envelope === null) continue;
    if (contentDigest(envelope) !== entry.content_digest) continue;
    if (envelope.type !== 'ANSWER' || envelope.message_id !== entry.message_id)
      continue;
    if (envelope.task_id !== record.task_id) continue;
    if (envelope.subtask_id !== subtaskId || envelope.attempt !== attempt)
      continue;
    if (!idEq(envelope.to, self) || !idEq(envelope.from, coord)) continue;
    if (envelope.owner_epoch !== coordEpoch) continue;
    const bodyInput = (
      envelope.body as { input_revision?: unknown } | undefined
    )?.input_revision;
    if (input !== null && bodyInput !== input) continue;
    if (newest === null || index > newest.order)
      newest = {
        message_id: entry.message_id,
        digest: entry.content_digest,
        order: index,
      };
  }
  if (newest !== null)
    return {
      ok: true,
      message_id: newest.message_id,
      digest: newest.digest,
      candidate: true,
    };
  return {
    ok: false,
    candidate,
    reason: 'no_correlated_registered_coordinator_answer',
  };
}

/**
 * A review action requires the current `applied` owner report for the latest matching attempt/input and its
 * exact registered envelope identity/type/task/owner/recipient/subtask/attempt/input/status/epoch, verified
 * against the record registry and coordinator. A digest matches bytes, not authority; late/superseded/
 * withheld/stale-sender results and any contradiction stay evidence only.
 */
function admittedReport(
  record: TaskRecord,
  registry: readonly AppliedMessage[],
  taskRoot: string,
  owner: Identity,
  coord: Coordinator | null,
  coordEpoch: number | null,
  subtaskId: string,
  attempt: number,
  attemptEpoch: number | null,
  input: string | null,
  latest: number,
): RegistryMatch {
  if (attemptEpoch !== coordEpoch)
    return { ok: false, candidate: false, reason: 'attempt_epoch_mismatch' };
  if (attempt !== latest)
    return { ok: false, candidate: false, reason: 'attempt_superseded' };
  const result = (record.results ?? []).find(
    (item: ResultEntry) =>
      item.subtask_id === subtaskId &&
      item.attempt === attempt &&
      item.classification === 'applied' &&
      FINAL_RESULT_STATES.has(item.status) &&
      (input === null ||
        item.input_revision === null ||
        item.input_revision === input),
  );
  if (!result)
    return { ok: false, candidate: false, reason: 'no_current_applied_report' };
  const entry = registry.find(
    (item) => item.type === 'REPORT' && item.message_id === result.message_id,
  );
  if (!entry)
    return { ok: false, candidate: true, reason: 'report_not_registered' };
  if (
    entry.subtask_id !== subtaskId ||
    entry.attempt !== attempt ||
    !idEq(entry.from, owner) ||
    (coord !== null && !idEq(entry.to, coord))
  )
    return { ok: false, candidate: true, reason: 'report_entry_mismatch' };
  const envelope = readEnvelope(taskRoot, entry.message_id);
  if (envelope === null)
    return { ok: false, candidate: true, reason: 'report_envelope_unreadable' };
  if (contentDigest(envelope) !== entry.content_digest)
    return { ok: false, candidate: true, reason: 'report_digest_mismatch' };
  const bodyStatus = (envelope.body as { status?: unknown } | undefined)
    ?.status;
  const bodyInput = (envelope.body as { input_revision?: unknown } | undefined)
    ?.input_revision;
  if (
    envelope.type !== 'REPORT' ||
    envelope.message_id !== result.message_id ||
    envelope.task_id !== record.task_id ||
    envelope.subtask_id !== subtaskId ||
    envelope.attempt !== attempt ||
    !idEq(envelope.from, owner) ||
    (coord !== null && !idEq(envelope.to, coord)) ||
    typeof bodyStatus !== 'string' ||
    !FINAL_RESULT_STATES.has(bodyStatus) ||
    (input !== null && bodyInput !== input)
  )
    return { ok: false, candidate: true, reason: 'report_envelope_mismatch' };
  return {
    ok: true,
    message_id: entry.message_id,
    digest: entry.content_digest,
    candidate: true,
  };
}

export async function inspectRecoveryProjection(
  options: RecoveryInspectionOptions,
): Promise<RecoveryProjectionResult> {
  const opts = options ?? ({} as RecoveryInspectionOptions);
  const { taskRoot, planFile, self, policy } = opts;
  if (typeof taskRoot !== 'string' || !path.isAbsolute(taskRoot))
    return fail('task_root_invalid', 'taskRoot must be an absolute path.');
  if (typeof planFile !== 'string' || !path.isAbsolute(planFile))
    return fail('plan_file_invalid', 'planFile must be an absolute path.');
  if (!isIdentity(self))
    return fail(
      'self_identity_invalid',
      'self must be a full identity with agent_id, session_id and harness.',
    );
  if (
    typeof policy !== 'object' ||
    policy === null ||
    !ROLES.has(policy.role) ||
    (policy.authorizedSubtasks !== undefined &&
      !Array.isArray(policy.authorizedSubtasks))
  )
    return fail(
      'policy_invalid',
      'policy.role must be writer, coordinator or reviewer with an optional authorizedSubtasks array.',
    );

  const notes: string[] = [];
  let incomplete = false;
  const markIncomplete = (note: string): void => {
    incomplete = true;
    notes.push(note);
  };

  // Anchored, structured initial record read.
  const namespace = anchorTaskNamespace(taskRoot);
  if (namespace === null)
    markIncomplete(
      'the task namespace (task root / messages / ancestors) is unavailable or redirected through a symlink.',
    );
  const initial = readRecordSafe(taskRoot);
  if (!initial.ok)
    return fail(
      'record_unreadable',
      `The task record could not be read safely (${initial.code}).`,
      'Verify the task root and that task.json is a readable regular file.',
    );
  const record = initial.record;
  const revisionInitial = record.state_revision;

  let report;
  try {
    report = await inspectWorkPlan({ taskRoot, planFile });
  } catch {
    return fail(
      'work_plan_inspection_failed',
      'The bounded work-plan inspection threw unexpectedly.',
      'Re-run against a readable plan and task record.',
    );
  }

  if (report.stale)
    markIncomplete(
      'the work-plan evaluation is stale against the current record; no consistent snapshot.',
    );
  if (report.status !== 'evaluated' || report.core === null)
    markIncomplete(
      `work-plan status is ${report.status}; evaluation unavailable.`,
    );
  if (report.evidence.over_budget)
    markIncomplete('the work-plan evidence exceeded its bounded read budget.');

  // Plan nodes for the node_id -> assignment_id join (bounded, validated).
  let plan: WorkPlan | null = null;
  const planReadInitial = readBoundedFile(planFile, MAX_PLAN_BYTES);
  const planDigestInitial = planReadInitial.ok ? planReadInitial.digest : null;
  if (!planReadInitial.ok) {
    markIncomplete(
      `the plan file is not a bounded readable regular file (${planReadInitial.code}).`,
    );
  } else {
    if (
      report.plan.digest !== null &&
      planReadInitial.digest !== report.plan.digest
    )
      markIncomplete(
        'the plan digest changed between reads; no consistent snapshot.',
      );
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(planReadInitial.text);
    } catch {
      parsed = null;
    }
    const validation = parsed === null ? null : validateWorkPlan(parsed);
    if (validation === null || !validation.ok) {
      markIncomplete(
        'the plan did not validate for the node-to-assignment join.',
      );
    } else {
      plan = validation.plan;
    }
  }

  const coord = record.coordinator;
  const coordEpoch = coord?.owner_epoch ?? null;
  // Role separation: only an explicit coordinator role whose self is the current record coordinator acts
  // on review work. A writer or reviewer never receives coordinator review-dispatch.
  const isCurrentCoordinator = coord !== null && idEq(self, coord);
  const coordinatorActs = policy.role === 'coordinator' && isCurrentCoordinator;
  if (policy.role === 'coordinator' && !isCurrentCoordinator)
    notes.push(
      'self is not the current record coordinator (agent/session/harness); coordinator review actions are withheld.',
    );

  const registry = record.messages ?? [];
  if (registry.length > MAX_REGISTERED_MESSAGES)
    markIncomplete(
      `registered message count ${registry.length} exceeds the bounded scan ${MAX_REGISTERED_MESSAGES}.`,
    );
  const boundedRegistry = registry.slice(0, MAX_REGISTERED_MESSAGES);

  const authorized = policy.authorizedSubtasks ?? null;
  const inScope = (sub: string): boolean =>
    authorized === null || authorized.includes(sub);
  const latestAttempt = (sub: string): number =>
    (record.attempts ?? [])
      .filter((a) => a.subtask_id === sub)
      .reduce((max, a) => Math.max(max, a.attempt ?? 0), 0);

  const planNodes = plan?.nodes ?? [];
  const byNodeId = new Map(planNodes.map((n) => [n.node_id, n]));
  const evalNodes: readonly WorkNodeEvaluation[] =
    report.status === 'evaluated' && report.core !== null
      ? report.core.nodes
      : [];
  if (evalNodes.length > MAX_NODES)
    markIncomplete(
      `evaluation node count ${evalNodes.length} exceeds the bound ${MAX_NODES}.`,
    );

  // Join completeness check: an eval or plan node without its counterpart is a join gap.
  if (plan !== null) {
    const evalIds = new Set(evalNodes.map((n) => n.node_id));
    for (const en of evalNodes)
      if (!byNodeId.has(en.node_id))
        markIncomplete(
          `evaluation node ${en.node_id} has no plan node (join gap).`,
        );
    for (const pn of planNodes)
      if (!evalIds.has(pn.node_id))
        markIncomplete(
          `plan node ${pn.node_id} has no evaluation entry (join gap).`,
        );
  }

  const actions: RecoveryAction[] = [];
  const epochKey = coordEpoch ?? 0;
  let envelopeReads = 0;

  for (const en of evalNodes.slice(0, MAX_NODES)) {
    const pn = byNodeId.get(en.node_id);
    if (!pn) continue;
    const sub = pn.assignment_id;
    const att = pn.attempt;
    const input = pn.input_revision ?? null;
    if (!inScope(sub)) continue;
    const attempt =
      (record.attempts ?? []).find(
        (a) => a.subtask_id === sub && a.attempt === att,
      ) ?? null;
    const evidence = [`workplan:${en.node_id}->${sub}#${att}:${en.status}`];

    if (en.status === 'blocked') {
      actions.push({
        key: `blocked_awaiting_gate:${sub}:${att}:${epochKey}`,
        kind: 'blocked_awaiting_gate',
        subtask_id: sub,
        attempt: att,
        prerequisites: (en.blockers ?? []).map((b) => b.code),
        evidence,
        status: 'blocked',
      });
      continue;
    }
    if (en.status === 'accepted') {
      actions.push({
        key: `verified_completion:${sub}:${att}:${epochKey}`,
        kind: 'verified_completion',
        subtask_id: sub,
        attempt: att,
        prerequisites: [],
        evidence,
        status: 'complete',
      });
      continue;
    }
    if (en.status === 'ready') continue;

    if (!attempt) {
      markIncomplete(
        `node ${en.node_id} (${sub}#${att}) has no matching record attempt (join gap).`,
      );
      continue;
    }
    const ambiguous = unresolvedUncertainty(record, sub, att);

    if (en.status === 'awaiting_acceptance') {
      if (!coordinatorActs) continue;
      if (ambiguous !== null) {
        actions.push(ambiguousAction(sub, att, epochKey, evidence, ambiguous));
        continue;
      }
      if (envelopeReads >= MAX_ENVELOPE_READS) {
        markIncomplete('registered-envelope read budget exceeded.');
        continue;
      }
      envelopeReads += 1;
      const admit = admittedReport(
        record,
        boundedRegistry,
        taskRoot,
        attempt.assignee,
        coord,
        coordEpoch,
        sub,
        att,
        attempt.owner_epoch,
        input,
        latestAttempt(sub),
      );
      if (admit.ok) {
        actions.push({
          key: `progress_report_to_review:${admit.message_id}:${admit.digest}:${sub}:${att}:${input ?? '-'}:${epochKey}`,
          kind: 'progress_report_to_review',
          subtask_id: sub,
          attempt: att,
          prerequisites: ['persist_reviewer_dispatch_before_complete'],
          evidence: [
            ...evidence,
            `report:${admit.message_id}`,
            `digest:${admit.digest}`,
          ],
          status: 'pending',
        });
      } else {
        actions.push({
          key: `report_unadmitted:${sub}:${att}:${epochKey}`,
          kind: 'report_unadmitted',
          subtask_id: sub,
          attempt: att,
          prerequisites: ['await_current_applied_registered_report'],
          evidence: [...evidence, `reason:${admit.reason ?? 'unadmitted'}`],
          status: 'unknown',
        });
      }
      continue;
    }

    if (en.status === 'running') {
      // Scope to the real record owner, not only the harness-less plan assignee.
      if (policy.role !== 'writer' || !idEq(attempt.assignee, self)) continue;
      if (ambiguous !== null) {
        actions.push(ambiguousAction(sub, att, epochKey, evidence, ambiguous));
        continue;
      }
      const gate = gateReason(attempt, record);
      if (gate !== null) {
        actions.push({
          key: `blocked_awaiting_gate:${sub}:${att}:${epochKey}`,
          kind: 'blocked_awaiting_gate',
          subtask_id: sub,
          attempt: att,
          prerequisites: [gate],
          evidence,
          status: 'blocked',
        });
        continue;
      }
      if (att !== latestAttempt(sub)) {
        markIncomplete(
          `node ${sub}#${att} is not the latest attempt (${latestAttempt(sub)}); superseded skew.`,
        );
        continue;
      }
      if (envelopeReads >= MAX_ENVELOPE_READS) {
        markIncomplete('registered-envelope read budget exceeded.');
        continue;
      }
      envelopeReads += 1;
      const answer = correlatedAnswer(
        record,
        boundedRegistry,
        taskRoot,
        self,
        coord,
        coordEpoch,
        sub,
        att,
        input,
      );
      if (answer.ok) {
        actions.push({
          key: `answer_supersedes_wait:${sub}:${att}:${answer.message_id}:${answer.digest}:${input ?? '-'}:${epochKey}`,
          kind: 'answer_supersedes_wait',
          subtask_id: sub,
          attempt: att,
          prerequisites: [
            'do_not_resume_obsolete_wait',
            'verify_fresh_capability_and_claims',
          ],
          evidence: [
            ...evidence,
            `answer:${answer.message_id}`,
            `digest:${answer.digest}`,
          ],
          status: 'pending',
        });
      } else {
        if (answer.candidate)
          notes.push(
            `an ANSWER for ${sub}#${att} failed registered-envelope correlation (${answer.reason}); insufficient evidence, not a continuation override.`,
          );
        actions.push({
          key: `resume_work:${sub}:${att}:${input ?? '-'}:${epochKey}`,
          kind: 'resume_work',
          subtask_id: sub,
          attempt: att,
          prerequisites: ['verify_fresh_capability_and_claims'],
          evidence,
          status: 'pending',
        });
      }
    }
  }

  // Whole-inspection revalidation: re-read the record and plan AFTER all evidence reads. Any revision,
  // digest or namespace change makes every affected recommendation non-actionable. Numeric revision match
  // is necessary, not an OS-level atomic fence; the executor must still revalidate before any effect.
  const finalRead = readRecordSafe(taskRoot);
  if (!finalRead.ok)
    markIncomplete(
      `the task record could not be re-read after evidence reads (${finalRead.code}).`,
    );
  else if (finalRead.record.state_revision !== revisionInitial)
    markIncomplete(
      `the record revision changed during inspection (${revisionInitial} -> ${finalRead.record.state_revision}); no consistent snapshot.`,
    );
  else if (finalRead.digest !== initial.digest)
    markIncomplete(
      'the task record bytes changed during inspection; no consistent snapshot.',
    );
  const planReadFinal = readBoundedFile(planFile, MAX_PLAN_BYTES);
  if (!planReadFinal.ok)
    markIncomplete(
      `the plan file became unreadable during inspection (${planReadFinal.code}).`,
    );
  else if (
    planDigestInitial !== null &&
    planReadFinal.digest !== planDigestInitial
  )
    markIncomplete(
      'the plan digest changed during inspection; no consistent snapshot.',
    );
  if (!verifyTaskNamespace(namespace))
    markIncomplete(
      'the task namespace (task root / messages / ancestors) changed or was redirected during inspection; no consistent snapshot.',
    );

  const coverage: 'complete' | 'incomplete' = incomplete
    ? 'incomplete'
    : 'complete';
  if (coverage === 'incomplete') {
    for (let i = 0; i < actions.length; i += 1) {
      const a = actions[i]!;
      if (
        a.status === 'pending' &&
        (a.kind === 'resume_work' ||
          a.kind === 'answer_supersedes_wait' ||
          a.kind === 'progress_report_to_review')
      ) {
        actions[i] = {
          ...a,
          status: 'unknown',
          prerequisites: ['complete_evidence', ...a.prerequisites],
        };
      }
    }
  }

  if (actions.length === 0) {
    actions.push({
      key: 'none:-:-:0',
      kind: 'none',
      subtask_id: null,
      attempt: null,
      prerequisites: coverage === 'incomplete' ? ['complete_evidence'] : [],
      evidence: [],
      status: coverage === 'incomplete' ? 'unknown' : 'pending',
    });
  }

  return {
    ok: true,
    value: {
      schema: COLLAB_RECOVERY_PROJECTION_SCHEMA,
      self: copyIdentity(self),
      task_root: report.task_root ?? taskRoot,
      task_id: report.task_id ?? record.task_id ?? null,
      plan_digest: report.plan.digest ?? planDigestInitial,
      record_revision: revisionInitial,
      coverage,
      coordinator_verified: coordinatorActs,
      actions,
      notes,
      limits: LIMITS,
    },
  };
}

function ambiguousAction(
  subtaskId: string,
  attempt: number,
  epochKey: number,
  evidence: readonly string[],
  uncertaintyKind: string,
): RecoveryAction {
  return {
    key: `ambiguous_effect:${subtaskId}:${attempt}:${epochKey}`,
    kind: 'ambiguous_effect',
    subtask_id: subtaskId,
    attempt,
    prerequisites: ['observe_persisted_uncertainty_before_any_continuation'],
    evidence: [...evidence, `uncertainty:${uncertaintyKind}`],
    status: 'unknown',
  };
}
