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
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { notifyRegisteredMessage } from '../../src/app/collab-notify.js';
import { makeTaskDomain } from './task-resources-fixtures.js';
import { owner } from './scenarios.js';

type NotifyResult = Awaited<ReturnType<typeof notifyRegisteredMessage>>;

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

/** Deterministic delivery stub: the transport is asserted, never actually called. */
function recordingNotify(outcomes: NotifyResult[] = []) {
  const calls: string[] = [];
  const queue = [...outcomes];
  const notify = (async (options: { messageId: string }) => {
    calls.push(options.messageId);
    const next = queue.shift();
    if (next !== undefined) return next;
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
  }) as unknown as (
    options: Parameters<typeof notifyRegisteredMessage>[0],
  ) => ReturnType<typeof notifyRegisteredMessage>;
  return { notify, calls };
}

function prepareRequest(
  domainRoot: string,
  cwd: string,
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
      { ...WRITER_A, cwd },
      { ...WRITER_B, cwd },
    ],
    bindings: [],
    assignments: [
      {
        subtask_id: 'writer-one',
        role: 'writer',
        assignee: WRITER_A.agent_id,
        objective: 'Objective for writer-one.',
        acceptance: ['Acceptance for writer-one.'],
        resources: [{ path: join(cwd, 'a'), access: 'write' }],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ],
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  };
}

function ackRequest(taskRoot: string): WorkflowParticipantRequest {
  return {
    schema: 'pappra/collab-workflow-participant-request/1',
    action: 'ack',
    task_root: taskRoot,
    caller: { ...WRITER_A, cwd: taskRoot },
    subtask_id: 'writer-one',
    attempt: 1,
    caller_pane: null,
    report: null,
    release: null,
  };
}

function reportRequest(
  taskRoot: string,
  outputs: string[],
): WorkflowParticipantRequest {
  return {
    schema: 'pappra/collab-workflow-participant-request/1',
    action: 'report',
    task_root: taskRoot,
    caller: { ...WRITER_A, cwd: taskRoot },
    subtask_id: 'writer-one',
    attempt: 1,
    caller_pane: null,
    report: {
      status: 'completed',
      summary: 'Reported outcome.',
      blockers: [],
      outputs,
    },
    release: null,
  };
}

async function preparedCohort(name: string) {
  const fixture = makeTaskDomain(name, ['cohort'], { initialize: [] });
  const request = prepareRequest(fixture.domainRoot, fixture.root);
  const prepared = await applyPrepare(request);
  assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
  const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
  mkdirSync(join(fixture.root, 'a'), { recursive: true });
  const output = join(fixture.root, 'a', 'out.txt');
  writeFileSync(output, 'built\n');
  return { fixture, taskRoot, output };
}

test('an ACK notifies once and a duplicate never wakes the coordinator twice', async () => {
  const { fixture, taskRoot } = await preparedCohort('workflow-notify-ack');
  try {
    const { notify, calls } = recordingNotify();
    const first = await applyParticipant(ackRequest(taskRoot), { notify });
    assert.equal(first.status, 'applied', JSON.stringify(first.blockers));
    assert.equal(first.messages[0]?.delivery, 'submitted');
    assert.equal(calls.length, 1, 'the first ACK is delivered once');

    const again = await applyParticipant(ackRequest(taskRoot), { notify });
    assert.equal(again.messages[0]?.duplicate, true);
    assert.equal(again.messages[0]?.delivery, 'already-recorded');
    assert.equal(calls.length, 1, 'a duplicate ACK never wakes the recipient');
  } finally {
    fixture.cleanup();
  }
});

test('a report keeps its applied protocol state when delivery fails', async () => {
  const { fixture, taskRoot, output } = await preparedCohort(
    'workflow-notify-fail',
  );
  try {
    const failure: NotifyResult = {
      ok: false,
      code: 'transport_unavailable',
      message: 'The transport is unavailable.',
      nextAction: null,
    };
    const failing = recordingNotify([failure]);
    const reported = await applyParticipant(reportRequest(taskRoot, [output]), {
      notify: failing.notify,
    });
    // The report is admitted; delivery is a separate, explicit warning.
    assert.equal(reported.status, 'applied', JSON.stringify(reported.blockers));
    assert.equal(reported.messages[0]?.delivery, 'not-notified');
    assert.equal(
      failing.calls.length,
      1,
      'delivery was attempted exactly once',
    );

    const retrying = recordingNotify();
    const retried = await applyParticipant(reportRequest(taskRoot, [output]), {
      notify: retrying.notify,
    });
    assert.equal(retried.messages[0]?.duplicate, true);
    assert.equal(
      retrying.calls.length,
      0,
      'a duplicate result is already recorded and is not re-delivered',
    );
  } finally {
    fixture.cleanup();
  }
});

test('an unknown delivery stays unknown and is never replayed automatically', async () => {
  const { fixture, taskRoot, output } = await preparedCohort(
    'workflow-notify-unknown',
  );
  try {
    const unknown: NotifyResult = {
      ok: true,
      value: {
        status: 'unknown',
        messageId: 'report-writer-one-1',
        detail: 'The transport exited without a confirmed delivery.',
        consumed: false,
        taskAccepted: false,
      },
    } as NotifyResult;
    const first = recordingNotify([unknown]);
    const reported = await applyParticipant(reportRequest(taskRoot, [output]), {
      notify: first.notify,
    });
    assert.equal(reported.status, 'applied', JSON.stringify(reported.blockers));
    assert.equal(reported.messages[0]?.delivery, 'unknown');
    assert.equal(first.calls.length, 1);

    const second = recordingNotify();
    const repeated = await applyParticipant(reportRequest(taskRoot, [output]), {
      notify: second.notify,
    });
    assert.equal(repeated.messages[0]?.duplicate, true);
    assert.equal(
      second.calls.length,
      0,
      'an ambiguous delivery is never replayed by a duplicate request',
    );
  } finally {
    fixture.cleanup();
  }
});

test('an acceptance notifies once and keeps its duplicate from waking twice', async () => {
  const { fixture, taskRoot, output } = await preparedCohort(
    'workflow-notify-accept',
  );
  try {
    const { notify: reportNotify } = recordingNotify();
    const reported = await applyParticipant(reportRequest(taskRoot, [output]), {
      notify: reportNotify,
    });
    assert.equal(reported.status, 'applied', JSON.stringify(reported.blockers));

    const accept: WorkflowAcceptRequest = {
      schema: 'pappra/collab-workflow-accept-request/1',
      task_root: taskRoot,
      caller: { ...COORDINATOR, cwd: fixture.root },
      subtask_id: 'writer-one',
      attempt: 1,
      report_message_id: reported.messages[0]!.message_id,
      caller_pane: null,
      reason: 'Looks complete.',
    };
    const { notify, calls } = recordingNotify();
    const decision = await applyAccept(accept, { notify });
    assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
    assert.equal(calls.length, 1, 'the first acceptance is delivered once');

    const repeated = await applyAccept(accept, { notify });
    assert.equal(repeated.messages[0]?.duplicate, true);
    assert.equal(
      calls.length,
      1,
      'a duplicate acceptance never wakes the writer',
    );
  } finally {
    fixture.cleanup();
  }
});

test('plan-only ACK, REPORT, RELEASE and ACCEPT never notify', async () => {
  const { fixture, taskRoot, output } = await preparedCohort(
    'workflow-plan-matrix',
  );
  try {
    // A real registered coordinator message, so the release guard has an actual correlation.
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
      body: { question: 'Plan-only matrix correlation.' },
    });
    const registered = submitMessage(taskRoot, ask);
    assert.equal(registered.ok, true, JSON.stringify(registered));

    const { notify, calls } = recordingNotify();
    const releaseRequest = (
      correlatesTo: string,
    ): WorkflowParticipantRequest => ({
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
        correlates_to: correlatesTo,
      },
    });

    const plannedAck = await applyParticipant(ackRequest(taskRoot), {
      notify,
      apply: false,
    });
    assert.equal(
      plannedAck.status,
      'planned',
      JSON.stringify(plannedAck.blockers),
    );

    const plannedReport = await applyParticipant(
      reportRequest(taskRoot, [output]),
      {
        notify,
        apply: false,
      },
    );
    assert.equal(
      plannedReport.status,
      'planned',
      JSON.stringify(plannedReport.blockers),
    );

    const plannedRelease = await applyParticipant(
      releaseRequest(ask.message_id),
      {
        notify,
        apply: false,
      },
    );
    assert.equal(
      plannedRelease.status,
      'planned',
      JSON.stringify(plannedRelease.blockers),
    );

    // ACK, report and release were all plan-only so far: the transport stays untouched.
    assert.equal(
      calls.length,
      0,
      'plan-only ACK, report and release never notify',
    );

    // The report must be real before an acceptance can name it.
    const reported = await applyParticipant(reportRequest(taskRoot, [output]), {
      notify,
    });
    assert.equal(reported.status, 'applied', JSON.stringify(reported.blockers));

    const accept: WorkflowAcceptRequest = {
      schema: 'pappra/collab-workflow-accept-request/1',
      task_root: taskRoot,
      caller: { ...COORDINATOR, cwd: fixture.root },
      subtask_id: 'writer-one',
      attempt: 1,
      report_message_id: reported.messages[0]!.message_id,
      caller_pane: null,
      reason: 'Looks complete.',
    };
    const plannedAccept = await applyAccept(accept, { notify, apply: false });
    assert.equal(
      plannedAccept.status,
      'planned',
      JSON.stringify(plannedAccept.blockers),
    );

    // The substantive report above delivered once; a plan-only acceptance adds nothing.
    assert.equal(
      calls.length,
      1,
      `plan-only acceptance must not notify (calls: ${calls.length} - ${calls.join(', ')})`,
    );

    // The spy is live: the substantive report (1) and this substantive acceptance (1)
    // are the only two deliveries in the whole matrix.
    const decided = await applyAccept(accept, { notify });
    assert.equal(decided.status, 'applied', JSON.stringify(decided.blockers));
    assert.equal(
      calls.length,
      2,
      `report + acceptance deliver once each (calls: ${calls.length} - ${calls.join(', ')})`,
    );

    // A duplicate substantive acceptance is already recorded and adds no third wake.
    const duplicated = await applyAccept(accept, { notify });
    assert.equal(duplicated.messages[0]?.duplicate, true);
    assert.equal(
      calls.length,
      2,
      `a duplicate acceptance never wakes twice (calls: ${calls.length} - ${calls.join(', ')})`,
    );
  } finally {
    fixture.cleanup();
  }
});
