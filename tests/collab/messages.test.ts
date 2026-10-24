import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import {
  initTask,
  notificationsDir,
  readRecord,
} from '../../src/collab/store.js';
import type { Identity, Message, TaskRecord } from '../../src/collab/types.js';
import {
  listMessagesForTaskRoot,
  assertMessageTaskCurrent,
  openMessageTask,
  readDeliveryRecord,
  readMessageFromTaskRoot,
  sendMessageFromFile,
} from '../../src/app/collab-messages.js';
import {
  buildNotificationText,
  createHerdrTransport,
  notifyRegisteredMessage,
  reportedSessionIdentity,
  type CommandResult,
  type CommandRunner,
  type HerdrAgentObservation,
  type HerdrCallerResult,
  type HerdrCallerObservation,
  type HerdrPromptResult,
  type HerdrTransport,
} from '../../src/app/collab-notify.js';
import type { CollabBinding } from '../../src/schemas/collaboration.js';
import { cleanup, makeTempDir, snapshotTree } from '../workspace/fixtures.js';

const clock = Date.parse('2026-10-21T09:30:00Z');
const coordinator = {
  agent_id: 'pappra-coordinator',
  session_id: 'coordinator-session',
  harness: 'codex',
  owner_epoch: 1,
  since: '2026-10-21T09:00:00+08:00',
};
const worker = {
  agent_id: 'pappra-implement',
  session_id: 'worker-session',
  harness: 'pi',
} as const satisfies Identity;

interface Fixture {
  readonly root: string;
  readonly domain: string;
  readonly taskRoot: string;
}

function fixture(label: string): Fixture {
  const root = makeTempDir(label);
  const domain = join(root, 'domain');
  mkdirSync(domain, { recursive: true });
  const taskRoot = join(domain, 'tasks', 'smoke');
  initTask(taskRoot, {
    taskId: 'smoke',
    coordinator,
    domainRoot: domain,
    clock,
  });
  return { root, domain, taskRoot };
}

function envelopeFile(
  fixtureValue: Fixture,
  message: Message,
  label = message.message_id,
): string {
  const file = join(fixtureValue.root, `envelope-${label}.json`);
  writeFileSync(file, `${JSON.stringify(message, null, 2)}\n`);
  return file;
}

function makeMessage(
  type: string,
  overrides: {
    readonly message_id?: string;
    readonly from?: Identity;
    readonly to?: Identity;
    readonly body?: Record<string, unknown>;
    readonly subtask_id?: string | null;
    readonly attempt?: number | null;
    readonly reply_to?: string | null;
    readonly owner_epoch?: number | null;
  } = {},
): Message {
  return buildMessage(
    {
      type,
      message_id: overrides.message_id ?? `msg-${type.toLowerCase()}-1`,
      task_id: 'smoke',
      from: overrides.from ?? coordinator,
      to: overrides.to ?? worker,
      reply_to: overrides.reply_to ?? null,
      subtask_id: overrides.subtask_id ?? null,
      attempt: overrides.attempt ?? null,
      owner_epoch: overrides.owner_epoch ?? null,
      body: overrides.body ?? {},
    },
    { clock },
  );
}

async function persist(fixtureValue: Fixture, message: Message) {
  const result = await sendMessageFromFile(
    fixtureValue.taskRoot,
    envelopeFile(fixtureValue, message),
    { apply: true, clock },
  );
  assert.equal(result.ok, true);
  return result.value;
}

function recordOf(taskRoot: string): TaskRecord {
  const record = readRecord(taskRoot);
  assert(record);
  return record;
}

test('task namespace rejects a new record generation inside the same directories', async () => {
  const value = fixture('message-namespace-generation');
  try {
    const opened = await openMessageTask(value.taskRoot);
    assert(opened.ok);
    const record = recordOf(value.taskRoot);
    const replacement = join(value.taskRoot, 'task-replacement.json');
    writeFileSync(
      replacement,
      JSON.stringify({
        ...record,
        created_at: new Date(clock + 1000).toISOString(),
      }),
    );
    renameSync(replacement, join(value.taskRoot, 'task.json'));
    const failure = await assertMessageTaskCurrent(opened.value);
    assert.equal(failure?.code, 'task_namespace_changed');
  } finally {
    cleanup(value.root);
  }
});

test('task namespace permits atomic record commits but rejects directory replacement', async () => {
  const value = fixture('message-namespace-commit');
  try {
    const opened = await openMessageTask(value.taskRoot);
    assert(opened.ok);
    await persist(
      value,
      makeMessage('ASK', {
        from: worker,
        subtask_id: 'work',
        attempt: 1,
        body: { question: 'Which file?' },
      }),
    );
    assert.equal(await assertMessageTaskCurrent(opened.value), null);

    const directory = join(value.taskRoot, 'messages');
    renameSync(directory, `${directory}-old`);
    mkdirSync(directory);
    const failure = await assertMessageTaskCurrent(opened.value);
    assert.equal(failure?.code, 'task_namespace_changed');
  } finally {
    cleanup(value.root);
  }
});

interface ParticipantOverrides {
  readonly herdrAgent?: string;
  readonly paneId?: string;
  readonly harness?: string;
  readonly cwd?: string;
  readonly nativeSession?: string | null;
}

function bindingFor(
  fixtureValue: Fixture,
  options: {
    readonly herdrAgent?: string;
    readonly paneId?: string;
    readonly harness?: string;
    readonly cwd?: string;
    readonly nativeSession?: string | null;
    readonly taskId?: string;
    readonly taskRoot?: string;
    /** Sender binding overrides; `false` omits the sender participant. */
    readonly sender?: ParticipantOverrides | false;
  } = {},
): { file: string; binding: CollabBinding } {
  const senderBinding: ParticipantOverrides | false =
    options.sender === false ? false : (options.sender ?? {});
  const participants: CollabBinding['participants'] = [];
  if (senderBinding !== false) {
    participants.push({
      agent_id: coordinator.agent_id,
      harness: senderBinding.harness ?? coordinator.harness,
      cwd: senderBinding.cwd ?? '/tmp/task-root',
      herdr_agent: senderBinding.herdrAgent ?? 'pappra-coordinator',
      pane_id: senderBinding.paneId ?? 'w3:p1',
      native_session_id:
        senderBinding.nativeSession === undefined
          ? coordinator.session_id
          : senderBinding.nativeSession,
    });
  }
  participants.push({
    agent_id: worker.agent_id,
    harness: options.harness ?? worker.harness,
    cwd: options.cwd ?? fixtureValue.taskRoot,
    herdr_agent: options.herdrAgent ?? 'pappra-implement',
    pane_id: options.paneId ?? 'w3:p3',
    native_session_id:
      options.nativeSession === undefined
        ? worker.session_id
        : options.nativeSession,
  });
  const binding: CollabBinding = {
    schema: 'pappra/collab-binding/1',
    task_id: options.taskId ?? 'smoke',
    task_root: options.taskRoot ?? fixtureValue.taskRoot,
    channel: 'herdr',
    participants,
  };
  const file = join(fixtureValue.root, 'binding.json');
  writeFileSync(file, `${JSON.stringify(binding, null, 2)}\n`);
  return { file, binding };
}

function observation(
  overrides: Partial<HerdrAgentObservation> = {},
): HerdrAgentObservation {
  return {
    name: 'pappra-implement',
    harness: 'pi',
    paneId: 'w3:p3',
    cwd: '/tmp/task-root',
    sessionValue: `/sessions/2026-10-21_${worker.session_id}.jsonl`,
    sessionKind: 'path',
    status: 'idle',
    focused: false,
    ...overrides,
  };
}

function senderObservation(
  overrides: Partial<HerdrAgentObservation> = {},
): HerdrAgentObservation {
  return {
    name: 'pappra-coordinator',
    harness: 'codex',
    paneId: 'w3:p1',
    cwd: '/tmp/task-root',
    sessionValue: null,
    sessionKind: null,
    status: 'idle',
    focused: false,
    ...overrides,
  };
}

function callerObservation(
  overrides: Partial<HerdrCallerObservation> = {},
): HerdrCallerObservation {
  return {
    paneId: 'w3:p1',
    workspaceId: 'w3',
    tabId: 'w3:t1',
    harness: 'codex',
    cwd: '/tmp/task-root',
    sessionKind: null,
    sessionValue: null,
    source: 'current',
    ...overrides,
  };
}

class FakeTransport implements HerdrTransport {
  readonly id = 'fake-herdr';
  readonly prompts: { agent: string; text: string }[] = [];
  callerCalls = 0;
  callerOptions: ({ readonly paneId?: string } | undefined)[] = [];
  listCalls = 0;
  constructor(
    private readonly state: {
      readonly caller?: HerdrCallerResult;
      readonly explicitCallers?: Record<string, HerdrCallerResult>;
      readonly sender?: HerdrAgentObservation | null;
      readonly agents?: readonly HerdrAgentObservation[];
      readonly prompt?: HerdrPromptResult;
      readonly listFailure?: {
        status: 'unavailable' | 'failed';
        detail: string;
      };
    } = {},
  ) {}
  async verifyCaller(
    options: { readonly paneId?: string } = {},
  ): Promise<HerdrCallerResult> {
    this.callerCalls += 1;
    this.callerOptions.push(options);
    if (options.paneId !== undefined) {
      return (
        this.state.explicitCallers?.[options.paneId] ?? {
          ok: false,
          status: 'unverified',
          code: 'caller_pane_unavailable',
          detail: `test: no explicit caller for ${options.paneId}`,
        }
      );
    }
    return (
      this.state.caller ?? {
        ok: true,
        caller: callerObservation(),
      }
    );
  }
  async list() {
    this.listCalls += 1;
    if (this.state.listFailure !== undefined) {
      return { ok: false as const, ...this.state.listFailure };
    }
    const sender =
      this.state.sender === null
        ? []
        : [this.state.sender ?? senderObservation()];
    return {
      ok: true as const,
      agents: [...sender, ...(this.state.agents ?? [observation()])],
    };
  }
  async prompt(agent: string, text: string) {
    this.prompts.push({ agent, text });
    return this.state.prompt ?? { status: 'submitted' as const, detail: null };
  }
}

test('send plans without writing and apply persists exactly once', async () => {
  const value = fixture('c0-send');
  try {
    const message = makeMessage('STATUS_QUERY', {
      body: { status: 'running' },
      from: coordinator,
    });
    const file = envelopeFile(value, message);
    const before = snapshotTree(value.taskRoot);
    const planned = await sendMessageFromFile(value.taskRoot, file, {
      apply: false,
      clock,
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.equal(planned.value.status, 'planned');
    assert.equal(planned.value.messagePath, null);
    assert.deepEqual(snapshotTree(value.taskRoot), before);
    assert.equal(recordOf(value.taskRoot).messages.length, 0);

    const applied = await sendMessageFromFile(value.taskRoot, file, {
      apply: true,
      clock,
    });
    assert.equal(applied.ok, true);
    if (!applied.ok) return;
    assert.equal(applied.value.status, 'accepted');
    assert.equal(applied.value.delivery, 'persisted-not-notified');
    assert.equal(applied.value.notified, false);
    assert.equal(applied.value.taskAccepted, false);
    assert.equal(typeof applied.value.digest, 'string');
    assert.equal(recordOf(value.taskRoot).messages.length, 1);

    const duplicate = await sendMessageFromFile(value.taskRoot, file, {
      apply: true,
      clock,
    });
    assert.equal(duplicate.ok, true);
    if (!duplicate.ok) return;
    assert.equal(duplicate.value.status, 'duplicate');
    assert.equal(recordOf(value.taskRoot).messages.length, 1);
  } finally {
    cleanup(value.root);
  }
});

test('read and list are bounded and write nothing', async () => {
  const value = fixture('c0-read');
  try {
    const first = makeMessage('STATUS_QUERY', { message_id: 'msg-q1' });
    const second = makeMessage('STATUS', {
      message_id: 'msg-q2',
      reply_to: 'msg-q1',
      body: { status: 'running' },
      from: worker,
    });
    await persist(value, first);
    await persist(value, second);
    const before = snapshotTree(value.taskRoot);

    const read = await readMessageFromTaskRoot(value.taskRoot, 'msg-q2');
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.value.message.type, 'STATUS');
    assert.equal(read.value.entry?.state, 'recorded');
    assert.equal(read.value.delivery, null);
    assert.equal(read.value.writes, false);

    const list = await listMessagesForTaskRoot(value.taskRoot, { limit: 1 });
    assert.equal(list.ok, true);
    if (!list.ok) return;
    assert.equal(list.value.total, 2);
    assert.equal(list.value.returned, 1);
    assert.equal(list.value.truncated, true);
    assert.equal(list.value.messages[0]?.message_id, 'msg-q2');
    assert.deepEqual(snapshotTree(value.taskRoot), before);

    const missing = await readMessageFromTaskRoot(value.taskRoot, 'msg-absent');
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.equal(missing.code, 'message_not_registered');
  } finally {
    cleanup(value.root);
  }
});

test('unsafe ids, malformed records, task mismatch and redirected state fail closed', async () => {
  const value = fixture('c0-unsafe');
  try {
    const unsafe = makeMessage('STATUS_QUERY', {
      message_id: '../escape',
      body: { status: 'running' },
    });
    const unsafeSend = await sendMessageFromFile(
      value.taskRoot,
      envelopeFile(value, unsafe, 'unsafe'),
      { apply: true, clock },
    );
    assert.equal(unsafeSend.ok, false);
    if (!unsafeSend.ok) assert.equal(unsafeSend.code, 'message_id_invalid');

    const unsafeRead = await readMessageFromTaskRoot(
      value.taskRoot,
      '../escape',
    );
    assert.equal(unsafeRead.ok, false);
    if (!unsafeRead.ok) assert.equal(unsafeRead.code, 'message_id_invalid');

    const mismatch = makeMessage('STATUS_QUERY', {
      message_id: 'msg-other-task',
      body: { status: 'running' },
    });
    const mismatched = await sendMessageFromFile(
      value.taskRoot,
      envelopeFile(value, { ...mismatch, task_id: 'other-task' }, 'mismatch'),
      { apply: true, clock },
    );
    assert.equal(mismatched.ok, false);
    if (!mismatched.ok) assert.equal(mismatched.code, 'message_task_mismatch');

    const alias = join(value.root, 'task-alias');
    symlinkSync(value.taskRoot, alias, 'dir');
    const redirected = await openMessageTask(alias);
    assert.equal(redirected.ok, false);
    if (!redirected.ok) assert.equal(redirected.code, 'task_root_redirected');

    renameSync(
      join(value.taskRoot, 'messages'),
      join(value.taskRoot, 'messages-real'),
    );
    symlinkSync(
      join(value.root, 'outside-messages'),
      join(value.taskRoot, 'messages'),
      'dir',
    );
    mkdirSync(join(value.root, 'outside-messages'), { recursive: true });
    const unsafeMessages = await openMessageTask(value.taskRoot);
    assert.equal(unsafeMessages.ok, false);
    if (!unsafeMessages.ok)
      assert.equal(unsafeMessages.code, 'task_messages_unsafe');
  } finally {
    cleanup(value.root);
  }
});

test('ASK is recorded without a task-state transition', async () => {
  const value = fixture('c0-ask');
  try {
    const ask = makeMessage('ASK', {
      message_id: 'msg-ask-1',
      from: worker,
      subtask_id: 'work',
      attempt: 1,
      body: { question: 'Which file?' },
    });
    const sent = await persist(value, ask);
    assert.equal(sent.status, 'accepted');
    const record = recordOf(value.taskRoot);
    assert.equal(record.messages.length, 1);
    assert.equal(record.messages[0]?.state, 'recorded');
    assert.equal(
      record.messages[0]?.detail,
      'question recorded; no task state change',
    );
    assert.equal(record.attempts.length, 0);
  } finally {
    cleanup(value.root);
  }
});

test('clarification, approval and stale-report boundaries survive the message path', async () => {
  const value = fixture('c0-flow');
  try {
    const assign = makeMessage('ASSIGN', {
      message_id: 'msg-assign-1',
      subtask_id: 'work',
      attempt: 1,
      owner_epoch: 1,
      body: {
        assignment_ref: '/tmp/assignment.json',
        assignment_digest: `sha256:${'a'.repeat(64)}`,
        input_revision: `sha256:${'b'.repeat(64)}`,
      },
    });
    assert.equal((await persist(value, assign)).status, 'accepted');

    const ack = makeMessage('ACK', {
      message_id: 'msg-ack-1',
      from: worker,
      reply_to: assign.message_id,
    });
    assert.equal((await persist(value, ack)).status, 'accepted');
    assert.equal(recordOf(value.taskRoot).attempts[0]?.state, 'accepted');

    const approval = makeMessage('BLOCK', {
      message_id: 'msg-approval-1',
      from: worker,
      to: coordinator,
      subtask_id: 'work',
      attempt: 1,
      body: { kind: 'approval' },
    });
    assert.equal((await persist(value, approval)).status, 'accepted');
    const blocked = recordOf(value.taskRoot).attempts[0];
    assert.equal(blocked?.state, 'needs_input');
    assert.equal(blocked?.awaiting, 'approval');

    const answerApproval = makeMessage('ANSWER', {
      message_id: 'msg-answer-approval',
      reply_to: approval.message_id,
      subtask_id: 'work',
      attempt: 1,
      body: { decision: 'approved' },
    });
    const refused = await persist(value, answerApproval);
    assert.equal(refused.status, 'rejected');
    assert.match(String(refused.detail), /approval_not_auto_answerable/);
    assert.equal(recordOf(value.taskRoot).attempts[0]?.state, 'needs_input');

    const clarification = makeMessage('BLOCK', {
      message_id: 'msg-clarification-1',
      from: worker,
      to: coordinator,
      subtask_id: 'work',
      attempt: 1,
      body: { kind: 'clarification' },
    });
    assert.equal((await persist(value, clarification)).status, 'accepted');

    const answer = makeMessage('ANSWER', {
      message_id: 'msg-answer-1',
      reply_to: clarification.message_id,
      subtask_id: 'work',
      attempt: 1,
      body: { answer: 'src/window.mjs' },
    });
    assert.equal((await persist(value, answer)).status, 'accepted');
    assert.equal(recordOf(value.taskRoot).attempts[0]?.state, 'running');

    const staleReport = makeMessage('REPORT', {
      message_id: 'msg-report-stale',
      from: { ...worker, session_id: 'other-session' },
      subtask_id: 'work',
      attempt: 1,
      body: { status: 'completed' },
    });
    const stale = await persist(value, staleReport);
    assert.equal(stale.status, 'accepted');
    const entry = recordOf(value.taskRoot).messages.find(
      (item) => item.message_id === 'msg-report-stale',
    );
    assert.equal(entry?.detail, 'report classified stale_sender');
  } finally {
    cleanup(value.root);
  }
});

test('notify validates the binding and sends one pointer-only prompt', async () => {
  const value = fixture('c0-notify');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-notify-1',
      from: coordinator,
    });
    const sent = await persist(value, message);
    assert(sent.messagePath);
    const binding = bindingFor(value, { cwd: value.taskRoot });
    const transport = new FakeTransport({
      agents: [observation({ cwd: value.taskRoot })],
    });

    const planned = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: false,
      retry: false,
      transport,
      clock,
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.equal(planned.value.status, 'planned');
    assert.equal(planned.value.transport, 'none');
    assert.equal(transport.prompts.length, 0);

    const notified = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(notified.ok, true);
    if (!notified.ok) return;
    assert.equal(notified.value.status, 'submitted');
    assert.equal(notified.value.consumed, false);
    assert.equal(notified.value.taskAccepted, false);
    assert.equal(notified.value.target?.native_session, 'match');
    assert.equal(transport.prompts.length, 1);
    assert.equal(transport.prompts[0]?.agent, 'pappra-implement');
    assert.equal(
      transport.prompts[0]?.text,
      buildNotificationText({
        taskId: 'smoke',
        type: message.type,
        messagePath: sent.messagePath,
        digest: sent.digest ?? '',
      }),
    );
    assert.doesNotMatch(transport.prompts[0]?.text ?? '', /\n/);
    assert.equal(
      readDeliveryRecord(value.taskRoot, message.message_id)?.status,
      'submitted',
    );

    const repeated = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(repeated.ok, true);
    if (!repeated.ok) return;
    assert.equal(repeated.value.status, 'already_recorded');
    assert.equal(repeated.value.priorStatus, 'submitted');
    assert.equal(transport.prompts.length, 1);

    const retried = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: true,
      transport,
      clock,
    });
    assert.equal(retried.ok, true);
    if (!retried.ok) return;
    assert.equal(retried.value.status, 'submitted');
    assert.equal(retried.value.attempts, 2);
    assert.equal(transport.prompts.length, 2);
  } finally {
    cleanup(value.root);
  }
});

test('notify rejects mismatched identity and never claims success on blocked or unavailable transport', async () => {
  const value = fixture('c0-mismatch');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-mismatch-1',
      from: coordinator,
    });
    await persist(value, message);

    const cases: {
      readonly label: string;
      readonly binding?: Parameters<typeof bindingFor>[1];
      readonly agents?: readonly HerdrAgentObservation[];
      readonly prompt?: HerdrPromptResult;
      readonly code?: string;
      readonly status?: string;
    }[] = [
      {
        label: 'binding task',
        binding: { taskId: 'other-task' },
        code: 'binding_task_mismatch',
      },
      {
        label: 'name',
        agents: [observation({ name: 'someone-else', cwd: value.taskRoot })],
        code: 'target_not_found',
      },
      {
        label: 'pane',
        agents: [observation({ paneId: 'w3:p9', cwd: value.taskRoot })],
        code: 'target_pane_mismatch',
      },
      {
        label: 'harness',
        agents: [observation({ harness: 'codex', cwd: value.taskRoot })],
        code: 'target_harness_mismatch',
      },
      {
        label: 'cwd',
        agents: [observation({ cwd: '/tmp/elsewhere' })],
        code: 'target_cwd_mismatch',
      },
      {
        label: 'session',
        agents: [
          observation({
            cwd: value.taskRoot,
            sessionValue: '/sessions/other-session.jsonl',
          }),
        ],
        code: 'target_session_mismatch',
      },
      {
        label: 'binding session',
        binding: { nativeSession: 'different-session' },
        code: 'binding_session_mismatch',
      },
      {
        label: 'blocked',
        prompt: { status: 'blocked', detail: 'agent_blocked' },
        status: 'blocked',
      },
    ];
    for (const entry of cases) {
      const binding = bindingFor(value, entry.binding ?? {});
      const transport = new FakeTransport({
        agents: entry.agents ?? [observation({ cwd: value.taskRoot })],
        ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }),
      });
      // Each case uses a distinct message id so delivery state does not leak between cases.
      const caseMessage = makeMessage('STATUS_QUERY', {
        message_id: `msg-${entry.label.replaceAll(' ', '-')}-1`,
        from: coordinator,
      });
      await persist(value, caseMessage);
      const result = await notifyRegisteredMessage({
        taskRoot: value.taskRoot,
        messageId: caseMessage.message_id,
        bindingFile: binding.file,
        apply: true,
        retry: false,
        transport,
        clock,
      });
      if (entry.code !== undefined) {
        assert.equal(result.ok, false, entry.label);
        if (!result.ok) assert.equal(result.code, entry.code, entry.label);
        assert.equal(transport.prompts.length, 0, entry.label);
      } else {
        assert.equal(result.ok, true, entry.label);
        if (!result.ok) continue;
        assert.equal(result.value.status, entry.status, entry.label);
        assert.equal(result.value.consumed, false, entry.label);
        assert.equal(
          readDeliveryRecord(value.taskRoot, caseMessage.message_id)?.status,
          entry.status,
          entry.label,
        );
      }
    }

    const unavailableMessage = makeMessage('STATUS_QUERY', {
      message_id: 'msg-unavailable-1',
      from: coordinator,
    });
    await persist(value, unavailableMessage);
    const unavailableBinding = bindingFor(value);
    const unavailableTransport = new FakeTransport({
      caller: {
        ok: false,
        status: 'unavailable',
        code: 'not_in_herdr',
        detail: 'test: outside Herdr',
      },
    });
    const unavailable = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: unavailableMessage.message_id,
      bindingFile: unavailableBinding.file,
      apply: true,
      retry: false,
      transport: unavailableTransport,
      clock,
    });
    assert.equal(unavailable.ok, true);
    if (!unavailable.ok) return;
    assert.equal(unavailable.value.status, 'herdr_unavailable');
    assert.equal(unavailable.value.target, null);
    assert.equal(unavailableTransport.prompts.length, 0);
    assert.equal(
      readDeliveryRecord(value.taskRoot, unavailableMessage.message_id),
      null,
    );
  } finally {
    cleanup(value.root);
  }
});

test('notify records an unknown outcome when the transport fails after reservation', async () => {
  const value = fixture('c0-unknown');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-unknown-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value);
    const transport: HerdrTransport = {
      id: 'throwing',
      verifyCaller: async () => ({
        ok: true,
        caller: {
          paneId: 'w3:p1',
          workspaceId: 'w3',
          tabId: 'w3:t1',
          harness: 'codex',
          cwd: '/tmp/task-root',
          sessionKind: null,
          sessionValue: null,
          source: 'current',
        },
      }),
      list: async () => ({
        ok: true,
        agents: [senderObservation(), observation({ cwd: value.taskRoot })],
      }),
      prompt: async () => {
        throw new Error('socket closed after write');
      },
    };
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, 'unknown');
    assert.match(String(result.value.detail), /socket closed/);
    assert.equal(result.value.consumed, false);
    assert.equal(
      readDeliveryRecord(value.taskRoot, message.message_id)?.status,
      'unknown',
    );
  } finally {
    cleanup(value.root);
  }
});

test('retry is explicit and bounded', async () => {
  const value = fixture('c0-retry');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-retry-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value);
    const transport = new FakeTransport({
      agents: [observation({ cwd: value.taskRoot })],
      prompt: { status: 'failed', detail: 'transport_failed' },
    });
    const notify = (retry: boolean) =>
      notifyRegisteredMessage({
        taskRoot: value.taskRoot,
        messageId: message.message_id,
        bindingFile: binding.file,
        apply: true,
        retry,
        transport,
        clock,
      });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await notify(attempt > 1);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.value.attempts, attempt);
    }
    const limited = await notify(true);
    assert.equal(limited.ok, false);
    if (!limited.ok) assert.equal(limited.code, 'retry_limit');
    assert.equal(transport.prompts.length, 3);
  } finally {
    cleanup(value.root);
  }
});

test('default Herdr transport resolves the caller, keeps argv boundaries and never waits', async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const ok = (payload: unknown): CommandResult => ({
    spawned: true,
    code: 0,
    signal: null,
    stdout: `${JSON.stringify(payload)}\n`,
    stderr: '',
    timedOut: false,
    spawnError: null,
  });
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'pane' && args[1] === 'current') {
      return ok({
        id: 'cli:pane:current',
        result: {
          type: 'pane_current',
          pane: {
            pane_id: 'w3:p3',
            workspace_id: 'w3',
            tab_id: 'w3:t1',
            agent: 'pi',
            cwd: '/tmp/task-root',
            agent_session: {
              kind: 'path',
              value: '/sessions/2026-10-21_worker-session.jsonl',
            },
          },
        },
      });
    }
    if (args[1] === 'list') {
      return ok({
        id: 'cli:agent:list',
        result: {
          type: 'agent_list',
          agents: [
            {
              agent: 'pi',
              agent_status: 'idle',
              cwd: '/tmp/task-root',
              focused: false,
              name: 'pappra-implement',
              pane_id: 'w3:p3',
              agent_session: {
                kind: 'path',
                value: '/sessions/2026-10-21_worker-session.jsonl',
              },
            },
          ],
        },
      });
    }
    return ok({ id: 'cli:agent:prompt', result: { type: 'agent_prompted' } });
  };
  const transport = createHerdrTransport({
    env: { HERDR_ENV: '1', HERDR_BIN_PATH: 'herdr', HERDR_PANE_ID: 'w3:p3' },
    run,
  });
  const caller = await transport.verifyCaller();
  assert.equal(caller.ok, true);
  if (caller.ok) assert.equal(caller.caller.paneId, 'w3:p3');
  const agents = await transport.list();
  assert.equal(agents.ok, true);
  const outcome = await transport.prompt(
    'pappra-implement',
    'COLLAB_MESSAGE task=smoke',
  );
  assert.equal(outcome.status, 'submitted');
  assert.deepEqual(calls[0], {
    command: 'herdr',
    args: ['pane', 'current', '--current'],
  });
  assert.deepEqual(calls[1], { command: 'herdr', args: ['agent', 'list'] });
  assert.deepEqual(calls[2], {
    command: 'herdr',
    args: ['agent', 'prompt', 'pappra-implement', 'COLLAB_MESSAGE task=smoke'],
  });
  const allArgs = calls.flatMap((call) => call.args);
  assert.equal(allArgs.includes('--wait'), false);
  assert.equal(allArgs.includes('focus'), false);
  const paneCommands = calls.filter((call) => call.args[0] === 'pane');
  assert.deepEqual(paneCommands, [
    { command: 'herdr', args: ['pane', 'current', '--current'] },
  ]);
});

test('notification is unavailable outside a verified Herdr caller', async () => {
  const value = fixture('c0-direct');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-direct-1',
      from: coordinator,
    });
    const sent = await persist(value, message);
    const binding = bindingFor(value);
    const transport = createHerdrTransport({ env: { HERDR_ENV: '0' } });
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, 'herdr_unavailable');
    assert.equal(result.value.messagePath, sent.messagePath);
    assert.equal(result.value.deliveryPath, null);
    assert.equal(result.value.consumed, false);
    assert.equal(readDeliveryRecord(value.taskRoot, message.message_id), null);
    const listed = await listMessagesForTaskRoot(value.taskRoot, { limit: 5 });
    assert.equal(listed.ok, true);
    if (listed.ok) assert.equal(listed.value.messages[0]?.delivery, null);
  } finally {
    cleanup(value.root);
  }
});

test('a reservation left by a crashed notifier is not resent implicitly', async () => {
  const value = fixture('c0-inflight');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-inflight-1',
      from: coordinator,
    });
    const sent = await persist(value, message);
    const binding = bindingFor(value);
    mkdirSync(notificationsDir(value.taskRoot), { recursive: true });
    const deliveryFile = join(
      notificationsDir(value.taskRoot),
      `${message.message_id}.json`,
    );
    writeFileSync(
      deliveryFile,
      `${JSON.stringify(
        {
          schema: 'pappra/collab-delivery/1',
          message_id: message.message_id,
          message_path: sent.messagePath,
          message_digest: sent.digest,
          task_id: 'smoke',
          task_root: value.taskRoot,
          recipient: { agent_id: worker.agent_id, harness: worker.harness },
          target: {
            herdr_agent: 'pappra-implement',
            pane_id: 'w3:p3',
            native_session: 'match',
          },
          status: 'submitting',
          attempts: [],
          created_at: '2026-10-21T09:30:00.000Z',
          updated_at: '2026-10-21T09:30:00.000Z',
        },
        null,
        2,
      )}\n`,
    );
    const transport = new FakeTransport({
      agents: [observation({ cwd: value.taskRoot })],
    });
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, 'in_flight_unknown');
    assert.equal(result.value.priorStatus, 'submitting');
    assert.equal(transport.prompts.length, 0);
    assert.equal(
      readFileSync(deliveryFile, 'utf8').includes('submitting'),
      true,
    );
  } finally {
    cleanup(value.root);
  }
});

test('corrupt delivery evidence is never overwritten or resent', async () => {
  const value = fixture('c0-corrupt-delivery');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-corrupt-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value);
    mkdirSync(notificationsDir(value.taskRoot), { recursive: true });
    writeFileSync(
      join(notificationsDir(value.taskRoot), `${message.message_id}.json`),
      '{not-json\n',
    );
    const transport = new FakeTransport({
      agents: [observation({ cwd: value.taskRoot })],
    });
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'delivery_state_invalid');
    assert.equal(transport.prompts.length, 0);
  } finally {
    cleanup(value.root);
  }
});

test('R1: a symlinked tasks parent into another domain is refused', async () => {
  const value = fixture('r1-alias-domain');
  try {
    const aliasDomain = join(value.root, 'alias-domain');
    mkdirSync(aliasDomain);
    symlinkSync(join(value.domain, 'tasks'), join(aliasDomain, 'tasks'), 'dir');
    const alias = await openMessageTask(join(aliasDomain, 'tasks', 'smoke'));
    assert.equal(alias.ok, false);
    if (!alias.ok) assert.equal(alias.code, 'task_root_redirected');
  } finally {
    cleanup(value.root);
  }
});

test('R1: a registered message symlink outside the task is never protocol content', async () => {
  const value = fixture('r1-message-symlink');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-symlink-1',
      from: coordinator,
    });
    await persist(value, message);
    const registered = join(value.taskRoot, 'messages', 'msg-symlink-1.json');
    const outside = join(value.root, 'outside-message.json');
    writeFileSync(outside, readFileSync(registered));
    unlinkSync(registered);
    symlinkSync(outside, registered);

    const read = await readMessageFromTaskRoot(value.taskRoot, 'msg-symlink-1');
    assert.equal(read.ok, false);
    if (!read.ok) assert.equal(read.code, 'message_registration_invalid');

    const binding = bindingFor(value);
    const transport = new FakeTransport({
      agents: [observation({ cwd: value.taskRoot })],
    });
    const notify = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-symlink-1',
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(notify.ok, false);
    if (!notify.ok) assert.equal(notify.code, 'message_registration_invalid');
    assert.equal(transport.prompts.length, 0);
  } finally {
    cleanup(value.root);
  }
});

test('R1: a task redirect during awaited transport observation creates nothing outside', async () => {
  const value = fixture('r1-mid-notify');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-mid-notify-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value);
    const outside = join(value.root, 'outside-state');
    mkdirSync(outside);
    const transport: HerdrTransport = {
      id: 'redirecting',
      verifyCaller: async () =>
        ({
          ok: true,
          caller: {
            paneId: 'w3:p1',
            workspaceId: 'w3',
            tabId: 'w3:t1',
            harness: 'codex',
            cwd: '/tmp/task-root',
            sessionKind: null,
            sessionValue: null,
            source: 'current',
          },
        }) satisfies HerdrCallerResult,
      list: async () => {
        renameSync(value.taskRoot, `${value.taskRoot}.old`);
        symlinkSync(outside, value.taskRoot, 'dir');
        return {
          ok: true,
          agents: [observation({ cwd: value.taskRoot })],
        };
      },
      prompt: async () => ({ status: 'submitted', detail: null }),
    };
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(outside, 'notifications')), false);
  } finally {
    cleanup(value.root);
  }
});

test('R2: native session identity is compared exactly, not by ancestor substring', async () => {
  const value = fixture('r2-session-substring');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-session-substring-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value);
    const transport = new FakeTransport({
      agents: [
        observation({
          cwd: value.taskRoot,
          sessionKind: 'path',
          sessionValue: '/sessions/worker-session/archive/other-session.jsonl',
        }),
      ],
    });
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'target_session_mismatch');
    assert.equal(transport.prompts.length, 0);
    assert.deepEqual(
      reportedSessionIdentity(
        'path',
        '/sessions/2026-10-21_worker-session.jsonl',
      ),
      { status: 'match', identity: 'worker-session' },
    );
    assert.deepEqual(
      reportedSessionIdentity(
        'path',
        '/sessions/worker-session/archive/other-session.jsonl',
      ),
      { status: 'match', identity: 'other-session' },
    );
  } finally {
    cleanup(value.root);
  }
});

test('R2: an explicit recipient session is checked even when the binding has none', async () => {
  const value = fixture('r2-null-binding-session');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-null-session-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value, { nativeSession: null });
    const mismatch = new FakeTransport({
      agents: [
        observation({
          cwd: value.taskRoot,
          sessionKind: 'path',
          sessionValue: '/sessions/2026-10-21_other-session.jsonl',
        }),
      ],
    });
    const refused = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport: mismatch,
      clock,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, 'target_session_mismatch');
    assert.equal(mismatch.prompts.length, 0);

    const unknown = new FakeTransport({
      agents: [
        observation({
          cwd: value.taskRoot,
          sessionKind: null,
          sessionValue: null,
        }),
      ],
    });
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport: unknown,
      clock,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, 'submitted');
    assert.equal(result.value.target?.native_session, 'unknown');
    assert.equal(result.value.target?.native_session_kind, null);
  } finally {
    cleanup(value.root);
  }
});

test('R3: concurrent retries serialize, count every attempt and hold the limit', async () => {
  const value = fixture('r3-retry-race');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-retry-race-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value);
    const initial = new FakeTransport({
      agents: [observation({ cwd: value.taskRoot })],
    });
    const first = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport: initial,
      clock,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.status, 'submitted');

    const concurrent = new FakeTransport({
      agents: [observation({ cwd: value.taskRoot })],
    });
    const retry = () =>
      notifyRegisteredMessage({
        taskRoot: value.taskRoot,
        messageId: message.message_id,
        bindingFile: binding.file,
        apply: true,
        retry: true,
        transport: concurrent,
        clock,
      });
    const raced = await Promise.all([retry(), retry()]);
    const statuses = raced
      .map((entry) => (entry.ok ? entry.value.status : entry.code))
      .sort();
    assert.deepEqual(statuses, ['in_flight_unknown', 'submitted']);
    assert.equal(concurrent.prompts.length, 1);
    const afterRace = readDeliveryRecord(value.taskRoot, message.message_id);
    assert.equal(afterRace?.attempts.length, 2);
    assert.equal(
      afterRace?.attempts.filter((attempt) => attempt.status === 'submitting')
        .length,
      0,
    );

    const third = await retry();
    assert.equal(third.ok, true);
    if (!third.ok) return;
    assert.equal(third.value.status, 'submitted');
    assert.equal(third.value.attempts, 3);
    assert.equal(concurrent.prompts.length, 2);
    const fourth = await retry();
    assert.equal(fourth.ok, false);
    if (!fourth.ok) assert.equal(fourth.code, 'retry_limit');
    assert.equal(concurrent.prompts.length, 2);
  } finally {
    cleanup(value.root);
  }
});

test('R4: the caller must resolve before any agent is inspected', async () => {
  const value = fixture('r4-caller');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-caller-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value);
    const calls: string[][] = [];
    const run: CommandRunner = async (_command, args) => {
      calls.push(args as string[]);
      return {
        spawned: true,
        code: 1,
        signal: null,
        stdout: '',
        stderr: 'pane resolution failed',
        timedOut: false,
        spawnError: null,
      };
    };
    const transport = createHerdrTransport({
      env: {
        HERDR_ENV: '1',
        HERDR_BIN_PATH: 'herdr',
        HERDR_PANE_ID: 'w3:p3',
      },
      run,
    });
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, 'herdr_caller_unverified');
    assert.match(String(result.value.detail), /caller_unresolved/);
    assert.deepEqual(calls, [['pane', 'current', '--current']]);
    assert.equal(readDeliveryRecord(value.taskRoot, message.message_id), null);
  } finally {
    cleanup(value.root);
  }
});

test('R4: a stale caller pane in the environment is unverified, not accepted', async () => {
  const calls: string[][] = [];
  const run: CommandRunner = async (_command, args) => {
    calls.push(args as string[]);
    return {
      spawned: true,
      code: 0,
      signal: null,
      stdout: `${JSON.stringify({
        result: { pane: { pane_id: 'w3:p3', workspace_id: 'w3' } },
      })}\n`,
      stderr: '',
      timedOut: false,
      spawnError: null,
    };
  };
  const transport = createHerdrTransport({
    env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w3:p9' },
    run,
  });
  const result = await transport.verifyCaller();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 'unverified');
    assert.equal(result.code, 'caller_env_mismatch');
  }
  assert.deepEqual(calls, [['pane', 'current', '--current']]);
});

test('R5: ambiguous post-spawn outcomes are unknown and recognized refusals stay definite', async () => {
  const adapter = (result: CommandResult) =>
    createHerdrTransport({ env: { HERDR_ENV: '1' }, run: async () => result });
  const base = {
    spawned: true,
    code: 1,
    signal: null,
    stdout: '',
    stderr: 'connection lost after writing',
    timedOut: false,
    spawnError: null,
  } satisfies CommandResult;
  assert.equal((await adapter(base).prompt('worker', 'x')).status, 'unknown');
  assert.equal(
    (
      await adapter({
        ...base,
        code: 0,
        stdout: 'not-json',
        stderr: '',
      }).prompt('worker', 'x')
    ).status,
    'unknown',
  );
  assert.equal(
    (
      await adapter({ ...base, code: null, timedOut: true }).prompt(
        'worker',
        'x',
      )
    ).status,
    'unknown',
  );
  assert.equal(
    (
      await adapter({ ...base, code: null, signal: 'SIGKILL' }).prompt(
        'worker',
        'x',
      )
    ).status,
    'unknown',
  );
  assert.equal(
    (
      await adapter({
        ...base,
        stdout: `${JSON.stringify({ error: { code: 'agent_blocked' } })}\n`,
      }).prompt('worker', 'x')
    ).status,
    'blocked',
  );
  assert.equal(
    (
      await adapter({
        ...base,
        stdout: `${JSON.stringify({ error: { code: 'agent_not_found' } })}\n`,
      }).prompt('worker', 'x')
    ).status,
    'refused',
  );
  assert.equal(
    (
      await adapter({
        ...base,
        spawned: false,
        code: null,
        spawnError: 'ENOENT',
      }).prompt('worker', 'x')
    ).status,
    'unavailable',
  );
});

test('R2R1: a symlinked task domain is refused without writes', async () => {
  const value = fixture('r2-alias-domain');
  try {
    const alias = join(value.root, 'alias-domain');
    symlinkSync(value.domain, alias, 'dir');
    const opened = await openMessageTask(join(alias, 'tasks', 'smoke'));
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.code, 'task_root_redirected');

    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-domain-alias-1',
      from: coordinator,
    });
    const sent = await sendMessageFromFile(
      join(alias, 'tasks', 'smoke'),
      envelopeFile(value, message),
      { apply: true, clock },
    );
    assert.equal(sent.ok, false);
    assert.equal(
      existsSync(join(value.taskRoot, 'messages', 'msg-domain-alias-1.json')),
      false,
    );
  } finally {
    cleanup(value.root);
  }
});

test('R2R1: a system alias above the domain still resolves', async () => {
  const root = realpathSync(makeTempDir('r2-system-alias'));
  try {
    const realParent = join(root, 'real-parent');
    const domain = join(realParent, 'domain');
    mkdirSync(domain, { recursive: true });
    const taskRoot = join(domain, 'tasks', 'smoke');
    initTask(taskRoot, {
      taskId: 'smoke',
      domainRoot: domain,
      coordinator,
      clock,
    });
    const aliasParent = join(root, 'alias-parent');
    symlinkSync(realParent, aliasParent, 'dir');
    const aliasTaskRoot = join(aliasParent, 'domain', 'tasks', 'smoke');

    const opened = await openMessageTask(aliasTaskRoot);
    assert.equal(opened.ok, true);
    if (opened.ok) assert.equal(opened.value.taskRoot, taskRoot);

    const message = buildMessage(
      {
        type: 'STATUS_QUERY',
        message_id: 'msg-system-alias-1',
        task_id: 'smoke',
        from: coordinator,
        to: worker,
      },
      { clock },
    );
    const envelope = join(root, 'alias-envelope.json');
    writeFileSync(envelope, `${JSON.stringify(message, null, 2)}\n`);
    const sent = await sendMessageFromFile(aliasTaskRoot, envelope, {
      apply: true,
      clock,
    });
    assert.equal(sent.ok, true);
    if (sent.ok) assert.equal(sent.value.status, 'accepted');
    assert.equal(
      existsSync(join(taskRoot, 'messages', 'msg-system-alias-1.json')),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test('R2R5: unrecognized JSON error codes stay unknown; only recognized refusals are definite', async () => {
  const base = {
    spawned: true,
    code: 1,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    spawnError: null,
  } satisfies CommandResult;
  const adapter = (code: string) =>
    createHerdrTransport({
      env: { HERDR_ENV: '1' },
      run: async () => ({
        ...base,
        stdout: `${JSON.stringify({
          error: { code, message: 'submission outcome unavailable' },
        })}\n`,
      }),
    });
  for (const code of [
    'connection_lost_after_write',
    'unrecognized_future_error',
  ]) {
    const result = await adapter(code).prompt('worker', 'pointer');
    assert.equal(result.status, 'unknown', code);
    assert.match(String(result.detail), new RegExp(code));
  }
  const recognized = await adapter('agent_not_found').prompt(
    'worker',
    'pointer',
  );
  assert.equal(recognized.status, 'refused');
  const blocked = await adapter('agent_blocked').prompt('worker', 'pointer');
  assert.equal(blocked.status, 'blocked');
  const timeout = await adapter('timeout').prompt('worker', 'pointer');
  assert.equal(timeout.status, 'unknown');
});

test('C1: missing inherited pane context refuses before any live resolution', async () => {
  const value = fixture('c1-context-missing');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-context-missing-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value);
    const calls: string[][] = [];
    const transport = createHerdrTransport({
      env: { HERDR_ENV: '1', HERDR_BIN_PATH: 'herdr' },
      run: async (_command, args) => {
        calls.push(args as string[]);
        throw new Error('must not resolve without inherited context');
      },
    });
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, 'herdr_caller_unverified');
    assert.match(String(result.value.detail), /caller_context_missing/);
    assert.match(String(result.value.detail), /--caller-pane/);
    assert.deepEqual(calls, []);
    assert.equal(readDeliveryRecord(value.taskRoot, message.message_id), null);
  } finally {
    cleanup(value.root);
  }
});

test('C1: a stale default context gives an explicit recovery hint', async () => {
  const transport = createHerdrTransport({
    env: {
      HERDR_ENV: '1',
      HERDR_BIN_PATH: 'herdr',
      HERDR_PANE_ID: 'w1:p1',
    },
    run: async () => ({
      spawned: true,
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'pane not found',
      timedOut: false,
      spawnError: null,
    }),
  });
  const result = await transport.verifyCaller();
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'caller_unresolved');
    assert.match(result.detail, /--caller-pane/);
  }
});

test('C1: explicit sender pane works with stale inherited IDs and unknown session', async () => {
  const value = fixture('c1-explicit-route');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-explicit-route-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value);
    const explicitCaller = {
      ok: true as const,
      caller: callerObservation({ source: 'explicit' }),
    };
    const transport = new FakeTransport({
      caller: {
        ok: false,
        status: 'unverified',
        code: 'caller_unresolved',
        detail: 'stale inherited context',
      },
      explicitCallers: { 'w3:p1': explicitCaller },
      agents: [observation({ cwd: value.taskRoot })],
    });
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      callerPane: 'w3:p1',
      transport,
      clock,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, 'submitted');
    assert.deepEqual(transport.callerOptions[0], { paneId: 'w3:p1' });
    assert.equal(result.value.caller?.source, 'explicit');
    assert.equal(result.value.caller?.paneId, 'w3:p1');
    assert.equal(result.value.caller?.nativeSession, 'unknown');
    assert.equal(result.value.caller?.processAffiliation, 'not-established');
    assert.equal(transport.prompts.length, 1);
    const delivery = readDeliveryRecord(value.taskRoot, message.message_id);
    assert.equal(delivery?.caller?.source, 'explicit');
    assert.equal(delivery?.caller?.process_affiliation, 'not-established');
    assert.equal(delivery?.caller?.native_session, 'unknown');
  } finally {
    cleanup(value.root);
  }
});

test('C1: an explicit foreign pane is refused before delivery writes', async () => {
  const value = fixture('c1-foreign-pane');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-foreign-pane-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value);
    const transport = new FakeTransport({
      explicitCallers: {
        'w3:p9': {
          ok: true,
          caller: callerObservation({ paneId: 'w3:p9', source: 'explicit' }),
        },
      },
    });
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      callerPane: 'w3:p9',
      transport,
      clock,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'caller_pane_mismatch');
    assert.equal(transport.prompts.length, 0);
    assert.equal(readDeliveryRecord(value.taskRoot, message.message_id), null);
  } finally {
    cleanup(value.root);
  }
});

test('C1: missing sender binding and sender mismatches refuse', async () => {
  const value = fixture('c1-sender-binding');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-sender-binding-1',
      from: coordinator,
    });
    await persist(value, message);

    const missing = bindingFor(value, { sender: false });
    const missingResult = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: missing.file,
      apply: true,
      retry: false,
      transport: new FakeTransport(),
      clock,
    });
    assert.equal(missingResult.ok, false);
    if (!missingResult.ok) {
      assert.equal(missingResult.code, 'binding_sender_missing');
    }

    const wrongHarness = bindingFor(value, {
      sender: { harness: 'pi' },
    });
    const harnessResult = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: wrongHarness.file,
      apply: true,
      retry: false,
      transport: new FakeTransport(),
      clock,
    });
    assert.equal(harnessResult.ok, false);
    if (!harnessResult.ok) {
      assert.equal(harnessResult.code, 'binding_sender_mismatch');
    }

    const wrongSession = bindingFor(value, {
      sender: { nativeSession: 'other-sender-session' },
    });
    const sessionResult = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: wrongSession.file,
      apply: true,
      retry: false,
      transport: new FakeTransport(),
      clock,
    });
    assert.equal(sessionResult.ok, false);
    if (!sessionResult.ok) {
      assert.equal(sessionResult.code, 'binding_sender_session_mismatch');
    }
  } finally {
    cleanup(value.root);
  }
});

test('C1: live sender name/pane/harness/cwd/session mismatches refuse', async () => {
  const value = fixture('c1-sender-live');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-sender-live-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value);
    const cases: { sender: HerdrAgentObservation; code: string }[] = [
      {
        sender: senderObservation({ name: 'someone-else' }),
        code: 'sender_target_not_found',
      },
      {
        sender: senderObservation({ paneId: 'w3:p9' }),
        code: 'sender_pane_mismatch',
      },
      {
        sender: senderObservation({ harness: 'pi' }),
        code: 'sender_harness_mismatch',
      },
      {
        sender: senderObservation({ cwd: '/tmp/elsewhere' }),
        code: 'sender_cwd_mismatch',
      },
      {
        sender: senderObservation({
          sessionKind: 'path',
          sessionValue: '/sessions/2026-10-21_other-session.jsonl',
        }),
        code: 'sender_session_mismatch',
      },
    ];
    for (const entry of cases) {
      const transport = new FakeTransport({ sender: entry.sender });
      const result = await notifyRegisteredMessage({
        taskRoot: value.taskRoot,
        messageId: message.message_id,
        bindingFile: binding.file,
        apply: true,
        retry: false,
        transport,
        clock,
      });
      assert.equal(result.ok, false, entry.code);
      if (!result.ok) assert.equal(result.code, entry.code, entry.code);
      assert.equal(transport.prompts.length, 0, entry.code);
      assert.equal(
        readDeliveryRecord(value.taskRoot, message.message_id),
        null,
        entry.code,
      );
    }
  } finally {
    cleanup(value.root);
  }
});

test('C1: null sender binding session still compares explicit message session', async () => {
  const value = fixture('c1-sender-null-session');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-sender-null-session-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value, { sender: { nativeSession: null } });
    const transport = new FakeTransport({
      sender: senderObservation({
        sessionKind: 'path',
        sessionValue: '/sessions/2026-10-21_other-session.jsonl',
      }),
    });
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'sender_session_mismatch');
    assert.equal(transport.prompts.length, 0);
  } finally {
    cleanup(value.root);
  }
});

test('notify permits unrelated atomic commits during live transport checks', async () => {
  const value = fixture('notify-unrelated-commit');
  try {
    const message = makeMessage('STATUS_QUERY');
    await persist(value, message);
    const binding = bindingFor(value);
    const transport = new FakeTransport({
      agents: [observation({ cwd: value.taskRoot })],
    });
    const list = transport.list.bind(transport);
    transport.list = async () => {
      await persist(
        value,
        makeMessage('ASK', {
          from: worker,
          subtask_id: 'work',
          attempt: 1,
          body: { question: 'Unrelated concurrent update' },
        }),
      );
      return list();
    };
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert(result.ok, JSON.stringify(result));
    assert.equal(result.value.status, 'submitted');
    assert.equal(transport.prompts.length, 1);
  } finally {
    cleanup(value.root);
  }
});

test('notify rejects selected binding or registered message drift during transport checks', async () => {
  for (const drift of ['binding', 'message'] as const) {
    const value = fixture(`notify-${drift}-drift`);
    try {
      const message = makeMessage('STATUS_QUERY');
      await persist(value, message);
      const binding = bindingFor(value);
      const transport = new FakeTransport({
        agents: [observation({ cwd: value.taskRoot })],
      });
      const list = transport.list.bind(transport);
      transport.list = async () => {
        if (drift === 'binding') {
          bindingFor(value, { paneId: 'w3:p9' });
        } else {
          writeFileSync(
            join(value.taskRoot, 'messages', `${message.message_id}.json`),
            JSON.stringify(
              makeMessage('STATUS_QUERY', { body: { changed: true } }),
            ),
          );
        }
        return list();
      };
      const result = await notifyRegisteredMessage({
        taskRoot: value.taskRoot,
        messageId: message.message_id,
        bindingFile: binding.file,
        apply: true,
        retry: false,
        transport,
        clock,
      });
      assert(!result.ok);
      assert.equal(
        result.code,
        drift === 'binding'
          ? 'binding_participant_changed'
          : 'message_registration_changed',
      );
      assert.equal(transport.prompts.length, 0);
      assert.equal(
        readDeliveryRecord(value.taskRoot, message.message_id),
        null,
      );
    } finally {
      cleanup(value.root);
    }
  }
});

test('C1: plan-only notify validates bindings without querying Herdr', async () => {
  const value = fixture('c1-plan-only');
  try {
    const message = makeMessage('STATUS_QUERY', {
      message_id: 'msg-plan-only-1',
      from: coordinator,
    });
    await persist(value, message);
    const binding = bindingFor(value);
    const transport = new FakeTransport();
    const result = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: message.message_id,
      bindingFile: binding.file,
      apply: false,
      retry: false,
      transport,
      clock,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, 'planned');
    assert.equal(result.value.caller, null);
    assert.equal(transport.callerCalls, 0);
    assert.equal(transport.listCalls, 0);
    assert.equal(transport.prompts.length, 0);
    assert.equal(readDeliveryRecord(value.taskRoot, message.message_id), null);
  } finally {
    cleanup(value.root);
  }
});
