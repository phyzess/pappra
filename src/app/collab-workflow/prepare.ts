import path from 'node:path';
import type { Message } from '../../collab/types.js';
import type { Assignment } from '../../collab/contracts.js';
import { pathsOverlap } from '../../collab/canonical.js';
import { buildMessage } from '../../collab/envelope.js';
import { findAttempt } from '../../collab/lifecycle.js';
import {
  claimResources,
  expandResources,
  listDomainRecords,
  scanConflicts,
} from '../../collab/resources.js';
import { initTask, readRecord, transact } from '../../collab/store.js';
import { submitMessage } from '../../collab/messages.js';
import { validateWorkPlan, WORK_PLAN_SCHEMA } from '../../collab/work-plan.js';
import {
  workflowWorkPlanPath,
  WORKFLOW_MAX_STRING as _maxString,
} from '../../schemas/collab-workflow.js';
import { digestText } from '../../collab/store.js';
import {
  WORKFLOW_MANIFEST_SCHEMA,
  WORKFLOW_PLAN_SCHEMA,
  WORKFLOW_MANIFEST_VERSION,
  workflowAssignmentPath,
  workflowManifestPath,
  workflowBindingPath,
  type WorkflowAssignmentDeclaration,
  type WorkflowParticipant,
  type WorkflowPrepareRequest,
} from '../../schemas/collab-workflow.js';
import {
  digestFile,
  readBoundedDocument,
  readBoundedJson,
  writeJsonExclusive,
  type ExclusiveWrite,
} from './context.js';
import {
  emptyResult,
  workflowFailure,
  type WorkflowAssignmentPlan,
  type WorkflowBlocker,
  type WorkflowOutcome,
  type WorkflowPlan,
  type WorkflowResult,
} from './types.js';

/**
 * Prepare: derive one deterministic cohort from a declared goal.
 *
 * The request states the goal, the observed participants and bindings, and disjoint
 * assignments once. Everything repeated — assignment documents, digests, message ids,
 * correlated ASSIGN envelopes, claim lists, policy fields — is derived here so a caller
 * cannot disagree with itself, and so a rerun converges instead of duplicating identities
 * and ASSIGN messages.
 */

const ASSIGNMENT_SCHEMA = 'harness-collab/assignment/1';

export interface DerivedClaimBatch {
  readonly access: 'read' | 'write';
  readonly resources: {
    readonly path: string;
    readonly scope?: 'file' | 'tree';
  }[];
}

export interface DerivedAssignment {
  readonly declaration: WorkflowAssignmentDeclaration;
  readonly participant: WorkflowParticipant;
  readonly attempt: number;
  readonly assignment: Assignment;
  readonly assignment_ref: string;
  /** Normalized declaration identity; final wire pins are only known after sealing. */
  readonly declaration_digest: string;
  readonly message_id: string;
  readonly claim_batches: readonly DerivedClaimBatch[];
  readonly derived_keys: readonly string[];
  readonly deferred: boolean;
}

export interface DerivedCohort {
  readonly request: WorkflowPrepareRequest;
  readonly taskRoot: string;
  readonly assignments: readonly DerivedAssignment[];
  /** The pinned input every assignment references, and the goal document when it is local. */
  readonly goal_input: { readonly ref: string; readonly digest: string };
  readonly goal_document: unknown | null;
}

function taskRootOf(domainRoot: string, taskId: string): string {
  return path.join(domainRoot, 'tasks', taskId);
}

function participantFor(
  request: WorkflowPrepareRequest,
  agentId: string,
): WorkflowParticipant | null {
  return request.participants.find((item) => item.agent_id === agentId) ?? null;
}

function bindingFor(
  request: WorkflowPrepareRequest,
  agentId: string,
): {
  agent_id: string;
  pane_id: string;
  native_session_id: string | null;
} | null {
  return request.bindings.find((item) => item.agent_id === agentId) ?? null;
}

/**
 * Derive the whole cohort without writing to the filesystem.
 *
 * `attempt` is derived (always 1 for a fresh cohort): the request declares subtasks, never
 * attempts, so an attempt number can only come from the record.
 */
export function deriveCohort(
  request: WorkflowPrepareRequest,
): WorkflowOutcome<DerivedCohort> {
  const taskRoot = taskRootOf(request.domain_root, request.task_id);
  let goalInput: { ref: string; digest: string } | null = null;
  if (request.goal.input_ref !== null) {
    const read = readBoundedJson(request.goal.input_ref, 'goal input');
    if (!read.ok)
      return workflowFailure(
        read.code,
        read.message,
        'Pin an existing regular input file, or pass null for an ad-hoc goal.',
      );
    const bytes = digestFile(request.goal.input_ref);
    if (bytes === null)
      return workflowFailure(
        'goal_input_unreadable',
        `Cannot read the goal input bytes at ${request.goal.input_ref}.`,
      );
    if (
      request.goal.input_digest !== null &&
      request.goal.input_digest !== bytes
    )
      return workflowFailure(
        'goal_input_digest_mismatch',
        `goal.input_digest does not match the bytes at ${request.goal.input_ref}.`,
        'Re-read the input and pin the digest of its current bytes.',
      );
    goalInput = { ref: request.goal.input_ref, digest: bytes };
  }
  // The assignment contract requires at least one pinned input. With no external input file,
  // the cohort pins the derived goal document it was built from: real bytes on disk, hashed
  // once. Path or kind strings are never hashed and presented as file bytes.
  const goalDocumentPath = path.join(taskRoot, 'workflow', 'goal.json');
  const goalDocument = {
    schema: 'pappra/collab-workflow-goal/1',
    task_id: request.task_id,
    objective: request.goal.objective,
    coordinator: {
      agent_id: request.coordinator.agent_id,
      session_id: request.coordinator.session_id,
      harness: request.coordinator.harness,
      owner_epoch: request.coordinator.owner_epoch,
    },
    participants: request.participants.map((item) => ({
      agent_id: item.agent_id,
      session_id: item.session_id,
      harness: item.harness,
      cwd: item.cwd,
      surface: item.surface,
      configuration_id: item.configuration_id,
    })),
    assignments: request.assignments.map((item) => ({
      subtask_id: item.subtask_id,
      role: item.role,
      assignee: item.assignee,
      objective: item.objective,
      depends_on: item.depends_on ?? [],
    })),
  };
  const derivedInput =
    goalInput === null
      ? {
          ref: goalDocumentPath,
          digest: digestText(`${JSON.stringify(goalDocument, null, 2)}\n`),
        }
      : goalInput;
  const assignments: DerivedAssignment[] = [];
  const coordinator = request.coordinator;
  for (const declaration of request.assignments) {
    const participant = participantFor(request, declaration.assignee);
    if (participant === null)
      return workflowFailure(
        'assignment_invalid',
        `Assignment ${declaration.subtask_id} names ${declaration.assignee}, which is not a declared participant.`,
      );
    // A deferred reviewer is sealed without real resource epochs, so a write footprint could
    // never be activated later; refuse it here, before any effect, instead of at dispatch.
    if (declaration.role === 'reviewer') {
      const writes = declaration.resources
        .filter((resource) => resource.access === 'write')
        .map((resource) => resource.path);
      if (writes.length > 0)
        return workflowFailure(
          'reviewer_write_footprint',
          `Reviewer ${declaration.subtask_id} declares write resources (${writes.join(', ')}); a deferred reviewer seals without real resource epochs and could never be activated.`,
          'Declare the reviewer read-only, or use a writer-role assignment for an assignee that must write a review file.',
        );
    }
    const deferred = declaration.role === 'reviewer';
    const messageId = `assign-${declaration.subtask_id}`;
    const assignment: Assignment = {
      schema: ASSIGNMENT_SCHEMA,
      task_id: request.task_id,
      assignment_id: declaration.subtask_id,
      objective: declaration.objective,
      attempt: 1,
      roles: [declaration.role],
      acceptance: [...declaration.acceptance],
      coordinator: {
        agent_id: coordinator.agent_id,
        session_id: coordinator.session_id,
        owner_epoch: coordinator.owner_epoch,
        harness: coordinator.harness,
      },
      assignee: {
        agent_id: participant.agent_id,
        session_id: participant.session_id,
        harness: participant.harness,
        cwd: participant.cwd,
        surface: participant.surface,
        configuration_id: participant.configuration_id,
      },
      // Inputs pin real input bytes only. A native session log is mutable observation
      // input for capability derivation, so it stays in `native_evidence` and never
      // becomes an immutable assignment input.
      inputs: [derivedInput],
      resources: declaration.resources.map((item) => ({
        kind: 'path',
        path: item.path,
        access: item.access,
        ...(item.scope === undefined ? {} : { scope: item.scope }),
      })),
      runner: {
        name: request.runner.name,
        mode: request.runner.mode,
        ...(request.runner.profile === undefined
          ? {}
          : { profile: request.runner.profile }),
        omitted_capabilities: [],
      },
      required: {
        skills: declaration.required_skills.map((item) => ({ ...item })),
        tools: [...declaration.required_tools],
      },
      preferred: { skills: [], tools: [] },
      native_evidence: declaration.native_evidence.map((item) => ({ ...item })),
    };
    const assignmentRef = workflowAssignmentPath(
      taskRoot,
      declaration.subtask_id,
    );
    const declarationDigest = assignmentDigestOf(assignment);

    const batches = new Map<
      'read' | 'write',
      { path: string; scope?: 'file' | 'tree' }[]
    >();
    for (const resource of declaration.resources) {
      const bucket = batches.get(resource.access) ?? [];
      bucket.push({
        path: resource.path,
        ...(resource.scope === undefined ? {} : { scope: resource.scope }),
      });
      batches.set(resource.access, bucket);
    }
    const claimBatches: DerivedClaimBatch[] = [...batches.entries()]
      .sort(([left], [right]) =>
        left === right ? 0 : left === 'write' ? -1 : 1,
      )
      .map(([access, resources]) => ({ access, resources }));

    const derivedKeys: string[] = [];
    for (const batch of claimBatches) {
      const expanded = expandResources(batch.resources, {
        includeGit: batch.access === 'write',
      });
      for (const item of expanded) derivedKeys.push(item.key);
    }

    assignments.push({
      declaration,
      participant,
      attempt: 1,
      assignment,
      assignment_ref: assignmentRef,
      declaration_digest: declarationDigest,
      message_id: messageId,
      claim_batches: claimBatches,
      derived_keys: derivedKeys,
      deferred,
    });
  }

  // Disjoint writer scopes are a property of the request, so they are checked here rather
  // than discovered as a claim conflict after artifacts were sealed.
  const writers = assignments.filter((item) => !item.deferred);
  for (let left = 0; left < writers.length; left += 1) {
    for (let right = left + 1; right < writers.length; right += 1) {
      const one = writers[left]!;
      const two = writers[right]!;
      for (const first of one.declaration.resources) {
        if (first.access !== 'write') continue;
        for (const second of two.declaration.resources) {
          if (second.access !== 'write') continue;
          if (pathsOverlap(first.path, second.path))
            return workflowFailure(
              'assignment_scope_overlap',
              `Assignments ${one.declaration.subtask_id} and ${two.declaration.subtask_id} both write ${first.path} and ${second.path}.`,
              'Give each writer a disjoint footprint; overlapping writers are refused before any effect.',
            );
        }
      }
    }
  }
  return {
    ok: true,
    value: {
      request,
      taskRoot,
      assignments,
      goal_input: derivedInput,
      goal_document: goalInput === null ? goalDocument : null,
    },
  };
}

function planEntry(
  taskRoot: string,
  derived: DerivedAssignment,
  sealed: SealedDocument | null,
): WorkflowAssignmentPlan {
  return {
    subtask_id: derived.declaration.subtask_id,
    role: derived.declaration.role,
    attempt: derived.attempt,
    assignment_id: derived.declaration.subtask_id,
    assignee: {
      agent_id: derived.participant.agent_id,
      session_id: derived.participant.session_id,
      harness: derived.participant.harness,
    },
    deferred: derived.deferred,
    assignment_ref: path.join(
      taskRoot,
      'workflow',
      'assignments',
      `${derived.declaration.subtask_id}.json`,
    ),
    declaration_digest: derived.declaration_digest,
    assignment_digest: sealed === null ? null : sealed.digest,
    sealed_digest: sealed === null ? null : sealed.digest,
    message_id: derived.message_id,
    // The ASSIGN body carries the wire pin, so its digest cannot exist before sealing.
    message_digest: null,
    resources: derived.declaration.resources.map((item) => ({
      path: item.path,
      access: item.access,
      ...(item.scope === undefined ? {} : { scope: item.scope }),
      key: item.path,
    })),
    derived_resources: derived.derived_keys,
    depends_on: derived.declaration.depends_on ?? [],
  };
}

interface SealedDocument {
  /** Exact bytes on disk: the wire pin every consumer compares. */
  readonly digest: string;
  readonly value: unknown;
}

/** One bounded, no-follow read: the parsed sealed document plus its exact-byte digest. */
function sealedDocumentOf(file: string): SealedDocument | null {
  const read = readBoundedDocument(file, 'sealed assignment');
  return read.ok ? read.value : null;
}

export interface PreparePlanReport {
  readonly plan: WorkflowPlan;
  readonly derived: DerivedCohort | null;
  readonly blockers: readonly WorkflowBlocker[];
}

/** Read-only derivation: nothing is created, sealed, claimed or notified. */
export function planPrepare(
  request: WorkflowPrepareRequest,
): WorkflowOutcome<PreparePlanReport> {
  const derived = deriveCohort(request);
  if (!derived.ok)
    return workflowFailure(derived.code, derived.message, derived.nextAction);
  const cohort = derived.value;
  const blockers: WorkflowBlocker[] = [];

  const domainRoot = request.domain_root;

  let existingRecord = null;
  try {
    existingRecord = readRecord(cohort.taskRoot);
  } catch {
    blockers.push({
      code: 'task_record_unreadable',
      detail: 'The task record exists but cannot be parsed.',
      next_action: 'Inspect task.json before preparing; nothing was written.',
    });
  }

  if (existingRecord !== null) {
    const coordinator = existingRecord.coordinator;
    const matches =
      coordinator !== null &&
      coordinator.agent_id === request.coordinator.agent_id &&
      coordinator.session_id === request.coordinator.session_id &&
      coordinator.owner_epoch === request.coordinator.owner_epoch;
    if (!matches)
      blockers.push({
        code: 'coordinator_mismatch',
        detail: `Task ${request.task_id} is owned by ${String(coordinator?.agent_id ?? 'nobody')} epoch ${String(coordinator?.owner_epoch ?? 0)}.`,
        next_action:
          'Prepare with the current coordinator identity, or use the transition engine to change ownership; a coordinator is never inferred.',
      });
    for (const item of cohort.assignments) {
      const attempt = findAttempt(
        existingRecord,
        item.declaration.subtask_id,
        1,
      );
      if (attempt !== null && attempt.state !== 'assigned')
        blockers.push({
          code: 'attempt_already_registered',
          detail: `${item.declaration.subtask_id}#1 is already ${attempt.state}.`,
          next_action:
            'Inspect the existing attempt; prepare never rewrites a registered assignment.',
        });
    }
  }

  for (const item of cohort.assignments) {
    const existing = sealedDocumentOf(item.assignment_ref);
    if (existing === null) continue;
    // Idempotence is judged on the declaration identity, because the sealed document also
    // carries the real epochs stamped at seal time. A substantive change is still a conflict.
    const declared = assignmentDigestOf(existing.value);
    if (declared !== item.declaration_digest)
      blockers.push({
        code: 'sealed_input_conflict',
        detail: `Sealed assignment ${item.declaration.subtask_id} no longer matches this request (${declared} vs ${item.declaration_digest}).`,
        next_action:
          'Keep the sealed input or prepare a new subtask; sealed bytes are never rewritten to match a new request.',
      });
  }

  // Domain-wide read-only footprint check. Claim conflicts, including the derived Git
  // index/HEAD resources, are reported here so apply can validate everything first.
  if (!blockers.some((item) => item.code === 'task_record_unreadable')) {
    let records;
    try {
      records = listDomainRecords(domainRoot);
    } catch {
      records = null;
    }
    if (records !== null) {
      for (const item of cohort.assignments) {
        if (item.deferred) continue;
        for (const batch of item.claim_batches) {
          const candidates = expandResources(batch.resources, {
            includeGit: batch.access === 'write',
          });
          const conflicts = scanConflicts(records, candidates, {
            access: batch.access,
            holder: {
              agent_id: item.participant.agent_id,
              session_id: item.participant.session_id,
              harness: item.participant.harness,
            },
          });
          for (const conflict of conflicts)
            blockers.push({
              code: 'resource_conflict',
              detail: `${item.declaration.subtask_id} cannot claim ${conflict.resource_key}: held ${conflict.held_access} by ${String(conflict.held_by?.agent_id ?? 'unknown')} in task ${conflict.held_task}.`,
              next_action:
                'Resolve or release the holding claim in its own task; the derived Git index/HEAD claims conflict exactly like path claims.',
            });
        }
      }
    }
  }

  const bindings = request.bindings.map((item) => ({ ...item }));
  const plan: WorkflowPlan = {
    schema: WORKFLOW_PLAN_SCHEMA,
    action: 'prepare',
    apply: false,
    status: blockers.length === 0 ? 'planned' : 'blocked',
    task_id: request.task_id,
    task_root: cohort.taskRoot,
    domain_root: request.domain_root,
    input_revision: cohort.goal_input.digest,
    assignments: cohort.assignments.map((item) =>
      planEntry(cohort.taskRoot, item, sealedDocumentOf(item.assignment_ref)),
    ),
    bindings,
    blockers,
    warnings: cohort.assignments
      .filter((item) => item.deferred)
      .map(
        (item) =>
          `${item.declaration.subtask_id} is a reviewer assignment: its ASSIGN and read claims stay deferred until accepted writers release.`,
      ),
    limits: [
      `declared resources per assignment <= ${16}`,
      'reviewer ASSIGN and claims deferred until writers release',
      'manifest is immutable bookkeeping, not a second task authority',
    ],
  };
  return { ok: true, value: { plan, derived: cohort, blockers } };
}

/**
 * Declaration and wire digests for a sealed assignment.
 *
 * `resource_epoch` is real claim state stamped at seal time, so it cannot be known during a
 * read-only plan. The declaration digest ignores it for plan/sealed/rerun identity; the
 * separate wire pin covers the exact sealed bytes for the manifest, ASSIGN and admission.
 */
export function normalizeAssignmentDocument(value: unknown): unknown {
  const document = value as { resources?: unknown };
  if (!Array.isArray(document.resources)) return value;
  return {
    ...(value as Record<string, unknown>),
    resources: document.resources.map((resource) => {
      const item = resource as Record<string, unknown>;
      const { resource_epoch: _ignored, ...rest } = item;
      void _ignored;
      return rest;
    }),
  };
}

export function assignmentDigestOf(value: unknown): string {
  return digestText(
    `${JSON.stringify(normalizeAssignmentDocument(value), null, 2)}\n`,
  );
}

function episodeOrSelf(
  resource: {
    kind?: string;
    path: string;
    access: string;
    scope?: string;
  },
  epoch: number | undefined,
): {
  kind: string;
  path: string;
  access: string;
  scope?: 'file' | 'tree';
  resource_epoch?: number;
} {
  const base: {
    kind: string;
    path: string;
    access: string;
    scope?: 'file' | 'tree';
  } = {
    kind: resource.kind ?? 'path',
    path: resource.path,
    access: resource.access,
    ...(resource.scope === 'file' || resource.scope === 'tree'
      ? { scope: resource.scope }
      : {}),
  };
  return epoch === undefined ? base : { ...base, resource_epoch: epoch };
}

function applyAssignmentDocument(
  root: string,
  derived: DerivedAssignment,
  epochs: ReadonlyMap<string, number>,
): {
  status: string;
  digest: string;
} {
  // Work-run correlates sealed assignment resources against the real claims, so the sealed
  // document carries the resource_epoch actually held, never an invented number.
  const sealedDocument = {
    ...derived.assignment,
    resources: derived.assignment.resources.map((resource) => {
      const epoch = epochs.get(resource.path.toLowerCase());
      return episodeOrSelf(resource, epoch);
    }),
  };
  const write: ExclusiveWrite = writeJsonExclusive(
    root,
    derived.assignment_ref,
    sealedDocument,
  );
  if (write.status === 'unsafe')
    throw Object.assign(new Error(`Cannot seal assignment: ${write.detail}`), {
      workflowCode: 'sealed_assignment_unsafe',
    });
  if (write.status === 'conflict')
    throw Object.assign(
      new Error('Sealed assignment bytes differ from this request'),
      { workflowCode: 'sealed_input_conflict' },
    );
  // The wire pin is the digest of the exact bytes that were written (`wx` create, or the
  // identical existing bytes on a rerun), never a re-normalized projection of them.
  return { status: write.status, digest: write.digest };
}

interface AssignmentMessage {
  readonly message: Message;
  readonly digest: string;
}

/**
 * Builds the ASSIGN envelope for one assignment once its wire pin exists. The pin is the
 * exact sealed file digest, so this cannot run during planning.
 */
function assignmentMessageOf(
  request: WorkflowPrepareRequest,
  item: DerivedAssignment,
  wireDigest: string,
  inputRevision: string,
): AssignmentMessage {
  const coordinator = request.coordinator;
  const participant = item.participant;
  const message = buildMessage({
    type: 'ASSIGN',
    task_id: request.task_id,
    from: {
      agent_id: coordinator.agent_id,
      session_id: coordinator.session_id,
      harness: coordinator.harness,
    },
    to: {
      agent_id: participant.agent_id,
      session_id: participant.session_id,
      harness: participant.harness,
    },
    message_id: item.message_id,
    subtask_id: item.declaration.subtask_id,
    attempt: item.attempt,
    owner_epoch: coordinator.owner_epoch,
    body: {
      assignment_ref: item.assignment_ref,
      assignment_digest: wireDigest,
      input_revision: inputRevision,
    },
  });
  return { message, digest: message.content_digest ?? digestText('') };
}

export interface PrepareApplyOptions {
  readonly clock?: number;
}

export async function applyPrepare(
  request: WorkflowPrepareRequest,
  options: PrepareApplyOptions = {},
): Promise<
  WorkflowResult<{
    manifest: string;
    manifest_digest: string;
    deferred: readonly string[];
  }>
> {
  const planned = planPrepare(request);
  if (!planned.ok) {
    const result = emptyResult<{
      manifest: string;
      manifest_digest: string;
      deferred: readonly string[];
    }>('prepare', true);
    return {
      ...result,
      blockers: [
        {
          code: planned.code,
          detail: planned.message,
          next_action: planned.nextAction,
        },
      ],
      next_action: planned.nextAction,
    };
  }
  const { plan, derived } = planned.value;
  if (derived === null) {
    return { ...emptyResult('prepare', true), status: 'invalid' };
  }
  const cohort = derived;
  const blockers = [...plan.blockers];
  const result = emptyResult<{
    manifest: string;
    manifest_digest: string;
    deferred: readonly string[];
  }>('prepare', true);
  const mutableResult = { ...result };
  if (blockers.length > 0)
    return {
      ...mutableResult,
      status: 'blocked',
      task_id: request.task_id,
      task_root: cohort.taskRoot,
      domain_root: request.domain_root,
      blockers,
      next_action: blockers[0]?.next_action ?? null,
    };

  const coordinator = {
    agent_id: request.coordinator.agent_id,
    session_id: request.coordinator.session_id,
    harness: request.coordinator.harness,
    owner_epoch: request.coordinator.owner_epoch,
    since:
      request.coordinator.since ??
      new Date(options.clock ?? Date.now()).toISOString(),
  };
  const init = initTask(cohort.taskRoot, {
    taskId: request.task_id,
    coordinator,
    domainRoot: request.domain_root,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const record = init.record;
  if (record === null)
    return {
      ...mutableResult,
      status: 'needs-reconciliation',
      task_id: request.task_id,
      task_root: cohort.taskRoot,
      blockers: [
        {
          code: 'task_record_unreadable',
          detail: 'The task root exists but holds no readable record.',
          next_action: 'Run collab state doctor for this task root.',
        },
      ],
    };

  if (cohort.goal_document !== null) {
    const goalWrite = writeJsonExclusive(
      cohort.taskRoot,
      path.join(cohort.taskRoot, 'workflow', 'goal.json'),
      cohort.goal_document,
    );
    if (goalWrite.status === 'conflict')
      blockers.push({
        code: 'goal_document_conflict',
        detail:
          'A different sealed goal document already exists for this task.',
        next_action:
          'Inspect the sealed goal; it is the immutable input this cohort was derived from.',
      });
    if (goalWrite.status === 'unsafe')
      blockers.push({
        code: 'goal_document_unsafe',
        detail: `Cannot seal the goal document: ${goalWrite.detail}.`,
        next_action:
          'Inspect the workflow directory; nothing else was written.',
      });
  }

  // Only derived digests are sealed; a per-run write status would make the manifest
  // non-reproducible and turn an honest rerun into a conflict.
  const appliedMessages: {
    message_id: string;
    type: string;
    registration: string | null;
    duplicate: boolean;
    delivery: string;
    digest: string | null;
  }[] = [];
  const claims: {
    claim_id: string;
    key: string;
    access: string;
    action: 'claimed' | 'released' | 'held';
  }[] = [];
  let stateRevision = record.state_revision;

  // Claims run before sealing so the sealed assignment can carry the real held epochs. They
  // are idempotent: an existing claim set for this attempt is reused, not re-allocated.
  const epochsBySubtask = new Map<string, Map<string, number>>();
  for (const item of cohort.assignments) {
    if (item.deferred) continue;
    const epochs = new Map<string, number>();
    for (const batch of item.claim_batches) {
      const snapshot = readRecord(cohort.taskRoot);
      const held = (snapshot?.claims ?? []).filter(
        (claim) =>
          claim.released_at === null &&
          claim.subtask_id === item.declaration.subtask_id &&
          claim.attempt === item.attempt &&
          claim.access === batch.access,
      );
      const required = expandResources(batch.resources, {
        includeGit: batch.access === 'write',
      });
      const heldKeys = new Set(held.map((claim) => claim.key));
      if (required.every((resource) => heldKeys.has(resource.key))) {
        for (const claim of held) {
          claims.push({
            claim_id: claim.claim_id,
            key: claim.key,
            access: claim.access,
            action: 'held',
          });
          if (typeof claim.path === 'string')
            epochs.set(claim.path.toLowerCase(), claim.resource_epoch);
        }
        for (const resource of item.declaration.resources) {
          const match = held.find(
            (claim) =>
              typeof claim.path === 'string' &&
              claim.path.toLowerCase() === resource.path.toLowerCase(),
          );
          if (match !== undefined)
            epochs.set(resource.path.toLowerCase(), match.resource_epoch);
        }
        continue;
      }
      const claimed = claimResources(cohort.taskRoot, {
        resources: batch.resources,
        access: batch.access,
        holder: {
          agent_id: item.participant.agent_id,
          session_id: item.participant.session_id,
          harness: item.participant.harness,
        },
        subtaskId: item.declaration.subtask_id,
        attempt: item.attempt,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        note: 'workflow prepare',
      });
      if (!claimed.ok) {
        blockers.push({
          code: String(claimed.reason),
          detail: `${item.declaration.subtask_id} could not claim its ${batch.access} footprint: ${String(claimed.reason)}.`,
          next_action:
            'Re-run apply once the holding claim is gone; the sealed assignment and registered attempt are reused, not duplicated.',
        });
        continue;
      }
      for (const claim of claimed.claims) {
        claims.push({
          claim_id: claim.claim_id,
          key: claim.key,
          access: claim.access,
          action: claim.released_at === null ? 'claimed' : 'held',
        });
        if (typeof claim.path === 'string')
          epochs.set(claim.path.toLowerCase(), claim.resource_epoch);
      }
      for (const resource of item.declaration.resources) {
        const match = claimed.claims.find(
          (claim) =>
            typeof claim.path === 'string' &&
            claim.path.toLowerCase() === resource.path.toLowerCase(),
        );
        if (match !== undefined)
          epochs.set(resource.path.toLowerCase(), match.resource_epoch);
      }
    }
    epochsBySubtask.set(item.declaration.subtask_id, epochs);
  }

  // Only derived digests are sealed; a per-run write status would make the manifest
  // non-reproducible and turn an honest rerun into a conflict.
  const sealed: { subtask_id: string; digest: string }[] = [];
  const wireBySubtask = new Map<string, string>();
  for (const item of cohort.assignments) {
    const epochs =
      epochsBySubtask.get(item.declaration.subtask_id) ?? new Map();
    const outcome = applyAssignmentDocument(cohort.taskRoot, item, epochs);
    wireBySubtask.set(item.declaration.subtask_id, outcome.digest);
    sealed.push({
      subtask_id: item.declaration.subtask_id,
      digest: outcome.digest,
    });
    // A sealed document that was already identical is reused, never rewritten.
  }

  const workPlan = {
    schema: WORK_PLAN_SCHEMA,
    plan_id: `workflow-${request.task_id}`,
    task_id: request.task_id,
    owner_epoch: request.coordinator.owner_epoch,
    nodes: cohort.assignments.map((item) => ({
      node_id: item.declaration.subtask_id,
      role: item.declaration.role,
      assignment_id: item.declaration.subtask_id,
      attempt: item.attempt,
      input_revision: cohort.goal_input.digest,
      assignee: {
        agent_id: item.participant.agent_id,
        session_id: item.participant.session_id,
      },
      depends_on: item.declaration.depends_on ?? [],
      resources: item.declaration.resources.map((resource) => ({
        path: resource.path,
        access: resource.access,
      })),
    })),
  };
  const validatedPlan = validateWorkPlan(workPlan);
  if (!validatedPlan.ok) {
    blockers.push({
      code: 'work_plan_invalid',
      detail: validatedPlan.diagnostics
        .map((diagnostic) => diagnostic.code)
        .join(', '),
      next_action:
        'Fix the cohort shape; the derived plan must validate before any dependent work can be accepted.',
    });
  }
  const planWrite = validatedPlan.ok
    ? writeJsonExclusive(
        cohort.taskRoot,
        workflowWorkPlanPath(cohort.taskRoot),
        workPlan,
      )
    : null;
  if (planWrite !== null && planWrite.status === 'conflict')
    blockers.push({
      code: 'work_plan_conflict',
      detail: 'A different sealed work plan already exists for this task.',
      next_action:
        'Inspect the sealed plan; it is derived bookkeeping and is never rewritten to match a new request.',
    });
  if (planWrite !== null && planWrite.status === 'unsafe')
    blockers.push({
      code: 'work_plan_unsafe',
      detail: `Cannot seal the work plan: ${planWrite.detail}.`,
      next_action:
        'Inspect the workflow directory; no dependent work was activated.',
    });

  // One immutable revision for the whole cohort: the digest of the pinned goal input bytes
  // (`goal.json` when no external input is declared). Work-plan nodes, the record, every
  // ASSIGN and the manifest all carry exactly this value, so a report can be accepted and
  // evaluated against the revision its attempt was started with.
  const inputRevision = cohort.goal_input.digest;
  const stamped = transact(cohort.taskRoot, {
    actor: request.coordinator.agent_id,
    purpose: 'workflow:prepare-input',
    apply: (current) => {
      if (current.input_revision === inputRevision) return null;
      current.input_revision = inputRevision;
      return {
        record: current,
        op: 'workflow-input',
        summary: { input_revision: inputRevision },
      };
    },
  });
  if (stamped.ok) stateRevision = stamped.state_revision;

  for (const item of cohort.assignments) {
    if (item.deferred) continue;
    const wire = wireBySubtask.get(item.declaration.subtask_id);
    if (wire === undefined) continue;
    const built = assignmentMessageOf(request, item, wire, inputRevision);
    const submitted = submitMessage(cohort.taskRoot, built.message, {
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const registration =
      typeof submitted.registration?.status === 'string'
        ? submitted.registration.status
        : null;
    appliedMessages.push({
      message_id: built.message.message_id,
      type: 'ASSIGN',
      registration,
      duplicate: submitted.ok && submitted.duplicate === true,
      delivery: 'persisted-not-notified',
      digest: built.digest,
    });
    if (!submitted.ok)
      blockers.push({
        code:
          submitted.reason === 'content_conflict'
            ? 'message_content_conflict'
            : 'assignment_refused',
        detail: `ASSIGN for ${item.declaration.subtask_id} was refused: ${String(submitted.reason)}.`,
        next_action:
          'Inspect the registered message and the attempt; a changed ASSIGN for a registered attempt is never replayed.',
      });
  }

  const manifest = {
    schema: WORKFLOW_MANIFEST_SCHEMA,
    version: WORKFLOW_MANIFEST_VERSION,
    task_id: request.task_id,
    domain_root: request.domain_root,
    task_root: cohort.taskRoot,
    input_revision: inputRevision,
    goal: {
      objective: request.goal.objective,
      input_ref: request.goal.input_ref,
      input_digest: request.goal.input_digest,
    },
    coordinator: {
      agent_id: request.coordinator.agent_id,
      session_id: request.coordinator.session_id,
      harness: request.coordinator.harness,
      owner_epoch: request.coordinator.owner_epoch,
    },
    participants: request.participants.map((item) => ({ ...item })),
    bindings: request.bindings.map((item) => ({ ...item })),
    assignments: cohort.assignments.map((item) => ({
      subtask_id: item.declaration.subtask_id,
      role: item.declaration.role,
      attempt: item.attempt,
      assignee: {
        agent_id: item.participant.agent_id,
        session_id: item.participant.session_id,
        harness: item.participant.harness,
      },
      deferred: item.deferred,
      assignment_ref: item.assignment_ref,
      declaration_digest: item.declaration_digest,
      // The wire pin is the exact sealed bytes; deferred reviewers are sealed here too, so
      // their pin exists even though their ASSIGN waits for activation.
      assignment_digest: wireBySubtask.get(item.declaration.subtask_id) ?? null,
      message_id: item.deferred ? null : item.message_id,
      message_digest:
        item.deferred ||
        wireBySubtask.get(item.declaration.subtask_id) === undefined
          ? null
          : assignmentMessageOf(
              request,
              item,
              wireBySubtask.get(item.declaration.subtask_id) as string,
              inputRevision,
            ).digest,
      resources: item.declaration.resources.map((entry) => ({ ...entry })),
      derived_resources: [...item.derived_keys],
      depends_on: item.declaration.depends_on ?? [],
    })),
    sealed,
  };
  const manifestWrite = writeJsonExclusive(
    cohort.taskRoot,
    workflowManifestPath(cohort.taskRoot),
    manifest,
  );
  const manifestDigest =
    manifestWrite.status === 'created' || manifestWrite.status === 'identical'
      ? manifestWrite.digest
      : '';
  if (manifestWrite.status === 'conflict') {
    blockers.push({
      code: 'manifest_conflict',
      detail: `A different manifest is already sealed for ${request.task_id}.`,
      next_action:
        'The manifest is immutable input bookkeeping; inspect it instead of rewriting it.',
    });
  } else if (manifestWrite.status === 'unsafe') {
    blockers.push({
      code: 'manifest_unsafe',
      detail: `Cannot seal the manifest: ${manifestWrite.detail}.`,
      next_action:
        'Inspect the workflow directory; nothing outside it was changed.',
    });
  }

  const coordinatorBinding = bindingFor(request, request.coordinator.agent_id);
  const bindingParticipants = request.participants.map((item) => {
    const binding = bindingFor(request, item.agent_id);
    return {
      agent_id: item.agent_id,
      harness: item.harness,
      cwd: item.cwd,
      herdr_agent: item.agent_id,
      pane_id: binding?.pane_id ?? null,
      native_session_id: item.session_id,
    };
  });
  // A coordinator that is not also a declared participant has no participant entry, so its
  // explicit binding is the only routing record for the sender side of coordinator messages;
  // dispatch refuses a sender the sealed binding does not describe. A coordinator that is
  // also a participant keeps exactly one entry: the mapping above, never two.
  if (coordinatorBinding !== null) {
    const declared = participantFor(request, request.coordinator.agent_id);
    if (declared === null)
      bindingParticipants.push({
        agent_id: request.coordinator.agent_id,
        harness: request.coordinator.harness,
        cwd: request.coordinator.cwd,
        herdr_agent: request.coordinator.agent_id,
        pane_id: coordinatorBinding.pane_id,
        native_session_id: request.coordinator.session_id,
      });
  }
  const bindingWrite =
    request.bindings.length === 0
      ? null
      : writeJsonExclusive(
          cohort.taskRoot,
          workflowBindingPath(cohort.taskRoot),
          {
            schema: 'pappra/collab-binding/1',
            task_id: request.task_id,
            task_root: cohort.taskRoot,
            channel: 'herdr',
            participants: bindingParticipants,
          },
        );
  if (bindingWrite !== null && bindingWrite.status === 'conflict')
    blockers.push({
      code: 'binding_conflict',
      detail: 'A different binding document already exists for this task.',
      next_action:
        'Keep the observed binding, or use collab binding to change it explicitly.',
    });

  const status = blockers.length === 0 ? 'applied' : 'needs-reconciliation';
  return {
    ...mutableResult,
    // `emptyResult` starts at ok:false (an invalid request); an applied prepare is a real
    // success and must say so, or every consumer sees failure with status "applied".
    ok: blockers.length === 0,
    status,
    task_id: request.task_id,
    task_root: cohort.taskRoot,
    domain_root: request.domain_root,
    state_revision: stateRevision,
    principal: {
      agent_id: request.coordinator.agent_id,
      session_id: request.coordinator.session_id,
      harness: request.coordinator.harness,
      role: 'coordinator',
    },
    messages: appliedMessages,
    claims,
    blockers,
    next_action:
      blockers[0]?.next_action ??
      (status === 'applied'
        ? 'Reviewer assignments stay deferred; dispatch writers next, then dispatch reviewers after accepted writers release.'
        : null),
    detail: {
      manifest: workflowManifestPath(cohort.taskRoot),
      manifest_digest: manifestDigest,
      deferred: cohort.assignments
        .filter((item) => item.deferred)
        .map((item) => item.declaration.subtask_id),
    },
  } satisfies WorkflowResult<{
    manifest: string;
    manifest_digest: string;
    deferred: readonly string[];
  }>;
}
