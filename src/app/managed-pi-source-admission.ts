import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  isAssignment,
  isCard,
  type Assignment,
  type CapabilityCard,
} from '../collab/contracts.js';
import { canonicalJson } from '../collab/envelope.js';
import { transact } from '../collab/store.js';
import type { Attempt, Identity, TaskRecord } from '../collab/types.js';
import { ManagedPiSdkSessionController } from '../hosts/pi/managed-sdk-session.js';
import type { ManagedPiExecutionScope } from './collab-session-transition.js';
import type { ManagedPiReadinessConfig } from './managed-pi-readiness.js';
import { validateSuccession } from './collab-route.js';
import { readBoundedFile } from './bounded-file.js';
import { openTaskStore, assertTaskStoreCurrent } from './collab-task-store.js';

const FIELD = 'managed_pi_source_admissions';
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: Identity, b: Identity) =>
  a.agent_id === b.agent_id &&
  a.session_id === b.session_id &&
  a.harness === b.harness;
const samePath = (a: string, b: string) => path.resolve(a) === path.resolve(b);
const digest = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
interface Admission {
  readonly schema: 'pappra/managed-source-admission/1';
  readonly task_id: string;
  readonly subtask_id: string;
  readonly attempt: number;
  readonly input_revision: string;
  readonly owner_epoch: number;
  readonly origin_ref: string;
  readonly origin_digest: string;
  readonly assignment_ref: string;
  readonly assignment_digest: string;
  readonly actor: Assignment['assignee'];
  readonly scope: ManagedPiExecutionScope;
  readonly controller_run_id: string;
  readonly predecessor_handoff_id: string;
  readonly predecessor_proof_digest: string;
  readonly claims: readonly {
    readonly claim_id: string;
    readonly resource_epoch: number;
    readonly path: string;
    readonly access: string;
    readonly key: string;
  }[];
}
function rows(record: TaskRecord): Admission[] {
  const value = record[FIELD];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    !value.every(
      (row) =>
        object(row) &&
        row.schema === 'pappra/managed-source-admission/1' &&
        object(row.actor) &&
        object(row.scope) &&
        Array.isArray(row.claims) &&
        row.claims.length > 0 &&
        row.claims.length <= 1024,
    )
  )
    throw new Error('managed_source_admissions_invalid');
  return value as Admission[];
}
function origin(attempt: Attempt): {
  assignment: Assignment;
  digest: string;
  file: string;
} {
  if (!attempt.assignment_ref || !attempt.assignment_digest)
    throw new Error('managed_source_origin_missing');
  const bytes = readBoundedFile(attempt.assignment_ref, 1024 * 1024);
  if (!bytes.ok || bytes.digest !== attempt.assignment_digest)
    throw new Error('managed_source_origin_changed');
  const value: unknown = JSON.parse(bytes.text);
  if (!isAssignment(value)) throw new Error('managed_source_origin_invalid');
  return {
    assignment: value,
    digest: bytes.digest,
    file: attempt.assignment_ref,
  };
}
function predecessor(record: TaskRecord, actor: Identity, handoffId?: string) {
  const matches = (record.successions ?? []).filter(
    (entry) =>
      entry.successor_native.agent_id === actor.agent_id &&
      entry.successor_native.session_id === actor.session_id &&
      (handoffId === undefined || entry.handoff_id === handoffId),
  );
  if (matches.length !== 1)
    throw new Error('managed_source_succession_missing_or_ambiguous');
  const checked = validateSuccession(record, matches[0]);
  if (!checked.ok) throw new Error('managed_source_succession_unverified');
  return checked;
}
function derived(base: Assignment, entry: Admission): Assignment {
  if (
    base.task_id !== entry.task_id ||
    base.attempt !== entry.attempt ||
    base.coordinator.owner_epoch !== entry.owner_epoch ||
    !samePath(base.assignee.cwd, entry.actor.cwd) ||
    base.resources.length !== entry.claims.length
  )
    throw new Error('managed_source_derivation_scope_mismatch');
  return {
    ...structuredClone(base),
    assignee: { ...entry.actor },
    resources: base.resources.map((resource) => {
      const claims = entry.claims.filter(
        (claim) =>
          samePath(claim.path, resource.path) &&
          claim.access === resource.access,
      );
      if (claims.length !== 1)
        throw new Error('managed_source_derivation_claim_mismatch');
      return { ...resource, resource_epoch: claims[0]!.resource_epoch };
    }),
  };
}

/** Original ASSIGN pins stay immutable. A completed succession permits a bounded current-source view. */
export function readManagedSourceAssignment(
  record: TaskRecord,
  attempt: Attempt,
  actor: Identity = attempt.assignee,
) {
  const base = origin(attempt);
  if (same(base.assignment.assignee, actor))
    return { ...base, originalDigest: base.digest };
  const matches = rows(record).filter(
    (entry) =>
      same(entry.actor, actor) &&
      entry.subtask_id === attempt.subtask_id &&
      entry.attempt === attempt.attempt,
  );
  if (matches.length !== 1)
    throw new Error('managed_source_admission_missing_or_ambiguous');
  const entry = matches[0]!;
  const lineage = predecessor(record, actor, entry.predecessor_handoff_id);
  const runtime = record.managed_pi_runtime_registry;
  if (
    !Array.isArray(runtime) ||
    !runtime.some(
      (row: unknown) =>
        object(row) &&
        row.session_id === actor.session_id &&
        row.controller_run_id === entry.controller_run_id &&
        canonicalJson(row.scope) === canonicalJson(entry.scope),
    ) ||
    entry.origin_ref !== base.file ||
    entry.origin_digest !== base.digest ||
    entry.task_id !== record.task_id ||
    entry.input_revision !== attempt.input_revision ||
    entry.owner_epoch !== attempt.owner_epoch ||
    entry.predecessor_proof_digest !== lineage.exclusion.proof_digest ||
    entry.claims.length !== lineage.intent.claims.length ||
    !entry.claims.every(
      (claim) =>
        lineage.intent.claims.some(
          (old) =>
            old.claim_id === claim.claim_id &&
            old.resource_epoch + 1 === claim.resource_epoch,
        ) &&
        record.claims.some(
          (stored) =>
            stored.claim_id === claim.claim_id &&
            stored.key === claim.key &&
            stored.path !== null &&
            stored.path !== undefined &&
            samePath(stored.path, claim.path) &&
            stored.access === claim.access,
        ),
    )
  )
    throw new Error('managed_source_admission_lineage_mismatch');
  const file = readBoundedFile(entry.assignment_ref, 1024 * 1024);
  if (!file.ok || file.digest !== entry.assignment_digest)
    throw new Error('managed_source_assignment_changed');
  const assignment: unknown = JSON.parse(file.text);
  if (
    !isAssignment(assignment) ||
    canonicalJson(assignment) !== canonicalJson(derived(base.assignment, entry))
  )
    throw new Error('managed_source_assignment_derivation_mismatch');
  return {
    assignment,
    digest: file.digest,
    file: entry.assignment_ref,
    originalDigest: base.digest,
  };
}
function writeImmutable(file: string, value: unknown) {
  const parent = fs.lstatSync(path.dirname(file));
  if (
    !path.isAbsolute(file) ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.mode & 0o077 ||
    fs.realpathSync(path.dirname(file)) !== path.dirname(file)
  )
    throw new Error('managed_source_output_not_private');
  const text = `${canonicalJson(value)}\n`;
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    const old = readBoundedFile(file, 1024 * 1024);
    if (!old.ok || old.digest !== digest(text))
      throw new Error('managed_source_output_conflict');
  } else {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const directory = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  }
  return digest(text);
}

/** Called only inside the successor's owned SDK process after its real first work. */
export async function admitManagedSourceAssignment(
  controller: ManagedPiSdkSessionController,
  scope: ManagedPiExecutionScope,
  readiness: ManagedPiReadinessConfig,
): Promise<void> {
  const native = controller.observe();
  if (
    !(controller instanceof ManagedPiSdkSessionController) ||
    controller.isDisposed ||
    controller.snapshot().process.pid !== process.pid ||
    native.native.sessionId !== scope.session_id ||
    native.cwd !== scope.cwd ||
    !native.native.agentId ||
    !native.native.surface ||
    !native.native.configurationId
  )
    throw new Error('managed_source_runtime_not_owned');
  const opened = await openTaskStore(scope.task_root);
  if (!opened.ok) throw new Error('managed_source_task_unavailable');
  const record = opened.value.record;
  const attempt = record.attempts.find(
    (row) =>
      row.subtask_id === scope.subtask_id && row.attempt === scope.attempt,
  );
  if (
    !attempt ||
    attempt.assignee.session_id !== native.native.sessionId ||
    attempt.assignee.agent_id !== native.native.agentId ||
    attempt.assignee.harness !== 'pi' ||
    attempt.owner_epoch !== scope.owner_epoch ||
    record.coordinator?.owner_epoch !== scope.owner_epoch ||
    !attempt.input_revision ||
    !['assigned', 'accepted', 'running'].includes(attempt.state) ||
    attempt.awaiting ||
    attempt.cancel_requested_at
  )
    throw new Error('managed_source_authority_changed');
  const lineage = predecessor(record, attempt.assignee);
  const base = origin(attempt);
  const registered = Array.isArray(record.managed_pi_runtime_registry)
    ? record.managed_pi_runtime_registry.filter(
        (row: unknown) =>
          object(row) &&
          row.session_id === scope.session_id &&
          canonicalJson(row.scope) === canonicalJson(scope),
      )
    : [];
  if (
    registered.length !== 1 ||
    !object(registered[0]) ||
    typeof registered[0].controller_run_id !== 'string'
  )
    throw new Error('managed_source_runtime_unregistered');
  const claims = scope.claim_epochs.map((pin) => {
    const claim = record.claims.find(
      (row) =>
        row.claim_id === pin.claim_id &&
        row.resource_epoch === pin.resource_epoch &&
        !row.released_at &&
        !row.cancel_pending &&
        same(row.holder, attempt.assignee) &&
        row.subtask_id === scope.subtask_id &&
        row.attempt === scope.attempt,
    );
    if (!claim?.path) throw new Error('managed_source_claim_changed');
    return {
      claim_id: claim.claim_id,
      resource_epoch: claim.resource_epoch,
      path: claim.path,
      access: claim.access,
      key: claim.key,
    };
  });
  const entryBase = {
    schema: 'pappra/managed-source-admission/1' as const,
    task_id: record.task_id,
    subtask_id: scope.subtask_id,
    attempt: scope.attempt,
    input_revision: attempt.input_revision,
    owner_epoch: scope.owner_epoch,
    origin_ref: base.file,
    origin_digest: base.digest,
    assignment_ref: readiness.assignmentFile,
    actor: {
      ...attempt.assignee,
      harness: 'pi',
      cwd: native.cwd,
      surface: native.native.surface,
      configuration_id: native.native.configurationId,
    },
    scope,
    controller_run_id: registered[0].controller_run_id,
    predecessor_handoff_id: lineage.intent.handoff_id,
    predecessor_proof_digest: lineage.exclusion.proof_digest,
    claims,
  };
  const assignment = derived(base.assignment, {
    ...entryBase,
    assignment_digest: '',
  });
  const entry: Admission = {
    ...entryBase,
    assignment_digest: writeImmutable(readiness.assignmentFile, assignment),
  };
  // Reuse the approved parent catalog only as a declaration. The actual child SDK
  // observation must independently promote every capability used by preflight.
  if (!fs.existsSync(readiness.templateFile)) {
    const launch = (record.launch_reservations ?? []).filter(
      (row) => row.requested_session_id === scope.session_id,
    );
    const bootstrap: unknown =
      launch.length === 1 ? launch[0]?.bootstrap : null;
    if (!object(bootstrap) || typeof bootstrap.request_file !== 'string')
      throw new Error('managed_source_parent_request_missing');
    const request = readBoundedFile(bootstrap.request_file, 64 * 1024);
    if (!request.ok || request.digest !== bootstrap.request_digest)
      throw new Error('managed_source_parent_request_changed');
    const parsed: unknown = JSON.parse(request.text);
    if (
      !object(parsed) ||
      !object(parsed.admission) ||
      typeof parsed.admission.capability_card_ref !== 'string'
    )
      throw new Error('managed_source_parent_card_missing');
    const bytes = readBoundedFile(
      parsed.admission.capability_card_ref,
      1024 * 1024,
    );
    if (!bytes.ok || bytes.digest !== parsed.admission.capability_card_digest)
      throw new Error('managed_source_parent_card_changed');
    const card: unknown = JSON.parse(bytes.text);
    if (!isCard(card)) throw new Error('managed_source_parent_card_invalid');
    const declare = (item: CapabilityCard['tools'][number]) => {
      const { evidence_ref: _evidence, ...rest } = item;
      return { ...rest, state: 'declared' };
    };
    writeImmutable(readiness.templateFile, {
      schema: 'harness-collab/capabilities/1',
      ...entry.actor,
      observed_at: new Date().toISOString(),
      evidence_level: 'declared',
      skills: card.skills.map(declare),
      tools: card.tools.map(declare),
    });
  }
  if (await assertTaskStoreCurrent(opened.value))
    throw new Error('managed_source_task_namespace_changed');
  const saved = transact(scope.task_root, {
    actor: native.native.agentId,
    purpose: 'record-managed-source-admission',
    apply(current) {
      const active = current.attempts.find(
        (row) =>
          row.subtask_id === scope.subtask_id && row.attempt === scope.attempt,
      );
      if (
        !active ||
        !same(active.assignee, entry.actor) ||
        active.owner_epoch !== scope.owner_epoch ||
        active.input_revision !== entry.input_revision ||
        active.awaiting ||
        active.cancel_requested_at ||
        current.coordinator?.owner_epoch !== scope.owner_epoch ||
        !claims.every((pin) =>
          current.claims.some(
            (row) =>
              row.claim_id === pin.claim_id &&
              row.resource_epoch === pin.resource_epoch &&
              !row.released_at &&
              !row.cancel_pending &&
              same(row.holder, entry.actor),
          ),
        )
      )
        return { ok: false, reason: 'managed_source_admission_stale' };
      const entries = rows(current);
      const old = entries.find(
        (row) => row.actor.session_id === entry.actor.session_id,
      );
      if (old && canonicalJson(old) !== canonicalJson(entry))
        return { ok: false, reason: 'managed_source_admission_conflict' };
      if (!old) {
        if (entries.length >= 32)
          return { ok: false, reason: 'managed_source_admission_limit' };
        entries.push(entry);
      }
      current[FIELD] = entries;
      return { record: current, result: null };
    },
  });
  if (!saved.ok) throw new Error(saved.reason);
}
