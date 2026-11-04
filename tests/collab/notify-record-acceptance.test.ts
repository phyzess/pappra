import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { initTask, readRecord } from '../../src/collab/store.js';
import type { Identity, Message } from '../../src/collab/types.js';
import {
  readDeliveryRecord,
  sendMessageFromFile,
} from '../../src/app/collab-messages.js';
import {
  notifyRegisteredMessage,
  type HerdrAgentObservation,
  type HerdrCallerResult,
  type HerdrListResult,
  type HerdrPromptResult,
  type HerdrTransport,
} from '../../src/app/collab-notify.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

/**
 * Notification admits a message only when the task record accepted it. A
 * registered file proves bytes, not a protocol decision, so a refused
 * registration, a hand-placed envelope and a content swap under an accepted id
 * are all refused before any transport call. Nothing here contacts a real host.
 */

const clock = Date.parse('2026-11-12T08:00:00Z');
const coordinator = {
  agent_id: 'pappra-coordinator',
  session_id: 'coordinator-session',
  harness: 'codex',
  owner_epoch: 1,
  since: '2026-11-12T08:00:00+08:00',
};
const worker = {
  agent_id: 'pappra-implement',
  session_id: 'worker-session',
  harness: 'pi',
} as const satisfies Identity;

interface Fixture {
  readonly root: string;
  readonly taskRoot: string;
  readonly bindingFile: string;
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
  const bindingFile = join(root, 'binding.json');
  writeFileSync(
    bindingFile,
    `${JSON.stringify(
      {
        schema: 'pappra/collab-binding/1',
        task_id: 'smoke',
        task_root: taskRoot,
        channel: 'herdr',
        participants: [
          {
            agent_id: coordinator.agent_id,
            harness: coordinator.harness,
            cwd: taskRoot,
            herdr_agent: 'pappra-coordinator',
            pane_id: 'w3:p1',
            native_session_id: coordinator.session_id,
          },
          {
            agent_id: worker.agent_id,
            harness: worker.harness,
            cwd: taskRoot,
            herdr_agent: 'pappra-implement',
            pane_id: 'w3:p3',
            native_session_id: worker.session_id,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { root, taskRoot, bindingFile };
}

function message(
  type: string,
  overrides: {
    readonly message_id: string;
    readonly from?: Identity;
    readonly to?: Identity;
    readonly body?: Record<string, unknown>;
    readonly subtask_id?: string | null;
    readonly attempt?: number | null;
    readonly owner_epoch?: number | null;
  },
): Message {
  return buildMessage(
    {
      type,
      message_id: overrides.message_id,
      task_id: 'smoke',
      from: overrides.from ?? coordinator,
      to: overrides.to ?? worker,
      reply_to: null,
      subtask_id: overrides.subtask_id ?? null,
      attempt: overrides.attempt ?? null,
      owner_epoch: overrides.owner_epoch ?? null,
      body: overrides.body ?? {},
    },
    { clock },
  );
}

async function send(value: Fixture, envelope: Message) {
  const file = join(value.root, `envelope-${envelope.message_id}.json`);
  writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`);
  const result = await sendMessageFromFile(value.taskRoot, file, {
    apply: true,
    clock,
  });
  assert.equal(result.ok, true);
  assert(result.ok);
  return result.value;
}

function observation(
  overrides: Partial<HerdrAgentObservation> = {},
): HerdrAgentObservation {
  return {
    name: 'pappra-implement',
    harness: 'pi',
    paneId: 'w3:p3',
    cwd: '/tmp/task-root',
    sessionValue: 'worker-session',
    sessionKind: 'id',
    status: 'idle',
    focused: false,
    ...overrides,
  };
}

/** Records every transport call so a refusal can be proven to reach none of them. */
class RecordingTransport implements HerdrTransport {
  readonly id = 'recording-herdr';
  readonly prompts: { readonly agent: string; readonly text: string }[] = [];
  callerCalls = 0;
  listCalls = 0;
  constructor(private readonly cwd: string) {}

  async verifyCaller(): Promise<HerdrCallerResult> {
    this.callerCalls += 1;
    return {
      ok: true,
      caller: {
        paneId: 'w3:p1',
        workspaceId: 'w3',
        tabId: 'w3:t1',
        harness: 'codex',
        cwd: this.cwd,
        sessionKind: 'id',
        sessionValue: coordinator.session_id,
        source: 'current',
      },
    };
  }

  async list(): Promise<HerdrListResult> {
    this.listCalls += 1;
    return {
      ok: true,
      agents: [
        observation({
          name: 'pappra-coordinator',
          harness: 'codex',
          paneId: 'w3:p1',
          cwd: this.cwd,
          sessionValue: coordinator.session_id,
        }),
        observation({ cwd: this.cwd }),
      ],
    };
  }

  async prompt(agent: string, text: string): Promise<HerdrPromptResult> {
    this.prompts.push({ agent, text });
    return { status: 'submitted', detail: null, effect: 'possible' };
  }
}

test('notify refuses a registration the protocol rejected, in plan and in apply', async () => {
  const value = fixture('notify-record-rejected');
  try {
    const stale = message('ASSIGN', {
      message_id: 'msg-stale-epoch-1',
      subtask_id: 'work',
      attempt: 1,
      owner_epoch: 99,
      body: { assignment_digest: 'sha256:assignment' },
    });
    const sent = await send(value, stale);
    assert.equal(sent.status, 'rejected');
    assert.equal(sent.registrationStatus, 'registered');
    assert.match(String(sent.detail), /stale_epoch/);

    // The envelope file stays on disk; the record holds no entry for it.
    assert.equal(
      existsSync(join(value.taskRoot, 'messages', 'msg-stale-epoch-1.json')),
      true,
    );
    const record = readRecord(value.taskRoot);
    assert(record);
    assert.equal(
      record.messages.some((row) => row.message_id === 'msg-stale-epoch-1'),
      false,
    );

    const transport = new RecordingTransport(value.taskRoot);
    const planned = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-stale-epoch-1',
      bindingFile: value.bindingFile,
      apply: false,
      retry: false,
      transport,
      clock,
    });
    assert.equal(planned.ok, false);
    assert(!planned.ok);
    assert.equal(planned.code, 'message_not_recorded');
    assert.equal(planned.effect, 'none');
    assert.match(String(planned.nextAction), /did not accept this message/);

    const applied = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-stale-epoch-1',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(applied.ok, false);
    assert(!applied.ok);
    assert.equal(applied.code, 'message_not_recorded');

    assert.equal(transport.callerCalls, 0);
    assert.equal(transport.listCalls, 0);
    assert.equal(transport.prompts.length, 0);
    assert.equal(readDeliveryRecord(value.taskRoot, 'msg-stale-epoch-1'), null);
    assert.equal(
      existsSync(
        join(value.taskRoot, 'notifications', 'msg-stale-epoch-1.json'),
      ),
      false,
    );
  } finally {
    cleanup(value.root);
  }
});

test('notify refuses a hand-placed envelope the task record never accepted', async () => {
  const value = fixture('notify-record-handplaced');
  try {
    const handPlaced = message('STATUS_QUERY', {
      message_id: 'msg-handplaced-1',
      body: { status: 'running' },
    });
    writeFileSync(
      join(value.taskRoot, 'messages', 'msg-handplaced-1.json'),
      `${JSON.stringify(handPlaced, null, 2)}\n`,
    );

    const transport = new RecordingTransport(value.taskRoot);
    const applied = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-handplaced-1',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(applied.ok, false);
    assert(!applied.ok);
    assert.equal(applied.code, 'message_not_recorded');
    assert.equal(transport.prompts.length, 0);
    assert.equal(readDeliveryRecord(value.taskRoot, 'msg-handplaced-1'), null);
  } finally {
    cleanup(value.root);
  }
});

test('notify refuses a file whose content differs from what the record accepted', async () => {
  const value = fixture('notify-record-content-swap');
  try {
    const accepted = message('STATUS_QUERY', {
      message_id: 'msg-swapped-1',
      body: { status: 'running' },
    });
    const sent = await send(value, accepted);
    assert.equal(sent.status, 'accepted');

    // Same id, different content: the record accepted the first body only.
    const swapped = {
      ...message('STATUS_QUERY', {
        message_id: 'msg-swapped-1',
        body: { status: 'completed' },
      }),
      created_at: accepted.created_at,
    };
    writeFileSync(
      join(value.taskRoot, 'messages', 'msg-swapped-1.json'),
      `${JSON.stringify(swapped, null, 2)}\n`,
    );

    const transport = new RecordingTransport(value.taskRoot);
    const applied = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-swapped-1',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(applied.ok, false);
    assert(!applied.ok);
    assert.equal(applied.code, 'message_content_not_recorded');
    assert.equal(transport.prompts.length, 0);
    assert.equal(readDeliveryRecord(value.taskRoot, 'msg-swapped-1'), null);
  } finally {
    cleanup(value.root);
  }
});

test('notify still forwards one pointer for a message the record accepted', async () => {
  const value = fixture('notify-record-accepted');
  try {
    const query = message('STATUS_QUERY', {
      message_id: 'msg-accepted-1',
      body: { status: 'running' },
    });
    const sent = await send(value, query);
    assert.equal(sent.status, 'accepted');

    const transport = new RecordingTransport(value.taskRoot);
    const notified = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-accepted-1',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(notified.ok, true);
    assert(notified.ok);
    assert.equal(notified.value.status, 'submitted');
    assert.equal(notified.value.consumed, false);
    assert.equal(notified.value.taskAccepted, false);
    assert.equal(transport.prompts.length, 1);
    assert.equal(
      readDeliveryRecord(value.taskRoot, 'msg-accepted-1')?.status,
      'submitted',
    );
  } finally {
    cleanup(value.root);
  }
});
