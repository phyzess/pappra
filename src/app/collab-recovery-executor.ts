import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readBoundedFile } from './bounded-file.js';
import { collabBindingSchema } from '../schemas/collaboration.js';
import { isPathInside } from '../schemas/paths.js';
import {
  anchorTaskNamespace,
  inspectRecoveryProjection,
  readRecordSafe,
  verifyTaskNamespace,
  type RecoveryAction,
  type RecoveryPolicy,
  type RecoveryProjection,
  type TaskNamespaceAnchor,
} from './collab-recovery-projection.js';
import type { Identity, TaskRecord } from '../collab/types.js';
import {
  createHerdrTransport,
  reportedSessionIdentity,
  type CommandRunner,
  type HerdrPromptResult,
  type HerdrTransport,
} from './collab-notify.js';

export const COLLAB_RECOVERY_EXECUTOR_SCHEMA =
  'pappra/collab-recovery-executor/1' as const;

const RESERVATION_SCHEMA = 'pappra/collab-recovery-reservation/2' as const;

/** Upper bounds; the executor never loops unboundedly and never mutates the protected task record. */
const MAX_RETRIES_CEILING = 4;
const DEFAULT_RETRIES = 2;
const MAX_RESERVATION_BYTES = 64 * 1024;
const MAX_JOURNAL_ENTRIES = 32;
const MAX_RESUME_CLAIM_HOPS = 64;
const RESERVATION_DIRNAME = '.recovery';
const NOFOLLOW_WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;

export type RecoveryExecutionMode = 'plan' | 'apply';

/** A continuation target is an already-authorised, verified existing session; never a fresh process. */
export interface RecoveryContinuationTarget {
  readonly agent_id: string;
  readonly session_id: string;
  readonly harness: string | null;
  readonly pane_id: string | null;
}

/** The admitted task participant a dispatch is bound to; verified against the live Herdr participant. */
export interface RecoveryBindingParticipant {
  readonly agent: string;
  readonly session_id: string;
  readonly cwd: string | null;
  readonly pane_id: string | null;
  readonly harness: string | null;
}

export interface RecoveryTaskBinding {
  readonly digest: string;
  readonly participant: RecoveryBindingParticipant;
}

export interface RecoveryExpectedSession {
  readonly session_id: string;
  readonly cwd: string | null;
  /** Digest of the canonical task-local binding file, not a caller-created participant hash. */
  readonly binding_digest: string | null;
  readonly target_agent?: string | null;
  readonly pane_id?: string | null;
  readonly harness?: string | null;
  /** Absolute path to the bounded, task-local pappra/collab-binding/1 file. */
  readonly binding_ref?: string | null;
  /** Populated only from the file whose digest and task identity were verified. */
  readonly binding?: RecoveryTaskBinding | null;
}

const MAX_RECOVERY_BINDING_BYTES = 64 * 1024;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Resolve only the exact task-local binding whose canonical file digest is pinned by the request. */
function readTaskBinding(
  taskRoot: string,
  taskId: string,
  self: Identity,
  expected: RecoveryExpectedSession | null | undefined,
): RecoveryTaskBinding | null {
  if (
    expected === null ||
    expected === undefined ||
    typeof expected.session_id !== 'string' ||
    expected.session_id.length === 0 ||
    expected.session_id !== self.session_id ||
    self.harness !== expected.harness ||
    typeof expected.cwd !== 'string' ||
    !path.isAbsolute(expected.cwd) ||
    typeof expected.harness !== 'string' ||
    expected.harness.length === 0 ||
    typeof expected.pane_id !== 'string' ||
    typeof expected.target_agent !== 'string' ||
    expected.target_agent.length === 0 ||
    typeof expected.binding_ref !== 'string' ||
    !path.isAbsolute(expected.binding_ref) ||
    typeof expected.binding_digest !== 'string' ||
    !SHA256_PATTERN.test(expected.binding_digest)
  )
    return null;

  const file = path.resolve(expected.binding_ref);
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(taskRoot);
    const fileReal = fs.realpathSync(file);
    if (
      !isPathInside(path.resolve(taskRoot), file) ||
      !isPathInside(rootReal, fileReal)
    )
      return null;
  } catch {
    return null;
  }
  const loaded = readBoundedFile(file, MAX_RECOVERY_BINDING_BYTES);
  if (!loaded.ok || loaded.digest !== expected.binding_digest) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(loaded.text) as unknown;
  } catch {
    return null;
  }
  const validated = collabBindingSchema.safeParse(parsed);
  if (!validated.success) return null;
  const binding = validated.data;
  let bindingRoot: string;
  try {
    bindingRoot = fs.realpathSync(binding.task_root);
  } catch {
    return null;
  }
  if (
    binding.task_id !== taskId ||
    bindingRoot !== rootReal ||
    binding.channel !== 'herdr'
  )
    return null;
  const matches = binding.participants.filter(
    (participant) =>
      participant.agent_id === self.agent_id &&
      participant.native_session_id === self.session_id &&
      participant.harness === expected.harness &&
      participant.cwd === expected.cwd &&
      participant.pane_id === expected.pane_id &&
      participant.herdr_agent === expected.target_agent,
  );
  if (matches.length !== 1) return null;
  const participant = matches[0]!;
  return {
    digest: loaded.digest,
    participant: {
      agent: participant.herdr_agent,
      session_id: participant.native_session_id!,
      cwd: participant.cwd,
      pane_id: participant.pane_id,
      harness: participant.harness,
    },
  };
}

export type RecoveryCauseReason = 'resume_unfinished' | 'progress_review';

/**
 * The durable, canonical cause a recovery wake is issued for. The reservation key derives from the cause
 * identity (task/actor/role/attempt/input/epoch + admitted answer/report identity), NOT from the caller
 * request id — a different request id for the same cause must not create a second right to send.
 */
export interface RecoveryCause {
  readonly reason: RecoveryCauseReason;
  readonly task_id: string | null;
  readonly role: RecoveryPolicy['role'];
  readonly actor: { readonly agent_id: string; readonly session_id: string };
  readonly action_key: string;
  readonly subtask_id: string | null;
  readonly attempt: number | null;
  readonly input_revision: string | null;
  readonly report_digest: string | null;
  readonly owner_epoch: number;
  /** Correlates callers only; it is not part of the dedup key. */
  readonly request_id: string;
  readonly is_recovery_wake: true;
}

export type RecoveryControllerKind = 'continue' | 'review';

export interface RecoveryControllerRequest {
  readonly kind: RecoveryControllerKind;
  readonly taskRoot: string;
  readonly target: RecoveryContinuationTarget;
  readonly expected: RecoveryExpectedSession | null;
  readonly cause: RecoveryCause;
  /** A recovery wake message, deliberately distinguishable from a fresh coordinator instruction. */
  readonly text: string;
  /**
   * Re-checks current task authority AFTER the controller's awaited live lookup and immediately before the
   * prompt, closing the lookup-to-send gap. A `false` result must stop the controller before any effect.
   */
  readonly confirmAuthority?: () => Promise<boolean>;
}

export type RecoveryControllerDisposition =
  'submitted' | 'deferred' | 'refused' | 'unknown' | 'failed' | 'unavailable';

/**
 * Honest effect observation.
 * - `none`: the controller has supported evidence that NO effect was issued (safe to retry).
 * - `queued`: a submission/queue acceptance only — never consumption or completion; stop.
 * - `applied`: a supported positive acknowledgement (still not task completion); stop.
 * - `unknown`: a possible/ambiguous effect (a throw, a post-submit failure) — stop, never retry.
 */
export type RecoveryEffectObservation =
  'queued' | 'applied' | 'none' | 'unknown';

export interface RecoveryControllerResult {
  readonly disposition: RecoveryControllerDisposition;
  readonly detail: string | null;
  readonly observation: RecoveryEffectObservation;
}

/**
 * The only component permitted to touch a live host. Injected by the CLI/host controller (real Herdr
 * transport with exact live-target verification) or by tests. A thrown controller is treated as a possible
 * effect (observation `unknown`), never retried.
 */
export interface RecoveryController {
  readonly id: string;
  perform(
    request: RecoveryControllerRequest,
  ): Promise<RecoveryControllerResult>;
}

export interface RecoveryExecutionRequest {
  readonly taskRoot: string;
  readonly planFile: string;
  readonly self: Identity;
  readonly policy: RecoveryPolicy;
  /** Stable caller correlation id; it does not widen the durable cause dedup. */
  readonly requestId: string;
  readonly mode: RecoveryExecutionMode;
  readonly expectedSession?: RecoveryExpectedSession | null;
  readonly maxRetries?: number;
}

export interface RecoveryExecutionDeps {
  readonly controller: RecoveryController;
  readonly now?: () => number;
  /** Bounded backoff sleeper; defaults to a real timer. Tests inject a synchronous stub. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export type RecoveryExecutionStatus =
  | 'planned'
  | 'applied'
  | 'noop'
  | 'blocked'
  | 'deferred'
  | 'unknown'
  | 'refused';

export interface ReservationView {
  readonly key: string;
  readonly path: string;
  readonly created: boolean;
  readonly outcome: string | null;
}

export interface RecoveryExecutionResult {
  readonly schema: typeof COLLAB_RECOVERY_EXECUTOR_SCHEMA;
  readonly ok: boolean;
  readonly status: RecoveryExecutionStatus;
  readonly action: RecoveryAction | null;
  readonly cause: RecoveryCause | null;
  readonly reservation: ReservationView | null;
  readonly performed: RecoveryControllerResult | null;
  readonly retries: number;
  readonly notes: readonly string[];
  readonly limits: readonly string[];
}

interface JournalEntry {
  readonly seq: number;
  readonly intent_at: number;
  readonly disposition: RecoveryControllerDisposition | null;
  readonly observation: RecoveryEffectObservation | null;
  readonly outcome_at: number | null;
}

interface ReservationFinal {
  readonly status: RecoveryExecutionStatus;
  readonly disposition: RecoveryControllerDisposition | null;
  readonly observation: RecoveryEffectObservation | null;
  readonly recorded_at: number;
}

interface ReservationFile {
  readonly schema: typeof RESERVATION_SCHEMA;
  readonly key: string;
  readonly cause: RecoveryCause;
  readonly reserved_at: number;
  owner_pid?: number;
  generation?: number;
  journal: JournalEntry[];
  final?: ReservationFinal;
}

interface InodeId {
  readonly dev: number;
  readonly ino: number;
}

interface SidecarAnchor {
  readonly dir: string;
  readonly recovery: InodeId;
  readonly reservations: InodeId;
}

const CONTINUE_KINDS = new Set<RecoveryAction['kind']>([
  'resume_work',
  'answer_supersedes_wait',
]);
const REVIEW_KINDS = new Set<RecoveryAction['kind']>([
  'progress_report_to_review',
]);

function controllerKindFor(
  kind: RecoveryAction['kind'],
): RecoveryControllerKind | null {
  if (CONTINUE_KINDS.has(kind)) return 'continue';
  if (REVIEW_KINDS.has(kind)) return 'review';
  return null;
}

function reservationDir(taskRoot: string): string {
  return path.join(taskRoot, RESERVATION_DIRNAME, 'reservations');
}

/** Derive the durable dedup key from the canonical cause identity (request id excluded). */
function causeKey(cause: RecoveryCause): string {
  const canonical = JSON.stringify({
    task_id: cause.task_id,
    role: cause.role,
    actor: cause.actor,
    owner_epoch: cause.owner_epoch,
    action_key: cause.action_key,
    subtask_id: cause.subtask_id,
    attempt: cause.attempt,
    input_revision: cause.input_revision,
    report_digest: cause.report_digest,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function result(
  partial: Omit<RecoveryExecutionResult, 'schema'>,
): RecoveryExecutionResult {
  return { schema: COLLAB_RECOVERY_EXECUTOR_SCHEMA, ...partial };
}

const BASE_LIMITS: readonly string[] = [
  'durable_sidecar_reservation_only_no_protected_record_mutation',
  'submission_or_queue_acceptance_is_not_consumption_or_completion',
  'no_native_query_controller_injected_and_live_target_verified',
  'no_new_session_hidden_process_or_reentrant_wake_loop',
  'unknown_or_possible_effects_stay_actionable_unknown_never_blind_replay',
  'no_follow_inode_anchored_sidecars_no_os_atomic_or_exactly_once_claim',
];

function boundRetries(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETRIES;
  if (!Number.isFinite(value) || !Number.isInteger(value))
    return DEFAULT_RETRIES;
  if (value < 0) return 0;
  if (value > MAX_RETRIES_CEILING) return MAX_RETRIES_CEILING;
  return value;
}

/** Find the single actionable recovery recommendation, or null when nothing is safe to act on. */
function selectActionable(
  projection: RecoveryProjection,
): RecoveryAction | null {
  if (projection.coverage !== 'complete') return null;
  const candidates = projection.actions.filter(
    (action) =>
      action.status === 'pending' && controllerKindFor(action.kind) !== null,
  );
  if (candidates.length !== 1) return null;
  return candidates[0] ?? null;
}

function buildCause(
  request: RecoveryExecutionRequest,
  projection: RecoveryProjection,
  action: RecoveryAction,
  reason: RecoveryCauseReason,
  ownerEpoch: number,
  inputRevision: string | null,
  actor: { agent_id: string; session_id: string },
  reportDigest: string | null,
): RecoveryCause {
  return {
    reason,
    task_id: projection.task_id,
    role: request.policy.role,
    actor,
    action_key: action.key,
    subtask_id: action.subtask_id,
    attempt: action.attempt,
    input_revision: inputRevision,
    report_digest: reportDigest,
    owner_epoch: ownerEpoch,
    request_id: request.requestId,
    is_recovery_wake: true,
  };
}

/**
 * Validate current authority and identity without querying a host. For a resume the acting `self` must
 * match the expected session and the attempt's bound native session; a pending cancellation refuses. For a
 * review the acting coordinator is validated by role, not by the completed writer's native binding.
 */
function validateAuthority(
  request: RecoveryExecutionRequest,
  record: TaskRecord,
  action: RecoveryAction,
  kind: RecoveryControllerKind,
  notes: string[],
): boolean {
  const expected = request.expectedSession;
  const participant = expected?.binding?.participant;
  if (
    expected === undefined ||
    expected === null ||
    participant === undefined ||
    participant === null ||
    expected.session_id !== request.self.session_id ||
    expected.binding_digest !== expected.binding?.digest ||
    participant.agent !== request.self.agent_id ||
    participant.session_id !== request.self.session_id ||
    participant.cwd !== expected.cwd ||
    participant.pane_id !== expected.pane_id ||
    participant.harness !== expected.harness ||
    expected.target_agent !== participant.agent
  ) {
    notes.push(
      'complete task-bound native identity evidence is required; refusing to apply.',
    );
    return false;
  }
  if (action.subtask_id === null || action.attempt === null) {
    notes.push(
      'the recovery action has no task attempt association; refusing to apply.',
    );
    return false;
  }
  const attempt = record.attempts.find(
    (candidate) =>
      candidate.subtask_id === action.subtask_id &&
      candidate.attempt === action.attempt,
  );
  if (!attempt) {
    notes.push(
      'the recovery attempt is not present in the current task record; refusing to apply.',
    );
    return false;
  }
  if (typeof attempt.cancel_requested_at === 'string') {
    notes.push(
      'the attempt has a pending cancellation; recovery respects the cancellation and does not apply.',
    );
    return false;
  }
  if (kind === 'continue') {
    if (
      request.policy.role !== 'writer' ||
      attempt.assignee.agent_id !== request.self.agent_id ||
      attempt.assignee.session_id !== request.self.session_id ||
      (attempt.native.session_id !== null &&
        attempt.native.session_id !== request.self.session_id)
    ) {
      notes.push(
        'the acting writer is not the current task assignee bound to this native session; refusing to apply.',
      );
      return false;
    }
  } else if (
    request.policy.role !== 'coordinator' ||
    record.coordinator?.agent_id !== request.self.agent_id ||
    record.coordinator?.session_id !== request.self.session_id
  ) {
    notes.push(
      'the acting session is not the current task coordinator; refusing review.',
    );
    return false;
  }
  return true;
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.seq === 'number' &&
    typeof entry.intent_at === 'number' &&
    (entry.disposition === null || typeof entry.disposition === 'string') &&
    (entry.observation === null || typeof entry.observation === 'string') &&
    (entry.outcome_at === null || typeof entry.outcome_at === 'number')
  );
}

function isCause(value: unknown): value is RecoveryCause {
  if (typeof value !== 'object' || value === null) return false;
  const cause = value as Record<string, unknown>;
  const actor = cause.actor as Record<string, unknown> | undefined;
  return (
    typeof cause.action_key === 'string' &&
    typeof cause.role === 'string' &&
    typeof cause.owner_epoch === 'number' &&
    (cause.task_id === null || typeof cause.task_id === 'string') &&
    (cause.subtask_id === null || typeof cause.subtask_id === 'string') &&
    (cause.attempt === null || typeof cause.attempt === 'number') &&
    (cause.input_revision === null ||
      typeof cause.input_revision === 'string') &&
    (cause.report_digest === null || typeof cause.report_digest === 'string') &&
    typeof cause.request_id === 'string' &&
    cause.is_recovery_wake === true &&
    typeof actor === 'object' &&
    actor !== null &&
    typeof actor.agent_id === 'string' &&
    typeof actor.session_id === 'string'
  );
}

/** Parse the complete reservation/cause/journal/final schema; malformed/truncated data stays unknown. */
function parseReservation(raw: string): ReservationFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const file = parsed as Record<string, unknown>;
  if (file.schema !== RESERVATION_SCHEMA) return null;
  if (typeof file.key !== 'string') return null;
  if (typeof file.reserved_at !== 'number') return null;
  if (
    file.owner_pid !== undefined &&
    (!Number.isSafeInteger(file.owner_pid) || Number(file.owner_pid) <= 0)
  )
    return null;
  if (!isCause(file.cause)) return null;
  if (
    file.generation !== undefined &&
    (!Number.isSafeInteger(file.generation) || Number(file.generation) < 0)
  )
    return null;
  if (!Array.isArray(file.journal) || !file.journal.every(isJournalEntry))
    return null;
  if (file.final !== undefined) {
    const final = file.final as Record<string, unknown>;
    if (
      typeof final !== 'object' ||
      final === null ||
      typeof final.status !== 'string' ||
      typeof final.recorded_at !== 'number'
    )
      return null;
  }
  return parsed as ReservationFile;
}

function lstatId(target: string): InodeId | null {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory()) return null;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

/**
 * Create and no-follow-verify the sidecar directory chain inside the task root, pinning each component's
 * inode. Every component must be a real directory (never a symlink) so a pre-created or swapped `.recovery`
 * cannot redirect writes outside the task root.
 */
function openSidecarDir(taskRoot: string): SidecarAnchor | null {
  const recoveryDir = path.join(taskRoot, RESERVATION_DIRNAME);
  const reservationsDir = path.join(recoveryDir, 'reservations');
  for (const dir of [recoveryDir, reservationsDir]) {
    if (lstatId(dir) === null) {
      try {
        fs.mkdirSync(dir);
      } catch {
        return null;
      }
    }
  }
  const recovery = lstatId(recoveryDir);
  const reservations = lstatId(reservationsDir);
  if (recovery === null || reservations === null) return null;
  return { dir: reservationsDir, recovery, reservations };
}

/** Re-verify the sidecar directories still resolve to the pinned inodes and are not symlinks. */
function verifySidecar(anchor: SidecarAnchor): boolean {
  const recovery = lstatId(path.join(anchor.dir, '..'));
  const reservations = lstatId(anchor.dir);
  return (
    recovery !== null &&
    reservations !== null &&
    recovery.dev === anchor.recovery.dev &&
    recovery.ino === anchor.recovery.ino &&
    reservations.dev === anchor.reservations.dev &&
    reservations.ino === anchor.reservations.ino
  );
}

/** Exclusively create the reservation file (O_EXCL refuses an existing symlink) and pin its inode. */
function createReservationExclusive(
  file: string,
  anchor: SidecarAnchor,
  body: string,
): { ok: true; id: InodeId } | { ok: false; reason: 'exists' | 'unsafe' } {
  if (!verifySidecar(anchor)) return { ok: false, reason: 'unsafe' };
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      return { ok: false, reason: 'exists' };
    return { ok: false, reason: 'unsafe' };
  }
  try {
    const stat = fs.fstatSync(fd);
    fs.writeSync(fd, body);
    fs.ftruncateSync(fd, Buffer.byteLength(body));
    fs.fsyncSync(fd);
    return { ok: true, id: { dev: stat.dev, ino: stat.ino } };
  } catch {
    return { ok: false, reason: 'unsafe' };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Update the reservation through a no-follow descriptor whose inode must still match the pinned file, with
 * the sidecar directories re-verified. A swapped symlink or replaced inode yields a conservative `false`
 * and never follows the link or writes outside; nothing throws out of this path.
 */
function safeUpdate(
  file: string,
  fileId: InodeId,
  anchor: SidecarAnchor,
  body: string,
): boolean {
  if (!verifySidecar(anchor)) return false;
  let fd: number;
  try {
    fd = fs.openSync(file, NOFOLLOW_WRITE_FLAGS);
  } catch {
    return false; // ELOOP for a symlink, ENOENT for a removed file, etc.
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== fileId.dev || stat.ino !== fileId.ino)
      return false;
    fs.writeSync(fd, body);
    fs.ftruncateSync(fd, Buffer.byteLength(body));
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/** Read and fully validate a reservation through a bounded no-follow regular-file read. */
function readReservation(
  file: string,
  anchor: SidecarAnchor,
): ReservationFile | null {
  if (!verifySidecar(anchor)) return null;
  let raw: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_RESERVATION_BYTES) return null;
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return parseReservation(raw);
}

function processExited(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Dead pre-dispatch claims are immutable. Contend on one deterministic successor
 * instead of unlinking a pathname that another contender may already have replaced.
 */
function claimResumeGeneration(
  reservationFile: string,
  anchor: SidecarAnchor,
  existing: ReservationFile,
): ReturnType<typeof createReservationExclusive> {
  const base = `${reservationFile}.resume-${existing.generation ?? 0}.lock`;
  let claimFile = base;
  const snapshot = serialize(existing);
  for (let hop = 0; hop < MAX_RESUME_CLAIM_HOPS; hop += 1) {
    const current = readReservation(reservationFile, anchor);
    if (current === null || serialize(current) !== snapshot)
      return { ok: false, reason: 'exists' };
    const claim = createReservationExclusive(
      claimFile,
      anchor,
      `${JSON.stringify({ owner_pid: process.pid, prior_owner_pid: existing.owner_pid, key: existing.key })}\n`,
    );
    if (claim.ok || claim.reason !== 'exists') return claim;
    let fd: number | null = null;
    try {
      fd = fs.openSync(
        claimFile,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024)
        return { ok: false, reason: 'unsafe' };
      const buffer = Buffer.alloc(1025);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes > 1024) return { ok: false, reason: 'unsafe' };
      const raw = buffer.subarray(0, bytes).toString('utf8');
      const owner: unknown = JSON.parse(raw);
      if (
        typeof owner !== 'object' ||
        owner === null ||
        !('owner_pid' in owner) ||
        !('key' in owner) ||
        owner.key !== existing.key ||
        typeof owner.owner_pid !== 'number' ||
        !Number.isSafeInteger(owner.owner_pid) ||
        owner.owner_pid <= 0 ||
        !processExited(owner.owner_pid)
      )
        return { ok: false, reason: 'exists' };
      const after = fs.lstatSync(claimFile);
      if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino)
        return { ok: false, reason: 'unsafe' };
      const boundary = crypto
        .createHash('sha256')
        .update(JSON.stringify([stat.dev, stat.ino, raw]))
        .digest('hex');
      claimFile = `${base}.retry-${boundary}`;
    } catch {
      return { ok: false, reason: 'unsafe' };
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* The claim remains conservative if descriptor cleanup fails. */
        }
      }
    }
  }
  return { ok: false, reason: 'exists' };
}

function controllerClass(
  outcome: RecoveryControllerResult,
): 'issued' | 'deferred' | 'refused' | 'retriable' | 'unknown' {
  if (outcome.disposition === 'submitted') return 'issued';
  if (outcome.disposition === 'deferred') return 'deferred';
  if (outcome.disposition === 'refused') return 'refused';
  // Retry only on explicit supported evidence of known no effect.
  if (
    (outcome.disposition === 'failed' ||
      outcome.disposition === 'unavailable') &&
    outcome.observation === 'none'
  )
    return 'retriable';
  return 'unknown';
}

function statusForClass(
  klass: 'issued' | 'deferred' | 'refused' | 'unknown',
): RecoveryExecutionStatus {
  if (klass === 'issued') return 'applied';
  if (klass === 'deferred') return 'deferred';
  if (klass === 'refused') return 'refused';
  return 'unknown';
}

/**
 * Execute one durable, idempotent recovery step. `plan` validates and reports the intended action with
 * zero effect; `apply` reserves atomically by canonical cause through no-follow inode-anchored sidecars
 * before issuing a single supported continuation/review wake through the injected (exact live-target
 * verifying) controller. Authority, namespace, sidecar anchors and the live target are re-validated before
 * every attempt and again inside the controller after its live lookup; only explicit known no-effect
 * failures retry within a bounded budget, and a possible/ambiguous effect stops as unknown. Persistence
 * failures become structured outcomes and never throw out of the host callback.
 */
export async function executeRecovery(
  request: RecoveryExecutionRequest,
  deps: RecoveryExecutionDeps,
): Promise<RecoveryExecutionResult> {
  try {
    return await runRecovery(request, deps);
  } catch (error) {
    return result({
      ok: false,
      status: 'unknown',
      action: null,
      cause: null,
      reservation: null,
      performed: null,
      retries: 0,
      notes: [
        `recovery stopped on an unexpected error and is recorded as an actionable unknown (${error instanceof Error ? error.message : 'error'}).`,
      ],
      limits: BASE_LIMITS,
    });
  }
}

async function runRecovery(
  request: RecoveryExecutionRequest,
  deps: RecoveryExecutionDeps,
): Promise<RecoveryExecutionResult> {
  const notes: string[] = [];
  const maxRetries = boundRetries(request.maxRetries);
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (request.mode !== 'plan' && request.mode !== 'apply')
    return refusal('mode must be "plan" or "apply".');
  if (typeof request.requestId !== 'string' || request.requestId.length === 0)
    return refusal('a non-empty stable requestId is required.');

  const projectionResult = await inspectRecoveryProjection({
    taskRoot: request.taskRoot,
    planFile: request.planFile,
    self: request.self,
    policy: request.policy,
  });
  if (!projectionResult.ok)
    return refusal(`projection refused: ${projectionResult.message}`);

  const projection = projectionResult.value;
  const action = selectActionable(projection);
  if (action === null)
    return result({
      ok: true,
      status: 'noop',
      action: null,
      cause: null,
      reservation: null,
      performed: null,
      retries: 0,
      notes:
        projection.coverage !== 'complete'
          ? ['projection coverage is incomplete; no action is safe to issue.']
          : ['no single actionable recovery recommendation; nothing to do.'],
      limits: [...BASE_LIMITS, ...projection.limits],
    });

  const controllerKind = controllerKindFor(
    action.kind,
  ) as RecoveryControllerKind;
  const reason: RecoveryCauseReason =
    controllerKind === 'review' ? 'progress_review' : 'resume_unfinished';
  const reportDigest =
    action.evidence.find((item) => item.startsWith('report:')) ?? null;

  const preRead = readRecordSafe(request.taskRoot);
  const ownerEpoch =
    preRead.ok && preRead.record.coordinator
      ? preRead.record.coordinator.owner_epoch
      : 0;
  const attemptForCause =
    preRead.ok && action.subtask_id !== null && action.attempt !== null
      ? (preRead.record.attempts.find(
          (candidate) =>
            candidate.subtask_id === action.subtask_id &&
            candidate.attempt === action.attempt,
        ) ?? null)
      : null;
  const inputRevision = attemptForCause ? attemptForCause.input_revision : null;
  const actor =
    controllerKind === 'review' && preRead.ok && preRead.record.coordinator
      ? {
          agent_id: preRead.record.coordinator.agent_id,
          session_id: preRead.record.coordinator.session_id,
        }
      : attemptForCause && attemptForCause.assignee
        ? {
            agent_id: attemptForCause.assignee.agent_id,
            session_id: attemptForCause.assignee.session_id,
          }
        : {
            agent_id: request.self.agent_id,
            session_id: request.self.session_id,
          };
  const cause = buildCause(
    request,
    projection,
    action,
    reason,
    ownerEpoch,
    inputRevision,
    actor,
    reportDigest,
  );
  const key = causeKey(cause);

  let applyRequest = request;
  if (request.mode === 'apply') {
    const taskBinding = readTaskBinding(
      request.taskRoot,
      projection.task_id ?? '',
      request.self,
      request.expectedSession,
    );
    if (taskBinding === null)
      return refusal(
        'apply requires an exact current-session identity and a matching digest-pinned task-local binding participant.',
      );
    applyRequest = {
      ...request,
      expectedSession: {
        ...request.expectedSession!,
        binding: taskBinding,
      },
    };
  }

  if (request.mode === 'plan') {
    const dir = reservationDir(request.taskRoot);
    return result({
      ok: true,
      status: 'planned',
      action,
      cause,
      reservation: {
        key,
        path: path.join(dir, `${key}.json`),
        created: false,
        outcome: null,
      },
      performed: null,
      retries: 0,
      notes: ['dry plan: no reservation written and no controller invoked.'],
      limits: [...BASE_LIMITS, ...projection.limits],
    });
  }

  // apply: retain the initial task namespace anchor across the whole operation.
  const initialAnchor = anchorTaskNamespace(applyRequest.taskRoot);
  if (!verifyTaskNamespace(initialAnchor))
    return blocked(
      action,
      cause,
      'the task namespace is unavailable or redirected; refusing to apply.',
      projection,
    );
  if (!preRead.ok)
    return blocked(
      action,
      cause,
      `the task record could not be re-read before applying (${preRead.code}).`,
      projection,
    );
  if (
    !validateAuthority(
      applyRequest,
      preRead.record,
      action,
      controllerKind,
      notes,
    )
  )
    return result({
      ok: false,
      status: 'refused',
      action,
      cause,
      reservation: null,
      performed: null,
      retries: 0,
      notes,
      limits: [...BASE_LIMITS, ...projection.limits],
    });

  const sidecar = openSidecarDir(applyRequest.taskRoot);
  if (sidecar === null)
    return blocked(
      action,
      cause,
      'the recovery sidecar directory is missing, not a directory, or redirected through a symlink; refusing to write or wake.',
      projection,
    );
  const file = path.join(sidecar.dir, `${key}.json`);

  const firstBody = `${JSON.stringify({ schema: RESERVATION_SCHEMA, key, cause, reserved_at: now(), owner_pid: process.pid, journal: [] } satisfies ReservationFile, null, 2)}\n`;
  const create = createReservationExclusive(file, sidecar, firstBody);
  let resumed: { reservation: ReservationFile; id: InodeId } | null = null;
  if (!create.ok) {
    if (create.reason === 'unsafe')
      return blocked(
        action,
        cause,
        'the recovery sidecar was redirected or unwritable; refusing to write or wake.',
        projection,
        { key, path: file, created: false },
      );
    const existing = readReservation(file, sidecar);
    if (existing === null)
      return unknownState(
        action,
        cause,
        key,
        file,
        'a reservation exists but is unreadable or malformed; the prior effect state is unknown. Not replaying.',
        projection,
      );
    const knownNoEffect =
      existing.key === key &&
      existing.journal.every(
        (entry, index, entries) =>
          Number.isSafeInteger(entry.seq) &&
          entry.seq >= 0 &&
          (index === 0 || entry.seq === entries[index - 1]!.seq + 1) &&
          entry.outcome_at !== null &&
          entry.observation === 'none' &&
          (entry.disposition === 'failed' ||
            entry.disposition === 'unavailable' ||
            entry.disposition === 'refused'),
      );
    const retryableFinal =
      knownNoEffect &&
      existing.final?.observation === 'none' &&
      (existing.final.status === 'blocked' ||
        existing.final.status === 'unknown' ||
        existing.final.status === 'refused');
    if (existing.final && !retryableFinal)
      return result({
        ok:
          existing.final.status === 'applied' ||
          existing.final.status === 'deferred',
        status:
          existing.final.status === 'applied' ||
          existing.final.status === 'deferred'
            ? 'noop'
            : 'unknown',
        action,
        cause,
        reservation: {
          key,
          path: file,
          created: false,
          outcome: existing.final.status,
        },
        performed: null,
        retries: 0,
        notes: [
          'this cause has a recorded effect or ambiguous outcome; preserving that outcome without re-issuing. A possible effect requires supported observation before retry.',
        ],
        limits: [...BASE_LIMITS, ...projection.limits],
      });
    const previousExited = processExited(existing.owner_pid);
    if (retryableFinal || (previousExited && knownNoEffect)) {
      // Each persisted retry boundary has one exclusive successor. A crash after
      // this claim remains ambiguous; the same boundary is never claimed twice.
      const claim = claimResumeGeneration(file, sidecar, existing);
      if (claim.ok) {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          const current = readReservation(file, sidecar);
          if (current && serialize(current) === serialize(existing)) {
            existing.owner_pid = process.pid;
            existing.generation = (existing.generation ?? 0) + 1;
            delete existing.final;
            const id = { dev: stat.dev, ino: stat.ino };
            if (safeUpdate(file, id, sidecar, serialize(existing)))
              resumed = { reservation: existing, id };
          }
        }
      }
    }
    if (!resumed)
      return unknownState(
        action,
        cause,
        key,
        file,
        'exclusive continuation ownership could not be established: an incomplete intent, live or malformed owner, or retry-claim chain beyond the bounded inspection limit remains unknown. No wake was replayed; inspect the reservation and claims.',
        projection,
      );
  }
  const fileId = resumed ? resumed.id : create.ok ? create.id : null;
  if (!fileId) throw new Error('recovery_reservation_identity_missing');
  const reservation: ReservationFile = resumed
    ? resumed.reservation
    : (JSON.parse(firstBody) as ReservationFile);
  const reservationCreated = resumed === null;

  // Per-attempt dispatch loop: fresh authority + sidecar/live-target revalidation before every attempt.
  let retries = 0;
  let last: RecoveryControllerResult = {
    disposition: 'unknown',
    detail: 'no attempt made',
    observation: 'unknown',
  };
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(2000, 100 * 2 ** (attempt - 1)));

    const recheckBlock = await revalidateBeforeAttempt(
      applyRequest,
      action,
      controllerKind,
      initialAnchor,
      sidecar,
    );
    if (recheckBlock !== null)
      return blockedAfterReserve(
        file,
        fileId,
        sidecar,
        reservation,
        now,
        action,
        cause,
        recheckBlock,
        projection,
        key,
        reservationCreated,
      );

    const entry: JournalEntry = {
      seq: (reservation.journal.at(-1)?.seq ?? -1) + 1,
      intent_at: now(),
      disposition: null,
      observation: null,
      outcome_at: null,
    };
    appendJournal(reservation, entry);
    if (!safeUpdate(file, fileId, sidecar, serialize(reservation)))
      return blocked(
        action,
        cause,
        'the reservation file was redirected or replaced before dispatch; refusing to write or wake.',
        projection,
        { key, path: file, created: reservationCreated },
      );

    const target: RecoveryContinuationTarget = {
      agent_id: applyRequest.self.agent_id,
      session_id: applyRequest.self.session_id,
      harness: applyRequest.self.harness,
      pane_id: applyRequest.expectedSession?.pane_id ?? null,
    };
    const confirmAuthority = async (): Promise<boolean> =>
      (await revalidateBeforeAttempt(
        applyRequest,
        action,
        controllerKind,
        initialAnchor,
        sidecar,
      )) === null;
    try {
      last = await deps.controller.perform({
        kind: controllerKind,
        taskRoot: applyRequest.taskRoot,
        target,
        expected: applyRequest.expectedSession ?? null,
        cause,
        text: wakeText(controllerKind, action, cause),
        confirmAuthority,
      });
    } catch (error) {
      last = {
        disposition: 'failed',
        detail: error instanceof Error ? error.message : 'controller threw',
        observation: 'unknown', // a throw is a possible effect; never retried.
      };
    }
    reservation.journal[reservation.journal.length - 1] = {
      ...entry,
      disposition: last.disposition,
      observation: last.observation,
      outcome_at: now(),
    };
    const outcomePersisted = safeUpdate(
      file,
      fileId,
      sidecar,
      serialize(reservation),
    );

    const klass = controllerClass(last);
    if (klass !== 'retriable') {
      const status = statusForClass(klass);
      finalize(file, fileId, sidecar, reservation, now, status, last);
      if (last.observation === 'queued')
        notes.push(
          'the wake was accepted into a queue; this is not consumption or task completion.',
        );
      if (klass === 'unknown')
        notes.push(
          'the dispatch result is a possible or ambiguous effect; it is recorded as an actionable unknown and not replayed.',
        );
      if (!outcomePersisted)
        notes.push(
          'the dispatch outcome could not be safely persisted (the sidecar path became unsafe); the effect is an actionable unknown.',
        );
      return result({
        ok: outcomePersisted && (status === 'applied' || status === 'deferred'),
        status: outcomePersisted ? status : 'unknown',
        action,
        cause,
        reservation: {
          key,
          path: file,
          created: reservationCreated,
          outcome: outcomePersisted ? status : 'unknown',
        },
        performed: last,
        retries,
        notes,
        limits: [...BASE_LIMITS, ...projection.limits],
      });
    }
    if (attempt >= maxRetries) {
      finalize(file, fileId, sidecar, reservation, now, 'unknown', last);
      notes.push(
        `the continuation wake could not be delivered after ${retries} retries (${last.disposition}); persisted no-effect evidence permits a later bounded retry after the obstruction is resolved.`,
      );
      return result({
        ok: false,
        status: 'unknown',
        action,
        cause,
        reservation: {
          key,
          path: file,
          created: reservationCreated,
          outcome: 'unknown',
        },
        performed: last,
        retries,
        notes,
        limits: [...BASE_LIMITS, ...projection.limits],
      });
    }
    retries += 1;
  }
}

function serialize(reservation: ReservationFile): string {
  return `${JSON.stringify(reservation, null, 2)}\n`;
}

function wakeText(
  kind: RecoveryControllerKind,
  action: RecoveryAction,
  cause: RecoveryCause,
): string {
  return kind === 'review'
    ? `[pappra-recovery] progress review for ${action.subtask_id ?? 'task'} attempt ${String(action.attempt ?? '-')}; do not rerun the writer. cause=${cause.action_key}`
    : `[pappra-recovery] resume authorised work for ${action.subtask_id ?? 'task'} attempt ${String(action.attempt ?? '-')} on this session; this is a recovery wake, not a new instruction. cause=${cause.action_key}`;
}

/**
 * Re-validate the namespace anchor, sidecar anchors, record, plan and authority immediately before an
 * attempt. Returns a block reason when the snapshot or authority changed (for example a CANCEL admitted
 * during backoff), or null when the same cause is still actionable.
 */
async function revalidateBeforeAttempt(
  request: RecoveryExecutionRequest,
  action: RecoveryAction,
  kind: RecoveryControllerKind,
  initialAnchor: TaskNamespaceAnchor | null,
  sidecar: SidecarAnchor,
): Promise<string | null> {
  if (!verifyTaskNamespace(initialAnchor))
    return 'the task namespace changed or was redirected during recovery; stopping before the effect.';
  if (!verifySidecar(sidecar))
    return 'the recovery sidecar directory was redirected during recovery; stopping before the effect.';
  const recheck = await inspectRecoveryProjection({
    taskRoot: request.taskRoot,
    planFile: request.planFile,
    self: request.self,
    policy: request.policy,
  });
  if (!recheck.ok)
    return 'the projection became unavailable during recovery; stopping.';
  const rechecked = selectActionable(recheck.value);
  if (rechecked === null || rechecked.key !== action.key)
    return 'the recovery recommendation changed during recovery; no wake was issued.';
  const safe = readRecordSafe(request.taskRoot);
  if (!safe.ok)
    return 'the task record became unreadable during recovery; stopping.';
  const currentBinding = readTaskBinding(
    request.taskRoot,
    safe.record.task_id,
    request.self,
    request.expectedSession,
  );
  if (
    currentBinding === null ||
    currentBinding.digest !== request.expectedSession?.binding?.digest ||
    JSON.stringify(currentBinding.participant) !==
      JSON.stringify(request.expectedSession?.binding?.participant)
  )
    return 'the pinned task binding changed or no longer admits this session; stopping before the effect.';
  const authorityNotes: string[] = [];
  if (!validateAuthority(request, safe.record, action, kind, authorityNotes))
    return authorityNotes[0] ?? 'authority changed during recovery; stopping.';
  return null;
}

function appendJournal(
  reservation: ReservationFile,
  entry: JournalEntry,
): void {
  reservation.journal.push(entry);
  if (reservation.journal.length > MAX_JOURNAL_ENTRIES)
    reservation.journal.splice(
      0,
      reservation.journal.length - MAX_JOURNAL_ENTRIES,
    );
}

function finalize(
  file: string,
  fileId: InodeId,
  sidecar: SidecarAnchor,
  reservation: ReservationFile,
  now: () => number,
  status: RecoveryExecutionStatus,
  outcome: RecoveryControllerResult,
): void {
  reservation.final = {
    status,
    disposition: outcome.disposition,
    observation: outcome.observation,
    recorded_at: now(),
  };
  // Best-effort: only ever through the safe no-follow path; never through an unsafe path.
  safeUpdate(file, fileId, sidecar, serialize(reservation));
}

function blockedAfterReserve(
  file: string,
  fileId: InodeId,
  sidecar: SidecarAnchor,
  reservation: ReservationFile,
  now: () => number,
  action: RecoveryAction,
  cause: RecoveryCause,
  note: string,
  projection: RecoveryProjection,
  key: string,
  created: boolean,
): RecoveryExecutionResult {
  reservation.final = {
    status: 'blocked',
    disposition: null,
    observation: 'none',
    recorded_at: now(),
  };
  safeUpdate(file, fileId, sidecar, serialize(reservation));
  return blocked(action, cause, note, projection, {
    key,
    path: file,
    created,
  });
}

function refusal(note: string): RecoveryExecutionResult {
  return result({
    ok: false,
    status: 'refused',
    action: null,
    cause: null,
    reservation: null,
    performed: null,
    retries: 0,
    notes: [note],
    limits: BASE_LIMITS,
  });
}

function blocked(
  action: RecoveryAction,
  cause: RecoveryCause,
  note: string,
  projection: RecoveryProjection,
  reservation: { key: string; path: string; created: boolean } | null = null,
): RecoveryExecutionResult {
  return result({
    ok: false,
    status: 'blocked',
    action,
    cause,
    reservation: reservation ? { ...reservation, outcome: 'blocked' } : null,
    performed: null,
    retries: 0,
    notes: [note],
    limits: [...BASE_LIMITS, ...projection.limits],
  });
}

function unknownState(
  action: RecoveryAction,
  cause: RecoveryCause,
  key: string,
  file: string,
  note: string,
  projection: RecoveryProjection,
): RecoveryExecutionResult {
  return result({
    ok: false,
    status: 'unknown',
    action,
    cause,
    reservation: { key, path: file, created: false, outcome: null },
    performed: null,
    retries: 0,
    notes: [note],
    limits: [...BASE_LIMITS, ...projection.limits],
  });
}

/**
 * Concrete controller for one visible Herdr target. Apply requires a complete native identity and a bounded,
 * digest-pinned task-local binding that admits the acting participant and target. The live session identity,
 * cwd, pane and harness must all match exactly. Task authority and the binding are re-read after the awaited
 * live lookup and immediately before the prompt. It never spawns a process.
 */
export function herdrRecoveryController(
  transport: HerdrTransport,
  target: { readonly agent: string },
): RecoveryController {
  return {
    id: `herdr:${transport.id}`,
    async perform(request) {
      const expected = request.expected;
      if (
        expected === null ||
        expected === undefined ||
        typeof expected.session_id !== 'string' ||
        expected.session_id.length === 0 ||
        typeof expected.cwd !== 'string' ||
        typeof expected.harness !== 'string' ||
        typeof expected.pane_id !== 'string' ||
        expected.target_agent !== target.agent ||
        typeof expected.binding_ref !== 'string' ||
        typeof expected.binding_digest !== 'string' ||
        request.cause.task_id === null ||
        request.cause.actor.session_id !== expected.session_id ||
        request.target.session_id !== expected.session_id ||
        request.target.pane_id !== expected.pane_id ||
        request.target.harness !== expected.harness ||
        request.target.agent_id !== request.cause.actor.agent_id ||
        typeof request.confirmAuthority !== 'function'
      )
        return {
          disposition: 'refused',
          detail:
            'complete task-bound native identity and final authority evidence are required',
          observation: 'none',
        };
      const actor: Identity = {
        agent_id: request.cause.actor.agent_id,
        session_id: request.cause.actor.session_id,
        harness: expected.harness,
      };
      const admitted = readTaskBinding(
        request.taskRoot,
        request.cause.task_id,
        actor,
        expected,
      );
      if (admitted === null)
        return {
          disposition: 'refused',
          detail:
            'the pinned task binding is missing, stale or does not admit the acting participant',
          observation: 'none',
        };
      const verifiedExpected: RecoveryExpectedSession = {
        ...expected,
        binding: admitted,
      };
      let listed;
      try {
        listed = await transport.list();
      } catch (error) {
        return {
          disposition: 'failed',
          detail: error instanceof Error ? error.message : 'list threw',
          observation: 'none',
        };
      }
      if (!listed.ok)
        return {
          disposition: listed.status,
          detail: listed.detail,
          observation: 'none',
        };
      const agent = listed.agents.find((item) => item.name === target.agent);
      if (!agent)
        return {
          disposition: 'refused',
          detail: `target agent ${target.agent} is not a live participant`,
          observation: 'none',
        };
      const reported = reportedSessionIdentity(
        agent.sessionKind,
        agent.sessionValue,
      );
      if (
        reported.status !== 'match' ||
        reported.identity !== verifiedExpected.session_id
      )
        return {
          disposition: 'refused',
          detail:
            'live target session identity does not exactly match the expected session',
          observation: 'none',
        };
      if (agent.cwd !== verifiedExpected.cwd)
        return {
          disposition: 'refused',
          detail:
            'live target cwd is missing or does not match the expected cwd',
          observation: 'none',
        };
      if (agent.paneId !== verifiedExpected.pane_id)
        return {
          disposition: 'refused',
          detail: 'live target pane does not match the expected pane',
          observation: 'none',
        };
      if (agent.harness !== verifiedExpected.harness)
        return {
          disposition: 'refused',
          detail: 'live target harness does not match the expected harness',
          observation: 'none',
        };
      const bindingRefusal = verifyBinding(
        verifiedExpected,
        agent,
        reported.identity,
      );
      if (bindingRefusal !== null)
        return {
          disposition: 'refused',
          detail: bindingRefusal,
          observation: 'none',
        };
      const currentBinding = readTaskBinding(
        request.taskRoot,
        request.cause.task_id,
        actor,
        expected,
      );
      if (
        currentBinding === null ||
        currentBinding.digest !== admitted.digest ||
        JSON.stringify(currentBinding.participant) !==
          JSON.stringify(admitted.participant) ||
        !(await request.confirmAuthority())
      )
        return {
          disposition: 'refused',
          detail:
            'task authority or the pinned binding changed between the live lookup and the prompt',
          observation: 'none',
        };
      let status: HerdrPromptResult;
      try {
        status = await transport.prompt(target.agent, request.text);
      } catch (error) {
        return {
          disposition: 'failed',
          detail: error instanceof Error ? error.message : 'prompt threw',
          observation: 'unknown',
        };
      }
      return mapPromptResult(status);
    },
  };
}

function verifyBinding(
  expected: RecoveryExpectedSession,
  agent: {
    name: string | null;
    cwd: string | null;
    paneId: string | null;
    harness: string;
  },
  sessionId: string,
): string | null {
  const participant = expected.binding?.participant;
  if (participant === undefined || participant === null)
    return 'the live target has no verified task-binding membership';
  if (
    agent.name !== participant.agent ||
    sessionId !== participant.session_id ||
    agent.cwd !== participant.cwd ||
    agent.paneId !== participant.pane_id ||
    agent.harness !== participant.harness
  )
    return 'the live participant does not match the canonical task binding';
  return null;
}

function mapPromptResult(status: HerdrPromptResult): RecoveryControllerResult {
  switch (status.status) {
    case 'submitted':
      return {
        disposition: 'submitted',
        detail: status.detail,
        observation: 'queued',
      };
    case 'blocked':
      return {
        disposition: 'deferred',
        detail: status.detail,
        observation: 'none',
      };
    case 'refused':
      return {
        disposition: 'refused',
        detail: status.detail,
        observation: 'none',
      };
    case 'unavailable':
      return {
        disposition: 'unavailable',
        detail: status.detail,
        observation: 'none',
      };
    case 'failed':
      return {
        disposition: 'failed',
        detail: status.detail,
        observation: 'unknown',
      };
    default:
      return {
        disposition: 'unknown',
        detail: status.detail,
        observation: 'unknown',
      };
  }
}

/** Build a Herdr-backed recovery controller from the ambient environment and a target agent. */
export function createHerdrRecoveryController(
  options: { readonly env?: NodeJS.ProcessEnv; readonly run?: CommandRunner },
  target: { readonly agent: string },
): RecoveryController {
  return herdrRecoveryController(createHerdrTransport(options), target);
}
