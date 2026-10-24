import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, readRegisteredMessage } from '../collab/envelope.js';
import { findAttempt } from '../collab/lifecycle.js';
import { isAssignment } from '../collab/contracts.js';
import { describeResource } from '../collab/canonical.js';
import { transact } from '../collab/store.js';
import type { TaskRecord } from '../collab/types.js';
import { createLocalTaskRecordReader } from '../hosts/integration/pi-bootstrap-runtime.js';
import type { ManagedPiSdkSessionSnapshot } from '../hosts/pi/managed-sdk-session.js';
import {
  assertManagedPiSdkResumeAuthorization,
  issueManagedPiResumeCapability,
  isManagedPiResumeCapabilityReserved,
  markManagedPiResumeCapabilityRegistered,
  revokeManagedPiResumeCapability,
  type ManagedPiSdkResumeAuthorization,
} from '../hosts/pi/resume-capability.js';
import { managedPiHostIdentity } from '../hosts/pi/managed-host-identity.js';
import {
  captureProcessIdentity,
  isLocalProcessIdentity,
  observeProcessIdentity,
  type LocalProcessIdentity,
} from '../infra/process-identity.js';
import type { ManagedPiExecutionScope } from '../schemas/managed-pi-execution.js';
import type { ManagedPiRequest } from './managed-pi.js';
import { readBoundedFile } from './bounded-file.js';

export interface ManagedPiResumeConfig {
  readonly sourceJournalPath: string;
  readonly sourceSessionFile: string;
  readonly sourceRunId: string;
}

export { assertManagedPiSdkResumeAuthorization };
export type { ManagedPiSdkResumeAuthorization };

export interface ManagedPiResumeRuntimeRegistration {
  readonly schema: 'pappra/managed-pi-runtime/1';
  readonly agent_id: string;
  readonly session_id: string;
  readonly pid: number;
  readonly descriptor_file: string;
  readonly controller_run_id: string;
  readonly input_revision: string;
  readonly scope: ManagedPiExecutionScope;
  readonly pane_id?: string | null;
}

interface FilePin {
  readonly file: string;
  readonly dev: number;
  readonly ino: number;
  readonly digest: string;
  readonly parentDev: number;
  readonly parentIno: number;
  readonly ownerOnly: boolean;
}

interface ResumeState {
  readonly pid: number;
  readonly reader: ReturnType<typeof createLocalTaskRecordReader>;
  readonly journal: FilePin;
  readonly descriptor: FilePin;
  readonly transcript: FilePin;
  readonly source: ManagedPiResumeRuntimeRegistration;
  readonly sourceJson: string;
  readonly reservationId: string;
  readonly newJournal: string;
  readonly authorityDigest: string;
}

const AUTHORIZATIONS = new WeakMap<object, ResumeState>();
const RESERVATIONS = 'managed_pi_resume_admissions';
const REGISTRY = 'managed_pi_runtime_registry';
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const digest = (value: string) =>
  crypto.createHash('sha256').update(value).digest('hex');
const fail = (code: string): never => {
  throw new Error(`managed_pi_resume_${code}`);
};

function parse(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return fail('invalid_json');
  }
  return object(value) ? value : fail('invalid_record');
}

function pin(
  file: string,
  maxBytes: number,
  ownerOnly = true,
): { pin: FilePin; text: string } {
  const parent = path.dirname(file);
  const directory = fs.lstatSync(parent);
  const stat = fs.lstatSync(file);
  if (
    !path.isAbsolute(file) ||
    fs.realpathSync(file) !== file ||
    fs.realpathSync(parent) !== parent ||
    !directory.isDirectory() ||
    (directory.mode & 0o022) !== 0 ||
    !stat.isFile() ||
    (stat.mode & (ownerOnly ? 0o077 : 0o022)) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    return fail('private_file_unsafe');
  const loaded = readBoundedFile(file, maxBytes);
  const after = fs.lstatSync(file);
  const parentAfter = fs.lstatSync(parent);
  if (
    !loaded.ok ||
    after.dev !== stat.dev ||
    after.ino !== stat.ino ||
    after.size !== stat.size ||
    after.mtimeMs !== stat.mtimeMs ||
    after.ctimeMs !== stat.ctimeMs ||
    parentAfter.dev !== directory.dev ||
    parentAfter.ino !== directory.ino
  )
    return fail('private_file_changed');
  return {
    pin: {
      file,
      dev: stat.dev,
      ino: stat.ino,
      digest: loaded.digest,
      parentDev: directory.dev,
      parentIno: directory.ino,
      ownerOnly,
    },
    text: loaded.text,
  };
}

function assertPinned(expected: FilePin, maxBytes: number): void {
  const current = pin(expected.file, maxBytes, expected.ownerOnly).pin;
  if (canonicalJson(current) !== canonicalJson(expected))
    fail('source_file_changed');
}

function assertDead(pid: number, identity?: LocalProcessIdentity): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('source_pid_invalid');
  if (identity) {
    if (identity.pid !== pid || observeProcessIdentity(identity) !== 'dead')
      fail('source_still_alive_or_unverified');
    return;
  }
  if (pid === process.pid) fail('source_pid_invalid');
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (object(error) && error.code === 'ESRCH') return;
    return fail('source_death_unknown');
  }
  fail('source_still_alive');
}

function assertIdle(
  snapshot: unknown,
): asserts snapshot is ManagedPiSdkSessionSnapshot {
  if (!object(snapshot)) fail('checkpoint_inventory_missing');
  const s = snapshot as unknown as ManagedPiSdkSessionSnapshot;
  try {
    const { queues, work, extensionDialogs, builtInUiApprovals } =
      s.ownedRuntime;
    const internal = queues.internal;
    const counts = [
      queues.pendingMessageCount,
      queues.steering.length,
      queues.followUp.length,
      internal.pendingNextTurn?.length,
      internal.pendingCustom?.length,
      internal.pendingBash?.length,
      internal.deferredSettledActionCount,
      internal.pendingUserInputs?.length,
      internal.compactionMessages?.length,
      internal.extensionDialogCount,
      extensionDialogs.pending.length,
      work.pendingToolCalls,
    ];
    if (
      !s.ingress.healthy ||
      s.ingress.state !== 'open' ||
      queues.completeness !== 'complete' ||
      work.observation !== 'complete' ||
      extensionDialogs.completeness !== 'complete' ||
      builtInUiApprovals.observation !== 'complete' ||
      work.isIdle !== true ||
      work.isStreaming !== false ||
      work.isCompacting !== false ||
      work.isBashRunning !== false ||
      work.hasPendingBashMessages !== false ||
      internal.activeSelector !== false ||
      counts.some((count) => count !== 0)
    )
      fail('checkpoint_not_idle');
  } catch {
    fail('checkpoint_not_idle');
  }
}

function sourceRuntime(record: TaskRecord, sessionId: string) {
  const rows = record[REGISTRY];
  if (!Array.isArray(rows)) return fail('source_not_registered');
  const matches = rows.filter(
    (row: unknown) => object(row) && row.session_id === sessionId,
  );
  if (matches.length !== 1) return fail('source_not_registered');
  return matches[0] as ManagedPiResumeRuntimeRegistration;
}

/** Reused before opening, inside registry replacement, and at every resumed execution gate. */
function authority(record: TaskRecord, scope: ManagedPiExecutionScope): string {
  const attempt = findAttempt(record, scope.subtask_id, scope.attempt);
  const latest = record.attempts
    .filter((row) => row.subtask_id === scope.subtask_id)
    .reduce((maximum, row) => Math.max(maximum, row.attempt), 0);
  if (
    scope.schema !== 'pappra/managed-pi-execution-scope/1' ||
    record.task_id !== scope.task_id ||
    record.task_root !== scope.task_root ||
    path.basename(scope.task_root) !== scope.task_id ||
    record.coordinator?.owner_epoch !== scope.owner_epoch ||
    record.dispatch_frozen === true ||
    !attempt ||
    latest !== scope.attempt ||
    !['assigned', 'accepted', 'running'].includes(attempt.state) ||
    attempt.awaiting !== undefined ||
    attempt.cancel_requested_at !== undefined ||
    attempt.closed_at !== undefined ||
    attempt.owner_epoch !== scope.owner_epoch ||
    attempt.assignee.session_id !== scope.session_id ||
    attempt.assignee.harness !== 'pi' ||
    attempt.assignee.cwd !== scope.cwd ||
    !attempt.assignment_ref ||
    !attempt.assignment_digest ||
    !attempt.input_revision ||
    record.uncertainty.some(
      (row) =>
        !row.resolved_at &&
        row.subtask_id === scope.subtask_id &&
        row.attempt === scope.attempt,
    ) ||
    (record.rollover ?? []).some(
      (row) =>
        row.subtask_id === scope.subtask_id &&
        row.attempt === scope.attempt &&
        row.from.session_id === scope.session_id,
    )
  )
    return fail('task_authority_stale');
  const artifact = readBoundedFile(attempt.assignment_ref, 1024 * 1024);
  if (!artifact.ok || artifact.digest !== attempt.assignment_digest)
    return fail('assignment_changed');
  const assignment = parse(artifact.text);
  if (
    !isAssignment(assignment) ||
    assignment.task_id !== scope.task_id ||
    assignment.attempt !== scope.attempt ||
    assignment.assignee.agent_id !== attempt.assignee.agent_id ||
    assignment.assignee.session_id !== scope.session_id ||
    assignment.assignee.cwd !== scope.cwd ||
    assignment.coordinator.agent_id !== record.coordinator?.agent_id ||
    assignment.coordinator.session_id !== record.coordinator?.session_id ||
    assignment.coordinator.owner_epoch !== scope.owner_epoch
  )
    return fail('assignment_identity_changed');
  const admitted = record.messages.find(
    (row) =>
      row.message_id === attempt.assignment_message_id &&
      row.state === 'applied',
  );
  const registered = readRegisteredMessage(
    record.task_root,
    attempt.assignment_message_id,
  );
  if (
    !admitted ||
    !registered ||
    registered.type !== 'ASSIGN' ||
    admitted.content_digest !== registered.content_digest ||
    registered.task_id !== scope.task_id ||
    registered.subtask_id !== scope.subtask_id ||
    registered.attempt !== scope.attempt ||
    registered.owner_epoch !== scope.owner_epoch ||
    registered.from.agent_id !== record.coordinator?.agent_id ||
    registered.from.session_id !== record.coordinator?.session_id ||
    registered.to.agent_id !== attempt.assignee.agent_id ||
    registered.to.session_id !== scope.session_id ||
    registered.to.harness !== 'pi' ||
    registered.body.assignment_ref !== attempt.assignment_ref ||
    registered.body.assignment_digest !== attempt.assignment_digest ||
    registered.body.input_revision !== attempt.input_revision ||
    canonicalJson(registered.body.approval ?? null) !==
      canonicalJson(attempt.approval)
  )
    return fail('assignment_not_admitted');
  const claims = record.claims.filter(
    (claim) =>
      claim.subtask_id === scope.subtask_id &&
      claim.attempt === scope.attempt &&
      !claim.released_at,
  );
  if (
    !scope.claim_epochs.length ||
    claims.length !== scope.claim_epochs.length ||
    new Set(scope.claim_epochs.map((row) => row.claim_id)).size !==
      claims.length ||
    claims.some(
      (claim) =>
        claim.cancel_pending ||
        claim.holder.agent_id !== attempt.assignee.agent_id ||
        claim.holder.session_id !== scope.session_id ||
        claim.holder.harness !== 'pi' ||
        !scope.claim_epochs.some(
          (pin) =>
            pin.claim_id === claim.claim_id &&
            pin.resource_epoch === claim.resource_epoch,
        ),
    )
  )
    return fail('claim_authority_stale');
  const used = new Set<string>();
  for (const resource of assignment.resources) {
    const descriptor = describeResource({
      path: resource.path,
      ...(resource.kind === undefined ? {} : { kind: resource.kind }),
      ...(resource.scope === undefined ? {} : { scope: resource.scope }),
    });
    const matched = claims.find(
      (claim) =>
        !used.has(claim.claim_id) &&
        claim.path === descriptor.path &&
        claim.access === resource.access &&
        (resource.resource_epoch === undefined ||
          resource.resource_epoch === claim.resource_epoch),
    );
    if (!matched) return fail('assignment_claim_mismatch');
    used.add(matched.claim_id);
  }
  if (used.size !== claims.length) return fail('assignment_claim_mismatch');
  return digest(
    canonicalJson({
      coordinator: record.coordinator,
      assignee: attempt.assignee,
      input: attempt.input_revision,
      assignment: artifact.digest,
      approval: attempt.approval,
      claims: scope.claim_epochs,
    }),
  );
}

function reservations(record: TaskRecord): Record<string, unknown>[] {
  const value = record[RESERVATIONS];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || !value.every(object))
    return fail('reservation_registry_invalid');
  return value;
}

/** Reclaim only owners proven dead; a reused or inaccessible PID stays reserved. */
function reservationOwnerDead(row: Record<string, unknown>): boolean {
  if (isLocalProcessIdentity(row.process_identity))
    return (
      row.process_identity.pid === row.pid &&
      observeProcessIdentity(row.process_identity) === 'dead'
    );
  if (!Number.isSafeInteger(row.pid) || Number(row.pid) <= 0) return false;
  if (
    typeof row.host_identity === 'string' &&
    row.host_identity !== managedPiHostIdentity()
  )
    return false;
  try {
    process.kill(Number(row.pid), 0);
    return false;
  } catch (error) {
    return object(error) && error.code === 'ESRCH';
  }
}

function validReservation(
  record: TaskRecord,
  state: ResumeState,
  expectedStatus: string,
): boolean {
  const selected = reservations(record).filter(
    (row) => row.reservation_id === state.reservationId,
  );
  return (
    selected.length === 1 &&
    selected[0]!.pid === process.pid &&
    selected[0]!.journal_path === state.newJournal &&
    selected[0]!.status === expectedStatus &&
    selected[0]!.source_run_id === state.source.controller_run_id
  );
}

function verifyJournal(text: string): Record<string, unknown>[] {
  if (!text.endsWith('\n')) return fail('source_journal_partial');
  let previous = '0'.repeat(64);
  let journalRunId: unknown;
  return text
    .trimEnd()
    .split('\n')
    .map((line, index) => {
      const row = parse(line);
      if (index === 0) {
        journalRunId = row.run_id;
        if (
          typeof journalRunId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(journalRunId)
        )
          return fail('source_journal_invalid');
      }
      const { digest: recorded, ...body } = row;
      if (
        row.schema !== 'harness-collab/pi-managed-session/1' ||
        row.run_id !== journalRunId ||
        row.sequence !== index + 1 ||
        row.previous_digest !== previous ||
        recorded !== digest(JSON.stringify(body))
      )
        return fail('source_journal_invalid');
      previous = String(recorded);
      return row;
    });
}

export async function prepareManagedPiResume(
  request: ManagedPiRequest,
): Promise<ManagedPiSdkResumeAuthorization> {
  const config = request.resume;
  const scope = request.executionScope;
  if (
    !config ||
    !scope ||
    !request.sessionId ||
    scope.session_id !== request.sessionId ||
    scope.cwd !== request.cwd ||
    request.journalPath === config.sourceJournalPath ||
    fs.existsSync(request.journalPath) ||
    request.initialAssignment ||
    request.automaticHandoffFile ||
    request.bootstrapExtensionPath ||
    request.handoffContextFile
  )
    return fail('request_invalid');
  const reader = createLocalTaskRecordReader(
    path.dirname(path.dirname(scope.task_root)),
    scope.task_id,
  );
  const record = reader.read();
  const authorityDigest = authority(record, scope);
  const source = sourceRuntime(record, scope.session_id);
  if (
    source.pane_id &&
    source.pane_id !==
      (request.herdrPaneId ?? process.env.HERDR_PANE_ID ?? null)
  )
    return fail('source_pane_changed');
  if (
    source.schema !== 'pappra/managed-pi-runtime/1' ||
    source.controller_run_id !== config.sourceRunId ||
    source.descriptor_file !== `${config.sourceJournalPath}.control.json` ||
    canonicalJson(source.scope) !== canonicalJson(scope) ||
    source.input_revision !==
      findAttempt(record, scope.subtask_id, scope.attempt)?.input_revision
  )
    return fail('source_registration_mismatch');
  const journal = pin(config.sourceJournalPath, MAX_JOURNAL_BYTES);
  const descriptor = pin(source.descriptor_file, 4096);
  const control = parse(descriptor.text);
  if (
    control.schema !== 'harness-collab/pi-managed-control/1' ||
    control.runId !== source.controller_run_id ||
    control.sessionId !== scope.session_id
  )
    return fail('source_descriptor_mismatch');
  // The private control endpoint and journal each generate their own run ID.
  // Descriptor/registry pins bind the endpoint; the chain independently pins its run.
  const rows = verifyJournal(journal.text);
  const checkpointIndex = rows.findLastIndex(
    (row) => row.kind === 'sdk_resume_checkpoint',
  );
  const checkpoint = rows[checkpointIndex];
  if (
    !checkpoint ||
    checkpoint.checkpoint_schema !== 'pappra/managed-pi-resume-checkpoint/1' ||
    checkpoint.session_id !== scope.session_id ||
    checkpoint.session_file !== config.sourceSessionFile ||
    checkpoint.cwd !== scope.cwd ||
    checkpoint.model !== request.model ||
    checkpoint.process_pid !== source.pid ||
    canonicalJson(checkpoint.execution_scope ?? null) !== canonicalJson(scope)
  )
    return fail('checkpoint_missing_or_mismatched');
  assertIdle(checkpoint.snapshot);
  const hostIdentity = managedPiHostIdentity();
  const sourceProcessIdentity = isLocalProcessIdentity(
    checkpoint.process_identity,
  )
    ? checkpoint.process_identity
    : undefined;
  if (
    !hostIdentity ||
    (!sourceProcessIdentity && checkpoint.host_identity !== hostIdentity)
  )
    return fail('source_host_mismatch');
  assertDead(source.pid, sourceProcessIdentity);
  if (
    checkpoint.snapshot.session.sessionId !== scope.session_id ||
    checkpoint.snapshot.session.sessionFile !== config.sourceSessionFile ||
    checkpoint.snapshot.process.pid !== source.pid ||
    checkpoint.snapshot.ingress.journalPath !== config.sourceJournalPath
  )
    return fail('checkpoint_native_identity_mismatch');
  for (const row of rows.slice(checkpointIndex + 1)) {
    if (
      row.kind === 'sdk_queue_observed' &&
      Array.isArray(row.steering) &&
      row.steering.length === 0 &&
      Array.isArray(row.follow_up) &&
      row.follow_up.length === 0
    )
      continue;
    if (
      !['sdk_session_ready', 'sdk_resources_ready'].includes(String(row.kind))
    )
      return fail('checkpoint_invalidated');
  }
  // Native Pi history follows the user's umask; it must not be writable by others.
  // Authenticated journals and control descriptors retain owner-only access.
  const transcript = pin(config.sourceSessionFile, MAX_TRANSCRIPT_BYTES, false);
  const header = parse(transcript.text.split('\n')[0] ?? '');
  if (
    header.type !== 'session' ||
    header.id !== scope.session_id ||
    header.cwd !== scope.cwd ||
    checkpoint.transcript_digest !== transcript.pin.digest
  )
    return fail('transcript_changed');
  const messages = transcript.text
    .trimEnd()
    .split('\n')
    .slice(1)
    .map(parse)
    .filter((entry) => entry.type === 'message' && object(entry.message));
  const lastAssistant = messages.findLast(
    (entry) => object(entry.message) && entry.message.role === 'assistant',
  )?.message;
  if (object(lastAssistant) && lastAssistant.stopReason !== 'stop')
    return fail('native_outcome_unresolved');
  const inputMap = new Map<string, string>();
  const inherited = checkpoint.registered_inputs ?? [];
  if (!Array.isArray(inherited)) return fail('input_dedup_invalid');
  const inputs = [
    ...inherited,
    ...rows.filter((row) => row.kind === 'sdk_control_input_reserved'),
  ];
  for (const input of inputs) {
    if (
      !object(input) ||
      typeof input.request_id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.request_id) ||
      typeof input.input_digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.input_digest) ||
      (inputMap.has(input.request_id) &&
        inputMap.get(input.request_id) !== input.input_digest)
    )
      return fail('input_dedup_invalid');
    inputMap.set(input.request_id, input.input_digest);
  }
  if (inputMap.size > 256) return fail('input_dedup_limit');
  const frozenScope = JSON.parse(
    JSON.stringify(scope),
  ) as ManagedPiExecutionScope;
  for (const claim of frozenScope.claim_epochs) Object.freeze(claim);
  Object.freeze(frozenScope.claim_epochs);
  Object.freeze(frozenScope);
  const authorization: ManagedPiSdkResumeAuthorization =
    issueManagedPiResumeCapability(
      {
        sessionId: scope.session_id,
        cwd: scope.cwd,
        sessionFile: config.sourceSessionFile,
        transcriptDigest: transcript.pin.digest,
        scope: frozenScope,
        checkpointSequence: Number(checkpoint.sequence),
        checkpointDigest: String(checkpoint.digest),
        sourceRunId: source.controller_run_id,
        sourcePid: source.pid,
        ...(sourceProcessIdentity ? { sourceProcessIdentity } : {}),
        hostIdentity,
        registeredInputs: Object.freeze(
          [...inputMap].map(([requestId, inputDigest]) =>
            Object.freeze({ requestId, inputDigest }),
          ),
        ),
      },
      (expected) => assertCurrentResumeAdmission(authorization, expected),
    );
  const reservationId = digest(
    canonicalJson({
      session: scope.session_id,
      sourceRun: source.controller_run_id,
      checkpoint: checkpoint.digest,
    }),
  );
  const state: ResumeState = {
    pid: process.pid,
    reader,
    journal: journal.pin,
    descriptor: descriptor.pin,
    transcript: transcript.pin,
    source,
    sourceJson: canonicalJson(source),
    reservationId,
    newJournal: request.journalPath,
    authorityDigest,
  };
  const saved = transact(scope.task_root, {
    actor: 'managed-pi-resume',
    purpose: 'reserve-exact-session-resume',
    apply(current) {
      assertDead(source.pid, sourceProcessIdentity);
      if (
        authority(current, scope) !== authorityDigest ||
        canonicalJson(sourceRuntime(current, scope.session_id)) !==
          state.sourceJson
      )
        return { ok: false, reason: 'managed_pi_resume_authority_changed' };
      const pending = reservations(current).filter(
        (row) => !reservationOwnerDead(row),
      );
      if (
        pending.length >= 64 ||
        pending.some((row) => row.source_run_id === source.controller_run_id)
      )
        return { ok: false, reason: 'managed_pi_resume_already_reserved' };
      pending.push({
        schema: 'pappra/managed-pi-resume-admission/1',
        reservation_id: reservationId,
        session_id: scope.session_id,
        source_run_id: source.controller_run_id,
        checkpoint_digest: checkpoint.digest,
        pid: process.pid,
        process_identity: captureProcessIdentity(),
        host_identity: hostIdentity,
        journal_path: request.journalPath,
        status: 'reserved',
        created_at: new Date().toISOString(),
      });
      current[RESERVATIONS] = pending;
      return {
        record: current,
        op: 'reserve-managed-pi-resume',
        summary: { session_id: scope.session_id },
        result: null,
      };
    },
  });
  if (!saved.ok) return fail('already_reserved_or_stale');
  AUTHORIZATIONS.set(authorization, state);
  try {
    assertManagedPiSdkResumeAuthorization(authorization, {
      sessionId: scope.session_id,
      cwd: scope.cwd,
    });
  } catch (error) {
    releaseManagedPiResume(authorization);
    throw error;
  }
  return authorization;
}

/** Release this process's exact reservation after startup failure or runtime shutdown. */
export function releaseManagedPiResume(
  value: ManagedPiSdkResumeAuthorization,
): boolean {
  const state = AUTHORIZATIONS.get(value);
  if (!state || state.pid !== process.pid) return true;
  try {
    const released = transact(value.scope.task_root, {
      actor: 'managed-pi-resume',
      purpose: 'release-exact-session-resume',
      apply(record) {
        record[RESERVATIONS] = reservations(record).filter(
          (row) =>
            row.reservation_id !== state.reservationId ||
            row.pid !== state.pid ||
            row.journal_path !== state.newJournal,
        );
        return {
          record,
          op: 'release-managed-pi-resume',
          summary: { session_id: value.sessionId },
          result: null,
        };
      },
    });
    if (!released.ok) return false;
    revokeManagedPiResumeCapability(value);
    AUTHORIZATIONS.delete(value);
    return true;
  } catch {
    // Cleanup failure must not replace the original startup/runtime error.
    // The exact dead process identity permits a later admission to reclaim it.
    return false;
  }
}

function assertCurrentResumeAdmission(
  value: ManagedPiSdkResumeAuthorization,
  expected: { sessionId: string; cwd: string },
): void {
  const state = AUTHORIZATIONS.get(value);
  if (
    !state ||
    state.pid !== process.pid ||
    !isManagedPiResumeCapabilityReserved(value) ||
    value.sessionId !== expected.sessionId ||
    value.cwd !== expected.cwd
  )
    return fail('authorization_invalid');
  if (managedPiHostIdentity() !== value.hostIdentity)
    return fail('source_host_mismatch');
  assertDead(value.sourcePid, value.sourceProcessIdentity);
  assertPinned(state.journal, MAX_JOURNAL_BYTES);
  assertPinned(state.descriptor, 4096);
  assertPinned(state.transcript, MAX_TRANSCRIPT_BYTES);
  const record = state.reader.read();
  if (
    authority(record, value.scope) !== state.authorityDigest ||
    !validReservation(record, state, 'reserved') ||
    canonicalJson(sourceRuntime(record, value.sessionId)) !== state.sourceJson
  )
    fail('authorization_stale');
}

/** Called only inside the task-store transaction that replaces the exact old registry entry. */
export function consumeManagedPiResumeRegistration(
  record: TaskRecord,
  value: ManagedPiSdkResumeAuthorization,
  old: ManagedPiResumeRuntimeRegistration,
  next: ManagedPiResumeRuntimeRegistration,
): void {
  const state = AUTHORIZATIONS.get(value);
  if (
    !state ||
    !isManagedPiResumeCapabilityReserved(value) ||
    state.pid !== process.pid ||
    !validReservation(record, state, 'reserved') ||
    authority(record, value.scope) !== state.authorityDigest ||
    canonicalJson(old) !== state.sourceJson ||
    next.session_id !== value.sessionId ||
    next.pid !== process.pid ||
    next.agent_id !== old.agent_id ||
    next.input_revision !== old.input_revision ||
    next.controller_run_id === old.controller_run_id ||
    next.descriptor_file !== `${state.newJournal}.control.json` ||
    canonicalJson(next.scope) !== canonicalJson(value.scope)
  )
    return fail('registration_not_authorized');
  assertDead(value.sourcePid, value.sourceProcessIdentity);
  assertPinned(state.journal, MAX_JOURNAL_BYTES);
  assertPinned(state.descriptor, 4096);
  const reservation = reservations(record).find(
    (row) => row.reservation_id === state.reservationId,
  )!;
  reservation.status = 'registered';
  reservation.controller_run_id = next.controller_run_id;
  reservation.registered_at = new Date().toISOString();
}

/** Enable ongoing authority checks only after the durable new registry entry exists. */
export function canExecuteManagedPiResume(
  value: ManagedPiSdkResumeAuthorization,
  native: { readonly sessionId: string; readonly cwd: string },
): boolean {
  const state = AUTHORIZATIONS.get(value);
  if (
    !state ||
    state.pid !== process.pid ||
    native.sessionId !== value.sessionId ||
    path.resolve(native.cwd) !== value.cwd
  )
    return false;
  try {
    const record = state.reader.read();
    if (
      authority(record, value.scope) !== state.authorityDigest ||
      !validReservation(record, state, 'registered')
    )
      return false;
    const current = sourceRuntime(record, value.sessionId);
    const registered =
      current.pid === process.pid &&
      current.descriptor_file === `${state.newJournal}.control.json`;
    if (registered) markManagedPiResumeCapabilityRegistered(value);
    return registered;
  } catch {
    return false;
  }
}
