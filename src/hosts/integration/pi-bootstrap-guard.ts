/**
 * Opt-in successor-bootstrap managed-tool gate (one rollover prerequisite).
 *
 * A separately opt-in Pi `tool_call` guard for the NEW (successor) writer session during a rollover.
 * Registered before any model work, it starts DENIED for every non-vetted-read managed tool
 * (bash/write/edit and any unknown/custom tool); only the fixed vetted native-read set reused from the
 * accepted freeze module is ever allowed, and only for the exact pinned native session. It permits the
 * successor's first non-read tool ONLY after the authoritative, validated current task record proves the
 * completed writer transfer to the pinned successor — read fresh on EVERY call. It does not require a
 * first-work REPORT to permit the first write; that proof comes afterward.
 *
 * Authority is validated against the record itself for cross-record CONSISTENCY, not merely schema
 * validity: the pinned intent in `record.rollover`, the completed WRITER `record.handoffs` entry (kind,
 * subtask/attempt, coordinator epoch, exact from/to, resources and ownership snapshot consistent with the
 * intent), a transfer boundary bounded by the current record and history, the latest actionable attempt
 * owned by the successor with `ownership:'transferred'` and its full confirmed native binding, and every
 * original claim held by the successor at `original + 1`. Duplicate or ambiguous ids anywhere block rather
 * than letting a first-match lookup resolve contradictory records to allow. Every check is fail-closed: a
 * malformed event, a throwing property/record accessor, or any traversal/validation failure returns an
 * explicit block and never escapes into host default behavior.
 *
 * What it is NOT: it is not a transfer action, a stop/quiescence inference, an authority store, or a
 * filesystem/cross-process write fence. It never mutates claims, epochs, handoffs, bindings, messages,
 * the bundle or the archive; it never feeds observations into the freeze controller; it adds no timer,
 * watcher, spawned command, transcript access, network or model call. There is no model-accessible allow/
 * thaw/release method and no boolean authorization callback. The record comes only from an explicitly
 * trusted, read-only host adapter supplied at registration that returns record DATA (never `allowed:true`,
 * a self-signed token or an invented stop proof); this slice does not authenticate a filesystem/remote
 * source, establish freshness against a dishonest adapter, or install a durable reader — a later real
 * adapter must bind and read the actual task domain safely, and this is not complete native authorization.
 *
 * There is no filesystem lock covering a tool's later execution: the guard answers the call-time question
 * only (check/use gap), and background/external processes and effects outside managed Pi tools are never
 * fenced.
 *
 * Installed Pi 1.3.0 `tool_call` blocking contract and the vetted native-read set are reused from the
 * accepted `pi-rollover-extension.ts`; the running session is read from `ctx.sessionManager.getSessionId()`
 * (pinned API). Structural compatibility is not a shipped-declaration or live-load proof.
 */

import {
  VETTED_NATIVE_READ_TOOLS,
  type PiToolBlockDecision,
  type PiToolCallEvent,
} from './pi-rollover-extension.js';
import { latestAttemptNumber } from '../../collab/lifecycle.js';
import type { Identity, TaskRecord } from '../../collab/types.js';
import { isTaskRecord } from '../../collab/validation.js';

export const PI_BOOTSTRAP_GUARD_STATUS_SCHEMA =
  'pappra/pi-bootstrap-guard-status/1';

const MAX_ID_LENGTH = 256;
const MAX_CLAIMS = 1024;

/**
 * The only current writer states that may hold first-write authority (active + owned + actionable). It is
 * `ACTIVE_STATES` minus `unknown`; `needs_input`, terminal and any unknown/blocked state can never
 * silently grant authority.
 */
const PERMITTED_WRITER_STATES: ReadonlySet<string> = new Set([
  'assigned',
  'accepted',
  'running',
]);

export interface BootstrapGuardIdentity {
  readonly agentId: string;
  readonly sessionId: string;
  readonly harness: string;
}

/** One pinned ORIGINAL claim: the guard requires the current claim at `originalResourceEpoch + 1`. */
export interface BootstrapGuardClaim {
  readonly claimId: string;
  readonly originalResourceEpoch: number;
}

/**
 * The explicitly trusted, read-only host adapter. It returns the current full task record DATA, or
 * throws/returns a non-record on failure (treated conservatively as a block). It never returns an allow
 * decision, a token or a stop proof. In tests this is a fixture; a later real adapter binds and reads the
 * authoritative task domain. This slice does not authenticate or install it.
 */
export type TrustedRecordReader = () => unknown | Promise<unknown>;

export interface BootstrapGuardOptions {
  readonly taskId: string;
  readonly intentId: string;
  readonly handoffId: string;
  readonly generation: number;
  readonly subtaskId: string;
  readonly attempt: number;
  readonly inputRevision: string;
  readonly coordinatorEpoch: number;
  readonly successor: BootstrapGuardIdentity;
  readonly claims: readonly BootstrapGuardClaim[];
  readonly readRecord: TrustedRecordReader;
}

interface PinnedConfig {
  readonly taskId: string;
  readonly intentId: string;
  readonly handoffId: string;
  readonly generation: number;
  readonly subtaskId: string;
  readonly attempt: number;
  readonly inputRevision: string;
  readonly coordinatorEpoch: number;
  readonly successor: BootstrapGuardIdentity;
  readonly claims: readonly BootstrapGuardClaim[];
}

export interface BootstrapDecision {
  readonly allow: boolean;
  readonly reason: string;
}

export interface BootstrapGuardStatus {
  readonly schema: typeof PI_BOOTSTRAP_GUARD_STATUS_SCHEMA;
  readonly taskId: string;
  readonly intentId: string;
  readonly handoffId: string;
  readonly generation: number;
  readonly subtaskId: string;
  readonly attempt: number;
  readonly coordinatorEpoch: number;
  readonly successor: BootstrapGuardIdentity;
  readonly pinnedClaimCount: number;
  readonly mode: 'deny-until-completed-transfer';
  readonly vettedReadTools: readonly string[];
  readonly limitations: readonly string[];
}

export interface PiToolCallHandler {
  (
    event: PiToolCallEvent,
    context: unknown,
  ): Promise<PiToolBlockDecision | undefined>;
}

/** Narrow structural host: only a `tool_call` subscription is needed (no model-accessible command). */
export interface PiBootstrapGuardHost {
  on(event: 'tool_call', handler: PiToolCallHandler): void;
}

export interface PiBootstrapGuard {
  status(): BootstrapGuardStatus;
}

const LIMITATIONS: readonly string[] = Object.freeze([
  'managed_pi_tool_gate_not_a_filesystem_or_cross_process_write_fence',
  'record_from_an_explicitly_trusted_read_only_adapter_not_authenticated_by_this_slice',
  'answers_the_call_time_question_only_check_use_gap_background_effects_not_fenced',
  'not_a_transfer_action_stop_inference_authority_store_or_native_authorization',
  'no_model_accessible_allow_thaw_or_release_and_no_boolean_authorization_callback',
  'first_work_is_not_a_prerequisite_for_the_first_write_that_proof_comes_afterward',
  'cross_record_consistency_validated_not_schema_only_ambiguous_ids_fail_closed',
]);

function isSafeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function isSafeEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A claim epoch must leave room for a safe `+1` (original resource epoch raised at transfer). */
function isSafeRaisableEpoch(value: unknown): value is number {
  return isSafeEpoch(value) && value < Number.MAX_SAFE_INTEGER;
}

/** Return the single element, or null when there are zero or more than one (ambiguous). */
function exactlyOne<T>(items: readonly T[]): T | null {
  if (items.length !== 1) return null;
  const only = items[0];
  return only === undefined ? null : only;
}

/** Read the tool name defensively: a throwing/proxy accessor or a non-string yields null (fail-closed). */
function readToolName(event: unknown): string | null {
  try {
    if (typeof event !== 'object' || event === null) return null;
    const name = (event as { toolName?: unknown }).toolName;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/** Pinned API: the running session is `ctx.sessionManager.getSessionId()`. Any failure stays null. */
function readLiveSessionId(context: unknown): string | null {
  try {
    if (typeof context !== 'object' || context === null) return null;
    const manager = (context as { sessionManager?: unknown }).sessionManager;
    if (typeof manager !== 'object' || manager === null) return null;
    const getter = (manager as { getSessionId?: unknown }).getSessionId;
    if (typeof getter !== 'function') return null;
    const value = (getter as () => unknown).call(manager);
    return isSafeId(value) ? value : null;
  } catch {
    return null;
  }
}

function copyIdentity(
  identity: BootstrapGuardIdentity,
): BootstrapGuardIdentity {
  return Object.freeze({
    agentId: identity.agentId,
    sessionId: identity.sessionId,
    harness: identity.harness,
  });
}

/** Two record identities match on agent id, native session id and harness. */
function sameIdentity(
  a: Identity | null | undefined,
  b: Identity | null | undefined,
): boolean {
  return (
    a !== null &&
    a !== undefined &&
    b !== null &&
    b !== undefined &&
    a.agent_id === b.agent_id &&
    a.session_id === b.session_id &&
    a.harness === b.harness
  );
}

/** A record identity matches the pinned successor on agent id, native session id and harness. */
function matchesSuccessor(
  identity: Identity | null | undefined,
  successor: BootstrapGuardIdentity,
): boolean {
  return (
    identity !== null &&
    identity !== undefined &&
    identity.agent_id === successor.agentId &&
    identity.session_id === successor.sessionId &&
    identity.harness === successor.harness
  );
}

function block(reason: string): BootstrapDecision {
  return { allow: false, reason };
}

/**
 * Pure decision over the current record. Allows a non-read tool only when the validated record proves a
 * consistent completed WRITER transfer to the pinned successor. First-work is NOT required. Any traversal
 * or accessor failure fails closed.
 */
export function decideBootstrapWrite(
  record: unknown,
  pinned: PinnedConfig,
  liveSessionId: string | null,
): BootstrapDecision {
  try {
    if (liveSessionId === null || liveSessionId !== pinned.successor.sessionId)
      return block('native_session_unknown_or_mismatch');
    if (!isTaskRecord(record)) return block('record_invalid');
    const task: TaskRecord = record;
    if (task.task_id !== pinned.taskId) return block('task_mismatch');
    // Coordinator owner_epoch, never a per-claim resource epoch.
    if ((task.coordinator?.owner_epoch ?? null) !== pinned.coordinatorEpoch)
      return block('coordinator_epoch_drift');

    // Pinned rollover intent read directly from the record; a duplicate/ambiguous id fails closed.
    const intent = exactlyOne(
      (task.rollover ?? []).filter(
        (item) => item.intent_id === pinned.intentId,
      ),
    );
    if (intent === null) return block('ambiguous_or_missing_intent');
    if (
      intent.task_id !== pinned.taskId ||
      intent.handoff_id !== pinned.handoffId ||
      intent.generation !== pinned.generation ||
      intent.subtask_id !== pinned.subtaskId ||
      intent.attempt !== pinned.attempt ||
      intent.input_revision !== pinned.inputRevision ||
      intent.coordinator_epoch !== pinned.coordinatorEpoch ||
      !matchesSuccessor(intent.to, pinned.successor)
    )
      return block('intent_mismatch');

    // The claim set the transfer concerns: the intent originals (deduplicated + pinned-consistent later).
    const intentClaims = intent.claims ?? [];
    const intentIds = new Set(intentClaims.map((item) => item.claim_id));
    if (intentIds.size !== intentClaims.length)
      return block('intent_claims_duplicated');

    // Completed WRITER handoff, consistent with the pinned intent (not merely a completed id match).
    const handoff = exactlyOne(
      (task.handoffs ?? []).filter(
        (item) => item.handoff_id === pinned.handoffId,
      ),
    );
    if (handoff === null) return block('ambiguous_or_missing_handoff');
    if (handoff.state !== 'completed') return block('handoff_not_completed');
    if (handoff.kind !== 'writer') return block('handoff_not_writer');
    if (
      handoff.subtask_id !== pinned.subtaskId ||
      handoff.attempt !== pinned.attempt
    )
      return block('handoff_target_mismatch');
    if (handoff.owner_epoch !== pinned.coordinatorEpoch)
      return block('handoff_epoch_mismatch');
    if (!sameIdentity(handoff.from, intent.from))
      return block('handoff_from_mismatch');
    if (!matchesSuccessor(handoff.to, pinned.successor))
      return block('handoff_to_mismatch');

    // `beginHandoff` records the pre-transfer resources as claim ids and an ownership snapshot of the
    // original holder/epoch. Both must match the intent originals.
    const resourceIds = new Set(handoff.resources ?? []);
    if (resourceIds.size !== intentIds.size)
      return block('handoff_resources_mismatch');
    for (const id of intentIds)
      if (!resourceIds.has(id)) return block('handoff_resources_mismatch');
    const snapshot = handoff.ownership_snapshot ?? [];
    const snapIds = new Set(snapshot.map((item) => item.claim_id));
    if (snapIds.size !== snapshot.length)
      return block('ownership_snapshot_duplicated');
    if (snapIds.size !== intentIds.size)
      return block('ownership_snapshot_mismatch');
    for (const id of intentIds)
      if (!snapIds.has(id)) return block('ownership_snapshot_mismatch');

    // Transfer boundary must be bounded by the current record and history (a record cannot predate its
    // own completed transfer); keep safe-integer checks.
    const boundary = intent.transfer_boundary ?? null;
    if (boundary === null) return block('transfer_not_bounded');
    if (
      !Number.isSafeInteger(boundary.state_revision) ||
      !Number.isSafeInteger(boundary.message_count)
    )
      return block('transfer_boundary_unsafe');
    if (boundary.state_revision > task.state_revision)
      return block('transfer_boundary_state_revision_out_of_range');
    if (boundary.message_count > (task.messages ?? []).length)
      return block('transfer_boundary_message_count_out_of_range');

    // Successor native pinned at the transfer boundary must be the configured Pi successor.
    const successorNative = intent.successor_native ?? null;
    if (
      successorNative === null ||
      successorNative.agent_id !== pinned.successor.agentId ||
      successorNative.session_id !== pinned.successor.sessionId ||
      successorNative.runner !== pinned.successor.harness
    )
      return block('successor_native_mismatch');

    // Latest actionable attempt, owned by the successor via a completed transfer, with a full native bind.
    if (latestAttemptNumber(task, pinned.subtaskId) !== pinned.attempt)
      return block('attempt_superseded');
    const attempt = exactlyOne(
      (task.attempts ?? []).filter(
        (item) =>
          item.subtask_id === pinned.subtaskId &&
          item.attempt === pinned.attempt,
      ),
    );
    if (attempt === null) return block('ambiguous_or_missing_attempt');
    if (!matchesSuccessor(attempt.assignee, pinned.successor))
      return block('attempt_not_reassigned');
    if (attempt.input_revision !== pinned.inputRevision)
      return block('attempt_input_drift');
    if (!PERMITTED_WRITER_STATES.has(attempt.state))
      return block('attempt_not_actionable');
    if (typeof attempt.awaiting === 'string' && attempt.awaiting.length > 0)
      return block('attempt_blocked');
    if (attempt.ownership !== 'transferred')
      return block('ownership_not_transferred');
    if (attempt.native.observation !== 'confirmed')
      return block('native_binding_not_confirmed');
    if (attempt.native.session_id !== pinned.successor.sessionId)
      return block('native_session_binding_mismatch');
    if (
      attempt.native.runner !== successorNative.runner ||
      attempt.native.session_id !== successorNative.session_id ||
      attempt.native.run_id !== successorNative.run_id ||
      (attempt.native.mission_id ?? null) !==
        (successorNative.mission_id ?? null)
    )
      return block('native_binding_mismatch');
    if (attempt.native.runner !== pinned.successor.harness)
      return block('native_runner_mismatch');

    // Exact set equality: pinned claims == intent originals. Each original epoch matches the intent and the
    // ownership snapshot (original holder was the source), and each current record claim is active, held by
    // the successor, at original + 1. A duplicate/ambiguous claim id fails closed.
    const pinnedOriginals = new Map(
      pinned.claims.map((item) => [item.claimId, item.originalResourceEpoch]),
    );
    if (pinnedOriginals.size !== intentIds.size)
      return block('claim_set_mismatch');
    for (const id of intentIds)
      if (!pinnedOriginals.has(id)) return block('claim_set_mismatch');
    for (const intentClaim of intentClaims) {
      const pinnedOriginal = pinnedOriginals.get(intentClaim.claim_id);
      if (pinnedOriginal === undefined) return block('claim_set_mismatch');
      if (!isSafeRaisableEpoch(intentClaim.resource_epoch))
        return block('claim_epoch_unsafe');
      if (pinnedOriginal !== intentClaim.resource_epoch)
        return block('claim_original_epoch_mismatch');
      const snap =
        snapshot.find((item) => item.claim_id === intentClaim.claim_id) ?? null;
      if (snap === null) return block('ownership_snapshot_mismatch');
      if ((snap.resource_epoch ?? null) !== intentClaim.resource_epoch)
        return block('ownership_snapshot_epoch_mismatch');
      if (!sameIdentity(snap.holder ?? null, intent.from))
        return block('ownership_snapshot_holder_mismatch');
      const current = exactlyOne(
        (task.claims ?? []).filter(
          (item) => item.claim_id === intentClaim.claim_id,
        ),
      );
      if (current === null) return block('ambiguous_or_missing_claim');
      if (current.released_at !== null) return block('claim_released');
      if (!matchesSuccessor(current.holder, pinned.successor))
        return block('claim_not_held_by_successor');
      if (current.resource_epoch !== intentClaim.resource_epoch + 1)
        return block('claim_resource_epoch_not_raised');
    }

    // No other open handoff may overlap this attempt or any pinned claim id (resources are claim ids).
    for (const other of task.handoffs ?? []) {
      if (other.handoff_id === pinned.handoffId) continue;
      if (other.state === 'completed' || other.state === 'aborted') continue;
      if (
        other.subtask_id === pinned.subtaskId &&
        other.attempt === pinned.attempt
      )
        return block('conflicting_handoff');
      for (const snap of other.ownership_snapshot ?? [])
        if (intentIds.has(snap.claim_id)) return block('conflicting_handoff');
      for (const resource of other.resources ?? [])
        if (intentIds.has(resource)) return block('conflicting_handoff');
    }

    return { allow: true, reason: 'completed_transfer_to_successor' };
  } catch {
    // Any accessor/traversal/validation exception is a conservative block, never a raw rejection.
    return block('record_traversal_failed');
  }
}

class BootstrapGuard implements PiBootstrapGuard {
  readonly #pinned: PinnedConfig;
  readonly #readRecord: TrustedRecordReader;

  constructor(pinned: PinnedConfig, readRecord: TrustedRecordReader) {
    this.#pinned = pinned;
    this.#readRecord = readRecord;
  }

  async decide(
    event: PiToolCallEvent,
    context: unknown,
  ): Promise<PiToolBlockDecision | undefined> {
    try {
      const liveBefore = readLiveSessionId(context);
      // Unknown/malformed native identity blocks even vetted reads.
      if (
        liveBefore === null ||
        liveBefore !== this.#pinned.successor.sessionId
      )
        return deny('native_session_unknown_or_mismatch');
      const toolName = readToolName(event);
      if (toolName === null) return deny('malformed_tool_event');
      if (VETTED_NATIVE_READ_TOOLS.includes(toolName)) return undefined;

      // Non-read tool: read the current full record from the trusted adapter and revalidate every time.
      let record: unknown;
      try {
        record = await this.#readRecord();
      } catch {
        return deny('trusted_record_read_failed');
      }
      // Recheck the native session after the asynchronous read, before deciding.
      const liveAfter = readLiveSessionId(context);
      if (liveAfter === null || liveAfter !== this.#pinned.successor.sessionId)
        return deny('native_session_drift');

      const decision = decideBootstrapWrite(record, this.#pinned, liveAfter);
      return decision.allow ? undefined : deny(decision.reason);
    } catch {
      // No raw exception ever escapes into host default behavior.
      return deny('guard_internal_error');
    }
  }

  status(): BootstrapGuardStatus {
    const status: BootstrapGuardStatus = {
      schema: PI_BOOTSTRAP_GUARD_STATUS_SCHEMA,
      taskId: this.#pinned.taskId,
      intentId: this.#pinned.intentId,
      handoffId: this.#pinned.handoffId,
      generation: this.#pinned.generation,
      subtaskId: this.#pinned.subtaskId,
      attempt: this.#pinned.attempt,
      coordinatorEpoch: this.#pinned.coordinatorEpoch,
      successor: copyIdentity(this.#pinned.successor),
      pinnedClaimCount: this.#pinned.claims.length,
      mode: 'deny-until-completed-transfer',
      vettedReadTools: Object.freeze([...VETTED_NATIVE_READ_TOOLS]),
      limitations: LIMITATIONS,
    };
    return Object.freeze(status);
  }
}

function deny(reason: string): PiToolBlockDecision {
  return { block: true, reason: `bootstrap-guard: ${reason}` };
}

function validateIdentity(
  value: BootstrapGuardIdentity,
): BootstrapGuardIdentity {
  if (
    !isSafeId(value.agentId) ||
    !isSafeId(value.sessionId) ||
    !isSafeId(value.harness)
  )
    throw new RangeError('pi-bootstrap-guard: invalid successor identity');
  return copyIdentity(value);
}

/** Deep-copy and bound-check options so a later mutation of the caller object cannot change the config. */
function pinOptions(options: BootstrapGuardOptions): PinnedConfig {
  if (
    !isSafeId(options.taskId) ||
    !isSafeId(options.intentId) ||
    !isSafeId(options.handoffId) ||
    !isSafeId(options.subtaskId) ||
    !isSafeId(options.inputRevision)
  )
    throw new RangeError('pi-bootstrap-guard: invalid pinned identifiers');
  if (
    !isSafeEpoch(options.generation) ||
    !isSafeEpoch(options.attempt) ||
    !isSafeEpoch(options.coordinatorEpoch)
  )
    throw new RangeError(
      'pi-bootstrap-guard: invalid generation/attempt/epoch',
    );
  if (
    !Array.isArray(options.claims) ||
    options.claims.length === 0 ||
    options.claims.length > MAX_CLAIMS
  )
    throw new RangeError(
      'pi-bootstrap-guard: claims must be a non-empty bounded set',
    );
  const seen = new Set<string>();
  const claims: BootstrapGuardClaim[] = options.claims.map((claim) => {
    if (
      !isSafeId(claim.claimId) ||
      !isSafeRaisableEpoch(claim.originalResourceEpoch)
    )
      throw new RangeError('pi-bootstrap-guard: invalid claim reference');
    if (seen.has(claim.claimId))
      throw new RangeError('pi-bootstrap-guard: duplicate pinned claim id');
    seen.add(claim.claimId);
    return Object.freeze({
      claimId: claim.claimId,
      originalResourceEpoch: claim.originalResourceEpoch,
    });
  });
  return Object.freeze({
    taskId: options.taskId,
    intentId: options.intentId,
    handoffId: options.handoffId,
    generation: options.generation,
    subtaskId: options.subtaskId,
    attempt: options.attempt,
    inputRevision: options.inputRevision,
    coordinatorEpoch: options.coordinatorEpoch,
    successor: validateIdentity(options.successor),
    claims: Object.freeze(claims),
  });
}

/**
 * Register the opt-in successor bootstrap gate on `pi`. It only subscribes `tool_call`; it registers no
 * model-accessible command, removes no tools/MCP/skills/hooks, and mutates nothing. The returned handle
 * exposes a conservative frozen status only — no allow/thaw/release.
 */
export function registerPiBootstrapGuard(
  pi: PiBootstrapGuardHost,
  options: BootstrapGuardOptions,
): PiBootstrapGuard {
  if (typeof options.readRecord !== 'function')
    throw new RangeError(
      'pi-bootstrap-guard: a trusted readRecord adapter is required',
    );
  const pinned = pinOptions(options);
  const guard = new BootstrapGuard(pinned, options.readRecord);
  pi.on('tool_call', (event, context) => guard.decide(event, context));
  return guard;
}
