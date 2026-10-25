import path from 'node:path';
import { object as isRecord } from '../../infra/validation.js';
import { canonicalJson } from '../../collab/envelope.js';
import type { TaskRecord } from '../../collab/types.js';
import { collabBindingSchema } from '../../schemas/collaboration.js';
import {
  loadVisibleBootstrapRequest,
  type VisibleBootstrapReport,
} from '../collab-bootstrap.js';
import type { RolloverReport } from '../collab-rollover.js';
import { routeExclusionFor, validateSuccession } from '../collab-route.js';
import type { OpenedTaskStore } from '../collab-task-store.js';
import {
  immutableDigest,
  type SessionTransitionRequest,
} from '../collab-session-transition-request.js';
import {
  digestText,
  isDigest,
  isText,
  safePathEqual,
} from '../collab-session-transition-validation.js';
import { bootstrapData, readTaskLocalFile } from './context.js';
import {
  MAX_ARCHIVE_BYTES,
  getHandoff,
  getIntent,
  readJournal,
} from './journal.js';
import {
  COLLAB_SESSION_TRANSITION_REPORT_SCHEMA,
  MANAGED_PI_SCOPED_PROOF_ADAPTER_ID,
  MANAGED_PI_SCOPED_RECEIPT_SCHEMA,
  SESSION_TRANSITION_ARCHIVE_SCHEMA,
  type SessionTransitionAction,
  type SessionTransitionHostObservation,
  type SessionTransitionJournalEntry,
  type SessionTransitionQuiescenceReceipt,
  type SessionTransitionReport,
  type SessionTransitionStage,
  type SessionTransitionStatus,
  type SessionTransitionStep,
} from './types.js';

export {
  LIMITATIONS,
  capabilities,
  causeRef,
  emptyReport,
  exactQuiescenceReceipt,
  exactRetirementReceipt,
  exactRouteBindingReceipt,
  failureReport,
  reportForContext,
  step,
};

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
