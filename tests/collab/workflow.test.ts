import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyAccept,
  applyDispatch,
  applyParticipant,
  applyPrepare,
  inspectWorkflow,
  planDispatch,
  planPrepare,
  type WorkflowAcceptRequest,
  type WorkflowDispatchRequest,
  type WorkflowParticipantRequest,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import {
  parseWorkflowPrepareRequest,
  workflowAssignmentPath,
} from '../../src/schemas/collab-workflow.js';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { claimResources } from '../../src/collab/resources.js';
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

function dispatchRequest(
  taskRoot: string,
  cards: WorkflowDispatchRequest['capability_targets'],
): WorkflowDispatchRequest {
  return {
    schema: 'pappra/collab-workflow-dispatch-request/1',
    task_root: taskRoot,
    caller: { ...COORDINATOR, cwd: taskRoot },
    caller_pane: 'w3:p3B',
    capability_targets: cards,
    subtasks: ['writer-one'],
    activate_deferred: false,
    max_age_minutes: 30,
  };
}

function capabilityCard(
  cwd: string,
  evidence: { ref: string; digest: string },
): Record<string, unknown> {
  return {
    schema: 'harness-collab/capabilities/1',
    agent_id: WRITER_A.agent_id,
    session_id: WRITER_A.session_id,
    harness: WRITER_A.harness,
    surface: WRITER_A.surface,
    configuration_id: WRITER_A.configuration_id,
    cwd,
    observed_at: new Date().toISOString(),
    evidence_level: 'runtime',
    evidence_records: [evidence],
    skills: [],
    tools: [],
  };
}

function fileDigest(file: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

test('workflow prepare plan derives the cohort and writes nothing', () => {
  const fixture = makeTaskDomain('workflow-plan', ['cohort'], {
    initialize: [],
  });
  try {
    const request = prepareRequest(
      fixture.domainRoot,
      fixture.root,
      baseAssignments(fixture.root),
    );
    const planned = planPrepare(request);
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.equal(planned.value.plan.assignments.length, 3);
    assert.equal(planned.value.plan.assignments[2]?.deferred, true);
    // A plan is genuinely read-only: no task root, no sealed documents.
    assert.equal(
      existsSync(join(fixture.domainRoot, 'tasks', 'cohort')),
      false,
    );
    assert.equal(planned.value.plan.blockers.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('workflow prepare apply seals deterministic artifacts and reruns idempotently', async () => {
  const fixture = makeTaskDomain('workflow-apply', ['cohort'], {
    initialize: [],
  });
  try {
    const request = prepareRequest(
      fixture.domainRoot,
      fixture.root,
      baseAssignments(fixture.root),
    );
    const first = await applyPrepare(request);
    assert.equal(first.status, 'applied', JSON.stringify(first.blockers));
    // Writers are registered; the reviewer stays deferred.
    // Writers are registered; the deferred reviewer gets a sealed document, not an ASSIGN.
    assert.deepEqual(
      [...new Set(first.messages.map((item) => item.message_id))].sort(),
      ['assign-writer-one', 'assign-writer-two'],
    );
    assert.ok(first.claims.length >= 2);
    const assignmentFile = workflowAssignmentPath(
      join(fixture.domainRoot, 'tasks', 'cohort'),
      'review',
    );
    assert.equal(
      existsSync(assignmentFile),
      true,
      'reviewer document is sealed',
    );
    const sealedBefore = readFileSync(assignmentFile, 'utf8');

    const inspected = await inspectWorkflow(
      join(fixture.domainRoot, 'tasks', 'cohort'),
    );
    assert.equal(inspected.ok, true);
    assert.deepEqual(
      (inspected.detail?.['deferred'] as { subtask_id: string }[]).map(
        (item) => item.subtask_id,
      ),
      ['review'],
    );

    const second = await applyPrepare(request);
    assert.equal(second.status, 'applied');
    assert.ok(
      second.messages.every((item) => item.duplicate),
      'a rerun is a protocol duplicate, never a second ASSIGN',
    );
    assert.deepEqual(
      second.claims.map((item) => item.claim_id).sort(),
      first.claims.map((item) => item.claim_id).sort(),
      'claims are reused',
    );
    assert.equal(readFileSync(assignmentFile, 'utf8'), sealedBefore);
  } finally {
    fixture.cleanup();
  }
});

test('workflow prepare canonicalizes duplicate declarations into one claim', async () => {
  const fixture = makeTaskDomain('workflow-duplicate', ['cohort'], {
    initialize: [],
  });
  try {
    const target = join(fixture.root, 'a');
    const parsed = parseWorkflowPrepareRequest(
      prepareRequest(fixture.domainRoot, fixture.root, [
        writerAssignment('writer-one', WRITER_A.agent_id, [
          { path: target, access: 'write' },
          { path: target, access: 'write' },
        ]),
      ]),
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.assignments[0]?.resources.length, 1);
    const applied = await applyPrepare(parsed.value);
    assert.equal(applied.status, 'applied', JSON.stringify(applied.blockers));
    // Claims are keyed by a canonical resource key (prefixed and lower-cased), not by the
    // raw declaration string, so match the declared suffix instead of inventing a format.
    const pathClaims = applied.claims.filter((claim) =>
      claim.key.toLowerCase().endsWith('/a'),
    );
    assert.equal(pathClaims.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('workflow prepare refuses conflicting declarations with no side effect', () => {
  const fixture = makeTaskDomain('workflow-conflict', ['cohort'], {
    initialize: [],
  });
  try {
    const target = join(fixture.root, 'a');
    const parsed = parseWorkflowPrepareRequest(
      prepareRequest(fixture.domainRoot, fixture.root, [
        writerAssignment('writer-one', WRITER_A.agent_id, [
          { path: target, access: 'write' },
          { path: target, access: 'read' },
        ]),
      ]),
    );
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.code, 'resource_declaration_conflict');
    assert.equal(
      existsSync(join(fixture.domainRoot, 'tasks', 'cohort')),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('workflow prepare refuses overlapping writer scopes before any effect', async () => {
  const fixture = makeTaskDomain('workflow-overlap', ['cohort'], {
    initialize: [],
  });
  try {
    const shared = join(fixture.root, 'shared');
    const request = prepareRequest(fixture.domainRoot, fixture.root, [
      writerAssignment('writer-one', WRITER_A.agent_id, [
        { path: join(shared, 'one'), access: 'write' },
      ]),
      writerAssignment('writer-two', WRITER_B.agent_id, [
        { path: shared, access: 'write' },
      ]),
    ]);
    const planned = planPrepare(request);
    assert.equal(planned.ok, false);
    if (planned.ok) return;
    assert.equal(planned.code, 'assignment_scope_overlap');
    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'invalid');
    assert.equal(
      existsSync(join(fixture.domainRoot, 'tasks', 'cohort')),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('workflow prepare reports a cross-task claim conflict and writes nothing', async () => {
  const fixture = makeTaskDomain(
    'workflow-domain-conflict',
    ['cohort', 'other'],
    {
      initialize: ['other'],
    },
  );
  try {
    const shared = join(fixture.root, 'shared');
    const otherRoot = fixture.tasks['other']!;
    const claimed = claimResources(otherRoot, {
      resources: [{ path: shared }],
      access: 'write',
      holder: {
        agent_id: 'other-writer',
        session_id: 'other-session',
        harness: 'pi',
      },
    });
    assert.equal(claimed.ok, true);
    const request = prepareRequest(fixture.domainRoot, fixture.root, [
      writerAssignment('writer-one', WRITER_A.agent_id, [
        { path: shared, access: 'write' },
      ]),
    ]);
    const planned = planPrepare(request);
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.ok(
      planned.value.plan.blockers.some(
        (item) => item.code === 'resource_conflict',
      ),
      JSON.stringify(planned.value.plan.blockers),
    );
    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'blocked');
    assert.equal(
      existsSync(join(fixture.domainRoot, 'tasks', 'cohort')),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('workflow participant actions are self-call only and never assume an attempt', async () => {
  const fixture = makeTaskDomain('workflow-participant', ['cohort'], {
    initialize: [],
  });
  try {
    const request = prepareRequest(
      fixture.domainRoot,
      fixture.root,
      baseAssignments(fixture.root),
    );
    const prepared = await applyPrepare(request);
    assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
    const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');

    const wrong = await applyParticipant(
      ackRequest(taskRoot, WRITER_B, 'writer-one', 1),
      { notify: silentNotify },
    );
    assert.equal(wrong.status, 'refused');
    assert.equal(wrong.blockers[0]?.code, 'sender_denied');

    const missing = await applyParticipant(
      ackRequest(taskRoot, WRITER_A, 'writer-one', 9),
      { notify: silentNotify },
    );
    assert.equal(missing.status, 'refused');
    assert.equal(missing.blockers[0]?.code, 'attempt_not_registered');

    const accepted = await applyParticipant(
      ackRequest(taskRoot, WRITER_A, 'writer-one', 1),
      { notify: silentNotify },
    );
    assert.equal(accepted.status, 'applied', JSON.stringify(accepted.blockers));
    assert.equal(accepted.messages[0]?.type, 'ACK');
  } finally {
    fixture.cleanup();
  }
});

test('workflow report digests only files inside the claimed write scope', async () => {
  const fixture = makeTaskDomain('workflow-report', ['cohort'], {
    initialize: [],
  });
  try {
    const request = prepareRequest(
      fixture.domainRoot,
      fixture.root,
      baseAssignments(fixture.root),
    );
    const prepared = await applyPrepare(request);
    assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
    const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
    const inside = join(fixture.root, 'a', 'output.txt');
    mkdirSync(join(fixture.root, 'a'), { recursive: true });
    writeFileSync(inside, 'built\n');
    const outside = join(fixture.root, 'outside.txt');
    writeFileSync(outside, 'not mine\n');

    const refused = await applyParticipant(
      reportRequest(taskRoot, WRITER_A, 'writer-one', 1, [outside]),
      { notify: silentNotify },
    );
    assert.equal(refused.status, 'refused');
    assert.ok(
      refused.blockers.some((item) => item.code === 'output_outside_claim'),
    );

    const reported = await applyParticipant(
      reportRequest(taskRoot, WRITER_A, 'writer-one', 1, [inside]),
      { notify: silentNotify },
    );
    assert.equal(reported.status, 'applied', JSON.stringify(reported.blockers));
    assert.equal(reported.detail?.outputs.length, 1);
    assert.match(
      reported.detail?.outputs[0]?.digest ?? '',
      /^sha256:[a-f0-9]{64}$/,
    );

    const inspected = await inspectWorkflow(taskRoot);
    const attempts = inspected.detail?.['attempts'] as {
      subtask_id: string;
      state: string;
      result: string | null;
    }[];
    const writerOne = attempts.find((item) => item.subtask_id === 'writer-one');
    assert.equal(writerOne?.state, 'completed');
    assert.equal(writerOne?.result, 'completed');
  } finally {
    fixture.cleanup();
  }
});

test('workflow acceptance is separate, explicit and never self-review', async () => {
  const fixture = makeTaskDomain('workflow-accept', ['cohort'], {
    initialize: [],
  });
  try {
    const request = prepareRequest(
      fixture.domainRoot,
      fixture.root,
      baseAssignments(fixture.root),
    );
    const prepared = await applyPrepare(request);
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
    const reportMessageId = reported.messages[0]!.message_id;

    const accept: WorkflowAcceptRequest = {
      schema: 'pappra/collab-workflow-accept-request/1',
      task_root: taskRoot,
      caller: { ...WRITER_A, cwd: fixture.root },
      subtask_id: 'writer-one',
      attempt: 1,
      report_message_id: reportMessageId,
      caller_pane: null,
      reason: 'Looks complete.',
    };
    const selfReview = await applyAccept(accept, { notify: silentNotify });
    assert.equal(selfReview.status, 'refused');
    assert.ok(
      selfReview.blockers.some(
        (item) => item.code === 'acceptance_self_review',
      ),
    );

    const decision = await applyAccept(
      { ...accept, caller: { ...COORDINATOR, cwd: fixture.root } },
      { notify: silentNotify },
    );
    assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
    assert.equal(decision.messages[0]?.type, 'ANSWER');
    const registered = JSON.parse(
      readFileSync(
        join(taskRoot, 'messages', `${decision.messages[0]!.message_id}.json`),
        'utf8',
      ),
    ) as { body: { acceptance: { decision: string; report_digest: string } } };
    assert.equal(registered.body.acceptance.decision, 'accepted');
    assert.match(registered.body.acceptance.report_digest, /^sha256:/);

    const accepted = await applyAccept(
      { ...accept, caller: { ...COORDINATOR, cwd: fixture.root } },
      { notify: silentNotify },
    );
    assert.equal(accepted.status, 'applied');
    assert.equal(accepted.messages[0]?.duplicate, true);
  } finally {
    fixture.cleanup();
  }
});

test('workflow report delivers exactly once and never wakes twice', async () => {
  const fixture = makeTaskDomain('workflow-notify', ['cohort'], {
    initialize: [],
  });
  try {
    const request = prepareRequest(
      fixture.domainRoot,
      fixture.root,
      baseAssignments(fixture.root),
    );
    const prepared = await applyPrepare(request);
    assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
    const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
    mkdirSync(join(fixture.root, 'a'), { recursive: true });
    const inside = join(fixture.root, 'a', 'out.txt');
    writeFileSync(inside, 'built\n');

    const calls: string[] = [];
    const notify = (async (options: { messageId: string }) => {
      calls.push(options.messageId);
      return {
        ok: true as const,
        value: {
          status: 'submitted' as const,
          messageId: options.messageId,
          detail: null,
          consumed: false as const,
          taskAccepted: false as const,
        },
      };
    }) as unknown as typeof silentNotify;

    const reported = await applyParticipant(
      reportRequest(taskRoot, WRITER_A, 'writer-one', 1, [inside]),
      { notify },
    );
    assert.equal(reported.status, 'applied', JSON.stringify(reported.blockers));
    assert.equal(reported.messages[0]?.delivery, 'submitted');
    assert.equal(calls.length, 1, 'a first report delivers once');

    const resent = await applyParticipant(
      reportRequest(taskRoot, WRITER_A, 'writer-one', 1, [inside]),
      { notify },
    );
    assert.equal(resent.messages[0]?.duplicate, true);
    assert.equal(
      calls.length,
      1,
      'a duplicate resend never wakes the recipient twice',
    );

    const planned = await applyParticipant(
      reportRequest(taskRoot, WRITER_A, 'writer-one', 1, [inside]),
      { notify, apply: false },
    );
    assert.equal(planned.status, 'planned');
    assert.equal(calls.length, 1, 'plan mode never notifies');
  } finally {
    fixture.cleanup();
  }
});

test('workflow release frees claims and never claims acceptance', async () => {
  const fixture = makeTaskDomain('workflow-release', ['cohort'], {
    initialize: [],
  });
  try {
    const request = prepareRequest(
      fixture.domainRoot,
      fixture.root,
      baseAssignments(fixture.root),
    );
    const prepared = await applyPrepare(request);
    assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
    const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
    const release = (correlatesTo: string | null) => ({
      schema: 'pappra/collab-workflow-participant-request/1' as const,
      action: 'release' as const,
      task_root: taskRoot,
      caller: { ...WRITER_A, cwd: fixture.root },
      subtask_id: 'writer-one',
      attempt: 1,
      caller_pane: null,
      report: null,
      release: {
        reason: 'Handing the scope back.',
        cancel_attempt: false,
        correlates_to: correlatesTo,
      },
    });

    const ask = buildMessage({
      type: 'ASK',
      task_id: 'cohort',
      from: {
        agent_id: COORDINATOR.agent_id,
        session_id: COORDINATOR.session_id,
        harness: COORDINATOR.harness,
      },
      to: {
        agent_id: WRITER_A.agent_id,
        session_id: WRITER_A.session_id,
        harness: WRITER_A.harness,
      },
      subtask_id: 'writer-one',
      attempt: 1,
      owner_epoch: 1,
      body: { question: 'Can you hand this scope back?' },
    });
    const registered = submitMessage(taskRoot, ask);
    assert.equal(registered.ok, true, JSON.stringify(registered));

    // The release intent embeds the request clock, so an idempotent replay pins it.
    const releaseClock = 1761300000000;
    const released = await applyParticipant(release(ask.message_id), {
      clock: releaseClock,
      notify: silentNotify,
    });
    assert.equal(released.status, 'applied', JSON.stringify(released.blockers));
    const inspected = await inspectWorkflow(taskRoot);
    const attempts = inspected.detail?.['attempts'] as {
      subtask_id: string;
      active_claims: number;
    }[];
    assert.equal(
      attempts.find((item) => item.subtask_id === 'writer-one')?.active_claims,
      0,
    );
    // A repeated identical release is idempotent, never a second claim effect.
    const repeated = await applyParticipant(release(ask.message_id), {
      clock: releaseClock,
      notify: silentNotify,
    });
    assert.equal(repeated.status, 'applied', JSON.stringify(repeated.blockers));
    assert.equal(repeated.messages[0]?.duplicate, true);
  } finally {
    fixture.cleanup();
  }
});

test('workflow release refuses an invented correlation and keeps its claims', async () => {
  const fixture = makeTaskDomain('workflow-release-invented', ['cohort'], {
    initialize: [],
  });
  try {
    const request = prepareRequest(
      fixture.domainRoot,
      fixture.root,
      baseAssignments(fixture.root),
    );
    const prepared = await applyPrepare(request);
    assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
    const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
    const refused = await applyParticipant(
      {
        schema: 'pappra/collab-workflow-participant-request/1',
        action: 'release',
        task_root: taskRoot,
        caller: { ...WRITER_A, cwd: fixture.root },
        subtask_id: 'writer-one',
        attempt: 1,
        caller_pane: null,
        report: null,
        release: {
          reason: 'Handing the scope back.',
          cancel_attempt: false,
          correlates_to: 'ask-never-registered',
        },
      },
      { notify: silentNotify },
    );
    assert.notEqual(refused.status, 'applied');
    assert.ok(
      refused.blockers.some(
        (item) => item.code === 'release_correlation_unknown',
      ),
      JSON.stringify(refused.blockers),
    );
    const inspected = await inspectWorkflow(taskRoot);
    const attempts = inspected.detail?.['attempts'] as {
      subtask_id: string;
      active_claims: number;
    }[];
    assert.ok(
      (attempts.find((item) => item.subtask_id === 'writer-one')
        ?.active_claims ?? 0) > 0,
      'a refused release keeps its claims',
    );
  } finally {
    fixture.cleanup();
  }
});

test('workflow dispatch refuses a missing, declared or stale capability card', async () => {
  const fixture = makeTaskDomain('workflow-dispatch', ['cohort'], {
    initialize: [],
  });
  try {
    const request = prepareRequest(
      fixture.domainRoot,
      fixture.root,
      baseAssignments(fixture.root),
    );
    const prepared = await applyPrepare(request);
    assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
    const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');

    const absent = planDispatch(dispatchRequest(taskRoot, []));
    assert.equal(absent.ok, true);
    if (!absent.ok) return;
    assert.ok(
      absent.value.blockers.some(
        (item) => item.code === 'capability_target_missing',
      ),
    );

    const evidence = join(fixture.root, 'session.log');
    writeFileSync(evidence, 'first\n');
    const digest = fileDigest(evidence);
    const cardFile = join(fixture.root, 'card.json');
    writeFileSync(
      cardFile,
      `${JSON.stringify(capabilityCard(fixture.root, { ref: evidence, digest }), null, 2)}\n`,
    );
    const current = planDispatch(
      dispatchRequest(taskRoot, [
        {
          subtask_id: 'writer-one',
          attempt: 1,
          capabilities_file: cardFile,
          template_file: null,
          session_file: null,
          events_file: null,
          execution_file: null,
        },
      ]),
    );
    assert.equal(current.ok, true);
    if (!current.ok) return;
    assert.equal(
      current.value.blockers.length,
      0,
      JSON.stringify(current.value.blockers),
    );
    assert.equal(current.value.nodes[0]?.card_state, 'explicit');

    // The explicit-card path is not a softer path: it is judged by the same shared
    // preflight, so a declared card and a stale observation are both refused.
    const declaredFile = join(fixture.root, 'card-declared.json');
    writeFileSync(
      declaredFile,
      `${JSON.stringify(
        {
          ...capabilityCard(fixture.root, { ref: evidence, digest }),
          evidence_level: 'declared',
        },
        null,
        2,
      )}\n`,
    );
    const declared = planDispatch(
      dispatchRequest(taskRoot, [
        {
          subtask_id: 'writer-one',
          attempt: 1,
          capabilities_file: declaredFile,
          template_file: null,
          session_file: null,
          events_file: null,
          execution_file: null,
        },
      ]),
    );
    assert.equal(declared.ok, true);
    if (!declared.ok) return;
    assert.ok(
      declared.value.blockers.some(
        (item) => item.code === 'runtime_capabilities_unconfirmed',
      ),
      JSON.stringify(declared.value.blockers),
    );

    const staleFile = join(fixture.root, 'card-stale.json');
    writeFileSync(
      staleFile,
      `${JSON.stringify(
        {
          ...capabilityCard(fixture.root, { ref: evidence, digest }),
          observed_at: new Date(Date.now() - 45 * 60_000).toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    const stale = planDispatch(
      dispatchRequest(taskRoot, [
        {
          subtask_id: 'writer-one',
          attempt: 1,
          capabilities_file: staleFile,
          template_file: null,
          session_file: null,
          events_file: null,
          execution_file: null,
        },
      ]),
    );
    assert.equal(stale.ok, true);
    if (!stale.ok) return;
    assert.ok(
      stale.value.blockers.some((item) => item.code === 'capabilities_stale'),
      'a 45-minute-old observation is refused by the shared 30-minute preflight bound',
    );

    const plannedOnly = await applyDispatch(dispatchRequest(taskRoot, []), {
      apply: false,
    });
    assert.equal(plannedOnly.status, 'blocked');
    assert.equal(plannedOnly.messages.length, 0);
  } finally {
    fixture.cleanup();
  }
});
