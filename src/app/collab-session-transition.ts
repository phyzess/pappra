import { object as isRecord } from '../infra/validation.js';
import fs from 'node:fs';
import path from 'node:path';
import { readManagedSourceAssignment } from './managed-pi-source-admission.js';
import { hasPendingCancellation } from '../collab/admission.js';
import { canonicalJson } from '../collab/envelope.js';
import { findAttempt } from '../collab/lifecycle.js';
import * as rollover from '../collab/rollover.js';
import { transact } from '../collab/store.js';
import type {
  Identity,
  LaunchReservation,
  RolloverIntent,
  TaskRecord,
} from '../collab/types.js';
import { handoffBundleRelativeRef } from '../continuity/index.js';
import {
  collabBindingSchema,
  type CollabBinding,
  type CollabBindingParticipant,
} from '../schemas/collaboration.js';
import { isPathInside } from '../schemas/paths.js';
import type {
  FreezeOutcome,
  FreezeStatus,
  FreezeToken,
} from '../hosts/integration/pi-rollover-extension.js';
import type { NativeFactsSnapshot } from '../hosts/integration/pi-native-events.js';
import {
  applyVisibleBootstrap,
  loadVisibleBootstrapRequest,
  planVisibleBootstrap,
  type LoadedVisibleBootstrapRequest,
  type VisibleBootstrapDependencies,
  type VisibleBootstrapReport,
} from './collab-bootstrap.js';
import {
  reportedSessionIdentity,
  createHerdrTransport,
  type HerdrListResult,
} from './collab-notify.js';
import {
  assertTaskStoreCurrent,
  openTaskStore,
  type OpenedTaskStore,
} from './collab-task-store.js';
import {
  openMessageTask,
  readRegisteredMessageSafe,
  type RegisteredMessage,
} from './collab-messages.js';
import { readBoundedFile } from './bounded-file.js';
import { runCollaborationPreflight } from './collab-preflight.js';
import {
  COLLAB_ROLLOVER_REQUEST_SCHEMA,
  inspectOrPlanRollover,
  type RolloverIntentRequest,
  type RolloverReport,
  type RolloverRequest,
} from './collab-rollover.js';
import {
  createHerdrBootstrapOps,
  type HerdrBootstrapOps,
} from './collab-bootstrap-transport.js';
import { routeExclusionFor, validateSuccession } from './collab-route.js';
import { isTaskRecord } from '../collab/validation.js';

import { isTrustedManagedPiScopedProof } from './managed-pi-transition-host.js';
import { verifyManagedPiSdkInstallation } from '../hosts/pi/managed-sdk-session.js';
import {
  MANAGED_PI_EXECUTION_SCOPE_SCHEMA,
  type ManagedPiExecutionScope,
} from '../schemas/managed-pi-execution.js';
export { MANAGED_PI_EXECUTION_SCOPE_SCHEMA };
export type { ManagedPiExecutionScope };
export {
  COLLAB_SESSION_TRANSITION_REQUEST_SCHEMA,
  loadSessionTransitionRequest,
  validateSessionTransitionRequest,
} from './collab-session-transition-request.js';
export type {
  LoadedSessionTransitionRequest,
  SessionTransitionRequest,
  SessionTransitionRequestResult,
} from './collab-session-transition-request.js';
import {
  immutableDigest,
  type LoadedSessionTransitionRequest,
  type SessionTransitionRequest,
} from './collab-session-transition-request.js';
import {
  digestText,
  isDigest,
  isNonNegativeInt,
  isPositiveInt,
  isSafeId,
  isText,
  safePathEqual,
  sameIdentity,
} from './collab-session-transition-validation.js';
export const COLLAB_SESSION_TRANSITION_REPORT_SCHEMA =
  'pappra/collaboration-session-transition/1';
export const SESSION_TRANSITION_ARCHIVE_SCHEMA =
  'pappra/session-transition-archive/1';

export interface SessionTransitionRetirementMarker {
  readonly schema: typeof SESSION_TRANSITION_ARCHIVE_SCHEMA;
  readonly mode: 'task-retirement';
  readonly task_id: string;
  readonly task_root: string;
  readonly transition_id: string;
  readonly intent_id: string;
  readonly handoff_id: string;
  readonly generation: number;
  readonly recorded_at: string;
  readonly first_work: {
    readonly message_id: string;
    readonly digest: string;
  };
  readonly successor_route_binding: {
    readonly ref: string;
    readonly digest: string;
  };
  readonly native_archive: 'unavailable';
  readonly original_transcript: 'retained-in-place';
  readonly reversible: true;
}

const MAX_JOURNAL_ENTRIES = 32;
const MAX_JOURNAL_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024;
const MAX_QUIESCENCE_AGE_MS = 30_000;
export const SESSION_TRANSITION_JOURNAL_KEY = 'session_transition_journal';
const JOURNAL_KEY = SESSION_TRANSITION_JOURNAL_KEY;

export type SessionTransitionAction = 'plan' | 'apply';
export type SessionTransitionStatus =
  | 'planned'
  | 'progressed'
  | 'waiting'
  | 'needs_input'
  | 'reconcile_required'
  | 'unknown'
  | 'invalid';
export type SessionTransitionStage =
  | 'not_started'
  | 'intent_created'
  | 'awaiting_quiescence'
  | 'prepared'
  | 'successor_bootstrap'
  | 'awaiting_receiver_ack'
  | 'receiver_confirmed'
  | 'ownership_transferred'
  | 'awaiting_first_work'
  | 'first_work_recorded'
  | 'task_retired'
  | 'unknown';

export const MANAGED_PI_SCOPED_PROOF_ADAPTER_ID =
  'pappra/managed-pi-session-transition-host/2';
export const MANAGED_PI_SCOPED_RECEIPT_SCHEMA =
  'pappra/session-transition-quiescence-receipt/2';

export interface SessionTransitionQuiescenceProof {
  readonly adapter_id:
    | 'pappra/pi-session-transition-host/1'
    | typeof MANAGED_PI_SCOPED_PROOF_ADAPTER_ID;
  readonly session_id: string;
  readonly cwd: string;
  readonly observed_at: string;
  readonly sequence: number;
  readonly evidence_ref: string;
  readonly freeze_token: FreezeToken;
  readonly inventory: rollover.RolloverInventory;
  readonly scope?: 'pinned_pi_1_4_owned_runtime';
  readonly execution_scope?: ManagedPiExecutionScope;
  readonly execution_scope_digest?: string;
  readonly excluded_scope?: readonly [
    'arbitrary_external_writers',
    'unowned_processes_and_descendants',
  ];
  readonly runtime_quiescent?: boolean;
  readonly runtime_blockers?: readonly string[];
  readonly controller_sequence?: number;
  readonly controller_head_digest?: string;
  readonly controller_journal_healthy?: boolean;
}

export interface SessionTransitionQuiescenceReceipt {
  readonly schema:
    | 'pappra/session-transition-quiescence-receipt/1'
    | typeof MANAGED_PI_SCOPED_RECEIPT_SCHEMA;
  readonly adapter_id:
    | 'pappra/pi-session-transition-host/1'
    | typeof MANAGED_PI_SCOPED_PROOF_ADAPTER_ID;
  readonly session_id: string;
  readonly cwd: string;
  readonly observed_at: string;
  readonly sequence: number;
  readonly evidence_ref: string;
  readonly freeze_token: FreezeToken;
  readonly inventory_digest: string;
  readonly execution_scope_digest?: string;
}

export interface SessionTransitionHostObservation {
  readonly session_id: string | null;
  readonly cwd: string | null;
  readonly pane_id: string | null;
  readonly proof_support: 'available' | 'unavailable';
  readonly proof: SessionTransitionQuiescenceProof | null;
  readonly freeze_status: FreezeStatus | null;
  readonly native_facts: NativeFactsSnapshot | null;
  readonly unavailable_code: string | null;
  readonly detail: string | null;
}

/**
 * In-process adapter supplied only by the opt-in Pi extension. The installed producer currently
 * cannot return a complete quiescence proof; its production adapter must report that boundary
 * rather than promote idle, settled, or a freeze latch to stop proof.
 */
export interface SessionTransitionHost {
  readonly id: string;
  observe(): Promise<SessionTransitionHostObservation>;
  freeze(token: FreezeToken): Promise<FreezeOutcome>;
}

export interface SessionTransitionBootstrapExecutor {
  plan(request: LoadedVisibleBootstrapRequest): Promise<VisibleBootstrapReport>;
  apply(
    request: LoadedVisibleBootstrapRequest,
  ): Promise<VisibleBootstrapReport>;
}

export interface SessionTransitionDependencies {
  readonly host?: SessionTransitionHost;
  readonly bootstrap?: SessionTransitionBootstrapExecutor;
  readonly bootstrapDependencies?: VisibleBootstrapDependencies;
  readonly herdr?: HerdrBootstrapOps;
  readonly clock?: () => number;
  readonly signal?: AbortSignal;
}

export interface SessionTransitionStep {
  readonly step: string;
  readonly status: string;
  readonly code: string | null;
  readonly detail: string | null;
}

export interface SessionTransitionReport {
  readonly schema: typeof COLLAB_SESSION_TRANSITION_REPORT_SCHEMA;
  readonly action: SessionTransitionAction;
  readonly ok: boolean;
  readonly status: SessionTransitionStatus;
  readonly code: string | null;
  readonly message: string | null;
  readonly next_action: string | null;
  readonly task_id: string | null;
  readonly task_root: string;
  readonly state_revision: number | null;
  readonly transition_id: string;
  readonly cause_ref: string;
  readonly stage: SessionTransitionStage;
  readonly intent: Record<string, unknown> | null;
  readonly handoff: Record<string, unknown> | null;
  readonly rollover: RolloverReport | null;
  readonly bootstrap: VisibleBootstrapReport | null;
  readonly receiver_ack: Record<string, unknown> | null;
  readonly transfer: Record<string, unknown> | null;
  readonly first_work: Record<string, unknown> | null;
  readonly route_transfer: Record<string, unknown> | null;
  readonly archive: Record<string, unknown> | null;
  readonly host: Record<string, unknown> | null;
  readonly steps: readonly SessionTransitionStep[];
  readonly capabilities: {
    readonly record_reducer: 'available';
    readonly bootstrap: 'available';
    readonly pi_host_extension: 'available' | 'not_loaded';
    readonly supported_quiescence: 'available' | 'unavailable' | 'unknown';
    readonly native_session_archive: 'unavailable';
    readonly task_retirement_archive: 'available';
    readonly task_route_transfer: 'available';
    readonly notification_route_exclusion:
      'active' | 'pending' | 'excluded' | 'unknown';
  };
  readonly limits: readonly string[];
}

interface TransitionFailure {
  readonly ok: false;
  readonly kind: 'invalid' | 'needs_input';
  readonly code: string;
  readonly message: string;
  readonly nextAction: string | null;
}

interface TransitionContext {
  readonly request: SessionTransitionRequest;
  readonly requestDigest: string;
  readonly task: OpenedTaskStore;
  readonly bootstrap: LoadedVisibleBootstrapRequest;
  readonly contactMessage: RegisteredMessage;
}

export interface SessionTransitionEffectReceipt {
  readonly state: 'pending' | 'completed' | 'unknown' | 'failed';
  readonly intent_at: string;
  readonly outcome_at?: string;
  readonly code?: string;
  readonly digest?: string;
  readonly ref?: string;
}

export interface SessionTransitionJournalEntry {
  readonly transition_id: string;
  readonly request_digest: string;
  readonly bootstrap_request_digest: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly effects: Readonly<Record<string, SessionTransitionEffectReceipt>>;
  readonly route_binding_ref?: string | null;
  readonly route_binding_digest?: string | null;
  readonly archive_ref?: string | null;
  readonly archive_digest?: string | null;
  readonly source_quiescence_receipt?: SessionTransitionQuiescenceReceipt;
  readonly transfer_quiescence_receipt?: SessionTransitionQuiescenceReceipt;
}

export interface SessionTransitionJournal {
  readonly schema: 'pappra/session-transition-journal/1';
  readonly entries: readonly SessionTransitionJournalEntry[];
}

function failure(
  kind: TransitionFailure['kind'],
  code: string,
  message: string,
  nextAction: string | null,
): TransitionFailure {
  return { ok: false, kind, code, message, nextAction };
}

function sameHarnessIdentity(
  left: Identity | null | undefined,
  right: Identity,
): boolean {
  if (!sameIdentity(left, right)) return false;
  // Task claim/assignee records may omit optional harness/cwd fields; compare them exactly when present.
  if (
    left?.harness !== undefined &&
    left.harness !== null &&
    left.harness !== right.harness
  )
    return false;
  if (
    left?.cwd !== undefined &&
    right.cwd !== undefined &&
    left.cwd !== right.cwd
  )
    return false;
  return true;
}

function nowIso(clock: () => number): string {
  return new Date(clock()).toISOString();
}

function requestOf(
  value: LoadedSessionTransitionRequest | SessionTransitionRequest,
): SessionTransitionRequest {
  return 'request' in value ? value.request : value;
}

function immutableDigestOf(
  value: LoadedSessionTransitionRequest | SessionTransitionRequest,
): string {
  return 'immutable_digest' in value
    ? value.immutable_digest
    : immutableDigest(value);
}

const LIMITATIONS: readonly string[] = Object.freeze([
  'managed-tool freeze is not a native or OS-level stop proof',
  'native-event queue, approval and in-flight completeness are unknown on the installed Pi API',
  'Herdr identity metadata is not process affiliation or ownership proof',
  'a submitted ACK/report pointer is not consumption or acceptance',
  'native Pi session archive is unavailable; task retirement preserves original session data in place',
]);

function capabilities(
  host: SessionTransitionHostObservation | null,
): SessionTransitionReport['capabilities'] {
  return {
    record_reducer: 'available',
    bootstrap: 'available',
    pi_host_extension: host === null ? 'not_loaded' : 'available',
    supported_quiescence:
      host?.proof_support === 'available'
        ? 'available'
        : host === null
          ? 'unknown'
          : 'unavailable',
    native_session_archive: 'unavailable',
    task_retirement_archive: 'available',
    task_route_transfer: 'available',
    notification_route_exclusion: 'pending',
  };
}

function causeRef(request: SessionTransitionRequest): string {
  return `rollover:${path.basename(request.task_root)}:${request.transition_id}`;
}

function emptyReport(
  action: SessionTransitionAction,
  request: SessionTransitionRequest,
  status: SessionTransitionStatus,
  stateRevision: number | null,
  taskId: string | null,
  fields: Partial<SessionTransitionReport> = {},
): SessionTransitionReport {
  return {
    schema: COLLAB_SESSION_TRANSITION_REPORT_SCHEMA,
    action,
    ok: status === 'planned' || status === 'progressed' || status === 'waiting',
    status,
    code: null,
    message: null,
    next_action: null,
    task_id: taskId,
    task_root: request.task_root,
    state_revision: stateRevision,
    transition_id: request.transition_id,
    cause_ref: causeRef(request),
    stage: 'not_started',
    intent: null,
    handoff: null,
    rollover: null,
    bootstrap: null,
    receiver_ack: null,
    transfer: null,
    first_work: null,
    route_transfer: null,
    archive: null,
    host: null,
    steps: [],
    capabilities: capabilities(null),
    limits: LIMITATIONS,
    ...fields,
  };
}

function step(
  name: string,
  status: string,
  code: string | null = null,
  detail: string | null = null,
): SessionTransitionStep {
  return { step: name, status, code, detail };
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

function parseRegisteredMessageEntry(
  record: TaskRecord,
  registered: RegisteredMessage,
): boolean {
  return (record.messages ?? []).some(
    (entry) =>
      entry.message_id === registered.message.message_id &&
      entry.content_digest === registered.message.content_digest &&
      ['applied', 'recorded'].includes(entry.state),
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

function exactQuiescenceReceipt(
  request: SessionTransitionRequest,
  receipt: SessionTransitionQuiescenceReceipt | undefined,
): receipt is SessionTransitionQuiescenceReceipt {
  const scoped = request.managed_execution_scope;
  const expectedScopeDigest =
    scoped === undefined ? null : digestText(canonicalJson(scoped));
  return (
    receipt !== undefined &&
    (scoped === undefined
      ? receipt.schema === 'pappra/session-transition-quiescence-receipt/1' &&
        receipt.adapter_id === 'pappra/pi-session-transition-host/1'
      : receipt.schema === MANAGED_PI_SCOPED_RECEIPT_SCHEMA &&
        receipt.adapter_id === MANAGED_PI_SCOPED_PROOF_ADAPTER_ID &&
        receipt.execution_scope_digest === expectedScopeDigest) &&
    receipt.session_id === request.intent.from.session_id &&
    safePathEqual(receipt.cwd, request.intent.from.cwd ?? '') &&
    isText(receipt.evidence_ref, 4096) &&
    isDigest(receipt.inventory_digest) &&
    Number.isSafeInteger(receipt.sequence) &&
    receipt.freeze_token.sessionId === request.intent.from.session_id &&
    receipt.freeze_token.taskId === path.basename(request.task_root) &&
    receipt.freeze_token.handoffId === request.intent.handoff_id &&
    receipt.freeze_token.generation === request.intent.generation
  );
}

function exactRouteBindingReceipt(
  request: SessionTransitionRequest,
  entry: SessionTransitionJournalEntry | undefined,
): boolean {
  if (
    entry === undefined ||
    !isText(entry.route_binding_ref, 4096) ||
    !isDigest(entry.route_binding_digest) ||
    entry.effects['successor-route-binding']?.state !== 'completed' ||
    entry.effects['successor-route-binding'].ref !== entry.route_binding_ref ||
    entry.effects['successor-route-binding'].digest !==
      entry.route_binding_digest
  )
    return false;
  const read = readTaskLocalFile(
    entry.route_binding_ref,
    request.task_root,
    64 * 1024,
  );
  if (!read.ok || read.digest !== entry.route_binding_digest) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes.toString('utf8')) as unknown;
  } catch {
    return false;
  }
  const binding = collabBindingSchema.safeParse(parsed);
  if (
    !binding.success ||
    binding.data.task_id !== path.basename(request.task_root) ||
    !safePathEqual(binding.data.task_root, request.task_root) ||
    binding.data.participants.length !== 1
  )
    return false;
  const participant = binding.data.participants[0]!;
  return (
    participant.agent_id === request.intent.to.agent_id &&
    participant.harness === request.intent.to.harness &&
    participant.native_session_id === request.intent.to.session_id &&
    safePathEqual(participant.cwd, request.intent.to.cwd ?? '')
  );
}

function exactRetirementReceipt(
  request: SessionTransitionRequest,
  record: TaskRecord,
  entry: SessionTransitionJournalEntry | undefined,
  succession: NonNullable<TaskRecord['successions']>[number],
): boolean {
  if (
    entry === undefined ||
    !isText(entry.archive_ref, 4096) ||
    !isDigest(entry.archive_digest) ||
    entry.effects['task-retirement-marker']?.state !== 'completed' ||
    entry.effects['task-retirement-marker'].ref !== entry.archive_ref ||
    entry.effects['task-retirement-marker'].digest !== entry.archive_digest ||
    !exactRouteBindingReceipt(request, entry)
  )
    return false;
  const read = readTaskLocalFile(
    entry.archive_ref,
    request.task_root,
    MAX_ARCHIVE_BYTES,
  );
  if (!read.ok || read.digest !== entry.archive_digest) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes.toString('utf8')) as unknown;
  } catch {
    return false;
  }
  if (
    !isRecord(parsed) ||
    !isRecord(parsed['first_work']) ||
    !isRecord(parsed['successor_route_binding'])
  )
    return false;
  return (
    parsed['schema'] === SESSION_TRANSITION_ARCHIVE_SCHEMA &&
    parsed['mode'] === 'task-retirement' &&
    parsed['task_id'] === record.task_id &&
    safePathEqual(String(parsed['task_root'] ?? ''), request.task_root) &&
    parsed['transition_id'] === request.transition_id &&
    parsed['intent_id'] === request.intent.intent_id &&
    parsed['handoff_id'] === request.intent.handoff_id &&
    parsed['generation'] === request.intent.generation &&
    isText(parsed['recorded_at'], 64) &&
    parsed['first_work']['message_id'] === succession.proof.message_id &&
    parsed['first_work']['digest'] === succession.proof.digest &&
    parsed['successor_route_binding']['ref'] === entry.route_binding_ref &&
    parsed['successor_route_binding']['digest'] ===
      entry.route_binding_digest &&
    parsed['native_archive'] === 'unavailable' &&
    parsed['original_transcript'] === 'retained-in-place' &&
    parsed['reversible'] === true
  );
}

function reportForContext(
  action: SessionTransitionAction,
  request: SessionTransitionRequest,
  record: TaskRecord,
  rolloverReport: RolloverReport | null,
  bootstrapReport: VisibleBootstrapReport | null,
  hostObservation: SessionTransitionHostObservation | null,
  steps: readonly SessionTransitionStep[],
  status: SessionTransitionStatus,
  extra: Partial<SessionTransitionReport> = {},
): SessionTransitionReport {
  const intent = getIntent(record, request.intent.intent_id);
  const handoff = getHandoff(record, request.intent.handoff_id);
  const succession =
    (record.successions ?? []).find(
      (entry) =>
        entry.intent_id === request.intent.intent_id &&
        entry.handoff_id === request.intent.handoff_id &&
        entry.generation === request.intent.generation,
    ) ?? null;
  const successionValidation =
    succession === null ? null : validateSuccession(record, succession);
  const successionValid = successionValidation?.ok === true;
  const routeExclusion = routeExclusionFor(record, request.intent.from);
  const journal = readJournal(record);
  const journalCandidate = journal.ok
    ? journal.value.entries.find(
        (entry) => entry.transition_id === request.transition_id,
      )
    : undefined;
  const journalItem =
    journalCandidate?.request_digest === immutableDigest(request) &&
    journalCandidate.bootstrap_request_digest ===
      request.bootstrap_request.digest
      ? journalCandidate
      : undefined;
  const routeBindingValid = exactRouteBindingReceipt(request, journalItem);
  const archiveValid =
    successionValid &&
    succession !== null &&
    exactRetirementReceipt(request, record, journalItem, succession);
  const archiveRef = archiveValid ? (journalItem?.archive_ref ?? null) : null;
  const sourceQuiescenceReceipt = journalItem?.source_quiescence_receipt;
  const transferQuiescenceReceipt = journalItem?.transfer_quiescence_receipt;
  const loadedBootstrap = loadVisibleBootstrapRequest(
    request.bootstrap_request.ref,
  );
  const bootstrapReservation = loadedBootstrap.ok
    ? (record.launch_reservations ?? []).find(
        (entry) =>
          bootstrapData(entry)['request_id'] ===
          loadedBootstrap.value.request.request_id,
      )
    : undefined;
  const bootstrapReservationData =
    bootstrapReservation === undefined
      ? {}
      : bootstrapData(bootstrapReservation);
  const bootstrapCompleted =
    bootstrapReservation?.phase === 'completed' &&
    ['submitted', 'already_recorded'].includes(
      String(bootstrapReservation.outcome),
    ) &&
    bootstrapReservationData['phase'] === 'completed';
  const stage: SessionTransitionStage = archiveValid
    ? 'task_retired'
    : successionValid
      ? 'first_work_recorded'
      : succession !== null
        ? 'unknown'
        : handoff?.state === 'completed'
          ? 'awaiting_first_work'
          : handoff?.state === 'receiver_confirmed'
            ? 'receiver_confirmed'
            : handoff?.state === 'transferring'
              ? bootstrapReservation === undefined
                ? 'prepared'
                : bootstrapCompleted
                  ? 'awaiting_receiver_ack'
                  : 'successor_bootstrap'
              : handoff?.state === 'old_writer_stopped'
                ? 'prepared'
                : handoff?.state === 'requested'
                  ? 'awaiting_quiescence'
                  : intent !== null
                    ? 'intent_created'
                    : 'not_started';
  return {
    schema: COLLAB_SESSION_TRANSITION_REPORT_SCHEMA,
    action,
    ok: status === 'planned' || status === 'progressed' || status === 'waiting',
    status,
    code: null,
    message: null,
    next_action: null,
    task_id: record.task_id,
    task_root: request.task_root,
    state_revision: record.state_revision,
    transition_id: request.transition_id,
    cause_ref: `rollover:${record.task_id}:${request.transition_id}`,
    stage,
    intent:
      intent === null
        ? null
        : {
            intent_id: intent.intent_id,
            generation: intent.generation,
            handoff_id: intent.handoff_id,
            subtask_id: intent.subtask_id,
            attempt: intent.attempt,
            input_revision: intent.input_revision,
            from: intent.from,
            to: intent.to,
            source_native: intent.source_native,
            successor_native: intent.successor_native ?? null,
            transfer_boundary: intent.transfer_boundary ?? null,
          },
    handoff:
      handoff === null
        ? null
        : {
            handoff_id: handoff.handoff_id,
            state: handoff.state,
            from: handoff.from,
            to: handoff.to,
            owner_epoch: handoff.owner_epoch,
          },
    rollover: rolloverReport,
    bootstrap: bootstrapReport,
    receiver_ack: handoff?.confirmation_message_id
      ? { message_id: handoff.confirmation_message_id, status: 'confirmed' }
      : null,
    transfer: intent?.transfer_boundary
      ? {
          status: 'core-transfer-recorded',
          boundary: intent.transfer_boundary,
          claim_count: request.intent.claims.length,
          source_quiescence_receipt: exactQuiescenceReceipt(
            request,
            sourceQuiescenceReceipt,
          )
            ? sourceQuiescenceReceipt
            : null,
          transfer_quiescence_receipt: exactQuiescenceReceipt(
            request,
            transferQuiescenceReceipt,
          )
            ? transferQuiescenceReceipt
            : null,
        }
      : null,
    first_work:
      succession === null
        ? null
        : successionValid
          ? {
              status: 'core-first-work-recorded',
              message_id: succession.proof.message_id,
              digest: succession.proof.digest,
            }
          : {
              status: 'succession-reconcile-required',
              message_id: succession.proof.message_id,
              digest: succession.proof.digest,
            },
    route_transfer: intent?.transfer_boundary
      ? {
          status: routeBindingValid
            ? 'successor-binding-written'
            : journalItem?.route_binding_ref
              ? 'successor-binding-reconcile-required'
              : 'task-assignee-and-claims-transferred',
          binding_ref: journalItem?.route_binding_ref ?? null,
          binding_digest: journalItem?.route_binding_digest ?? null,
          notification_route_exclusion: routeExclusion.state,
        }
      : null,
    archive:
      succession === null
        ? null
        : {
            status: !successionValid
              ? 'succession-reconcile-required'
              : archiveValid
                ? 'task-retirement-marker-recorded'
                : journalItem?.archive_ref
                  ? 'task-retirement-reconcile-required'
                  : 'task-history-retained',
            ref: archiveValid ? archiveRef : (journalItem?.archive_ref ?? null),
            digest: archiveValid ? (journalItem?.archive_digest ?? null) : null,
            native_archive: 'unavailable',
            original_transcript: 'retained-in-place',
            reversible: true,
          },
    host:
      hostObservation === null
        ? null
        : {
            session_id: hostObservation.session_id,
            cwd: hostObservation.cwd,
            pane_id: hostObservation.pane_id,
            proof_support: hostObservation.proof_support,
            proof_code: hostObservation.unavailable_code,
            freeze_active: hostObservation.freeze_status?.frozen ?? false,
            native_facts: hostObservation.native_facts,
            process_affiliation: 'not-established',
          },
    steps,
    capabilities: {
      record_reducer: 'available',
      bootstrap: 'available',
      pi_host_extension: hostObservation === null ? 'not_loaded' : 'available',
      supported_quiescence:
        hostObservation?.proof_support === 'available'
          ? 'available'
          : hostObservation === null
            ? 'unknown'
            : 'unavailable',
      native_session_archive: 'unavailable',
      task_retirement_archive: 'available',
      task_route_transfer: 'available',
      notification_route_exclusion: routeExclusion.state,
    },
    limits: LIMITATIONS,
    ...extra,
  };
}

function failureReport(
  action: SessionTransitionAction,
  request: SessionTransitionRequest,
  status: SessionTransitionStatus,
  code: string,
  message: string,
  nextAction: string | null,
  task: OpenedTaskStore | null = null,
  details: Partial<SessionTransitionReport> = {},
): SessionTransitionReport {
  const base =
    task === null
      ? emptyReport(action, request, status, null, null)
      : reportForContext(
          action,
          request,
          task.record,
          null,
          null,
          null,
          [],
          status,
        );
  return {
    ...base,
    ok: false,
    status,
    code,
    message,
    next_action: nextAction,
    ...details,
  };
}

function bootstrapExecutor(
  dependencies: SessionTransitionDependencies,
): SessionTransitionBootstrapExecutor {
  if (dependencies.bootstrap !== undefined) return dependencies.bootstrap;
  return {
    plan: (request) =>
      planVisibleBootstrap(request, dependencies.bootstrapDependencies),
    apply: (request) =>
      applyVisibleBootstrap(request, dependencies.bootstrapDependencies),
  };
}

function validateBootstrapTransition(
  request: SessionTransitionRequest,
  bootstrap: LoadedVisibleBootstrapRequest,
  contact: RegisteredMessage,
  record: TaskRecord,
): TransitionFailure | null {
  const next = bootstrap.request;
  if (
    !safePathEqual(next.task_root, request.task_root) ||
    next.target.choice !== 'sibling' ||
    next.participant.agent_id !== request.intent.to.agent_id ||
    next.participant.native_session_selector !== request.intent.to.session_id ||
    next.participant.harness !== request.intent.to.harness ||
    next.target.cwd !== request.intent.to.cwd ||
    next.admission.subtask_id !== request.intent.subtask_id ||
    next.admission.attempt !== request.intent.attempt ||
    next.admission.input_revision !== request.intent.input_revision ||
    next.binding_ref === undefined
  )
    return failure(
      'invalid',
      'bootstrap_transition_mismatch',
      'Successor bootstrap identity, attempt, cwd or binding does not match the transition.',
      null,
    );
  const bindingFile = readTaskLocalFile(
    next.binding_ref,
    record.task_root,
    64 * 1024,
  );
  if (!bindingFile.ok)
    return failure(
      'needs_input',
      'bootstrap_binding_unavailable',
      'The exact source routing binding is missing, unreadable or outside the task root.',
      'Provide one bounded task-local pappra/collab-binding/1 file; no focus-based fallback is allowed.',
    );
  let bindingValue: unknown;
  try {
    bindingValue = JSON.parse(bindingFile.bytes.toString('utf8')) as unknown;
  } catch {
    return failure(
      'invalid',
      'bootstrap_binding_invalid',
      'The source routing binding is not valid JSON.',
      null,
    );
  }
  const binding = collabBindingSchema.safeParse(bindingValue);
  if (
    !binding.success ||
    binding.data.task_id !== record.task_id ||
    !safePathEqual(binding.data.task_root, record.task_root)
  )
    return failure(
      'needs_input',
      'bootstrap_binding_invalid',
      'The source routing binding schema or task identity does not match.',
      'Reconcile the task-local binding before transition.',
    );
  const sourceParticipants = binding.data.participants.filter(
    (participant) => participant.agent_id === request.intent.from.agent_id,
  );
  if (
    sourceParticipants.length !== 1 ||
    sourceParticipants[0]!.harness !== request.intent.from.harness ||
    sourceParticipants[0]!.native_session_id !==
      request.intent.from.session_id ||
    !safePathEqual(sourceParticipants[0]!.cwd, request.intent.from.cwd ?? '') ||
    (next.caller.pane_id !== null &&
      sourceParticipants[0]!.pane_id !== next.caller.pane_id) ||
    binding.data.participants.some(
      (participant) => participant.agent_id === request.intent.to.agent_id,
    )
  )
    return failure(
      'needs_input',
      'bootstrap_source_binding_mismatch',
      'The task-local binding does not uniquely identify the pinned caller or already contains the sibling successor.',
      'Reconcile the exact source/successor binding; no focus or silent reuse fallback is allowed.',
    );
  const message = contact.message;
  if (
    contact.digest !== next.message_pointer.content_digest ||
    contact.file !== next.message_pointer.content_ref ||
    !parseRegisteredMessageEntry(record, contact)
  )
    return failure(
      'needs_input',
      'bootstrap_pointer_not_registered',
      'Bootstrap pointer is not the exact registered message file/content.',
      'Register and apply a task-local transition status pointer before launching the successor.',
    );
  if (
    message.type !== 'STATUS' ||
    message.task_id !== record.task_id ||
    message.subtask_id !== request.intent.subtask_id ||
    message.attempt !== request.intent.attempt ||
    message.owner_epoch !== request.intent.coordinator_epoch ||
    !sameHarnessIdentity(message.from, request.intent.from) ||
    !sameHarnessIdentity(message.to, request.intent.to) ||
    message.body?.['handoff_id'] !== request.intent.handoff_id ||
    message.body?.['rollover_intent_id'] !== request.intent.intent_id ||
    message.body?.['rollover_generation'] !== request.intent.generation ||
    message.body?.['input_revision'] !== request.intent.input_revision
  )
    return failure(
      'needs_input',
      'bootstrap_pointer_correlation_mismatch',
      'Registered STATUS pointer does not correlate to the exact transition.',
      'Register a STATUS pointer with matching identities, handoff, generation and input.',
    );
  return null;
}

async function loadContext(
  input: LoadedSessionTransitionRequest | SessionTransitionRequest,
): Promise<
  { readonly ok: true; readonly value: TransitionContext } | TransitionFailure
> {
  const request = requestOf(input);
  const requestDigest = immutableDigestOf(input);
  const task = await openTaskStore(request.task_root);
  if (!task.ok)
    return failure('needs_input', task.code, task.message, task.nextAction);
  if (!safePathEqual(task.value.taskRoot, request.task_root))
    return failure(
      'invalid',
      'task_root_mismatch',
      'Request task_root is not the canonical task root.',
      'Use the canonical task root.',
    );
  const loadedBootstrap = loadVisibleBootstrapRequest(
    request.bootstrap_request.ref,
  );
  if (!loadedBootstrap.ok)
    return failure(
      'invalid',
      loadedBootstrap.code,
      loadedBootstrap.message,
      null,
    );
  if (loadedBootstrap.value.digest !== request.bootstrap_request.digest)
    return failure(
      'invalid',
      'bootstrap_request_digest_mismatch',
      'The pinned bootstrap request digest changed.',
      null,
    );
  if (loadedBootstrap.value.request.managed_runtime) {
    try {
      verifyManagedPiSdkInstallation(
        loadedBootstrap.value.request.managed_runtime.sdk_module_path,
      );
    } catch {
      return failure(
        'needs_input',
        'successor_sdk_incompatible',
        'The successor SDK is unavailable or incompatible; no source freeze was attempted.',
        'Select a supported SDK installation and re-plan before freezing the source.',
      );
    }
  }
  const messageTask = await openMessageTask(task.value.taskRoot);
  if (!messageTask.ok)
    return failure(
      'needs_input',
      messageTask.code,
      messageTask.message,
      messageTask.nextAction,
    );
  const contact = await readRegisteredMessageSafe(
    messageTask.value,
    loadedBootstrap.value.request.message_pointer.message_id,
  );
  if (!contact.ok)
    return failure(
      'needs_input',
      contact.code,
      contact.message,
      contact.nextAction,
    );
  const transitionCheck = validateBootstrapTransition(
    request,
    loadedBootstrap.value,
    contact.value,
    task.value.record,
  );
  if (transitionCheck !== null) return transitionCheck;
  const changed = await assertTaskStoreCurrent(task.value);
  if (changed !== null)
    return failure(
      'needs_input',
      changed.code,
      changed.message,
      changed.nextAction,
    );
  return {
    ok: true,
    value: {
      request,
      requestDigest,
      task: task.value,
      bootstrap: loadedBootstrap.value,
      contactMessage: contact.value,
    },
  };
}

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

function validatePreflight(context: TransitionContext, now: number) {
  const attempt = findAttempt(
    context.task.record,
    context.request.intent.subtask_id,
    context.request.intent.attempt,
  );
  if (
    attempt === null ||
    attempt.assignment_ref === null ||
    attempt.assignment_ref === undefined
  )
    return {
      ok: false as const,
      code: 'assignment_missing',
      message: 'Current attempt has no assignment reference.',
    };
  let assignmentFile: string;
  try {
    assignmentFile = readManagedSourceAssignment(
      context.task.record,
      attempt,
      context.request.intent.from,
    ).file;
  } catch {
    return {
      ok: false as const,
      code: 'source_admission_unverified',
      message:
        'The source assignment does not match its immutable admission lineage.',
    };
  }
  const result = runCollaborationPreflight({
    assignmentFile,
    capabilitiesFile: context.bootstrap.request.admission.capability_card_ref,
    maxAgeMinutes: 30,
    now,
  });
  return result.status === 'ready'
    ? { ok: true as const, report: result }
    : {
        ok: false as const,
        code:
          result.blockers[0]?.code ?? result.errors[0] ?? 'admission_not_ready',
        message: `Current collaboration preflight is ${result.status}.`,
      };
}

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

export type SessionTransitionEffectName =
  'source-freeze' | 'successor-route-binding' | 'task-retirement-marker';

type EffectJournalFailure = {
  readonly ok: false;
  readonly kind: 'invalid' | 'needs_input';
  readonly code: string;
  readonly message: string;
  readonly nextAction: string | null;
};

type EffectJournalSuccess = {
  readonly ok: true;
  readonly task: OpenedTaskStore;
  readonly replayed: boolean;
};

function effectPhase(
  name: SessionTransitionEffectName,
): 'source' | 'successor' | 'retired' {
  if (name === 'source-freeze') return 'source';
  if (name === 'successor-route-binding') return 'successor';
  return 'retired';
}

async function recordEffectIntent(
  context: TransitionContext,
  currentTask: OpenedTaskStore,
  name: SessionTransitionEffectName,
  now: () => number,
  signal?: AbortSignal,
): Promise<EffectJournalSuccess | EffectJournalFailure> {
  if (signal?.aborted)
    return {
      ok: false,
      kind: 'needs_input',
      code: 'abort_requested',
      message:
        'The transition was aborted before the effect intent was committed.',
      nextAction: 'Reconcile the current task before a new explicit apply.',
    };
  const current = await assertTaskStoreCurrent(currentTask);
  if (current !== null)
    return {
      ok: false,
      kind: 'needs_input',
      code: current.code,
      message: current.message,
      nextAction: current.nextAction,
    };
  if (
    hasJournalConflict(
      currentTask.record,
      context.request,
      context.requestDigest,
    )
  )
    return {
      ok: false,
      kind: 'invalid',
      code: 'transition_journal_conflict',
      message:
        'The durable journal is invalid or pins different immutable request inputs.',
      nextAction: 'Inspect the task record; do not perform the effect.',
    };
  const journal = journalEntry(
    currentTask.record,
    context.request,
    context.requestDigest,
  );
  if (journal === null)
    return {
      ok: false,
      kind: 'needs_input',
      code: 'transition_journal_missing',
      message: 'The transition effect has no matching durable intent journal.',
      nextAction: 'Inspect the task record before any effect.',
    };
  const prior = journal.effects[name];
  if (prior !== undefined) {
    if (prior.state === 'completed')
      return { ok: true, task: currentTask, replayed: true };
    return {
      ok: false,
      kind: 'needs_input',
      code:
        prior.state === 'failed'
          ? `${name.replaceAll('-', '_')}_failed`
          : `${name.replaceAll('-', '_')}_reconcile_required`,
      message: `The ${name} effect already has a ${prior.state} journal receipt; it will not be replayed.`,
      nextAction:
        'Reconcile the exact host/file effect and journal before continuing.',
    };
  }
  const outcome = transact(currentTask.taskRoot, {
    actor: context.request.intent.from.agent_id,
    purpose: `session-transition:${name}:intent`,
    expectRevision: currentTask.record.state_revision,
    clock: now(),
    apply: (record) => {
      if (signal?.aborted)
        return { ok: false as const, reason: 'abort_requested' };
      const drift = currentStateDrift(
        record,
        context.request,
        effectPhase(name),
      );
      if (drift !== null) return { ok: false as const, reason: drift.code };
      if (hasJournalConflict(record, context.request, context.requestDigest))
        return { ok: false as const, reason: 'transition_journal_conflict' };
      const entry = journalEntry(
        record,
        context.request,
        context.requestDigest,
      );
      if (entry === null)
        return { ok: false as const, reason: 'transition_journal_missing' };
      if (entry.effects[name] !== undefined)
        return { ok: false as const, reason: 'effect_intent_raced' };
      const saved = setJournalEffect(record, context.request.transition_id, {
        name,
        state: 'pending',
        at: nowIso(now),
      });
      if (!saved.ok) return { ok: false as const, reason: saved.code };
      return {
        record,
        op: 'session-transition-effect-intent',
        summary: { transition_id: context.request.transition_id, effect: name },
        result: { effect: name, state: 'pending' },
      };
    },
  });
  if (!outcome.ok)
    return {
      ok: false,
      kind: 'needs_input',
      code: outcome.reason,
      message: 'The durable effect intent was not committed.',
      nextAction:
        'Re-read current task authority and journal before any retry.',
    };
  const savedTask = await openTaskStore(currentTask.taskRoot);
  if (!savedTask.ok)
    return {
      ok: false,
      kind: 'needs_input',
      code: savedTask.code,
      message: savedTask.message,
      nextAction: savedTask.nextAction,
    };
  const savedJournal = journalEntry(
    savedTask.value.record,
    context.request,
    context.requestDigest,
  );
  if (savedJournal?.effects[name]?.state !== 'pending')
    return {
      ok: false,
      kind: 'needs_input',
      code: 'effect_intent_unconfirmed',
      message:
        'The effect-intent transaction returned without a matching durable pending receipt.',
      nextAction: 'Inspect the task journal; do not invoke the effect.',
    };
  return { ok: true, task: savedTask.value, replayed: false };
}

async function recordEffectOutcome(
  context: TransitionContext,
  currentTask: OpenedTaskStore,
  name: SessionTransitionEffectName,
  state: 'completed' | 'failed' | 'unknown',
  clock: number,
  code: string | null,
  options: {
    readonly digest?: string;
    readonly ref?: string;
    readonly artifact?: 'route-binding' | 'task-retirement';
  } = {},
): Promise<
  | { readonly ok: true; readonly task: OpenedTaskStore }
  | { readonly ok: false; readonly code: string }
> {
  const current = await assertTaskStoreCurrent(currentTask);
  if (current !== null) return { ok: false, code: current.code };
  const outcome = transact(currentTask.taskRoot, {
    actor: context.request.intent.from.agent_id,
    purpose: `session-transition:${name}:outcome`,
    expectRevision: currentTask.record.state_revision,
    clock,
    apply: (record) => {
      if (
        !isTaskRecord(record) ||
        record.task_id !== path.basename(context.request.task_root) ||
        !safePathEqual(record.task_root, context.request.task_root)
      )
        return { ok: false as const, reason: 'task_namespace_changed' };
      if (hasJournalConflict(record, context.request, context.requestDigest))
        return { ok: false as const, reason: 'transition_journal_conflict' };
      const journal = journalEntry(
        record,
        context.request,
        context.requestDigest,
      );
      if (journal === null)
        return { ok: false as const, reason: 'transition_journal_missing' };
      const prior = journal.effects[name];
      if (prior === undefined)
        return { ok: false as const, reason: 'effect_intent_missing' };
      if (prior.state === state) {
        const same =
          (options.digest === undefined || prior.digest === options.digest) &&
          (options.ref === undefined || prior.ref === options.ref) &&
          (code === null || prior.code === code);
        if (!same)
          return { ok: false as const, reason: 'effect_outcome_conflict' };
        return {
          record,
          op: 'session-transition-effect-outcome-replay',
          summary: {
            transition_id: context.request.transition_id,
            effect: name,
            state,
          },
          result: { effect: name, state, replayed: true },
        };
      }
      if (prior.state !== 'pending' && prior.state !== 'unknown')
        return { ok: false as const, reason: 'effect_outcome_conflict' };
      const saved = setJournalEffect(record, context.request.transition_id, {
        name,
        state,
        at: new Date(clock).toISOString(),
        ...(code === null ? {} : { code }),
        ...(options.digest === undefined ? {} : { digest: options.digest }),
        ...(options.ref === undefined ? {} : { ref: options.ref }),
        ...(options.artifact === undefined
          ? {}
          : { artifact: options.artifact }),
      });
      if (!saved.ok) return { ok: false as const, reason: saved.code };
      return {
        record,
        op: 'session-transition-effect-outcome',
        summary: {
          transition_id: context.request.transition_id,
          effect: name,
          state,
        },
        result: { effect: name, state, replayed: false },
      };
    },
  });
  if (!outcome.ok) return { ok: false, code: outcome.reason };
  const savedTask = await openTaskStore(currentTask.taskRoot);
  if (!savedTask.ok) return { ok: false, code: savedTask.code };
  const savedJournal = journalEntry(
    savedTask.value.record,
    context.request,
    context.requestDigest,
  );
  const savedEffect = savedJournal?.effects[name];
  if (
    savedEffect?.state !== state ||
    (options.digest !== undefined && savedEffect.digest !== options.digest) ||
    (options.ref !== undefined && savedEffect.ref !== options.ref)
  )
    return { ok: false, code: 'effect_outcome_unconfirmed' };
  return { ok: true, task: savedTask.value };
}

export async function planSessionTransition(
  input: LoadedSessionTransitionRequest | SessionTransitionRequest,
  dependencies: SessionTransitionDependencies = {},
): Promise<SessionTransitionReport> {
  const request = requestOf(input);
  const context = await loadContext(input);
  if (!context.ok)
    return failureReport(
      'plan',
      request,
      context.kind === 'invalid' ? 'invalid' : 'needs_input',
      context.code,
      context.message,
      context.nextAction,
    );
  const now = dependencies.clock ?? Date.now;
  const handoffAtRead = getHandoff(
    context.value.task.record,
    request.intent.handoff_id,
  );
  if (
    handoffAtRead?.state !== 'receiver_confirmed' &&
    handoffAtRead?.state !== 'completed'
  ) {
    const preflight = validatePreflight(context.value, now());
    if (!preflight.ok)
      return failureReport(
        'plan',
        request,
        'needs_input',
        preflight.code,
        preflight.message,
        'Refresh the exact current assignment/card evidence; no transition effect was attempted.',
        context.value.task,
      );
  }
  const rolloverResult = await inspectOrPlanRollover(
    buildRolloverRequest(request, context.value.task.record),
  );
  if (!rolloverResult.ok)
    return failureReport(
      'plan',
      request,
      'needs_input',
      rolloverResult.code,
      rolloverResult.message,
      rolloverResult.nextAction,
      context.value.task,
    );
  let bootstrap: VisibleBootstrapReport;
  try {
    bootstrap = await bootstrapExecutor(dependencies).plan(
      context.value.bootstrap,
    );
  } catch {
    return failureReport(
      'plan',
      request,
      'unknown',
      'bootstrap_plan_failed',
      'The read-only bootstrap planner did not return a report.',
      'Reconcile the exact bootstrap request and current task; no transition effect was attempted.',
      context.value.task,
    );
  }
  const changed = await assertTaskStoreCurrent(context.value.task);
  if (changed !== null)
    return failureReport(
      'plan',
      request,
      'needs_input',
      changed.code,
      changed.message,
      changed.nextAction,
      context.value.task,
    );
  let hostObservation: SessionTransitionHostObservation | null = null;
  if (dependencies.host !== undefined) {
    try {
      hostObservation = await dependencies.host.observe();
    } catch {
      return failureReport(
        'plan',
        request,
        'needs_input',
        'host_observation_unavailable',
        'The opt-in Pi host did not return an observation.',
        'Re-read the exact session/cwd and host status; planning did not attempt a transition effect.',
        context.value.task,
      );
    }
    const identityIssue = hostIdentityFailure(hostObservation, request);
    if (identityIssue !== null)
      return failureReport(
        'plan',
        request,
        'needs_input',
        identityIssue.code,
        identityIssue.message,
        identityIssue.nextAction,
        context.value.task,
        { host: { id: dependencies.host.id, ...hostObservation } },
      );
    const changedAfterHost = await assertTaskStoreCurrent(context.value.task);
    if (changedAfterHost !== null)
      return failureReport(
        'plan',
        request,
        'needs_input',
        changedAfterHost.code,
        changedAfterHost.message,
        changedAfterHost.nextAction,
        context.value.task,
        { host: { id: dependencies.host.id, ...hostObservation } },
      );
  }
  const refreshed = await openTaskStore(request.task_root);
  if (!refreshed.ok)
    return failureReport(
      'plan',
      request,
      'needs_input',
      refreshed.code,
      refreshed.message,
      refreshed.nextAction,
      context.value.task,
    );
  const existingIntent = getIntent(
    refreshed.value.record,
    request.intent.intent_id,
  );
  const handoff = getHandoff(refreshed.value.record, request.intent.handoff_id);
  const drift = currentStateDrift(
    refreshed.value.record,
    request,
    handoff?.state === 'completed' ? 'successor' : 'source',
  );
  const steps = plannedSteps(
    rolloverResult.value,
    bootstrap,
    hostObservation,
    existingIntent !== null,
    handoff?.state ?? null,
  );
  const report = reportForContext(
    'plan',
    request,
    refreshed.value.record,
    rolloverResult.value,
    bootstrap,
    hostObservation,
    steps,
    'planned',
  );
  return drift === null
    ? report
    : {
        ...report,
        ok: false,
        status: 'needs_input',
        code: drift.code,
        message: drift.message,
        next_action: 'Reconcile current attempt/claims/epoch before applying.',
      };
}

export async function applySessionTransition(
  input: LoadedSessionTransitionRequest | SessionTransitionRequest,
  dependencies: SessionTransitionDependencies = {},
): Promise<SessionTransitionReport> {
  const request = requestOf(input);
  const now = dependencies.clock ?? Date.now;
  const context = await loadContext(input);
  if (!context.ok)
    return failureReport(
      'apply',
      request,
      context.kind === 'invalid' ? 'invalid' : 'needs_input',
      context.code,
      context.message,
      context.nextAction,
    );
  const existingHandoff = getHandoff(
    context.value.task.record,
    request.intent.handoff_id,
  );
  if (existingHandoff?.state !== 'completed') {
    const scopeDrift = managedExecutionScopeDrift(
      request,
      context.value.task.record,
    );
    if (scopeDrift !== null)
      return failureReport(
        'apply',
        request,
        'needs_input',
        scopeDrift.code,
        scopeDrift.message,
        'Rebind only after the authoritative task, attempt, owner epoch and claim pins are reconciled; no transition effect was attempted.',
        context.value.task,
      );
  }
  if (existingHandoff?.state === 'completed') {
    const drift = currentStateDrift(
      context.value.task.record,
      request,
      'successor',
    );
    if (drift !== null)
      return failureReport(
        'apply',
        request,
        'needs_input',
        drift.code,
        drift.message,
        'Reconcile successor authority, attempt and claim epochs before first-work or retirement.',
        context.value.task,
      );
    return applyFirstWorkAndRetirement(
      context.value,
      context.value.task,
      null,
      dependencies,
      now,
    );
  }
  if (existingHandoff?.state !== 'receiver_confirmed') {
    const preflight = validatePreflight(context.value, now());
    if (!preflight.ok)
      return failureReport(
        'apply',
        request,
        'needs_input',
        preflight.code,
        preflight.message,
        'Refresh the matching current assignment/card and re-plan.',
        context.value.task,
      );
  }
  if (dependencies.host === undefined) {
    const currentIntent = getIntent(
      context.value.task.record,
      request.intent.intent_id,
    );
    return failureReport(
      'apply',
      request,
      'needs_input',
      'pi_transition_host_required',
      'Effectful transition requires the explicitly loaded Pi session-transition host adapter; CLI-only metadata is not quiescence proof.',
      'Load the opt-in Pi extension and invoke its transition command; no freeze, bootstrap, transfer or archive was performed.',
      context.value.task,
      {
        stage: currentIntent === null ? 'not_started' : 'intent_created',
        intent:
          currentIntent === null
            ? null
            : { intent_id: currentIntent.intent_id },
        capabilities: {
          ...capabilities(null),
          pi_host_extension: 'not_loaded',
        },
      },
    );
  }
  let hostBefore: SessionTransitionHostObservation;
  try {
    hostBefore = await dependencies.host.observe();
  } catch {
    return failureReport(
      'apply',
      request,
      'needs_input',
      'host_observation_unavailable',
      'The opt-in Pi host did not return a current observation.',
      'Reconcile exact source session/cwd and controller status; no transition effect was attempted.',
      context.value.task,
    );
  }
  const changedAfterHostRead = await assertTaskStoreCurrent(context.value.task);
  if (changedAfterHostRead !== null)
    return failureReport(
      'apply',
      request,
      'needs_input',
      changedAfterHostRead.code,
      changedAfterHostRead.message,
      changedAfterHostRead.nextAction,
      context.value.task,
      { host: { id: dependencies.host.id, ...hostBefore } },
    );
  const identityIssue = hostIdentityFailure(hostBefore, request);
  if (identityIssue !== null)
    return failureReport(
      'apply',
      request,
      'needs_input',
      identityIssue.code,
      identityIssue.message,
      identityIssue.nextAction,
      context.value.task,
      { host: { id: dependencies.host.id, ...hostBefore } },
    );
  const rolloverResult = await inspectOrPlanRollover(
    buildRolloverRequest(request, context.value.task.record),
  );
  if (!rolloverResult.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      rolloverResult.code,
      rolloverResult.message,
      rolloverResult.nextAction,
      context.value.task,
      { host: { id: dependencies.host.id, ...hostBefore } },
    );
  const existing = getIntent(
    context.value.task.record,
    request.intent.intent_id,
  );
  const blockingDrift = rolloverResult.value.drift.find(
    (item) => !(existing === null && item.code === 'unknown_handoff'),
  );
  if (blockingDrift !== undefined)
    return failureReport(
      'apply',
      request,
      'needs_input',
      blockingDrift.code,
      blockingDrift.detail,
      'Reconcile task drift before transition effects.',
      context.value.task,
      {
        rollover: rolloverResult.value,
        host: { id: dependencies.host.id, ...hostBefore },
      },
    );
  if (
    existing !== null &&
    !sameIntentRequest(existing, request.intent, request)
  )
    return failureReport(
      'apply',
      request,
      'invalid',
      'intent_input_conflict',
      'The transition id is already pinned to different immutable inputs.',
      'Choose a new transition id only after reconciling the existing handoff.',
      context.value.task,
    );
  if (existing === null) {
    const created = await intentTransaction(context.value, dependencies, now);
    if (!created.ok)
      return failureReport(
        'apply',
        request,
        'needs_input',
        created.reason,
        'The durable rollover intent could not be committed.',
        'Re-read current task revision/claims and reconcile before retrying.',
        context.value.task,
        { host: { id: dependencies.host.id, ...hostBefore } },
      );
  }
  const currentTask = await openTaskStore(request.task_root);
  if (!currentTask.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      currentTask.code,
      currentTask.message,
      currentTask.nextAction,
      context.value.task,
    );
  const currentIntent = getIntent(
    currentTask.value.record,
    request.intent.intent_id,
  );
  if (
    currentIntent === null ||
    !sameIntentRequest(currentIntent, request.intent, request)
  )
    return failureReport(
      'apply',
      request,
      'unknown',
      'intent_reconcile_required',
      'The intent commit could not be confirmed from the current record.',
      'Inspect the authoritative task record; no native effect was attempted.',
      currentTask.value,
      { host: { id: dependencies.host.id, ...hostBefore } },
    );
  const handoff = getHandoff(
    currentTask.value.record,
    request.intent.handoff_id,
  );
  if (handoff === null)
    return failureReport(
      'apply',
      request,
      'unknown',
      'handoff_missing',
      'The rollover intent is recorded but its handoff is missing.',
      'Inspect the task record; do not create a second handoff.',
      currentTask.value,
    );

  if (handoff.state === 'requested') {
    if (hostBefore.proof_support !== 'available') {
      const currentRollover = await inspectOrPlanRollover(
        buildRolloverRequest(request, currentTask.value.record),
      );
      const blocker =
        hostBefore.unavailable_code ?? 'host_stop_proof_unavailable';
      const detail =
        hostBefore.detail ??
        'No accepted host can produce complete native quiescence proof.';
      return failureReport(
        'apply',
        request,
        'waiting',
        blocker,
        detail,
        'Do not infer stop from idle, settled events, a freeze latch, or transcript data. Wait for the accepted session-bound native proof API; no source freeze, successor bootstrap, or transfer was attempted.',
        currentTask.value,
        {
          stage: 'awaiting_quiescence',
          intent: {
            intent_id: currentIntent.intent_id,
            generation: currentIntent.generation,
            handoff_id: currentIntent.handoff_id,
          },
          handoff: { handoff_id: handoff.handoff_id, state: handoff.state },
          rollover: currentRollover.ok ? currentRollover.value : null,
          host: { id: dependencies.host.id, ...hostBefore },
          steps: [
            step('create-intent', 'satisfied'),
            step('source-quiescence', 'unavailable', blocker, detail),
            step(
              'successor-bootstrap',
              'blocked',
              'predecessor_step_unavailable',
              'Bootstrap cannot start until source quiescence is supported.',
            ),
            step(
              'receiver-ack',
              'blocked',
              'predecessor_step_unavailable',
              'No successor was started.',
            ),
            step(
              'claim-route-transfer',
              'blocked',
              'predecessor_step_unavailable',
              'Claims and assignment remain with the source.',
            ),
            step(
              'first-work',
              'blocked',
              'predecessor_step_unavailable',
              'No successor work is authorized.',
            ),
            step(
              'task-retirement',
              'blocked',
              'predecessor_step_unavailable',
              'Retirement is forbidden before validated first work.',
            ),
          ],
          capabilities: capabilities(hostBefore),
        },
      );
    }
    const prepared = await freezeAndPrepare(
      context.value,
      currentTask.value,
      hostBefore,
      dependencies,
      now,
    );
    return prepared.report;
  }

  if (handoff.state === 'transferring') {
    let bootstrapReport: VisibleBootstrapReport;
    try {
      bootstrapReport = await bootstrapExecutor(dependencies).apply(
        context.value.bootstrap,
      );
    } catch {
      return failureReport(
        'apply',
        request,
        'unknown',
        'bootstrap_outcome_unknown',
        'The successor bootstrap executor did not return a durable result.',
        'Inspect the exact bootstrap reservation, pane, binding and notification receipt; never repeat an ambiguous launch or prompt.',
        currentTask.value,
      );
    }
    const afterBootstrap = await openTaskStore(request.task_root);
    if (!afterBootstrap.ok)
      return failureReport(
        'apply',
        request,
        'unknown',
        afterBootstrap.code,
        afterBootstrap.message,
        afterBootstrap.nextAction,
        currentTask.value,
        { bootstrap: bootstrapReport },
      );
    const current = getHandoff(
      afterBootstrap.value.record,
      request.intent.handoff_id,
    );
    if (current?.state === 'receiver_confirmed')
      return applyConfirmedTransfer(
        context.value,
        afterBootstrap.value,
        hostBefore,
        dependencies,
        now,
        bootstrapReport,
      );
    if (current?.state !== 'transferring')
      return failureReport(
        'apply',
        request,
        'unknown',
        'handoff_state_changed',
        'Handoff changed during successor bootstrap; inspect before continuing.',
        'Re-read the task record and bootstrap reservation; no further effect was attempted.',
        afterBootstrap.value,
        { bootstrap: bootstrapReport },
      );
    if (
      request.evidence.ack_message_id !== null &&
      (bootstrapReport.status === 'applied' ||
        bootstrapReport.status === 'already_recorded')
    )
      return applyConfirmedTransfer(
        context.value,
        afterBootstrap.value,
        hostBefore,
        dependencies,
        now,
        bootstrapReport,
      );
    const bootstrapComplete =
      bootstrapReport.status === 'applied' ||
      bootstrapReport.status === 'already_recorded';
    return reportForContext(
      'apply',
      request,
      afterBootstrap.value.record,
      null,
      bootstrapReport,
      hostBefore,
      [
        step('create-intent', 'satisfied'),
        step('source-quiescence', 'satisfied'),
        step(
          'successor-bootstrap',
          bootstrapComplete ? 'satisfied' : 'unknown',
          bootstrapReport.code,
          bootstrapReport.message,
        ),
        step(
          'receiver-ack',
          bootstrapComplete ? 'waiting' : 'blocked',
          bootstrapComplete ? null : 'predecessor_step_unavailable',
          'Wait for and register the exact successor ACK; no second prompt or successor start is automatic.',
        ),
        step(
          'claim-route-transfer',
          'blocked',
          'predecessor_step_unavailable',
          'Claims and assignment remain with the source until the correlated ACK.',
        ),
        step(
          'first-work',
          'blocked',
          'predecessor_step_unavailable',
          'Successor first work is not yet authorized.',
        ),
        step(
          'task-retirement',
          'blocked',
          'predecessor_step_unavailable',
          'Retirement follows validated first work.',
        ),
      ],
      bootstrapComplete ? 'waiting' : 'unknown',
      {
        next_action: bootstrapComplete
          ? 'Wait for the exact registered successor ACK and apply once with its message id.'
          : 'Reconcile the durable bootstrap reservation before continuing.',
      },
    );
  }

  if (handoff.state === 'receiver_confirmed') {
    return applyConfirmedTransfer(
      context.value,
      currentTask.value,
      hostBefore,
      dependencies,
      now,
    );
  }
  if (handoff.state === 'completed') {
    return applyFirstWorkAndRetirement(
      context.value,
      currentTask.value,
      hostBefore,
      dependencies,
      now,
    );
  }
  if (handoff.state === 'aborted')
    return failureReport(
      'apply',
      request,
      'needs_input',
      'handoff_aborted',
      'The recorded handoff is aborted and cannot transition.',
      'Create a new explicitly authorized transition only after reconciliation.',
      currentTask.value,
    );
  return failureReport(
    'apply',
    request,
    'unknown',
    'handoff_state_unknown',
    `Handoff is in unsupported state ${handoff.state}.`,
    'Inspect the authoritative record; no automatic recovery is attempted.',
    currentTask.value,
  );
}

function plannedSteps(
  rolloverReport: RolloverReport,
  bootstrapReport: VisibleBootstrapReport,
  host: SessionTransitionHostObservation | null,
  intentFound: boolean,
  handoffState: string | null,
): SessionTransitionStep[] {
  const rollStep = (name: string) =>
    rolloverReport.steps.find((item) => item.step === name);
  const prepared =
    rolloverReport.prepared.recorded ||
    [
      'old-writer-stopped',
      'transferring',
      'receiver-confirmed',
      'completed',
    ].includes(rolloverReport.stage);
  const confirmed =
    handoffState === 'receiver_confirmed' || handoffState === 'completed';
  const transferred = handoffState === 'completed';
  const successionValid = rolloverReport.succession.valid;
  const proofSupported = host?.proof_support === 'available';
  return [
    step(
      'create-intent',
      intentFound
        ? 'satisfied'
        : (rollStep('create-intent')?.status ?? 'blocked'),
      rollStep('create-intent')?.blockers[0]?.code ?? null,
      rollStep('create-intent')?.blockers[0]?.detail ?? null,
    ),
    step(
      'source-quiescence',
      prepared ? 'satisfied' : proofSupported ? 'ready' : 'unavailable',
      prepared
        ? null
        : (host?.unavailable_code ?? 'host_stop_proof_unavailable'),
      prepared
        ? null
        : (host?.detail ??
            'The installed Pi producer does not provide complete, trusted quiescence proof.'),
    ),
    step(
      'successor-bootstrap',
      prepared
        ? bootstrapReport.status === 'planned' ||
          bootstrapReport.status === 'applied' ||
          bootstrapReport.status === 'already_recorded'
          ? bootstrapReport.status === 'planned'
            ? 'ready'
            : 'satisfied'
          : 'blocked'
        : 'blocked',
      prepared ? bootstrapReport.code : 'predecessor_step_unavailable',
      prepared
        ? bootstrapReport.message
        : 'Successor launch is not allowed before source quiescence.',
    ),
    step(
      'receiver-ack',
      confirmed ? 'satisfied' : prepared ? 'waiting' : 'blocked',
      confirmed ? null : prepared ? null : 'predecessor_step_unavailable',
      confirmed
        ? null
        : 'Requires a registered ACK correlated to this exact intent and the original assignment.',
    ),
    step(
      'claim-route-transfer',
      transferred ? 'ready' : confirmed ? 'ready' : 'blocked',
      transferred || confirmed ? null : 'predecessor_step_unavailable',
      transferred
        ? 'Core assignee/claim transfer is recorded; the explicit successor-only route binding still needs reconciliation.'
        : 'Claims and the current task assignee transfer only after the correlated receiver ACK.',
    ),
    step(
      'first-work',
      successionValid ? 'satisfied' : transferred ? 'waiting' : 'blocked',
      successionValid
        ? null
        : transferred
          ? null
          : 'predecessor_step_unavailable',
      successionValid
        ? null
        : 'Requires an admitted completed successor REPORT after the recorded transfer boundary.',
    ),
    step(
      'task-retirement',
      successionValid ? 'ready' : 'blocked',
      successionValid ? null : 'predecessor_step_unavailable',
      successionValid
        ? 'Writes a reversible task-local retirement marker only; native Pi archive is unavailable.'
        : 'Retirement is forbidden before validated first work.',
    ),
  ];
}

function hostIdentityFailure(
  observation: SessionTransitionHostObservation,
  request: SessionTransitionRequest,
): TransitionFailure | null {
  if (observation.session_id !== request.intent.from.session_id)
    return failure(
      'needs_input',
      'source_session_mismatch',
      'The opt-in Pi host is not running in the exact source session.',
      'Load the extension in the task-bound source session; no transition effect was attempted.',
    );
  if (observation.cwd !== request.intent.from.cwd)
    return failure(
      'needs_input',
      'source_cwd_mismatch',
      'The opt-in Pi host cwd does not match the pinned source identity.',
      'Run from the exact task-bound cwd; no transition effect was attempted.',
    );
  if (observation.pane_id !== null && !isText(observation.pane_id, 64))
    return failure(
      'needs_input',
      'source_pane_invalid',
      'The source pane observation is malformed.',
      'Re-read the exact Herdr pane identity; no transition effect was attempted.',
    );
  return null;
}

function proofSupportFailure(
  observation: SessionTransitionHostObservation,
  request: SessionTransitionRequest,
  now: number,
): TransitionFailure | null {
  if (observation.proof_support !== 'available')
    return failure(
      'needs_input',
      observation.unavailable_code ?? 'host_stop_proof_unavailable',
      observation.detail ??
        'The installed Pi host exposes only incomplete/unauthenticated quiescence observations.',
      'Do not infer stop from idle, settled, a freeze latch, or a transcript. Resume only when an accepted session-bound proof adapter is available; no successor was started.',
    );
  const rawProof: unknown = observation.proof;
  const rawFreeze: unknown = observation.freeze_status;
  if (!isRecord(rawProof) || !isRecord(rawFreeze))
    return failure(
      'needs_input',
      'host_quiescence_proof_invalid',
      'The host reported proof support without a complete structured proof and active freeze receipt.',
      'Reconcile the current source session and inventory; no ownership transfer was attempted.',
    );
  const proof = rawProof;
  const tokenValue: unknown = proof['freeze_token'];
  const inventoryValue: unknown = proof['inventory'];
  const freeze = rawFreeze;
  const tokenSnapshotValue: unknown = freeze['token'];
  if (
    !isRecord(tokenValue) ||
    !isRecord(inventoryValue) ||
    !isRecord(tokenSnapshotValue)
  )
    return failure(
      'needs_input',
      'host_quiescence_proof_invalid',
      'The host quiescence receipt is missing its freeze token, inventory or freeze status.',
      'Reconcile the current source session and inventory; no ownership transfer was attempted.',
    );
  const token = tokenValue;
  const inventory = inventoryValue;
  const age = now - Date.parse(String(proof['observed_at'] ?? ''));
  const tokenSnapshot = tokenSnapshotValue;
  const managedScope = request.managed_execution_scope;
  const scopedProofMatches =
    managedScope === undefined
      ? proof['adapter_id'] === 'pappra/pi-session-transition-host/1'
      : isTrustedManagedPiScopedProof(rawProof) &&
        proof['adapter_id'] === MANAGED_PI_SCOPED_PROOF_ADAPTER_ID &&
        proof['scope'] === 'pinned_pi_1_4_owned_runtime' &&
        isRecord(proof['execution_scope']) &&
        canonicalJson(proof['execution_scope']) ===
          canonicalJson(managedScope) &&
        proof['execution_scope_digest'] ===
          digestText(canonicalJson(managedScope)) &&
        Array.isArray(proof['excluded_scope']) &&
        proof['excluded_scope'].length === 2 &&
        proof['excluded_scope'][0] === 'arbitrary_external_writers' &&
        proof['excluded_scope'][1] === 'unowned_processes_and_descendants' &&
        proof['runtime_quiescent'] === true &&
        Array.isArray(proof['runtime_blockers']) &&
        proof['runtime_blockers'].length === 0 &&
        proof['controller_journal_healthy'] === true &&
        isNonNegativeInt(proof['controller_sequence']) &&
        isDigest(proof['controller_head_digest']) &&
        isNonNegativeInt(proof['sequence']) &&
        (proof['sequence'] as number) >=
          (proof['controller_sequence'] as number);
  if (
    !isRecord(tokenSnapshot) ||
    !scopedProofMatches ||
    proof['session_id'] !== request.intent.from.session_id ||
    proof['cwd'] !== request.intent.from.cwd ||
    !isText(proof['observed_at'], 64) ||
    !Number.isFinite(Date.parse(proof['observed_at'])) ||
    age < 0 ||
    age > MAX_QUIESCENCE_AGE_MS ||
    !isText(proof['evidence_ref'], 4096) ||
    !Number.isSafeInteger(proof['sequence']) ||
    (proof['sequence'] as number) < 0 ||
    token['sessionId'] !== request.intent.from.session_id ||
    token['taskId'] !== path.basename(request.task_root) ||
    token['handoffId'] !== request.intent.handoff_id ||
    token['generation'] !== request.intent.generation ||
    freeze['frozen'] !== true ||
    tokenSnapshot['sessionId'] !== token['sessionId'] ||
    tokenSnapshot['taskId'] !== token['taskId'] ||
    tokenSnapshot['handoffId'] !== token['handoffId'] ||
    tokenSnapshot['generation'] !== token['generation'] ||
    inventory['completeness'] !== 'complete' ||
    !Array.isArray(inventory['inflight']) ||
    inventory['inflight'].length !== 0 ||
    !Array.isArray(inventory['pending_approvals']) ||
    inventory['pending_approvals'].length !== 0 ||
    !Array.isArray(inventory['pending_messages']) ||
    inventory['pending_messages'].length !== 0 ||
    (inventory['partial_outputs'] !== undefined &&
      !Array.isArray(inventory['partial_outputs']))
  )
    return failure(
      'needs_input',
      'host_quiescence_proof_invalid',
      'Host quiescence evidence is stale, incomplete, mismatched, or not bound to the active freeze token.',
      'Reconcile the current source session and inventory; no ownership transfer was attempted.',
    );
  return null;
}

function freezeTokenMatches(status: unknown, expected: FreezeToken): boolean {
  if (
    !isRecord(status) ||
    status['frozen'] !== true ||
    !isRecord(status['token'])
  )
    return false;
  const token = status['token'];
  return (
    token['sessionId'] === expected.sessionId &&
    token['taskId'] === expected.taskId &&
    token['handoffId'] === expected.handoffId &&
    token['generation'] === expected.generation
  );
}

function sameFreezeToken(left: FreezeToken, right: FreezeToken): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.taskId === right.taskId &&
    left.handoffId === right.handoffId &&
    left.generation === right.generation
  );
}

function quiescenceInventoryDigest(
  inventory: rollover.RolloverInventory,
): string | null {
  if (
    inventory.completeness !== 'complete' ||
    !Array.isArray(inventory.inflight) ||
    !Array.isArray(inventory.pending_approvals) ||
    !Array.isArray(inventory.pending_messages) ||
    (inventory.partial_outputs !== undefined &&
      !Array.isArray(inventory.partial_outputs))
  )
    return null;
  try {
    return digestText(
      canonicalJson({
        completeness: 'complete',
        inflight: inventory.inflight,
        pending_approvals: inventory.pending_approvals,
        pending_messages: inventory.pending_messages,
        partial_outputs: inventory.partial_outputs ?? [],
      }),
    );
  } catch {
    return null;
  }
}

function quiescenceReceipt(
  proof: SessionTransitionQuiescenceProof,
  inventoryDigest: string,
): SessionTransitionQuiescenceReceipt {
  const scoped = proof.adapter_id === MANAGED_PI_SCOPED_PROOF_ADAPTER_ID;
  return {
    schema: scoped
      ? MANAGED_PI_SCOPED_RECEIPT_SCHEMA
      : 'pappra/session-transition-quiescence-receipt/1',
    adapter_id: proof.adapter_id,
    session_id: proof.session_id,
    cwd: proof.cwd,
    observed_at: proof.observed_at,
    sequence: proof.sequence,
    evidence_ref: proof.evidence_ref,
    freeze_token: { ...proof.freeze_token },
    inventory_digest: inventoryDigest,
    ...(scoped && proof.execution_scope_digest !== undefined
      ? { execution_scope_digest: proof.execution_scope_digest }
      : {}),
  };
}

async function freezeAndPrepare(
  context: TransitionContext,
  currentTask: OpenedTaskStore,
  initialObservation: SessionTransitionHostObservation,
  dependencies: SessionTransitionDependencies,
  now: () => number,
): Promise<
  | { readonly ok: true; readonly report: SessionTransitionReport }
  | { readonly ok: false; readonly report: SessionTransitionReport }
> {
  const request = context.request;
  const host = dependencies.host;
  if (host === undefined)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        'pi_transition_host_required',
        'No opt-in Pi host is connected.',
        'Load the transition extension explicitly; no native effect was attempted.',
        currentTask,
      ),
    };
  const token: FreezeToken = {
    sessionId: request.intent.from.session_id,
    taskId: currentTask.record.task_id,
    handoffId: request.intent.handoff_id,
    generation: request.intent.generation,
  };
  let observation: SessionTransitionHostObservation;
  try {
    observation = await host.observe();
  } catch {
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'unknown',
        'host_observation_unknown',
        'The host observation failed before the source freeze could be reconciled.',
        'Re-read the exact task-bound host and durable journal; no freeze or transfer was attempted.',
        currentTask,
      ),
    };
  }
  const namespace = await assertTaskStoreCurrent(currentTask);
  if (namespace !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        namespace.code,
        namespace.message,
        namespace.nextAction,
        currentTask,
      ),
    };
  const identityIssue = hostIdentityFailure(observation, request);
  if (identityIssue !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        identityIssue.kind,
        identityIssue.code,
        identityIssue.message,
        identityIssue.nextAction,
        currentTask,
        { host: { id: host.id, ...observation } },
      ),
    };
  const scopeDrift = managedExecutionScopeDrift(request, currentTask.record);
  if (scopeDrift !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        scopeDrift.code,
        scopeDrift.message,
        'Reconcile the current task/attempt/claim pins before source freeze; no new effect was attempted.',
        currentTask,
      ),
    };
  if (observation.proof_support !== 'available')
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'waiting',
        observation.unavailable_code ?? 'host_stop_proof_unavailable',
        observation.detail ??
          'No accepted host can produce complete quiescence proof.',
        'Do not freeze or transfer; wait for the supported native proof API.',
        currentTask,
        { host: { id: host.id, ...observation } },
      ),
    };
  if (
    initialObservation.session_id !== observation.session_id ||
    initialObservation.cwd !== observation.cwd
  )
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        'host_identity_changed',
        'The source host identity changed between the initial and effect-boundary observations.',
        'Reconcile the current session/cwd and re-plan; no freeze or transfer was attempted.',
        currentTask,
        { host: { id: host.id, ...observation } },
      ),
    };
  let journal = journalEntry(
    currentTask.record,
    request,
    context.requestDigest,
  );
  if (journal === null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'unknown',
        'transition_journal_missing',
        'The transition intent lacks a matching durable effect journal.',
        'Inspect the task record before any native operation.',
        currentTask,
      ),
    };
  let freezeReceipt = journal.effects['source-freeze'];
  if (
    freezeReceipt === undefined &&
    context.bootstrap.request.managed_runtime
  ) {
    try {
      verifyManagedPiSdkInstallation(
        context.bootstrap.request.managed_runtime.sdk_module_path,
      );
    } catch {
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          'needs_input',
          'successor_sdk_incompatible',
          'The successor SDK changed or is incompatible; no source freeze was attempted.',
          'Select a supported SDK installation and re-plan.',
          currentTask,
        ),
      };
    }
  }
  if (freezeReceipt?.state === 'failed')
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        'source_freeze_failed',
        'A prior source-freeze operation returned a known failure and will not be replayed automatically.',
        'Reconcile the source-controller state; start a new transition only with explicit authorization.',
        currentTask,
        { host: { id: host.id, ...observation } },
      ),
    };
  if (
    freezeReceipt?.state === 'pending' ||
    freezeReceipt?.state === 'unknown'
  ) {
    if (!freezeTokenMatches(observation.freeze_status, token))
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          'reconcile_required',
          'source_freeze_outcome_unknown',
          'A previous freeze may have taken effect, but the exact token is not confirmed by the current host observation.',
          'Reconcile the in-process controller and journal; do not repeat freeze or continue transfer.',
          currentTask,
          { host: { id: host.id, ...observation } },
        ),
      };
    const reconciled = await recordEffectOutcome(
      context,
      currentTask,
      'source-freeze',
      'completed',
      now(),
      null,
    );
    if (!reconciled.ok)
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          'unknown',
          reconciled.code,
          'The exact source freeze is visible, but its durable journal outcome could not be recorded.',
          'Inspect host status and task journal; do not repeat the freeze.',
          currentTask,
          { host: { id: host.id, ...observation } },
        ),
      };
    currentTask = reconciled.task;
    journal = journalEntry(currentTask.record, request, context.requestDigest);
    freezeReceipt = journal?.effects['source-freeze'];
  }
  let currentObservation = observation;
  if (freezeReceipt?.state !== 'completed') {
    const intent = await recordEffectIntent(
      context,
      currentTask,
      'source-freeze',
      now,
      dependencies.signal,
    );
    if (!intent.ok)
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          intent.kind === 'invalid' ? 'invalid' : 'needs_input',
          intent.code,
          intent.message,
          intent.nextAction,
          currentTask,
          { host: { id: host.id, ...observation } },
        ),
      };
    currentTask = intent.task;
    let freezeOutcome: FreezeOutcome | null = null;
    try {
      freezeOutcome = await host.freeze(token);
    } catch {
      let afterFailure: SessionTransitionHostObservation | null = null;
      try {
        afterFailure = await host.observe();
      } catch {
        // The pending journal receipt remains the reconciliation fence.
      }
      if (
        afterFailure !== null &&
        freezeTokenMatches(afterFailure.freeze_status, token)
      ) {
        const reconciled = await recordEffectOutcome(
          context,
          currentTask,
          'source-freeze',
          'completed',
          now(),
          null,
        );
        if (!reconciled.ok)
          return {
            ok: false,
            report: failureReport(
              'apply',
              request,
              'unknown',
              reconciled.code,
              'The host may have frozen the source, but the outcome receipt could not be persisted.',
              'Reconcile the in-process controller and journal; do not retry freeze.',
              currentTask,
              { host: { id: host.id, ...afterFailure } },
            ),
          };
        currentTask = reconciled.task;
        currentObservation = afterFailure;
      } else {
        const unknown = await recordEffectOutcome(
          context,
          currentTask,
          'source-freeze',
          'unknown',
          now(),
          'freeze_result_unknown',
        );
        const outcomeTask = unknown.ok ? unknown.task : currentTask;
        return {
          ok: false,
          report: failureReport(
            'apply',
            request,
            'reconcile_required',
            'source_freeze_outcome_unknown',
            'The host freeze call threw and its effect cannot be determined.',
            'Inspect the source controller and task journal; never replay the freeze blindly.',
            outcomeTask,
            {
              host:
                afterFailure === null
                  ? { id: host.id }
                  : { id: host.id, ...afterFailure },
            },
          ),
        };
      }
    }
    if (freezeOutcome !== null) {
      const frozen = freezeOutcome;
      if (!frozen.ok) {
        const recorded = await recordEffectOutcome(
          context,
          currentTask,
          'source-freeze',
          'failed',
          now(),
          frozen.reason,
        );
        const outcomeTask = recorded.ok ? recorded.task : currentTask;
        return {
          ok: false,
          report: failureReport(
            'apply',
            request,
            'needs_input',
            frozen.reason,
            frozen.detail,
            'Reconcile the source freeze status; no transfer or successor start occurred.',
            outcomeTask,
            { host: { id: host.id, ...observation } },
          ),
        };
      }
      if (!sameFreezeToken(frozen.token, token)) {
        const unknown = await recordEffectOutcome(
          context,
          currentTask,
          'source-freeze',
          'unknown',
          now(),
          'freeze_token_mismatch',
        );
        const outcomeTask = unknown.ok ? unknown.task : currentTask;
        return {
          ok: false,
          report: failureReport(
            'apply',
            request,
            'reconcile_required',
            'source_freeze_token_mismatch',
            'The host freeze returned a different token.',
            'Inspect the in-process controller and journal; do not continue or replay.',
            outcomeTask,
            { host: { id: host.id, ...observation } },
          ),
        };
      }
      try {
        currentObservation = await host.observe();
      } catch {
        const unknown = await recordEffectOutcome(
          context,
          currentTask,
          'source-freeze',
          'unknown',
          now(),
          'post_freeze_observation_unknown',
        );
        const outcomeTask = unknown.ok ? unknown.task : currentTask;
        return {
          ok: false,
          report: failureReport(
            'apply',
            request,
            'reconcile_required',
            'post_freeze_observation_unknown',
            'Freeze returned success, but its current host status could not be observed.',
            'Reconcile the freeze and complete quiescence proof before transfer.',
            outcomeTask,
          ),
        };
      }
      if (!freezeTokenMatches(currentObservation.freeze_status, token)) {
        const unknown = await recordEffectOutcome(
          context,
          currentTask,
          'source-freeze',
          'unknown',
          now(),
          'freeze_receipt_not_observed',
        );
        const outcomeTask = unknown.ok ? unknown.task : currentTask;
        return {
          ok: false,
          report: failureReport(
            'apply',
            request,
            'reconcile_required',
            'freeze_receipt_not_observed',
            'Freeze returned success but the exact token is absent from the current host status.',
            'Reconcile the source controller; no ownership transfer was attempted.',
            outcomeTask,
            { host: { id: host.id, ...currentObservation } },
          ),
        };
      }
      const recorded = await recordEffectOutcome(
        context,
        currentTask,
        'source-freeze',
        'completed',
        now(),
        null,
      );
      if (!recorded.ok)
        return {
          ok: false,
          report: failureReport(
            'apply',
            request,
            'unknown',
            recorded.code,
            'Freeze was applied but its outcome could not be durably recorded.',
            'Inspect the source controller and task journal; never retry freeze blindly.',
            currentTask,
            { host: { id: host.id, ...currentObservation } },
          ),
        };
      currentTask = recorded.task;
    }
  } else if (!freezeTokenMatches(observation.freeze_status, token)) {
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'reconcile_required',
        'source_freeze_receipt_mismatch',
        'The journal says the source is frozen, but the current controller does not expose the exact freeze token.',
        'Reconcile the in-process controller; no transfer is permitted.',
        currentTask,
        { host: { id: host.id, ...observation } },
      ),
    };
  }
  const afterIdentityIssue = hostIdentityFailure(currentObservation, request);
  if (afterIdentityIssue !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        afterIdentityIssue.code,
        afterIdentityIssue.message,
        afterIdentityIssue.nextAction,
        currentTask,
        { host: { id: host.id, ...currentObservation } },
      ),
    };
  const changedAfterHost = await assertTaskStoreCurrent(currentTask);
  if (changedAfterHost !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        changedAfterHost.code,
        changedAfterHost.message,
        changedAfterHost.nextAction,
        currentTask,
        { host: { id: host.id, ...currentObservation } },
      ),
    };
  const proofIssue = proofSupportFailure(currentObservation, request, now());
  if (proofIssue !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'waiting',
        proofIssue.code,
        'Source tools are frozen but the post-freeze proof is not sufficient to transfer ownership.',
        'Keep the source frozen and reconcile with an accepted complete host proof; no successor was launched.',
        currentTask,
        { host: { id: host.id, ...currentObservation } },
      ),
    };
  const proof = currentObservation.proof!;
  const outcome = transact(currentTask.taskRoot, {
    actor: request.intent.from.agent_id,
    purpose: 'session-transition:prepare-transfer',
    expectRevision: currentTask.record.state_revision,
    clock: now(),
    apply: (record) => {
      if (dependencies.signal?.aborted)
        return { ok: false as const, reason: 'abort_requested' };
      const drift = sourceStateFailure(record, request);
      if (drift !== null) return { ok: false as const, reason: drift.code };
      const effect = journalEntry(record, request, context.requestDigest)
        ?.effects['source-freeze'];
      if (effect?.state !== 'completed')
        return { ok: false as const, reason: 'source_freeze_receipt_missing' };
      const prepared = rollover.prepareRolloverTransfer(record, {
        intent_id: request.intent.intent_id,
        observation: 'confirmed',
        evidence_ref: proof.evidence_ref,
        inventory: proof.inventory,
        actor: request.intent.from.agent_id,
        clock: now(),
      });
      if (!prepared.ok) return prepared;

      const preparedIntent = getIntent(record, request.intent.intent_id);
      const inventoryDigest = preparedIntent?.prepared?.inventory;
      if (!isDigest(inventoryDigest))
        return {
          ok: false as const,
          reason: 'prepared_inventory_digest_missing',
        };
      const receipt = quiescenceReceipt(proof, inventoryDigest);
      const savedReceipt = setJournalQuiescenceReceipt(
        record,
        request.transition_id,
        'source',
        receipt,
      );
      if (!savedReceipt.ok)
        return { ok: false as const, reason: savedReceipt.code };
      return {
        record,
        op: 'session-transition-prepare-transfer',
        summary: {
          transition_id: request.transition_id,
          handoff_id: request.intent.handoff_id,
        },
        result: prepared,
      };
    },
  });
  if (!outcome.ok)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        outcome.reason,
        'Core rollover refused the prepared transfer.',
        'Re-read current task/claims and host evidence before any retry.',
        currentTask,
        { host: { id: host.id, ...currentObservation } },
      ),
    };
  const refreshed = await openTaskStore(request.task_root);
  if (!refreshed.ok)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'unknown',
        refreshed.code,
        refreshed.message,
        refreshed.nextAction,
        currentTask,
      ),
    };
  const roll = await inspectOrPlanRollover(
    buildRolloverRequest(request, refreshed.value.record),
  );
  const report = reportForContext(
    'apply',
    request,
    refreshed.value.record,
    roll.ok ? roll.value : null,
    null,
    currentObservation,
    [
      step('create-intent', 'satisfied'),
      step('source-quiescence', 'satisfied'),
      step('prepare-transfer', 'satisfied'),
      step('successor-bootstrap', 'ready'),
      step('receiver-ack', 'blocked', 'predecessor_step_unavailable'),
      step('claim-route-transfer', 'blocked', 'predecessor_step_unavailable'),
      step('first-work', 'blocked', 'predecessor_step_unavailable'),
      step('task-retirement', 'blocked', 'predecessor_step_unavailable'),
    ],
    'progressed',
    {
      next_action:
        'Apply the validated successor bootstrap once; then wait for its registered correlated ACK.',
    },
  );
  return { ok: true, report };
}

interface TaskLocalFileRead {
  readonly ok: true;
  readonly bytes: Buffer;
  readonly digest: string;
  readonly file: string;
}

type TaskLocalFileReadResult =
  TaskLocalFileRead | { readonly ok: false; readonly code: string };

function ensureTaskLocalDirectory(
  taskRoot: string,
  directory: string,
  create: boolean,
):
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly code: string } {
  try {
    const root = fs.realpathSync(taskRoot);
    if (root !== path.resolve(taskRoot) || !isPathInside(root, directory))
      return { ok: false, code: 'artifact_path_escape' };
    let current = root;
    const relative = path.relative(root, directory);
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          fs.realpathSync(current) !== current
        )
          return { ok: false, code: 'artifact_directory_unsafe' };
      } catch (error) {
        const code = isRecord(error) ? error['code'] : null;
        if (code !== 'ENOENT' || !create)
          return {
            ok: false,
            code:
              code === 'ENOENT'
                ? 'artifact_missing'
                : 'artifact_directory_unavailable',
          };
        fs.mkdirSync(current, { mode: 0o700 });
        const stat = fs.lstatSync(current);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          fs.realpathSync(current) !== current
        )
          return { ok: false, code: 'artifact_directory_unsafe' };
      }
    }
    return { ok: true, root };
  } catch {
    return { ok: false, code: 'artifact_directory_unavailable' };
  }
}

function readTaskLocalFile(
  file: string,
  taskRoot: string,
  maxBytes: number,
): TaskLocalFileReadResult {
  if (!path.isAbsolute(file) || path.resolve(file) !== file)
    return { ok: false, code: 'artifact_path_invalid' };
  const directory = path.dirname(file);
  const safeDirectory = ensureTaskLocalDirectory(taskRoot, directory, false);
  if (!safeDirectory.ok)
    return safeDirectory.code === 'artifact_missing'
      ? { ok: false, code: 'missing' }
      : { ok: false, code: safeDirectory.code };
  try {
    const stat = fs.lstatSync(file);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      fs.realpathSync(file) !== file
    )
      return { ok: false, code: 'artifact_file_unsafe' };
  } catch (error) {
    const code = isRecord(error) ? error['code'] : null;
    return {
      ok: false,
      code: code === 'ENOENT' ? 'missing' : 'artifact_unreadable',
    };
  }
  const read = readBoundedFile(file, maxBytes);
  if (!read.ok) return { ok: false, code: `artifact_${read.code}` };
  try {
    if (!isPathInside(safeDirectory.root, fs.realpathSync(file)))
      return { ok: false, code: 'artifact_path_escape' };
  } catch {
    return { ok: false, code: 'artifact_unreadable' };
  }
  return { ok: true, bytes: read.bytes, digest: read.digest, file };
}

function writeTaskLocalExclusive(
  file: string,
  taskRoot: string,
  bytes: Buffer,
  maxBytes: number,
):
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly code: string } {
  if (bytes.length > maxBytes) return { ok: false, code: 'artifact_too_large' };
  const expectedDigest = digestText(bytes);
  const prior = readTaskLocalFile(file, taskRoot, maxBytes);
  if (prior.ok)
    return prior.bytes.equals(bytes)
      ? { ok: true, digest: prior.digest }
      : { ok: false, code: 'artifact_conflict' };
  if (prior.code !== 'missing') return { ok: false, code: prior.code };
  const directory = ensureTaskLocalDirectory(
    taskRoot,
    path.dirname(file),
    true,
  );
  if (!directory.ok) return { ok: false, code: directory.code };
  let fd: number | null = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollow,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (written <= 0) throw new Error('short_write');
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    const directoryFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* Preserve the original write outcome. */
      }
    }
    const code = isRecord(error) ? error['code'] : null;
    if (code === 'EEXIST') {
      const raced = readTaskLocalFile(file, taskRoot, maxBytes);
      return raced.ok && raced.bytes.equals(bytes)
        ? { ok: true, digest: raced.digest }
        : { ok: false, code: raced.ok ? 'artifact_conflict' : raced.code };
    }
    return { ok: false, code: 'artifact_write_unknown' };
  }
  const written = readTaskLocalFile(file, taskRoot, maxBytes);
  if (!written.ok) return { ok: false, code: 'artifact_write_unconfirmed' };
  return written.digest === expectedDigest && written.bytes.equals(bytes)
    ? { ok: true, digest: written.digest }
    : { ok: false, code: 'artifact_write_conflict' };
}

function bootstrapData(entry: LaunchReservation): Record<string, unknown> {
  const value = (entry as LaunchReservation & { readonly bootstrap?: unknown })
    .bootstrap;
  return isRecord(value) ? value : {};
}

function findBootstrapReservation(
  record: TaskRecord,
  context: TransitionContext,
): LaunchReservation | null | 'ambiguous' {
  const requestId = context.bootstrap.request.request_id;
  const matches = (record.launch_reservations ?? []).filter((entry) => {
    const data = bootstrapData(entry);
    return data['request_id'] === requestId;
  });
  return matches.length > 1 ? 'ambiguous' : (matches[0] ?? null);
}

interface ValidatedSuccessorBinding {
  readonly source_file: string;
  readonly source_digest: string;
  readonly participant: CollabBindingParticipant;
  readonly successor_binding: CollabBinding;
  readonly herdr_agent: string;
}

function validateSuccessorBinding(
  context: TransitionContext,
  record: TaskRecord,
):
  | { readonly ok: true; readonly value: ValidatedSuccessorBinding }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const request = context.request;
  const reservation = findBootstrapReservation(record, context);
  if (reservation === 'ambiguous')
    return {
      ok: false,
      code: 'bootstrap_reservation_ambiguous',
      message: 'More than one bootstrap reservation matches this transition.',
    };
  if (reservation === null)
    return {
      ok: false,
      code: 'bootstrap_reservation_missing',
      message: 'No task-bound successor bootstrap reservation is recorded.',
    };
  const data = bootstrapData(reservation);
  if (
    reservation.subtask_id !== request.intent.subtask_id ||
    reservation.attempt !== request.intent.attempt ||
    reservation.requested_session_id !== request.intent.to.session_id ||
    !sameHarnessIdentity(reservation.holder, request.intent.from) ||
    typeof reservation.released_at !== 'string' ||
    !Number.isFinite(Date.parse(reservation.released_at)) ||
    reservation.phase !== 'completed' ||
    !['submitted', 'already_recorded'].includes(String(reservation.outcome)) ||
    data['request_id'] !== context.bootstrap.request.request_id ||
    data['request_digest'] !== context.bootstrap.digest ||
    data['request_file'] !== context.bootstrap.file ||
    data['config_digest'] !==
      context.bootstrap.request.bootstrap.config_digest ||
    data['bundle_manifest_digest'] !==
      context.bootstrap.request.bootstrap.bundle_digest ||
    data['target_choice'] !== 'sibling' ||
    data['participant_agent_id'] !== request.intent.to.agent_id ||
    data['participant_session_id'] !== request.intent.to.session_id ||
    data['message_id'] !==
      context.bootstrap.request.message_pointer.message_id ||
    data['message_digest'] !==
      context.bootstrap.request.message_pointer.content_digest ||
    data['phase'] !== 'completed' ||
    !isText(data['binding_file'], 4096) ||
    !isText(data['herdr_agent'], 32)
  )
    return {
      ok: false,
      code: 'bootstrap_reservation_mismatch',
      message:
        'The durable bootstrap reservation does not prove this exact completed successor request.',
    };
  const file = data['binding_file'];
  const read = readTaskLocalFile(file, context.task.taskRoot, 64 * 1024);
  if (!read.ok)
    return {
      ok: false,
      code:
        read.code === 'missing'
          ? 'successor_binding_missing'
          : 'successor_binding_unreadable',
      message:
        'The exact task-local bootstrap binding is unavailable or unsafe.',
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes.toString('utf8')) as unknown;
  } catch {
    return {
      ok: false,
      code: 'successor_binding_invalid',
      message: 'The task-local bootstrap binding is not valid JSON.',
    };
  }
  const result = collabBindingSchema.safeParse(parsed);
  if (
    !result.success ||
    result.data.task_id !== record.task_id ||
    !safePathEqual(result.data.task_root, context.task.taskRoot)
  )
    return {
      ok: false,
      code: 'successor_binding_invalid',
      message: 'The task-local binding schema or task identity is invalid.',
    };
  const participants = result.data.participants.filter(
    (participant) => participant.agent_id === request.intent.to.agent_id,
  );
  if (participants.length !== 1)
    return {
      ok: false,
      code: 'successor_binding_ambiguous',
      message: 'The binding must contain exactly one successor participant.',
    };
  const participant = participants[0]!;
  if (
    participant.harness !== request.intent.to.harness ||
    participant.native_session_id !== request.intent.to.session_id ||
    !safePathEqual(participant.cwd, request.intent.to.cwd ?? '') ||
    participant.herdr_agent !== data['herdr_agent']
  )
    return {
      ok: false,
      code: 'successor_binding_identity_mismatch',
      message:
        'The successor binding differs from the pinned agent, harness, cwd or Herdr name.',
    };
  const successorBinding = collabBindingSchema.safeParse({
    ...result.data,
    participants: [participant],
  });
  if (!successorBinding.success)
    return {
      ok: false,
      code: 'successor_route_binding_invalid',
      message:
        'A successor-only task-local route binding could not be validated.',
    };
  return {
    ok: true,
    value: {
      source_file: read.file,
      source_digest: read.digest,
      participant,
      successor_binding: successorBinding.data,
      herdr_agent: participant.herdr_agent,
    },
  };
}

interface EnsuredRouteBinding {
  readonly ok: true;
  readonly task: OpenedTaskStore;
  readonly ref: string;
  readonly digest: string;
  readonly binding: CollabBinding;
}

type RouteBindingEnsureResult =
  | EnsuredRouteBinding
  | { readonly ok: false; readonly report: SessionTransitionReport };

function routeBindingFailure(
  context: TransitionContext,
  task: OpenedTaskStore,
  status: 'needs_input' | 'reconcile_required' | 'unknown',
  code: string,
  message: string,
  nextAction: string | null,
): RouteBindingEnsureResult {
  return {
    ok: false,
    report: failureReport(
      'apply',
      context.request,
      status,
      code,
      message,
      nextAction,
      task,
    ),
  };
}

async function ensureSuccessorRouteBinding(
  context: TransitionContext,
  initialTask: OpenedTaskStore,
  dependencies: SessionTransitionDependencies,
  now: () => number,
): Promise<RouteBindingEnsureResult> {
  const request = context.request;
  const drift = currentStateDrift(initialTask.record, request, 'successor');
  if (drift !== null)
    return routeBindingFailure(
      context,
      initialTask,
      'needs_input',
      drift.code,
      drift.message,
      'Reconcile successor assignment, claim epochs and coordinator authority before route changes.',
    );
  const validated = validateSuccessorBinding(context, initialTask.record);
  if (!validated.ok)
    return routeBindingFailure(
      context,
      initialTask,
      'needs_input',
      validated.code,
      validated.message,
      'Reconcile the exact completed bootstrap reservation and task-local binding; do not infer a route.',
    );
  const file = path.join(
    initialTask.taskRoot,
    'notifications',
    'session-transition-bindings',
    `${request.transition_id}.json`,
  );
  const bytes = Buffer.from(
    `${JSON.stringify(validated.value.successor_binding, null, 2)}\n`,
    'utf8',
  );
  const expectedDigest = digestText(bytes);
  let task = initialTask;
  let journal = journalEntry(task.record, request, context.requestDigest);
  if (journal === null)
    return routeBindingFailure(
      context,
      task,
      'unknown',
      'transition_journal_missing',
      'The transition journal is missing or conflicts with its immutable request.',
      'Inspect the authoritative task record before any route-binding effect.',
    );
  const receipt = journal.effects['successor-route-binding'];
  if (receipt?.state === 'failed')
    return routeBindingFailure(
      context,
      task,
      'needs_input',
      'successor_route_binding_failed',
      'A prior route-binding write has a known failed receipt and will not be replayed.',
      'Inspect the exact task-local file and journal before continuing.',
    );
  if (receipt?.state === 'completed') {
    const read = readTaskLocalFile(file, task.taskRoot, 64 * 1024);
    if (
      receipt.ref !== file ||
      receipt.digest !== expectedDigest ||
      journal.route_binding_ref !== file ||
      journal.route_binding_digest !== expectedDigest ||
      !read.ok ||
      read.digest !== expectedDigest ||
      !read.bytes.equals(bytes)
    )
      return routeBindingFailure(
        context,
        task,
        'reconcile_required',
        'successor_route_binding_receipt_mismatch',
        'The completed route-binding receipt no longer matches its exact task-local artifact.',
        'Reconcile the binding file and journal; do not overwrite or re-create it.',
      );
    return {
      ok: true,
      task,
      ref: file,
      digest: expectedDigest,
      binding: validated.value.successor_binding,
    };
  }
  if (receipt?.state === 'pending' || receipt?.state === 'unknown') {
    const read = readTaskLocalFile(file, task.taskRoot, 64 * 1024);
    if (!read.ok || read.digest !== expectedDigest || !read.bytes.equals(bytes))
      return routeBindingFailure(
        context,
        task,
        'reconcile_required',
        'successor_route_binding_outcome_unknown',
        'A prior route-binding effect is pending/unknown and its exact artifact is not present for reconciliation.',
        'Inspect the task-local path and journal; never replay an ambiguous write.',
      );
    const reconciled = await recordEffectOutcome(
      context,
      task,
      'successor-route-binding',
      'completed',
      now(),
      null,
      {
        digest: expectedDigest,
        ref: file,
        artifact: 'route-binding',
      },
    );
    if (!reconciled.ok)
      return routeBindingFailure(
        context,
        task,
        'unknown',
        reconciled.code,
        'The exact route binding exists but its durable receipt could not be reconciled.',
        'Inspect the file and task journal before continuing.',
      );
    task = reconciled.task;
    return {
      ok: true,
      task,
      ref: file,
      digest: expectedDigest,
      binding: validated.value.successor_binding,
    };
  }
  const intent = await recordEffectIntent(
    context,
    task,
    'successor-route-binding',
    now,
    dependencies.signal,
  );
  if (!intent.ok)
    return routeBindingFailure(
      context,
      task,
      intent.kind === 'invalid' ? 'needs_input' : 'reconcile_required',
      intent.code,
      intent.message,
      intent.nextAction,
    );
  task = intent.task;
  const currentBinding = validateSuccessorBinding(context, task.record);
  if (
    !currentBinding.ok ||
    currentBinding.value.source_file !== validated.value.source_file ||
    currentBinding.value.source_digest !== validated.value.source_digest ||
    canonicalJson(currentBinding.value.successor_binding) !==
      canonicalJson(validated.value.successor_binding)
  ) {
    const failed = await recordEffectOutcome(
      context,
      task,
      'successor-route-binding',
      'failed',
      now(),
      'successor_binding_changed_before_write',
    );
    const resultTask = failed.ok ? failed.task : task;
    return routeBindingFailure(
      context,
      resultTask,
      'needs_input',
      'successor_binding_changed_before_write',
      'The source binding or bootstrap reservation changed after the durable effect intent.',
      'Reconcile the exact binding and re-plan before any route file is written.',
    );
  }
  const written = writeTaskLocalExclusive(
    file,
    task.taskRoot,
    bytes,
    64 * 1024,
  );
  if (!written.ok) {
    const unknown = await recordEffectOutcome(
      context,
      task,
      'successor-route-binding',
      'unknown',
      now(),
      written.code,
    );
    const resultTask = unknown.ok ? unknown.task : task;
    return routeBindingFailure(
      context,
      resultTask,
      'reconcile_required',
      'successor_route_binding_outcome_unknown',
      `The successor route binding write did not return a confirmed result (${written.code}).`,
      'Inspect the exact task-local artifact and journal; do not replay the write blindly.',
    );
  }
  const recorded = await recordEffectOutcome(
    context,
    task,
    'successor-route-binding',
    'completed',
    now(),
    null,
    {
      digest: written.digest,
      ref: file,
      artifact: 'route-binding',
    },
  );
  if (!recorded.ok)
    return routeBindingFailure(
      context,
      task,
      'unknown',
      recorded.code,
      'The route-binding file is written but its outcome receipt could not be persisted.',
      'Inspect the binding and journal; do not overwrite or repeat the transfer.',
    );
  return {
    ok: true,
    task: recorded.task,
    ref: file,
    digest: written.digest,
    binding: currentBinding.value.successor_binding,
  };
}

interface EnsuredRetirementMarker {
  readonly ok: true;
  readonly task: OpenedTaskStore;
  readonly ref: string;
  readonly digest: string;
}

type RetirementEnsureResult =
  | EnsuredRetirementMarker
  | { readonly ok: false; readonly report: SessionTransitionReport };

async function ensureTaskRetirementMarker(
  context: TransitionContext,
  initialTask: OpenedTaskStore,
  routeBinding: EnsuredRouteBinding,
  dependencies: SessionTransitionDependencies,
  now: () => number,
): Promise<RetirementEnsureResult> {
  const request = context.request;
  const drift = currentStateDrift(initialTask.record, request, 'retired');
  if (drift !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        drift.code,
        drift.message,
        'Reconcile successor authority and claim epochs before task retirement.',
        initialTask,
      ),
    };
  const succession = (initialTask.record.successions ?? []).find(
    (item) =>
      item.intent_id === request.intent.intent_id &&
      item.handoff_id === request.intent.handoff_id &&
      item.generation === request.intent.generation,
  );
  if (succession === undefined)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        'first_work_not_recorded',
        'No exact core succession proves successor first work.',
        'Register and apply the admitted successor REPORT before task retirement.',
        initialTask,
      ),
    };
  const validation = validateSuccession(initialTask.record, succession);
  if (!validation.ok)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        validation.code,
        validation.detail,
        'Reconcile the first-work REPORT and recorded transfer boundary before task retirement.',
        initialTask,
      ),
    };
  const routeReceipt = journalEntry(
    initialTask.record,
    request,
    context.requestDigest,
  );
  if (
    routeReceipt?.effects['successor-route-binding']?.state !== 'completed' ||
    routeReceipt?.route_binding_ref !== routeBinding.ref ||
    routeReceipt?.route_binding_digest !== routeBinding.digest
  )
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'reconcile_required',
        'successor_route_binding_receipt_missing',
        'Task retirement requires the exact durable successor route-binding receipt.',
        'Reconcile the route binding before creating a retirement marker.',
        initialTask,
      ),
    };
  const routeFile = readTaskLocalFile(
    routeBinding.ref,
    initialTask.taskRoot,
    64 * 1024,
  );
  if (!routeFile.ok || routeFile.digest !== routeBinding.digest)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'reconcile_required',
        'successor_route_binding_missing',
        'The recorded successor route binding is missing or has changed.',
        'Reconcile the task-local binding before retirement; no archive marker was written.',
        initialTask,
      ),
    };
  const file = path.join(
    initialTask.taskRoot,
    'archive',
    'session-transitions',
    `${request.transition_id}.json`,
  );
  let task = initialTask;
  let journal = journalEntry(task.record, request, context.requestDigest);
  if (journal === null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'unknown',
        'transition_journal_missing',
        'The retirement marker has no matching durable transition journal.',
        'Inspect the task record before writing an archive marker.',
        task,
      ),
    };
  let receipt = journal.effects['task-retirement-marker'];
  let effectJustCreated = false;
  if (receipt?.state === 'failed')
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        'task_retirement_marker_failed',
        'A prior retirement marker write has a known failed receipt and will not be replayed.',
        'Inspect the exact task-local marker and journal before continuing.',
        task,
      ),
    };
  if (receipt === undefined) {
    const intent = await recordEffectIntent(
      context,
      task,
      'task-retirement-marker',
      now,
      dependencies.signal,
    );
    if (!intent.ok)
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          intent.kind === 'invalid' ? 'needs_input' : 'reconcile_required',
          intent.code,
          intent.message,
          intent.nextAction,
          task,
        ),
      };
    task = intent.task;
    effectJustCreated = true;
    journal = journalEntry(task.record, request, context.requestDigest);
    receipt = journal?.effects['task-retirement-marker'];
  }
  if (receipt === undefined)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'unknown',
        'task_retirement_intent_unconfirmed',
        'The retirement intent was not durably recorded.',
        'Inspect the transition journal; do not write an unjournaled marker.',
        task,
      ),
    };
  const marker: SessionTransitionRetirementMarker = {
    schema: SESSION_TRANSITION_ARCHIVE_SCHEMA,
    mode: 'task-retirement',
    task_id: task.record.task_id,
    task_root: task.taskRoot,
    transition_id: request.transition_id,
    intent_id: request.intent.intent_id,
    handoff_id: request.intent.handoff_id,
    generation: request.intent.generation,
    recorded_at: receipt.intent_at,
    first_work: {
      message_id: validation.proof.message_id,
      digest: validation.proof.content_digest,
    },
    successor_route_binding: {
      ref: routeBinding.ref,
      digest: routeBinding.digest,
    },
    native_archive: 'unavailable',
    original_transcript: 'retained-in-place',
    reversible: true,
  } as const;
  const bytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  const expectedDigest = digestText(bytes);
  if (receipt.state === 'completed') {
    const read = readTaskLocalFile(file, task.taskRoot, MAX_ARCHIVE_BYTES);
    if (
      receipt.ref !== file ||
      receipt.digest !== expectedDigest ||
      journal?.archive_ref !== file ||
      journal.archive_digest !== expectedDigest ||
      !read.ok ||
      read.digest !== expectedDigest ||
      !read.bytes.equals(bytes)
    )
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          'reconcile_required',
          'task_retirement_receipt_mismatch',
          'The completed reversible retirement marker no longer matches its durable receipt.',
          'Reconcile the marker and task journal; do not overwrite or re-create it.',
          task,
        ),
      };
    return { ok: true, task, ref: file, digest: expectedDigest };
  }
  if (
    (receipt.state === 'pending' || receipt.state === 'unknown') &&
    !effectJustCreated
  ) {
    const read = readTaskLocalFile(file, task.taskRoot, MAX_ARCHIVE_BYTES);
    if (!read.ok || read.digest !== expectedDigest || !read.bytes.equals(bytes))
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          'reconcile_required',
          'task_retirement_outcome_unknown',
          'A prior retirement marker effect is pending/unknown and its exact artifact is not available for reconciliation.',
          'Inspect the task-local path and journal; never replay an ambiguous archive write.',
          task,
        ),
      };
    const reconciled = await recordEffectOutcome(
      context,
      task,
      'task-retirement-marker',
      'completed',
      now(),
      null,
      {
        digest: expectedDigest,
        ref: file,
        artifact: 'task-retirement',
      },
    );
    if (!reconciled.ok)
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          'unknown',
          reconciled.code,
          'The exact retirement marker exists but its durable receipt could not be reconciled.',
          'Inspect the file and task journal before continuing.',
          task,
        ),
      };
    return {
      ok: true,
      task: reconciled.task,
      ref: file,
      digest: expectedDigest,
    };
  }
  const written = writeTaskLocalExclusive(
    file,
    task.taskRoot,
    bytes,
    MAX_ARCHIVE_BYTES,
  );
  if (!written.ok) {
    const unknown = await recordEffectOutcome(
      context,
      task,
      'task-retirement-marker',
      'unknown',
      now(),
      written.code,
    );
    const resultTask = unknown.ok ? unknown.task : task;
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'reconcile_required',
        'task_retirement_outcome_unknown',
        `The retirement marker write did not return a confirmed result (${written.code}).`,
        'Inspect the exact task-local artifact and journal; do not replay the write blindly.',
        resultTask,
      ),
    };
  }
  const recorded = await recordEffectOutcome(
    context,
    task,
    'task-retirement-marker',
    'completed',
    now(),
    null,
    {
      digest: written.digest,
      ref: file,
      artifact: 'task-retirement',
    },
  );
  if (!recorded.ok)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'unknown',
        recorded.code,
        'The reversible retirement marker is written but its outcome receipt could not be persisted.',
        'Inspect the marker and task journal; do not overwrite or repeat the transfer.',
        task,
      ),
    };
  return { ok: true, task: recorded.task, ref: file, digest: written.digest };
}

function herdrOpsFor(
  dependencies: SessionTransitionDependencies,
  taskRoot: string,
): HerdrBootstrapOps {
  if (dependencies.herdr !== undefined) return dependencies.herdr;
  const bootstrap = dependencies.bootstrapDependencies;
  if (bootstrap?.ops !== undefined) return bootstrap.ops;
  return bootstrap?.transport === undefined
    ? createHerdrBootstrapOps({ transport: createHerdrTransport({ taskRoot }) })
    : createHerdrBootstrapOps({ transport: bootstrap.transport });
}

async function readRegisteredTaskMessage(
  context: TransitionContext,
  messageId: string,
): Promise<
  | { readonly ok: true; readonly value: RegisteredMessage }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const opened = await openMessageTask(context.task.taskRoot);
  if (!opened.ok)
    return { ok: false, code: opened.code, message: opened.message };
  const registered = await readRegisteredMessageSafe(opened.value, messageId);
  if (!registered.ok)
    return { ok: false, code: registered.code, message: registered.message };
  return { ok: true, value: registered.value };
}

function registeredApplied(
  record: TaskRecord,
  registered: RegisteredMessage,
  type: 'ACK' | 'REPORT',
): boolean {
  return (
    registered.message.type === type &&
    (record.messages ?? []).some(
      (entry) =>
        entry.message_id === registered.message.message_id &&
        entry.content_digest === registered.message.content_digest &&
        entry.state === 'applied' &&
        entry.type === type,
    )
  );
}

function transitionProgressReport(
  context: TransitionContext,
  task: OpenedTaskStore,
  host: SessionTransitionHostObservation | null,
  bootstrapReport: VisibleBootstrapReport | null,
  steps: readonly SessionTransitionStep[],
  nextAction: string,
): SessionTransitionReport {
  return reportForContext(
    'apply',
    context.request,
    task.record,
    null,
    bootstrapReport,
    host,
    steps,
    'progressed',
    { next_action: nextAction },
  );
}

async function applyConfirmedTransfer(
  context: TransitionContext,
  initialTask: OpenedTaskStore,
  initialHost: SessionTransitionHostObservation,
  dependencies: SessionTransitionDependencies,
  now: () => number,
  bootstrapReport: VisibleBootstrapReport | null = null,
): Promise<SessionTransitionReport> {
  const request = context.request;
  let task = initialTask;
  let handoff = getHandoff(task.record, request.intent.handoff_id);
  if (handoff === null)
    return failureReport(
      'apply',
      request,
      'unknown',
      'handoff_missing',
      'The exact receiver handoff is missing.',
      'Inspect the authoritative task record before continuing.',
      task,
      { bootstrap: bootstrapReport },
    );
  const ackId =
    request.evidence.ack_message_id ?? handoff.confirmation_message_id ?? null;
  if (handoff.state === 'transferring' && ackId === null)
    return failureReport(
      'apply',
      request,
      'waiting',
      'receiver_ack_required',
      'The successor has not supplied a correlated registered ACK.',
      'Wait for the successor ACK, register/apply it, then reapply once with its message id.',
      task,
      {
        bootstrap: bootstrapReport,
        host: { id: dependencies.host?.id ?? 'not-loaded', ...initialHost },
        steps: [
          step('create-intent', 'satisfied'),
          step('source-quiescence', 'satisfied'),
          step(
            'successor-bootstrap',
            bootstrapReport?.status === 'applied' ||
              bootstrapReport?.status === 'already_recorded'
              ? 'satisfied'
              : 'unknown',
          ),
          step('receiver-ack', 'waiting', 'receiver_ack_required'),
          step(
            'claim-route-transfer',
            'blocked',
            'predecessor_step_unavailable',
          ),
          step('first-work', 'blocked', 'predecessor_step_unavailable'),
          step('task-retirement', 'blocked', 'predecessor_step_unavailable'),
        ],
      },
    );
  if (ackId === null)
    return failureReport(
      'apply',
      request,
      'needs_input',
      'receiver_ack_missing',
      'No correlated receiver ACK id is recorded for this handoff.',
      'Inspect the handoff state and register the exact ACK; do not infer recipient acceptance.',
      task,
      { bootstrap: bootstrapReport },
    );
  const loadedAck = await readRegisteredTaskMessage(context, ackId);
  if (!loadedAck.ok)
    return failureReport(
      'apply',
      request,
      'waiting',
      'receiver_ack_not_registered',
      `ACK ${ackId} is not available as a safe registered message (${loadedAck.code}).`,
      'Register and apply the exact successor ACK; do not treat notification submission as acceptance.',
      task,
      { bootstrap: bootstrapReport },
    );
  let ack = loadedAck.value;
  const currentAfterAckRead = await openTaskStore(request.task_root);
  if (!currentAfterAckRead.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      currentAfterAckRead.code,
      currentAfterAckRead.message,
      currentAfterAckRead.nextAction,
      task,
      { bootstrap: bootstrapReport },
    );
  task = currentAfterAckRead.value;
  if (!registeredApplied(task.record, ack, 'ACK'))
    return failureReport(
      'apply',
      request,
      'waiting',
      'receiver_ack_not_applied',
      'The exact ACK file exists but the current task ledger does not show it as applied.',
      'Apply the registered ACK under the current task revision before transfer.',
      task,
      { bootstrap: bootstrapReport },
    );
  handoff = getHandoff(task.record, request.intent.handoff_id);
  if (handoff === null)
    return failureReport(
      'apply',
      request,
      'unknown',
      'handoff_missing',
      'The exact handoff disappeared while reading the ACK.',
      'Inspect the authoritative task record.',
      task,
      { bootstrap: bootstrapReport },
    );
  if (handoff.state === 'transferring') {
    if (dependencies.signal?.aborted)
      return failureReport(
        'apply',
        request,
        'needs_input',
        'abort_requested',
        'The transition was aborted before receiver confirmation.',
        'Reconcile the current ACK and task state before continuing.',
        task,
        { bootstrap: bootstrapReport },
      );
    const outcome = transact(task.taskRoot, {
      actor: request.intent.from.agent_id,
      purpose: 'session-transition:confirm-receiver',
      expectRevision: task.record.state_revision,
      clock: now(),
      apply: (record) => {
        const drift = currentStateDrift(record, request, 'source');
        if (drift !== null) return { ok: false as const, reason: drift.code };
        const entry = (record.messages ?? []).find(
          (item) => item.message_id === ackId,
        );
        if (
          entry?.state !== 'applied' ||
          entry.content_digest !== ack.message.content_digest ||
          entry.type !== 'ACK'
        )
          return { ok: false as const, reason: 'receiver_ack_not_applied' };
        const confirmed = rollover.confirmRolloverReceiver(record, {
          intent_id: request.intent.intent_id,
          message: ack.message,
          clock: now(),
        });
        if (!confirmed.ok) return confirmed;
        return {
          record,
          op: 'session-transition-confirm-receiver',
          summary: {
            transition_id: request.transition_id,
            ack_message_id: ackId,
          },
          result: confirmed,
        };
      },
    });
    if (!outcome.ok) {
      const waiting =
        outcome.reason === 'receiver_ack_not_applied' ||
        outcome.reason === 'ack_not_registered' ||
        outcome.reason === 'ack_not_applied';
      return failureReport(
        'apply',
        request,
        waiting ? 'waiting' : 'needs_input',
        outcome.reason,
        'Core rollover refused receiver confirmation.',
        'Reconcile the exact ACK, current epoch, assignment and claims before any transfer.',
        task,
        { bootstrap: bootstrapReport },
      );
    }
    const confirmedTask = await openTaskStore(request.task_root);
    if (!confirmedTask.ok)
      return failureReport(
        'apply',
        request,
        'unknown',
        confirmedTask.code,
        confirmedTask.message,
        confirmedTask.nextAction,
        task,
        { bootstrap: bootstrapReport },
      );
    task = confirmedTask.value;
    handoff = getHandoff(task.record, request.intent.handoff_id);
  }
  if (handoff?.state !== 'receiver_confirmed')
    return failureReport(
      'apply',
      request,
      'unknown',
      'receiver_confirmation_unconfirmed',
      'The durable task record does not confirm the receiver ACK.',
      'Inspect the exact ACK, handoff and task revision before any transfer.',
      task,
      { bootstrap: bootstrapReport },
    );
  if (handoff.confirmation_message_id !== ackId)
    return failureReport(
      'apply',
      request,
      'invalid',
      'receiver_ack_conflict',
      'The ACK id differs from the confirmation already recorded for this handoff.',
      'Use the exact recorded confirmation id; do not replace receiver evidence.',
      task,
      { bootstrap: bootstrapReport },
    );
  if (!registeredApplied(task.record, ack, 'ACK')) {
    const refreshedAck = await readRegisteredTaskMessage(context, ackId);
    if (
      !refreshedAck.ok ||
      !registeredApplied(task.record, refreshedAck.value, 'ACK')
    )
      return failureReport(
        'apply',
        request,
        'needs_input',
        'receiver_ack_receipt_changed',
        'The recorded ACK is no longer present as the exact applied task message.',
        'Reconcile the registered message digest and handoff confirmation before transfer.',
        task,
        { bootstrap: bootstrapReport },
      );
    ack = refreshedAck.value;
  }
  const bindingBefore = validateSuccessorBinding(context, task.record);
  if (!bindingBefore.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      bindingBefore.code,
      bindingBefore.message,
      'Reconcile the exact bootstrap reservation and successor binding before claim transfer.',
      task,
      { bootstrap: bootstrapReport },
    );
  const herdr = herdrOpsFor(dependencies, task.taskRoot);
  let listed: HerdrListResult;
  try {
    listed = await herdr.listAgents();
  } catch {
    return failureReport(
      'apply',
      request,
      'needs_input',
      'herdr_agent_list_unavailable',
      'The live successor identity could not be re-observed.',
      'Refresh Herdr metadata for the exact successor binding; no claim transfer was attempted.',
      task,
      { bootstrap: bootstrapReport },
    );
  }
  if (!listed.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      'herdr_agent_list_unavailable',
      listed.detail,
      'Refresh Herdr metadata for the exact successor binding; no claim transfer was attempted.',
      task,
      { bootstrap: bootstrapReport },
    );
  const liveMatches = listed.agents.filter(
    (agent) => agent.name === bindingBefore.value.herdr_agent,
  );
  if (liveMatches.length !== 1)
    return failureReport(
      'apply',
      request,
      'needs_input',
      'successor_live_identity_not_unique',
      'Herdr does not report exactly one live participant for the reserved successor name.',
      'Reconcile the exact task-local binding and live Herdr roster; no claims were transferred.',
      task,
      { bootstrap: bootstrapReport },
    );
  const live = liveMatches[0]!;
  const liveSession = reportedSessionIdentity(
    live.sessionKind,
    live.sessionValue,
  );
  if (
    live.paneId !== bindingBefore.value.participant.pane_id ||
    live.harness !== request.intent.to.harness ||
    live.cwd === null ||
    !safePathEqual(live.cwd, request.intent.to.cwd ?? '') ||
    liveSession.status !== 'match' ||
    liveSession.identity !== request.intent.to.session_id
  )
    return failureReport(
      'apply',
      request,
      'needs_input',
      'successor_live_identity_mismatch',
      'Live Herdr pane, harness, cwd or reported native session differs from the reserved successor binding.',
      'Reconcile the exact successor identity; Herdr metadata does not prove process affiliation.',
      task,
      { bootstrap: bootstrapReport },
    );
  const host = dependencies.host;
  if (host === undefined)
    return failureReport(
      'apply',
      request,
      'needs_input',
      'pi_transition_host_required',
      'The source host disappeared before ownership transfer.',
      'Reopen the opt-in source-session adapter and re-plan; no claims were transferred.',
      task,
      { bootstrap: bootstrapReport },
    );
  let currentHost: SessionTransitionHostObservation;
  try {
    currentHost = await host.observe();
  } catch {
    return failureReport(
      'apply',
      request,
      'waiting',
      'host_observation_unknown',
      'The source session could not be re-observed immediately before claim transfer.',
      'Reconcile the exact source freeze and complete quiescence proof; no transfer was attempted.',
      task,
      { bootstrap: bootstrapReport },
    );
  }
  const sourceIdentityIssue = hostIdentityFailure(currentHost, request);
  if (sourceIdentityIssue !== null)
    return failureReport(
      'apply',
      request,
      'needs_input',
      sourceIdentityIssue.code,
      sourceIdentityIssue.message,
      sourceIdentityIssue.nextAction,
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const proofIssue = proofSupportFailure(currentHost, request, now());
  if (proofIssue !== null)
    return failureReport(
      'apply',
      request,
      'waiting',
      proofIssue.code,
      proofIssue.message,
      'Keep the source frozen and reconcile a fresh complete native proof before moving claims.',
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const transferProof = currentHost.proof;
  const transferInventoryDigest =
    transferProof === null
      ? null
      : quiescenceInventoryDigest(transferProof.inventory);
  if (transferProof === null || transferInventoryDigest === null)
    return failureReport(
      'apply',
      request,
      'waiting',
      'host_quiescence_proof_invalid',
      'The immediate pre-transfer observation did not include a complete inventory digest.',
      'Reconcile a fresh complete native proof; no claims were transferred.',
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const transferQuiescenceReceipt = quiescenceReceipt(
    transferProof,
    transferInventoryDigest,
  );
  const unchanged = await assertTaskStoreCurrent(task);
  if (unchanged !== null)
    return failureReport(
      'apply',
      request,
      'needs_input',
      unchanged.code,
      unchanged.message,
      unchanged.nextAction,
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const latest = await openTaskStore(request.task_root);
  if (!latest.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      latest.code,
      latest.message,
      latest.nextAction,
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  task = latest.value;
  const drift = currentStateDrift(task.record, request, 'source');
  if (drift !== null)
    return failureReport(
      'apply',
      request,
      'needs_input',
      drift.code,
      drift.message,
      'Reconcile current attempt, approval/cancellation, coordinator epoch, source identity and claims before transfer.',
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  handoff = getHandoff(task.record, request.intent.handoff_id);
  if (
    handoff?.state !== 'receiver_confirmed' ||
    handoff.confirmation_message_id !== ackId
  )
    return failureReport(
      'apply',
      request,
      'needs_input',
      'handoff_confirmation_changed',
      'Receiver confirmation changed before claim transfer.',
      'Reconcile the authoritative handoff and exact ACK before continuing.',
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const bindingNow = validateSuccessorBinding(context, task.record);
  if (
    !bindingNow.ok ||
    bindingNow.value.source_file !== bindingBefore.value.source_file ||
    bindingNow.value.source_digest !== bindingBefore.value.source_digest ||
    bindingNow.value.participant.pane_id !== live.paneId
  )
    return failureReport(
      'apply',
      request,
      'needs_input',
      'successor_binding_changed',
      bindingNow.ok
        ? 'The exact successor binding changed after live identity observation.'
        : bindingNow.message,
      'Reconcile task-local binding and live Herdr evidence before transfer.',
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const nativeEvidenceRef = `${herdr.id}:${live.name}:session:${liveSession.identity}`;
  const transfer = transact(task.taskRoot, {
    actor: request.intent.from.agent_id,
    purpose: 'session-transition:complete-transfer',
    expectRevision: task.record.state_revision,
    clock: now(),
    apply: (record) => {
      if (dependencies.signal?.aborted)
        return { ok: false as const, reason: 'abort_requested' };
      const sourceDrift = currentStateDrift(record, request, 'source');
      if (sourceDrift !== null)
        return { ok: false as const, reason: sourceDrift.code };
      const currentHandoff = getHandoff(record, request.intent.handoff_id);
      if (
        currentHandoff?.state !== 'receiver_confirmed' ||
        currentHandoff.confirmation_message_id !== ackId
      )
        return { ok: false as const, reason: 'handoff_confirmation_changed' };
      const ackEntry = (record.messages ?? []).find(
        (entry) => entry.message_id === ackId,
      );
      if (
        ackEntry?.state !== 'applied' ||
        ackEntry.content_digest !== ack.message.content_digest ||
        ackEntry.type !== 'ACK'
      )
        return { ok: false as const, reason: 'receiver_ack_receipt_changed' };
      const successorBinding = validateSuccessorBinding(context, record);
      if (
        !successorBinding.ok ||
        successorBinding.value.source_digest !==
          bindingBefore.value.source_digest
      )
        return { ok: false as const, reason: 'successor_binding_changed' };
      const completed = rollover.completeRolloverTransfer(record, {
        intent_id: request.intent.intent_id,
        successor_native: {
          agent_id: request.intent.to.agent_id,
          runner: 'pi',
          session_id: request.intent.to.session_id,
          run_id: null,
          mission_id: null,
          evidence_ref: nativeEvidenceRef,
          observed_at: new Date(now()).toISOString(),
        },
        actor: request.intent.from.agent_id,
        clock: now(),
      });
      if (!completed.ok) return completed;
      const savedQuiescence = setJournalQuiescenceReceipt(
        record,
        request.transition_id,
        'transfer',
        transferQuiescenceReceipt,
      );
      if (!savedQuiescence.ok)
        return { ok: false as const, reason: savedQuiescence.code };
      return {
        record,
        op: 'session-transition-complete-transfer',
        summary: {
          transition_id: request.transition_id,
          ack_message_id: ackId,
        },
        result: completed,
      };
    },
  });
  if (!transfer.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      transfer.reason,
      'Core rollover refused the ownership/claim transfer.',
      'Reconcile the exact ACK, successor binding, live Herdr session, source proof and current claims before retrying.',
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const transferredTask = await openTaskStore(request.task_root);
  if (!transferredTask.ok)
    return failureReport(
      'apply',
      request,
      'unknown',
      transferredTask.code,
      transferredTask.message,
      transferredTask.nextAction,
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const routeBinding = await ensureSuccessorRouteBinding(
    context,
    transferredTask.value,
    dependencies,
    now,
  );
  if (!routeBinding.ok)
    return {
      ...routeBinding.report,
      host: { id: host.id, ...currentHost },
      bootstrap: bootstrapReport,
    };
  return transitionProgressReport(
    context,
    routeBinding.task,
    currentHost,
    bootstrapReport,
    [
      step('create-intent', 'satisfied'),
      step('source-quiescence', 'satisfied'),
      step('successor-bootstrap', 'satisfied'),
      step('receiver-ack', 'satisfied'),
      step('claim-route-transfer', 'satisfied'),
      step('first-work', 'waiting'),
      step('task-retirement', 'blocked', 'predecessor_step_unavailable'),
    ],
    'The task assignee and claims moved after correlated ACK, and a successor-only task-local binding was recorded. Wait for the admitted successor REPORT; native session archival remains unavailable.',
  );
}

async function applyFirstWorkAndRetirement(
  context: TransitionContext,
  initialTask: OpenedTaskStore,
  hostObservation: SessionTransitionHostObservation | null,
  dependencies: SessionTransitionDependencies,
  now: () => number,
): Promise<SessionTransitionReport> {
  const request = context.request;
  const observedHost = hostObservation ?? {};
  let task = initialTask;
  const handoff = getHandoff(task.record, request.intent.handoff_id);
  if (handoff?.state !== 'completed')
    return failureReport(
      'apply',
      request,
      'needs_input',
      'transfer_not_completed',
      'Successor first work cannot be recorded before the core claim/assignee transfer.',
      'Reconcile the receiver ACK and transfer boundary first.',
      task,
      {
        host: { id: dependencies.host?.id ?? 'not-loaded', ...observedHost },
      },
    );
  const routeBinding = await ensureSuccessorRouteBinding(
    context,
    task,
    dependencies,
    now,
  );
  if (!routeBinding.ok)
    return {
      ...routeBinding.report,
      host: { id: dependencies.host?.id ?? 'not-loaded', ...observedHost },
    };
  task = routeBinding.task;
  let succession = (task.record.successions ?? []).find(
    (item) =>
      item.intent_id === request.intent.intent_id &&
      item.handoff_id === request.intent.handoff_id &&
      item.generation === request.intent.generation,
  );
  if (succession !== undefined) {
    const validation = validateSuccession(task.record, succession);
    if (!validation.ok)
      return failureReport(
        'apply',
        request,
        'needs_input',
        validation.code,
        validation.detail,
        'Reconcile the exact first-work REPORT and transfer boundary; retirement remains blocked.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    if (
      request.evidence.first_work_report_id !== null &&
      request.evidence.first_work_report_id !== validation.proof.message_id
    )
      return failureReport(
        'apply',
        request,
        'invalid',
        'first_work_report_conflict',
        'The request REPORT id differs from the first-work proof already recorded for this transition.',
        'Use the exact recorded first-work report; do not replace accepted evidence.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
  } else {
    const reportId = request.evidence.first_work_report_id;
    if (reportId === null)
      return failureReport(
        'apply',
        request,
        'waiting',
        'first_work_report_required',
        'Task retirement is waiting for an admitted successor first-work REPORT.',
        'Register/apply the exact completed successor REPORT, then reapply with its message id; no archive marker is written before it.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
          steps: [
            step('create-intent', 'satisfied'),
            step('source-quiescence', 'satisfied'),
            step('successor-bootstrap', 'satisfied'),
            step('receiver-ack', 'satisfied'),
            step('claim-route-transfer', 'satisfied'),
            step('first-work', 'waiting', 'first_work_report_required'),
            step('task-retirement', 'blocked', 'predecessor_step_unavailable'),
          ],
        },
      );
    const loadedReport = await readRegisteredTaskMessage(context, reportId);
    if (!loadedReport.ok)
      return failureReport(
        'apply',
        request,
        'waiting',
        'first_work_report_not_registered',
        `REPORT ${reportId} is not available as a safe registered message (${loadedReport.code}).`,
        'Register/apply the exact successor REPORT; submission alone is not first-work evidence.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    const latest = await openTaskStore(request.task_root);
    if (!latest.ok)
      return failureReport(
        'apply',
        request,
        'needs_input',
        latest.code,
        latest.message,
        latest.nextAction,
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    task = latest.value;
    const drift = currentStateDrift(task.record, request, 'successor');
    if (drift !== null)
      return failureReport(
        'apply',
        request,
        'needs_input',
        drift.code,
        drift.message,
        'Reconcile successor attempt, approval/cancellation, input, epoch, native identity and claim epochs before first-work recording.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    if (!registeredApplied(task.record, loadedReport.value, 'REPORT'))
      return failureReport(
        'apply',
        request,
        'waiting',
        'first_work_report_not_applied',
        'The REPORT file exists but the task ledger does not show it as applied.',
        'Apply the exact registered successor REPORT before first-work recording.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    const routeReceipt = journalEntry(
      task.record,
      request,
      context.requestDigest,
    );
    const routeFile = readTaskLocalFile(
      routeBinding.ref,
      task.taskRoot,
      64 * 1024,
    );
    if (
      routeReceipt?.effects['successor-route-binding']?.state !== 'completed' ||
      routeReceipt?.route_binding_ref !== routeBinding.ref ||
      routeReceipt?.route_binding_digest !== routeBinding.digest ||
      !routeFile.ok ||
      routeFile.digest !== routeBinding.digest
    )
      return failureReport(
        'apply',
        request,
        'reconcile_required',
        'successor_route_binding_receipt_missing',
        'The route binding changed before first-work recording.',
        'Reconcile the successor-only binding and journal before proceeding.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    const outcome = transact(task.taskRoot, {
      actor: request.intent.to.agent_id,
      purpose: 'session-transition:record-first-work',
      expectRevision: task.record.state_revision,
      clock: now(),
      apply: (record) => {
        if (dependencies.signal?.aborted)
          return { ok: false as const, reason: 'abort_requested' };
        const currentDrift = currentStateDrift(record, request, 'successor');
        if (currentDrift !== null)
          return { ok: false as const, reason: currentDrift.code };
        const savedRoute = journalEntry(record, request, context.requestDigest);
        if (
          savedRoute?.effects['successor-route-binding']?.state !==
            'completed' ||
          savedRoute?.route_binding_ref !== routeBinding.ref ||
          savedRoute?.route_binding_digest !== routeBinding.digest
        )
          return {
            ok: false as const,
            reason: 'successor_route_binding_receipt_missing',
          };
        const entry = (record.messages ?? []).find(
          (item) => item.message_id === reportId,
        );
        if (
          entry?.state !== 'applied' ||
          entry.content_digest !== loadedReport.value.message.content_digest ||
          entry.type !== 'REPORT'
        )
          return {
            ok: false as const,
            reason: 'first_work_report_not_applied',
          };
        const recorded = rollover.recordRolloverFirstWork(record, {
          intent_id: request.intent.intent_id,
          message: loadedReport.value.message,
          clock: now(),
        });
        if (!recorded.ok) return recorded;
        return {
          record,
          op: 'session-transition-record-first-work',
          summary: {
            transition_id: request.transition_id,
            report_message_id: reportId,
          },
          result: recorded,
        };
      },
    });
    if (!outcome.ok) {
      const waiting =
        outcome.reason === 'first_work_report_not_registered' ||
        outcome.reason === 'first_work_report_not_applied';
      return failureReport(
        'apply',
        request,
        waiting ? 'waiting' : 'needs_input',
        outcome.reason,
        'Core rollover refused the first-work proof.',
        'Reconcile the registered REPORT, post-transfer boundary and current successor claims before retirement.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    }
    const recordedTask = await openTaskStore(request.task_root);
    if (!recordedTask.ok)
      return failureReport(
        'apply',
        request,
        'unknown',
        recordedTask.code,
        recordedTask.message,
        recordedTask.nextAction,
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    task = recordedTask.value;
    succession = (task.record.successions ?? []).find(
      (item) =>
        item.intent_id === request.intent.intent_id &&
        item.handoff_id === request.intent.handoff_id &&
        item.generation === request.intent.generation,
    );
    if (succession === undefined)
      return failureReport(
        'apply',
        request,
        'unknown',
        'first_work_outcome_unconfirmed',
        'The core first-work reducer returned without a matching succession record.',
        'Inspect the authoritative task record; do not submit a second report.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
  }
  const validation = validateSuccession(task.record, succession);
  if (!validation.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      validation.code,
      validation.detail,
      'Reconcile the exact first-work REPORT and transfer boundary before retirement.',
      task,
      {
        host: { id: dependencies.host?.id ?? 'not-loaded', ...observedHost },
      },
    );
  const exclusion = routeExclusionFor(task.record, request.intent.from);
  if (exclusion.state !== 'excluded')
    return failureReport(
      'apply',
      request,
      'needs_input',
      exclusion.conflict ?? 'route_exclusion_unconfirmed',
      'The validated succession does not yet exclude the old identity from notify routing.',
      'Reconcile the succession record before retirement; native routing removal is still not claimed.',
      task,
      {
        host: { id: dependencies.host?.id ?? 'not-loaded', ...observedHost },
      },
    );
  const retirement = await ensureTaskRetirementMarker(
    context,
    task,
    routeBinding,
    dependencies,
    now,
  );
  if (!retirement.ok)
    return {
      ...retirement.report,
      host: { id: dependencies.host?.id ?? 'not-loaded', ...observedHost },
    };
  return transitionProgressReport(
    context,
    retirement.task,
    hostObservation,
    null,
    [
      step('create-intent', 'satisfied'),
      step('source-quiescence', 'satisfied'),
      step('successor-bootstrap', 'satisfied'),
      step('receiver-ack', 'satisfied'),
      step('claim-route-transfer', 'satisfied'),
      step('first-work', 'satisfied'),
      step('task-retirement', 'satisfied'),
    ],
    'A reversible task-retirement marker is recorded; the original transcript remains in place and native Pi session archive is unavailable.',
  );
}
