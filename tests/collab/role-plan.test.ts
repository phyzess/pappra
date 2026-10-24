import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMessage, contentDigest } from '../../src/collab/envelope.js';
import {
  WORK_PLAN_EVALUATION_SCHEMA,
  evaluateWorkPlan,
  validateWorkPlan,
  type WorkNodeEvaluation,
  type WorkNodeStatus,
  type WorkPlanEvaluation,
  type WorkPlanRefusal,
} from '../../src/collab/work-plan.js';
import {
  COLLAB_ROLE_PLAN_SCHEMA,
  aggregateRolePlan,
  expandRolePlan,
  type RolePlanRequest,
  type RolePlanSuccess,
} from '../../src/app/collab-role-plan.js';
import type {
  AppliedMessage,
  Identity,
  TaskRecord,
} from '../../src/collab/types.js';

const INPUT_REVISION = `sha256:${'a'.repeat(64)}`;
const COORDINATOR: Identity = {
  agent_id: 'coordinator',
  session_id: 'coordinator-session',
  harness: 'pi',
};
const WRITER_A: Identity = {
  agent_id: 'writer-a',
  session_id: 'writer-a-session',
  harness: 'codex',
};
const WRITER_B: Identity = {
  agent_id: 'writer-b',
  session_id: 'writer-b-session',
  harness: 'claude',
};
const REVIEWER: Identity = {
  agent_id: 'reviewer',
  session_id: 'reviewer-session',
  harness: 'pi',
};

function request(): RolePlanRequest {
  return {
    schema: COLLAB_ROLE_PLAN_SCHEMA,
    plan_id: 'plan-multi-role',
    task_id: 'task-multi-role',
    owner_epoch: 1,
    participants: [
      {
        participant_id: 'writer-a',
        role: 'writer',
        assignee: WRITER_A,
      },
      {
        participant_id: 'writer-b',
        role: 'writer',
        assignee: WRITER_B,
      },
      {
        participant_id: 'reviewer',
        role: 'reviewer',
        assignee: REVIEWER,
      },
    ],
    assignments: [
      {
        node_id: 'write-a',
        role: 'writer',
        assignment_id: 'assignment-a',
        attempt: 1,
        input_revision: INPUT_REVISION,
        participant_id: 'writer-a',
        resources: [{ path: '/repo/src/alpha.ts', access: 'write' }],
      },
      {
        node_id: 'write-b',
        role: 'writer',
        assignment_id: 'assignment-b',
        attempt: 1,
        input_revision: INPUT_REVISION,
        participant_id: 'writer-b',
        resources: [{ path: '/repo/src/beta.ts', access: 'write' }],
      },
      {
        node_id: 'review',
        role: 'reviewer',
        assignment_id: 'assignment-review',
        attempt: 1,
        input_revision: INPUT_REVISION,
        participant_id: 'reviewer',
        resources: [{ path: '/repo/src', access: 'read' }],
      },
    ],
  };
}

function expanded(value = request()): RolePlanSuccess {
  const result = expandRolePlan(value);
  if (result.ok === false) assert.fail(JSON.stringify(result));
  return result;
}

function withPlanner(): RolePlanRequest {
  const base = request();
  return {
    ...base,
    participants: [
      ...base.participants,
      {
        participant_id: 'planner',
        role: 'planner',
        assignee: { agent_id: 'planner', session_id: 'planner-session' },
      },
    ],
    assignments: [
      ...base.assignments,
      {
        node_id: 'plan',
        role: 'planner',
        assignment_id: 'assignment-plan',
        attempt: 1,
        input_revision: INPUT_REVISION,
        participant_id: 'planner',
        resources: [{ path: '/repo/plan.json', access: 'write' }],
      },
    ],
  };
}

test('optional planner runs before independent writers and review remains gated by all writers', () => {
  const expansion = expanded(withPlanner());
  assert.equal(expansion.roles.planner_node_id, 'plan');
  const nodes = expansion.plan.nodes;
  assert.deepEqual(
    nodes.find((node) => node.node_id === 'plan')!.depends_on,
    [],
  );
  for (const id of expansion.roles.writer_node_ids)
    assert.deepEqual(nodes.find((node) => node.node_id === id)!.depends_on, [
      'plan',
    ]);
  assert.deepEqual(
    nodes.find((node) => node.role === 'reviewer')!.depends_on,
    expansion.roles.writer_node_ids,
  );
});

test('planner acceptance participates in aggregation and missing planning work is never accepted', () => {
  const expansion = expanded(withPlanner());
  const accepted = Object.fromEntries(
    expansion.plan.nodes.map((node) => [node.node_id, { status: 'accepted' }]),
  );
  assert.equal(
    aggregateRolePlan(expansion, evaluationSnapshot(expansion, accepted))
      .outcome,
    'accepted',
  );
  assert.equal(
    aggregateRolePlan(
      expansion,
      evaluationSnapshot(expansion, accepted, ['plan']),
    ).outcome,
    'missing',
  );
  assert.equal(
    aggregateRolePlan(
      expansion,
      evaluationSnapshot(expansion, { ...accepted, plan: { status: 'ready' } }),
    ).outcome,
    'pending',
  );
});

test('multiple planners or a planner sharing an execution identity are refused', () => {
  const input = withPlanner();
  assert.equal(
    expandRolePlan({
      ...input,
      assignments: [
        ...input.assignments,
        {
          ...input.assignments.at(-1)!,
          node_id: 'plan-two',
          assignment_id: 'plan-two',
        },
      ],
    }).ok,
    false,
  );
  assert.equal(
    expandRolePlan({
      ...input,
      participants: input.participants.map((participant) =>
        participant.role === 'planner'
          ? { ...participant, assignee: WRITER_A }
          : participant,
      ),
    }).ok,
    false,
  );
});

function evaluationSnapshot(
  expansion: ReturnType<typeof expanded>,
  values: Readonly<
    Record<
      string,
      { readonly status: string; readonly blockers?: readonly string[] }
    >
  >,
  omitted: readonly string[] = [],
): WorkPlanEvaluation {
  const nodes: WorkNodeEvaluation[] = expansion.plan.nodes
    .filter((node) => !omitted.includes(node.node_id))
    .map((node) => {
      const value = values[node.node_id] ?? { status: 'ready' };
      return {
        node_id: node.node_id,
        role: node.role,
        status: value.status as WorkNodeStatus,
        blockers: (value.blockers ?? []).map((code) => ({
          code,
          detail: code,
        })),
        recovery: null,
      };
    });
  const ids = (status: WorkNodeStatus) =>
    nodes.filter((node) => node.status === status).map((node) => node.node_id);
  return {
    schema: WORK_PLAN_EVALUATION_SCHEMA,
    ok: true,
    plan_id: expansion.plan.plan_id,
    task_id: expansion.plan.task_id,
    owner_epoch: expansion.plan.owner_epoch,
    nodes,
    ready_nodes: ids('ready'),
    running_nodes: ids('running'),
    awaiting_acceptance_nodes: ids('awaiting_acceptance'),
    accepted_nodes: ids('accepted'),
    blocked_nodes: ids('blocked'),
    limits: [],
  };
}

function appliedEntry(
  message: ReturnType<typeof buildMessage>,
): AppliedMessage {
  return {
    message_id: message.message_id,
    type: message.type,
    subtask_id: message.subtask_id,
    attempt: message.attempt,
    from: message.from,
    to: message.to,
    reply_to: message.reply_to,
    owner_epoch: message.owner_epoch,
    content_digest: contentDigest(message),
    at: message.created_at,
    applied_at: message.created_at,
    state: 'applied',
    detail: 'role-plan test fixture',
    body_kind: message.type,
  };
}

function evaluateWithWriterAcceptance(
  expansion: ReturnType<typeof expanded>,
  accepted: boolean,
): WorkPlanEvaluation | WorkPlanRefusal {
  const reports = new Map<string, ReturnType<typeof buildMessage>>();
  const messages: ReturnType<typeof buildMessage>[] = [];
  const record: TaskRecord = {
    schema: 'pappra/collab-task-record/1',
    task_id: expansion.plan.task_id,
    domain_id: 'domain',
    domain_root: '/repo',
    task_root: '/repo/.pappra/tasks/task-multi-role',
    created_at: '2026-10-23T00:00:00.000Z',
    updated_at: '2026-10-23T00:00:00.000Z',
    state_revision: 1,
    coordinator: {
      ...COORDINATOR,
      owner_epoch: expansion.plan.owner_epoch,
      since: '2026-10-23T00:00:00.000Z',
    },
    input_revision: INPUT_REVISION,
    policy: {},
    attempts: [],
    messages: [],
    claims: [],
    handoffs: [],
    uncertainty: [],
    results: [],
    native: [],
  };

  for (const node of expansion.plan.nodes.filter(
    (entry) => entry.role === 'writer',
  )) {
    const assignee: Identity = {
      agent_id: node.assignee.agent_id,
      session_id: node.assignee.session_id,
      harness: 'worker',
    };
    const report = buildMessage({
      message_id: `report-${node.assignment_id}`,
      type: 'REPORT',
      task_id: expansion.plan.task_id,
      from: assignee,
      to: COORDINATOR,
      subtask_id: node.assignment_id,
      attempt: node.attempt,
      owner_epoch: expansion.plan.owner_epoch,
      body: {
        status: 'completed',
        input_revision: node.input_revision,
      },
    });
    reports.set(node.node_id, report);
    record.messages.push(appliedEntry(report));
    record.attempts.push({
      subtask_id: node.assignment_id,
      attempt: node.attempt,
      state: 'completed',
      owner_epoch: expansion.plan.owner_epoch,
      assignee,
      assignment_message_id: `assignment-${node.assignment_id}`,
      assignment_ref: null,
      assignment_digest: null,
      input_revision: node.input_revision,
      created_at: report.created_at,
      updated_at: report.created_at,
      native: {
        runner: null,
        session_id: null,
        run_id: null,
        mission_id: null,
        observation: 'not_observed',
        observed_at: null,
        evidence_ref: null,
      },
      approval: null,
      transitions: [],
    });
    record.results.push({
      schema: 'pappra/collab-result/1',
      subtask_id: node.assignment_id,
      attempt: node.attempt,
      status: 'completed',
      message_id: report.message_id,
      input_revision: node.input_revision,
      outputs: [],
      native_ref: null,
      recorded_at: report.created_at,
      evidence_ref: null,
      classification: 'applied',
      reason: null,
    });
  }

  if (accepted) {
    for (const node of expansion.plan.nodes.filter(
      (entry) => entry.role === 'writer',
    )) {
      const report = reports.get(node.node_id)!;
      const answer = buildMessage({
        message_id: `answer-${node.assignment_id}`,
        type: 'ANSWER',
        task_id: expansion.plan.task_id,
        from: COORDINATOR,
        to: {
          agent_id: node.assignee.agent_id,
          session_id: node.assignee.session_id,
          harness: 'worker',
        },
        reply_to: report.message_id,
        subtask_id: node.assignment_id,
        attempt: node.attempt,
        owner_epoch: expansion.plan.owner_epoch,
        body: {
          acceptance: {
            plan_id: expansion.plan.plan_id,
            node_id: node.node_id,
            assignment_id: node.assignment_id,
            attempt: node.attempt,
            input_revision: node.input_revision,
            report_digest: contentDigest(report),
            decision: 'accepted',
          },
        },
      });
      record.messages.push(appliedEntry(answer));
      messages.push(answer);
    }
  }

  const result = evaluateWorkPlan({
    plan: expansion.plan,
    record,
    messages,
  });
  return result;
}

test('expands disjoint writers and a reviewer into the existing WorkPlan graph', () => {
  const result = expanded();
  assert.equal(result.plan.nodes.length, 3);
  assert.equal(validateWorkPlan(result.plan).ok, true);
  assert.deepEqual(result.roles.writer_node_ids, ['write-a', 'write-b']);
  assert.equal(result.roles.reviewer_node_id, 'review');

  const writers = result.plan.nodes.filter((node) => node.role === 'writer');
  const reviewer = result.plan.nodes.find((node) => node.role === 'reviewer');
  assert.ok(reviewer);
  assert.deepEqual(
    writers.map((node) => node.depends_on),
    [[], []],
  );
  assert.deepEqual(reviewer.depends_on, ['write-a', 'write-b']);
  assert.deepEqual(
    writers.map((node) => node.resources[0]?.path),
    ['/repo/src/alpha.ts', '/repo/src/beta.ts'],
  );
  assert.deepEqual(
    result.plan.nodes.map((node) => node.assignment_id),
    ['assignment-a', 'assignment-b', 'assignment-review'],
  );
});

test('rejects conflicting writer scopes and missing explicit roles or resources', () => {
  const base = request();
  const conflict = {
    ...base,
    participants: base.participants.filter(
      (participant) => participant.participant_id !== 'writer-b',
    ),
    assignments: base.assignments.map((assignment) =>
      assignment.node_id === 'write-b'
        ? {
            ...assignment,
            participant_id: 'writer-a',
            resources: [
              { path: '/repo/src/alpha.ts/nested', access: 'write' as const },
            ],
          }
        : assignment,
    ),
  };
  const conflictResult = expandRolePlan(conflict);
  assert.equal(conflictResult.ok, false);
  const writerConflict = conflictResult.diagnostics.find(
    (entry) => entry.code === 'writer_resource_conflict',
  );
  assert.match(writerConflict?.detail ?? '', /participant writer-a/);

  const missingReviewer = {
    ...base,
    assignments: base.assignments.filter(
      (assignment) => assignment.role === 'writer',
    ),
  };
  const roleResult = expandRolePlan(missingReviewer);
  assert.equal(roleResult.ok, false);
  assert.ok(
    roleResult.diagnostics.some(
      (entry) =>
        entry.code === 'role_missing' && entry.detail.includes('reviewer'),
    ),
  );

  const missingResources = {
    ...base,
    assignments: base.assignments.map((assignment) =>
      assignment.node_id === 'write-a'
        ? { ...assignment, resources: [] }
        : assignment,
    ),
  };
  const resourceResult = expandRolePlan(missingResources);
  assert.equal(resourceResult.ok, false);
  assert.ok(
    resourceResult.diagnostics.some(
      (entry) => entry.code === 'resources_required',
    ),
  );
});

test('requires at least one explicitly assigned writer', () => {
  const base = request();
  const reviewerOnly = {
    ...base,
    participants: base.participants.filter(
      (participant) => participant.role === 'reviewer',
    ),
    assignments: base.assignments.filter(
      (assignment) => assignment.role === 'reviewer',
    ),
  };
  const result = expandRolePlan(reviewerOnly);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (entry) =>
        entry.code === 'role_missing' && entry.detail.includes('writer'),
    ),
  );
});

test('requires a reviewer identity distinct from every writer', () => {
  const base = request();
  const sameIdentity = {
    ...base,
    participants: base.participants.map((participant) =>
      participant.participant_id === 'reviewer'
        ? { ...participant, assignee: WRITER_A }
        : participant,
    ),
  };
  const result = expandRolePlan(sameIdentity);
  assert.equal(result.ok, false);
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.code === 'reviewer_writer_identity_conflict',
    ),
  );
});

test('the existing evaluator keeps reviewer work behind completed accepted writers', () => {
  const result = expanded();
  const awaiting = evaluateWithWriterAcceptance(result, false);
  assert.equal(awaiting.ok, true, JSON.stringify(awaiting));
  if (!awaiting.ok) return;
  assert.deepEqual(awaiting.awaiting_acceptance_nodes, ['write-a', 'write-b']);
  const blockedReviewer = awaiting.nodes.find(
    (node) => node.node_id === 'review',
  );
  assert.equal(blockedReviewer?.status, 'blocked');
  assert.ok(
    blockedReviewer?.blockers.some(
      (blocker) => blocker.code === 'acceptance_missing',
    ),
  );

  const accepted = evaluateWithWriterAcceptance(result, true);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  if (!accepted.ok) return;
  assert.deepEqual(accepted.accepted_nodes, ['write-a', 'write-b']);
  assert.equal(
    accepted.nodes.find((node) => node.node_id === 'review')?.status,
    'ready',
  );
});

test('aggregation retains rejection, unknown and missing nodes without delivery-based success', () => {
  const result = expanded();
  const evaluation = evaluationSnapshot(
    result,
    {
      'write-a': { status: 'blocked', blockers: ['acceptance_rejected'] },
      'write-b': { status: 'not-a-work-plan-status' },
    },
    ['review'],
  );
  const aggregate = aggregateRolePlan(result, evaluation);
  assert.equal(aggregate.outcome, 'rejected');
  assert.deepEqual(aggregate.rejected_nodes, ['write-a']);
  assert.deepEqual(aggregate.unknown_nodes, ['write-b']);
  assert.deepEqual(aggregate.missing_nodes, ['review']);
  assert.equal(
    aggregate.nodes.find((node) => node.node_id === 'write-b')
      ?.work_plan_status,
    'not-a-work-plan-status',
  );

  const deliveredButNotAccepted = {
    ...evaluationSnapshot(result, {
      'write-a': { status: 'accepted' },
      'write-b': { status: 'accepted' },
      review: { status: 'awaiting_acceptance' },
    }),
    delivery: { status: 'submitted' },
  } as WorkPlanEvaluation & { readonly delivery: { readonly status: string } };
  const pending = aggregateRolePlan(result, deliveredButNotAccepted);
  assert.equal(pending.outcome, 'pending');
  assert.deepEqual(pending.accepted_nodes, ['write-a', 'write-b']);
  assert.deepEqual(pending.pending_nodes, ['review']);
});

test('an evaluation refusal remains unknown rather than becoming success or missing work', () => {
  const result = expanded();
  const aggregate = aggregateRolePlan(result, {
    ok: false,
    diagnostics: [
      {
        code: 'record_invalid',
        node_id: null,
        detail: 'the authoritative record could not be evaluated',
      },
    ],
  });
  assert.equal(aggregate.outcome, 'unknown');
  assert.deepEqual(aggregate.unknown_nodes, ['write-a', 'write-b', 'review']);
  assert.deepEqual(aggregate.missing_nodes, []);
  assert.ok(
    aggregate.diagnostics.some((entry) => entry.code === 'record_invalid'),
  );
});
