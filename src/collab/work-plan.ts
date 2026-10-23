import path from 'node:path';
import { pathRelation } from './canonical.js';
import { contentDigest, validateEnvelope } from './envelope.js';
import type {
  AppliedMessage,
  Attempt,
  Claim,
  Message,
  ResultEntry,
  TaskRecord,
} from './types.js';

/**
 * Bounded, read-only role and dependency planning over the authoritative task record.
 *
 * This module never writes a record, never claims a resource, never dispatches and never
 * refreshes evidence. It reads the caller's `TaskRecord` plus the full registered message
 * envelopes the caller already holds, and reports what the current record says about each
 * planned node. Every dependency is gated on an explicit coordinator acceptance whose
 * meaning is re-derived here from the registered envelope, the record entry and the digest
 * of the accepted report; a finished report alone never unlocks dependent work. The result
 * is advisory and must be re-evaluated before a later explicit claim or dispatch: role
 * labels select responsibilities, never authority.
 */

export const WORK_PLAN_SCHEMA = 'pappra/collab-work-plan/1';
export const WORK_PLAN_EVALUATION_SCHEMA =
  'pappra/collab-work-plan-evaluation/1';

const MAX_NODES = 64;
const MAX_DEPENDENCIES = 16;
const MAX_RESOURCES = 16;
const MAX_STRING = 512;
const MAX_EVIDENCE = 256;
/** Documented bound per record array; beyond it planning refuses rather than truncating. */
const MAX_RECORD_ENTRIES = 512;

/** Blockers that never stop the request itself: they say "re-evaluate before acting". */
const IGNORED_UNCERTAINTY = new Set(['registered_not_started', 'late_result']);

export interface WorkPlanResource {
  readonly path: string;
  readonly access: 'read' | 'write';
}

export interface WorkPlanNode {
  readonly node_id: string;
  readonly role: string;
  /** Assignment identity this node expects; correlation is validated, never granted. */
  readonly assignment_id: string;
  readonly attempt: number;
  /** Pinned input revision the node expects to run against. */
  readonly input_revision: string;
  readonly assignee: {
    readonly agent_id: string;
    readonly session_id: string;
  };
  readonly depends_on: readonly string[];
  readonly resources: readonly WorkPlanResource[];
}

export interface WorkPlan {
  readonly schema: typeof WORK_PLAN_SCHEMA;
  readonly plan_id: string;
  readonly task_id: string;
  readonly owner_epoch: number;
  readonly nodes: readonly WorkPlanNode[];
}

export interface WorkPlanDiagnostic {
  readonly code: string;
  readonly node_id: string | null;
  readonly detail: string;
}

export type WorkPlanValidation =
  | { readonly ok: true; readonly plan: WorkPlan }
  | { readonly ok: false; readonly diagnostics: readonly WorkPlanDiagnostic[] };

export type WorkNodeStatus =
  'ready' | 'running' | 'awaiting_acceptance' | 'accepted' | 'blocked';

export interface WorkNodeBlocker {
  readonly code: string;
  readonly detail: string;
}

export interface WorkNodeEvaluation {
  readonly node_id: string;
  readonly role: string;
  readonly status: WorkNodeStatus;
  readonly blockers: readonly WorkNodeBlocker[];
  readonly recovery: string | null;
}

export interface WorkPlanEvaluation {
  readonly schema: typeof WORK_PLAN_EVALUATION_SCHEMA;
  readonly ok: true;
  readonly plan_id: string;
  readonly task_id: string;
  readonly owner_epoch: number;
  readonly nodes: readonly WorkNodeEvaluation[];
  readonly ready_nodes: readonly string[];
  readonly running_nodes: readonly string[];
  readonly awaiting_acceptance_nodes: readonly string[];
  readonly accepted_nodes: readonly string[];
  readonly blocked_nodes: readonly string[];
  readonly limits: readonly string[];
}

export interface WorkPlanRefusal {
  readonly ok: false;
  readonly diagnostics: readonly WorkPlanDiagnostic[];
}

/**
 * Caller-supplied evidence. `record` is the authoritative `TaskRecord` that was read from
 * the task root; `messages` are the full envelopes the caller holds for it. An acceptance
 * that is registered in the record but not supplied here cannot be verified, so it never
 * unlocks work.
 */
export interface WorkPlanEvidence {
  readonly plan: unknown;
  readonly record: TaskRecord;
  readonly messages?: readonly Message[];
}

const isString = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_STRING &&
  !value.includes('\u0000');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIdentity = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  isString(value['agent_id']) &&
  isString(value['session_id']);

const isOptionalString = (value: unknown): boolean =>
  value === undefined || value === null || typeof value === 'string';

const isOptionalInteger = (value: unknown): boolean =>
  value === undefined || value === null || Number.isSafeInteger(value);

/** The fields each record entry must expose before evaluation dereferences it. */
const RECORD_ENTRIES: readonly [string, (value: unknown) => boolean][] = [
  [
    'attempts',
    (value) =>
      isRecord(value) &&
      typeof value['subtask_id'] === 'string' &&
      Number.isSafeInteger(value['attempt']) &&
      typeof value['state'] === 'string' &&
      isIdentity(value['assignee']) &&
      isOptionalString(value['input_revision']) &&
      isOptionalInteger(value['owner_epoch']),
  ],
  [
    'messages',
    (value) =>
      isRecord(value) &&
      typeof value['message_id'] === 'string' &&
      typeof value['type'] === 'string' &&
      typeof value['state'] === 'string' &&
      typeof value['content_digest'] === 'string' &&
      typeof value['at'] === 'string' &&
      isIdentity(value['from']) &&
      isOptionalString(value['reply_to']) &&
      isOptionalString(value['subtask_id']) &&
      isOptionalInteger(value['attempt']),
  ],
  [
    'results',
    (value) =>
      isRecord(value) &&
      typeof value['subtask_id'] === 'string' &&
      Number.isSafeInteger(value['attempt']) &&
      typeof value['classification'] === 'string' &&
      typeof value['status'] === 'string' &&
      typeof value['message_id'] === 'string',
  ],
  [
    'claims',
    (value) =>
      isRecord(value) &&
      typeof value['claim_id'] === 'string' &&
      typeof value['access'] === 'string' &&
      isOptionalString(value['path']) &&
      isOptionalString(value['released_at']) &&
      (value['holder'] === undefined ||
        value['holder'] === null ||
        isIdentity(value['holder'])),
  ],
  [
    'uncertainty',
    (value) =>
      isRecord(value) &&
      typeof value['uncertainty_id'] === 'string' &&
      typeof value['kind'] === 'string' &&
      isOptionalString(value['resolved_at']) &&
      isOptionalString(value['subtask_id']) &&
      isOptionalInteger(value['attempt']),
  ],
];
function diagnostic(
  diagnostics: WorkPlanDiagnostic[],
  code: string,
  detail: string,
  nodeId: string | null = null,
): void {
  diagnostics.push({ code, node_id: nodeId, detail });
}

/** Plan paths are compared lexically only; `..` and symlink aliases are refused, not guessed. */
function normalizePlanPath(value: string): string | null {
  if (!path.isAbsolute(value)) return null;
  const strip = (candidate: string): string =>
    candidate.length > 1 ? candidate.replace(/\/+$/, '') : candidate;
  const normalized = path.normalize(value);
  if (strip(normalized) !== strip(value)) return null;
  return strip(value);
}

function readResources(
  value: unknown,
  nodeId: string,
  diagnostics: WorkPlanDiagnostic[],
): WorkPlanResource[] | null {
  if (!Array.isArray(value) || value.length > MAX_RESOURCES) {
    diagnostic(
      diagnostics,
      'plan_too_large',
      `resources must be an array of at most ${MAX_RESOURCES}`,
      nodeId,
    );
    return null;
  }
  const resources: WorkPlanResource[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isString(entry['path'])) {
      diagnostic(
        diagnostics,
        'resource_invalid',
        'resource needs a bounded absolute path',
        nodeId,
      );
      return null;
    }
    if (normalizePlanPath(entry['path']) === null) {
      diagnostic(
        diagnostics,
        'resource_invalid',
        'resource path must be absolute and already normalized',
        nodeId,
      );
      return null;
    }
    if (entry['access'] !== 'read' && entry['access'] !== 'write') {
      diagnostic(
        diagnostics,
        'resource_invalid',
        'resource access must be read or write',
        nodeId,
      );
      return null;
    }
    resources.push({ path: entry['path'], access: entry['access'] });
  }
  return resources;
}

function readNode(
  value: unknown,
  index: number,
  diagnostics: WorkPlanDiagnostic[],
): WorkPlanNode | null {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'node_invalid', `node ${index} is not an object`);
    return null;
  }
  const nodeId = value['node_id'];
  if (!isString(nodeId)) {
    diagnostic(
      diagnostics,
      'node_invalid',
      `node ${index} needs a bounded node_id`,
    );
    return null;
  }
  if (value['requires_acceptance'] !== undefined) {
    // Dependency acceptance is coordinator-only: a plan cannot declare itself exempt.
    diagnostic(
      diagnostics,
      'plan_invalid',
      'requires_acceptance is not part of the plan format; coordinator acceptance always gates dependents',
      nodeId,
    );
    return null;
  }
  const role = value['role'];
  const assignmentId = value['assignment_id'];
  const inputRevision = value['input_revision'];
  const attempt = value['attempt'];
  const assignee = value['assignee'];
  const dependsOn = value['depends_on'];
  if (!isString(role) || !isString(assignmentId) || !isString(inputRevision)) {
    diagnostic(
      diagnostics,
      'node_invalid',
      'role, assignment_id and input_revision are required',
      nodeId,
    );
    return null;
  }
  if (
    typeof attempt !== 'number' ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > 1000
  ) {
    diagnostic(
      diagnostics,
      'node_invalid',
      'attempt must be a positive bounded integer',
      nodeId,
    );
    return null;
  }
  if (!isIdentity(assignee)) {
    diagnostic(
      diagnostics,
      'node_invalid',
      'assignee needs agent_id and session_id',
      nodeId,
    );
    return null;
  }
  if (!Array.isArray(dependsOn) || dependsOn.length > MAX_DEPENDENCIES) {
    diagnostic(
      diagnostics,
      'plan_too_large',
      `depends_on must be an array of at most ${MAX_DEPENDENCIES}`,
      nodeId,
    );
    return null;
  }
  const dependencies: string[] = [];
  for (const dependency of dependsOn) {
    if (!isString(dependency)) {
      diagnostic(
        diagnostics,
        'dependency_invalid',
        'dependency ids must be bounded strings',
        nodeId,
      );
      return null;
    }
    dependencies.push(dependency);
  }
  const resources = readResources(value['resources'], nodeId, diagnostics);
  if (resources === null) return null;
  return {
    node_id: nodeId,
    role,
    assignment_id: assignmentId,
    attempt,
    input_revision: inputRevision,
    assignee: {
      agent_id: assignee['agent_id'] as string,
      session_id: assignee['session_id'] as string,
    },
    depends_on: dependencies,
    resources,
  };
}

/** Validates shape, bounds and the dependency graph before any evaluation. */
export function validateWorkPlan(input: unknown): WorkPlanValidation {
  const diagnostics: WorkPlanDiagnostic[] = [];
  if (!isRecord(input)) {
    diagnostic(diagnostics, 'plan_invalid', 'plan must be an object');
    return { ok: false, diagnostics };
  }
  if (input['schema'] !== WORK_PLAN_SCHEMA) {
    diagnostic(
      diagnostics,
      'plan_invalid',
      `schema must be ${WORK_PLAN_SCHEMA}`,
    );
    return { ok: false, diagnostics };
  }
  const planId = input['plan_id'];
  const taskId = input['task_id'];
  const ownerEpoch = input['owner_epoch'];
  if (!isString(planId) || !isString(taskId)) {
    diagnostic(diagnostics, 'plan_invalid', 'plan_id and task_id are required');
    return { ok: false, diagnostics };
  }
  if (
    typeof ownerEpoch !== 'number' ||
    !Number.isSafeInteger(ownerEpoch) ||
    ownerEpoch < 1
  ) {
    diagnostic(
      diagnostics,
      'plan_invalid',
      'owner_epoch must be a positive integer',
    );
    return { ok: false, diagnostics };
  }
  const rawNodes = input['nodes'];
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    diagnostic(diagnostics, 'plan_invalid', 'nodes must be a non-empty array');
    return { ok: false, diagnostics };
  }
  if (rawNodes.length > MAX_NODES) {
    diagnostic(
      diagnostics,
      'plan_too_large',
      `at most ${MAX_NODES} nodes are supported`,
    );
    return { ok: false, diagnostics };
  }
  const nodes: WorkPlanNode[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawNodes.entries()) {
    const node = readNode(raw, index, diagnostics);
    if (node === null) continue;
    if (seen.has(node.node_id)) {
      diagnostic(
        diagnostics,
        'duplicate_node_id',
        `node id is repeated: ${node.node_id}`,
        node.node_id,
      );
      continue;
    }
    seen.add(node.node_id);
    nodes.push(node);
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  for (const node of nodes) {
    const unique = new Set(node.depends_on);
    if (unique.size !== node.depends_on.length) {
      diagnostic(
        diagnostics,
        'duplicate_dependency',
        'a dependency is listed twice',
        node.node_id,
      );
      continue;
    }
    for (const dependency of node.depends_on) {
      if (dependency === node.node_id) {
        diagnostic(
          diagnostics,
          'self_dependency',
          'a node cannot depend on itself',
          node.node_id,
        );
        continue;
      }
      if (!seen.has(dependency)) {
        diagnostic(
          diagnostics,
          'unknown_dependency',
          `dependency is not a plan node: ${dependency}`,
          node.node_id,
        );
      }
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const state = new Map<string, 'visiting' | 'done'>();
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const visit = (nodeId: string, trail: string[]): boolean => {
    const current = state.get(nodeId);
    if (current === 'done') return true;
    if (current === 'visiting') {
      diagnostic(
        diagnostics,
        'dependency_cycle',
        `cycle: ${[...trail, nodeId].join(' -> ')}`,
        nodeId,
      );
      return false;
    }
    state.set(nodeId, 'visiting');
    const node = byId.get(nodeId);
    for (const dependency of node?.depends_on ?? []) {
      if (!visit(dependency, [...trail, nodeId])) return false;
    }
    state.set(nodeId, 'done');
    return true;
  };
  for (const node of nodes) {
    if (!visit(node.node_id, [])) break;
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return {
    ok: true,
    plan: {
      schema: WORK_PLAN_SCHEMA,
      plan_id: planId,
      task_id: taskId,
      owner_epoch: ownerEpoch,
      nodes,
    },
  };
}

const RECOVERY: ReadonlyMap<string, string> = new Map([
  [
    'owner_epoch_mismatch',
    'Re-read the task record and rebuild the plan against the current owner epoch.',
  ],
  [
    'dispatch_frozen',
    'A handoff froze dispatch; finish or release it before planning further dispatch.',
  ],
  [
    'assignment_stale',
    'Re-issue or re-pin the assignment attempt; planning never rewrites an existing attempt.',
  ],
  [
    'assignee_mismatch',
    'Plan the node for the assignee recorded on the current attempt, or re-issue the assignment.',
  ],
  [
    'input_unpinned',
    'Pin an input revision on the attempt before planning work against it.',
  ],
  [
    'input_changed',
    'Repin the assignment input revision before dispatching this node.',
  ],
  [
    'own_failed',
    'The recorded attempt already failed or was cancelled; decide explicitly whether a new attempt is needed.',
  ],
  ['own_blocked', 'Resolve the recorded block before this node can proceed.'],
  [
    'own_uncertain',
    'Confirm what the native execution actually did before planning further work.',
  ],
  [
    'uncertainty_open',
    'Reconcile the open uncertainty on this attempt; planning does not resolve it.',
  ],
  [
    'predecessor_incomplete',
    'Wait for the predecessor attempt to finish; readiness is advisory and must be re-evaluated.',
  ],
  [
    'predecessor_failed',
    'Resolve the failed predecessor explicitly; dependent work is not silently redispatched.',
  ],
  [
    'predecessor_blocked',
    'Resolve the predecessor blocker; this node cannot advance past an unusable predecessor.',
  ],
  [
    'acceptance_missing',
    'Obtain an explicit coordinator acceptance correlated to the predecessor report.',
  ],
  [
    'acceptance_untrusted',
    'Supply the registered acceptance envelope unchanged; an unregistered or edited one proves nothing.',
  ],
  [
    'acceptance_stale',
    'Re-accept the predecessor against the pinned input revision and owner epoch currently in force.',
  ],
  [
    'acceptance_mismatch',
    'Accept the exact predecessor assignment attempt and registered report digest.',
  ],
  [
    'acceptance_rejected',
    'Revise the rejected work under a new attempt before dependents advance.',
  ],
  [
    'acceptance_self_review',
    'Have the coordinator, not the writer, accept the report.',
  ],
  [
    'acceptance_not_coordinator',
    'Obtain acceptance from the current coordinator identity.',
  ],
  [
    'resource_overlap',
    'Serialize the concurrently overlapping write scope or narrow it; planning cannot fence.',
  ],
  [
    'resource_claim_conflict',
    'Wait for or explicitly transfer the active claim before dispatch; planning cannot fence.',
  ],
]);

function overlap(left: string, right: string): boolean {
  return pathRelation(left, right) !== 'disjoint';
}

function claimOverlaps(
  claim: Claim,
  resource: WorkPlanResource,
  access: WorkPlanResource['access'],
): boolean {
  if (typeof claim.path !== 'string') return false;
  if (claim.access === 'read' && access === 'read') return false;
  return overlap(claim.path, resource.path);
}

interface NodeFacts {
  readonly attempt: Attempt | null;
  readonly latestAttempt: number | null;
  readonly admitted: ResultEntry | null;
}

interface AcceptanceOutcome {
  readonly accepted: boolean;
  readonly blocker: WorkNodeBlocker | null;
}

/**
 * Evaluates a validated plan against the authoritative record and the supplied envelopes.
 *
 * Returns a refusal with diagnostics when the plan, the record or the supplied evidence is
 * malformed or oversized; readiness is never reported from facts that could not be read.
 */
export function evaluateWorkPlan(
  evidence: WorkPlanEvidence,
): WorkPlanEvaluation | WorkPlanRefusal {
  const validated = validateWorkPlan(evidence.plan);
  if (!validated.ok) return { ok: false, diagnostics: validated.diagnostics };
  const plan = validated.plan;
  const diagnostics: WorkPlanDiagnostic[] = [];
  const record = evidence.record;

  if (!isRecord(record)) {
    diagnostic(diagnostics, 'record_invalid', 'record must be an object');
    return { ok: false, diagnostics };
  }
  for (const [key, isValid] of RECORD_ENTRIES) {
    const entries = record[key];
    if (!Array.isArray(entries)) {
      diagnostic(
        diagnostics,
        'record_invalid',
        `record.${key} must be an array`,
      );
      continue;
    }
    if (entries.length > MAX_RECORD_ENTRIES) {
      diagnostic(
        diagnostics,
        'record_too_large',
        `record.${key} has ${entries.length} entries; planning reads at most ${MAX_RECORD_ENTRIES}`,
      );
      continue;
    }
    const malformed = entries.findIndex((entry) => !isValid(entry));
    if (malformed >= 0) {
      diagnostic(
        diagnostics,
        'record_invalid',
        `record.${key}[${malformed}] does not have the expected shape`,
      );
    }
  }
  if (record.coordinator !== null && record.coordinator !== undefined) {
    const coordinator: unknown = record.coordinator;
    if (
      !isRecord(coordinator) ||
      !isIdentity(coordinator) ||
      !Number.isSafeInteger(coordinator['owner_epoch'])
    ) {
      diagnostic(
        diagnostics,
        'record_invalid',
        'record.coordinator must carry an identity and an owner epoch',
      );
    }
  }
  if (
    record.dispatch_frozen !== undefined &&
    typeof record.dispatch_frozen !== 'boolean'
  ) {
    diagnostic(
      diagnostics,
      'record_invalid',
      'record.dispatch_frozen must be a boolean when present',
    );
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  if (record.task_id !== plan.task_id) {
    diagnostic(
      diagnostics,
      'task_identity_mismatch',
      `record is ${record.task_id}, plan is ${plan.task_id}`,
    );
    return { ok: false, diagnostics };
  }

  const supplied: Message[] = [];
  const rawMessages: unknown = evidence.messages ?? [];
  if (!Array.isArray(rawMessages)) {
    diagnostic(diagnostics, 'evidence_invalid', 'messages must be an array');
    return { ok: false, diagnostics };
  }
  if (rawMessages.length > MAX_EVIDENCE) {
    diagnostic(
      diagnostics,
      'evidence_too_large',
      `at most ${MAX_EVIDENCE} message envelopes may be supplied; narrow the evidence instead of truncating`,
    );
    return { ok: false, diagnostics };
  }
  for (const raw of rawMessages) {
    const label =
      isRecord(raw) && typeof raw['message_id'] === 'string'
        ? raw['message_id']
        : null;
    let envelope: Message;
    try {
      envelope = validateEnvelope(raw);
    } catch {
      diagnostic(
        diagnostics,
        'message_invalid',
        `supplied envelope ${label ?? '<unknown>'} is not a valid message`,
      );
      continue;
    }
    if (envelope.task_id !== plan.task_id) {
      diagnostic(
        diagnostics,
        'message_task_mismatch',
        `supplied envelope ${envelope.message_id} belongs to ${envelope.task_id}`,
      );
      continue;
    }
    supplied.push(envelope);
  }
  const envelopes = new Map<string, Message>();
  for (const envelope of supplied) {
    const existing = envelopes.get(envelope.message_id);
    if (existing !== undefined) {
      if (contentDigest(existing) !== contentDigest(envelope)) {
        diagnostic(
          diagnostics,
          'message_duplicate_conflict',
          `two different envelopes share message id ${envelope.message_id}`,
        );
        continue;
      }
      continue;
    }
    envelopes.set(envelope.message_id, envelope);
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const limits = new Set<string>([
    'advisory_read_only_plan',
    'no_resource_fencing',
    'no_dispatch_or_launch',
    're_evaluate_before_claim',
    'path_aliases_not_verified',
  ]);

  const attempts = record.attempts ?? [];
  const results = record.results ?? [];
  const claims = (record.claims ?? []).filter((claim) => !claim.released_at);
  const appliedMessages = record.messages ?? [];
  const appliedById = new Map(
    appliedMessages.map((entry) => [entry.message_id, entry]),
  );
  // Application order is the record's own append order; sender timestamps never order
  // authority, so a backdated or future-dated decision cannot change the outcome.
  const registrationIndex = new Map<string, number>();
  appliedMessages.forEach((entry, index) => {
    if (!registrationIndex.has(entry.message_id))
      registrationIndex.set(entry.message_id, index);
  });

  const attemptsBySubtask = new Map<string, Attempt[]>();
  const latestAttempt = new Map<string, number>();
  for (const attempt of attempts) {
    const list = attemptsBySubtask.get(attempt.subtask_id) ?? [];
    list.push(attempt);
    attemptsBySubtask.set(attempt.subtask_id, list);
    const seen = latestAttempt.get(attempt.subtask_id) ?? 0;
    latestAttempt.set(attempt.subtask_id, Math.max(seen, attempt.attempt));
  }
  const admittedByAttempt = new Map<string, ResultEntry[]>();
  for (const result of results) {
    if (result.classification !== 'applied') continue;
    const key = `${result.subtask_id}#${result.attempt}`;
    const list = admittedByAttempt.get(key) ?? [];
    list.push(result);
    admittedByAttempt.set(key, list);
  }

  const coordinator = record.coordinator ?? null;
  const epochCurrent =
    coordinator !== null && coordinator.owner_epoch === plan.owner_epoch;
  const byId = new Map(plan.nodes.map((node) => [node.node_id, node]));
  const memo = new Map<string, WorkNodeEvaluation>();
  const acceptanceMemo = new Map<string, AcceptanceOutcome>();

  const factsFor = (node: WorkPlanNode): NodeFacts => {
    const attempt =
      (attemptsBySubtask.get(node.assignment_id) ?? []).find(
        (candidate) => candidate.attempt === node.attempt,
      ) ?? null;
    const list =
      admittedByAttempt.get(`${node.assignment_id}#${node.attempt}`) ?? [];
    return {
      attempt,
      latestAttempt: latestAttempt.get(node.assignment_id) ?? null,
      admitted: list.length > 0 ? list[list.length - 1]! : null,
    };
  };

  /** True when the node's recorded attempt already ended and no longer writes. */
  const executionEndedFor = (node: WorkPlanNode): boolean => {
    const state = factsFor(node).attempt?.state ?? null;
    return state === 'completed' || state === 'failed' || state === 'cancelled';
  };

  /** True when `nodeId` transitively depends on `targetId`. */
  const dependsOn = (nodeId: string, targetId: string): boolean => {
    const seen = new Set<string>();
    const walk = (current: string): boolean => {
      const node = byId.get(current);
      if (node === undefined) return false;
      for (const dependency of node.depends_on) {
        if (dependency === targetId) return true;
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        if (walk(dependency)) return true;
      }
      return false;
    };
    return walk(nodeId);
  };

  const acceptanceOf = (node: WorkPlanNode): AcceptanceOutcome => {
    const cached = acceptanceMemo.get(node.node_id);
    if (cached !== undefined) return cached;
    const settle = (outcome: AcceptanceOutcome): AcceptanceOutcome => {
      acceptanceMemo.set(node.node_id, outcome);
      return outcome;
    };
    const denied = (code: string, detail: string): AcceptanceOutcome =>
      settle({ accepted: false, blocker: { code, detail } });
    const facts = factsFor(node);
    const admitted = facts.admitted;
    if (admitted === null) {
      return denied(
        'predecessor_incomplete',
        'no current applied result is recorded for this node',
      );
    }
    const reportEntry = appliedById.get(admitted.message_id);
    if (reportEntry === undefined) {
      return denied(
        'acceptance_untrusted',
        `report ${admitted.message_id} is not registered in the task record`,
      );
    }

    // The authoritative decision set comes from the record, never from the supplied list
    // alone: an omitted later rejection must not disappear.
    const decisions = appliedMessages.filter(
      (entry) =>
        entry.type === 'ANSWER' &&
        entry.state === 'applied' &&
        // A decision addressed to this report belongs to the authoritative set even when it
        // names a different attempt; the correlation checks below then refuse it.
        entry.reply_to === admitted.message_id,
    );
    if (decisions.length === 0) {
      const suppliedTargetsReport = [...envelopes.values()].some(
        (envelope) =>
          envelope.type === 'ANSWER' &&
          envelope.reply_to === admitted.message_id,
      );
      return suppliedTargetsReport
        ? denied(
            'acceptance_untrusted',
            'the supplied decision is not registered in the task record',
          )
        : denied(
            'acceptance_missing',
            'no registered coordinator decision targets this report',
          );
    }
    interface Resolved {
      readonly entry: AppliedMessage;
      readonly envelope: Message;
      readonly acceptance: Record<string, unknown>;
    }
    const resolved: Resolved[] = [];
    for (const entry of decisions) {
      const envelope = envelopes.get(entry.message_id);
      if (envelope === undefined) {
        limits.add('acceptance_envelope_missing');
        return denied(
          'acceptance_untrusted',
          `registered decision ${entry.message_id} was not supplied, so the decision set is incomplete`,
        );
      }
      if (
        entry.type !== envelope.type ||
        entry.content_digest !== contentDigest(envelope) ||
        entry.from.agent_id !== envelope.from.agent_id ||
        entry.from.session_id !== envelope.from.session_id
      ) {
        return denied(
          'acceptance_untrusted',
          `registered decision ${entry.message_id} does not match its stored digest`,
        );
      }
      const acceptance = envelope.body?.['acceptance'];
      if (!isRecord(acceptance)) {
        return denied(
          'acceptance_mismatch',
          `registered decision ${entry.message_id} carries no acceptance payload`,
        );
      }
      resolved.push({ entry, envelope, acceptance });
    }
    // Authoritative application order, never sender timestamps or message-id ordering.
    resolved.sort(
      (left, right) =>
        (registrationIndex.get(left.entry.message_id) ?? 0) -
        (registrationIndex.get(right.entry.message_id) ?? 0),
    );
    const witness = resolved[resolved.length - 1]!;
    if (
      witness.acceptance['plan_id'] !== plan.plan_id ||
      witness.acceptance['node_id'] !== node.node_id
    ) {
      return denied(
        'acceptance_mismatch',
        'the latest decision targets a different plan or node',
      );
    }
    const decision = witness.acceptance['decision'];
    if (decision !== 'accepted') {
      return denied(
        decision === 'rejected' ? 'acceptance_rejected' : 'acceptance_mismatch',
        `acceptance decision must be accepted, found ${String(decision)}`,
      );
    }
    const assignmentId = witness.acceptance['assignment_id'];
    const attemptNumber = witness.acceptance['attempt'];
    const inputRevision = witness.acceptance['input_revision'];
    const reportDigest = witness.acceptance['report_digest'];
    if (
      assignmentId !== node.assignment_id ||
      attemptNumber !== node.attempt ||
      reportDigest !== reportEntry.content_digest
    ) {
      return denied(
        'acceptance_mismatch',
        'acceptance does not target this assignment attempt and registered report digest',
      );
    }
    if (inputRevision !== node.input_revision) {
      return denied(
        'acceptance_stale',
        'acceptance targets a different input revision',
      );
    }
    const envelope = witness.envelope;
    if (
      envelope.subtask_id !== node.assignment_id ||
      envelope.attempt !== node.attempt ||
      envelope.reply_to !== admitted.message_id
    ) {
      return denied(
        'acceptance_mismatch',
        'acceptance envelope does not reply to this report for this attempt',
      );
    }
    if (envelope.owner_epoch !== plan.owner_epoch) {
      return denied(
        'acceptance_stale',
        'acceptance was issued under a different owner epoch',
      );
    }
    if (
      envelope.to.agent_id !== node.assignee.agent_id ||
      envelope.to.session_id !== node.assignee.session_id
    ) {
      return denied(
        'acceptance_mismatch',
        'acceptance is not addressed to the predecessor assignee',
      );
    }
    if (
      envelope.from.agent_id === node.assignee.agent_id &&
      envelope.from.session_id === node.assignee.session_id
    ) {
      return denied(
        'acceptance_self_review',
        'a writer cannot accept its own report',
      );
    }
    if (coordinator === null) {
      return denied(
        'owner_epoch_mismatch',
        'the record has no coordinator, so no acceptance can be current',
      );
    }
    if (
      envelope.from.agent_id !== coordinator.agent_id ||
      envelope.from.session_id !== coordinator.session_id
    ) {
      return denied(
        'acceptance_not_coordinator',
        'acceptance must come from the current coordinator identity',
      );
    }
    return settle({ accepted: true, blocker: null });
  };

  const evaluateNode = (nodeId: string): WorkNodeEvaluation => {
    const cached = memo.get(nodeId);
    if (cached !== undefined) return cached;
    const node = byId.get(nodeId);
    if (node === undefined) {
      const missing: WorkNodeEvaluation = {
        node_id: nodeId,
        role: 'unknown',
        status: 'blocked',
        blockers: [
          {
            code: 'predecessor_incomplete',
            detail: 'node is not part of the plan',
          },
        ],
        recovery: RECOVERY.get('predecessor_incomplete') ?? null,
      };
      memo.set(nodeId, missing);
      return missing;
    }

    const blockers: WorkNodeBlocker[] = [];
    const add = (code: string, detail: string): void => {
      if (blockers.some((blocker) => blocker.code === code)) return;
      blockers.push({ code, detail });
    };

    if (!epochCurrent) {
      add(
        'owner_epoch_mismatch',
        `plan owner epoch ${plan.owner_epoch} is not the current epoch ${coordinator?.owner_epoch ?? 'none'}`,
      );
    }
    if (record.dispatch_frozen === true) {
      add(
        'dispatch_frozen',
        'the record is dispatch-frozen; authority is not currently dispatchable',
      );
    }

    const facts = factsFor(node);
    if (facts.latestAttempt !== null && facts.latestAttempt !== node.attempt) {
      add(
        'assignment_stale',
        `planned attempt ${node.attempt} is not the latest attempt ${facts.latestAttempt}`,
      );
    }
    const attempt = facts.attempt;
    if (attempt !== null) {
      if (
        attempt.assignee.agent_id !== node.assignee.agent_id ||
        attempt.assignee.session_id !== node.assignee.session_id
      ) {
        add(
          'assignee_mismatch',
          'recorded assignee differs from the planned assignee',
        );
      }
      if (attempt.input_revision === null) {
        add(
          'input_unpinned',
          'the recorded attempt has no pinned input revision',
        );
      } else if (attempt.input_revision !== node.input_revision) {
        add(
          'input_changed',
          `recorded input revision ${attempt.input_revision} differs from the plan`,
        );
      }
      if (
        attempt.owner_epoch !== null &&
        attempt.owner_epoch !== plan.owner_epoch
      ) {
        add(
          'owner_epoch_mismatch',
          `attempt was issued under owner epoch ${attempt.owner_epoch}`,
        );
      }
      for (const entry of record.uncertainty ?? []) {
        if (entry.resolved_at) continue;
        if (entry.subtask_id !== node.assignment_id) continue;
        if (entry.attempt !== null && entry.attempt !== node.attempt) continue;
        if (IGNORED_UNCERTAINTY.has(entry.kind)) continue;
        add(
          'uncertainty_open',
          `unresolved ${entry.kind} uncertainty ${entry.uncertainty_id}`,
        );
        break;
      }
    }

    const ownState = attempt?.state ?? null;
    if (ownState === 'failed' || ownState === 'cancelled') {
      add('own_failed', `recorded attempt is ${ownState}`);
    } else if (ownState === 'needs_input') {
      add('own_blocked', 'recorded attempt is waiting for input');
    } else if (ownState === 'unknown') {
      add('own_uncertain', 'native execution state of the attempt is unknown');
    }

    for (const dependencyId of node.depends_on) {
      const dependency = evaluateNode(dependencyId);
      if (dependency.status === 'ready' || dependency.status === 'running') {
        add(
          'predecessor_incomplete',
          `predecessor ${dependencyId} has no current applied result yet`,
        );
        continue;
      }
      if (dependency.status === 'blocked') {
        const failed = dependency.blockers.some(
          (blocker) => blocker.code === 'own_failed',
        );
        add(
          failed ? 'predecessor_failed' : 'predecessor_blocked',
          `predecessor ${dependencyId} is blocked by ${dependency.blockers[0]?.code ?? 'unknown'}`,
        );
        continue;
      }
      if (dependency.status === 'awaiting_acceptance') {
        const dependencyNode = byId.get(dependencyId);
        const outcome =
          dependencyNode === undefined
            ? {
                accepted: false,
                blocker: {
                  code: 'predecessor_incomplete',
                  detail: `predecessor ${dependencyId} is not part of the plan`,
                },
              }
            : acceptanceOf(dependencyNode);
        if (outcome.blocker !== null) {
          add(outcome.blocker.code, outcome.blocker.detail);
        }
      }
    }

    // Resource scope describes current and future execution. A node whose attempt already
    // ended (completed, failed or cancelled) no longer proposes to write, so a successor's
    // claim on the same path cannot retroactively block it; planning never moves a claim.
    const executionEnded =
      ownState === 'completed' ||
      ownState === 'failed' ||
      ownState === 'cancelled';
    if (!executionEnded) {
      for (const resource of node.resources) {
        const conflicting = claims.find(
          (claim) =>
            claimOverlaps(claim, resource, resource.access) &&
            !(
              claim.holder?.agent_id === node.assignee.agent_id &&
              claim.holder?.session_id === node.assignee.session_id
            ),
        );
        if (conflicting !== undefined) {
          add(
            'resource_claim_conflict',
            `active claim ${conflicting.claim_id} on ${resource.path} is held by another holder`,
          );
        }
        for (const other of plan.nodes) {
          if (other.node_id === node.node_id) continue;
          if (
            dependsOn(node.node_id, other.node_id) ||
            dependsOn(other.node_id, node.node_id)
          )
            continue;
          const otherEnded =
            other.node_id !== node.node_id && executionEndedFor(other);
          if (otherEnded) continue;
          const overlapping = other.resources.some(
            (candidate) =>
              (candidate.access === 'write' || resource.access === 'write') &&
              overlap(candidate.path, resource.path),
          );
          if (overlapping) {
            add(
              'resource_overlap',
              `scope overlaps concurrently planned node ${other.node_id}`,
            );
          }
        }
      }
    }

    const acceptance = ownState === 'completed' ? acceptanceOf(node) : null;
    let status: WorkNodeStatus;
    if (blockers.length > 0) status = 'blocked';
    else if (ownState === 'completed') {
      status =
        acceptance?.accepted === true ? 'accepted' : 'awaiting_acceptance';
    } else if (ownState === null) status = 'ready';
    else if (
      ownState === 'assigned' ||
      ownState === 'accepted' ||
      ownState === 'running'
    )
      status = 'running';
    else status = 'blocked';

    const firstBlocker = blockers[0];
    const evaluation: WorkNodeEvaluation = {
      node_id: node.node_id,
      role: node.role,
      status,
      blockers,
      recovery:
        firstBlocker !== undefined
          ? (RECOVERY.get(firstBlocker.code) ?? null)
          : acceptance !== null && acceptance.blocker !== null
            ? (RECOVERY.get(acceptance.blocker.code) ?? null)
            : null,
    };
    memo.set(node.node_id, evaluation);
    return evaluation;
  };

  const nodes = plan.nodes.map((node) => evaluateNode(node.node_id));
  const ids = (status: WorkNodeStatus): string[] =>
    nodes.filter((node) => node.status === status).map((node) => node.node_id);

  return {
    schema: WORK_PLAN_EVALUATION_SCHEMA,
    ok: true,
    plan_id: plan.plan_id,
    task_id: plan.task_id,
    owner_epoch: plan.owner_epoch,
    nodes,
    ready_nodes: ids('ready'),
    running_nodes: ids('running'),
    awaiting_acceptance_nodes: ids('awaiting_acceptance'),
    accepted_nodes: ids('accepted'),
    blocked_nodes: ids('blocked'),
    limits: [...limits],
  };
}
