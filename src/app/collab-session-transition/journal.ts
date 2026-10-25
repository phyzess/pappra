import path from 'node:path';
import { object as isRecord } from '../../infra/validation.js';
import { hasPendingCancellation } from '../../collab/admission.js';
import { canonicalJson } from '../../collab/envelope.js';
import { findAttempt } from '../../collab/lifecycle.js';
import { transact } from '../../collab/store.js';
import type { RolloverIntent, TaskRecord } from '../../collab/types.js';
import { isTaskRecord } from '../../collab/validation.js';
import { MANAGED_PI_EXECUTION_SCOPE_SCHEMA } from '../../schemas/managed-pi-execution.js';
import {
  isDigest,
  isPositiveInt,
  isSafeId,
  isText,
  safePathEqual,
  sameIdentity,
} from '../collab-session-transition-validation.js';
import {
  MANAGED_PI_SCOPED_PROOF_ADAPTER_ID,
  MANAGED_PI_SCOPED_RECEIPT_SCHEMA,
  type SessionTransitionDependencies,
  type SessionTransitionEffectReceipt,
  type SessionTransitionJournal,
  type SessionTransitionJournalEntry,
  type SessionTransitionQuiescenceReceipt,
  type TransitionContext,
} from './types.js';
import { nowIso, sameHarnessIdentity } from './context.js';
import * as rollover from '../../collab/rollover.js';
import { handoffBundleRelativeRef } from '../../continuity/index.js';
import {
  COLLAB_ROLLOVER_REQUEST_SCHEMA,
  type RolloverIntentRequest,
  type RolloverRequest,
} from '../collab-rollover.js';
import type { SessionTransitionRequest } from '../collab-session-transition-request.js';
export {
  MAX_ARCHIVE_BYTES,
  MAX_QUIESCENCE_AGE_MS,
  addJournalEntry,
  buildRolloverRequest,
  currentStateDrift,
  getHandoff,
  getIntent,
  hasJournalConflict,
  intentTransaction,
  journalEntry,
  managedExecutionScopeDrift,
  parseQuiescenceReceipt,
  readJournal,
  sameIntentRequest,
  setJournalEffect,
  setJournalQuiescenceReceipt,
  sourceStateFailure,
};

function hasJournalConflict(
  record: TaskRecord,
  request: SessionTransitionRequest,
  requestDigest: string,
): boolean {
  const journal = readJournal(record);
  if (!journal.ok) return true;
  const entry = journal.value.entries.find(
    (candidate) => candidate.transition_id === request.transition_id,
  );
  return (
    entry !== undefined &&
    (entry.request_digest !== requestDigest ||
      entry.bootstrap_request_digest !== request.bootstrap_request.digest)
  );
}
function sameIntentRequest(
  existing: RolloverIntent,
  requested: RolloverIntentRequest,
  request: SessionTransitionRequest,
): boolean {
  const expectedBundleRef = handoffBundleRelativeRef(request.bundle.bundle_id);
  const existingClaims = [...existing.claims]
    .map((claim) => ({
      claim_id: claim.claim_id,
      resource_epoch: claim.resource_epoch,
    }))
    .sort((a, b) => a.claim_id.localeCompare(b.claim_id));
  const requestedClaims = [...requested.claims]
    .map((claim) => ({
      claim_id: claim.claim_id,
      resource_epoch: claim.resource_epoch,
    }))
    .sort((a, b) => a.claim_id.localeCompare(b.claim_id));
  return (
    existing.intent_id === requested.intent_id &&
    existing.generation === requested.generation &&
    existing.handoff_id === requested.handoff_id &&
    existing.task_id === path.basename(request.task_root) &&
    existing.subtask_id === requested.subtask_id &&
    existing.attempt === requested.attempt &&
    existing.input_revision === requested.input_revision &&
    existing.coordinator_epoch === requested.coordinator_epoch &&
    sameHarnessIdentity(existing.from, requested.from) &&
    sameHarnessIdentity(existing.to, requested.to) &&
    existing.bundle.ref === expectedBundleRef &&
    existing.bundle.digest === request.bundle.digest &&
    JSON.stringify(existingClaims) === JSON.stringify(requestedClaims)
  );
}
const MAX_JOURNAL_ENTRIES = 32;
const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024;
const MAX_QUIESCENCE_AGE_MS = 30_000;
export const SESSION_TRANSITION_JOURNAL_KEY = 'session_transition_journal';
const JOURNAL_KEY = SESSION_TRANSITION_JOURNAL_KEY;
function sourceStateFailure(
  record: TaskRecord,
  request: SessionTransitionRequest,
) {
  return currentStateDrift(record, request, 'source');
}

function addJournalEntry(
  record: TaskRecord,
  request: SessionTransitionRequest,
  requestDigest: string,
  at: string,
): { readonly ok: true } | { readonly ok: false; readonly code: string } {
  const loaded = readJournal(record);
  if (!loaded.ok) return loaded;
  const existing = loaded.value.entries.find(
    (entry) => entry.transition_id === request.transition_id,
  );
  if (existing !== undefined) {
    if (
      existing.request_digest !== requestDigest ||
      existing.bootstrap_request_digest !== request.bootstrap_request.digest
    )
      return { ok: false, code: 'transition_request_conflict' };
    return { ok: true };
  }
  if (loaded.value.entries.length >= MAX_JOURNAL_ENTRIES)
    return { ok: false, code: 'transition_journal_limit' };
  const entry: SessionTransitionJournalEntry = {
    transition_id: request.transition_id,
    request_digest: requestDigest,
    bootstrap_request_digest: request.bootstrap_request.digest,
    created_at: at,
    updated_at: at,
    effects: {},
  };
  const journal: SessionTransitionJournal = {
    schema: 'pappra/session-transition-journal/1',
    entries: [...loaded.value.entries, entry],
  };
  const encoded = JSON.stringify(journal);
  if (Buffer.byteLength(encoded) > MAX_JOURNAL_BYTES)
    return { ok: false, code: 'transition_journal_limit' };
  (record as TaskRecord & { [JOURNAL_KEY]?: unknown })[JOURNAL_KEY] = journal;
  return { ok: true };
}

function setJournalEffect(
  record: TaskRecord,
  transitionId: string,
  input: {
    readonly name: string;
    readonly state: SessionTransitionEffectReceipt['state'];
    readonly at: string;
    readonly code?: string;
    readonly digest?: string;
    readonly ref?: string;
    readonly artifact?: 'route-binding' | 'task-retirement';
  },
): { readonly ok: true } | { readonly ok: false; readonly code: string } {
  const loaded = readJournal(record);
  if (!loaded.ok) return loaded;
  const entries = [...loaded.value.entries];
  const index = entries.findIndex(
    (entry) => entry.transition_id === transitionId,
  );
  if (index < 0) return { ok: false, code: 'transition_journal_missing' };
  const current = entries[index]!;
  const effects: Record<string, SessionTransitionEffectReceipt> = {
    ...current.effects,
    [input.name]: {
      state: input.state,
      intent_at: current.effects[input.name]?.intent_at ?? input.at,
      ...(input.state === 'pending' ? {} : { outcome_at: input.at }),
      ...(input.code === undefined ? {} : { code: input.code }),
      ...(input.digest === undefined ? {} : { digest: input.digest }),
      ...(input.ref === undefined ? {} : { ref: input.ref }),
    },
  };
  let updated: SessionTransitionJournalEntry = {
    ...current,
    updated_at: input.at,
    effects,
  };
  if (input.state === 'completed' && input.artifact === 'route-binding')
    updated = {
      ...updated,
      route_binding_ref: input.ref ?? null,
      route_binding_digest: input.digest ?? null,
    };
  if (input.state === 'completed' && input.artifact === 'task-retirement')
    updated = {
      ...updated,
      archive_ref: input.ref ?? null,
      archive_digest: input.digest ?? null,
    };
  entries[index] = updated;
  const journal: SessionTransitionJournal = { ...loaded.value, entries };
  if (Buffer.byteLength(JSON.stringify(journal)) > MAX_JOURNAL_BYTES)
    return { ok: false, code: 'transition_journal_limit' };
  (record as TaskRecord & { [JOURNAL_KEY]?: unknown })[JOURNAL_KEY] = journal;
  return { ok: true };
}

function setJournalQuiescenceReceipt(
  record: TaskRecord,
  transitionId: string,
  stage: 'source' | 'transfer',
  receipt: SessionTransitionQuiescenceReceipt,
): { readonly ok: true } | { readonly ok: false; readonly code: string } {
  const loaded = readJournal(record);
  if (!loaded.ok) return loaded;
  const entries = [...loaded.value.entries];
  const index = entries.findIndex(
    (entry) => entry.transition_id === transitionId,
  );
  if (index < 0) return { ok: false, code: 'transition_journal_missing' };
  const current = entries[index]!;
  const key =
    stage === 'source'
      ? 'source_quiescence_receipt'
      : 'transfer_quiescence_receipt';
  const prior = current[key];
  if (prior !== undefined && canonicalJson(prior) !== canonicalJson(receipt))
    return { ok: false, code: `${stage}_quiescence_receipt_conflict` };
  const updated: SessionTransitionJournalEntry = {
    ...current,
    updated_at: receipt.observed_at,
    [key]: receipt,
  };
  entries[index] = updated;
  const journal: SessionTransitionJournal = { ...loaded.value, entries };
  if (Buffer.byteLength(JSON.stringify(journal)) > MAX_JOURNAL_BYTES)
    return { ok: false, code: 'transition_journal_limit' };
  (record as TaskRecord & { [JOURNAL_KEY]?: unknown })[JOURNAL_KEY] = journal;
  return { ok: true };
}

function intentTransaction(
  context: TransitionContext,
  dependencies: SessionTransitionDependencies,
  now: () => number,
): Promise<Awaited<ReturnType<typeof transact>>> {
  return Promise.resolve(
    transact(context.task.taskRoot, {
      actor: context.request.intent.from.agent_id,
      purpose: 'session-transition:create-intent',
      expectRevision: context.task.record.state_revision,
      clock: now(),
      apply: (record) => {
        if (dependencies.signal?.aborted)
          return { ok: false as const, reason: 'abort_requested' };
        const drift = sourceStateFailure(record, context.request);
        if (drift !== null) return { ok: false as const, reason: drift.code };
        const existing = getIntent(record, context.request.intent.intent_id);
        if (existing !== null) {
          if (
            !sameIntentRequest(
              existing,
              context.request.intent,
              context.request,
            )
          )
            return { ok: false as const, reason: 'intent_input_conflict' };
          const journal = addJournalEntry(
            record,
            context.request,
            context.requestDigest,
            nowIso(now),
          );
          if (!journal.ok) return { ok: false as const, reason: journal.code };
          return {
            record,
            op: 'session-transition-intent-replay',
            summary: { transition_id: context.request.transition_id },
            result: { replayed: true },
          };
        }
        const created = rollover.createRolloverIntent(record, {
          ...context.request.intent,
          bundle: {
            ref: handoffBundleRelativeRef(context.request.bundle.bundle_id),
            digest: context.request.bundle.digest,
          },
          clock: now(),
        });
        if (!created.ok) return created;
        const journal = addJournalEntry(
          record,
          context.request,
          context.requestDigest,
          nowIso(now),
        );
        if (!journal.ok) return { ok: false as const, reason: journal.code };
        return {
          record,
          op: 'session-transition-intent',
          summary: { transition_id: context.request.transition_id },
          result: { replayed: false },
        };
      },
    }),
  );
}

function parseQuiescenceReceipt(
  value: unknown,
): SessionTransitionQuiescenceReceipt | null {
  if (!isRecord(value) || !isRecord(value['freeze_token'])) return null;
  const token = value['freeze_token'];
  const legacy =
    value['schema'] === 'pappra/session-transition-quiescence-receipt/1' &&
    value['adapter_id'] === 'pappra/pi-session-transition-host/1';
  const scoped =
    value['schema'] === MANAGED_PI_SCOPED_RECEIPT_SCHEMA &&
    value['adapter_id'] === MANAGED_PI_SCOPED_PROOF_ADAPTER_ID &&
    isDigest(value['execution_scope_digest']);
  if (
    (!legacy && !scoped) ||
    !isText(value['session_id'], 256) ||
    !isText(value['cwd'], 4096) ||
    !path.isAbsolute(value['cwd']) ||
    !isText(value['observed_at'], 64) ||
    !Number.isFinite(Date.parse(value['observed_at'])) ||
    !Number.isSafeInteger(value['sequence']) ||
    (value['sequence'] as number) < 0 ||
    !isText(value['evidence_ref'], 4096) ||
    !isDigest(value['inventory_digest']) ||
    !isText(token['sessionId'], 256) ||
    !isSafeId(token['taskId']) ||
    !isSafeId(token['handoffId']) ||
    !isPositiveInt(token['generation']) ||
    token['sessionId'] !== value['session_id']
  )
    return null;
  return {
    schema: value['schema'] as SessionTransitionQuiescenceReceipt['schema'],
    adapter_id: value[
      'adapter_id'
    ] as SessionTransitionQuiescenceReceipt['adapter_id'],
    session_id: value['session_id'],
    cwd: value['cwd'],
    observed_at: value['observed_at'],
    sequence: value['sequence'] as number,
    evidence_ref: value['evidence_ref'],
    freeze_token: {
      sessionId: token['sessionId'],
      taskId: token['taskId'],
      handoffId: token['handoffId'],
      generation: token['generation'],
    },
    inventory_digest: value['inventory_digest'],
    ...(scoped
      ? { execution_scope_digest: value['execution_scope_digest'] as string }
      : {}),
  };
}

function readJournal(
  record: TaskRecord,
):
  | { readonly ok: true; readonly value: SessionTransitionJournal }
  | { readonly ok: false; readonly code: string } {
  const raw = (record as TaskRecord & { [JOURNAL_KEY]?: unknown })[JOURNAL_KEY];
  if (raw === undefined)
    return {
      ok: true,
      value: { schema: 'pappra/session-transition-journal/1', entries: [] },
    };
  if (
    !isRecord(raw) ||
    raw['schema'] !== 'pappra/session-transition-journal/1' ||
    !Array.isArray(raw['entries']) ||
    raw['entries'].length > MAX_JOURNAL_ENTRIES
  )
    return { ok: false, code: 'transition_journal_invalid' };
  const entries: SessionTransitionJournalEntry[] = [];
  for (const item of raw['entries']) {
    if (
      !isRecord(item) ||
      !isSafeId(item['transition_id']) ||
      !isDigest(item['request_digest']) ||
      !isDigest(item['bootstrap_request_digest']) ||
      !isText(item['created_at'], 64) ||
      !isText(item['updated_at'], 64) ||
      !isRecord(item['effects'])
    )
      return { ok: false, code: 'transition_journal_invalid' };
    const effects: Record<string, SessionTransitionEffectReceipt> = {};
    for (const [key, value] of Object.entries(item['effects'])) {
      if (
        !isSafeId(key) ||
        !isRecord(value) ||
        !['pending', 'completed', 'unknown', 'failed'].includes(
          String(value['state']),
        ) ||
        !isText(value['intent_at'], 64)
      )
        return { ok: false, code: 'transition_journal_invalid' };
      effects[key] = {
        state: value['state'] as SessionTransitionEffectReceipt['state'],
        intent_at: value['intent_at'],
        ...(isText(value['outcome_at'], 64)
          ? { outcome_at: value['outcome_at'] }
          : {}),
        ...(isText(value['code'], 128) ? { code: value['code'] } : {}),
        ...(isDigest(value['digest']) ? { digest: value['digest'] } : {}),
        ...(isText(value['ref'], 4096) ? { ref: value['ref'] } : {}),
      };
    }
    const sourceReceiptValue = item['source_quiescence_receipt'];
    const transferReceiptValue = item['transfer_quiescence_receipt'];
    const sourceReceipt =
      sourceReceiptValue === undefined
        ? null
        : parseQuiescenceReceipt(sourceReceiptValue);
    const transferReceipt =
      transferReceiptValue === undefined
        ? null
        : parseQuiescenceReceipt(transferReceiptValue);
    if (
      (sourceReceiptValue !== undefined && sourceReceipt === null) ||
      (transferReceiptValue !== undefined && transferReceipt === null)
    )
      return { ok: false, code: 'transition_journal_invalid' };
    entries.push({
      transition_id: item['transition_id'],
      request_digest: item['request_digest'],
      bootstrap_request_digest: item['bootstrap_request_digest'],
      created_at: item['created_at'],
      updated_at: item['updated_at'],
      effects,
      ...(sourceReceipt === null
        ? {}
        : { source_quiescence_receipt: sourceReceipt }),
      ...(transferReceipt === null
        ? {}
        : { transfer_quiescence_receipt: transferReceipt }),
      ...(isText(item['route_binding_ref'], 4096)
        ? { route_binding_ref: item['route_binding_ref'] }
        : {}),
      ...(isDigest(item['route_binding_digest'])
        ? { route_binding_digest: item['route_binding_digest'] }
        : {}),
      ...(isText(item['archive_ref'], 4096)
        ? { archive_ref: item['archive_ref'] }
        : {}),
      ...(isDigest(item['archive_digest'])
        ? { archive_digest: item['archive_digest'] }
        : {}),
    });
  }
  return {
    ok: true,
    value: { schema: 'pappra/session-transition-journal/1', entries },
  };
}

function journalEntry(
  record: TaskRecord,
  request: SessionTransitionRequest,
  requestDigest: string,
): SessionTransitionJournalEntry | null {
  const journal = readJournal(record);
  if (!journal.ok) return null;
  const entry = journal.value.entries.find(
    (candidate) => candidate.transition_id === request.transition_id,
  );
  if (entry === undefined) return null;
  return entry.request_digest === requestDigest &&
    entry.bootstrap_request_digest === request.bootstrap_request.digest
    ? entry
    : null;
}

function currentStateDrift(
  record: TaskRecord,
  request: SessionTransitionRequest,
  phase: 'source' | 'successor' | 'retired',
): { readonly code: string; readonly message: string } | null {
  if (!isTaskRecord(record))
    return {
      code: 'record_invalid',
      message: 'Authoritative task record failed validation.',
    };
  if (
    record.task_id !== path.basename(request.task_root) ||
    !safePathEqual(record.task_root, request.task_root)
  )
    return {
      code: 'task_namespace_changed',
      message: 'Task identity/root changed during transition.',
    };
  const coordinator = record.coordinator;
  if (
    coordinator === null ||
    coordinator.owner_epoch !== request.intent.coordinator_epoch
  )
    return {
      code: 'stale_epoch',
      message: 'Coordinator epoch changed during transition.',
    };
  const attempt = findAttempt(
    record,
    request.intent.subtask_id,
    request.intent.attempt,
  );
  if (attempt === null)
    return {
      code: 'unknown_attempt',
      message: 'The pinned attempt is absent.',
    };
  const latest = (record.attempts ?? [])
    .filter((entry) => entry.subtask_id === request.intent.subtask_id)
    .reduce((max, entry) => Math.max(max, entry.attempt), 0);
  if (latest !== request.intent.attempt)
    return {
      code: 'attempt_superseded',
      message: 'A newer attempt superseded the transition.',
    };
  if (attempt.input_revision !== request.intent.input_revision)
    return {
      code: 'input_changed',
      message: 'The pinned input revision changed.',
    };
  if (record.dispatch_frozen === true)
    return {
      code: 'dispatch_frozen',
      message: 'Dispatch is frozen; no transition effect is authorized.',
    };
  if (attempt.awaiting !== undefined)
    return {
      code:
        attempt.awaiting === 'approval'
          ? 'awaiting_approval'
          : 'attempt_blocked',
      message: `The attempt is waiting for ${attempt.awaiting}.`,
    };
  if (
    attempt.cancel_requested_at != null ||
    hasPendingCancellation(
      record,
      request.intent.subtask_id,
      request.intent.attempt,
    )
  )
    return {
      code: 'cancel_unconfirmed',
      message: 'Cancellation is pending or unconfirmed.',
    };
  const transferred = phase !== 'source';
  const expectedIdentity = transferred
    ? request.intent.to
    : request.intent.from;
  if (!sameHarnessIdentity(attempt.assignee, expectedIdentity))
    return {
      code: 'assignee_mismatch',
      message: 'Current assignee differs from the pinned transition stage.',
    };
  if (
    !transferred &&
    !['assigned', 'accepted', 'running'].includes(attempt.state)
  )
    return {
      code: 'attempt_not_active',
      message: `Source attempt state ${attempt.state} is not active.`,
    };
  const intent = getIntent(record, request.intent.intent_id);
  const expectedNative = transferred
    ? (intent?.successor_native ?? null)
    : (intent?.source_native ?? null);
  if (expectedNative !== null) {
    const native = attempt.native ?? null;
    if (
      native === null ||
      native.observation !== 'confirmed' ||
      native.session_id !== expectedNative.session_id ||
      native.runner !== expectedNative.runner ||
      native.run_id !== expectedNative.run_id
    )
      return {
        code: 'native_identity_drift',
        message:
          'Current attempt native identity differs from the pinned identity.',
      };
  }
  for (const reference of request.intent.claims) {
    const claim = (record.claims ?? []).find(
      (entry) => entry.claim_id === reference.claim_id,
    );
    if (claim === undefined || claim.released_at !== null)
      return {
        code: 'claim_unavailable',
        message: `Claim ${reference.claim_id} is missing or released.`,
      };
    const expectedEpoch = transferred
      ? reference.resource_epoch + 1
      : reference.resource_epoch;
    if (
      !sameIdentity(claim.holder, expectedIdentity) ||
      (claim.holder.harness !== null &&
        claim.holder.harness !== expectedIdentity.harness) ||
      (claim.resource_epoch ?? 0) !== expectedEpoch
    )
      return {
        code: 'claim_drift',
        message: `Claim ${reference.claim_id} holder/epoch changed.`,
      };
  }
  return null;
}
function managedExecutionScopeDrift(
  request: SessionTransitionRequest,
  record: TaskRecord,
): { readonly code: string; readonly message: string } | null {
  const scope = request.managed_execution_scope;
  if (scope === undefined) return null;
  if (
    scope.schema !== MANAGED_PI_EXECUTION_SCOPE_SCHEMA ||
    scope.task_id !== record.task_id ||
    !safePathEqual(scope.task_root, record.task_root) ||
    scope.session_id !== request.intent.from.session_id ||
    !safePathEqual(scope.cwd, request.intent.from.cwd ?? '') ||
    scope.subtask_id !== request.intent.subtask_id ||
    scope.attempt !== request.intent.attempt ||
    scope.owner_epoch !== request.intent.coordinator_epoch ||
    record.coordinator?.owner_epoch !== scope.owner_epoch
  )
    return {
      code: 'managed_execution_scope_mismatch',
      message: 'The scoped SDK binding no longer matches the task/source pins.',
    };
  const attempt = findAttempt(record, scope.subtask_id, scope.attempt);
  const latestAttempt = (record.attempts ?? [])
    .filter((candidate) => candidate.subtask_id === scope.subtask_id)
    .reduce((latest, candidate) => Math.max(latest, candidate.attempt), 0);
  if (
    attempt === null ||
    latestAttempt !== scope.attempt ||
    !['assigned', 'accepted', 'running'].includes(attempt.state) ||
    attempt.owner_epoch !== scope.owner_epoch ||
    attempt.assignee.harness !== 'pi' ||
    attempt.assignee.agent_id !== request.intent.from.agent_id ||
    attempt.assignee.session_id !== scope.session_id ||
    (attempt.assignee.cwd !== undefined &&
      !safePathEqual(attempt.assignee.cwd, scope.cwd))
  )
    return {
      code: 'managed_execution_scope_attempt_stale',
      message: 'The scoped source attempt or owner epoch changed.',
    };
  if (
    scope.claim_epochs.length === 0 ||
    scope.claim_epochs.length !== request.intent.claims.length
  )
    return {
      code: 'managed_execution_scope_claims_invalid',
      message: 'The scope must pin every transition claim.',
    };
  for (let index = 0; index < scope.claim_epochs.length; index++) {
    const pin = scope.claim_epochs[index]!;
    const intentPin = request.intent.claims[index];
    const claim = (record.claims ?? []).find(
      (entry) => entry.claim_id === pin.claim_id,
    );
    if (
      pin.resource_epoch <= 0 ||
      pin.claim_id !== intentPin?.claim_id ||
      pin.resource_epoch !== intentPin?.resource_epoch ||
      claim === undefined ||
      claim.released_at !== null ||
      (claim.resource_epoch ?? 0) !== pin.resource_epoch ||
      claim.holder.agent_id !== request.intent.from.agent_id ||
      claim.holder.session_id !== scope.session_id ||
      claim.holder.harness !== 'pi'
    )
      return {
        code: 'managed_execution_scope_claim_stale',
        message: `Scoped claim ${pin.claim_id} is missing, released, reassigned, or at a different epoch.`,
      };
  }
  return null;
}
function getIntent(
  record: TaskRecord,
  intentId: string,
): RolloverIntent | null {
  return (
    (record.rollover ?? []).find((entry) => entry.intent_id === intentId) ??
    null
  );
}

function getHandoff(record: TaskRecord, handoffId: string) {
  return (
    (record.handoffs ?? []).find((entry) => entry.handoff_id === handoffId) ??
    null
  );
}

function buildRolloverRequest(
  request: SessionTransitionRequest,
  record: TaskRecord,
): RolloverRequest {
  const existing = getIntent(record, request.intent.intent_id);
  return {
    schema: COLLAB_ROLLOVER_REQUEST_SCHEMA,
    action: existing === null ? 'plan' : 'inspect',
    task_root: request.task_root,
    intent_id: existing === null ? null : existing.intent_id,
    proposed_intent: existing === null ? request.intent : null,
    bundle: request.bundle,
    evidence: {
      ack_message_id: request.evidence.ack_message_id,
      report_message_id: request.evidence.first_work_report_id,
    },
  };
}
