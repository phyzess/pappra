import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyAccept,
  applyParticipant,
  applyPrepare,
  type WorkflowAcceptRequest,
  type WorkflowParticipantRequest,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import {
  applyAwait,
  loadAwaitRequest,
  parseWorkflowAwaitRequest,
  WORKFLOW_AWAIT_MAX_TIMEOUT_SECONDS,
  type WorkflowAwaitRequest,
} from '../../src/app/collab-workflow/await.js';
import { evaluateCohortPlan } from '../../src/app/collab-workflow/dispatch.js';
import type { notifyRegisteredMessage } from '../../src/app/collab-notify.js';
import { buildMessage, registerMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { readRecord, transact } from '../../src/collab/store.js';
import { makeTaskDomain } from './task-resources-fixtures.js';
import { owner } from './scenarios.js';

const cli = fileURLToPath(new URL('../../src/cli/main.js', import.meta.url));

const COORDINATOR = {
  agent_id: owner.agent_id,
  session_id: owner.session_id,
  harness: owner.harness,
  owner_epoch: owner.owner_epoch,
  since: owner.since,
};
const COORDINATOR_IDENTITY = {
  agent_id: COORDINATOR.agent_id,
  session_id: COORDINATOR.session_id,
  harness: COORDINATOR.harness,
};
const WRITER = {
  agent_id: 'writer-a',
  session_id: 'writer-a-session',
  harness: 'pi',
};
const OTHER_WRITER = {
  agent_id: 'writer-b',
  session_id: 'writer-b-session',
  harness: 'pi',
};
const NEXT = {
  agent_id: 'next-coordinator',
  session_id: 'next-session',
  harness: 'claude',
};

/** Delivery stub: these tests assert protocol state, never the Herdr transport. */
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

function prepareRequest(
  domainRoot: string,
  cwd: string,
): WorkflowPrepareRequest {
  return {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: domainRoot,
    task_id: 'cohort',
    goal: { objective: 'Await fixture.', input_ref: null, input_digest: null },
    coordinator: {
      ...COORDINATOR,
      cwd,
      surface: 'cli',
      configuration_id: 'daily-visible',
    },
    participants: [
      {
        ...COORDINATOR_IDENTITY,
        cwd,
        surface: 'cli',
        configuration_id: 'daily-visible',
      },
      { ...WRITER, cwd, surface: 'cli', configuration_id: 'daily-visible' },
    ],
    bindings: [],
    assignments: [
      {
        subtask_id: 'writer-one',
        role: 'writer',
        assignee: WRITER.agent_id,
        objective: 'Objective for writer-one.',
        acceptance: ['Acceptance for writer-one.'],
        resources: [{ path: join(cwd, 'a'), access: 'write' }],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ],
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  } satisfies WorkflowPrepareRequest;
}

function reportRequest(
  taskRoot: string,
  outputs: string[],
  status: 'completed' | 'needs_input' = 'completed',
  summary = 'Reported outcome.',
): WorkflowParticipantRequest {
  return {
    schema: 'pappra/collab-workflow-participant-request/1',
    action: 'report',
    task_root: taskRoot,
    caller: { ...WRITER, cwd: taskRoot },
    subtask_id: 'writer-one',
    attempt: 1,
    caller_pane: null,
    report: {
      status,
      summary,
      blockers:
        status === 'needs_input' ? ['A concrete missing observation.'] : [],
      outputs,
    },
    release: null,
  };
}

function releaseRequest(
  taskRoot: string,
  correlatesTo: string,
): WorkflowParticipantRequest {
  return {
    schema: 'pappra/collab-workflow-participant-request/1',
    action: 'release',
    task_root: taskRoot,
    caller: { ...WRITER, cwd: taskRoot },
    subtask_id: 'writer-one',
    attempt: 1,
    caller_pane: null,
    report: null,
    release: {
      reason: 'parity probe',
      cancel_attempt: false,
      correlates_to: correlatesTo,
    },
  };
}

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

async function reportedFixture(label: string, report = true) {
  const fixture = makeTaskDomain(label, ['cohort'], { initialize: [] });
  const prepared = await applyPrepare(
    prepareRequest(fixture.domainRoot, fixture.root),
  );
  assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
  const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
  mkdirSync(join(fixture.root, 'a'), { recursive: true });
  const output = join(fixture.root, 'a', 'output.txt');
  writeFileSync(output, 'built\n');
  let report_id = '';
  let report_digest = '';
  if (report) {
    const reported = await applyParticipant(reportRequest(taskRoot, [output]), {
      notify: silentNotify,
    });
    assert.equal(reported.status, 'applied', JSON.stringify(reported.blockers));
    report_id = reported.messages[0]!.message_id;
    report_digest = reported.messages[0]!.digest ?? '';
  }
  const accept = (
    caller: typeof COORDINATOR | typeof NEXT,
  ): WorkflowAcceptRequest => ({
    schema: 'pappra/collab-workflow-accept-request/1',
    task_root: taskRoot,
    caller: { ...caller, cwd: fixture.root },
    subtask_id: 'writer-one',
    attempt: 1,
    report_message_id: report_id,
    caller_pane: null,
    reason: 'Looks complete.',
  });
  const request = (
    overrides: Partial<WorkflowAwaitRequest> = {},
  ): WorkflowAwaitRequest => ({
    schema: 'pappra/collab-workflow-await-request/1',
    task_root: taskRoot,
    caller: { ...WRITER, cwd: fixture.root },
    subtask_id: 'writer-one',
    attempt: 1,
    timeout_seconds: 0,
    poll_interval_seconds: 1,
    ...overrides,
  });
  return {
    fixture,
    taskRoot,
    accept,
    request,
    report: { id: report_id, digest: report_digest },
  };
}

type Fixture = Awaited<ReturnType<typeof reportedFixture>>;

async function decide(
  f: Fixture,
  caller: typeof COORDINATOR | typeof NEXT = COORDINATOR,
) {
  const decision = await applyAccept(f.accept(caller), {
    notify: silentNotify,
  });
  assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
  return decision.messages[0]!.message_id;
}

/** A virtual clock: the injected sleep advances it, so no test waits in real time. */
function virtualClock(
  onSleep: (count: number) => Promise<void> | void = () => undefined,
) {
  let at = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => at,
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
      at += milliseconds;
      await onSleep(sleeps.length);
    },
  };
}

function craftDecision(
  f: Fixture,
  options: {
    id: string;
    from?: typeof COORDINATOR_IDENTITY;
    to?: typeof WRITER;
    epoch?: number;
    acceptance?: Record<string, unknown> | null;
    applied?: boolean;
  },
) {
  const acceptance =
    options.acceptance === undefined
      ? {
          plan_id: 'crafted-plan',
          node_id: 'crafted-node',
          assignment_id: 'writer-one',
          attempt: 1,
          input_revision: null,
          report_digest: f.report.digest,
          decision: 'accepted',
        }
      : options.acceptance;
  const message = buildMessage({
    type: 'ANSWER',
    task_id: 'cohort',
    from: options.from ?? COORDINATOR_IDENTITY,
    to: options.to ?? WRITER,
    reply_to: f.report.id,
    message_id: options.id,
    subtask_id: 'writer-one',
    attempt: 1,
    owner_epoch: options.epoch ?? 1,
    body: {
      status: 'completed',
      reason: 'crafted',
      ...(acceptance === null ? {} : { acceptance }),
    },
  });
  if (options.applied === false) {
    registerMessage(f.taskRoot, message);
    return message;
  }
  const submitted = submitMessage(f.taskRoot, message);
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  return message;
}

/** Every regular file and symlink under a root, with the bytes and mtime that identify it. */
function snapshot(root: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const full = join(root, relative);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) result[relative] = `link:${readlinkSync(full)}`;
    else if (stat.isDirectory()) {
      result[relative] = 'dir';
      Object.assign(result, snapshot(root, relative));
    } else
      result[relative] =
        `${stat.size}:${stat.mtimeMs}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
  }
  return result;
}

/** The release path's decision-correlation blockers for one candidate id. */
async function releaseCorrelation(f: Fixture, id: string): Promise<string[]> {
  const plan = await applyParticipant(releaseRequest(f.taskRoot, id), {
    apply: false,
    notify: silentNotify,
  });
  return plan.blockers
    .map((blocker) => blocker.code)
    .filter((code) => code.startsWith('release_correlation_'));
}

test('the await request is strict, bounded and shares the participant identity validators', () => {
  const base = {
    schema: 'pappra/collab-workflow-await-request/1',
    task_root: '/tmp/domain/tasks/cohort',
    caller: {
      agent_id: 'writer-a',
      session_id: 'writer-a-session',
      harness: 'pi',
      cwd: '/tmp',
    },
    subtask_id: 'writer-one',
    attempt: 1,
    timeout_seconds: 30,
  };
  const ok = parseWorkflowAwaitRequest(base);
  assert.equal(ok.ok, true);
  // The poll interval is optional and has a documented default.
  assert.equal(ok.ok && ok.value.poll_interval_seconds, 5);
  assert.equal(
    parseWorkflowAwaitRequest({ ...base, poll_interval_seconds: 60 }).ok,
    true,
  );
  assert.equal(
    parseWorkflowAwaitRequest({
      ...base,
      timeout_seconds: WORKFLOW_AWAIT_MAX_TIMEOUT_SECONDS,
    }).ok,
    true,
  );
  assert.equal(
    parseWorkflowAwaitRequest({ ...base, timeout_seconds: 0 }).ok,
    true,
  );

  const refused: Record<string, unknown>[] = [
    { ...base, extra: true },
    { ...base, schema: 'pappra/collab-workflow-participant-request/1' },
    // The hard maximum is refused, never clamped.
    { ...base, timeout_seconds: WORKFLOW_AWAIT_MAX_TIMEOUT_SECONDS + 1 },
    { ...base, timeout_seconds: -1 },
    { ...base, timeout_seconds: 1.5 },
    { ...base, timeout_seconds: '30' },
    { ...base, poll_interval_seconds: 0 },
    { ...base, poll_interval_seconds: 61 },
    { ...base, poll_interval_seconds: 0.5 },
    { ...base, task_root: 'relative/tasks/cohort' },
    { ...base, subtask_id: '../escape' },
    { ...base, attempt: 0 },
    { ...base, attempt: 1001 },
    { ...base, caller: { ...base.caller, extra: 1 } },
    { ...base, caller: { ...base.caller, cwd: 'relative' } },
  ];
  for (const candidate of refused) {
    const parsed = parseWorkflowAwaitRequest(candidate);
    assert.equal(parsed.ok, false, JSON.stringify(candidate));
  }
  const withoutTimeout: Record<string, unknown> = { ...base };
  delete withoutTimeout['timeout_seconds'];
  assert.equal(
    parseWorkflowAwaitRequest(withoutTimeout).ok,
    false,
    'how long to block is always an explicit choice',
  );
});

test('loadAwaitRequest reads one bounded regular file and refuses a mismatched document', async () => {
  const f = await reportedFixture('await-load', false);
  try {
    const good = join(f.fixture.root, 'await.json');
    writeFileSync(good, JSON.stringify(f.request({ timeout_seconds: 5 })));
    const loaded = loadAwaitRequest(good);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.ok && loaded.value.timeout_seconds, 5);

    const wrongSchema = join(f.fixture.root, 'participant.json');
    writeFileSync(wrongSchema, JSON.stringify(reportRequest(f.taskRoot, [])));
    const mismatch = loadAwaitRequest(wrongSchema);
    assert.equal(mismatch.ok, false);
    assert.equal(!mismatch.ok && mismatch.code, 'request_schema_invalid');

    const broken = join(f.fixture.root, 'broken.json');
    writeFileSync(broken, '{ not json');
    assert.equal(
      (() => {
        const result = loadAwaitRequest(broken);
        return result.ok ? null : result.code;
      })(),
      'file_invalid_json',
    );
    const link = join(f.fixture.root, 'link.json');
    symlinkSync(good, link);
    assert.equal(
      (() => {
        const result = loadAwaitRequest(link);
        return result.ok ? null : result.code;
      })(),
      'file_symlink',
    );
    assert.equal(loadAwaitRequest('relative.json').ok, false);
  } finally {
    f.fixture.cleanup();
  }
});

test('an existing valid decision ends the wait at the first observation', async () => {
  const f = await reportedFixture('await-decided');
  try {
    const id = await decide(f);
    const clock = virtualClock();
    const result = await applyAwait(f.request({ timeout_seconds: 30 }), clock);
    assert.equal(result.status, 'decided', JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.action, 'await');
    assert.equal(result.apply, false);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.detail?.decision?.message_id, id);
    assert.equal(result.detail?.decision?.reply_to, f.report.id);
    assert.equal(result.detail?.decision?.report_digest, f.report.digest);
    assert.equal(result.detail?.decision?.owner_epoch, 1);
    assert.equal(result.detail?.decision?.from.agent_id, COORDINATOR.agent_id);
    assert.equal(result.detail?.report_message_id, f.report.id);
    assert.equal(result.detail?.polls, 1);
    assert.deepEqual(clock.sleeps, []);
    assert.equal(result.messages[0]?.message_id, id);
    assert.equal(result.messages[0]?.type, 'ANSWER');
    assert.equal(result.messages[0]?.delivery, 'not-attempted');
    assert.equal(result.principal?.role, 'participant');
    assert.match(result.next_action ?? '', /release/);
    assert.match(result.next_action ?? '', /accepted nothing/);
    // The decision found here is one the release path correlates to.
    assert.deepEqual(await releaseCorrelation(f, id), []);
  } finally {
    f.fixture.cleanup();
  }
});

test('a decision that lands while waiting is observed on the next poll', async () => {
  const f = await reportedFixture('await-mid');
  try {
    let decided = '';
    const clock = virtualClock(async (count) => {
      if (count === 2) decided = await decide(f);
    });
    const result = await applyAwait(
      f.request({ timeout_seconds: 10, poll_interval_seconds: 1 }),
      clock,
    );
    assert.equal(result.status, 'decided', JSON.stringify(result));
    assert.equal(result.detail?.decision?.message_id, decided);
    assert.equal(result.detail?.polls, 3);
    assert.equal(result.detail?.waited_ms, 2000);
    assert.deepEqual(clock.sleeps, [1000, 1000]);
  } finally {
    f.fixture.cleanup();
  }
});

test('a wait with no decision times out after exactly one poll interval per sleep, not ok and decided nothing', async () => {
  const f = await reportedFixture('await-timeout');
  try {
    const clock = virtualClock();
    const result = await applyAwait(
      f.request({ timeout_seconds: 3, poll_interval_seconds: 1 }),
      clock,
    );
    assert.equal(result.status, 'timeout', JSON.stringify(result));
    // A timeout is not ok, so the CLI exits non-zero and `await && release` cannot release; the
    // status still tells it from a refusal.
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.blockers.map((blocker) => blocker.code),
      ['await_timeout'],
    );
    assert.match(
      result.blockers[0]?.detail ?? '',
      /writer-one#1 appeared within 3s \(4 observations\)\.$/,
    );
    assert.equal(result.detail?.decision, null);
    assert.equal(result.detail?.report_message_id, f.report.id);
    assert.equal(result.detail?.polls, 4);
    assert.equal(result.detail?.waited_ms, 3000);
    assert.deepEqual(clock.sleeps, [1000, 1000, 1000]);
    assert.deepEqual(result.messages, []);
    assert.match(result.next_action ?? '', /do not treat this as accepted/);

    // The last sleep is clamped to the time left, so the wait never overshoots its bound.
    const clamped = virtualClock();
    const second = await applyAwait(
      f.request({ timeout_seconds: 5, poll_interval_seconds: 2 }),
      clamped,
    );
    assert.equal(second.status, 'timeout');
    assert.deepEqual(clamped.sleeps, [2000, 2000, 1000]);
    assert.equal(second.detail?.waited_ms, 5000);

    // Zero observes exactly once and never sleeps.
    const zero = virtualClock();
    const once = await applyAwait(f.request({ timeout_seconds: 0 }), zero);
    assert.equal(once.status, 'timeout');
    assert.equal(once.detail?.polls, 1);
    assert.equal(once.ok, false);
    assert.match(
      once.blockers[0]?.detail ?? '',
      /within 0s \(1 observation\)\.$/,
    );
    assert.deepEqual(zero.sleeps, []);
  } finally {
    f.fixture.cleanup();
  }
});

test('before any completed report the wait says there is nothing to decide yet', async () => {
  const f = await reportedFixture('await-no-report', false);
  try {
    const result = await applyAwait(f.request(), virtualClock());
    assert.equal(result.status, 'timeout');
    assert.equal(result.ok, false);
    assert.equal(result.detail?.report_message_id, null);
    assert.equal(result.detail?.attempt_state, 'assigned');
    // The reason sits in the blocker that makes the result not ok, not in a warning.
    assert.match(
      result.blockers[0]?.detail ?? '',
      /No completed report is admitted yet/,
    );
    assert.deepEqual(result.warnings, []);
    assert.match(result.next_action ?? '', /Report first/);

    // A report that is not completed is not something a coordinator can accept either.
    const output = join(f.fixture.root, 'a', 'partial.txt');
    writeFileSync(output, 'partial\n');
    const blocked = await applyParticipant(
      reportRequest(f.taskRoot, [output], 'needs_input'),
      { notify: silentNotify },
    );
    assert.equal(blocked.status, 'applied', JSON.stringify(blocked.blockers));
    const still = await applyAwait(f.request(), virtualClock());
    assert.equal(still.status, 'timeout');
    assert.equal(still.detail?.report_message_id, null);
  } finally {
    f.fixture.cleanup();
  }
});

test('await writes nothing: the task root is byte-identical after a decided, a timed out and a refused wait', async () => {
  const f = await reportedFixture('await-readonly');
  try {
    const before = snapshot(f.taskRoot);
    const timedOut = await applyAwait(
      f.request({ timeout_seconds: 2 }),
      virtualClock(),
    );
    assert.equal(timedOut.status, 'timeout');
    const refused = await applyAwait(
      f.request({ caller: { ...OTHER_WRITER, cwd: f.fixture.root } }),
      virtualClock(),
    );
    assert.equal(refused.status, 'refused');
    assert.deepEqual(snapshot(f.taskRoot), before);

    await decide(f);
    const afterDecision = snapshot(f.taskRoot);
    const decided = await applyAwait(f.request(), virtualClock());
    assert.equal(decided.status, 'decided');
    assert.deepEqual(snapshot(f.taskRoot), afterDecision);
  } finally {
    f.fixture.cleanup();
  }
});

test('await is self-call only: another agent, another session or the coordinator is denied', async () => {
  const f = await reportedFixture('await-self');
  try {
    await decide(f);
    for (const caller of [
      OTHER_WRITER,
      { ...WRITER, session_id: 'another-session' },
      { ...WRITER, agent_id: 'writer-z' },
      COORDINATOR_IDENTITY,
      // A bound harness that does not match is not the registered participant.
      { ...WRITER, harness: 'codex' },
    ]) {
      const clock = virtualClock();
      const result = await applyAwait(
        f.request({ caller: { ...caller, cwd: f.fixture.root } }),
        clock,
      );
      assert.equal(result.status, 'refused', JSON.stringify(caller));
      assert.equal(result.ok, false);
      assert.equal(result.blockers[0]?.code, 'sender_denied');
      // Nothing about the decision leaks to a caller that is not the participant.
      assert.equal(result.detail?.decision, null);
      assert.deepEqual(result.messages, []);
      assert.deepEqual(clock.sleeps, []);
    }
    const unregistered = await applyAwait(
      f.request({ attempt: 2 }),
      virtualClock(),
    );
    assert.equal(unregistered.status, 'refused');
    assert.equal(unregistered.blockers[0]?.code, 'attempt_not_registered');
  } finally {
    f.fixture.cleanup();
  }
});

test('an unusable task root is reported invalid, never guessed at', async () => {
  const f = await reportedFixture('await-root', false);
  try {
    const missing = await applyAwait(
      f.request({ task_root: join(f.fixture.domainRoot, 'tasks', 'absent') }),
      virtualClock(),
    );
    assert.equal(missing.status, 'invalid');
    assert.equal(missing.ok, false);
    assert.equal(missing.blockers.length, 1);
    assert.equal(missing.task_id, null);
  } finally {
    f.fixture.cleanup();
  }
});

test('a task whose record or namespace changes during the wait fails closed', async () => {
  const gone = await reportedFixture('await-gone');
  try {
    const clock = virtualClock((count) => {
      if (count === 1) rmSync(join(gone.taskRoot, 'task.json'));
    });
    const result = await applyAwait(
      gone.request({ timeout_seconds: 5 }),
      clock,
    );
    assert.equal(result.status, 'invalid', JSON.stringify(result));
    assert.equal(result.ok, false);
    assert.equal(result.blockers[0]?.code, 'task_record_missing');
    assert.equal(result.detail?.decision, null);
    assert.equal(clock.sleeps.length, 1);
  } finally {
    gone.fixture.cleanup();
  }

  const swapped = await reportedFixture('await-swapped');
  try {
    const clock = virtualClock((count) => {
      if (count === 1) {
        const messages = join(swapped.taskRoot, 'messages');
        renameSync(messages, join(swapped.fixture.root, 'moved-messages'));
        symlinkSync(join(swapped.fixture.root, 'moved-messages'), messages);
      }
    });
    const result = await applyAwait(
      swapped.request({ timeout_seconds: 5 }),
      clock,
    );
    assert.equal(result.status, 'invalid', JSON.stringify(result));
    assert.match(
      result.blockers[0]?.code ?? '',
      /task_messages_unsafe|task_namespace_changed/,
    );
  } finally {
    swapped.fixture.cleanup();
  }
});

test('a decision that was only registered, or is not an acceptance of this report, never counts', async () => {
  const f = await reportedFixture('await-evidence');
  try {
    // Registered but never applied: not evidence.
    craftDecision(f, { id: 'unapplied-accept', applied: false });
    assert.equal(
      (await applyAwait(f.request(), virtualClock())).status,
      'timeout',
    );

    // Addressed to somebody else: the release path refuses to correlate to it, so does await.
    craftDecision(f, { id: 'accept-for-other', to: OTHER_WRITER });
    // A decision-shaped answer with no acceptance payload (an informational reply).
    craftDecision(f, { id: 'plain-answer', acceptance: null });
    // Wrong attempt, wrong report digest and an explicit rejection.
    craftDecision(f, {
      id: 'accept-wrong-attempt',
      acceptance: {
        assignment_id: 'writer-one',
        attempt: 2,
        report_digest: f.report.digest,
        decision: 'accepted',
      },
    });
    craftDecision(f, {
      id: 'accept-wrong-digest',
      acceptance: {
        assignment_id: 'writer-one',
        attempt: 1,
        report_digest: `sha256:${'0'.repeat(64)}`,
        decision: 'accepted',
      },
    });
    craftDecision(f, {
      id: 'rejection',
      acceptance: {
        assignment_id: 'writer-one',
        attempt: 1,
        report_digest: f.report.digest,
        decision: 'rejected',
      },
    });
    // The coordinator's own harness label differs: the release path compares it exactly.
    craftDecision(f, {
      id: 'accept-other-harness',
      from: { ...COORDINATOR_IDENTITY, harness: 'other-harness' },
    });
    const result = await applyAwait(f.request(), virtualClock());
    assert.equal(result.status, 'timeout', JSON.stringify(result.detail));
    assert.equal(result.detail?.decision, null);
    const reasons = new Map(
      result.detail?.ignored.map((item) => [item.message_id, item.reason]),
    );
    assert.equal(reasons.has('unapplied-accept'), false);
    assert.equal(
      reasons.get('accept-for-other'),
      'decision_not_addressed_to_caller',
    );
    assert.equal(reasons.get('plain-answer'), 'decision_has_no_acceptance');
    assert.equal(reasons.get('accept-wrong-attempt'), 'decision_wrong_attempt');
    assert.equal(reasons.get('accept-wrong-digest'), 'decision_wrong_report');
    assert.equal(reasons.get('rejection'), 'decision_not_accepted:rejected');
    assert.equal(
      reasons.get('accept-other-harness'),
      'decision_not_from_current_coordinator',
    );
    assert.equal(result.detail?.ignored_total, 6);
    assert.match(result.warnings.join('\n'), /ignored decision plain-answer/);

    // Where the release path refuses to correlate, await did not decide either.
    for (const id of [
      'unapplied-accept',
      'accept-for-other',
      'accept-other-harness',
    ])
      assert.notDeepEqual(
        await releaseCorrelation(f, id),
        [],
        `release should refuse ${id}`,
      );

    // A real decision still wins over everything ignored above.
    const real = await decide(f);
    const decided = await applyAwait(f.request(), virtualClock());
    assert.equal(decided.status, 'decided', JSON.stringify(decided.detail));
    assert.equal(decided.detail?.decision?.message_id, real);
    // The earlier rejection was valid evidence, only superseded: the last valid decision counts.
    assert.equal(decided.detail?.ignored_total, 5);
    assert.equal(
      decided.detail?.ignored.some((item) => item.message_id === 'rejection'),
      false,
    );
  } finally {
    f.fixture.cleanup();
  }
});

test("the last decision that passes the release-correlation evidence counts: await's own rule, not the work-plan evaluator's verdict", async () => {
  const f = await reportedFixture('await-witness');
  try {
    craftDecision(f, { id: 'first-accept' });
    assert.equal(
      (await applyAwait(f.request(), virtualClock())).detail?.decision
        ?.message_id,
      'first-accept',
    );
    craftDecision(f, {
      id: 'later-rejection',
      acceptance: {
        assignment_id: 'writer-one',
        attempt: 1,
        report_digest: f.report.digest,
        decision: 'rejected',
      },
    });
    const rejected = await applyAwait(f.request(), virtualClock());
    assert.equal(rejected.status, 'timeout', JSON.stringify(rejected.detail));
    assert.equal(rejected.detail?.decision, null);
    craftDecision(f, { id: 'final-accept' });
    const accepted = await applyAwait(f.request(), virtualClock());
    assert.equal(accepted.detail?.decision?.message_id, 'final-accept');
  } finally {
    f.fixture.cleanup();
  }
});

test("decided is the release-correlation evidence, not the work-plan evaluator's verdict", async () => {
  const f = await reportedFixture('await-not-evaluator');
  try {
    const accepted = await decide(f);
    const evaluation = () =>
      evaluateCohortPlan(f.taskRoot, readRecord(f.taskRoot)!).evaluation;
    assert.equal(evaluation()?.accepted_nodes.length, 1);
    assert.equal(
      (await applyAwait(f.request(), virtualClock())).detail?.decision
        ?.message_id,
      accepted,
    );

    // One more decision of the coordinator arrives through the lower-level message path, addressed
    // to somebody else. It fails the release-correlation evidence, so await keeps the earlier valid
    // decision. The evaluator judges the last applied decision itself and no longer accepts the node.
    craftDecision(f, { id: 'extra-answer', to: OTHER_WRITER });
    const result = await applyAwait(f.request(), virtualClock());
    assert.equal(result.status, 'decided', JSON.stringify(result.detail));
    assert.equal(result.detail?.decision?.message_id, accepted);
    assert.deepEqual(result.detail?.ignored, [
      {
        message_id: 'extra-answer',
        reason: 'decision_not_addressed_to_caller',
      },
    ]);
    assert.equal(evaluation()?.accepted_nodes.length, 0);
    assert.equal(evaluation()?.awaiting_acceptance_nodes.length, 1);
  } finally {
    f.fixture.cleanup();
  }
});

test('a decision for an earlier report does not decide the current one', async () => {
  const f = await reportedFixture('await-other-report', false);
  try {
    const output = join(f.fixture.root, 'a', 'first.txt');
    writeFileSync(output, 'first\n');
    const blocked = await applyParticipant(
      reportRequest(f.taskRoot, [output], 'needs_input'),
      { notify: silentNotify },
    );
    assert.equal(blocked.status, 'applied', JSON.stringify(blocked.blockers));
    const earlier = {
      id: blocked.messages[0]!.message_id,
      digest: blocked.messages[0]!.digest ?? '',
    };
    // A hand-made decision of the coordinator on the earlier, unfinished report.
    craftDecision(
      { ...f, report: earlier },
      {
        id: 'accept-earlier-report',
        acceptance: {
          assignment_id: 'writer-one',
          attempt: 1,
          report_digest: earlier.digest,
          decision: 'accepted',
        },
      },
    );
    const done = join(f.fixture.root, 'a', 'output.txt');
    const completed = await applyParticipant(
      reportRequest(f.taskRoot, [done], 'completed', 'Now finished.'),
      { notify: silentNotify },
    );
    assert.equal(
      completed.status,
      'applied',
      JSON.stringify(completed.blockers),
    );
    const result = await applyAwait(f.request(), virtualClock());
    assert.equal(result.status, 'timeout', JSON.stringify(result.detail));
    assert.equal(
      result.detail?.report_message_id,
      completed.messages[0]!.message_id,
    );
    assert.deepEqual(result.detail?.ignored, [
      {
        message_id: 'accept-earlier-report',
        reason: 'decision_for_other_report',
      },
    ]);
  } finally {
    f.fixture.cleanup();
  }
});

test('a registered decision that was changed or replaced by a link after it was applied is ignored', async () => {
  const tampered = await reportedFixture('await-tamper');
  try {
    const id = await decide(tampered);
    const file = join(tampered.taskRoot, 'messages', `${id}.json`);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      body: { reason: string };
    };
    stored.body.reason = 'Changed after it was applied.';
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
    const result = await applyAwait(tampered.request(), virtualClock());
    assert.equal(result.status, 'timeout', JSON.stringify(result.detail));
    assert.deepEqual(result.detail?.ignored, [
      { message_id: id, reason: 'decision_digest_mismatch' },
    ]);
  } finally {
    tampered.fixture.cleanup();
  }

  const linked = await reportedFixture('await-link');
  try {
    const id = await decide(linked);
    const file = join(linked.taskRoot, 'messages', `${id}.json`);
    const copy = join(linked.fixture.root, 'copy.json');
    writeFileSync(copy, readFileSync(file));
    rmSync(file);
    symlinkSync(copy, file);
    const result = await applyAwait(linked.request(), virtualClock());
    assert.equal(result.status, 'timeout', JSON.stringify(result.detail));
    assert.deepEqual(result.detail?.ignored, [
      { message_id: id, reason: 'decision_unreadable' },
    ]);
  } finally {
    linked.fixture.cleanup();
  }

  const missing = await reportedFixture('await-missing');
  try {
    const id = await decide(missing);
    rmSync(join(missing.taskRoot, 'messages', `${id}.json`));
    const result = await applyAwait(missing.request(), virtualClock());
    assert.equal(result.status, 'timeout');
    assert.equal(result.detail?.ignored[0]?.reason, 'decision_unreadable');
  } finally {
    missing.fixture.cleanup();
  }
});

test('after a succession a decision of the earlier coordinator counts when applied before its epoch ended', async () => {
  const f = await reportedFixture('await-succ-valid');
  try {
    const id = await decide(f, COORDINATOR);
    succeed(f.taskRoot, '2099-01-01T00:00:00Z');
    const result = await applyAwait(f.request(), virtualClock());
    assert.equal(result.status, 'decided', JSON.stringify(result.detail));
    assert.equal(result.detail?.decision?.message_id, id);
    assert.equal(result.detail?.decision?.owner_epoch, 1);
    assert.deepEqual(await releaseCorrelation(f, id), []);
  } finally {
    f.fixture.cleanup();
  }
});

test('after a succession a decision applied after its epoch ended is ignored and the successor decides', async () => {
  const f = await reportedFixture('await-succ-late');
  try {
    const old = await decide(f, COORDINATOR);
    // The handoff completed before that decision was applied.
    succeed(f.taskRoot, '2020-01-01T00:00:00Z');
    const late = await applyAwait(f.request(), virtualClock());
    assert.equal(late.status, 'timeout', JSON.stringify(late.detail));
    assert.deepEqual(late.detail?.ignored, [
      {
        message_id: old,
        reason: 'decision_evidence_applied_after_epoch_ended',
      },
    ]);
    assert.notDeepEqual(await releaseCorrelation(f, old), []);

    const fresh = await decide(f, NEXT);
    assert.notEqual(fresh, old);
    const result = await applyAwait(f.request(), virtualClock());
    assert.equal(result.status, 'decided', JSON.stringify(result.detail));
    assert.equal(result.detail?.decision?.message_id, fresh);
    assert.equal(result.detail?.decision?.owner_epoch, 2);
    assert.equal(result.detail?.decision?.from.agent_id, NEXT.agent_id);
    assert.equal(result.detail?.ignored_total, 1);
    assert.deepEqual(await releaseCorrelation(f, fresh), []);
  } finally {
    f.fixture.cleanup();
  }
});

test('after a succession the successor can decide a report made under the earlier epoch', async () => {
  const f = await reportedFixture('await-succ-new');
  try {
    succeed(f.taskRoot, '2099-01-01T00:00:00Z');
    assert.equal(
      (await applyAwait(f.request(), virtualClock())).status,
      'timeout',
    );
    const id = await decide(f, NEXT);
    const result = await applyAwait(f.request(), virtualClock());
    assert.equal(result.status, 'decided', JSON.stringify(result.detail));
    assert.equal(result.detail?.decision?.message_id, id);
    assert.equal(result.detail?.decision?.owner_epoch, 2);
  } finally {
    f.fixture.cleanup();
  }
});

test('an invalid lineage reduces the evidence to the current coordinator only', async () => {
  const f = await reportedFixture('await-succ-broken');
  try {
    const id = await decide(f, COORDINATOR);
    succeed(f.taskRoot, '2099-01-01T00:00:00Z');
    // The record and its last handoff now disagree about who came before: no lineage is trusted.
    const broke = transact(f.taskRoot, {
      actor: 'fixture',
      purpose: 'break-lineage',
      apply: (record) => {
        record.coordinator = {
          ...record.coordinator!,
          previous: null,
        };
        return { record, op: 'break', summary: {}, result: { ok: true } };
      },
    });
    assert.ok(broke.ok);
    const result = await applyAwait(f.request(), virtualClock());
    assert.equal(result.status, 'timeout', JSON.stringify(result.detail));
    assert.deepEqual(result.detail?.ignored, [
      { message_id: id, reason: 'decision_not_from_current_coordinator' },
    ]);
    assert.notDeepEqual(await releaseCorrelation(f, id), []);
  } finally {
    f.fixture.cleanup();
  }
});

function writeRequest(f: Fixture, request: unknown, name = 'await.json') {
  const file = join(f.fixture.root, name);
  writeFileSync(file, JSON.stringify(request));
  return file;
}

/** The CLI with every Herdr hint removed: the channel under test must not need it. */
function invoke(f: Fixture, args: string[]) {
  return spawnSync(process.execPath, [cli, 'collab', 'workflow', ...args], {
    cwd: f.fixture.root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: f.fixture.root,
      HERDR_ENV: '',
      HERDR_PANE_ID: '',
      HERDR_SOCKET_PATH: join(f.fixture.root, 'absent-herdr.sock'),
    },
  });
}

test('the CLI exits 0 only for a decision: a timeout exits 1 with status timeout and its reason', async () => {
  const f = await reportedFixture('await-cli');
  try {
    const file = writeRequest(f, f.request({ timeout_seconds: 1 }));
    const waited = invoke(f, ['await', '--request', file, '--json']);
    assert.equal(waited.status, 1, waited.stderr + waited.stdout);
    const timeout = JSON.parse(waited.stdout) as {
      status: string;
      ok: boolean;
      apply: boolean;
      blockers: { code: string }[];
      detail: { polls: number; decision: unknown };
    };
    assert.equal(timeout.status, 'timeout');
    assert.equal(timeout.ok, false);
    assert.deepEqual(
      timeout.blockers.map((blocker) => blocker.code),
      ['await_timeout'],
    );
    assert.equal(timeout.apply, false);
    assert.equal(timeout.detail.decision, null);
    assert.ok(timeout.detail.polls >= 2, 'a one second wait polls again');

    const human = invoke(f, ['await', '--request', file]);
    assert.equal(human.status, 1, human.stdout);
    assert.match(human.stdout, /^Workflow await: timeout \(cohort\)\n/);
    assert.match(
      human.stdout,
      /blocker await_timeout: No valid accept decision for writer-one#1 appeared within 1s/,
    );
    assert.match(human.stdout, /next: Run await again or ask the coordinator/);

    const id = await decide(f);
    // `--apply` is accepted and changes nothing: there is nothing to apply.
    const decided = invoke(f, [
      'await',
      '--request',
      file,
      '--apply',
      '--json',
    ]);
    assert.equal(decided.status, 0, decided.stderr + decided.stdout);
    const body = JSON.parse(decided.stdout) as {
      status: string;
      apply: boolean;
      messages: { message_id: string }[];
      detail: { decision: { message_id: string } };
    };
    assert.equal(body.status, 'decided');
    assert.equal(body.apply, false);
    assert.equal(body.messages[0]?.message_id, id);
    assert.equal(body.detail.decision.message_id, id);
    const humanDecided = invoke(f, ['await', '--request', file]);
    assert.match(humanDecided.stdout, /^Workflow await: decided \(cohort\)\n/);
    assert.match(
      humanDecided.stdout,
      new RegExp(`ANSWER ${id}: applied, delivery not-attempted`),
    );
    assert.match(humanDecided.stdout, /next: Run release/);
  } finally {
    f.fixture.cleanup();
  }
});

test('await && release cannot release without a decision, and releases once there is one', async () => {
  const f = await reportedFixture('await-chain');
  try {
    const awaitFile = writeRequest(
      f,
      f.request({ timeout_seconds: 1 }),
      'await.json',
    );
    const releaseFile = (correlatesTo: string | null) =>
      writeRequest(
        f,
        {
          ...releaseRequest(f.taskRoot, 'unused'),
          release: {
            reason: 'chained release',
            cancel_attempt: false,
            correlates_to: correlatesTo,
          },
        },
        'release.json',
      );
    const chain = (release: string) =>
      spawnSync(
        '/bin/sh',
        [
          '-c',
          '"$0" "$1" collab workflow await --request "$2" --json && "$0" "$1" collab workflow release --request "$3" --apply --json',
          process.execPath,
          cli,
          awaitFile,
          release,
        ],
        {
          cwd: f.fixture.root,
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            HOME: f.fixture.root,
            HERDR_ENV: '',
            HERDR_PANE_ID: '',
            HERDR_SOCKET_PATH: join(f.fixture.root, 'absent-herdr.sock'),
          },
        },
      );
    const held = () =>
      readRecord(f.taskRoot)!.claims.filter(
        (claim) => claim.released_at === null,
      ).length;
    const releasedStatus = join(
      f.taskRoot,
      'messages',
      'released-writer-one-1.json',
    );
    assert.ok(held() > 0, 'the writer holds its claims');

    // No decision yet: the wait times out, exits 1 and the chain stops before the release.
    const early = chain(releaseFile(null));
    assert.equal(early.status, 1, early.stderr + early.stdout);
    const lines = early.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'only await ran');
    assert.equal(
      (JSON.parse(lines[0]!) as { status: string }).status,
      'timeout',
    );
    assert.equal(existsSync(releasedStatus), false);
    assert.ok(held() > 0, 'a timeout released nothing');

    // With a decision the same chain releases, and the release may cite the decision.
    const id = await decide(f);
    const done = chain(releaseFile(id));
    assert.equal(done.status, 0, done.stderr + done.stdout);
    const results = done.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { action: string; status: string });
    assert.deepEqual(
      results.map((item) => `${item.action}:${item.status}`),
      ['await:decided', 'release:applied'],
    );
    assert.equal(existsSync(releasedStatus), true);
    assert.equal(held(), 0);
  } finally {
    f.fixture.cleanup();
  }
});

test('the CLI maps refusals to exit 1 and invalid documents or arguments to exit 2', async () => {
  const f = await reportedFixture('await-cli-codes');
  try {
    const denied = writeRequest(
      f,
      f.request({ caller: { ...OTHER_WRITER, cwd: f.fixture.root } }),
      'denied.json',
    );
    const refused = invoke(f, ['await', '--request', denied, '--json']);
    assert.equal(refused.status, 1, refused.stdout);
    assert.equal(
      (JSON.parse(refused.stdout) as { blockers: { code: string }[] })
        .blockers[0]?.code,
      'sender_denied',
    );

    const tooLong = writeRequest(
      f,
      f.request({ timeout_seconds: WORKFLOW_AWAIT_MAX_TIMEOUT_SECONDS + 1 }),
      'long.json',
    );
    const long = invoke(f, ['await', '--request', tooLong]);
    assert.equal(long.status, 2, long.stdout);
    assert.match(long.stdout, /timeout_seconds/);

    const wrong = writeRequest(
      f,
      reportRequest(f.taskRoot, []),
      'participant.json',
    );
    const mismatch = invoke(f, ['await', '--request', wrong]);
    assert.equal(mismatch.status, 2, mismatch.stdout);
    assert.match(
      mismatch.stdout,
      /Expected a pappra\/collab-workflow-await-request\/1 document/,
    );

    assert.equal(invoke(f, ['await']).status, 2);
    const withTaskRoot = invoke(f, [
      'await',
      '--request',
      denied,
      '--task-root',
      f.taskRoot,
    ]);
    assert.equal(withTaskRoot.status, 2);
    assert.match(withTaskRoot.stdout, /--task-root is not accepted here/);
    assert.equal(
      invoke(f, ['await', '--request', denied, '--limit', '3']).status,
      2,
    );
  } finally {
    f.fixture.cleanup();
  }
});

test('a separate await process sees a decision recorded after it started, with no Herdr at all', async () => {
  const f = await reportedFixture('await-live');
  try {
    const file = writeRequest(
      f,
      f.request({ timeout_seconds: 30, poll_interval_seconds: 1 }),
    );
    const child = spawn(
      process.execPath,
      [cli, 'collab', 'workflow', 'await', '--request', file, '--json'],
      {
        cwd: f.fixture.root,
        env: {
          ...process.env,
          HOME: f.fixture.root,
          HERDR_ENV: '',
          HERDR_PANE_ID: '',
          HERDR_SOCKET_PATH: join(f.fixture.root, 'absent-herdr.sock'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const closed = new Promise<number | null>((resolve) =>
      child.on('close', resolve),
    );
    // A hung child must fail this test, not the whole run.
    const guard = setTimeout(() => child.kill('SIGKILL'), 25_000);
    // The coordinator decides while the worker is already waiting; nothing wakes the worker.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const id = await decide(f);
    const code = await closed;
    clearTimeout(guard);
    assert.equal(code, 0, stderr + stdout);
    const result = JSON.parse(stdout) as {
      status: string;
      detail: { decision: { message_id: string }; polls: number };
    };
    assert.equal(result.status, 'decided');
    assert.equal(result.detail.decision.message_id, id);
    // Whether it saw the decision on its first or a later observation depends on how fast the
    // process started; both are the same outcome and neither may be asserted on.
    assert.ok(result.detail.polls >= 1);
  } finally {
    f.fixture.cleanup();
  }
});
