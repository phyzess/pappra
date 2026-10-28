import assert from 'node:assert/strict';
import fs, {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  applyAccept,
  applyAcceptBatch,
  applyParticipant,
  applyPrepare,
  type WorkflowAcceptBatchRequest,
  type WorkflowAcceptRequest,
  type WorkflowParticipantRequest,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import type { notifyRegisteredMessage } from '../../src/app/collab-notify.js';
import {
  buildMessage,
  contentDigest,
  readRegisteredMessage,
  registerMessage,
} from '../../src/collab/envelope.js';
import { readRecord, transact } from '../../src/collab/store.js';
import type { Identity, Message } from '../../src/collab/types.js';
import { makeTaskDomain } from './task-resources-fixtures.js';
import { owner } from './scenarios.js';

// The accept id after a coordinator succession, the authority re-check before its second write, and
// the delivery fallback of an accept whose notification did not reach the worker. Races are
// injected where the exclusive create of the decision happens, through the same `fs` mocking the
// other collaboration tests use.

const COORDINATOR = {
  agent_id: owner.agent_id,
  session_id: owner.session_id,
  harness: owner.harness,
  owner_epoch: owner.owner_epoch,
  since: owner.since,
};

/** The coordinator of epoch 1 as a message sender. */
const EARLIER = {
  agent_id: COORDINATOR.agent_id,
  session_id: COORDINATOR.session_id,
  harness: COORDINATOR.harness,
};

const NEXT = {
  agent_id: 'next-coordinator',
  session_id: 'next-session',
  harness: 'claude',
};

/** The coordinator that takes over from `NEXT` in a second succession. */
const AFTER_NEXT = {
  agent_id: 'after-next-coordinator',
  session_id: 'after-next-session',
  harness: 'claude',
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

const ONE = {
  subtask: 'writer-one',
  writer: WRITER_A,
  directory: 'a',
  baseId: 'accept-writer-one-1',
};

const TWO = {
  subtask: 'writer-two',
  writer: WRITER_B,
  directory: 'b',
  baseId: 'accept-writer-two-1',
};

type Subtask = typeof ONE;

type NotifyResult = Awaited<ReturnType<typeof notifyRegisteredMessage>>;

/** A delivery stub that records the ids it was asked to deliver and answers with `result`. */
function notifier(result?: unknown) {
  const calls: string[] = [];
  const notify = (async (options: { messageId: string }) => {
    calls.push(options.messageId);
    return (
      result ?? {
        ok: true as const,
        value: {
          status: 'submitted' as const,
          messageId: options.messageId,
          detail: null,
          consumed: false as const,
          taskAccepted: false as const,
        },
      }
    );
  }) as unknown as typeof notifyRegisteredMessage;
  return { notify, calls };
}

const silentNotify = notifier().notify;

const TRANSPORT_FAILURE: NotifyResult = {
  ok: false,
  code: 'transport_unavailable',
  message: 'Operation not permitted',
  nextAction: null,
};

function prepareRequest(
  domainRoot: string,
  cwd: string,
  subtasks: readonly Subtask[],
): WorkflowPrepareRequest {
  const member = (identity: typeof NEXT) => ({
    agent_id: identity.agent_id,
    session_id: identity.session_id,
    harness: identity.harness,
    cwd,
    surface: 'cli',
    configuration_id: 'daily-visible',
  });
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
      member(COORDINATOR),
      ...subtasks.map((item) => member(item.writer)),
    ],
    bindings: [],
    assignments: subtasks.map((item) => ({
      subtask_id: item.subtask,
      role: 'writer' as const,
      assignee: item.writer.agent_id,
      objective: `Objective for ${item.subtask}.`,
      acceptance: [`Acceptance for ${item.subtask}.`],
      resources: [
        { path: join(cwd, item.directory), access: 'write' as const },
      ],
      required_skills: [],
      required_tools: [],
      native_evidence: [],
    })),
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  } satisfies WorkflowPrepareRequest;
}

function reportRequest(
  taskRoot: string,
  item: Subtask,
  outputs: string[],
): WorkflowParticipantRequest {
  return {
    schema: 'pappra/collab-workflow-participant-request/1',
    action: 'report',
    task_root: taskRoot,
    caller: { ...item.writer, cwd: taskRoot },
    subtask_id: item.subtask,
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

/**
 * Completes a second coordinator handoff on disk, from `NEXT` at epoch 2 to `to` at epoch 3, so the
 * record moves on after `succeed`. `to` may be `NEXT` itself: the same identity at a later epoch.
 */
function succeedAgain(
  taskRoot: string,
  to: typeof NEXT,
  endedAt: string,
): void {
  const done = transact(taskRoot, {
    actor: 'fixture',
    purpose: 'succeed-again',
    apply: (record) => {
      // The epoch being ended began when the first handoff completed.
      const began = record.coordinator?.since ?? endedAt;
      const before = {
        agent_id: NEXT.agent_id,
        session_id: NEXT.session_id,
        owner_epoch: 2,
      };
      record.coordinator = {
        ...to,
        owner_epoch: 3,
        since: endedAt,
        previous: before,
      } as never;
      record.handoffs = [
        ...(record.handoffs ?? []),
        {
          schema: 'harness-collab/handoff/1',
          handoff_id: 'h2',
          kind: 'coordinator',
          subtask_id: null,
          attempt: null,
          from: NEXT,
          to,
          resources: [],
          ownership_snapshot: [],
          state: 'completed',
          owner_epoch: 3,
          created_at: endedAt,
          updated_at: endedAt,
          reason: null,
          steps: [{ state: 'completed', at: endedAt, actor: 'fixture' }],
          partial_outputs: [],
          inflight: [],
          pending_approvals: [],
          confirmation_message_id: null,
          previous_coordinator: { ...NEXT, ...before, since: began },
        } as never,
      ];
      return {
        record,
        op: 'succeed-again',
        summary: {},
        result: { ok: true },
      };
    },
  });
  assert.ok(done.ok);
}

/** Removes every handoff, so the lineage no longer shows any succession. */
function dropHandoffs(taskRoot: string): void {
  const done = transact(taskRoot, {
    actor: 'fixture',
    purpose: 'drop-handoffs',
    apply: (record) => {
      record.handoffs = [];
      return { record, op: 'drop-handoffs', summary: {}, result: { ok: true } };
    },
  });
  assert.ok(done.ok);
}

/** A cohort whose writers have reported and whose reports are not decided yet. */
async function reportedFixture(
  label: string,
  subtasks: readonly Subtask[] = [ONE],
) {
  const fixture = makeTaskDomain(label, ['cohort'], { initialize: [] });
  const prepared = await applyPrepare(
    prepareRequest(fixture.domainRoot, fixture.root, subtasks),
  );
  assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
  const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
  const reports = new Map<string, string>();
  for (const item of subtasks) {
    mkdirSync(join(fixture.root, item.directory), { recursive: true });
    const output = join(fixture.root, item.directory, 'output.txt');
    writeFileSync(output, 'built\n');
    const reported = await applyParticipant(
      reportRequest(taskRoot, item, [output]),
      { notify: silentNotify },
    );
    assert.equal(reported.status, 'applied', JSON.stringify(reported.blockers));
    reports.set(item.subtask, reported.messages[0]!.message_id);
  }
  const reportOf = (item: Subtask): string => {
    const id = reports.get(item.subtask);
    assert.ok(id !== undefined);
    return id;
  };
  const accept = (
    caller: typeof NEXT | typeof COORDINATOR,
    item: Subtask = ONE,
  ): WorkflowAcceptRequest => ({
    schema: 'pappra/collab-workflow-accept-request/1',
    task_root: taskRoot,
    caller: { ...caller, cwd: fixture.root },
    subtask_id: item.subtask,
    attempt: 1,
    report_message_id: reportOf(item),
    caller_pane: null,
    reason: 'Looks complete.',
  });
  const batch = (
    caller: typeof NEXT | typeof COORDINATOR,
  ): WorkflowAcceptBatchRequest => ({
    schema: 'pappra/collab-workflow-accept-batch-request/1',
    task_root: taskRoot,
    caller: { ...caller, cwd: fixture.root },
    caller_pane: null,
    accepts: subtasks.map((item) => ({
      subtask_id: item.subtask,
      attempt: 1,
      report_message_id: reportOf(item),
      reason: 'Looks complete.',
    })),
  });
  return { fixture, taskRoot, accept, batch, reportOf };
}

/**
 * A message another writer registers, derived from the decision the accept was about to register
 * so that only the stated fields differ from it.
 */
function competitor(
  attempted: Message,
  changes: {
    readonly from?: Identity;
    readonly owner_epoch?: number;
    readonly reason?: string;
    readonly message_id?: string;
  } = {},
): Message {
  return buildMessage({
    type: attempted.type,
    task_id: attempted.task_id,
    from: changes.from ?? attempted.from,
    to: attempted.to,
    reply_to: attempted.reply_to,
    message_id: changes.message_id ?? attempted.message_id,
    subtask_id: attempted.subtask_id,
    attempt: attempted.attempt,
    owner_epoch: changes.owner_epoch ?? attempted.owner_epoch,
    body:
      changes.reason === undefined
        ? attempted.body
        : { ...attempted.body, reason: changes.reason },
  });
}

/** A decision-shaped message that someone else registered before the accept started. */
function handMade(
  reportId: string,
  id: string,
  from: typeof NEXT,
  epoch: number,
  reason: string,
): Message {
  return buildMessage({
    type: 'ANSWER',
    task_id: 'cohort',
    from,
    to: {
      agent_id: WRITER_A.agent_id,
      session_id: WRITER_A.session_id,
      harness: WRITER_A.harness,
    },
    reply_to: reportId,
    message_id: id,
    subtask_id: ONE.subtask,
    attempt: 1,
    owner_epoch: epoch,
    body: { status: 'completed', reason },
  });
}

function register(taskRoot: string, message: Message): void {
  const registered = registerMessage(taskRoot, message);
  assert.equal(registered.status, 'registered', JSON.stringify(registered));
}

/**
 * Makes the first exclusive create of `baseId` lose a race: `compete` runs at that moment, with
 * the decision the accept was about to register, and the create then fails because the file now
 * exists. Every exclusive create of an accept id is listed in `attempts`, in order.
 */
function loseRaceOnBaseId(
  t: TestContext,
  taskRoot: string,
  baseId: string,
  compete: (attempted: Message) => void,
): { readonly attempts: string[] } {
  const messages = join(taskRoot, 'messages');
  const baseFile = join(messages, `${baseId}.json`);
  const original = fs.writeFileSync;
  const attempts: string[] = [];
  let racing = false;
  let fired = false;
  t.mock.method(
    fs,
    'writeFileSync',
    (
      file: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions,
    ) => {
      const exclusive =
        typeof options === 'object' &&
        options !== null &&
        options.flag === 'wx';
      if (
        !racing &&
        exclusive &&
        typeof file === 'string' &&
        dirname(file) === messages &&
        basename(file).startsWith('accept-')
      ) {
        attempts.push(basename(file, '.json'));
        if (file === baseFile && !fired) {
          fired = true;
          racing = true;
          try {
            compete(JSON.parse(String(data)) as Message);
          } finally {
            racing = false;
          }
        }
      }
      return original(file, data, options);
    },
  );
  return { attempts };
}

function decisionsFor(taskRoot: string, reportId: string) {
  const record = readRecord(taskRoot);
  assert.ok(record !== null);
  return record.messages
    .filter((entry) => entry.type === 'ANSWER' && entry.reply_to === reportId)
    .map((entry) => ({
      id: entry.message_id,
      state: entry.state,
      epoch: entry.owner_epoch,
    }));
}

const messageFile = (taskRoot: string, id: string) =>
  join(taskRoot, 'messages', `${id}.json`);

/** The accept decisions registered on disk, whether or not they were ever applied. */
function acceptFiles(taskRoot: string): string[] {
  return readdirSync(join(taskRoot, 'messages'))
    .filter((name) => name.startsWith('accept-'))
    .sort();
}

test('a lost race with a base-id message of another epoch takes the epoch-qualified id once', async (t) => {
  const { fixture, taskRoot, accept, reportOf } =
    await reportedFixture('suffix-race');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const winnerBytes: string[] = [];
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, (attempted) => {
      // The earlier coordinator registered the base id and stopped before applying it.
      register(
        taskRoot,
        competitor(attempted, { from: EARLIER, owner_epoch: 1 }),
      );
      winnerBytes.push(readFileSync(messageFile(taskRoot, ONE.baseId), 'utf8'));
    });
    const delivery = notifier();
    const decision = await applyAccept(accept(NEXT), {
      notify: delivery.notify,
    });
    t.mock.restoreAll();

    assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
    assert.equal(decision.messages[0]?.message_id, 'accept-writer-one-1-e2');
    assert.equal(decision.messages[0]?.registration, 'registered');
    assert.equal(decision.messages[0]?.delivery, 'submitted');
    assert.deepEqual(
      race.attempts,
      ['accept-writer-one-1', 'accept-writer-one-1-e2'],
      'one lost create, then exactly one retry',
    );
    assert.deepEqual(
      delivery.calls,
      ['accept-writer-one-1-e2'],
      'the qualified decision is the one delivered',
    );
    // The winner is neither touched nor applied, and the successor's decision stands alone.
    assert.deepEqual(winnerBytes, [
      readFileSync(messageFile(taskRoot, ONE.baseId), 'utf8'),
    ]);
    assert.deepEqual(decisionsFor(taskRoot, reportOf(ONE)), [
      { id: 'accept-writer-one-1-e2', state: 'applied', epoch: 2 },
    ]);
    assert.equal(
      readRegisteredMessage(taskRoot, 'accept-writer-one-1-e2')?.owner_epoch,
      2,
    );
    // The qualified decision is final like any other.
    const again = await applyAccept(accept(NEXT), { notify: silentNotify });
    assert.ok(
      again.blockers.some((item) => item.code === 'acceptance_already_decided'),
      JSON.stringify(again.blockers),
    );
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('a base-id message the pre-check already sees is qualified without a lost create', async (t) => {
  const { fixture, taskRoot, accept, reportOf } =
    await reportedFixture('suffix-seen');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    // Registered before the call, so the id is chosen qualified from the start and nothing races.
    register(
      taskRoot,
      handMade(reportOf(ONE), ONE.baseId, EARLIER, 1, 'Looks complete.'),
    );
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, () =>
      assert.fail('the base id must not be created again'),
    );
    const decision = await applyAccept(accept(NEXT), { notify: silentNotify });
    t.mock.restoreAll();

    assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
    assert.equal(decision.messages[0]?.message_id, 'accept-writer-one-1-e2');
    assert.deepEqual(race.attempts, ['accept-writer-one-1-e2']);
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('a content-only difference at the current epoch stays a content_conflict', async (t) => {
  const { fixture, taskRoot, accept } = await reportedFixture('suffix-content');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, (attempted) =>
      register(taskRoot, competitor(attempted, { reason: 'Another reason.' })),
    );
    const delivery = notifier();
    const decision = await applyAccept(accept(NEXT), {
      notify: delivery.notify,
    });
    t.mock.restoreAll();

    assert.equal(decision.status, 'blocked');
    assert.equal(decision.ok, false);
    assert.deepEqual(
      decision.blockers.map((item) => item.code),
      ['content_conflict'],
    );
    assert.equal(decision.messages[0]?.registration, null);
    assert.deepEqual(race.attempts, ['accept-writer-one-1']);
    assert.equal(
      existsSync(messageFile(taskRoot, 'accept-writer-one-1-e2')),
      false,
    );
    assert.deepEqual(delivery.calls, []);
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('a winner with the same content is a plain duplicate and never qualifies the id', async (t) => {
  const { fixture, taskRoot, accept, reportOf } =
    await reportedFixture('suffix-same');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, (attempted) =>
      // Another process of the same coordinator registered the very same decision first.
      register(taskRoot, competitor(attempted)),
    );
    const decision = await applyAccept(accept(NEXT), { notify: silentNotify });
    t.mock.restoreAll();

    assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
    assert.equal(decision.messages[0]?.message_id, 'accept-writer-one-1');
    assert.equal(decision.messages[0]?.registration, 'duplicate');
    assert.deepEqual(race.attempts, ['accept-writer-one-1']);
    assert.deepEqual(decisionsFor(taskRoot, reportOf(ONE)), [
      { id: 'accept-writer-one-1', state: 'applied', epoch: 2 },
    ]);
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('with a one-entry lineage a lost race never qualifies the id', async (t) => {
  const { fixture, taskRoot, accept } = await reportedFixture('suffix-single');
  try {
    // No succession: epoch 1 is the only epoch. A base-id message of another epoch can only be
    // hand-made, and it is a conflict like any other.
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, (attempted) =>
      register(taskRoot, competitor(attempted, { owner_epoch: 7 })),
    );
    const decision = await applyAccept(accept(COORDINATOR), {
      notify: silentNotify,
    });
    t.mock.restoreAll();

    assert.equal(decision.status, 'blocked');
    assert.deepEqual(
      decision.blockers.map((item) => item.code),
      ['content_conflict'],
    );
    assert.deepEqual(race.attempts, ['accept-writer-one-1']);
    assert.equal(
      existsSync(messageFile(taskRoot, 'accept-writer-one-1-e1')),
      false,
    );
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('two identical qualified registrations are duplicates', async (t) => {
  const { fixture, taskRoot, accept, reportOf } =
    await reportedFixture('suffix-twin');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, (attempted) => {
      register(
        taskRoot,
        competitor(attempted, { from: EARLIER, owner_epoch: 1 }),
      );
      // Another process of the successor registered the same qualified decision first.
      register(
        taskRoot,
        competitor(attempted, { message_id: 'accept-writer-one-1-e2' }),
      );
    });
    const decision = await applyAccept(accept(NEXT), { notify: silentNotify });
    t.mock.restoreAll();

    assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
    assert.equal(decision.messages[0]?.message_id, 'accept-writer-one-1-e2');
    assert.equal(decision.messages[0]?.registration, 'duplicate');
    assert.deepEqual(race.attempts, [
      'accept-writer-one-1',
      'accept-writer-one-1-e2',
    ]);
    assert.deepEqual(decisionsFor(taskRoot, reportOf(ONE)), [
      { id: 'accept-writer-one-1-e2', state: 'applied', epoch: 2 },
    ]);
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('a conflicting qualified registration stays a content_conflict and is not retried again', async (t) => {
  const { fixture, taskRoot, accept } = await reportedFixture('suffix-clash');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, (attempted) => {
      register(
        taskRoot,
        competitor(attempted, { from: EARLIER, owner_epoch: 1 }),
      );
      register(
        taskRoot,
        competitor(attempted, {
          message_id: 'accept-writer-one-1-e2',
          reason: 'Another reason.',
        }),
      );
    });
    const delivery = notifier();
    const decision = await applyAccept(accept(NEXT), {
      notify: delivery.notify,
    });
    t.mock.restoreAll();

    assert.equal(decision.status, 'blocked');
    assert.deepEqual(
      decision.blockers.map((item) => item.code),
      ['content_conflict'],
    );
    assert.equal(decision.messages[0]?.message_id, 'accept-writer-one-1-e2');
    assert.equal(decision.messages[0]?.registration, null);
    assert.deepEqual(
      race.attempts,
      ['accept-writer-one-1', 'accept-writer-one-1-e2'],
      'exactly one retry, never a chain of ids',
    );
    assert.deepEqual(delivery.calls, []);
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('a winner that cannot be read keeps the content_conflict', async (t) => {
  const { fixture, taskRoot, accept } = await reportedFixture('suffix-opaque');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, () =>
      writeFileSync(messageFile(taskRoot, ONE.baseId), '{ not json', {
        flag: 'wx',
      }),
    );
    const decision = await applyAccept(accept(NEXT), { notify: silentNotify });
    t.mock.restoreAll();

    assert.equal(decision.status, 'blocked');
    assert.deepEqual(
      decision.blockers.map((item) => item.code),
      ['content_conflict'],
    );
    assert.deepEqual(race.attempts, ['accept-writer-one-1']);
    assert.equal(
      existsSync(messageFile(taskRoot, 'accept-writer-one-1-e2')),
      false,
    );
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('a conflict on an id that was already qualified is final and is not attempted twice', async (t) => {
  const { fixture, taskRoot, accept, reportOf } =
    await reportedFixture('suffix-twice');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    // Both registered before the call: the pre-check qualifies the id, and the qualified id
    // already holds a different decision of the current epoch.
    register(
      taskRoot,
      handMade(reportOf(ONE), ONE.baseId, EARLIER, 1, 'Looks complete.'),
    );
    register(
      taskRoot,
      handMade(
        reportOf(ONE),
        'accept-writer-one-1-e2',
        NEXT,
        2,
        'Another reason.',
      ),
    );
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, () =>
      assert.fail('the base id must not be created again'),
    );
    const decision = await applyAccept(accept(NEXT), { notify: silentNotify });
    t.mock.restoreAll();

    assert.equal(decision.status, 'blocked');
    assert.deepEqual(
      decision.blockers.map((item) => item.code),
      ['content_conflict'],
    );
    assert.equal(decision.messages[0]?.message_id, 'accept-writer-one-1-e2');
    assert.deepEqual(
      race.attempts,
      ['accept-writer-one-1-e2'],
      'a qualified id is never qualified again',
    );
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('a task namespace that changed during the call stops the retry', async (t) => {
  const { fixture, taskRoot, accept } = await reportedFixture('suffix-moved');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const messages = join(taskRoot, 'messages');
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, (attempted) => {
      // The messages directory is replaced while the winner registers, as a redirect would be.
      renameSync(messages, `${messages}-moved`);
      mkdirSync(messages, { mode: 0o700 });
      register(
        taskRoot,
        competitor(attempted, { from: EARLIER, owner_epoch: 1 }),
      );
    });
    const decision = await applyAccept(accept(NEXT), { notify: silentNotify });
    t.mock.restoreAll();

    assert.equal(decision.status, 'blocked');
    assert.deepEqual(
      decision.blockers.map((item) => item.code),
      ['task_namespace_changed', 'content_conflict'],
    );
    assert.deepEqual(race.attempts, ['accept-writer-one-1']);
    assert.equal(
      existsSync(messageFile(taskRoot, 'accept-writer-one-1-e2')),
      false,
    );
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('a succession that completes between the two writes refuses and registers nothing', async (t) => {
  const { fixture, taskRoot, accept, reportOf } =
    await reportedFixture('suffix-succeeded');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, (attempted) => {
      register(
        taskRoot,
        competitor(attempted, { from: EARLIER, owner_epoch: 1 }),
      );
      // Another coordinator takes over while this accept is between its two writes.
      succeedAgain(taskRoot, AFTER_NEXT, '2099-06-01T00:00:00Z');
    });
    const delivery = notifier();
    const decision = await applyAccept(accept(NEXT), {
      notify: delivery.notify,
    });
    t.mock.restoreAll();

    assert.equal(decision.status, 'refused');
    assert.equal(decision.ok, false);
    assert.deepEqual(
      decision.blockers.map((item) => item.code),
      ['accept_not_coordinator'],
    );
    assert.deepEqual(decision.messages, []);
    assert.deepEqual(
      race.attempts,
      ['accept-writer-one-1'],
      'the qualified id is never created',
    );
    assert.deepEqual(
      acceptFiles(taskRoot),
      ['accept-writer-one-1.json'],
      'no orphan qualified file is left behind',
    );
    assert.deepEqual(decisionsFor(taskRoot, reportOf(ONE)), []);
    assert.deepEqual(delivery.calls, []);

    // It is the refusal a caller that already was not the coordinator gets from the first checks.
    const atStart = await applyAccept(accept(NEXT), { notify: silentNotify });
    assert.deepEqual(Object.keys(atStart), Object.keys(decision));
    assert.equal(atStart.status, decision.status);
    assert.equal(atStart.blockers[0]?.code, decision.blockers[0]?.code);
    assert.equal(atStart.next_action, decision.next_action);
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('the same coordinator at a later epoch refuses too: the decision would carry a stale epoch', async (t) => {
  const { fixture, taskRoot, accept, reportOf } =
    await reportedFixture('suffix-reelected');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, (attempted) => {
      register(
        taskRoot,
        competitor(attempted, { from: EARLIER, owner_epoch: 1 }),
      );
      // The same identity holds the next epoch: the caller still matches, its epoch does not.
      succeedAgain(taskRoot, NEXT, '2099-06-01T00:00:00Z');
    });
    const decision = await applyAccept(accept(NEXT), { notify: silentNotify });
    t.mock.restoreAll();

    assert.equal(decision.status, 'refused');
    assert.deepEqual(
      decision.blockers.map((item) => item.code),
      ['acceptance_stale'],
    );
    assert.match(
      decision.blockers[0]?.detail ?? '',
      /began under epoch 2 and the record is now at epoch 3/,
    );
    assert.deepEqual(race.attempts, ['accept-writer-one-1']);
    assert.deepEqual(acceptFiles(taskRoot), ['accept-writer-one-1.json']);
    assert.deepEqual(decisionsFor(taskRoot, reportOf(ONE)), []);
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('a lineage that no longer shows the succession refuses and registers nothing', async (t) => {
  const { fixture, taskRoot, accept, reportOf } =
    await reportedFixture('suffix-unshown');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, (attempted) => {
      register(
        taskRoot,
        competitor(attempted, { from: EARLIER, owner_epoch: 1 }),
      );
      // The caller and its epoch are unchanged, but the handoffs that justify the lineage are gone.
      dropHandoffs(taskRoot);
    });
    const decision = await applyAccept(accept(NEXT), { notify: silentNotify });
    t.mock.restoreAll();

    assert.equal(decision.status, 'refused');
    assert.deepEqual(
      decision.blockers.map((item) => item.code),
      ['acceptance_stale'],
    );
    assert.match(
      decision.blockers[0]?.detail ?? '',
      /lineage no longer shows the succession/,
    );
    assert.deepEqual(race.attempts, ['accept-writer-one-1']);
    assert.deepEqual(acceptFiles(taskRoot), ['accept-writer-one-1.json']);
    assert.deepEqual(decisionsFor(taskRoot, reportOf(ONE)), []);
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

/** The winner of the race also became an applied decision, as far as the record shows. */
function applyWinner(taskRoot: string, winner: Message): void {
  const applied = transact(taskRoot, {
    actor: 'fixture',
    purpose: 'apply-winner',
    apply: (record) => {
      record.messages.push({
        message_id: winner.message_id,
        type: winner.type,
        subtask_id: winner.subtask_id,
        attempt: winner.attempt,
        from: winner.from,
        to: winner.to,
        reply_to: winner.reply_to,
        owner_epoch: winner.owner_epoch,
        content_digest: contentDigest(winner),
        at: winner.created_at,
        applied_at: new Date().toISOString(),
        state: 'applied',
        detail: 'applied by the fixture',
        body_kind: null,
      });
      return { record, op: 'apply-winner', summary: {}, result: { ok: true } };
    },
  });
  assert.ok(applied.ok);
}

test('a winner that already is a valid applied decision is final and is not decided again', async (t) => {
  const { fixture, taskRoot, accept, reportOf } =
    await reportedFixture('suffix-final');
  try {
    // Epoch 1 ends far in the future, so a decision applied now was applied inside it.
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, (attempted) => {
      const winner = competitor(attempted, { from: EARLIER, owner_epoch: 1 });
      register(taskRoot, winner);
      applyWinner(taskRoot, winner);
    });
    const delivery = notifier();
    const decision = await applyAccept(accept(NEXT), {
      notify: delivery.notify,
    });
    t.mock.restoreAll();

    assert.equal(decision.status, 'blocked');
    assert.deepEqual(
      decision.blockers.map((item) => item.code),
      ['acceptance_already_decided', 'content_conflict'],
    );
    assert.deepEqual(race.attempts, ['accept-writer-one-1']);
    assert.equal(
      existsSync(messageFile(taskRoot, 'accept-writer-one-1-e2')),
      false,
    );
    assert.deepEqual(decisionsFor(taskRoot, reportOf(ONE)), [
      { id: 'accept-writer-one-1', state: 'applied', epoch: 1 },
    ]);
    assert.deepEqual(delivery.calls, []);
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('a winner applied after its epoch ended does not count, so the successor decides with the qualified id', async (t) => {
  const { fixture, taskRoot, accept, reportOf } =
    await reportedFixture('suffix-late');
  try {
    // Epoch 1 ended long ago; a decision applied now was applied after it.
    succeed(taskRoot, '2020-01-01T00:00:00Z');
    const race = loseRaceOnBaseId(t, taskRoot, ONE.baseId, (attempted) => {
      const winner = competitor(attempted, { from: EARLIER, owner_epoch: 1 });
      register(taskRoot, winner);
      applyWinner(taskRoot, winner);
    });
    const decision = await applyAccept(accept(NEXT), { notify: silentNotify });
    t.mock.restoreAll();

    assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
    assert.equal(decision.messages[0]?.message_id, 'accept-writer-one-1-e2');
    assert.deepEqual(race.attempts, [
      'accept-writer-one-1',
      'accept-writer-one-1-e2',
    ]);
    assert.deepEqual(
      decisionsFor(taskRoot, reportOf(ONE)).map((item) => item.id),
      ['accept-writer-one-1', 'accept-writer-one-1-e2'],
    );
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('an accept whose notification fails is recorded and names the worker-side next action', async () => {
  const { fixture, taskRoot, accept, reportOf } =
    await reportedFixture('fallback-failed');
  try {
    const failing = notifier(TRANSPORT_FAILURE);
    const decision = await applyAccept(accept(COORDINATOR), {
      notify: failing.notify,
    });

    assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
    assert.equal(decision.ok, true);
    assert.equal(decision.messages[0]?.delivery, 'not-notified');
    assert.deepEqual(failing.calls, ['accept-writer-one-1']);
    assert.deepEqual(decision.warnings, [
      'transport_unavailable: Operation not permitted',
    ]);
    const fallback = decision.detail?.delivery_fallback;
    assert.ok(fallback !== undefined);
    assert.deepEqual(Object.keys(fallback).sort(), [
      'reason',
      'worker_next_action',
    ]);
    assert.equal(
      fallback.reason,
      'transport_unavailable: Operation not permitted',
    );
    assert.match(fallback.worker_next_action, /`collab workflow await`/);
    assert.match(
      fallback.worker_next_action,
      /pappra\/collab-workflow-await-request\/1/,
    );
    assert.ok(
      fallback.worker_next_action.includes(`${taskRoot}, writer-one#1`),
    );
    assert.match(fallback.worker_next_action, /`collab workflow release`/);
    assert.match(
      fallback.worker_next_action,
      /reports decision accept-writer-one-1, then/,
    );
    // The decision itself is recorded as usual and the rest of the result is untouched.
    assert.deepEqual(decisionsFor(taskRoot, reportOf(ONE)), [
      { id: 'accept-writer-one-1', state: 'applied', epoch: 1 },
    ]);
    assert.equal(decision.detail?.report_message_id, reportOf(ONE));
    assert.deepEqual(decision.detail?.pane_reclaim, []);
  } finally {
    fixture.cleanup();
  }
});

test('an accept whose notification is not submitted names the worker-side next action', async () => {
  const { fixture, accept } = await reportedFixture('fallback-unknown');
  try {
    const unknown = notifier({
      ok: true,
      value: {
        status: 'unknown',
        messageId: 'accept-writer-one-1',
        detail: 'The transport exited without a confirmed delivery.',
        consumed: false,
        taskAccepted: false,
      },
    });
    const decision = await applyAccept(accept(COORDINATOR), {
      notify: unknown.notify,
    });

    assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
    assert.equal(decision.messages[0]?.delivery, 'unknown');
    assert.deepEqual(decision.warnings, [
      'delivery_unknown: The transport exited without a confirmed delivery.',
    ]);
    assert.equal(
      decision.detail?.delivery_fallback?.reason,
      'delivery_unknown: The transport exited without a confirmed delivery.',
    );
    assert.match(
      decision.detail?.delivery_fallback?.worker_next_action ?? '',
      /`collab workflow await`.*`collab workflow release`/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('a qualified decision carries its own id in the worker-side next action', async (t) => {
  const { fixture, taskRoot, accept } =
    await reportedFixture('fallback-suffix');
  try {
    succeed(taskRoot, '2099-01-01T00:00:00Z');
    loseRaceOnBaseId(t, taskRoot, ONE.baseId, (attempted) =>
      register(
        taskRoot,
        competitor(attempted, { from: EARLIER, owner_epoch: 1 }),
      ),
    );
    const decision = await applyAccept(accept(NEXT), {
      notify: notifier(TRANSPORT_FAILURE).notify,
    });
    t.mock.restoreAll();

    assert.equal(decision.status, 'applied', JSON.stringify(decision.blockers));
    assert.equal(decision.messages[0]?.message_id, 'accept-writer-one-1-e2');
    assert.match(
      decision.detail?.delivery_fallback?.worker_next_action ?? '',
      /reports decision accept-writer-one-1-e2, then/,
    );
  } finally {
    t.mock.restoreAll();
    fixture.cleanup();
  }
});

test('no delivery fallback without a failed or unsubmitted notification', async () => {
  const { fixture, accept } = await reportedFixture('fallback-none');
  try {
    // A plan never notifies and never carries one.
    const failing = notifier(TRANSPORT_FAILURE);
    const planned = await applyAccept(accept(COORDINATOR), {
      notify: failing.notify,
      apply: false,
    });
    assert.equal(planned.status, 'planned', JSON.stringify(planned.blockers));
    assert.deepEqual(failing.calls, []);
    assert.ok(planned.detail !== null);
    assert.equal('delivery_fallback' in planned.detail, false);

    // A submitted delivery is the plain result it always was.
    const delivered = await applyAccept(accept(COORDINATOR), {
      notify: silentNotify,
    });
    assert.equal(
      delivered.status,
      'applied',
      JSON.stringify(delivered.blockers),
    );
    assert.equal(delivered.messages[0]?.delivery, 'submitted');
    assert.ok(delivered.detail !== null);
    assert.equal('delivery_fallback' in delivered.detail, false);
    assert.deepEqual(delivered.warnings, []);

    // A duplicate of a recorded decision is not delivered again and so has nothing to fall back from.
    const repeated = await applyAccept(accept(COORDINATOR), {
      notify: failing.notify,
    });
    assert.equal(repeated.messages[0]?.duplicate, true);
    assert.equal(repeated.messages[0]?.delivery, 'already-recorded');
    assert.deepEqual(failing.calls, []);
    assert.ok(repeated.detail !== null);
    assert.equal('delivery_fallback' in repeated.detail, false);
  } finally {
    fixture.cleanup();
  }
});

test('a batch reports the delivery fallback of exactly the entries whose notification failed', async () => {
  const { fixture, batch, reportOf } = await reportedFixture('fallback-batch', [
    ONE,
    TWO,
  ]);
  try {
    // Entry one is delivered, entry two is not.
    let calls = 0;
    const notify = (async (options: { messageId: string }) => {
      calls += 1;
      return calls === 1
        ? {
            ok: true as const,
            value: {
              status: 'submitted' as const,
              messageId: options.messageId,
              detail: null,
              consumed: false as const,
              taskAccepted: false as const,
            },
          }
        : TRANSPORT_FAILURE;
    }) as unknown as typeof notifyRegisteredMessage;
    const decided = await applyAcceptBatch(batch(COORDINATOR), { notify });

    assert.equal(decided.status, 'applied', JSON.stringify(decided.blockers));
    const items = decided.detail?.items ?? [];
    assert.deepEqual(
      items.map((item) => item.subtask_id),
      ['writer-one', 'writer-two'],
    );
    assert.equal('delivery_fallback' in items[0]!, false);
    const fallback = items[1]?.delivery_fallback;
    assert.ok(fallback !== undefined);
    assert.equal(
      fallback.reason,
      'transport_unavailable: Operation not permitted',
    );
    assert.match(
      fallback.worker_next_action,
      /reports decision accept-writer-two-1, then/,
    );
    assert.equal(items[1]?.report_message_id, reportOf(TWO));
    assert.ok(
      decided.warnings.every((item) => item.startsWith('writer-two#1:')),
      JSON.stringify(decided.warnings),
    );
  } finally {
    fixture.cleanup();
  }
});
