import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { readRecord } from '../../src/collab/store.js';
import type {
  Identity,
  Message,
  MessageInput,
  TaskRecord,
} from '../../src/collab/types.js';
import {
  WORK_PLAN_SCHEMA,
  evaluateWorkPlan,
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

const NEXT: Identity = {
  agent_id: 'next-coordinator',
  session_id: 'next-session',
  harness: 'claude',
};

/** The record as it reads after one completed coordinator handoff, ended at `endedAt`. */
function succeeded(
  record: TaskRecord,
  endedAt: string,
  options: { readonly handedOffBy?: Identity } = {},
): TaskRecord {
  const copy = structuredClone(record);
  const previous = options.handedOffBy ?? COORDINATOR;
  const before = { ...previous, owner_epoch: 1 };
  copy.coordinator = {
    ...NEXT,
    owner_epoch: 2,
    since: endedAt,
    previous: {
      agent_id: before.agent_id,
      session_id: before.session_id,
      owner_epoch: 1,
    },
  } as never;
  copy.handoffs = [
    ...(copy.handoffs ?? []),
    {
      schema: 'harness-collab/handoff/1',
      handoff_id: 'h1',
      kind: 'coordinator',
      subtask_id: null,
      attempt: null,
      from: previous,
      to: NEXT,
      resources: [],
      ownership_snapshot: [],
      state: 'completed',
      owner_epoch: 2,
      created_at: endedAt,
      updated_at: endedAt,
      reason: null,
      steps: [{ state: 'completed', at: endedAt, actor: 'fixture' }],
      partial_outputs: [],
      inflight: [],
      pending_approvals: [],
      confirmation_message_id: null,
      previous_coordinator: before,
    } as never,
  ];
  return copy;
}

function acceptedFlow(label: string): { flow: Flow; reported: Message } {
  const flow = makeFlow(label);
  assign(flow, { subtask: 'work' });
  const reported = report(flow, { subtask: 'work' });
  answer(flow, { subtask: 'work', reportMessage: reported });
  return { flow, reported };
}

const TWO = plan([node('work'), node('next', { depends_on: ['work'] })]);

function evaluateOn(flow: Flow, record: TaskRecord, planValue: unknown) {
  return evaluateWorkPlan({
    plan: planValue,
    record,
    messages: flow.messages,
  });
}

test('after a succession the predecessor acceptance applied before the handoff still counts', () => {
  const { flow } = acceptedFlow('succession-accept-before');
  try {
    const record = succeeded(flow.record(), '2026-10-21T00:00:00Z');
    const result = evaluateOn(flow, record, TWO);
    assert.equal(statusOf(result, 'work'), 'accepted');
    assert.equal(statusOf(result, 'next'), 'ready');
    assert.ok(!codesOf(result, 'next').includes('dependency_not_accepted'));
    assert.ok(!codesOf(result, 'next').includes('acceptance_stale'));
  } finally {
    flow.cleanup();
  }
});

test('after a succession an acceptance applied after its epoch ended is stale', () => {
  const { flow } = acceptedFlow('succession-accept-after');
  try {
    const record = succeeded(flow.record(), '2026-10-19T00:00:00Z');
    const result = evaluateOn(flow, record, TWO);
    assert.ok(codesOf(result, 'next').length > 0);
    assert.ok(
      JSON.stringify(ok(result).nodes).includes('acceptance_stale'),
      JSON.stringify(ok(result).nodes),
    );
  } finally {
    flow.cleanup();
  }
});

test('after a succession an acceptance not signed by that epoch coordinator is refused', () => {
  const { flow } = acceptedFlow('succession-accept-signer');
  try {
    const other: Identity = {
      agent_id: 'someone-else',
      session_id: 'other-session',
      harness: 'pi',
    };
    const record = succeeded(flow.record(), '2026-10-21T00:00:00Z', {
      handedOffBy: other,
    });
    const result = evaluateOn(flow, record, TWO);
    assert.ok(
      JSON.stringify(ok(result).nodes).includes('acceptance_not_coordinator'),
      JSON.stringify(ok(result).nodes),
    );
  } finally {
    flow.cleanup();
  }
});

test('a plan epoch outside the lineage is never current, with or without succession', () => {
  const { flow } = acceptedFlow('succession-plan-epoch');
  try {
    const record = succeeded(flow.record(), '2026-10-21T00:00:00Z');
    const result = evaluateOn(
      flow,
      record,
      plan([node('work')], { owner_epoch: 5 }),
    );
    assert.deepEqual(codesOf(result, 'work'), ['owner_epoch_mismatch']);
  } finally {
    flow.cleanup();
  }
});

test('an invalid lineage falls back to strict epoch equality', () => {
  const { flow } = acceptedFlow('succession-invalid');
  try {
    const record = succeeded(flow.record(), '2026-10-21T00:00:00Z');
    record.handoffs![record.handoffs!.length - 1]!.steps = [];
    const result = evaluateOn(flow, record, TWO);
    assert.deepEqual(codesOf(result, 'work'), ['owner_epoch_mismatch']);
  } finally {
    flow.cleanup();
  }
});

test('with no succession on record the evaluation is the one it always was', () => {
  const { flow } = acceptedFlow('succession-none');
  try {
    const record = flow.record();
    assert.deepEqual(
      shapeOf(evaluateOn(flow, record, TWO)),
      shapeOf(evaluate(flow, TWO)),
    );
    assert.deepEqual(
      codesOf(
        evaluateOn(flow, record, plan([node('work')], { owner_epoch: 2 })),
        'work',
      ),
      ['owner_epoch_mismatch'],
    );
  } finally {
    flow.cleanup();
  }
});
