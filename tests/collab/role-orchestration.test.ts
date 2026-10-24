import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  COLLAB_ROLE_ORCHESTRATION_SCHEMA,
  tickRoleOrchestration,
  type RoleOrchestrationDependencies,
  type RoleOrchestrationRequest,
} from '../../src/app/collab-role-orchestration.js';
import {
  COLLAB_ROLE_PLAN_SCHEMA,
  expandRolePlan,
  type RolePlanRequest,
  type RolePlanSuccess,
} from '../../src/app/collab-role-plan.js';
import type { WorkPlanEvaluation } from '../../src/collab/work-plan.js';
import type { WorkPlanReport } from '../../src/app/collab-work-plan.js';
import type { WorkExecutionReport } from '../../src/app/collab-work-execution.js';

const caller = {
  agent_id: 'coordinator',
  session_id: 'coordinator-session',
  harness: 'pi',
  cwd: '/repo',
};

function rolePlan(): RolePlanRequest {
  const revision = `sha256:${'a'.repeat(64)}`;
  return {
    schema: COLLAB_ROLE_PLAN_SCHEMA,
    plan_id: 'orchestration-plan',
    task_id: 'orchestration-task',
    owner_epoch: 1,
    participants: [
      {
        participant_id: 'writer-a',
        role: 'writer',
        assignee: { agent_id: 'writer-a', session_id: 'writer-a-session' },
      },
      {
        participant_id: 'writer-b',
        role: 'writer',
        assignee: { agent_id: 'writer-b', session_id: 'writer-b-session' },
      },
      {
        participant_id: 'reviewer',
        role: 'reviewer',
        assignee: { agent_id: 'reviewer', session_id: 'reviewer-session' },
      },
    ],
    assignments: [
      {
        node_id: 'write-a',
        role: 'writer',
        assignment_id: 'assignment-a',
        attempt: 1,
        input_revision: revision,
        participant_id: 'writer-a',
        resources: [{ path: '/repo/src/a.ts', access: 'write' }],
      },
      {
        node_id: 'write-b',
        role: 'writer',
        assignment_id: 'assignment-b',
        attempt: 1,
        input_revision: revision,
        participant_id: 'writer-b',
        resources: [{ path: '/repo/src/b.ts', access: 'write' }],
      },
      {
        node_id: 'review',
        role: 'reviewer',
        assignment_id: 'assignment-review',
        attempt: 1,
        input_revision: revision,
        participant_id: 'reviewer',
        resources: [{ path: '/repo/src', access: 'read' }],
      },
    ],
  };
}

function setup(): {
  readonly directory: string;
  readonly request: RoleOrchestrationRequest;
  readonly expansion: RolePlanSuccess;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pappra-roles-'));
  const planFile = path.join(directory, 'work-plan.json');
  const journalFile = path.join(directory, 'role-orchestration.json');
  const role_plan = rolePlan();
  const expanded = expandRolePlan(role_plan);
  assert.equal(expanded.ok, true);
  if (!expanded.ok) assert.fail(JSON.stringify(expanded));
  fs.writeFileSync(planFile, `${JSON.stringify(expanded.plan)}\n`);
  return {
    directory,
    expansion: expanded,
    request: {
      role_plan,
      execution: {
        task_root: directory,
        plan_file: planFile,
        binding_file: path.join(directory, 'binding.json'),
        caller,
        caller_pane: 'pi:p1',
        capability_cards: [
          {
            assignment_id: 'assignment-a',
            capabilities_file: path.join(directory, 'a.json'),
          },
          {
            assignment_id: 'assignment-b',
            capabilities_file: path.join(directory, 'b.json'),
          },
          {
            assignment_id: 'assignment-review',
            capabilities_file: path.join(directory, 'review.json'),
          },
        ],
      },
      event_id: 'session-event-1',
      journal_file: journalFile,
      limits: { max_rounds: 4, max_actions: 4, max_attempts: 3 },
    },
  };
}

function report(
  expansion: RolePlanSuccess,
  planFile: string,
  overrides: Readonly<
    Record<string, { status: string; blockers?: readonly string[] }>
  > = {},
): WorkPlanReport {
  const nodes = expansion.plan.nodes.map((node) => {
    const value = overrides[node.node_id] ?? {
      status: node.role === 'reviewer' ? 'blocked' : 'ready',
      blockers: node.role === 'reviewer' ? ['acceptance_missing'] : [],
    };
    return {
      node_id: node.node_id,
      role: node.role,
      status: value.status as
        'ready' | 'running' | 'awaiting_acceptance' | 'accepted' | 'blocked',
      blockers: (value.blockers ?? []).map((code) => ({ code, detail: code })),
      recovery: null,
    };
  });
  const ids = (status: string) =>
    nodes.filter((node) => node.status === status).map((node) => node.node_id);
  const core: WorkPlanEvaluation = {
    schema: 'pappra/collab-work-plan-evaluation/1',
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
  return {
    schema: 'pappra/collaboration-work-plan-report/1',
    ok: true,
    status: 'evaluated',
    task_root: path.dirname(planFile),
    task_id: expansion.plan.task_id,
    plan: {
      ref: planFile,
      digest: null,
      plan_id: expansion.plan.plan_id,
      owner_epoch: expansion.plan.owner_epoch,
      node_count: expansion.plan.nodes.length,
    },
    stale: false,
    summary: {
      ready: ids('ready').length,
      running: 0,
      awaiting_acceptance: 0,
      accepted: 0,
      blocked: ids('blocked').length,
    },
    nodes: nodes.map((node) => ({
      node_id: node.node_id,
      role: node.role,
      assignment_id: expansion.plan.nodes.find(
        (planned) => planned.node_id === node.node_id,
      )!.assignment_id,
      attempt: expansion.plan.nodes.find(
        (planned) => planned.node_id === node.node_id,
      )!.attempt,
      status: node.status,
      blockers: node.blockers,
      next_action: null,
    })),
    core,
    evidence: {
      relevant_reports: 0,
      registered_decisions: 0,
      supplied: 0,
      raw_bytes: 0,
      per_file_limit: 1024,
      aggregate_limit: 4096,
      message_limit: 128,
      unreadable: [],
      over_budget: false,
    },
    diagnostics: [],
    identity_mapping: 'test only',
    limits: [],
  };
}

function executionReport(
  options: Parameters<NonNullable<RoleOrchestrationDependencies['execute']>>[0],
): WorkExecutionReport {
  const nodes = options.request.capability_cards.map((card) => ({
    node_id:
      card.assignment_id === 'assignment-review'
        ? 'review'
        : card.assignment_id === 'assignment-a'
          ? 'write-a'
          : 'write-b',
    role: card.assignment_id === 'assignment-review' ? 'reviewer' : 'writer',
    assignment_id: card.assignment_id,
    attempt: 1,
    input_revision: `sha256:${'a'.repeat(64)}`,
    work_plan_status: 'ready',
    execution_status: 'dispatched' as const,
    blockers: [],
    next_action: null,
    assignment: { ref: null, digest: null },
    capabilities: { ref: card.capabilities_file, digest: null },
    intent_message_id: 'reserved-intent',
    delivery: {
      status: 'submitted',
      message_digest: null,
      delivery_path: null,
      target_pane: null,
    },
    acceptance: 'not-applicable' as const,
  }));
  return {
    schema: 'pappra/collab-work-execution/1',
    ok: true,
    status: 'applied',
    diagnostics: [],
    apply: true,
    task_root: options.request.task_root,
    task_id: 'orchestration-task',
    plan: {
      ref: options.request.plan_file,
      digest: null,
      plan_id: 'orchestration-plan',
      owner_epoch: 1,
    },
    concurrency: {
      limit: options.request.max_concurrency ?? 2,
      selected: nodes.length,
      actual_overlap: false,
    },
    nodes,
    reports: [],
    acceptance: {
      accepted_nodes: [],
      awaiting_acceptance_nodes: [],
      rejected_nodes: [],
    },
    limits: [],
  };
}

function remove(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

test('dispatches only explicitly ready writer assignments and reserves before runner effects', async () => {
  const fixture = setup();
  try {
    const planFile = fixture.request.execution.plan_file;
    let inspections = 0;
    let executed = 0;
    const result = await tickRoleOrchestration(fixture.request, {
      inspect: async () => {
        inspections += 1;
        return report(fixture.expansion, planFile);
      },
      execute: async (options) => {
        executed += 1;
        const journal = JSON.parse(
          fs.readFileSync(fixture.request.journal_file, 'utf8'),
        ) as {
          events: { state: string; reserved_actions: number }[];
        };
        assert.equal(journal.events[0]?.state, 'reserved');
        assert.equal(journal.events[0]?.reserved_actions, 2);
        assert.deepEqual(
          options.request.capability_cards.map((card) => card.assignment_id),
          ['assignment-a', 'assignment-b'],
        );
        assert.equal(options.apply, true);
        return executionReport(options);
      },
    });
    assert.equal(result.schema, COLLAB_ROLE_ORCHESTRATION_SCHEMA);
    assert.equal(result.status, 'dispatched');
    assert.equal(result.reserved_actions, 2);
    assert.equal(inspections, 3);
    assert.equal(executed, 1);
    const duplicate = await tickRoleOrchestration(fixture.request, {
      inspect: async () => report(fixture.expansion, planFile),
      execute: async () => {
        assert.fail('duplicate event must not execute again');
      },
    });
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(duplicate.prior_outcome, 'dispatched');
  } finally {
    remove(fixture.directory);
  }
});

test('assigned running nodes with no dispatch intent remain schedulable', async () => {
  const fixture = setup();
  try {
    let calls = 0;
    const inspect = async () => {
      const observed = report(
        fixture.expansion,
        fixture.request.execution.plan_file,
        {
          'write-a': { status: 'running' },
          'write-b': { status: 'running' },
        },
      );
      return {
        ...observed,
        nodes: observed.nodes.map((node) => ({
          ...node,
          dispatch_pending: node.role === 'writer',
        })),
      };
    };
    const result = await tickRoleOrchestration(fixture.request, {
      inspect,
      execute: async (options) => {
        calls++;
        assert.equal(options.request.capability_cards.length, 2);
        return executionReport(options);
      },
    });
    assert.equal(result.status, 'dispatched');
    assert.equal(calls, 1);
  } finally {
    remove(fixture.directory);
  }
});

test('a crashed reserved event is not redelivered and a later evidence event may reconcile', async () => {
  const fixture = setup();
  try {
    const planFile = fixture.request.execution.plan_file;
    let executions = 0;
    const deps = {
      inspect: async () => report(fixture.expansion, planFile),
      execute: async () => {
        executions += 1;
        throw new Error('unknown native outcome');
      },
    };
    const crashed = await tickRoleOrchestration(fixture.request, deps);
    assert.equal(crashed.status, 'reconciliation-required');
    const duplicate = await tickRoleOrchestration(fixture.request, deps);
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(
      duplicate.prior_outcome,
      'reserved_unknown_reconcile_before_new_event',
    );
    assert.equal(executions, 1);
  } finally {
    remove(fixture.directory);
  }
});

test('dispatches independent review only after accepted writer evidence and aggregates final acceptance', async () => {
  const fixture = setup();
  try {
    const planFile = fixture.request.execution.plan_file;
    const writerAccepted = report(fixture.expansion, planFile, {
      'write-a': { status: 'accepted', blockers: [] },
      'write-b': { status: 'accepted', blockers: [] },
      review: { status: 'ready', blockers: [] },
    });
    const fullyAccepted = report(fixture.expansion, planFile, {
      'write-a': { status: 'accepted', blockers: [] },
      'write-b': { status: 'accepted', blockers: [] },
      review: { status: 'accepted', blockers: [] },
    });
    let inspectCount = 0;
    let selectedReview = false;
    const result = await tickRoleOrchestration(
      { ...fixture.request, event_id: 'writer-acceptance-event' },
      {
        inspect: async () => {
          inspectCount += 1;
          return inspectCount < 3 ? writerAccepted : fullyAccepted;
        },
        execute: async (options) => {
          assert.deepEqual(
            options.request.capability_cards.map((card) => card.assignment_id),
            ['assignment-review'],
          );
          selectedReview = true;
          return executionReport(options);
        },
      },
    );
    assert.equal(selectedReview, true);
    assert.equal(result.status, 'accepted');
    assert.deepEqual(result.aggregate?.accepted_nodes, [
      'write-a',
      'write-b',
      'review',
    ]);
  } finally {
    remove(fixture.directory);
  }
});

test('rejected registered acceptance requires a new pinned attempt and stops at the attempt bound', async () => {
  const fixture = setup();
  try {
    const rejected = report(
      fixture.expansion,
      fixture.request.execution.plan_file,
      {
        'write-a': { status: 'blocked', blockers: ['acceptance_rejected'] },
        'write-b': { status: 'accepted' },
        review: { status: 'blocked', blockers: ['acceptance_missing'] },
      },
    );
    const repair = await tickRoleOrchestration(fixture.request, {
      inspect: async () => rejected,
      execute: async () => assert.fail('rejected attempt must not be replayed'),
    });
    assert.equal(repair.status, 'repair-required');
    assert.match(
      repair.diagnostics[0] ?? '',
      /new_authoritatively_assigned_attempt/,
    );

    const exhaustedRequest = {
      ...fixture.request,
      event_id: 'event-attempt-limit',
      limits: { ...fixture.request.limits, max_attempts: 1 },
    };
    const exhausted = await tickRoleOrchestration(exhaustedRequest, {
      inspect: async () => rejected,
      execute: async () => assert.fail('rejected attempt must not be replayed'),
    });
    assert.equal(exhausted.status, 'repair-exhausted');
  } finally {
    remove(fixture.directory);
  }
});

test('bounds rounds and total dispatch actions durably', async () => {
  const fixture = setup();
  try {
    const request = {
      ...fixture.request,
      limits: { max_rounds: 3, max_actions: 1, max_attempts: 3 },
    };
    const planFile = request.execution.plan_file;
    let selectedCount = 0;
    const first = await tickRoleOrchestration(request, {
      inspect: async () => report(fixture.expansion, planFile),
      execute: async (options) => {
        selectedCount = options.request.capability_cards.length;
        return executionReport(options);
      },
    });
    assert.equal(first.reserved_actions, 1);
    assert.equal(selectedCount, 1);
    const noActionsLeft = await tickRoleOrchestration(
      { ...request, event_id: 'event-2' },
      {
        inspect: async () => report(fixture.expansion, planFile),
        execute: async () => assert.fail('action budget is exhausted'),
      },
    );
    assert.equal(noActionsLeft.status, 'waiting');
    assert.equal(noActionsLeft.reserved_actions, 0);

    const fullyAccepted = report(fixture.expansion, planFile, {
      'write-a': { status: 'accepted', blockers: [] },
      'write-b': { status: 'accepted', blockers: [] },
      review: { status: 'accepted', blockers: [] },
    });
    const final = await tickRoleOrchestration(
      { ...request, event_id: 'event-3' },
      {
        inspect: async () => fullyAccepted,
        execute: async () =>
          assert.fail('accepted plan does not dispatch again'),
      },
    );
    assert.equal(final.status, 'accepted');
    assert.equal(final.reserved_actions, 0);
  } finally {
    remove(fixture.directory);
  }
});
