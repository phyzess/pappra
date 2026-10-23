import { createHash } from 'node:crypto';
import type { Identity, Message, TaskRecord } from './types.js';
import { canonicalJson, contentDigest, validateEnvelope } from './envelope.js';
import {
  beginHandoff,
  completeHandoff,
  confirmReceiver,
  findHandoff,
  markOldWriterStopped,
  markTransferring,
} from './handoff.js';
import { bindNative, findAttempt } from './lifecycle.js';
import { nowIso } from './store.js';
import { isTaskRecord, text } from './validation.js';

/**
 * Bounded, record-level writer rollover correlation.
 *
 * This module only reduces the existing task record: handoff state and claims stay
 * authoritative, and no second authority store, filesystem access, native control or
 * continuity import is introduced. An intent pins the immutable inputs of one
 * writer-to-writer transfer, including the confirmed source native identity; confirmation
 * and first-work evidence must be stored, digest-verified protocol messages correlated to
 * that intent. A caller-supplied object is never treated as authenticated native proof.
 */

export const ROLLOVER_INTENT_SCHEMA = 'pappra/collab-rollover-intent/1';
export const ROLLOVER_SUCCESSION_SCHEMA = 'pappra/collab-succession/1';

const MAX_INTENTS = 32;
const MAX_SUCCESSIONS = 32;
const MAX_CLAIMS = 64;
const MAX_INVENTORY_ITEMS = 64;
const MAX_INVENTORY_BYTES = 16 * 1024;
const MAX_STRING = 2048;
const MAX_ID = 256;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const ACTIVE_ATTEMPT_STATES = new Set([
  'assigned',
  'accepted',
  'running',
  'unknown',
]);
const CLOSED_HANDOFF_STATES = new Set(['completed', 'aborted']);
const PAST_PREPARE_STATES = new Set([
  'transferring',
  'receiver_confirmed',
  'completed',
]);

export interface RolloverClaimReference {
  readonly claim_id: string;
  readonly resource_epoch: number;
}

export interface RolloverBundleReference {
  readonly ref: string;
  readonly digest: string;
}

/** The native session identity of one writer; never inferred from another pointer. */
export interface RolloverNativeIdentity {
  readonly agent_id: string | null;
  readonly runner: string | null;
  readonly session_id: string | null;
  readonly run_id: string | null;
  readonly mission_id: string | null;
}

export interface RolloverNativeBindingInput extends RolloverNativeIdentity {
  readonly evidence_ref: string;
  readonly observed_at?: string | null;
}

export interface RolloverTransferBoundary {
  /** Message-application position at completion; never a sender timestamp. */
  readonly message_count: number;
  readonly state_revision: number;
  readonly at: string;
}

/** Explicit quiescence inventory. Unknown or partial completeness never authorizes transfer. */
export interface RolloverInventory {
  readonly completeness: 'complete' | 'partial' | 'unknown';
  readonly inflight: readonly unknown[];
  readonly pending_approvals: readonly unknown[];
  /** Required: absent message completeness can never be treated as "none". */
  readonly pending_messages?: readonly unknown[];
  /** Captured partial outputs; part of the pinned inventory identity. */
  readonly partial_outputs?: readonly unknown[];
}

export interface CreateRolloverIntentInput {
  readonly intent_id: string;
  readonly generation: number;
  readonly handoff_id: string;
  readonly subtask_id: string;
  readonly attempt: number;
  readonly input_revision: string;
  readonly from: Identity;
  readonly to: Identity;
  readonly claims: readonly RolloverClaimReference[];
  readonly bundle: RolloverBundleReference;
  readonly coordinator_epoch: number;
  readonly clock?: number;
}

export interface RolloverFailure {
  readonly ok: false;
  readonly reason: string;
  readonly [key: string]: unknown;
}

const failure = (
  reason: string,
  detail: Record<string, unknown> = {},
): RolloverFailure => ({ ok: false, reason, ...detail });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeString = (value: unknown, max = MAX_STRING): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !value.includes('\u0000');

const isOptionalString = (value: unknown, max: number): boolean =>
  value === undefined || value === null || isSafeString(value, max);

const isCount = (value: unknown, minimum = 0): value is number =>
  Number.isSafeInteger(value) && (value as number) >= minimum;

const isIdentity = (value: unknown): value is Identity =>
  isObject(value) &&
  isSafeString(value['agent_id'], MAX_ID) &&
  isSafeString(value['session_id'], MAX_ID);

const sameIdentity = (left: Identity, right: Identity): boolean =>
  left.agent_id === right.agent_id && left.session_id === right.session_id;

const copyIdentity = (value: Identity): Identity => ({
  agent_id: value.agent_id,
  session_id: value.session_id,
  harness: value.harness ?? null,
  ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
});

const copyNative = (value: RolloverNativeIdentity): RolloverNativeIdentity => ({
  agent_id: value.agent_id,
  runner: value.runner,
  session_id: value.session_id,
  run_id: value.run_id,
  mission_id: value.mission_id,
});

const sameNative = (
  left: RolloverNativeIdentity,
  right: RolloverNativeIdentity,
): boolean =>
  left.agent_id === right.agent_id &&
  left.runner === right.runner &&
  left.session_id === right.session_id &&
  left.run_id === right.run_id &&
  left.mission_id === right.mission_id;

const sameClaimSet = (
  left: readonly RolloverClaimReference[],
  right: readonly RolloverClaimReference[],
): boolean =>
  left.length === right.length &&
  left.every((claim) =>
    right.some(
      (other) =>
        other.claim_id === claim.claim_id &&
        other.resource_epoch === claim.resource_epoch,
    ),
  );

const sameBundle = (
  left: RolloverBundleReference,
  right: RolloverBundleReference,
): boolean => left.ref === right.ref && left.digest === right.digest;

/** Exact bounded inventory fingerprint; counts alone are not an identity. */
function inventoryFingerprint(
  inventory: unknown,
): { readonly ok: true; readonly digest: string } | RolloverFailure {
  if (!isObject(inventory)) return failure('inventory_required');
  const inflight = inventory['inflight'];
  const approvals = inventory['pending_approvals'];
  const messages = inventory['pending_messages'];
  const partial = inventory['partial_outputs'] ?? [];
  if (
    inventory['completeness'] !== 'complete' ||
    !Array.isArray(inflight) ||
    !Array.isArray(approvals) ||
    !Array.isArray(messages) ||
    !Array.isArray(partial)
  )
    return failure('inventory_incomplete', {
      completeness: inventory['completeness'] ?? null,
    });
  for (const list of [inflight, approvals, messages, partial]) {
    if (list.length > MAX_INVENTORY_ITEMS)
      return failure('inventory_too_large', { limit: MAX_INVENTORY_ITEMS });
  }
  let serialized: string;
  try {
    serialized = canonicalJson({
      completeness: 'complete',
      inflight,
      pending_approvals: approvals,
      pending_messages: messages,
      partial_outputs: partial,
    });
  } catch {
    return failure('inventory_invalid');
  }
  if (serialized.length > MAX_INVENTORY_BYTES)
    return failure('inventory_too_large', { limitBytes: MAX_INVENTORY_BYTES });
  return {
    ok: true,
    digest: `sha256:${createHash('sha256').update(serialized).digest('hex')}`,
  };
}

/**
 * Bounded record validation for every public entry point. The authoritative `isTaskRecord`
 * predicate validates nested native/claim/handoff/message/result/rollover shapes; this adds
 * only the bounded collection counts. Malformed or oversized data is refused, never thrown.
 */
function recordFailure(record: unknown): RolloverFailure | null {
  if (!isTaskRecord(record)) return failure('record_invalid');
  if ((record.rollover ?? []).length > MAX_INTENTS)
    return failure('record_too_large', {
      field: 'rollover',
      limit: MAX_INTENTS,
    });
  if ((record.successions ?? []).length > MAX_SUCCESSIONS)
    return failure('record_too_large', {
      field: 'successions',
      limit: MAX_SUCCESSIONS,
    });
  return null;
}

/** Deterministic immutable-input comparison; no serialization order is trusted. */
function sameIntentInput(
  intent: {
    task_id: string;
    handoff_id: string;
    subtask_id: string;
    attempt: number;
    input_revision: string;
    coordinator_epoch: number;
    from: Identity;
    to: Identity;
    claims: readonly RolloverClaimReference[];
    bundle: RolloverBundleReference;
    generation: number;
  },
  input: CreateRolloverIntentInput,
  taskId: string,
): boolean {
  return (
    intent.task_id === taskId &&
    intent.handoff_id === input.handoff_id &&
    intent.subtask_id === input.subtask_id &&
    intent.attempt === input.attempt &&
    intent.input_revision === input.input_revision &&
    intent.coordinator_epoch === input.coordinator_epoch &&
    intent.generation === input.generation &&
    sameIdentity(intent.from, input.from) &&
    sameIdentity(intent.to, input.to) &&
    sameClaimSet(intent.claims, input.claims) &&
    sameBundle(intent.bundle, input.bundle)
  );
}

function validateInput(
  input: CreateRolloverIntentInput,
): RolloverFailure | null {
  if (!isObject(input)) return failure('intent_invalid');
  if (!isSafeString(input.intent_id, MAX_ID))
    return failure('intent_id_invalid');
  if (!isSafeString(input.handoff_id, MAX_ID))
    return failure('handoff_id_invalid');
  if (!isSafeString(input.subtask_id, MAX_ID))
    return failure('subtask_id_invalid');
  if (!isSafeString(input.input_revision, MAX_STRING))
    return failure('input_revision_invalid');
  if (!isCount(input.generation, 1) || input.generation > 1000)
    return failure('generation_invalid');
  if (!isCount(input.attempt, 1) || input.attempt > 1000)
    return failure('attempt_invalid');
  if (!isCount(input.coordinator_epoch, 1))
    return failure('coordinator_epoch_invalid');
  if (!isIdentity(input.from) || !isIdentity(input.to))
    return failure('identity_invalid');
  if (sameIdentity(input.from, input.to))
    return failure('successor_matches_source');
  if (!Array.isArray(input.claims) || input.claims.length === 0)
    return failure('claims_required');
  if (input.claims.length > MAX_CLAIMS) return failure('claims_too_large');
  const ids = new Set<string>();
  for (const claim of input.claims) {
    if (!isObject(claim) || !isSafeString(claim.claim_id, MAX_ID))
      return failure('claim_reference_invalid');
    if (!isCount(claim.resource_epoch)) return failure('claim_epoch_invalid');
    if (ids.has(claim.claim_id))
      return failure('claim_reference_duplicate', { claim_id: claim.claim_id });
    ids.add(claim.claim_id);
  }
  if (
    !isObject(input.bundle) ||
    !isSafeString(input.bundle.ref) ||
    typeof input.bundle.digest !== 'string' ||
    !DIGEST.test(input.bundle.digest)
  )
    return failure('bundle_reference_invalid');
  return null;
}

function intentList(record: TaskRecord) {
  return record.rollover ?? [];
}

function findIntent(record: TaskRecord, intentId: string) {
  return intentList(record).find((item) => item.intent_id === intentId) ?? null;
}

function findSuccession(
  record: TaskRecord,
  handoffId: string,
  generation: number,
) {
  return (
    (record.successions ?? []).find(
      (item) => item.handoff_id === handoffId && item.generation === generation,
    ) ?? null
  );
}

function latestAttemptOf(record: TaskRecord, subtaskId: string): number | null {
  let latest: number | null = null;
  for (const attempt of record.attempts ?? []) {
    if (attempt.subtask_id !== subtaskId) continue;
    latest =
      latest === null ? attempt.attempt : Math.max(latest, attempt.attempt);
  }
  return latest;
}

/**
 * A stored ACK/REPORT envelope is evidence only when the record holds a matching applied
 * entry with the same content digest. The caller's object is never trusted on its own.
 */
function storedEnvelope(
  record: TaskRecord,
  raw: unknown,
  expectedType: 'ACK' | 'REPORT',
):
  | {
      readonly ok: true;
      readonly message: Message;
      readonly entry: NonNullable<TaskRecord['messages']>[number];
      readonly index: number;
    }
  | RolloverFailure {
  let message: Message;
  try {
    message = validateEnvelope(raw);
  } catch {
    return failure(expectedType === 'ACK' ? 'ack_invalid' : 'report_invalid');
  }
  if (message.type !== expectedType)
    return failure(
      expectedType === 'ACK' ? 'ack_type_invalid' : 'report_type_invalid',
    );
  const entries = record.messages ?? [];
  const index = entries.findIndex(
    (item) => item.message_id === message.message_id,
  );
  if (index < 0)
    return failure(
      expectedType === 'ACK' ? 'ack_not_registered' : 'report_not_registered',
    );
  const entry = entries[index]!;
  if (entry.state !== 'applied')
    return failure(
      expectedType === 'ACK' ? 'ack_not_applied' : 'report_not_applied',
    );
  if (entry.content_digest !== contentDigest(message))
    return failure(
      expectedType === 'ACK'
        ? 'ack_content_mismatch'
        : 'report_content_mismatch',
    );
  if (message.task_id !== record.task_id)
    return failure(
      expectedType === 'ACK' ? 'ack_task_mismatch' : 'report_task_mismatch',
    );
  return { ok: true, message, entry, index };
}

/**
 * Commits a reducer result only when the resulting record is persistable under the real
 * record validator; otherwise the original record is left byte-identical.
 */
function commit(record: TaskRecord, next: TaskRecord): RolloverFailure | null {
  if (!isTaskRecord(next))
    return failure('record_invalid', { detail: 'mutation would not persist' });
  Object.assign(record, next);
  return null;
}

/** Current source and ownership facts that every pre-transfer step re-validates. */
function currentStateDrift(
  record: TaskRecord,
  intent: NonNullable<ReturnType<typeof findIntent>>,
  expectedHandoffState: string,
): RolloverFailure | null {
  const coordinator = record.coordinator ?? null;
  if (coordinator === null) return failure('coordinator_required');
  if (coordinator.owner_epoch !== intent.coordinator_epoch)
    return failure('stale_epoch', {
      expected: intent.coordinator_epoch,
      actual: coordinator.owner_epoch,
    });
  const attempt = findAttempt(record, intent.subtask_id, intent.attempt);
  if (attempt === null) return failure('unknown_attempt');
  if (latestAttemptOf(record, intent.subtask_id) !== intent.attempt)
    return failure('attempt_superseded', {
      attempt: intent.attempt,
      latest: latestAttemptOf(record, intent.subtask_id),
    });
  if (!ACTIVE_ATTEMPT_STATES.has(attempt.state))
    return failure('attempt_not_active', { state: attempt.state });
  if (attempt.awaiting !== undefined)
    return failure('writer_blocked', { awaiting: attempt.awaiting });
  if (!sameIdentity(attempt.assignee, intent.from))
    return failure('assignee_mismatch', {
      expected: intent.from,
      actual: attempt.assignee ?? null,
    });
  if (attempt.input_revision !== intent.input_revision)
    return failure('input_changed', {
      expected: intent.input_revision,
      actual: attempt.input_revision ?? null,
    });
  // A changed or unknown source native identity invalidates previously recorded stop
  // evidence; resources are never moved on stale proof.
  const native = attempt.native ?? null;
  if (native === null || native.observation !== 'confirmed')
    return failure('source_native_unconfirmed', {
      observation: native?.observation ?? null,
    });
  const currentNative: RolloverNativeIdentity = {
    agent_id: intent.from.agent_id,
    runner: native.runner ?? null,
    session_id: native.session_id ?? null,
    run_id: native.run_id ?? null,
    mission_id: native.mission_id ?? null,
  };
  if (!sameNative(currentNative, intent.source_native))
    return failure('source_native_drift', {
      expected: intent.source_native,
      actual: currentNative,
    });
  for (const reference of intent.claims) {
    const claim = (record.claims ?? []).find(
      (item) => item.claim_id === reference.claim_id,
    );
    if (claim === undefined)
      return failure('claim_unavailable', { claim_id: reference.claim_id });
    if (claim.released_at)
      return failure('claim_released', { claim_id: reference.claim_id });
    if (claim.holder === null || claim.holder === undefined)
      return failure('claim_holder_missing', { claim_id: reference.claim_id });
    if (!sameIdentity(claim.holder, intent.from))
      return failure('claim_holder_mismatch', {
        claim_id: reference.claim_id,
        holder: claim.holder,
      });
    if ((claim.resource_epoch ?? 0) !== reference.resource_epoch)
      return failure('claim_epoch_mismatch', {
        claim_id: reference.claim_id,
        expected: reference.resource_epoch,
        actual: claim.resource_epoch ?? null,
      });
  }
  const handoff = findHandoff(record, intent.handoff_id);
  if (handoff === null) return failure('unknown_handoff');
  if (handoff.state !== expectedHandoffState)
    return failure('handoff_not_ready', { state: handoff.state });
  if (
    !sameIdentity(handoff.from, intent.from) ||
    !sameIdentity(handoff.to, intent.to) ||
    handoff.owner_epoch !== intent.coordinator_epoch
  )
    return failure('handoff_mismatch', {
      from: handoff.from ?? null,
      to: handoff.to ?? null,
      owner_epoch: handoff.owner_epoch,
    });
  return null;
}

/**
 * Records the immutable intent and opens the underlying writer handoff. An exact replay of
 * the same intent inputs returns the existing intent without another mutation.
 */
export function createRolloverIntent(
  record: TaskRecord,
  input: CreateRolloverIntentInput,
) {
  const invalidRecord = recordFailure(record);
  if (invalidRecord !== null) return invalidRecord;
  const invalid = validateInput(input);
  if (invalid !== null) return invalid;
  const clock = input.clock ?? Date.now();
  const from = copyIdentity(input.from);
  const to = copyIdentity(input.to);
  const claims = input.claims.map((claim) => ({
    claim_id: claim.claim_id,
    resource_epoch: claim.resource_epoch,
  }));
  const bundle = { ref: input.bundle.ref, digest: input.bundle.digest };

  const existing = findIntent(record, input.intent_id);
  if (existing !== null) {
    if (
      !sameIntentInput(
        existing,
        { ...input, from, to, claims, bundle },
        record.task_id,
      )
    )
      return failure('intent_input_conflict', {
        intent_id: existing.intent_id,
      });
    return {
      ok: true as const,
      intent: existing,
      handoff_state: findHandoff(record, existing.handoff_id)?.state ?? null,
      replayed: true,
    };
  }

  if (intentList(record).length >= MAX_INTENTS)
    return failure('rollover_limit', { limit: MAX_INTENTS });

  const targetHandoff = findHandoff(record, input.handoff_id);
  if (targetHandoff !== null && CLOSED_HANDOFF_STATES.has(targetHandoff.state))
    return failure('handoff_closed', { state: targetHandoff.state });

  for (const other of intentList(record)) {
    const handoff = findHandoff(record, other.handoff_id);
    const closed = handoff === null || CLOSED_HANDOFF_STATES.has(handoff.state);
    if (closed) continue;
    const sameAttempt =
      other.subtask_id === input.subtask_id && other.attempt === input.attempt;
    const sharedClaim = other.claims.some((claim) =>
      claims.some((candidate) => candidate.claim_id === claim.claim_id),
    );
    if (sameAttempt || sharedClaim)
      return failure('intent_conflict', {
        other_intent: other.intent_id,
        other_handoff: other.handoff_id,
      });
  }

  const next: TaskRecord = structuredClone(record);
  const coordinator = next.coordinator ?? null;
  if (coordinator === null) return failure('coordinator_required');
  if (coordinator.owner_epoch !== input.coordinator_epoch)
    return failure('stale_epoch', {
      expected: coordinator.owner_epoch,
      actual: input.coordinator_epoch,
    });
  const attempt = findAttempt(next, input.subtask_id, input.attempt);
  if (attempt === null) return failure('unknown_attempt');
  if (latestAttemptOf(next, input.subtask_id) !== input.attempt)
    return failure('attempt_superseded', {
      attempt: input.attempt,
      latest: latestAttemptOf(next, input.subtask_id),
    });
  if (!ACTIVE_ATTEMPT_STATES.has(attempt.state))
    return failure('attempt_not_active', { state: attempt.state });
  if (attempt.awaiting !== undefined)
    return failure('writer_blocked', { awaiting: attempt.awaiting });
  if (!sameIdentity(attempt.assignee, from))
    return failure('assignee_mismatch', {
      expected: from,
      actual: attempt.assignee ?? null,
    });
  if (attempt.input_revision !== input.input_revision)
    return failure('input_changed', {
      expected: attempt.input_revision ?? null,
      actual: input.input_revision,
    });

  // The source native identity must be confirmed and must belong to the source session.
  const sourceNative = attempt.native ?? null;
  if (sourceNative === null || sourceNative.observation !== 'confirmed')
    return failure('source_native_unconfirmed', {
      observation: sourceNative?.observation ?? null,
    });
  if (
    !isSafeString(sourceNative.session_id, MAX_ID) ||
    sourceNative.session_id !== from.session_id
  )
    return failure('source_native_mismatch', {
      expected: from.session_id,
      actual: sourceNative.session_id ?? null,
    });
  if (!isSafeString(sourceNative.runner, MAX_ID))
    return failure('source_native_unconfirmed', { detail: 'runner missing' });

  for (const reference of claims) {
    const claim = (next.claims ?? []).find(
      (item) => item.claim_id === reference.claim_id,
    );
    if (claim === undefined || claim.released_at)
      return failure('claim_unavailable', { claim_id: reference.claim_id });
    if (claim.holder === null || claim.holder === undefined)
      return failure('claim_holder_missing', { claim_id: reference.claim_id });
    if (!sameIdentity(claim.holder, from))
      return failure('claim_holder_mismatch', {
        claim_id: reference.claim_id,
        holder: claim.holder,
      });
    if ((claim.resource_epoch ?? 0) !== reference.resource_epoch)
      return failure('claim_epoch_mismatch', {
        claim_id: reference.claim_id,
        expected: reference.resource_epoch,
        actual: claim.resource_epoch ?? null,
      });
  }

  const begun = beginHandoff(next, {
    handoffId: input.handoff_id,
    kind: 'writer',
    subtaskId: input.subtask_id,
    attempt: input.attempt,
    from,
    to,
    resources: claims.map((claim) => claim.claim_id),
    ownerEpoch: input.coordinator_epoch,
    clock,
    reason: `rollover intent ${input.intent_id} generation ${input.generation}`,
  });
  if (!begun.ok) return begun;

  const intent = {
    schema: ROLLOVER_INTENT_SCHEMA,
    intent_id: input.intent_id,
    generation: input.generation,
    task_id: next.task_id,
    handoff_id: input.handoff_id,
    subtask_id: input.subtask_id,
    attempt: input.attempt,
    input_revision: input.input_revision,
    coordinator_epoch: input.coordinator_epoch,
    from,
    to,
    claims,
    bundle,
    created_at: nowIso(clock),
    source_native: {
      agent_id: from.agent_id,
      runner: sourceNative.runner,
      session_id: sourceNative.session_id,
      run_id: sourceNative.run_id ?? null,
      mission_id: sourceNative.mission_id ?? null,
    },
    prepared: null,
    transfer_boundary: null,
    successor_native: null,
  };
  next.rollover = [...intentList(next), intent];
  const committed = commit(record, next);
  if (committed !== null) return committed;
  return {
    ok: true as const,
    intent,
    handoff_state: 'requested',
    replayed: false,
  };
}

/** Read-only projection of one intent, its handoff progress and any recorded succession. */
export function inspectRolloverIntent(record: TaskRecord, intentId: string) {
  const invalidRecord = recordFailure(record);
  if (invalidRecord !== null) return invalidRecord;
  const intent = findIntent(record, intentId);
  if (intent === null)
    return failure('unknown_intent', { intent_id: intentId });
  const handoff = findHandoff(record, intent.handoff_id);
  const attempt = findAttempt(record, intent.subtask_id, intent.attempt);
  const succession = findSuccession(
    record,
    intent.handoff_id,
    intent.generation,
  );
  return {
    ok: true as const,
    intent,
    handoff_state: handoff?.state ?? null,
    ownership: attempt?.ownership ?? null,
    assignee: attempt?.assignee ?? null,
    claims: intent.claims.map((reference) => {
      const claim = (record.claims ?? []).find(
        (item) => item.claim_id === reference.claim_id,
      );
      return {
        claim_id: reference.claim_id,
        expected_resource_epoch: reference.resource_epoch,
        holder: claim?.holder ?? null,
        resource_epoch: claim?.resource_epoch ?? null,
        released_at: claim?.released_at ?? null,
      };
    }),
    transfer_boundary: intent.transfer_boundary ?? null,
    succession,
    // Routing integration lives outside this record slice and stays explicitly pending.
    routing: succession === null ? 'not_started' : 'pending',
    native_archive: 'unavailable',
  };
}

/**
 * Records confirmed quiescence and freezes the transfer inventory. An absent or non-complete
 * inventory, unknown stop evidence, a blocked writer and any drift are refused without
 * mutation; an exact replay of a completed step is a no-op.
 */
export function prepareRolloverTransfer(
  record: TaskRecord,
  {
    intent_id,
    observation,
    evidence_ref,
    inventory,
    actor,
    clock = Date.now(),
  }: {
    intent_id: string;
    observation: string;
    evidence_ref: string | null;
    inventory: RolloverInventory;
    actor?: string;
    clock?: number;
  },
) {
  const invalidRecord = recordFailure(record);
  if (invalidRecord !== null) return invalidRecord;
  const intent = findIntent(record, intent_id);
  if (intent === null) return failure('unknown_intent', { intent_id });
  const handoff = findHandoff(record, intent.handoff_id);
  if (handoff === null) return failure('unknown_handoff');

  const fingerprint = inventoryFingerprint(inventory);
  if (!('ok' in fingerprint) || fingerprint.ok !== true) return fingerprint;
  const inventoryValue = inventory as RolloverInventory;
  const pendingMessages = (inventoryValue.pending_messages ??
    []) as readonly unknown[];
  if (
    inventoryValue.inflight.length > 0 ||
    inventoryValue.pending_approvals.length > 0 ||
    pendingMessages.length > 0
  )
    return failure('incomplete_inventory', {
      inflight: inventoryValue.inflight.length,
      pending_approvals: inventoryValue.pending_approvals.length,
      pending_messages: pendingMessages.length,
    });
  const digest = fingerprint.digest;
  if (PAST_PREPARE_STATES.has(handoff.state)) {
    const prepared = intent.prepared ?? null;
    if (
      prepared !== null &&
      prepared.evidence_ref === evidence_ref &&
      prepared.inventory === digest
    )
      return {
        ok: true as const,
        handoff_state: handoff.state,
        replayed: true,
      };
    return failure('prepare_conflict', { state: handoff.state });
  }
  if (handoff.state !== 'requested')
    return failure('handoff_not_ready', { state: handoff.state });
  if (observation !== 'confirmed')
    return failure('old_writer_not_stopped', { observation });
  if (!text(evidence_ref)) return failure('stop_evidence_required');

  const drift = currentStateDrift(record, intent, 'requested');
  if (drift !== null) return drift;

  const next: TaskRecord = structuredClone(record);
  const stopped = markOldWriterStopped(next, {
    handoffId: intent.handoff_id,
    observation,
    evidenceRef: evidence_ref,
    actor: actor ?? intent.from.agent_id,
    clock,
  });
  if (!stopped.ok) return stopped;
  const transferring = markTransferring(next, {
    handoffId: intent.handoff_id,
    partialOutputs: [...(inventoryValue.partial_outputs ?? [])],
    inflight: [],
    pendingApprovals: [],
    actor: actor ?? intent.from.agent_id,
    clock,
  });
  if (!transferring.ok) return transferring;
  next.rollover = intentList(next).map((item) =>
    item.intent_id === intent.intent_id
      ? {
          ...item,
          prepared: { evidence_ref, inventory: digest, at: nowIso(clock) },
        }
      : item,
  );
  const committed = commit(record, next);
  if (committed !== null) return committed;
  return { ok: true as const, handoff_state: 'transferring', replayed: false };
}

/**
 * Confirms the successor only from a stored, digest-verified ACK envelope that carries the
 * pinned input revision, the current coordinator epoch and recipient, the intent/handoff/
 * generation correlation and this attempt's registered assignment as its bootstrap.
 */
export function confirmRolloverReceiver(
  record: TaskRecord,
  {
    intent_id,
    message,
    clock = Date.now(),
  }: { intent_id: string; message: unknown; clock?: number },
) {
  const invalidRecord = recordFailure(record);
  if (invalidRecord !== null) return invalidRecord;
  const intent = findIntent(record, intent_id);
  if (intent === null) return failure('unknown_intent', { intent_id });
  const handoff = findHandoff(record, intent.handoff_id);
  if (handoff === null) return failure('unknown_handoff');

  const stored = storedEnvelope(record, message, 'ACK');
  if (!('ok' in stored) || stored.ok !== true) return stored;
  const { message: ack, entry } = stored;

  if (handoff.state === 'receiver_confirmed' || handoff.state === 'completed') {
    if (handoff.confirmation_message_id === ack.message_id)
      return {
        ok: true as const,
        handoff_state: handoff.state,
        replayed: true,
      };
    return failure('confirmation_conflict', {
      state: handoff.state,
      confirmation_message_id: handoff.confirmation_message_id ?? null,
    });
  }
  if (handoff.state !== 'transferring')
    return failure('handoff_not_ready', { state: handoff.state });

  if (
    !sameIdentity(ack.from, intent.to) ||
    !sameIdentity(entry.from, intent.to)
  )
    return failure('ack_identity_mismatch', {
      expected: intent.to,
      actual: ack.from,
    });
  const coordinator = record.coordinator ?? null;
  if (coordinator === null) return failure('coordinator_required');
  if (
    !sameIdentity(ack.to, coordinator) ||
    (entry.to !== null && !sameIdentity(entry.to, coordinator))
  )
    return failure('ack_recipient_mismatch', {
      expected: coordinator,
      actual: ack.to ?? null,
    });
  if (ack.owner_epoch !== coordinator.owner_epoch)
    return failure('stale_epoch', {
      expected: coordinator.owner_epoch,
      actual: ack.owner_epoch ?? null,
    });
  if (ack.subtask_id !== intent.subtask_id || ack.attempt !== intent.attempt)
    return failure('ack_correlation_mismatch', {
      subtask_id: ack.subtask_id,
      attempt: ack.attempt,
    });
  if (ack.body?.handoff_id !== intent.handoff_id)
    return failure('ack_correlation_mismatch', {
      handoff_id: ack.body?.handoff_id ?? null,
    });
  if (ack.body?.rollover_intent_id !== intent.intent_id)
    return failure('ack_correlation_mismatch', {
      intent_id: ack.body?.rollover_intent_id ?? null,
    });
  if (ack.body?.rollover_generation !== intent.generation)
    return failure('ack_correlation_mismatch', {
      generation: ack.body?.rollover_generation ?? null,
    });
  if (ack.body?.input_revision !== intent.input_revision)
    return failure('ack_input_mismatch', {
      expected: intent.input_revision,
      actual: ack.body?.input_revision ?? null,
    });
  const attempt = findAttempt(record, intent.subtask_id, intent.attempt);
  if (attempt === null) return failure('unknown_attempt');
  if (ack.reply_to !== attempt.assignment_message_id)
    return failure('ack_bootstrap_mismatch', {
      expected: attempt.assignment_message_id,
      actual: ack.reply_to ?? null,
    });

  // A prior ACK cannot survive any current source, ownership or claim drift.
  const drift = currentStateDrift(record, intent, 'transferring');
  if (drift !== null) return drift;

  const next: TaskRecord = structuredClone(record);
  const confirmed = confirmReceiver(next, {
    handoffId: intent.handoff_id,
    message: ack,
    clock,
  });
  if (!confirmed.ok) return confirmed;
  const committed = commit(record, next);
  if (committed !== null) return committed;
  return {
    ok: true as const,
    handoff_state: 'receiver_confirmed',
    replayed: false,
  };
}

/**
 * Completes the writer transfer: claims move to the successor with a raised resource epoch,
 * the attempt is reassigned and its native identity is rebound explicitly. The coordinator
 * owner epoch is never raised here.
 */
export function completeRolloverTransfer(
  record: TaskRecord,
  {
    intent_id,
    successor_native,
    actor,
    clock = Date.now(),
  }: {
    intent_id: string;
    successor_native: RolloverNativeBindingInput;
    actor?: string;
    clock?: number;
  },
) {
  const invalidRecord = recordFailure(record);
  if (invalidRecord !== null) return invalidRecord;
  const intent = findIntent(record, intent_id);
  if (intent === null) return failure('unknown_intent', { intent_id });
  const handoff = findHandoff(record, intent.handoff_id);
  if (handoff === null) return failure('unknown_handoff');

  if (
    !isObject(successor_native) ||
    !isSafeString(successor_native.session_id, MAX_ID) ||
    !isSafeString(successor_native.agent_id, MAX_ID) ||
    !isSafeString(successor_native.runner, MAX_ID) ||
    !text(successor_native.evidence_ref) ||
    !isOptionalString(successor_native.run_id, MAX_ID) ||
    !isOptionalString(successor_native.mission_id, MAX_ID) ||
    !isOptionalString(successor_native.observed_at, 64)
  )
    return failure('successor_native_invalid');
  if (successor_native.agent_id !== intent.to.agent_id)
    return failure('successor_native_mismatch', {
      field: 'agent_id',
      expected: intent.to.agent_id,
      actual: successor_native.agent_id,
    });
  if (successor_native.session_id !== intent.to.session_id)
    return failure('successor_native_mismatch', {
      field: 'session_id',
      expected: intent.to.session_id,
      actual: successor_native.session_id,
    });
  if (successor_native.session_id === intent.from.session_id)
    return failure('successor_native_inherited', {
      session_id: successor_native.session_id,
    });
  const pinnedNative = copyNative({
    agent_id: successor_native.agent_id,
    runner: successor_native.runner,
    session_id: successor_native.session_id,
    run_id: successor_native.run_id ?? null,
    mission_id: successor_native.mission_id ?? null,
  });

  if (
    intent.transfer_boundary !== null &&
    intent.transfer_boundary !== undefined
  ) {
    const stored = intent.successor_native ?? null;
    if (stored !== null && sameNative(stored, pinnedNative))
      return {
        ok: true as const,
        handoff_state: handoff.state,
        transfer_boundary: intent.transfer_boundary,
        replayed: true,
      };
    return failure('transfer_already_completed', {
      at: intent.transfer_boundary.at,
    });
  }
  if (handoff.state !== 'receiver_confirmed')
    return failure('handoff_not_ready', { state: handoff.state });

  const drift = currentStateDrift(record, intent, 'receiver_confirmed');
  if (drift !== null) return drift;

  const next: TaskRecord = structuredClone(record);
  const completed = completeHandoff(next, {
    handoffId: intent.handoff_id,
    actor: actor ?? intent.from.agent_id,
    clock,
  });
  if (!completed.ok) return completed;
  const bound = bindNative(next, {
    subtaskId: intent.subtask_id,
    attempt: intent.attempt,
    runner: pinnedNative.runner,
    sessionId: pinnedNative.session_id,
    runId: pinnedNative.run_id,
    missionId: pinnedNative.mission_id,
    observation: 'confirmed',
    evidenceRef: successor_native.evidence_ref,
    observedAt: successor_native.observed_at ?? null,
    clock,
  });
  if (!bound.ok) return bound;

  const boundary: RolloverTransferBoundary = {
    message_count: (next.messages ?? []).length,
    state_revision: next.state_revision,
    at: nowIso(clock),
  };
  next.rollover = intentList(next).map((item) =>
    item.intent_id === intent.intent_id
      ? {
          ...item,
          transfer_boundary: boundary,
          successor_native: pinnedNative,
        }
      : item,
  );
  const committed = commit(record, next);
  if (committed !== null) return committed;
  return {
    ok: true as const,
    handoff_state: 'completed',
    transfer_boundary: boundary,
    owner_epoch: next.coordinator?.owner_epoch ?? null,
    replayed: false,
  };
}

/**
 * Records the source-session history marker only when a stored, admitted successor REPORT
 * proves first work after the recorded transfer boundary, under the pinned input, current
 * attempt, exact post-transfer claim epochs and the pinned successor native identity.
 */
export function recordRolloverFirstWork(
  record: TaskRecord,
  {
    intent_id,
    message,
    clock = Date.now(),
  }: { intent_id: string; message: unknown; clock?: number },
) {
  const invalidRecord = recordFailure(record);
  if (invalidRecord !== null) return invalidRecord;
  const intent = findIntent(record, intent_id);
  if (intent === null) return failure('unknown_intent', { intent_id });
  const handoff = findHandoff(record, intent.handoff_id);
  if (handoff === null) return failure('unknown_handoff');
  if (handoff.state !== 'completed')
    return failure('transfer_not_completed', { state: handoff.state });
  const boundary = intent.transfer_boundary ?? null;
  if (boundary === null || boundary === undefined)
    return failure('transfer_boundary_missing');

  const existing = findSuccession(record, intent.handoff_id, intent.generation);

  const stored = storedEnvelope(record, message, 'REPORT');
  if (!('ok' in stored) || stored.ok !== true) return stored;
  const { message: report, entry, index } = stored;

  if (existing !== null) {
    if (
      existing.proof.message_id === report.message_id &&
      existing.proof.digest === entry.content_digest
    ) {
      return {
        ok: true as const,
        succession: existing,
        replayed: true,
        routing: 'pending',
        native_archive: 'unavailable',
      };
    }
    return failure('first_work_already_recorded', {
      message_id: existing.proof.message_id,
    });
  }

  if (index < boundary.message_count)
    return failure('report_pre_transfer', {
      index,
      boundary: boundary.message_count,
    });
  const attempt = findAttempt(record, intent.subtask_id, intent.attempt);
  if (attempt === null) return failure('unknown_attempt');
  if (latestAttemptOf(record, intent.subtask_id) !== intent.attempt)
    return failure('attempt_superseded', {
      attempt: intent.attempt,
      latest: latestAttemptOf(record, intent.subtask_id),
    });
  if (!sameIdentity(attempt.assignee, intent.to))
    return failure('assignee_mismatch', {
      expected: intent.to,
      actual: attempt.assignee ?? null,
    });
  if (attempt.input_revision !== intent.input_revision)
    return failure('input_changed', {
      expected: intent.input_revision,
      actual: attempt.input_revision ?? null,
    });
  if (
    !sameIdentity(report.from, intent.to) ||
    !sameIdentity(entry.from, intent.to)
  )
    return failure('report_sender_mismatch', {
      expected: intent.to,
      actual: report.from,
    });
  if (
    report.subtask_id !== intent.subtask_id ||
    report.attempt !== intent.attempt
  )
    return failure('report_correlation_mismatch', {
      subtask_id: report.subtask_id,
      attempt: report.attempt,
    });
  if (report.body?.handoff_id !== intent.handoff_id)
    return failure('report_correlation_mismatch', {
      handoff_id: report.body?.handoff_id ?? null,
    });
  if (report.body?.rollover_generation !== intent.generation)
    return failure('report_correlation_mismatch', {
      generation: report.body?.rollover_generation ?? null,
    });

  const result = (record.results ?? []).find(
    (item) => item.message_id === report.message_id,
  );
  if (result === undefined)
    return failure('report_not_admitted', { detail: 'no result entry' });
  if (result.classification !== 'applied')
    return failure('report_not_admitted', {
      classification: result.classification,
    });
  if (result.status !== 'completed')
    return failure('report_not_admitted', { status: result.status });
  if (report.body?.status !== result.status)
    return failure('report_status_mismatch', {
      report: report.body?.status ?? null,
      result: result.status,
    });
  if (
    result.subtask_id !== intent.subtask_id ||
    result.attempt !== intent.attempt
  )
    return failure('report_not_admitted', {
      detail: 'result attempt mismatch',
    });
  if (
    report.body?.input_revision !== intent.input_revision ||
    result.input_revision !== intent.input_revision
  )
    return failure('report_input_mismatch', {
      expected: intent.input_revision,
      report: report.body?.input_revision ?? null,
      result: result.input_revision ?? null,
    });

  const coordinator = record.coordinator ?? null;
  if (
    coordinator === null ||
    coordinator.owner_epoch !== intent.coordinator_epoch
  )
    return failure('stale_epoch', {
      expected: intent.coordinator_epoch,
      actual: coordinator?.owner_epoch ?? null,
    });
  for (const reference of intent.claims) {
    const claim = (record.claims ?? []).find(
      (item) => item.claim_id === reference.claim_id,
    );
    if (claim === undefined || claim.released_at)
      return failure('claim_unavailable', { claim_id: reference.claim_id });
    if (claim.holder === null || claim.holder === undefined)
      return failure('claim_holder_missing', { claim_id: reference.claim_id });
    if (!sameIdentity(claim.holder, intent.to))
      return failure('claim_holder_mismatch', {
        claim_id: reference.claim_id,
        holder: claim.holder,
      });
    if (claim.resource_epoch !== reference.resource_epoch + 1)
      return failure('claim_epoch_mismatch', {
        claim_id: reference.claim_id,
        expected: reference.resource_epoch + 1,
        actual: claim.resource_epoch ?? null,
      });
  }

  const pinnedSuccessor = intent.successor_native ?? null;
  const native = attempt.native ?? null;
  if (pinnedSuccessor === null) return failure('successor_native_missing');
  if (native === null || native.observation !== 'confirmed')
    return failure('native_identity_mismatch', {
      observation: native?.observation ?? null,
    });
  if (native.session_id !== pinnedSuccessor.session_id)
    return failure('native_identity_mismatch', {
      field: 'session_id',
      expected: pinnedSuccessor.session_id,
      actual: native.session_id ?? null,
    });
  if (native.run_id !== pinnedSuccessor.run_id)
    return failure('native_identity_mismatch', {
      field: 'run_id',
      expected: pinnedSuccessor.run_id,
      actual: native.run_id ?? null,
    });
  if (native.runner !== pinnedSuccessor.runner)
    return failure('native_identity_mismatch', {
      field: 'runner',
      expected: pinnedSuccessor.runner,
      actual: native.runner ?? null,
    });

  const succession = {
    schema: ROLLOVER_SUCCESSION_SCHEMA,
    intent_id: intent.intent_id,
    handoff_id: intent.handoff_id,
    generation: intent.generation,
    old_native: copyNative(intent.source_native),
    successor_native: copyNative(pinnedSuccessor),
    archived_at: nowIso(clock),
    history_retained: true as const,
    // Routing integration is a later adapter slice: never claim effective removal.
    routing: 'pending' as const,
    native_archive: 'unavailable' as const,
    proof: { message_id: report.message_id, digest: entry.content_digest },
  };
  if ((record.successions ?? []).length >= MAX_SUCCESSIONS)
    return failure('rollover_limit', {
      field: 'successions',
      limit: MAX_SUCCESSIONS,
    });
  const next: TaskRecord = structuredClone(record);
  next.successions = [...(next.successions ?? []), succession];
  if (recordFailure(next) !== null)
    return failure('record_invalid', {
      detail: 'succession would not persist',
    });
  commit(record, next);
  return {
    ok: true as const,
    succession,
    replayed: false,
    routing: 'pending',
    native_archive: 'unavailable',
  };
}
