import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { transitionAttempt } from '../../src/collab/lifecycle.js';
import { claimResources, releaseClaim } from '../../src/collab/resources.js';
import { readRecord, transact } from '../../src/collab/store.js';
import type {
  Identity,
  Message,
  MessageInput,
  TaskRecord,
} from '../../src/collab/types.js';
import {
  WORK_PLAN_SCHEMA,
  evaluateWorkPlan,
  validateWorkPlan,
  type WorkPlanDiagnostic,
  type WorkPlanEvaluation,
  type WorkPlanRefusal,
} from '../../src/collab/work-plan.js';
import { makeTaskDomain } from './task-resources-fixtures.js';

// The fixtures drive the real protocol: assignments, reports, answers and claims are
// registered through the shipped helpers, so acceptance evidence carries the digests the
// record actually stored instead of synthetic strings.

const TASK = 'sample';
const PLAN_ID = 'plan-e2';
const INPUT = `sha256:${'1'.repeat(64)}`;
const INPUT_OTHER = `sha256:${'2'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'3'.repeat(64)}`;

const COORDINATOR: Identity = {
  agent_id: 'coordinator',
  session_id: 'coord-session',
  harness: 'pi',
};
const WRITER_A: Identity = {
  agent_id: 'writer-a',
  session_id: 'session-a',
  harness: 'codex',
};
const WRITER_B: Identity = {
  agent_id: 'writer-b',
  session_id: 'session-b',
  harness: 'claude',
};
const WRITER_C: Identity = {
  agent_id: 'writer-c',
  session_id: 'session-c',
  harness: 'pi',
};

interface Flow {
  readonly task: string;
  readonly root: string;
  readonly messages: Message[];
  send(input: MessageInput): Message;
  nextId(prefix: string): string;
  record(): TaskRecord;
  cleanup(): void;
}

function makeFlow(label: string): Flow {
  const domain = makeTaskDomain(label, [TASK]);
  const task = domain.tasks[TASK]!;
  const messages: Message[] = [];
  let clock = Date.parse('2026-10-20T00:00:00Z');
  let counter = 0;
  const tick = (): number => (clock += 1000);
  return {
    task,
    root: domain.root,
    messages,
    nextId: (prefix) => `${prefix}-${(counter += 1)}`,
    send: (input) => {
      const message = buildMessage(input, { clock: tick() });
      const outcome = submitMessage(task, message, { clock: tick() });
      assert.equal(
        outcome.ok,
        true,
        `could not submit ${input.type}: ${JSON.stringify(outcome)}`,
      );
      messages.push(message);
      return message;
    },
    record: () => {
      const record = readRecord(task);
      assert.ok(record, 'task record is missing');
      return record;
    },
    cleanup: domain.cleanup,
  };
}

interface AssignOptions {
  readonly subtask: string;
  readonly attempt?: number;
  readonly writer?: Identity;
  readonly inputRevision?: string | null;
  readonly approval?: { approved_by: string; reason: string };
  readonly messageId?: string;
}

function assign(flow: Flow, options: AssignOptions): Message {
  return flow.send({
    message_id:
      options.messageId ??
      `msg-assign-${options.subtask}-${options.attempt ?? 1}`,
    type: 'ASSIGN',
    task_id: TASK,
    from: COORDINATOR,
    to: options.writer ?? WRITER_A,
    subtask_id: options.subtask,
    attempt: options.attempt ?? 1,
    owner_epoch: 1,
    body: {
      assignment_digest: `sha256:${'a'.repeat(64)}`,
      input_revision:
        options.inputRevision === undefined ? INPUT : options.inputRevision,
      ...(options.approval === undefined ? {} : { approval: options.approval }),
    },
  });
}

interface ReportOptions {
  readonly subtask: string;
  readonly reportMessageId?: string;
  readonly attempt?: number;
  readonly writer?: Identity;
  readonly status?: string;
  readonly inputRevision?: string;
}

function report(flow: Flow, options: ReportOptions): Message {
  return flow.send({
    message_id:
      options.reportMessageId ??
      `msg-report-${options.subtask}-${options.attempt ?? 1}`,
    type: 'REPORT',
    task_id: TASK,
    from: options.writer ?? WRITER_A,
    to: COORDINATOR,
    subtask_id: options.subtask,
    attempt: options.attempt ?? 1,
    body: {
      status: options.status ?? 'completed',
      input_revision: options.inputRevision ?? INPUT,
    },
  });
}

interface AnswerOptions {
  readonly subtask: string;
  readonly reportMessage: Message;
  readonly nodeId?: string;
  readonly attempt?: number;
  readonly inputRevision?: string;
  readonly decision?: string;
  readonly reportDigest?: string;
  readonly reportMessageId?: string;
  readonly planId?: string;
  readonly ownerEpoch?: number;
  readonly from?: Identity;
  readonly to?: Identity;
  readonly messageId?: string;
  readonly replyTo?: string;
  readonly protocolRefusal?: string;
  /** Explicit sender timestamp, used to prove that sender time never orders authority. */
  readonly createdAt?: string;
}

function answer(flow: Flow, options: AnswerOptions): Message {
  const digest = options.reportMessage.content_digest;
  assert.equal(typeof digest, 'string', 'the report must carry a digest');
  const attempt = options.attempt ?? 1;
  const input: MessageInput = {
    message_id: options.messageId ?? flow.nextId('msg-answer'),
    type: 'ANSWER',
    task_id: TASK,
    from: options.from ?? COORDINATOR,
    to: options.to ?? WRITER_A,
    reply_to: options.replyTo ?? options.reportMessage.message_id,
    subtask_id: options.subtask,
    attempt,
    owner_epoch: options.ownerEpoch ?? 1,
    ...(options.createdAt === undefined
      ? {}
      : { created_at: options.createdAt }),
    body: {
      acceptance: {
        plan_id: options.planId ?? PLAN_ID,
        node_id: options.nodeId ?? options.subtask,
        assignment_id: options.subtask,
        attempt,
        input_revision: options.inputRevision ?? INPUT,
        report_message_id:
          options.reportMessageId ?? options.reportMessage.message_id,
        report_digest: options.reportDigest ?? digest,
        decision: options.decision ?? 'accepted',
      },
    },
  };
  if (options.protocolRefusal !== undefined) {
    const message = buildMessage(input);
    const outcome = submitMessage(flow.task, message);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, options.protocolRefusal);
    flow.messages.push(message);
    return message;
  }
  return flow.send(input);
}

function node(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    node_id: id,
    role: 'writer',
    assignment_id: id,
    attempt: 1,
    input_revision: INPUT,
    assignee: WRITER_A,
    depends_on: [],
    resources: [],
    ...overrides,
  };
}

function plan(
  nodes: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: WORK_PLAN_SCHEMA,
    plan_id: PLAN_ID,
    task_id: TASK,
    owner_epoch: 1,
    nodes,
    ...overrides,
  };
}

function evaluate(
  flow: Flow,
  planValue: unknown,
  messages?: readonly Message[],
): WorkPlanEvaluation | WorkPlanRefusal {
  return evaluateWorkPlan({
    plan: planValue,
    record: flow.record(),
    messages: messages ?? flow.messages,
  });
}

function ok(result: WorkPlanEvaluation | WorkPlanRefusal): WorkPlanEvaluation {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as WorkPlanEvaluation;
}

function diagnosticCodes(result: {
  readonly ok: boolean;
  readonly diagnostics?: readonly WorkPlanDiagnostic[];
}): readonly string[] {
  assert.equal(result.ok, false, JSON.stringify(result));
  return (result.diagnostics ?? []).map((entry) => entry.code);
}

function refusalCodes(
  result: WorkPlanEvaluation | WorkPlanRefusal,
): readonly string[] {
  return diagnosticCodes(result);
}

function statusOf(
  result: WorkPlanEvaluation | WorkPlanRefusal,
  nodeId: string,
): string {
  const found = ok(result).nodes.find((entry) => entry.node_id === nodeId);
  assert.ok(found, `no node ${nodeId} in the evaluation`);
  return found.status;
}

function codesOf(
  result: WorkPlanEvaluation | WorkPlanRefusal,
  nodeId: string,
): readonly string[] {
  const found = ok(result).nodes.find((entry) => entry.node_id === nodeId);
  assert.ok(found, `no node ${nodeId} in the evaluation`);
  return found.blockers.map((entry) => entry.code);
}

function shapeOf(
  result: WorkPlanEvaluation | WorkPlanRefusal,
): Record<string, { status: string; blockers: readonly string[] }> {
  return Object.fromEntries(
    ok(result).nodes.map((entry) => [
      entry.node_id,
      {
        status: entry.status,
        blockers: entry.blockers.map((blocker) => blocker.code),
      },
    ]),
  );
}

test('the plan format rejects malformed graphs, unsafe paths and an acceptance bypass', () => {
  assert.deepEqual(
    diagnosticCodes(validateWorkPlan(plan([node('a', { depends_on: ['a'] })]))),
    ['self_dependency'],
  );
  assert.deepEqual(
    diagnosticCodes(validateWorkPlan(plan([node('a', { depends_on: ['b'] })]))),
    ['unknown_dependency'],
  );
  assert.deepEqual(
    diagnosticCodes(
      validateWorkPlan(
        plan([
          node('a', { depends_on: ['b'] }),
          node('b', { depends_on: ['a'] }),
        ]),
      ),
    ),
    ['dependency_cycle'],
  );
  assert.deepEqual(
    diagnosticCodes(validateWorkPlan(plan([node('a'), node('a')]))),
    ['duplicate_node_id'],
  );
  assert.deepEqual(
    diagnosticCodes(
      validateWorkPlan(
        plan([
          node('a', {
            resources: [{ path: 'relative/path', access: 'write' }],
          }),
        ]),
      ),
    ),
    ['resource_invalid'],
  );
  assert.deepEqual(
    diagnosticCodes(
      validateWorkPlan(
        plan([
          node('a', {
            resources: [{ path: '/tmp/../tmp/scope', access: 'write' }],
          }),
        ]),
      ),
    ),
    ['resource_invalid'],
  );
  assert.deepEqual(
    diagnosticCodes(
      validateWorkPlan(plan([node('a', { requires_acceptance: false })])),
    ),
    ['plan_invalid'],
  );
  assert.equal(validateWorkPlan(plan([node('a')])).ok, true);
});

test('a registered coordinator acceptance unlocks the dependent', () => {
  const flow = makeFlow('work-plan-accept');
  try {
    assign(flow, { subtask: 'work' });
    const reported = report(flow, { subtask: 'work' });
    answer(flow, { subtask: 'work', reportMessage: reported });
    const result = evaluate(
      flow,
      plan([node('work'), node('next', { assignee: WRITER_B })]),
    );
    assert.equal(statusOf(result, 'work'), 'accepted');
    assert.equal(statusOf(result, 'next'), 'ready');
    assert.deepEqual(ok(result).accepted_nodes, ['work']);
    assert.deepEqual(ok(result).awaiting_acceptance_nodes, []);
  } finally {
    flow.cleanup();
  }
});

test('a completed report alone never unlocks the dependent', () => {
  const flow = makeFlow('work-plan-no-acceptance');
  try {
    assign(flow, { subtask: 'work' });
    report(flow, { subtask: 'work' });
    const result = evaluate(
      flow,
      plan([
        node('work'),
        node('next', { depends_on: ['work'], assignee: WRITER_B }),
      ]),
    );
    assert.equal(statusOf(result, 'work'), 'awaiting_acceptance');
    assert.deepEqual(ok(result).awaiting_acceptance_nodes, ['work']);
    assert.equal(statusOf(result, 'next'), 'blocked');
    assert.deepEqual(codesOf(result, 'next'), ['acceptance_missing']);
    const next = ok(result).nodes.find((entry) => entry.node_id === 'next');
    assert.match(String(next?.recovery), /coordinator acceptance/);
  } finally {
    flow.cleanup();
  }
});

test('an unregistered or edited acceptance envelope proves nothing', () => {
  const unregistered = makeFlow('work-plan-unregistered-accept');
  try {
    assign(unregistered, { subtask: 'work' });
    const reported = report(unregistered, { subtask: 'work' });
    const forged = buildMessage({
      message_id: 'msg-forged-answer',
      type: 'ANSWER',
      task_id: TASK,
      from: COORDINATOR,
      to: WRITER_A,
      reply_to: reported.message_id,
      subtask_id: 'work',
      attempt: 1,
      owner_epoch: 1,
      body: {
        acceptance: {
          plan_id: PLAN_ID,
          node_id: 'work',
          assignment_id: 'work',
          attempt: 1,
          input_revision: INPUT,
          report_message_id: reported.message_id,
          report_digest: reported.content_digest,
          decision: 'accepted',
        },
      },
    });
    const result = evaluate(
      unregistered,
      plan([node('work'), node('next', { depends_on: ['work'] })]),
      [...unregistered.messages, forged],
    );
    assert.equal(statusOf(result, 'work'), 'awaiting_acceptance');
    assert.deepEqual(codesOf(result, 'next'), ['acceptance_untrusted']);
  } finally {
    unregistered.cleanup();
  }

  const edited = makeFlow('work-plan-edited-accept');
  try {
    assign(edited, { subtask: 'work' });
    const reported = report(edited, { subtask: 'work' });
    const registered = answer(edited, {
      subtask: 'work',
      reportMessage: reported,
    });
    const tampered = JSON.parse(JSON.stringify(registered)) as Message;
    (tampered.body['acceptance'] as Record<string, unknown>)['decision'] =
      'rejected';
    const result = evaluate(
      edited,
      plan([node('work'), node('next', { depends_on: ['work'] })]),
      edited.messages.map((message) =>
        message.message_id === registered.message_id ? tampered : message,
      ),
    );
    assert.equal(statusOf(result, 'work'), 'awaiting_acceptance');
    assert.deepEqual(codesOf(result, 'next'), ['acceptance_untrusted']);
  } finally {
    edited.cleanup();
  }
});

test('an unknown or explicitly rejected decision is not acceptance', () => {
  const unknown = makeFlow('work-plan-unknown-decision');
  try {
    assign(unknown, { subtask: 'work' });
    const reported = report(unknown, { subtask: 'work' });
    answer(unknown, {
      subtask: 'work',
      reportMessage: reported,
      decision: 'banana',
    });
    const result = evaluate(
      unknown,
      plan([node('work'), node('next', { depends_on: ['work'] })]),
    );
    assert.deepEqual(codesOf(result, 'next'), ['acceptance_mismatch']);
  } finally {
    unknown.cleanup();
  }

  const rejected = makeFlow('work-plan-rejected');
  try {
    assign(rejected, { subtask: 'work' });
    const reported = report(rejected, { subtask: 'work' });
    answer(rejected, {
      subtask: 'work',
      reportMessage: reported,
      decision: 'rejected',
    });
    const result = evaluate(
      rejected,
      plan([node('work'), node('next', { depends_on: ['work'] })]),
    );
    assert.deepEqual(codesOf(result, 'next'), ['acceptance_rejected']);
  } finally {
    rejected.cleanup();
  }
});

test('a later rejection overrides an earlier acceptance regardless of array order', () => {
  const flow = makeFlow('work-plan-late-rejection');
  try {
    assign(flow, { subtask: 'work' });
    const reported = report(flow, { subtask: 'work' });
    answer(flow, { subtask: 'work', reportMessage: reported });
    answer(flow, {
      subtask: 'work',
      reportMessage: reported,
      decision: 'rejected',
    });
    const planValue = plan([
      node('work'),
      node('next', { depends_on: ['work'] }),
    ]);
    const forward = evaluate(flow, planValue);
    const reversed = evaluate(flow, planValue, [...flow.messages].reverse());
    assert.deepEqual(codesOf(forward, 'next'), ['acceptance_rejected']);
    assert.deepEqual(shapeOf(forward), shapeOf(reversed));
  } finally {
    flow.cleanup();
  }
});

test('acceptance must be current, addressed and issued by the coordinator', () => {
  const cases: readonly {
    readonly name: string;
    readonly overrides: Partial<
      Omit<AnswerOptions, 'subtask' | 'reportMessage'>
    >;
    readonly code: string;
  }[] = [
    {
      name: 'self review',
      overrides: {
        from: WRITER_A,
        to: WRITER_A,
        protocolRefusal: 'unauthorized_sender',
      },
      code: 'acceptance_untrusted',
    },
    {
      name: 'non coordinator',
      overrides: {
        from: WRITER_B,
        to: WRITER_A,
        protocolRefusal: 'unauthorized_sender',
      },
      code: 'acceptance_untrusted',
    },
    {
      name: 'stale owner epoch',
      overrides: { ownerEpoch: 2 },
      code: 'acceptance_stale',
    },
    {
      name: 'stale input revision',
      overrides: { inputRevision: INPUT_OTHER },
      code: 'acceptance_stale',
    },
    {
      name: 'wrong report digest',
      overrides: { reportDigest: OTHER_DIGEST },
      code: 'acceptance_mismatch',
    },
    {
      name: 'wrong recipient',
      overrides: { to: WRITER_B },
      code: 'acceptance_mismatch',
    },
    {
      name: 'wrong attempt',
      overrides: { attempt: 2 },
      code: 'acceptance_mismatch',
    },
  ];
  for (const item of cases) {
    const flow = makeFlow(`work-plan-acceptance-${item.code}`);
    try {
      assign(flow, { subtask: 'work' });
      const reported = report(flow, { subtask: 'work' });
      answer(flow, {
        subtask: 'work',
        reportMessage: reported,
        ...item.overrides,
      });
      const result = evaluate(
        flow,
        plan([node('work'), node('next', { depends_on: ['work'] })]),
      );
      assert.equal(
        statusOf(result, 'work'),
        'awaiting_acceptance',
        `${item.name} must not accept the node`,
      );
      assert.deepEqual(codesOf(result, 'next'), [item.code], item.name);
    } finally {
      flow.cleanup();
    }
  }
});

test('a registered acceptance whose envelope was not supplied cannot be verified', () => {
  const flow = makeFlow('work-plan-missing-envelope');
  try {
    const assigned = assign(flow, { subtask: 'work' });
    const reported = report(flow, { subtask: 'work' });
    answer(flow, { subtask: 'work', reportMessage: reported });
    const result = evaluate(
      flow,
      plan([node('work'), node('next', { depends_on: ['work'] })]),
      [assigned, reported],
    );
    assert.deepEqual(codesOf(result, 'next'), ['acceptance_untrusted']);
    assert.ok(ok(result).limits.includes('acceptance_envelope_missing'));
  } finally {
    flow.cleanup();
  }
});

test('identical evidence is idempotent', () => {
  const flow = makeFlow('work-plan-idempotent');
  try {
    assign(flow, { subtask: 'work' });
    const reported = report(flow, { subtask: 'work' });
    answer(flow, { subtask: 'work', reportMessage: reported });
    const planValue = plan([
      node('work'),
      node('next', { depends_on: ['work'] }),
    ]);
    const once = ok(evaluate(flow, planValue));
    const twice = ok(
      evaluate(flow, planValue, [...flow.messages, ...flow.messages]),
    );
    assert.deepEqual(once, twice);
  } finally {
    flow.cleanup();
  }
});

test('dependency evaluation does not depend on node order', () => {
  const flow = makeFlow('work-plan-order');
  try {
    assign(flow, { subtask: 'work', inputRevision: INPUT_OTHER });
    const work = node('work');
    const join = node('join', { depends_on: ['work'], assignee: WRITER_B });
    const forward = evaluate(flow, plan([work, join]));
    const reversed = evaluate(flow, plan([join, work]));
    assert.deepEqual(shapeOf(forward), shapeOf(reversed));
    assert.deepEqual(codesOf(forward, 'work'), ['input_changed']);
    assert.equal(statusOf(forward, 'work'), 'blocked');
    assert.deepEqual(codesOf(forward, 'join'), ['predecessor_blocked']);
    assert.deepEqual(
      [...ok(forward).blocked_nodes].sort(),
      [...ok(reversed).blocked_nodes].sort(),
    );
  } finally {
    flow.cleanup();
  }
});

test('a superseded attempt blocks a node pinned to the older attempt', () => {
  const flow = makeFlow('work-plan-superseded');
  try {
    assign(flow, { subtask: 'work' });
    report(flow, { subtask: 'work' });
    assign(flow, {
      subtask: 'work',
      attempt: 2,
      approval: { approved_by: 'coordinator', reason: 'retry after review' },
    });
    const result = evaluate(
      flow,
      plan([
        node('work'),
        node('work-two', { assignment_id: 'work', attempt: 2 }),
      ]),
    );
    assert.deepEqual(codesOf(result, 'work'), ['assignment_stale']);
    assert.equal(statusOf(result, 'work'), 'blocked');
    assert.equal(statusOf(result, 'work-two'), 'running');
  } finally {
    flow.cleanup();
  }
});

test('an attempt without a pinned input revision cannot match the plan', () => {
  const flow = makeFlow('work-plan-unpinned-input');
  try {
    assign(flow, { subtask: 'work', inputRevision: null });
    const result = evaluate(flow, plan([node('work')]));
    assert.deepEqual(codesOf(result, 'work'), ['input_unpinned']);
  } finally {
    flow.cleanup();
  }
});

test('a failed attempt blocks itself and its dependents', () => {
  const flow = makeFlow('work-plan-failed');
  try {
    assign(flow, { subtask: 'work' });
    report(flow, { subtask: 'work', status: 'failed' });
    const result = evaluate(
      flow,
      plan([node('work'), node('next', { depends_on: ['work'] })]),
    );
    assert.equal(statusOf(result, 'work'), 'blocked');
    assert.deepEqual(codesOf(result, 'work'), ['own_failed']);
    assert.deepEqual(codesOf(result, 'next'), ['predecessor_failed']);
  } finally {
    flow.cleanup();
  }
});

test('an attempt waiting for clarification is blocked, not ready to retry', () => {
  const flow = makeFlow('work-plan-needs-input');
  try {
    assign(flow, { subtask: 'work' });
    flow.send({
      message_id: 'msg-block-work',
      type: 'BLOCK',
      task_id: TASK,
      from: WRITER_A,
      to: COORDINATOR,
      subtask_id: 'work',
      attempt: 1,
      body: { kind: 'clarification' },
    });
    const result = evaluate(flow, plan([node('work')]));
    assert.deepEqual(codesOf(result, 'work'), ['own_blocked']);
  } finally {
    flow.cleanup();
  }
});

test('an unknown native execution state is not dispatch readiness', () => {
  const flow = makeFlow('work-plan-unknown-state');
  try {
    assign(flow, { subtask: 'work' });
    const moved = transact(flow.task, {
      actor: 'fixture',
      purpose: 'mark-unknown',
      apply: (record) => {
        const running = transitionAttempt(record, {
          subtaskId: 'work',
          attempt: 1,
          to: 'running',
          actor: 'fixture',
        });
        if (!running.ok) return running;
        const unknown = transitionAttempt(record, {
          subtaskId: 'work',
          attempt: 1,
          to: 'unknown',
          actor: 'fixture',
        });
        if (!unknown.ok) return unknown;
        return {
          record,
          op: 'mark-unknown',
          summary: {},
          result: { ok: true as const },
        };
      },
    });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    const result = evaluate(flow, plan([node('work')]));
    assert.deepEqual(codesOf(result, 'work'), ['own_uncertain']);
  } finally {
    flow.cleanup();
  }
});

test('a stale owner epoch or a frozen dispatch is not dispatch readiness', () => {
  const stale = makeFlow('work-plan-stale-epoch');
  try {
    const result = evaluate(stale, plan([node('work')], { owner_epoch: 2 }));
    assert.deepEqual(codesOf(result, 'work'), ['owner_epoch_mismatch']);
  } finally {
    stale.cleanup();
  }

  const frozen = makeFlow('work-plan-frozen');
  try {
    const froze = transact(frozen.task, {
      actor: 'fixture',
      purpose: 'freeze',
      apply: (record) => {
        record.dispatch_frozen = true;
        return {
          record,
          op: 'freeze',
          summary: {},
          result: { ok: true as const },
        };
      },
    });
    assert.equal(froze.ok, true, JSON.stringify(froze));
    const result = evaluate(frozen, plan([node('work')]));
    assert.deepEqual(codesOf(result, 'work'), ['dispatch_frozen']);
  } finally {
    frozen.cleanup();
  }
});

test('read shares run concurrently while write scopes serialize', () => {
  const shared = '/tmp/e2-shared-scope';
  const readers = makeFlow('work-plan-readers');
  try {
    const result = evaluate(
      readers,
      plan([
        node('read-a', { resources: [{ path: shared, access: 'read' }] }),
        node('read-b', { resources: [{ path: shared, access: 'read' }] }),
      ]),
    );
    assert.deepEqual(ok(result).ready_nodes, ['read-a', 'read-b']);
    assert.deepEqual(ok(result).blocked_nodes, []);
  } finally {
    readers.cleanup();
  }

  const writers = makeFlow('work-plan-writers');
  try {
    const result = evaluate(
      writers,
      plan([
        node('write-a', { resources: [{ path: shared, access: 'write' }] }),
        node('write-b', { resources: [{ path: shared, access: 'write' }] }),
      ]),
    );
    assert.deepEqual(ok(result).ready_nodes, []);
    assert.deepEqual(codesOf(result, 'write-a'), ['resource_overlap']);
    assert.deepEqual(codesOf(result, 'write-b'), ['resource_overlap']);
  } finally {
    writers.cleanup();
  }

  const serialized = makeFlow('work-plan-serialized');
  try {
    assign(serialized, { subtask: 'write-a' });
    const reported = report(serialized, { subtask: 'write-a' });
    answer(serialized, { subtask: 'write-a', reportMessage: reported });
    const result = evaluate(
      serialized,
      plan([
        node('write-a', { resources: [{ path: shared, access: 'write' }] }),
        node('write-b', {
          depends_on: ['write-a'],
          resources: [{ path: shared, access: 'write' }],
        }),
      ]),
    );
    assert.equal(statusOf(result, 'write-a'), 'accepted');
    assert.equal(statusOf(result, 'write-b'), 'ready');
    assert.deepEqual(codesOf(result, 'write-b'), []);
  } finally {
    serialized.cleanup();
  }
});

test('active claims block only conflicting holders and access modes', () => {
  const shared = (flow: Flow): string => join(flow.root, 'shared-scope');
  const conflict = makeFlow('work-plan-claim-conflict');
  try {
    claimResources(conflict.task, {
      resources: [{ kind: 'path', path: shared(conflict) }],
      holder: WRITER_B,
      subtaskId: 'other-work',
      attempt: 1,
    });
    const result = evaluate(
      conflict,
      plan([
        node('work', {
          resources: [{ path: shared(conflict), access: 'write' }],
        }),
      ]),
    );
    assert.deepEqual(codesOf(result, 'work'), ['resource_claim_conflict']);
  } finally {
    conflict.cleanup();
  }

  const own = makeFlow('work-plan-own-claim');
  try {
    claimResources(own.task, {
      resources: [{ kind: 'path', path: shared(own) }],
      holder: WRITER_A,
      subtaskId: 'work',
      attempt: 1,
    });
    const result = evaluate(
      own,
      plan([
        node('work', { resources: [{ path: shared(own), access: 'write' }] }),
      ]),
    );
    assert.equal(statusOf(result, 'work'), 'ready');
  } finally {
    own.cleanup();
  }

  const readers = makeFlow('work-plan-claim-readers');
  try {
    claimResources(readers.task, {
      resources: [{ kind: 'path', path: shared(readers) }],
      access: 'read',
      holder: WRITER_B,
      subtaskId: 'other-read',
      attempt: 1,
    });
    const readResult = evaluate(
      readers,
      plan([
        node('work', {
          resources: [{ path: shared(readers), access: 'read' }],
        }),
      ]),
    );
    assert.equal(statusOf(readResult, 'work'), 'ready');
    const writeResult = evaluate(
      readers,
      plan([
        node('work', {
          resources: [{ path: shared(readers), access: 'write' }],
        }),
      ]),
    );
    assert.deepEqual(codesOf(writeResult, 'work'), ['resource_claim_conflict']);
  } finally {
    readers.cleanup();
  }

  const released = makeFlow('work-plan-claim-released');
  try {
    const claimed = claimResources(released.task, {
      resources: [{ kind: 'path', path: shared(released) }],
      holder: WRITER_B,
      subtaskId: 'other-work',
      attempt: 1,
    });
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    const claimIds = claimed.ok
      ? claimed.claims.map((claim) => claim.claim_id)
      : [];
    for (const claimId of claimIds) {
      const outcome = releaseClaim(released.task, {
        claimId,
        holder: WRITER_B,
        reason: 'fixture release',
      });
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
    }
    const result = evaluate(
      released,
      plan([
        node('work', {
          resources: [{ path: shared(released), access: 'write' }],
        }),
      ]),
    );
    assert.equal(statusOf(result, 'work'), 'ready');
  } finally {
    released.cleanup();
  }
});

test('a plan for another task or malformed evidence is refused with diagnostics', () => {
  const flow = makeFlow('work-plan-refusals');
  try {
    assert.deepEqual(
      refusalCodes(
        evaluate(flow, plan([node('work')], { task_id: 'another-task' })),
      ),
      ['task_identity_mismatch'],
    );
    assert.deepEqual(
      refusalCodes(
        evaluate(
          flow,
          plan([node('work')]),
          new Array<Message>(500).fill({} as Message),
        ),
      ),
      ['evidence_too_large'],
    );
    assert.deepEqual(
      refusalCodes(evaluate(flow, plan([node('work')]), [{} as Message])),
      ['message_invalid'],
    );
    const foreign = buildMessage({
      message_id: 'msg-foreign-status',
      type: 'STATUS',
      task_id: 'another-task',
      from: COORDINATOR,
      to: WRITER_A,
      reply_to: 'msg-assign-work-1',
      body: { status: 'running' },
    });
    assert.deepEqual(
      refusalCodes(evaluate(flow, plan([node('work')]), [foreign])),
      ['message_task_mismatch'],
    );
  } finally {
    flow.cleanup();
  }
});

test('an omitted later rejection keeps acceptance unknown instead of reusing an older accept', () => {
  const flow = makeFlow('work-plan-omitted-rejection');
  try {
    assign(flow, { subtask: 'work' });
    const reported = report(flow, { subtask: 'work' });
    answer(flow, { subtask: 'work', reportMessage: reported });
    const rejection = answer(flow, {
      subtask: 'work',
      reportMessage: reported,
      decision: 'rejected',
    });
    const result = evaluate(
      flow,
      plan([node('work'), node('next', { depends_on: ['work'] })]),
      flow.messages.filter(
        (message) => message.message_id !== rejection.message_id,
      ),
    );
    assert.equal(statusOf(result, 'work'), 'awaiting_acceptance');
    assert.deepEqual(codesOf(result, 'next'), ['acceptance_untrusted']);
    assert.ok(ok(result).limits.includes('acceptance_envelope_missing'));
    assert.ok(!ok(result).accepted_nodes.includes('work'));
  } finally {
    flow.cleanup();
  }
});

test('sender timestamps never order authoritative decisions', () => {
  const backdated = makeFlow('work-plan-backdated-rejection');
  try {
    assign(backdated, { subtask: 'work' });
    const reported = report(backdated, { subtask: 'work' });
    answer(backdated, {
      subtask: 'work',
      reportMessage: reported,
      createdAt: '2026-10-25T00:00:00+08:00',
    });
    answer(backdated, {
      subtask: 'work',
      reportMessage: reported,
      decision: 'rejected',
      createdAt: '2026-10-01T00:00:00-07:00',
    });
    const result = evaluate(
      backdated,
      plan([node('work'), node('next', { depends_on: ['work'] })]),
    );
    assert.deepEqual(codesOf(result, 'next'), ['acceptance_rejected']);
  } finally {
    backdated.cleanup();
  }

  const forwardDated = makeFlow('work-plan-forward-dated-accept');
  try {
    assign(forwardDated, { subtask: 'work' });
    const reported = report(forwardDated, { subtask: 'work' });
    answer(forwardDated, {
      subtask: 'work',
      reportMessage: reported,
      decision: 'rejected',
      createdAt: '2026-10-20T00:00:00Z',
    });
    answer(forwardDated, {
      subtask: 'work',
      reportMessage: reported,
      createdAt: '2026-12-31T23:59:59Z',
    });
    const result = evaluate(
      forwardDated,
      plan([node('work'), node('next', { depends_on: ['work'] })]),
      [...forwardDated.messages].reverse(),
    );
    assert.equal(statusOf(result, 'work'), 'accepted');
  } finally {
    forwardDated.cleanup();
  }

  const tied = makeFlow('work-plan-tied-timestamps');
  try {
    assign(tied, { subtask: 'work' });
    const reported = report(tied, { subtask: 'work' });
    answer(tied, {
      subtask: 'work',
      reportMessage: reported,
      createdAt: '2026-10-20T12:00:00Z',
    });
    answer(tied, {
      subtask: 'work',
      reportMessage: reported,
      decision: 'rejected',
      createdAt: '2026-10-20T12:00:00Z',
    });
    const result = evaluate(
      tied,
      plan([node('work'), node('next', { depends_on: ['work'] })]),
    );
    assert.deepEqual(codesOf(result, 'next'), ['acceptance_rejected']);
  } finally {
    tied.cleanup();
  }
});

test('a transferred claim does not invalidate an accepted predecessor', () => {
  const flow = makeFlow('work-plan-claim-transfer');
  try {
    const scope = join(flow.root, 'shared-scope');
    assign(flow, { subtask: 'work' });
    const reported = report(flow, { subtask: 'work' });
    answer(flow, { subtask: 'work', reportMessage: reported });
    const claimed = claimResources(flow.task, {
      resources: [{ kind: 'path', path: scope }],
      holder: WRITER_B,
      subtaskId: 'next',
      attempt: 1,
    });
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    const planValue = plan([
      node('work', { resources: [{ path: scope, access: 'write' }] }),
      node('next', {
        assignee: WRITER_B,
        depends_on: ['work'],
        resources: [{ path: scope, access: 'write' }],
      }),
    ]);
    const result = evaluate(flow, planValue);
    assert.equal(statusOf(result, 'work'), 'accepted');
    assert.deepEqual(codesOf(result, 'work'), []);
    assert.equal(statusOf(result, 'next'), 'ready');

    for (const claim of claimed.ok ? claimed.claims : []) {
      const released = releaseClaim(flow.task, {
        claimId: claim.claim_id,
        holder: WRITER_B,
        reason: 'transfer to third writer',
      });
      assert.equal(released.ok, true, JSON.stringify(released));
    }
    const foreign = claimResources(flow.task, {
      resources: [{ kind: 'path', path: scope }],
      holder: WRITER_C,
      subtaskId: 'third',
      attempt: 1,
    });
    assert.equal(foreign.ok, true, JSON.stringify(foreign));
    const afterTransfer = evaluate(flow, planValue);
    assert.equal(statusOf(afterTransfer, 'work'), 'accepted');
    assert.equal(statusOf(afterTransfer, 'next'), 'blocked');
    assert.deepEqual(codesOf(afterTransfer, 'next'), [
      'resource_claim_conflict',
    ]);
  } finally {
    flow.cleanup();
  }
});

test('malformed or oversized record entries are refused with diagnostics', () => {
  const flow = makeFlow('work-plan-record-bounds');
  try {
    const planValue = plan([node('work')]);
    const baseline = flow.record();
    const cases: readonly {
      readonly key:
        'claims' | 'attempts' | 'results' | 'messages' | 'uncertainty';
      readonly value: unknown;
      readonly code: string;
    }[] = [
      { key: 'claims', value: [null], code: 'record_invalid' },
      { key: 'attempts', value: [{}], code: 'record_invalid' },
      {
        key: 'results',
        value: [{ subtask_id: 'work' }],
        code: 'record_invalid',
      },
      { key: 'messages', value: [{ message_id: 'x' }], code: 'record_invalid' },
      { key: 'uncertainty', value: [null], code: 'record_invalid' },
      {
        key: 'results',
        value: new Array(600).fill({
          subtask_id: 'work',
          attempt: 1,
          status: 'completed',
          message_id: 'msg-x',
          classification: 'applied',
        }),
        code: 'record_too_large',
      },
    ];
    for (const item of cases) {
      const mutated = {
        ...baseline,
        [item.key]: item.value,
      } as unknown as TaskRecord;
      const result = evaluateWorkPlan({
        plan: planValue,
        record: mutated,
        messages: flow.messages,
      });
      assert.deepEqual(refusalCodes(result), [item.code], item.key);
    }
  } finally {
    flow.cleanup();
  }
});
