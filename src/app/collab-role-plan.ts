import { object as isRecord } from '../infra/validation.js';
import { pathRelation } from '../collab/canonical.js';
import {
  WORK_PLAN_EVALUATION_SCHEMA,
  WORK_PLAN_SCHEMA,
  validateWorkPlan,
  type WorkNodeStatus,
  type WorkPlan,
  type WorkPlanDiagnostic,
  type WorkPlanEvaluation,
  type WorkPlanNode,
  type WorkPlanRefusal,
  type WorkPlanResource,
} from '../collab/work-plan.js';

export const COLLAB_ROLE_PLAN_SCHEMA = 'pappra/collab-role-plan/1';
export const COLLAB_ROLE_PLAN_AGGREGATION_SCHEMA =
  'pappra/collab-role-plan-aggregation/1';

const MAX_NODES = 64;
const MAX_PARTICIPANTS = 64;
const MAX_RESOURCES = 16;
const MAX_STRING = 512;
const UNCERTAIN_BLOCKERS = new Set([
  'acceptance_envelope_missing',
  'acceptance_untrusted',
  'own_uncertain',
  'uncertainty_open',
]);

export type RolePlanRole = 'planner' | 'writer' | 'reviewer';

export interface RolePlanParticipant {
  readonly participant_id: string;
  readonly role: RolePlanRole;
  readonly assignee: WorkPlanNode['assignee'];
}

/** All assignment pins and resource scopes are caller supplied; none are inferred. */
export interface RolePlanAssignment {
  readonly node_id: string;
  readonly role: RolePlanRole;
  readonly assignment_id: string;
  readonly attempt: number;
  readonly input_revision: string;
  readonly participant_id: string;
  readonly resources: readonly WorkPlanResource[];
}

export interface RolePlanRequest {
  readonly schema: typeof COLLAB_ROLE_PLAN_SCHEMA;
  readonly plan_id: string;
  readonly task_id: string;
  readonly owner_epoch: number;
  readonly participants: readonly RolePlanParticipant[];
  readonly assignments: readonly RolePlanAssignment[];
}

export interface RolePlanDiagnostic {
  readonly code: string;
  readonly node_id: string | null;
  readonly detail: string;
}

export interface RolePlanSuccess {
  readonly schema: typeof COLLAB_ROLE_PLAN_SCHEMA;
  readonly ok: true;
  readonly plan: WorkPlan;
  readonly roles: {
    readonly planner_node_id?: string;
    readonly writer_node_ids: readonly string[];
    readonly reviewer_node_id: string;
  };
}

export interface RolePlanRefusal {
  readonly schema: typeof COLLAB_ROLE_PLAN_SCHEMA;
  readonly ok: false;
  readonly diagnostics: readonly RolePlanDiagnostic[];
}

export type RolePlanExpansion = RolePlanSuccess | RolePlanRefusal;

export type RolePlanNodeOutcome =
  'accepted' | 'rejected' | 'unknown' | 'missing' | 'pending' | 'blocked';

export interface RolePlanNodeAggregation {
  readonly node_id: string;
  readonly role: RolePlanRole;
  readonly outcome: RolePlanNodeOutcome;
  /** The status observed in the existing evaluation, retained even when unknown. */
  readonly work_plan_status: string | null;
  readonly blockers: readonly string[];
}

export interface RolePlanAggregation {
  readonly schema: typeof COLLAB_ROLE_PLAN_AGGREGATION_SCHEMA;
  readonly plan_id: string;
  readonly outcome: RolePlanNodeOutcome;
  readonly nodes: readonly RolePlanNodeAggregation[];
  readonly accepted_nodes: readonly string[];
  readonly rejected_nodes: readonly string[];
  readonly unknown_nodes: readonly string[];
  readonly missing_nodes: readonly string[];
  readonly pending_nodes: readonly string[];
  readonly blocked_nodes: readonly string[];
  readonly diagnostics: readonly RolePlanDiagnostic[];
}

interface ParsedAssignment extends RolePlanAssignment {}

const isBoundedString = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_STRING &&
  !value.includes('\u0000');

const isRole = (value: unknown): value is RolePlanRole =>
  value === 'planner' || value === 'writer' || value === 'reviewer';

const isIdentity = (value: unknown): value is WorkPlanNode['assignee'] =>
  isRecord(value) &&
  isBoundedString(value['agent_id']) &&
  isBoundedString(value['session_id']);

function roleDiagnostic(
  code: string,
  detail: string,
  nodeId: string | null = null,
): RolePlanDiagnostic {
  return { code, node_id: nodeId, detail };
}

function refusal(diagnostics: readonly RolePlanDiagnostic[]): RolePlanRefusal {
  return {
    schema: COLLAB_ROLE_PLAN_SCHEMA,
    ok: false,
    diagnostics,
  };
}

function projectWorkPlanDiagnostics(
  diagnostics: readonly WorkPlanDiagnostic[],
): RolePlanDiagnostic[] {
  return diagnostics.map(({ code, node_id, detail }) => ({
    code,
    node_id,
    detail,
  }));
}

function readResources(
  value: unknown,
  nodeId: string,
  diagnostics: RolePlanDiagnostic[],
): WorkPlanResource[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push(
      roleDiagnostic(
        'resources_required',
        'each assignment needs an explicit non-empty resource list',
        nodeId,
      ),
    );
    return null;
  }
  if (value.length > MAX_RESOURCES) {
    diagnostics.push(
      roleDiagnostic(
        'resource_limit',
        `an assignment may declare at most ${MAX_RESOURCES} resources`,
        nodeId,
      ),
    );
    return null;
  }

  const resources: WorkPlanResource[] = [];
  for (const [index, resource] of value.entries()) {
    if (
      !isRecord(resource) ||
      !isBoundedString(resource['path']) ||
      (resource['access'] !== 'read' && resource['access'] !== 'write')
    ) {
      diagnostics.push(
        roleDiagnostic(
          'resource_invalid',
          `resource ${index} needs a bounded absolute path and read/write access`,
          nodeId,
        ),
      );
      return null;
    }
    resources.push({
      path: resource['path'],
      access: resource['access'],
    });
  }
  return resources;
}

/**
 * Expands an explicit role request into the existing dependency-aware WorkPlan.
 * An optional planner precedes independent writers. The reviewer depends on every writer, so the existing
 * evaluator—not this planner—requires each predecessor's current coordinator acceptance.
 */
export function expandRolePlan(input: RolePlanRequest): RolePlanExpansion {
  const raw: unknown = input;
  if (!isRecord(raw))
    return refusal([
      roleDiagnostic('request_invalid', 'request must be an object'),
    ]);

  const diagnostics: RolePlanDiagnostic[] = [];
  if (raw['schema'] !== COLLAB_ROLE_PLAN_SCHEMA)
    diagnostics.push(
      roleDiagnostic(
        'request_schema_invalid',
        `schema must be ${COLLAB_ROLE_PLAN_SCHEMA}`,
      ),
    );
  const planId = raw['plan_id'];
  const taskId = raw['task_id'];
  const ownerEpoch = raw['owner_epoch'];
  if (!isBoundedString(planId) || !isBoundedString(taskId))
    diagnostics.push(
      roleDiagnostic(
        'request_invalid',
        'plan_id and task_id are required bounded strings',
      ),
    );
  if (
    typeof ownerEpoch !== 'number' ||
    !Number.isSafeInteger(ownerEpoch) ||
    ownerEpoch < 1
  )
    diagnostics.push(
      roleDiagnostic(
        'request_invalid',
        'owner_epoch must be a positive integer',
      ),
    );

  const rawParticipants = raw['participants'];
  if (!Array.isArray(rawParticipants) || rawParticipants.length === 0) {
    diagnostics.push(
      roleDiagnostic(
        'participants_required',
        'declare the plan participants explicitly',
      ),
    );
    return refusal(diagnostics);
  }
  if (rawParticipants.length > MAX_PARTICIPANTS) {
    diagnostics.push(
      roleDiagnostic(
        'participant_limit',
        `at most ${MAX_PARTICIPANTS} participants are supported`,
      ),
    );
    return refusal(diagnostics);
  }

  const participants = new Map<string, RolePlanParticipant>();
  for (const [index, rawParticipant] of rawParticipants.entries()) {
    if (!isRecord(rawParticipant)) {
      diagnostics.push(
        roleDiagnostic(
          'participant_invalid',
          `participant ${index} must be an object`,
        ),
      );
      continue;
    }
    const participantId = rawParticipant['participant_id'];
    const role = rawParticipant['role'];
    const assignee = rawParticipant['assignee'];
    if (
      !isBoundedString(participantId) ||
      !isRole(role) ||
      !isIdentity(assignee)
    ) {
      diagnostics.push(
        roleDiagnostic(
          'participant_invalid',
          `participant ${index} needs an id, planner/writer/reviewer role, and explicit assignee identity`,
        ),
      );
      continue;
    }
    if (participants.has(participantId)) {
      diagnostics.push(
        roleDiagnostic(
          'duplicate_participant_id',
          `participant id is repeated: ${participantId}`,
        ),
      );
      continue;
    }
    participants.set(participantId, {
      participant_id: participantId,
      role,
      assignee: {
        agent_id: assignee['agent_id'],
        session_id: assignee['session_id'],
      },
    });
  }

  const rawAssignments = raw['assignments'];
  if (!Array.isArray(rawAssignments) || rawAssignments.length === 0) {
    diagnostics.push(
      roleDiagnostic(
        'assignments_required',
        'declare writer and reviewer assignments explicitly',
      ),
    );
    return refusal(diagnostics);
  }
  if (rawAssignments.length > MAX_NODES) {
    diagnostics.push(
      roleDiagnostic(
        'plan_too_large',
        `at most ${MAX_NODES} role assignments are supported`,
      ),
    );
    return refusal(diagnostics);
  }

  const assignments: ParsedAssignment[] = [];
  for (const [index, rawAssignment] of rawAssignments.entries()) {
    if (!isRecord(rawAssignment)) {
      diagnostics.push(
        roleDiagnostic(
          'assignment_invalid',
          `assignment ${index} must be an object`,
        ),
      );
      continue;
    }
    const nodeId = rawAssignment['node_id'];
    const role = rawAssignment['role'];
    const assignmentId = rawAssignment['assignment_id'];
    const attempt = rawAssignment['attempt'];
    const inputRevision = rawAssignment['input_revision'];
    const participantId = rawAssignment['participant_id'];
    if (
      !isBoundedString(nodeId) ||
      !isRole(role) ||
      !isBoundedString(assignmentId) ||
      typeof attempt !== 'number' ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      attempt > 1000 ||
      !isBoundedString(inputRevision) ||
      !isBoundedString(participantId)
    ) {
      diagnostics.push(
        roleDiagnostic(
          'assignment_invalid',
          `assignment ${index} needs node, role, assignment, attempt, input revision, and participant pins`,
          isBoundedString(nodeId) ? nodeId : null,
        ),
      );
      continue;
    }
    const resources = readResources(
      rawAssignment['resources'],
      nodeId,
      diagnostics,
    );
    if (resources === null) continue;
    assignments.push({
      node_id: nodeId,
      role,
      assignment_id: assignmentId,
      attempt,
      input_revision: inputRevision,
      participant_id: participantId,
      resources,
    });
  }

  const usedParticipants = new Set<string>();
  for (const assignment of assignments) {
    const participant = participants.get(assignment.participant_id);
    if (participant === undefined) {
      diagnostics.push(
        roleDiagnostic(
          'participant_missing',
          `assignment references undeclared participant ${assignment.participant_id}`,
          assignment.node_id,
        ),
      );
    } else if (participant.role !== assignment.role) {
      diagnostics.push(
        roleDiagnostic(
          'participant_role_mismatch',
          `assignment role ${assignment.role} does not match participant role ${participant.role}`,
          assignment.node_id,
        ),
      );
    } else {
      usedParticipants.add(participant.participant_id);
    }
  }
  for (const participantId of participants.keys()) {
    if (!usedParticipants.has(participantId))
      diagnostics.push(
        roleDiagnostic(
          'participant_unassigned',
          `declared participant ${participantId} has no matching assignment`,
        ),
      );
  }

  const writers = assignments
    .filter((assignment) => assignment.role === 'writer')
    .sort((left, right) => left.node_id.localeCompare(right.node_id));
  const reviewers = assignments.filter(
    (assignment) => assignment.role === 'reviewer',
  );
  const planners = assignments.filter(
    (assignment) => assignment.role === 'planner',
  );
  if (planners.length > 1)
    diagnostics.push(
      roleDiagnostic(
        'planner_assignment_conflict',
        'at most one planner assignment is supported',
      ),
    );
  const planner = planners[0];
  if (planner) {
    const identity = participants.get(planner.participant_id)?.assignee;
    for (const assignment of [...writers, ...reviewers]) {
      const other = participants.get(assignment.participant_id)?.assignee;
      if (
        identity &&
        other &&
        identity.agent_id === other.agent_id &&
        identity.session_id === other.session_id
      )
        diagnostics.push(
          roleDiagnostic(
            'planner_identity_conflict',
            'planner requires a distinct agent/session identity',
            planner.node_id,
          ),
        );
    }
  }
  if (writers.length === 0)
    diagnostics.push(
      roleDiagnostic(
        'role_missing',
        'at least one writer assignment is required',
      ),
    );
  if (reviewers.length === 0)
    diagnostics.push(
      roleDiagnostic('role_missing', 'one reviewer assignment is required'),
    );
  if (reviewers.length > 1)
    diagnostics.push(
      roleDiagnostic(
        'reviewer_assignment_conflict',
        'the role plan supports exactly one reviewer assignment',
      ),
    );

  const assignmentIds = new Set<string>();
  for (const assignment of assignments) {
    if (assignmentIds.has(assignment.assignment_id))
      diagnostics.push(
        roleDiagnostic(
          'duplicate_assignment_id',
          `assignment id is repeated: ${assignment.assignment_id}`,
          assignment.node_id,
        ),
      );
    assignmentIds.add(assignment.assignment_id);
  }

  for (let leftIndex = 0; leftIndex < writers.length; leftIndex += 1) {
    const left = writers[leftIndex]!;
    for (const right of writers.slice(leftIndex + 1)) {
      const conflict = left.resources.some((leftResource) =>
        right.resources.some(
          (rightResource) =>
            (leftResource.access === 'write' ||
              rightResource.access === 'write') &&
            pathRelation(leftResource.path, rightResource.path) !== 'disjoint',
        ),
      );
      if (conflict)
        diagnostics.push(
          roleDiagnostic(
            'writer_resource_conflict',
            `writer scopes overlap between ${left.node_id} and ${right.node_id}${left.participant_id === right.participant_id ? ` for participant ${left.participant_id}` : ''}; independent writer work must be disjoint and is not implicitly serialized`,
            right.node_id,
          ),
        );
    }
  }

  const reviewerCandidate = reviewers[0];
  if (reviewerCandidate !== undefined) {
    const reviewerParticipant = participants.get(
      reviewerCandidate.participant_id,
    );
    if (reviewerParticipant !== undefined) {
      for (const writer of writers) {
        const writerParticipant = participants.get(writer.participant_id);
        if (
          writerParticipant !== undefined &&
          writerParticipant.assignee.agent_id ===
            reviewerParticipant.assignee.agent_id &&
          writerParticipant.assignee.session_id ===
            reviewerParticipant.assignee.session_id
        )
          diagnostics.push(
            roleDiagnostic(
              'reviewer_writer_identity_conflict',
              'reviewer must use a different agent/session identity from every writer',
              reviewerCandidate.node_id,
            ),
          );
      }
    }
  }
  if (diagnostics.length > 0) return refusal(diagnostics);

  const reviewer = reviewers[0]!;
  const rawPlan = {
    schema: WORK_PLAN_SCHEMA,
    plan_id: planId as string,
    task_id: taskId as string,
    owner_epoch: ownerEpoch as number,
    nodes: [
      ...(planner
        ? [
            {
              node_id: planner.node_id,
              role: planner.role,
              assignment_id: planner.assignment_id,
              attempt: planner.attempt,
              input_revision: planner.input_revision,
              assignee: participants.get(planner.participant_id)!.assignee,
              depends_on: [],
              resources: planner.resources,
            },
          ]
        : []),
      ...writers.map((assignment) => {
        const participant = participants.get(assignment.participant_id)!;
        return {
          node_id: assignment.node_id,
          role: assignment.role,
          assignment_id: assignment.assignment_id,
          attempt: assignment.attempt,
          input_revision: assignment.input_revision,
          assignee: participant.assignee,
          depends_on: planner ? [planner.node_id] : [],
          resources: assignment.resources,
        };
      }),
      {
        node_id: reviewer.node_id,
        role: reviewer.role,
        assignment_id: reviewer.assignment_id,
        attempt: reviewer.attempt,
        input_revision: reviewer.input_revision,
        assignee: participants.get(reviewer.participant_id)!.assignee,
        depends_on: writers.map((assignment) => assignment.node_id),
        resources: reviewer.resources,
      },
    ],
  };
  const validated = validateWorkPlan(rawPlan);
  if (!validated.ok)
    return refusal(projectWorkPlanDiagnostics(validated.diagnostics));

  return {
    schema: COLLAB_ROLE_PLAN_SCHEMA,
    ok: true,
    plan: validated.plan,
    roles: {
      ...(planner ? { planner_node_id: planner.node_id } : {}),
      writer_node_ids: writers.map((assignment) => assignment.node_id),
      reviewer_node_id: reviewer.node_id,
    },
  };
}

function isWorkNodeStatus(value: unknown): value is WorkNodeStatus {
  return (
    value === 'ready' ||
    value === 'running' ||
    value === 'awaiting_acceptance' ||
    value === 'accepted' ||
    value === 'blocked'
  );
}

function readBlockerCodes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const codes: string[] = [];
  for (const blocker of value) {
    if (!isRecord(blocker) || !isBoundedString(blocker['code'])) return null;
    codes.push(blocker['code']);
  }
  return codes;
}

function unknownNode(
  nodeId: string,
  role: RolePlanRole,
  status: string | null = null,
  blockers: readonly string[] = [],
): RolePlanNodeAggregation {
  return {
    node_id: nodeId,
    role,
    outcome: 'unknown',
    work_plan_status: status,
    blockers: [...blockers],
  };
}

function classifyNode(
  nodeId: string,
  role: RolePlanRole,
  rawNode: unknown,
): RolePlanNodeAggregation {
  if (!isRecord(rawNode)) return unknownNode(nodeId, role, null);
  const rawStatus = rawNode['status'];
  const status = typeof rawStatus === 'string' ? rawStatus : null;
  const blockers = readBlockerCodes(rawNode['blockers']);
  if (
    rawNode['node_id'] !== nodeId ||
    rawNode['role'] !== role ||
    !isWorkNodeStatus(rawStatus) ||
    blockers === null
  )
    return unknownNode(nodeId, role, status, blockers ?? []);
  const ownAcceptance = rawNode['acceptance_blocker'];
  const ownCode =
    isRecord(ownAcceptance) && typeof ownAcceptance['code'] === 'string'
      ? ownAcceptance['code']
      : null;
  const rejected =
    'acceptance_blocker' in rawNode
      ? ownCode === 'acceptance_rejected'
      : blockers.includes('acceptance_rejected');
  if (rejected)
    return {
      node_id: nodeId,
      role,
      outcome: 'rejected',
      work_plan_status: status,
      blockers,
    };
  if (
    (ownCode !== null && UNCERTAIN_BLOCKERS.has(ownCode)) ||
    blockers.some((code) => UNCERTAIN_BLOCKERS.has(code))
  )
    return {
      node_id: nodeId,
      role,
      outcome: 'unknown',
      work_plan_status: status,
      blockers,
    };
  if (rawStatus === 'accepted')
    return {
      node_id: nodeId,
      role,
      outcome: 'accepted',
      work_plan_status: status,
      blockers,
    };
  if (rawStatus === 'blocked')
    return {
      node_id: nodeId,
      role,
      outcome: 'blocked',
      work_plan_status: status,
      blockers,
    };
  return {
    node_id: nodeId,
    role,
    outcome: 'pending',
    work_plan_status: status,
    blockers,
  };
}

function aggregateOutcome(
  nodes: readonly RolePlanNodeAggregation[],
): RolePlanNodeOutcome {
  if (nodes.some((node) => node.outcome === 'rejected')) return 'rejected';
  if (nodes.some((node) => node.outcome === 'unknown')) return 'unknown';
  if (nodes.some((node) => node.outcome === 'missing')) return 'missing';
  if (nodes.some((node) => node.outcome === 'blocked')) return 'blocked';
  if (nodes.length > 0 && nodes.every((node) => node.outcome === 'accepted'))
    return 'accepted';
  return 'pending';
}

/**
 * Projects the existing read-only WorkPlan evaluation. A role-plan succeeds only when every
 * planned node is already accepted in that evaluation; delivery observations are not inputs.
 */
export function aggregateRolePlan(
  expansion: RolePlanSuccess,
  evaluation: WorkPlanEvaluation | WorkPlanRefusal,
): RolePlanAggregation {
  const diagnostics: RolePlanDiagnostic[] = [];
  const expected = [
    ...(expansion.roles.planner_node_id
      ? [{ nodeId: expansion.roles.planner_node_id, role: 'planner' as const }]
      : []),
    ...expansion.roles.writer_node_ids.map((nodeId) => ({
      nodeId,
      role: 'writer' as const,
    })),
    { nodeId: expansion.roles.reviewer_node_id, role: 'reviewer' as const },
  ];
  const rawEvaluation: unknown = evaluation;
  let nodes: RolePlanNodeAggregation[];

  if (!isRecord(rawEvaluation) || rawEvaluation['ok'] !== true) {
    const refusalValue = isRecord(rawEvaluation) ? rawEvaluation : null;
    const rawDiagnostics = refusalValue?.['diagnostics'];
    if (Array.isArray(rawDiagnostics)) {
      for (const entry of rawDiagnostics) {
        if (isRecord(entry) && isBoundedString(entry['code']))
          diagnostics.push(
            roleDiagnostic(
              entry['code'],
              isBoundedString(entry['detail'])
                ? entry['detail']
                : 'work-plan evaluation was refused',
              isBoundedString(entry['node_id']) ? entry['node_id'] : null,
            ),
          );
      }
    }
    if (diagnostics.length === 0)
      diagnostics.push(
        roleDiagnostic(
          'evaluation_unavailable',
          'work-plan evaluation was refused; node outcomes remain unknown',
        ),
      );
    nodes = expected.map(({ nodeId, role }) => unknownNode(nodeId, role));
  } else {
    const metadataMatches =
      rawEvaluation['schema'] === WORK_PLAN_EVALUATION_SCHEMA &&
      rawEvaluation['plan_id'] === expansion.plan.plan_id &&
      rawEvaluation['task_id'] === expansion.plan.task_id &&
      rawEvaluation['owner_epoch'] === expansion.plan.owner_epoch;
    const rawNodes = rawEvaluation['nodes'];
    if (!metadataMatches) {
      diagnostics.push(
        roleDiagnostic(
          'evaluation_mismatch',
          'evaluation schema, plan id, task id, or owner epoch does not match the expanded plan',
        ),
      );
      nodes = expected.map(({ nodeId, role }) => unknownNode(nodeId, role));
    } else if (!Array.isArray(rawNodes)) {
      diagnostics.push(
        roleDiagnostic(
          'evaluation_invalid',
          'evaluation.nodes must be an array',
        ),
      );
      nodes = expected.map(({ nodeId, role }) => unknownNode(nodeId, role));
    } else {
      const byId = new Map<string, unknown[]>();
      for (const rawNode of rawNodes) {
        const id = isRecord(rawNode) ? rawNode['node_id'] : null;
        if (!isBoundedString(id)) continue;
        const entries = byId.get(id) ?? [];
        entries.push(rawNode);
        byId.set(id, entries);
      }
      const expectedIds = new Set(expected.map((node) => node.nodeId));
      for (const nodeId of byId.keys()) {
        if (!expectedIds.has(nodeId))
          diagnostics.push(
            roleDiagnostic(
              'evaluation_node_unexpected',
              `evaluation contains an unplanned node ${nodeId}`,
              nodeId,
            ),
          );
      }
      nodes = expected.map(({ nodeId, role }) => {
        const entries = byId.get(nodeId) ?? [];
        if (entries.length === 0)
          return {
            node_id: nodeId,
            role,
            outcome: 'missing',
            work_plan_status: null,
            blockers: [],
          };
        if (entries.length > 1) {
          diagnostics.push(
            roleDiagnostic(
              'evaluation_node_ambiguous',
              `evaluation repeats node ${nodeId}; its result is unknown`,
              nodeId,
            ),
          );
          return unknownNode(nodeId, role, null);
        }
        const result = classifyNode(nodeId, role, entries[0]);
        if (result.outcome === 'unknown')
          diagnostics.push(
            roleDiagnostic(
              'evaluation_node_unknown',
              `evaluation result for ${nodeId} is malformed, uncertain, or has an unknown status`,
              nodeId,
            ),
          );
        return result;
      });
    }
  }

  const ids = (outcome: RolePlanNodeOutcome): string[] =>
    nodes
      .filter((node) => node.outcome === outcome)
      .map((node) => node.node_id);
  return {
    schema: COLLAB_ROLE_PLAN_AGGREGATION_SCHEMA,
    plan_id: expansion.plan.plan_id,
    outcome: aggregateOutcome(nodes),
    nodes,
    accepted_nodes: ids('accepted'),
    rejected_nodes: ids('rejected'),
    unknown_nodes: ids('unknown'),
    missing_nodes: ids('missing'),
    pending_nodes: ids('pending'),
    blocked_nodes: ids('blocked'),
    diagnostics,
  };
}
