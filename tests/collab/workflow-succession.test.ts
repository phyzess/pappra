import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyAccept,
  applyAdopt,
  currentBindingFile,
  type WorkflowAdoptRequest,
  applyParticipant,
  applyPrepare,
  type WorkflowAcceptRequest,
  type WorkflowParticipantRequest,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import { readCoordinatorHandoffCheck } from '../../src/app/collab-handoff.js';
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

async function boundFixture(label: string) {
  const fixture = makeTaskDomain(label, ['cohort'], { initialize: [] });
  const prepared = await applyPrepare(
    prepareRequest(
      fixture.domainRoot,
      fixture.root,
      baseAssignments(fixture.root),
      [
        {
          agent_id: COORDINATOR.agent_id,
          pane_id: 'w1:p1',
          native_session_id: COORDINATOR.session_id,
        },
        {
          agent_id: WRITER_A.agent_id,
          pane_id: 'w1:p2',
          native_session_id: WRITER_A.session_id,
        },
        {
          agent_id: WRITER_B.agent_id,
          pane_id: 'w1:p3',
          native_session_id: WRITER_B.session_id,
        },
        {
          agent_id: REVIEWER.agent_id,
          pane_id: 'w1:p4',
          native_session_id: REVIEWER.session_id,
        },
      ],
    ),
  );
  assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
  const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
  const adopt = (
    overrides: Partial<WorkflowAdoptRequest> = {},
  ): WorkflowAdoptRequest => ({
    schema: 'pappra/collab-workflow-adopt-request/1',
    task_root: taskRoot,
    caller: { ...NEXT, cwd: fixture.root },
    caller_pane: 'w1:p9',
    ...overrides,
  });
  const observed = async () => ({
    ok: true as const,
    agents: [
      {
        name: 'next-agent',
        harness: NEXT.harness,
        paneId: 'w1:p9',
        cwd: fixture.root,
        sessionKind: 'id',
        sessionValue: NEXT.session_id,
        status: 'idle',
        focused: true,
      },
    ],
  });
  return { fixture, taskRoot, adopt, observed };
}

test('adopt writes the next binding generation and routing follows it', async () => {
  const { fixture, taskRoot, adopt, observed } = await boundFixture('adopt-ok');
  try {
    assert.equal(currentBindingFile(taskRoot), join(taskRoot, 'binding.json'));
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    // Not adopted yet: routing still reads the sealed generation.
    assert.equal(currentBindingFile(taskRoot), join(taskRoot, 'binding.json'));
    const planned = await applyAdopt(adopt(), {
      apply: false,
      listAgents: observed,
    });
    assert.equal(planned.status, 'planned', JSON.stringify(planned.blockers));
    assert.equal(existsSync(join(taskRoot, 'binding.e2.json')), false);
    const applied = await applyAdopt(adopt(), { listAgents: observed });
    assert.equal(applied.status, 'applied', JSON.stringify(applied.blockers));
    const file = join(taskRoot, 'binding.e2.json');
    assert.equal(currentBindingFile(taskRoot), file);
    const generation = JSON.parse(readFileSync(file, 'utf8')) as {
      participants: { agent_id: string; pane_id: string }[];
    };
    assert.deepEqual(
      generation.participants.map((item) => [item.agent_id, item.pane_id]),
      [
        [WRITER_A.agent_id, 'w1:p2'],
        [WRITER_B.agent_id, 'w1:p3'],
        [REVIEWER.agent_id, 'w1:p4'],
        [NEXT.agent_id, 'w1:p9'],
      ],
    );
    const again = await applyAdopt(adopt(), { listAgents: observed });
    assert.equal(again.status, 'applied');
  } finally {
    fixture.cleanup();
  }
});

test('adopt refuses a non-coordinator, a missing succession and an unobserved pane', async () => {
  const { fixture, taskRoot, adopt, observed } = await boundFixture('adopt-no');
  try {
    const none = await applyAdopt(
      adopt({ caller: { ...COORDINATOR, cwd: fixture.root } }),
      { listAgents: observed },
    );
    assert.deepEqual(
      none.blockers.map((item) => item.code),
      ['adopt_no_succession'],
    );
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const stranger = await applyAdopt(
      adopt({ caller: { ...WRITER_A, cwd: fixture.root } }),
      { listAgents: observed },
    );
    assert.ok(
      stranger.blockers.some((item) => item.code === 'adopt_not_coordinator'),
    );
    const wrongPane = await applyAdopt(adopt({ caller_pane: 'w1:p7' }), {
      listAgents: observed,
    });
    assert.ok(
      wrongPane.blockers.some((item) => item.code === 'adopt_pane_unobserved'),
    );
    const unavailable = await applyAdopt(adopt(), {
      listAgents: async () => ({
        ok: false as const,
        status: 'unavailable' as const,
        detail: 'no herdr',
      }),
    });
    assert.ok(
      unavailable.blockers.some(
        (item) => item.code === 'adopt_pane_unobserved',
      ),
    );
    assert.equal(existsSync(join(taskRoot, 'binding.e2.json')), false);
  } finally {
    fixture.cleanup();
  }
});

test('adopt refuses an invalid lineage and a task that uses an unsupported surface', async () => {
  const { fixture, taskRoot, adopt, observed } =
    await boundFixture('adopt-bad');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const broken = transact(taskRoot, {
      actor: 'fixture',
      purpose: 'break',
      apply: (record) => {
        record.handoffs[record.handoffs.length - 1]!.steps = [];
        return { record, op: 'break', summary: {}, result: { ok: true } };
      },
    });
    assert.ok(broken.ok);
    const invalid = await applyAdopt(adopt(), { listAgents: observed });
    assert.ok(
      invalid.blockers.some((item) => item.code === 'adopt_lineage_invalid'),
    );
    const restored = transact(taskRoot, {
      actor: 'fixture',
      purpose: 'restore',
      apply: (record) => {
        record.handoffs[record.handoffs.length - 1]!.steps = [
          { state: 'completed', at: '2099-01-01T00:00:00Z', actor: 'fixture' },
        ];
        (record as unknown as Record<string, unknown>)[
          'managed_pi_runtime_registry'
        ] = [{}];
        return { record, op: 'restore', summary: {}, result: { ok: true } };
      },
    });
    assert.ok(restored.ok);
    const unsupported = await applyAdopt(adopt(), { listAgents: observed });
    assert.ok(
      unsupported.blockers.some(
        (item) => item.code === 'adopt_unsupported_surface',
      ),
      JSON.stringify(unsupported.blockers),
    );
  } finally {
    fixture.cleanup();
  }
});

test('mid-cohort check blocks an attempt that was only assigned, and relaxes acknowledged ones', async () => {
  const fixture = makeTaskDomain('check-mid', ['cohort'], { initialize: [] });
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
    const codes = (value: Record<string, unknown>) =>
      (value['blockers'] as { code: string }[]).map((item) => item.code);

    const assigned = await readCoordinatorHandoffCheck(taskRoot, {
      mode: 'mid_cohort',
    });
    assert.ok(assigned.ok);
    assert.equal(assigned.value['status'], 'blocked');
    assert.equal(
      codes(assigned.value).filter(
        (code) => code === 'attempt_not_transferable',
      ).length,
      2,
    );

    for (const [writer, subtask] of [
      [WRITER_A, 'writer-one'],
      [WRITER_B, 'writer-two'],
    ] as const) {
      const acked = await applyParticipant(
        ackRequest(taskRoot, writer, subtask, 1),
        { notify: silentNotify },
      );
      assert.equal(acked.status, 'applied', JSON.stringify(acked.blockers));
    }
    // A confirmed native observation answers "registered but not started"; an ACK alone does not.
    const open = await readCoordinatorHandoffCheck(taskRoot, {
      mode: 'mid_cohort',
    });
    assert.ok(open.ok);
    assert.ok(
      (open.value['blockers'] as { code: string }[]).every(
        (item) =>
          item.code === 'attempt_not_transferable' ||
          item.code === 'claims_unreleased',
      ),
      JSON.stringify(open.value['blockers']),
    );
    const confirmed = transact(taskRoot, {
      actor: 'fixture',
      purpose: 'confirm',
      apply: (record) => {
        for (const item of record.uncertainty)
          item.resolved_at = '2026-10-28T00:00:00Z';
        return { record, op: 'confirm', summary: {}, result: { ok: true } };
      },
    });
    assert.ok(confirmed.ok);
    const running = await readCoordinatorHandoffCheck(taskRoot, {
      mode: 'mid_cohort',
    });
    assert.ok(running.ok);
    assert.equal(
      running.value['status'],
      'ready',
      JSON.stringify(running.value['blockers']),
    );
    assert.equal(running.value['mode'], 'mid_cohort');
    const relaxed = (running.value['relaxed'] as { code: string }[]).map(
      (item) => item.code,
    );
    assert.ok(relaxed.includes('attempt_in_flight'));
    assert.ok(relaxed.includes('claims_unreleased'));
    assert.ok(relaxed.includes('cohort_node_not_accepted'));

    // The boundary check keeps its meaning.
    const boundary = await readCoordinatorHandoffCheck(taskRoot);
    assert.ok(boundary.ok);
    assert.equal(boundary.value['status'], 'blocked');
    assert.ok(codes(boundary.value).includes('attempt_in_flight'));
  } finally {
    fixture.cleanup();
  }
});

test('mid-cohort check keeps blocking an unsupported surface and a needs_input attempt', async () => {
  const fixture = makeTaskDomain('check-mid-block', ['cohort'], {
    initialize: [],
  });
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
    for (const [writer, subtask] of [
      [WRITER_A, 'writer-one'],
      [WRITER_B, 'writer-two'],
    ] as const)
      assert.equal(
        (
          await applyParticipant(ackRequest(taskRoot, writer, subtask, 1), {
            notify: silentNotify,
          })
        ).status,
        'applied',
      );
    const marked = transact(taskRoot, {
      actor: 'fixture',
      purpose: 'surface',
      apply: (record) => {
        (record as unknown as Record<string, unknown>)[
          'managed_pi_runtime_registry'
        ] = [{}];
        const attempt = record.attempts.find(
          (item) => item.subtask_id === 'writer-two',
        )!;
        attempt.state = 'needs_input';
        return { record, op: 'surface', summary: {}, result: { ok: true } };
      },
    });
    assert.ok(marked.ok);
    const result = await readCoordinatorHandoffCheck(taskRoot, {
      mode: 'mid_cohort',
    });
    assert.ok(result.ok);
    const codes = (result.value['blockers'] as { code: string }[]).map(
      (item) => item.code,
    );
    assert.equal(result.value['status'], 'blocked');
    assert.ok(codes.includes('adopt_unsupported_surface'));
    assert.ok(codes.includes('attempt_needs_input'));
  } finally {
    fixture.cleanup();
  }
});

test('adopt refuses instead of truncating a full binding, and a malformed generation never routes', async () => {
  const { fixture, taskRoot, adopt, observed } =
    await boundFixture('adopt-full');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    // A generation that is not a valid binding is not a usable generation.
    writeFileSync(join(taskRoot, 'binding.e2.json'), '{"nope":true}\n');
    assert.equal(currentBindingFile(taskRoot), join(taskRoot, 'binding.json'));
    rmSync(join(taskRoot, 'binding.e2.json'));
    // Fill the sealed binding to the cap so the successor entry would not fit.
    const sealed = join(taskRoot, 'binding.json');
    const document = JSON.parse(readFileSync(sealed, 'utf8')) as {
      participants: Record<string, unknown>[];
    };
    for (let index = document.participants.length; index < 16; index += 1)
      document.participants.push({
        agent_id: `filler-${index}`,
        harness: 'pi',
        cwd: fixture.root,
        herdr_agent: `filler-${index}`,
        pane_id: `w1:p${20 + index}`,
        native_session_id: null,
      });
    writeFileSync(sealed, `${JSON.stringify(document, null, 2)}\n`);
    const refused = await applyAdopt(adopt(), { listAgents: observed });
    // The previous coordinator is dropped, so one slot frees up and adoption still fits.
    assert.equal(refused.status, 'applied', JSON.stringify(refused.blockers));
    rmSync(join(taskRoot, 'binding.e2.json'));
    // If the previous coordinator also holds an attempt its entry stays and the binding is full.
    const kept = transact(taskRoot, {
      actor: 'fixture',
      purpose: 'worker',
      apply: (record) => {
        record.attempts[0]!.assignee = {
          agent_id: COORDINATOR.agent_id,
          session_id: COORDINATOR.session_id,
          harness: COORDINATOR.harness,
        };
        return { record, op: 'worker', summary: {}, result: { ok: true } };
      },
    });
    assert.ok(kept.ok);
    const full = await applyAdopt(adopt(), { listAgents: observed });
    assert.ok(
      full.blockers.some((item) => item.code === 'adopt_binding_full'),
      JSON.stringify(full.blockers),
    );
    assert.equal(existsSync(join(taskRoot, 'binding.e2.json')), false);
  } finally {
    fixture.cleanup();
  }
});

test('accept and dispatch warn, never refuse, before the successor adopts', async () => {
  const { fixture, taskRoot, accept } = await reportedFixture('succ-warn');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const decision = await applyAccept(accept(NEXT), { notify: silentNotify });
    assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
    assert.ok(
      decision.warnings.some((item) => item.includes('not adopted')),
      JSON.stringify(decision.warnings),
    );
  } finally {
    fixture.cleanup();
  }
});

test('a Codex coordinator is adopted by its thread id and the pane the launcher recorded, never by a Herdr listing', async () => {
  const { fixture, taskRoot, adopt } = await boundFixture('adopt-codex');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const codex = transact(taskRoot, {
      actor: 'fixture',
      purpose: 'codex',
      apply: (record) => {
        record.coordinator!.harness = 'codex';
        return { record, op: 'codex', summary: {}, result: { ok: true } };
      },
    });
    assert.ok(codex.ok);
    // A sandboxed Codex shell cannot reach Herdr: listing must not be needed.
    const unreachable = async () => {
      throw new Error('Herdr must not be consulted for a Codex coordinator');
    };
    const request = adopt({
      caller: { ...NEXT, harness: 'codex', cwd: fixture.root },
      caller_pane: 'w1:p9',
    });
    const record = (pane: string, session: string) => {
      mkdirSync(join(taskRoot, 'successor'), { recursive: true });
      writeFileSync(
        join(taskRoot, 'successor', 'req1.outcome.json'),
        JSON.stringify({
          schema: 'pappra/collab-successor-outcome/1',
          request_id: 'req1',
          request_digest: `sha256:${'a'.repeat(64)}`,
          recorded_at: '2026-10-28T00:00:00Z',
          status: 'launched',
          pane_id: pane,
          agent_name: 'next-agent',
          identity: {
            agent_id: NEXT.agent_id,
            session_id: session,
            harness: 'codex',
            cwd: fixture.root,
          },
          evidence: null,
          detail: null,
        }),
      );
    };
    const unrecorded = await applyAdopt(request, {
      listAgents: unreachable,
      callerCodexThread: NEXT.session_id,
    });
    assert.ok(
      unrecorded.blockers.some((item) => item.code === 'adopt_pane_unobserved'),
    );
    record('w1:p7', NEXT.session_id);
    const otherPane = await applyAdopt(request, {
      listAgents: unreachable,
      callerCodexThread: NEXT.session_id,
    });
    assert.ok(
      otherPane.blockers.some((item) => item.code === 'adopt_pane_unobserved'),
    );
    // An outcome for another thread, and a schema-invalid one, are skipped: still unrecorded.
    writeFileSync(
      join(taskRoot, 'successor', 'req2.outcome.json'),
      '{"nope":1}\n',
    );
    record('w1:p9', 'another-thread');
    const elsewhere = await applyAdopt(request, {
      listAgents: unreachable,
      callerCodexThread: NEXT.session_id,
    });
    assert.ok(
      elsewhere.blockers.some((item) => item.code === 'adopt_pane_unobserved'),
    );
    record('w1:p9', NEXT.session_id);
    // Two launches of the same thread that disagree on the pane are ambiguous.
    writeFileSync(
      join(taskRoot, 'successor', 'req3.outcome.json'),
      readFileSync(join(taskRoot, 'successor', 'req1.outcome.json'), 'utf8')
        .replace('"request_id":"req1"', '"request_id":"req3"')
        .replace('"pane_id":"w1:p9"', '"pane_id":"w1:p8"'),
    );
    const ambiguous = await applyAdopt(request, {
      listAgents: unreachable,
      callerCodexThread: NEXT.session_id,
    });
    assert.ok(
      ambiguous.blockers.some((item) => item.code === 'adopt_pane_unobserved'),
    );
    rmSync(join(taskRoot, 'successor', 'req3.outcome.json'));
    const wrongThread = await applyAdopt(request, {
      listAgents: unreachable,
      callerCodexThread: 'some-other-thread',
    });
    assert.ok(
      wrongThread.blockers.some(
        (item) => item.code === 'adopt_pane_unobserved',
      ),
    );
    const right = await applyAdopt(request, {
      listAgents: unreachable,
      callerCodexThread: NEXT.session_id,
    });
    assert.equal(right.status, 'applied', JSON.stringify(right.blockers));
    const generation = JSON.parse(
      readFileSync(join(taskRoot, 'binding.e2.json'), 'utf8'),
    ) as {
      participants: {
        agent_id: string;
        herdr_agent: string;
        pane_id: string;
      }[];
    };
    const entry = generation.participants.find(
      (item) => item.agent_id === NEXT.agent_id,
    );
    assert.deepEqual(
      [entry?.herdr_agent, entry?.pane_id],
      ['next-agent', 'w1:p9'],
    );
  } finally {
    fixture.cleanup();
  }
});
