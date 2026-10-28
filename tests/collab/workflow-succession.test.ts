import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyAccept,
  applyParticipant,
  applyPrepare,
  type WorkflowAcceptRequest,
  type WorkflowParticipantRequest,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import { transact } from '../../src/collab/store.js';
import { notifyRegisteredMessage } from '../../src/app/collab-notify.js';
import { makeTaskDomain } from './task-resources-fixtures.js';
import { owner } from './scenarios.js';

const COORDINATOR = {
  agent_id: owner.agent_id,
  session_id: owner.session_id,
  harness: owner.harness,
  owner_epoch: owner.owner_epoch,
  since: owner.since,
};

const WRITER_A = {
  agent_id: 'writer-a',
  session_id: 'writer-a-session',
  harness: 'pi',
  surface: 'cli',
  configuration_id: 'daily-visible',
};

const WRITER_B = {
  agent_id: 'writer-b',
  session_id: 'writer-b-session',
  harness: 'pi',
  surface: 'cli',
  configuration_id: 'daily-visible',
};

const REVIEWER = {
  agent_id: 'reviewer',
  session_id: 'reviewer-session',
  harness: 'pi',
  surface: 'cli',
  configuration_id: 'daily-visible',
};

/** Delivery stub: these unit tests assert protocol state, not the Herdr transport. */
const silentNotify = (async (options: { messageId: string }) => ({
  ok: true as const,
  value: {
    status: 'submitted' as const,
    messageId: options.messageId,
    detail: null,
    consumed: false as const,
    taskAccepted: false as const,
  },
})) as unknown as (
  options: Parameters<typeof notifyRegisteredMessage>[0],
) => ReturnType<typeof notifyRegisteredMessage>;

function participant(
  base: typeof WRITER_A,
  cwd: string,
): typeof WRITER_A & { cwd: string } {
  return { ...base, cwd };
}

function prepareRequest(
  domainRoot: string,
  cwd: string,
  assignments: WorkflowPrepareRequest['assignments'],
  bindings: WorkflowPrepareRequest['bindings'] = [],
): WorkflowPrepareRequest {
  return {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: domainRoot,
    task_id: 'cohort',
    goal: {
      objective: 'Build the sample cohort.',
      input_ref: null,
      input_digest: null,
    },
    coordinator: {
      ...COORDINATOR,
      cwd,
      surface: 'cli',
      configuration_id: 'daily-visible',
    },
    participants: [
      {
        agent_id: COORDINATOR.agent_id,
        session_id: COORDINATOR.session_id,
        harness: COORDINATOR.harness,
        cwd,
        surface: 'cli',
        configuration_id: 'daily-visible',
      },
      participant(WRITER_A, cwd),
      participant(WRITER_B, cwd),
      participant(REVIEWER, cwd),
    ],
    bindings,
    assignments,
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  } satisfies WorkflowPrepareRequest;
}

function writerAssignment(
  subtask: string,
  assignee: string,
  resources: { path: string; access: 'read' | 'write' }[],
  role: 'writer' | 'reviewer' = 'writer',
) {
  return {
    subtask_id: subtask,
    role,
    assignee,
    objective: `Objective for ${subtask}.`,
    acceptance: [`Acceptance for ${subtask}.`],
    resources,
    required_skills: [],
    required_tools: [],
    native_evidence: [],
  };
}

function baseAssignments(root: string) {
  return [
    writerAssignment('writer-one', WRITER_A.agent_id, [
      { path: join(root, 'a'), access: 'write' as const },
    ]),
    writerAssignment('writer-two', WRITER_B.agent_id, [
      { path: join(root, 'b'), access: 'write' as const },
    ]),
    writerAssignment(
      'review',
      REVIEWER.agent_id,
      [{ path: join(root, 'a'), access: 'read' as const }],
      'reviewer',
    ),
  ];
}

function ackRequest(
  taskRoot: string,
  caller: { agent_id: string; session_id: string; harness: string },
  subtaskId: string,
  attempt: number,
): WorkflowParticipantRequest {
  return {
    schema: 'pappra/collab-workflow-participant-request/1',
    action: 'ack',
    task_root: taskRoot,
    caller: { ...caller, cwd: taskRoot },
    subtask_id: subtaskId,
    attempt,
    caller_pane: null,
    report: null,
    release: null,
  };
}

function reportRequest(
  taskRoot: string,
  caller: { agent_id: string; session_id: string; harness: string },
  subtaskId: string,
  attempt: number,
  outputs: string[],
  status: 'completed' | 'needs_input' = 'completed',
): WorkflowParticipantRequest {
  return {
    schema: 'pappra/collab-workflow-participant-request/1',
    action: 'report',
    task_root: taskRoot,
    caller: { ...caller, cwd: taskRoot },
    subtask_id: subtaskId,
    attempt,
    caller_pane: null,
    report: {
      status,
      summary: 'Reported outcome.',
      blockers:
        status === 'needs_input' ? ['A concrete missing observation.'] : [],
      outputs,
    },
    release: null,
  };
}

const NEXT = {
  agent_id: 'next-coordinator',
  session_id: 'next-session',
  harness: 'claude',
};

/** Installs one completed coordinator handoff on disk, ending epoch 1 at `endedAt`. */
function succeed(taskRoot: string, endedAt: string): void {
  const done = transact(taskRoot, {
    actor: 'fixture',
    purpose: 'succeed',
    apply: (record) => {
      const before = {
        agent_id: COORDINATOR.agent_id,
        session_id: COORDINATOR.session_id,
        owner_epoch: 1,
      };
      record.coordinator = {
        ...NEXT,
        owner_epoch: 2,
        since: endedAt,
        previous: before,
      } as never;
      record.handoffs = [
        ...(record.handoffs ?? []),
        {
          schema: 'harness-collab/handoff/1',
          handoff_id: 'h1',
          kind: 'coordinator',
          subtask_id: null,
          attempt: null,
          from: COORDINATOR,
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
          previous_coordinator: { ...COORDINATOR, ...before },
        } as never,
      ];
      return { record, op: 'succeed', summary: {}, result: { ok: true } };
    },
  });
  assert.ok(done.ok);
}

async function reportedFixture(label: string) {
  const fixture = makeTaskDomain(label, ['cohort'], { initialize: [] });
  const prepared = await applyPrepare(
    prepareRequest(
      fixture.domainRoot,
      fixture.root,
      baseAssignments(fixture.root),
    ),
  );
  assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
  const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
  mkdirSync(join(fixture.root, 'a'), { recursive: true });
  const inside = join(fixture.root, 'a', 'output.txt');
  writeFileSync(inside, 'built\n');
  const reported = await applyParticipant(
    reportRequest(taskRoot, WRITER_A, 'writer-one', 1, [inside]),
    { notify: silentNotify },
  );
  assert.equal(reported.status, 'applied', JSON.stringify(reported.blockers));
  const accept = (
    caller: typeof COORDINATOR | typeof NEXT,
  ): WorkflowAcceptRequest => ({
    schema: 'pappra/collab-workflow-accept-request/1',
    task_root: taskRoot,
    caller: { ...caller, cwd: fixture.root },
    subtask_id: 'writer-one',
    attempt: 1,
    report_message_id: reported.messages[0]!.message_id,
    caller_pane: null,
    reason: 'Looks complete.',
  });
  return { fixture, taskRoot, accept };
}

test('after a succession the successor decides a report made under the earlier epoch', async () => {
  const { fixture, taskRoot, accept } = await reportedFixture('succ-accept');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const decision = await applyAccept(accept(NEXT), { notify: silentNotify });
    assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
    assert.equal(decision.messages[0]?.message_id, 'accept-writer-one-1');
    const again = await applyAccept(accept(NEXT), { notify: silentNotify });
    assert.ok(
      again.blockers.some((item) => item.code === 'acceptance_already_decided'),
      JSON.stringify(again.blockers),
    );
  } finally {
    fixture.cleanup();
  }
});

test('a valid applied decision of the earlier coordinator is final for the successor', async () => {
  const { fixture, taskRoot, accept } = await reportedFixture('succ-final');
  try {
    const first = await applyAccept(accept(COORDINATOR), {
      notify: silentNotify,
    });
    assert.equal(first.status, 'applied', JSON.stringify(first.blockers));
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const refused = await applyAccept(accept(NEXT), { notify: silentNotify });
    assert.equal(refused.status, 'refused');
    assert.ok(
      refused.blockers.some(
        (item) => item.code === 'acceptance_already_decided',
      ),
      JSON.stringify(refused.blockers),
    );
  } finally {
    fixture.cleanup();
  }
});

test('a decision applied after its epoch ended does not block the successor, whose id is epoch-qualified', async () => {
  const { fixture, taskRoot, accept } = await reportedFixture('succ-late');
  try {
    const first = await applyAccept(accept(COORDINATOR), {
      notify: silentNotify,
    });
    assert.equal(first.status, 'applied', JSON.stringify(first.blockers));
    // The handoff completed before that decision was applied.
    succeed(taskRoot, '2020-01-01T00:00:00Z');
    const decision = await applyAccept(accept(NEXT), { notify: silentNotify });
    assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
    assert.equal(decision.messages[0]?.message_id, 'accept-writer-one-1-e2');
  } finally {
    fixture.cleanup();
  }
});

test('with no succession the accept id is never epoch-qualified', async () => {
  const { fixture, accept } = await reportedFixture('succ-none');
  try {
    const decision = await applyAccept(accept(COORDINATOR), {
      notify: silentNotify,
    });
    assert.equal(decision.messages[0]?.message_id, 'accept-writer-one-1');
  } finally {
    fixture.cleanup();
  }
});

test('after a succession an identical worker ACK addressed to the earlier coordinator is a duplicate', async () => {
  const fixture = makeTaskDomain('succ-ack', ['cohort'], { initialize: [] });
  try {
    const prepared = await applyPrepare(
      prepareRequest(
        fixture.domainRoot,
        fixture.root,
        baseAssignments(fixture.root),
      ),
    );
    assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
    const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
    const acked = await applyParticipant(
      ackRequest(taskRoot, WRITER_A, 'writer-one', 1),
      { notify: silentNotify },
    );
    assert.equal(acked.status, 'applied', JSON.stringify(acked.blockers));
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const again = await applyParticipant(
      ackRequest(taskRoot, WRITER_A, 'writer-one', 1),
      { notify: silentNotify },
    );
    assert.equal(again.status, 'applied', JSON.stringify(again.blockers));
    assert.equal(again.messages[0]?.duplicate, true);
    assert.equal(
      again.messages[0]?.registration,
      'registered-to-earlier-coordinator',
    );
  } finally {
    fixture.cleanup();
  }
});

function releaseRequest(
  taskRoot: string,
  correlatesTo: string,
): WorkflowParticipantRequest {
  return {
    schema: 'pappra/collab-workflow-participant-request/1',
    action: 'release',
    task_root: taskRoot,
    caller: { ...WRITER_A, cwd: taskRoot },
    subtask_id: 'writer-one',
    attempt: 1,
    caller_pane: null,
    report: null,
    release: {
      reason: 'finished',
      cancel_attempt: false,
      correlates_to: correlatesTo,
    },
  };
}

test('a release may answer a decision made under the earlier epoch, applied before it ended', async () => {
  const { fixture, taskRoot, accept } = await reportedFixture('succ-release');
  try {
    const first = await applyAccept(accept(COORDINATOR), {
      notify: silentNotify,
    });
    assert.equal(first.status, 'applied', JSON.stringify(first.blockers));
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const released = await applyParticipant(
      releaseRequest(taskRoot, 'accept-writer-one-1'),
      { notify: silentNotify },
    );
    assert.ok(
      !released.blockers.some((item) =>
        item.code.startsWith('release_correlation'),
      ),
      JSON.stringify(released.blockers),
    );
  } finally {
    fixture.cleanup();
  }
});

test('a release cannot answer a decision applied after its epoch ended', async () => {
  const { fixture, taskRoot, accept } =
    await reportedFixture('succ-release-late');
  try {
    const first = await applyAccept(accept(COORDINATOR), {
      notify: silentNotify,
    });
    assert.equal(first.status, 'applied', JSON.stringify(first.blockers));
    succeed(taskRoot, '2000-01-01T00:00:00Z');
    const released = await applyParticipant(
      releaseRequest(taskRoot, 'accept-writer-one-1'),
      { notify: silentNotify },
    );
    assert.equal(released.status, 'refused');
    assert.ok(
      released.blockers.some(
        (item) => item.code === 'release_correlation_sender',
      ),
      JSON.stringify(released.blockers),
    );
  } finally {
    fixture.cleanup();
  }
});
