import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertTaskStoreCurrent, openTaskStore } from './collab-task-store.js';
import { readBoundedFile } from './bounded-file.js';
import { buildMessage } from '../collab/envelope.js';
import { CLOSED_STATES } from '../collab/lifecycle.js';
import { readRecord } from '../collab/store.js';
import { submitMessage } from '../collab/messages.js';
import { isAssignment } from '../collab/contracts.js';
import type { Identity, Message, TaskRecord } from '../collab/types.js';
import {
  expandRolePlan,
  type RolePlanRequest,
  type RolePlanSuccess,
} from './collab-role-plan.js';
import {
  validateWorkPlan,
  type WorkPlanNode,
  type WorkPlanResource,
} from '../collab/work-plan.js';
import {
  claimResources,
  expandResources,
  releaseClaim,
} from '../collab/resources.js';
import type { WorkExecutionRequest } from './collab-work-execution.js';

const REPAIR_JOURNAL_SCHEMA = 'pappra/collab-role-repair-journal/1';
const STOP_RECEIPT_SCHEMA = 'pappra/collab-native-stop-receipt/1';
const MAX_REPAIR_JOURNAL_BYTES = 1024 * 1024;
const MAX_REPAIRS = 64;
const MAX_STOP_RECEIPT_AGE_MS = 30_000;

export interface RoleRepairCoordinatorPin {
  readonly agent_id: string;
  readonly session_id: string;
  readonly owner_epoch: number;
}

export interface RoleRepairSourcePin {
  readonly node_id: string;
  readonly assignment_id: string;
  readonly attempt: number;
  readonly input_revision: string;
  readonly resources: readonly WorkPlanResource[];
}

export interface RoleRepairNextPin {
  readonly assignment_ref: string;
  readonly assignment_digest: string;
  readonly assignment_id: string;
  readonly attempt: number;
  readonly input_revision: string;
  readonly participant_id: string;
  readonly assignee: Identity;
  readonly resources: readonly WorkPlanResource[];
}

/**
 * A pre-authorized single transition. Approval pins bind the record approved by the
 * coordinator to this exact source/target transition; the approval payload itself is
 * passed unchanged (apart from its protocol-defined fields) to the ASSIGN envelope.
 */
export interface RoleRepairAuthorization {
  readonly coordinator: RoleRepairCoordinatorPin;
  readonly source: RoleRepairSourcePin;
  readonly next: RoleRepairNextPin;
  readonly approval: {
    readonly approved_by: string;
    readonly reason: string;
    readonly authorization_id: string;
    readonly owner_epoch: number;
    readonly source_attempt: number;
    readonly source_input_revision: string;
    readonly next_assignment_id: string;
    readonly next_attempt: number;
    readonly next_input_revision: string;
    readonly resources_digest: string;
  };
  readonly next_execution?: WorkExecutionRequest;
}

export interface RoleRepairPolicy {
  /** One explicit approval per repair transition; no approval is synthesized. */
  readonly authorizations: readonly RoleRepairAuthorization[];
}

/** A live, source-bound stop observation supplied only by a trusted host adapter. */
export interface NativeStopReceipt {
  readonly schema: typeof STOP_RECEIPT_SCHEMA;
  readonly observation: 'confirmed';
  readonly task_id: string;
  readonly subtask_id: string;
  readonly attempt: number;
  readonly owner_epoch: number;
  readonly assignee: Identity;
  readonly evidence_ref: string;
  readonly observed_at: string;
}

export interface RoleRepairRequest {
  readonly task_root: string;
  readonly plan_file: string;
  readonly journal_file: string;
  readonly event_id: string;
  readonly role_plan: RolePlanRequest;
  readonly execution: WorkExecutionRequest;
  readonly policy: RoleRepairPolicy;
  readonly rejected_node_ids: readonly string[];
  readonly max_attempts: number;
  readonly max_actions: number;
  readonly reserved_actions: number;
}

export interface RoleRepairDependencies {
  /** Must perform a live host query and return its supported receipt, never a boolean. */
  readonly confirm_stopped?: (source: {
    readonly task_id: string;
    readonly coordinator: RoleRepairCoordinatorPin;
    readonly source: RoleRepairSourcePin;
    readonly assignee: Identity;
  }) => Promise<NativeStopReceipt | null>;
  readonly now?: () => number;
}

export interface RoleRepairOutcome {
  readonly status:
    | 'repaired'
    | 'repair-required'
    | 'repair-exhausted'
    | 'reconciliation-required';
  readonly role_plan: RolePlanRequest | null;
  readonly expansion: RolePlanSuccess | null;
  readonly execution: WorkExecutionRequest | null;
  readonly diagnostic: string;
}

export interface RoleRepairRecovery {
  readonly role_plan: RolePlanRequest;
  readonly execution: WorkExecutionRequest;
}

interface RepairIntent {
  readonly authorization_digest: string;
  readonly event_id: string;
  readonly source: RoleRepairSourcePin;
  readonly source_plan: RolePlanSuccess['plan'];
  readonly next_role_plan: RolePlanRequest;
  readonly next_plan: RolePlanSuccess['plan'];
  readonly next_execution: WorkExecutionRequest;
  readonly release_claim_ids: readonly string[];
  readonly cancel_message: Message | null;
  readonly assign_message: Message;
  readonly stop_receipt: NativeStopReceipt | null;
  state:
    | 'prepared'
    | 'source-closed'
    | 'source-claims-released'
    | 'assignment-applied'
    | 'next-claims-acquired'
    | 'complete';
}

interface RepairJournal {
  readonly schema: typeof REPAIR_JOURNAL_SCHEMA;
  readonly intents: RepairIntent[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function stableDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateJournal(value: unknown): RepairJournal | null {
  if (
    !isRecord(value) ||
    value['schema'] !== REPAIR_JOURNAL_SCHEMA ||
    !Array.isArray(value['intents']) ||
    value['intents'].length > MAX_REPAIRS
  )
    return null;
  for (const item of value['intents']) {
    if (
      !isRecord(item) ||
      typeof item['authorization_digest'] !== 'string' ||
      typeof item['event_id'] !== 'string' ||
      !isRecord(item['source']) ||
      !isRecord(item['source_plan']) ||
      !isRecord(item['next_role_plan']) ||
      !isRecord(item['next_execution']) ||
      !Array.isArray(item['release_claim_ids']) ||
      !isRecord(item['next_plan']) ||
      !isRecord(item['assign_message']) ||
      !(item['cancel_message'] === null || isRecord(item['cancel_message'])) ||
      !(item['stop_receipt'] === null || isRecord(item['stop_receipt'])) ||
      ![
        'prepared',
        'source-closed',
        'source-claims-released',
        'assignment-applied',
        'next-claims-acquired',
        'complete',
      ].includes(String(item['state']))
    )
      return null;
  }
  return value as unknown as RepairJournal;
}

function readJournal(file: string): RepairJournal | null | undefined {
  if (!fs.existsSync(file))
    return { schema: REPAIR_JOURNAL_SCHEMA, intents: [] };
  const read = readBoundedFile(file, MAX_REPAIR_JOURNAL_BYTES);
  if (!read.ok) return undefined;
  try {
    return validateJournal(JSON.parse(read.text) as unknown) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeAtomic(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.${createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16)}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    const parent = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Rename already consumed it, or cleanup can be retried later.
    }
  }
}

function persistJournal(file: string, journal: RepairJournal): void {
  writeAtomic(file, `${JSON.stringify(journal)}\n`);
}

function requireTaskLocalFile(taskRoot: string, file: string): boolean {
  if (!path.isAbsolute(file)) return false;
  const absolute = path.resolve(file);
  const relative = path.relative(path.resolve(taskRoot), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    return false;
  try {
    const parent = fs.lstatSync(path.dirname(absolute));
    const target = fs.existsSync(absolute) ? fs.lstatSync(absolute) : null;
    return (
      parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      (target === null || (target.isFile() && !target.isSymbolicLink()))
    );
  } catch {
    return false;
  }
}

type IdentityLike = {
  readonly agent_id: string;
  readonly session_id: string;
  readonly harness?: string | null;
  readonly cwd?: string;
};

function sameIdentity(
  left: IdentityLike | null | undefined,
  right: IdentityLike,
): boolean {
  return (
    left?.agent_id === right.agent_id &&
    left.session_id === right.session_id &&
    (right.harness === undefined || (left.harness ?? null) === right.harness) &&
    (right.cwd === undefined || (left.cwd ?? null) === right.cwd)
  );
}

function validAuthorization(
  authorization: RoleRepairAuthorization,
  sourceNode: WorkPlanNode,
  coordinator: TaskRecord['coordinator'],
  maxAttempts: number,
  resources: readonly WorkPlanResource[],
): boolean {
  const { source, next, approval } = authorization;
  return (
    coordinator !== null &&
    authorization.coordinator.agent_id === coordinator.agent_id &&
    authorization.coordinator.session_id === coordinator.session_id &&
    authorization.coordinator.owner_epoch === coordinator.owner_epoch &&
    source.node_id === sourceNode.node_id &&
    source.assignment_id === sourceNode.assignment_id &&
    source.attempt === sourceNode.attempt &&
    source.input_revision === sourceNode.input_revision &&
    sameJson(source.resources, sourceNode.resources) &&
    source.attempt < maxAttempts &&
    next.assignment_id === source.assignment_id &&
    typeof next.assignment_ref === 'string' &&
    path.isAbsolute(next.assignment_ref) &&
    typeof next.assignment_digest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(next.assignment_digest) &&
    next.attempt === source.attempt + 1 &&
    next.attempt <= maxAttempts &&
    next.input_revision.length > 0 &&
    next.participant_id.length > 0 &&
    next.assignee.agent_id.length > 0 &&
    next.assignee.session_id.length > 0 &&
    sameJson(next.resources, resources) &&
    approval.approved_by === coordinator.agent_id &&
    approval.reason.trim().length > 0 &&
    approval.authorization_id.length > 0 &&
    approval.owner_epoch === coordinator.owner_epoch &&
    approval.source_attempt === source.attempt &&
    approval.source_input_revision === source.input_revision &&
    approval.next_assignment_id === next.assignment_id &&
    approval.next_attempt === next.attempt &&
    approval.next_input_revision === next.input_revision &&
    approval.resources_digest === stableDigest(next.resources)
  );
}

function validStopReceipt(
  receipt: NativeStopReceipt | null,
  taskId: string,
  coordinator: RoleRepairCoordinatorPin,
  source: RoleRepairSourcePin,
  assignee: Identity,
  now: number,
): receipt is NativeStopReceipt {
  if (
    !receipt ||
    receipt.schema !== STOP_RECEIPT_SCHEMA ||
    receipt.observation !== 'confirmed'
  )
    return false;
  const observed = Date.parse(receipt.observed_at);
  return (
    receipt.task_id === taskId &&
    receipt.subtask_id === source.assignment_id &&
    receipt.attempt === source.attempt &&
    receipt.owner_epoch === coordinator.owner_epoch &&
    sameIdentity(receipt.assignee, assignee) &&
    receipt.evidence_ref.trim().length > 0 &&
    Number.isFinite(observed) &&
    observed <= now + 5_000 &&
    now - observed <= MAX_STOP_RECEIPT_AGE_MS
  );
}

function currentAuthorization(
  policy: RoleRepairPolicy,
  node: WorkPlanNode,
): RoleRepairAuthorization | null {
  return (
    policy.authorizations.find(
      (authorization) =>
        authorization.source.node_id === node.node_id &&
        authorization.source.assignment_id === node.assignment_id &&
        authorization.source.attempt === node.attempt,
    ) ?? null
  );
}

function nextRolePlan(
  rolePlan: RolePlanRequest,
  authorization: RoleRepairAuthorization,
): RolePlanRequest | null {
  const sourceAssignment = rolePlan.assignments.find(
    (entry) => entry.node_id === authorization.source.node_id,
  );
  if (!sourceAssignment) return null;
  const participant = rolePlan.participants.find(
    (entry) => entry.participant_id === authorization.next.participant_id,
  );
  if (
    participant &&
    !sameIdentity(participant.assignee, authorization.next.assignee) &&
    (participant.participant_id !== sourceAssignment.participant_id ||
      rolePlan.assignments.some(
        (entry) =>
          entry.node_id !== sourceAssignment.node_id &&
          entry.participant_id === participant.participant_id,
      ))
  )
    return null;
  const assignments = rolePlan.assignments.map((assignment) =>
    assignment.node_id === authorization.source.node_id
      ? {
          ...assignment,
          assignment_id: authorization.next.assignment_id,
          attempt: authorization.next.attempt,
          input_revision: authorization.next.input_revision,
          participant_id: authorization.next.participant_id,
          resources: authorization.next.resources,
        }
      : assignment,
  );
  const usedParticipants = new Set(
    assignments.map((entry) => entry.participant_id),
  );
  const participants = [
    ...rolePlan.participants.filter(
      (entry) => entry.participant_id !== authorization.next.participant_id,
    ),
    {
      participant_id: authorization.next.participant_id,
      role: sourceAssignment.role,
      assignee: authorization.next.assignee,
    },
  ].filter((entry) => usedParticipants.has(entry.participant_id));
  return { ...rolePlan, assignments, participants };
}

function nextExecution(
  current: WorkExecutionRequest,
  authorization: RoleRepairAuthorization,
  sourceNode: WorkPlanNode,
): WorkExecutionRequest | null {
  const configured = authorization.next_execution;
  const unchangedPins =
    authorization.next.input_revision === authorization.source.input_revision &&
    sameJson(authorization.next.resources, authorization.source.resources) &&
    authorization.next.assignee.agent_id === sourceNode.assignee.agent_id &&
    authorization.next.assignee.session_id === sourceNode.assignee.session_id;
  if (!configured) return unchangedPins ? current : null;
  if (
    configured.task_root !== current.task_root ||
    configured.plan_file !== current.plan_file ||
    configured.binding_file !== current.binding_file ||
    configured.caller.agent_id !== current.caller.agent_id ||
    configured.caller.session_id !== current.caller.session_id ||
    configured.caller_pane !== current.caller_pane ||
    configured.capability_cards.some(
      (card) => !path.isAbsolute(card.capabilities_file) || !card.assignment_id,
    )
  )
    return null;
  const cards = configured.capability_cards.filter(
    (card) => card.assignment_id === authorization.next.assignment_id,
  );
  return cards.length === 1 ? configured : null;
}
function protocolMessageIds(authorizationDigest: string): {
  cancel: string;
  assign: string;
} {
  const prefix = `role-repair-${authorizationDigest.slice(0, 32)}`;
  return { cancel: `${prefix}-stop`, assign: `${prefix}-assign` };
}

function writeUpdatedPlan(
  planFile: string,
  sourcePlan: RolePlanSuccess['plan'],
  nextPlan: RolePlanSuccess['plan'],
): boolean {
  try {
    const existing = fs.lstatSync(planFile);
    if (!existing.isFile() || existing.isSymbolicLink()) return false;
    const current = readBoundedFile(planFile, 512 * 1024);
    if (!current.ok) return false;
    const parsed = JSON.parse(current.text) as unknown;
    if (sameJson(parsed, nextPlan)) return true;
    if (!sameJson(parsed, sourcePlan)) return false;
    writeAtomic(planFile, `${JSON.stringify(nextPlan)}\n`);
    return true;
  } catch {
    return false;
  }
}

function submitIdempotently(taskRoot: string, message: Message): boolean {
  try {
    const result = submitMessage(taskRoot, message);
    return result.ok;
  } catch {
    return false;
  }
}
function matchingClaimKeys(
  taskRoot: string,
  resources: readonly WorkPlanResource[],
  holder: Identity,
  subtaskId: string,
  attempt: number,
): {
  readonly expected: readonly string[];
  readonly existing: readonly string[];
} | null {
  const record = readRecord(taskRoot);
  if (!record) return null;
  const expected = new Set<string>();
  for (const access of ['read', 'write'] as const) {
    const group = resources.filter((resource) => resource.access === access);
    if (group.length === 0) continue;
    const expanded = expandResources(
      group.map((resource) => ({ path: resource.path })),
      { includeGit: access === 'write' },
    );
    for (const item of expanded) expected.add(`${access}:${item.key}`);
  }
  const existing = (record.claims ?? [])
    .filter(
      (claim) =>
        claim.access === resources[0]?.access &&
        !claim.released_at &&
        claim.subtask_id === subtaskId &&
        claim.attempt === attempt &&
        claim.holder?.agent_id === holder.agent_id &&
        claim.holder?.session_id === holder.session_id,
    )
    .map((claim) => `${claim.access}:${claim.key}`);
  return { expected: [...expected], existing };
}

function releaseSourceClaims(
  taskRoot: string,
  ids: readonly string[],
  holder: Identity,
): boolean {
  for (const claimId of ids) {
    const record = readRecord(taskRoot);
    const claim = record?.claims?.find((entry) => entry.claim_id === claimId);
    if (!claim || claim.released_at) continue;
    const released = releaseClaim(taskRoot, {
      claimId,
      holder,
      reason: 'authorized role repair closed the source attempt',
    });
    if (!released.ok) return false;
  }
  return true;
}

function acquireNextClaims(
  taskRoot: string,
  authorization: RoleRepairAuthorization,
): boolean {
  for (const access of ['read', 'write'] as const) {
    const resources = authorization.next.resources.filter(
      (resource) => resource.access === access,
    );
    if (resources.length === 0) continue;
    const observed = matchingClaimKeys(
      taskRoot,
      resources,
      authorization.next.assignee,
      authorization.next.assignment_id,
      authorization.next.attempt,
    );
    if (!observed) return false;
    const expected = observed.expected;
    if (
      observed.existing.length === expected.length &&
      expected.every((key) => observed.existing.includes(key))
    )
      continue;
    if (observed.existing.length > 0) return false;
    const claimed = claimResources(taskRoot, {
      resources: resources.map((resource) => ({ path: resource.path })),
      access,
      holder: authorization.next.assignee,
      subtaskId: authorization.next.assignment_id,
      attempt: authorization.next.attempt,
      note: `authorized role repair ${authorization.approval.authorization_id}`,
    });
    if (!claimed.ok) return false;
  }
  return true;
}

function outcome(
  status: RoleRepairOutcome['status'],
  diagnostic: string,
  rolePlan: RolePlanRequest | null = null,
  expansion: RolePlanSuccess | null = null,
  execution: WorkExecutionRequest | null = null,
): RoleRepairOutcome {
  return { status, diagnostic, role_plan: rolePlan, expansion, execution };
}

/** Replace only the exact rejected node selected by the bounded authorization policy. */
export async function repairRejectedRoleNode(
  request: RoleRepairRequest,
  deps: RoleRepairDependencies = {},
): Promise<RoleRepairOutcome> {
  const { role_plan: rolePlan, policy } = request;
  if (
    !policy ||
    !Array.isArray(policy.authorizations) ||
    policy.authorizations.length === 0 ||
    policy.authorizations.length > MAX_REPAIRS ||
    !Number.isSafeInteger(request.max_attempts) ||
    request.reserved_actions < 1 ||
    request.reserved_actions > request.max_actions
  )
    return outcome('repair-required', 'repair_authority_missing_or_unbounded');
  if (policy.authorizations.length > Math.max(0, request.max_attempts - 1))
    return outcome('repair-exhausted', 'repair_policy_exceeds_attempt_bound');
  if (
    !requireTaskLocalFile(request.task_root, request.journal_file) ||
    !requireTaskLocalFile(request.task_root, request.plan_file)
  )
    return outcome(
      'reconciliation-required',
      'repair_paths_not_task_local_regular_files',
    );

  const expanded = expandRolePlan(rolePlan);
  if (!expanded.ok)
    return outcome('repair-required', 'repair_role_plan_invalid');
  const rejected = new Set(request.rejected_node_ids);
  const sourceNode = expanded.plan.nodes.find((node) =>
    rejected.has(node.node_id),
  );
  if (!sourceNode)
    return outcome('repair-required', 'repair_source_not_rejected');
  const authorization = currentAuthorization(policy, sourceNode);
  if (!authorization)
    return outcome(
      sourceNode.attempt >= request.max_attempts
        ? 'repair-exhausted'
        : 'repair-required',
      sourceNode.attempt >= request.max_attempts
        ? 'rejected_attempt_limit_reached'
        : 'repair_authorization_missing_for_exact_attempt',
    );
  if (sourceNode.attempt >= request.max_attempts)
    return outcome('repair-exhausted', 'rejected_attempt_limit_reached');
  const updatedRolePlan = nextRolePlan(rolePlan, authorization);
  if (!updatedRolePlan)
    return outcome('repair-required', 'repair_next_participant_pin_mismatch');
  const updatedExpansion = expandRolePlan(updatedRolePlan);
  if (!updatedExpansion.ok)
    return outcome('repair-required', 'repair_next_role_plan_refused');
  const updatedExecution = nextExecution(
    request.execution,
    authorization,
    sourceNode,
  );
  if (!updatedExecution)
    return outcome(
      'repair-required',
      'next_execution_pins_missing_or_incompatible',
    );
  const nextFile = readBoundedFile(
    authorization.next.assignment_ref,
    1024 * 1024,
  );
  let nextAssignment: unknown;
  try {
    nextAssignment = nextFile.ok ? JSON.parse(nextFile.text) : null;
  } catch {
    nextAssignment = null;
  }
  if (
    !nextFile.ok ||
    nextFile.digest !== authorization.next.assignment_digest ||
    !isAssignment(nextAssignment) ||
    nextAssignment.task_id !== rolePlan.task_id ||
    nextAssignment.assignment_id !== authorization.next.assignment_id ||
    nextAssignment.attempt !== authorization.next.attempt ||
    !sameIdentity(nextAssignment.assignee, authorization.next.assignee) ||
    nextAssignment.coordinator.agent_id !==
      authorization.coordinator.agent_id ||
    nextAssignment.coordinator.session_id !==
      authorization.coordinator.session_id ||
    nextAssignment.coordinator.owner_epoch !==
      authorization.coordinator.owner_epoch ||
    !sameJson(
      nextAssignment.resources.map((resource) => ({
        path: resource.path,
        access: resource.access,
      })),
      authorization.next.resources,
    )
  )
    return outcome(
      'repair-required',
      'next_assignment_artifact_missing_or_mismatched',
    );

  const opened = await openTaskStore(request.task_root);
  if (!opened.ok)
    return outcome('reconciliation-required', 'repair_task_record_unavailable');
  const current = await assertTaskStoreCurrent(opened.value);
  if (current !== null)
    return outcome('reconciliation-required', 'repair_task_record_changed');
  const record = opened.value.record;
  const coordinator = record.coordinator;
  if (
    !validAuthorization(
      authorization,
      sourceNode,
      coordinator,
      request.max_attempts,
      authorization.next.resources,
    ) ||
    record.task_id !== rolePlan.task_id ||
    rolePlan.owner_epoch !== coordinator?.owner_epoch ||
    coordinator?.agent_id !== authorization.coordinator.agent_id ||
    coordinator?.session_id !== authorization.coordinator.session_id
  )
    return outcome(
      'repair-required',
      'repair_approval_or_coordinator_pins_stale',
    );

  const sourceAttempt = (record.attempts ?? []).find(
    (attempt) =>
      attempt.subtask_id === authorization.source.assignment_id &&
      attempt.attempt === authorization.source.attempt,
  );
  if (
    !sourceAttempt ||
    sourceAttempt.input_revision !== authorization.source.input_revision ||
    sourceAttempt.owner_epoch !== authorization.coordinator.owner_epoch ||
    !sameIdentity(sourceAttempt.assignee, sourceNode.assignee)
  )
    return outcome('repair-required', 'repair_source_attempt_pins_stale');

  const authDigest = stableDigest(authorization);
  const journalFile = `${request.journal_file}.repair.json`;
  if (!requireTaskLocalFile(request.task_root, journalFile))
    return outcome('reconciliation-required', 'repair_journal_path_invalid');
  const journal = readJournal(journalFile);
  if (!journal)
    return outcome(
      'reconciliation-required',
      'repair_journal_invalid_or_unreadable',
    );
  let intent = journal.intents.find(
    (entry) => entry.authorization_digest === authDigest,
  );
  if (intent?.state === 'complete') {
    const recovered = await recoverRoleRepairPlan(
      rolePlan,
      request.execution,
      policy,
      request.journal_file,
      request.task_root,
      request.plan_file,
      request.max_attempts,
    );
    return sameJson(recovered.role_plan, updatedRolePlan) &&
      sameJson(recovered.execution, updatedExecution)
      ? outcome(
          'repaired',
          'repair_already_reconciled',
          intent.next_role_plan,
          updatedExpansion,
          intent.next_execution,
        )
      : outcome('reconciliation-required', 'repair_journal_plan_invalid');
  }
  if (intent) {
    if (
      intent.source.attempt !== authorization.source.attempt ||
      !sameJson(intent.source, authorization.source) ||
      !sameJson(intent.source_plan, expanded.plan) ||
      !sameJson(intent.next_plan, updatedExpansion.plan) ||
      !sameJson(intent.next_role_plan, updatedRolePlan) ||
      !sameJson(intent.next_execution, updatedExecution)
    )
      return outcome(
        'reconciliation-required',
        'repair_intent_conflicts_with_current_authority',
      );
  } else {
    if (journal.intents.length >= MAX_REPAIRS)
      return outcome('repair-exhausted', 'repair_journal_limit_reached');
    const toIdentity = {
      agent_id: sourceAttempt.assignee.agent_id,
      session_id: sourceAttempt.assignee.session_id,
      harness: sourceAttempt.assignee.harness ?? null,
      ...(sourceAttempt.assignee.cwd
        ? { cwd: sourceAttempt.assignee.cwd }
        : {}),
    };
    const alreadyClosed = CLOSED_STATES.includes(sourceAttempt.state);
    // A terminal task state does not fence the old native session's input.
    const stopReceipt =
      (await deps.confirm_stopped?.({
        task_id: record.task_id,
        coordinator: authorization.coordinator,
        source: authorization.source,
        assignee: sourceAttempt.assignee,
      })) ?? null;
    if (
      !validStopReceipt(
        stopReceipt,
        record.task_id,
        authorization.coordinator,
        authorization.source,
        sourceAttempt.assignee,
        (deps.now ?? Date.now)(),
      )
    )
      return outcome(
        'repair-required',
        'live_supported_stop_receipt_missing_or_stale',
      );
    if (await assertTaskStoreCurrent(opened.value))
      return outcome(
        'reconciliation-required',
        'repair_authority_changed_during_native_stop',
      );
    const activeClaims = (record.claims ?? []).filter(
      (claim) => !claim.released_at,
    );
    const sameHolder = (claim: (typeof activeClaims)[number]) =>
      claim.holder?.agent_id === sourceAttempt.assignee.agent_id &&
      claim.holder?.session_id === sourceAttempt.assignee.session_id;
    const unscopedReleaseHazard =
      activeClaims.some(
        (claim) =>
          sameHolder(claim) &&
          (claim.subtask_id === null || claim.subtask_id === undefined) &&
          (claim.attempt === null ||
            claim.attempt === undefined ||
            claim.attempt === authorization.source.attempt),
      ) ||
      activeClaims.some(
        (claim) =>
          sameHolder(claim) &&
          claim.subtask_id === authorization.source.assignment_id &&
          (claim.attempt === null || claim.attempt === undefined),
      );
    if (unscopedReleaseHazard)
      return outcome(
        'repair-required',
        'source_claim_scope_is_not_attempt_pinned',
      );
    const releaseClaimIds = activeClaims
      .filter(
        (claim) =>
          sameHolder(claim) &&
          claim.subtask_id === authorization.source.assignment_id &&
          claim.attempt === authorization.source.attempt,
      )
      .map((claim) => claim.claim_id);
    const coordinatorIdentity: Identity = {
      agent_id: coordinator!.agent_id,
      session_id: coordinator!.session_id,
      harness: coordinator!.harness ?? null,
      ...(coordinator!.cwd ? { cwd: coordinator!.cwd } : {}),
    };
    const idsNow = protocolMessageIds(authDigest);
    const cancelMessage = alreadyClosed
      ? null
      : buildMessage({
          message_id: idsNow.cancel,
          type: 'CANCELLED',
          task_id: record.task_id,
          from: coordinatorIdentity,
          to: toIdentity,
          reply_to: sourceAttempt.assignment_message_id,
          subtask_id: authorization.source.assignment_id,
          attempt: authorization.source.attempt,
          owner_epoch: authorization.coordinator.owner_epoch,
          body: { stop_evidence: stopReceipt },
        });
    const assignMessage = buildMessage({
      message_id: idsNow.assign,
      type: 'ASSIGN',
      task_id: record.task_id,
      from: coordinatorIdentity,
      to: authorization.next.assignee,
      subtask_id: authorization.next.assignment_id,
      attempt: authorization.next.attempt,
      owner_epoch: authorization.coordinator.owner_epoch,
      body: {
        assignment_ref: authorization.next.assignment_ref,
        assignment_digest: authorization.next.assignment_digest,
        input_revision: authorization.next.input_revision,
        approval: {
          approved_by: authorization.approval.approved_by,
          reason: authorization.approval.reason,
        },
      },
    });
    intent = {
      authorization_digest: authDigest,
      event_id: request.event_id,
      source: authorization.source,
      source_plan: expanded.plan,
      next_role_plan: updatedRolePlan,
      next_plan: updatedExpansion.plan,
      next_execution: updatedExecution,
      release_claim_ids: releaseClaimIds,
      cancel_message: cancelMessage,
      assign_message: assignMessage,
      stop_receipt: stopReceipt,
      state: 'prepared',
    };
    journal.intents.push(intent);
    try {
      persistJournal(journalFile, journal);
    } catch {
      return outcome('reconciliation-required', 'repair_intent_persist_failed');
    }
  }

  if (intent.cancel_message && intent.state === 'prepared') {
    if (!submitIdempotently(request.task_root, intent.cancel_message))
      return outcome(
        'reconciliation-required',
        'source_close_protocol_refused',
      );
    intent.state = 'source-closed';
    try {
      persistJournal(journalFile, journal);
    } catch {
      return outcome(
        'reconciliation-required',
        'source_closed_but_repair_journal_update_failed',
      );
    }
  }
  if (intent.state === 'prepared' && !intent.cancel_message)
    intent.state = 'source-closed';
  if (intent.state === 'source-closed') {
    if (
      !releaseSourceClaims(
        request.task_root,
        intent.release_claim_ids,
        sourceAttempt.assignee,
      )
    )
      return outcome(
        'reconciliation-required',
        'source_resource_claim_release_refused',
      );
    intent.state = 'source-claims-released';
    try {
      persistJournal(journalFile, journal);
    } catch {
      return outcome(
        'reconciliation-required',
        'source_claims_released_but_repair_journal_update_failed',
      );
    }
  }
  if (intent.state === 'source-claims-released') {
    if (!submitIdempotently(request.task_root, intent.assign_message))
      return outcome(
        'reconciliation-required',
        'next_assignment_protocol_refused',
      );
    intent.state = 'assignment-applied';
    try {
      persistJournal(journalFile, journal);
    } catch {
      return outcome(
        'reconciliation-required',
        'assignment_applied_but_repair_journal_update_failed',
      );
    }
  }
  if (intent.state === 'assignment-applied') {
    if (!acquireNextClaims(request.task_root, authorization))
      return outcome(
        'reconciliation-required',
        'next_attempt_resource_claims_unavailable',
      );
    intent.state = 'next-claims-acquired';
    try {
      persistJournal(journalFile, journal);
    } catch {
      return outcome(
        'reconciliation-required',
        'next_claims_acquired_but_repair_journal_update_failed',
      );
    }
  }
  if (intent.state === 'next-claims-acquired') {
    if (
      !writeUpdatedPlan(request.plan_file, intent.source_plan, intent.next_plan)
    )
      return outcome(
        'reconciliation-required',
        'assignment_applied_but_plan_update_failed',
      );
    intent.state = 'complete';
    try {
      persistJournal(journalFile, journal);
    } catch {
      return outcome(
        'reconciliation-required',
        'plan_updated_but_repair_journal_update_failed',
      );
    }
  }
  return outcome(
    'repaired',
    'fresh_assignment_registered_resource_claimed_and_work_plan_updated',
    intent.next_role_plan,
    updatedExpansion,
    intent.next_execution,
  );
}

/**
 * Read-only recovery of a caller-authorized plan. Journal data alone is never authority:
 * promotion requires the live task record, current coordinator, registered assignment and
 * already-published task-local WorkPlan to match the exact policy transition.
 */
export async function recoverRoleRepairPlan(
  rolePlan: RolePlanRequest,
  execution: WorkExecutionRequest,
  policy: RoleRepairPolicy | undefined,
  journalFile: string,
  taskRoot: string,
  planFile: string,
  maxAttempts: number,
): Promise<RoleRepairRecovery> {
  const unchanged = { role_plan: rolePlan, execution };
  if (
    !policy ||
    !Array.isArray(policy.authorizations) ||
    policy.authorizations.length === 0 ||
    policy.authorizations.some((item): boolean => !isRecord(item)) ||
    !path.isAbsolute(journalFile) ||
    !requireTaskLocalFile(taskRoot, journalFile) ||
    !requireTaskLocalFile(taskRoot, planFile)
  )
    return unchanged;
  const journal = readJournal(`${journalFile}.repair.json`);
  if (!journal) return unchanged;
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok || (await assertTaskStoreCurrent(opened.value)) !== null)
    return unchanged;
  const record = opened.value.record;
  const coordinator = record.coordinator;
  if (!coordinator || record.task_id !== rolePlan.task_id) return unchanged;

  let currentRolePlan = rolePlan;
  let currentExecution = execution;
  let currentExpansion = expandRolePlan(currentRolePlan);
  if (!currentExpansion.ok) return unchanged;
  const visited = new Set<string>();
  let recovered: RoleRepairRecovery | null = null;
  for (let pass = 0; pass < policy.authorizations.length; pass += 1) {
    let advanced = false;
    for (const authorization of policy.authorizations) {
      const authDigest = stableDigest(authorization);
      if (visited.has(authDigest)) continue;
      const sourceNode = currentExpansion.plan.nodes.find(
        (node) =>
          node.node_id === authorization.source.node_id &&
          node.assignment_id === authorization.source.assignment_id &&
          node.attempt === authorization.source.attempt,
      );
      if (!sourceNode) continue;
      visited.add(authDigest);
      if (
        !validAuthorization(
          authorization,
          sourceNode,
          coordinator,
          maxAttempts,
          authorization.next.resources,
        ) ||
        currentRolePlan.owner_epoch !== coordinator.owner_epoch
      )
        continue;
      const nextRolePlan = nextRolePlanForRecovery(
        currentRolePlan,
        authorization,
      );
      if (!nextRolePlan) continue;
      const nextExecutionPins = nextExecution(
        currentExecution,
        authorization,
        sourceNode,
      );
      if (!nextExecutionPins) continue;
      const nextExpansion = expandRolePlan(nextRolePlan);
      if (!nextExpansion.ok) continue;
      const intent = journal.intents.find(
        (entry) => entry.authorization_digest === authDigest,
      );
      if (
        !intent ||
        (intent.state !== 'complete' &&
          intent.state !== 'next-claims-acquired') ||
        !sameJson(intent.source, authorization.source) ||
        !sameJson(intent.source_plan, currentExpansion.plan) ||
        !sameJson(intent.next_role_plan, nextRolePlan) ||
        !sameJson(intent.next_plan, nextExpansion.plan) ||
        !sameJson(intent.next_execution, nextExecutionPins)
      )
        continue;
      const ids = protocolMessageIds(authDigest);
      if (
        intent.assign_message.message_id !== ids.assign ||
        intent.assign_message.type !== 'ASSIGN' ||
        intent.assign_message.task_id !== record.task_id ||
        intent.assign_message.subtask_id !== authorization.next.assignment_id ||
        intent.assign_message.attempt !== authorization.next.attempt ||
        intent.assign_message.owner_epoch !== coordinator.owner_epoch
      )
        continue;
      const sourceAttempt = (record.attempts ?? []).find(
        (attempt) =>
          attempt.subtask_id === authorization.source.assignment_id &&
          attempt.attempt === authorization.source.attempt,
      );
      const nextAttempt = (record.attempts ?? []).find(
        (attempt) =>
          attempt.subtask_id === authorization.next.assignment_id &&
          attempt.attempt === authorization.next.attempt,
      );
      const assignmentRecord = (record.messages ?? []).find(
        (entry) => entry.message_id === intent.assign_message.message_id,
      );
      if (
        !sourceAttempt ||
        !CLOSED_STATES.includes(sourceAttempt.state) ||
        sourceAttempt.input_revision !== authorization.source.input_revision ||
        sourceAttempt.owner_epoch !== coordinator.owner_epoch ||
        !sameIdentity(sourceAttempt.assignee, sourceNode.assignee) ||
        !nextAttempt ||
        nextAttempt.assignment_message_id !==
          intent.assign_message.message_id ||
        nextAttempt.owner_epoch !== coordinator.owner_epoch ||
        nextAttempt.input_revision !== authorization.next.input_revision ||
        !sameIdentity(nextAttempt.assignee, authorization.next.assignee) ||
        !sameJson(nextAttempt.approval, {
          approved_by: authorization.approval.approved_by,
          reason: authorization.approval.reason,
        }) ||
        !assignmentRecord ||
        assignmentRecord.type !== 'ASSIGN' ||
        assignmentRecord.state !== 'applied'
      )
        continue;
      let claimsReady = true;
      for (const access of ['read', 'write'] as const) {
        const resources = authorization.next.resources.filter(
          (resource: WorkPlanResource) => resource.access === access,
        );
        if (!resources.length) continue;
        const claims = matchingClaimKeys(
          taskRoot,
          resources,
          authorization.next.assignee,
          authorization.next.assignment_id,
          authorization.next.attempt,
        );
        if (
          !claims ||
          claims.expected.length !== claims.existing.length ||
          !claims.expected.every((key) => claims.existing.includes(key))
        ) {
          claimsReady = false;
          break;
        }
      }
      if (!claimsReady) continue;
      const workPlanRead = readBoundedFile(planFile, 512 * 1024);
      if (!workPlanRead.ok) continue;
      let workPlanPayload: unknown;
      try {
        workPlanPayload = JSON.parse(workPlanRead.text) as unknown;
      } catch {
        continue;
      }
      const validatedPlan = validateWorkPlan(workPlanPayload);
      if (
        !validatedPlan.ok ||
        !sameJson(validatedPlan.plan, nextExpansion.plan)
      )
        continue;
      recovered = { role_plan: nextRolePlan, execution: nextExecutionPins };
      currentRolePlan = nextRolePlan;
      currentExecution = nextExecutionPins;
      currentExpansion = nextExpansion;
      advanced = true;
      break;
    }
    if (!advanced) break;
  }
  return recovered ?? unchanged;
}

function nextRolePlanForRecovery(
  rolePlan: RolePlanRequest,
  authorization: RoleRepairAuthorization,
): RolePlanRequest | null {
  return nextRolePlan(rolePlan, authorization);
}
