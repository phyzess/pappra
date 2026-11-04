import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { initTask } from '../../src/collab/store.js';
import {
  readDeliveryRecord,
  sendMessageFromFile,
} from '../../src/app/collab-messages.js';
import {
  notifyRegisteredMessage,
  type HerdrAgentObservation,
  type HerdrTransport,
} from '../../src/app/collab-notify.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

const ROOT = realpathSync(
  dirname(fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json'))),
);
const CLI = join(ROOT, 'dist/cli/main.js');
const clock = Date.parse('2026-10-21T10:00:00Z');

interface CliRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): CliRun {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    env,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function envWithoutHerdr(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['HERDR_ENV'];
  delete env['HERDR_BIN_PATH'];
  return env;
}

test('installed CLI persists, reads, lists and reports truthful notification state', () => {
  const root = realpathSync(makeTempDir('c0-message-cli'));
  try {
    const domain = join(root, 'domain');
    mkdirSync(domain, { recursive: true });
    const taskRoot = join(domain, 'tasks', 'cli-task');
    initTask(taskRoot, {
      taskId: 'cli-task',
      domainRoot: domain,
      coordinator: {
        agent_id: 'coordinator',
        session_id: 'coordinator-session',
        harness: 'codex',
        owner_epoch: 1,
        since: '2026-10-21T09:00:00+08:00',
      },
      clock,
    });
    const message = buildMessage(
      {
        type: 'STATUS_QUERY',
        message_id: 'msg-cli-1',
        task_id: 'cli-task',
        from: {
          agent_id: 'coordinator',
          session_id: 'coordinator-session',
          harness: 'codex',
        },
        to: {
          agent_id: 'worker',
          session_id: 'worker-session',
          harness: 'pi',
        },
      },
      { clock },
    );
    const envelope = join(root, 'envelope.json');
    writeFileSync(envelope, `${JSON.stringify(message, null, 2)}\n`);
    const binding = join(root, 'binding.json');
    writeFileSync(
      binding,
      `${JSON.stringify(
        {
          schema: 'pappra/collab-binding/1',
          task_id: 'cli-task',
          task_root: taskRoot,
          channel: 'herdr',
          participants: [
            {
              agent_id: 'coordinator',
              harness: 'codex',
              cwd: taskRoot,
              herdr_agent: 'pappra-coordinator',
              pane_id: 'w3:p1',
              native_session_id: 'coordinator-session',
            },
            {
              agent_id: 'worker',
              harness: 'pi',
              cwd: taskRoot,
              herdr_agent: 'pappra-implement',
              pane_id: 'w3:p3',
              native_session_id: 'worker-session',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const planned = run(
      [
        'collab',
        'message',
        'send',
        '--task-root',
        taskRoot,
        '--message',
        envelope,
        '--json',
      ],
      root,
    );
    assert.equal(planned.status, 0, planned.stderr);
    const plannedValue = JSON.parse(planned.stdout) as {
      ok: boolean;
      status: string;
      delivery: string;
    };
    assert.equal(plannedValue.ok, true);
    assert.equal(plannedValue.status, 'planned');
    assert.equal(plannedValue.delivery, 'not-attempted');
    assert.equal(
      existsSync(join(taskRoot, 'messages', 'msg-cli-1.json')),
      false,
    );

    const applied = run(
      [
        'collab',
        'message',
        'send',
        '--task-root',
        taskRoot,
        '--message',
        envelope,
        '--apply',
        '--json',
      ],
      root,
    );
    assert.equal(applied.status, 0, applied.stderr);
    const appliedValue = JSON.parse(applied.stdout) as {
      ok: boolean;
      status: string;
      delivery: string;
      notified: boolean;
      taskAccepted: boolean;
      messagePath: string;
      digest: string;
    };
    assert.equal(appliedValue.ok, true);
    assert.equal(appliedValue.status, 'accepted');
    assert.equal(appliedValue.delivery, 'persisted-not-notified');
    assert.equal(appliedValue.notified, false);
    assert.equal(appliedValue.taskAccepted, false);
    assert.equal(
      appliedValue.messagePath,
      join(taskRoot, 'messages', 'msg-cli-1.json'),
    );
    assert.match(appliedValue.digest, /^sha256:[0-9a-f]{64}$/);

    const read = run(
      [
        'collab',
        'message',
        'read',
        '--task-root',
        taskRoot,
        '--message-id',
        'msg-cli-1',
        '--json',
      ],
      root,
    );
    assert.equal(read.status, 0, read.stderr);
    const readValue = JSON.parse(read.stdout) as {
      message: { message_id: string };
      writes: boolean;
      delivery: unknown;
    };
    assert.equal(readValue.message.message_id, 'msg-cli-1');
    assert.equal(readValue.writes, false);
    assert.equal(readValue.delivery, null);

    const list = run(
      [
        'collab',
        'message',
        'list',
        '--task-root',
        taskRoot,
        '--limit',
        '5',
        '--json',
      ],
      root,
    );
    assert.equal(list.status, 0, list.stderr);
    const listValue = JSON.parse(list.stdout) as {
      total: number;
      returned: number;
      messages: { message_id: string }[];
    };
    assert.equal(listValue.total, 1);
    assert.equal(listValue.returned, 1);
    assert.equal(listValue.messages[0]?.message_id, 'msg-cli-1');

    const notify = run(
      [
        'collab',
        'message',
        'notify',
        '--task-root',
        taskRoot,
        '--message-id',
        'msg-cli-1',
        '--binding',
        binding,
        '--apply',
        '--json',
      ],
      root,
      envWithoutHerdr(),
    );
    assert.equal(notify.status, 1, notify.stderr);
    const notifyValue = JSON.parse(notify.stdout) as {
      ok: boolean;
      status: string;
      consumed: boolean;
      taskAccepted: boolean;
      messagePath: string;
    };
    assert.equal(notifyValue.ok, false);
    assert.equal(notifyValue.status, 'herdr_unavailable');
    assert.equal(notifyValue.consumed, false);
    assert.equal(notifyValue.taskAccepted, false);
    assert.equal(
      notifyValue.messagePath,
      join(taskRoot, 'messages', 'msg-cli-1.json'),
    );
    assert.equal(
      existsSync(join(taskRoot, 'notifications', 'msg-cli-1.json')),
      false,
    );

    const missingMessage = run(
      ['collab', 'message', 'send', '--task-root', taskRoot, '--json'],
      root,
    );
    assert.equal(missingMessage.status, 2);
    const missingValue = JSON.parse(missingMessage.stdout) as {
      ok: boolean;
      code: string;
    };
    assert.equal(missingValue.ok, false);
    assert.equal(missingValue.code, 'invalid_arguments');

    const help = run(['collab', '--help'], root);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /message <send\|list\|read\|notify>/);

    const ignoredFlag = run(
      ['doctor', '--task-root', taskRoot, '--json'],
      root,
    );
    assert.equal(ignoredFlag.status, 2);
    const ignoredValue = JSON.parse(ignoredFlag.stdout) as {
      ok: boolean;
      code: string;
    };
    assert.equal(ignoredValue.ok, false);
    assert.equal(ignoredValue.code, 'invalid_arguments');

    const messageHelp = run(['collab', 'message', '--help'], root);
    assert.equal(messageHelp.status, 0, messageHelp.stderr);
    assert.match(
      messageHelp.stdout,
      /pappra collab message <send\|list\|read\|notify>/,
    );
    assert.match(messageHelp.stdout, /send plans by default/);

    const prepareWithMessageFlag = run(
      [
        'collab',
        'prepare',
        '--goal',
        '/tmp/goal.json',
        '--domain-root',
        '/tmp/domain',
        '--task-root',
        taskRoot,
        '--json',
      ],
      root,
    );
    assert.equal(prepareWithMessageFlag.status, 2);
    const prepareValue = JSON.parse(prepareWithMessageFlag.stdout) as {
      ok: boolean;
      code: string;
    };
    assert.equal(prepareValue.ok, false);
    assert.equal(prepareValue.code, 'invalid_arguments');

    const invalidCallerPane = run(
      [
        'collab',
        'message',
        'notify',
        '--task-root',
        taskRoot,
        '--message-id',
        'msg-cli-1',
        '--binding',
        binding,
        '--caller-pane',
        'w3-p1',
        '--apply',
        '--json',
      ],
      root,
    );
    assert.equal(invalidCallerPane.status, 2, invalidCallerPane.stderr);
    const invalidCallerValue = JSON.parse(invalidCallerPane.stdout) as {
      ok: boolean;
      code: string;
    };
    assert.equal(invalidCallerValue.ok, false);
    assert.equal(invalidCallerValue.code, 'caller_pane_invalid');

    const listWithObserve = run(
      [
        'collab',
        'message',
        'list',
        '--task-root',
        taskRoot,
        '--observe',
        '--json',
      ],
      root,
    );
    assert.equal(listWithObserve.status, 2);
    const listObserveValue = JSON.parse(listWithObserve.stdout) as {
      ok: boolean;
      code: string;
    };
    assert.equal(listObserveValue.ok, false);
    assert.equal(listObserveValue.code, 'invalid_arguments');

    const notifyWithObserve = run(
      [
        'collab',
        'message',
        'notify',
        '--task-root',
        taskRoot,
        '--message-id',
        'msg-cli-1',
        '--binding',
        binding,
        '--apply',
        '--observe',
        '--json',
      ],
      root,
      envWithoutHerdr(),
    );
    // Routing accepts the flag; the outcome is still the transport's refusal.
    assert.equal(notifyWithObserve.status, 1, notifyWithObserve.stderr);
    const observedValue = JSON.parse(notifyWithObserve.stdout) as {
      status: string;
      observation: unknown;
    };
    assert.equal(observedValue.status, 'herdr_unavailable');
    assert.equal(observedValue.observation, null);

    const sendWithCallerPane = run(
      [
        'collab',
        'message',
        'send',
        '--task-root',
        taskRoot,
        '--message',
        envelope,
        '--caller-pane',
        'w3:p1',
        '--apply',
        '--json',
      ],
      root,
    );
    assert.equal(sendWithCallerPane.status, 2);
    const sendValue = JSON.parse(sendWithCallerPane.stdout) as {
      ok: boolean;
      code: string;
    };
    assert.equal(sendValue.ok, false);
    assert.equal(sendValue.code, 'invalid_arguments');

    const explicitHelp = run(['collab', 'message', '--help'], root);
    assert.equal(explicitHelp.status, 0, explicitHelp.stderr);
    assert.match(explicitHelp.stdout, /--caller-pane <id>/);
    assert.match(explicitHelp.stdout, /--observe/);
  } finally {
    cleanup(root);
  }
});

test('message read reports a saved observation, and an unobserved record as unobserved', () => {
  const root = realpathSync(makeTempDir('c0-message-cli-receipt'));
  try {
    const domain = join(root, 'domain');
    mkdirSync(domain, { recursive: true });
    const taskRoot = join(domain, 'tasks', 'receipt-task');
    initTask(taskRoot, {
      taskId: 'receipt-task',
      domainRoot: domain,
      coordinator: {
        agent_id: 'coordinator',
        session_id: 'coordinator-session',
        harness: 'codex',
        owner_epoch: 1,
        since: '2026-10-21T09:00:00+08:00',
      },
      clock,
    });
    const at = new Date(clock).toISOString();
    const record = (messageId: string, observation: unknown) => ({
      schema: 'pappra/collab-delivery/1',
      message_id: messageId,
      message_path: join(taskRoot, 'messages', `${messageId}.json`),
      message_digest: `sha256:${'0'.repeat(64)}`,
      task_id: 'receipt-task',
      task_root: taskRoot,
      recipient: { agent_id: 'worker', harness: 'pi' },
      target: {
        herdr_agent: 'pappra-implement',
        pane_id: 'w3:p3',
        native_session: 'unknown',
      },
      status: 'submitted',
      attempts: [
        {
          at,
          status: 'submitted',
          detail: null,
          reservation_id: `reservation-${messageId}`,
          ...(observation === null ? {} : { observation }),
        },
      ],
      created_at: at,
      updated_at: at,
    });
    const messages = join(taskRoot, 'messages');
    const notifications = join(taskRoot, 'notifications');
    mkdirSync(messages, { recursive: true });
    mkdirSync(notifications, { recursive: true });
    for (const messageId of ['msg-receipt-observed', 'msg-receipt-old']) {
      writeFileSync(
        join(messages, `${messageId}.json`),
        `${JSON.stringify(
          buildMessage(
            {
              type: 'STATUS_QUERY',
              message_id: messageId,
              task_id: 'receipt-task',
              from: {
                agent_id: 'coordinator',
                session_id: 'coordinator-session',
                harness: 'codex',
              },
              to: {
                agent_id: 'worker',
                session_id: 'worker-session',
                harness: 'pi',
              },
            },
            { clock },
          ),
          null,
          2,
        )}\n`,
      );
    }
    writeFileSync(
      join(notifications, 'msg-receipt-observed.json'),
      `${JSON.stringify(
        record('msg-receipt-observed', {
          schema: 'pappra/collab-delivery-observation/1',
          receipt: 'unknown',
          reason: 'no_turn_activity_observed',
          source: 'herdr-agent-state',
          started_at: at,
          ended_at: at,
          window_ms: 2_000,
          samples: 3,
          before: {
            observed_at: at,
            agent_status: 'idle',
            terminal_id: 'terminal-1',
            state_change_seq: 5,
            completion_seq: 4,
            revision: 10,
            interactive_ready: null,
            launch_pending: null,
          },
          after: {
            observed_at: at,
            agent_status: 'idle',
            terminal_id: 'terminal-1',
            state_change_seq: 5,
            completion_seq: 4,
            revision: 10,
            interactive_ready: null,
            launch_pending: null,
          },
          detail: 'No working turn was observed.',
        }),
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(notifications, 'msg-receipt-old.json'),
      `${JSON.stringify(record('msg-receipt-old', null), null, 2)}\n`,
    );

    const observed = run(
      [
        'collab',
        'message',
        'read',
        '--task-root',
        taskRoot,
        '--message-id',
        'msg-receipt-observed',
      ],
      root,
    );
    assert.equal(observed.status, 0, observed.stderr);
    assert.match(
      observed.stdout,
      /receipt: unknown \(no_turn_activity_observed\), 3 sample\(s\) over 2000 ms; most recent attempt submitted/,
    );

    const old = run(
      [
        'collab',
        'message',
        'read',
        '--task-root',
        taskRoot,
        '--message-id',
        'msg-receipt-old',
      ],
      root,
    );
    assert.equal(old.status, 0, old.stderr);
    // An old record has no observation: it is unobserved, not an unknown receipt.
    assert.match(old.stdout, /receipt: unobserved/);
  } finally {
    cleanup(root);
  }
});

test('message read summarises the most recent attempt and JSON keeps earlier evidence', async () => {
  const root = realpathSync(makeTempDir('c0-message-cli-recent'));
  try {
    const domain = join(root, 'domain');
    mkdirSync(domain, { recursive: true });
    const taskRoot = join(domain, 'tasks', 'recent-task');
    const coordinator = {
      agent_id: 'coordinator',
      session_id: 'coordinator-session',
      harness: 'codex',
      owner_epoch: 1,
      since: '2026-10-21T09:00:00+08:00',
    };
    initTask(taskRoot, {
      taskId: 'recent-task',
      domainRoot: domain,
      coordinator,
      clock,
    });
    const envelopeFile = join(root, 'recent-envelope.json');
    writeFileSync(
      envelopeFile,
      `${JSON.stringify(
        buildMessage(
          {
            type: 'STATUS_QUERY',
            message_id: 'msg-recent-1',
            task_id: 'recent-task',
            from: {
              agent_id: 'coordinator',
              session_id: 'coordinator-session',
              harness: 'codex',
            },
            to: {
              agent_id: 'worker',
              session_id: 'worker-session',
              harness: 'pi',
            },
          },
          { clock },
        ),
        null,
        2,
      )}\n`,
    );
    const sent = await sendMessageFromFile(taskRoot, envelopeFile, {
      apply: true,
      clock,
    });
    assert.equal(sent.ok, true);
    const binding = join(root, 'recent-binding.json');
    writeFileSync(
      binding,
      `${JSON.stringify(
        {
          schema: 'pappra/collab-binding/1',
          task_id: 'recent-task',
          task_root: taskRoot,
          channel: 'herdr',
          participants: [
            {
              agent_id: 'coordinator',
              harness: 'codex',
              cwd: taskRoot,
              herdr_agent: 'pappra-coordinator',
              pane_id: 'w3:p1',
              native_session_id: 'coordinator-session',
            },
            {
              agent_id: 'worker',
              harness: 'pi',
              cwd: taskRoot,
              herdr_agent: 'pappra-implement',
              pane_id: 'w3:p3',
              native_session_id: 'worker-session',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const recipient = (
      overrides: Partial<HerdrAgentObservation> = {},
    ): HerdrAgentObservation => ({
      name: 'pappra-implement',
      harness: 'pi',
      paneId: 'w3:p3',
      cwd: taskRoot,
      sessionValue: 'worker-session',
      sessionKind: 'id',
      status: 'idle',
      focused: false,
      terminalId: 'terminal-1',
      stateChangeSeq: 5,
      completionSeq: 4,
      revision: 10,
      interactiveReady: null,
      launchPending: null,
      ...overrides,
    });
    let prompts = 0;
    const transport: HerdrTransport = {
      id: 'cli-recent-herdr',
      async verifyCaller() {
        return {
          ok: true,
          caller: {
            paneId: 'w3:p1',
            workspaceId: 'w3',
            tabId: 'w3:t1',
            harness: 'codex',
            cwd: taskRoot,
            sessionKind: 'id',
            sessionValue: 'coordinator-session',
            source: 'current',
          },
        };
      },
      async list() {
        return {
          ok: true,
          agents: [
            {
              name: 'pappra-coordinator',
              harness: 'codex',
              paneId: 'w3:p1',
              cwd: taskRoot,
              sessionValue: null,
              sessionKind: null,
              status: 'idle',
              focused: false,
            },
            recipient(),
          ],
        };
      },
      async prompt() {
        prompts += 1;
        return prompts === 1
          ? { status: 'submitted', detail: null }
          : { status: 'refused', detail: 'Herdr refused', effect: 'none' };
      },
    };

    let observationNow = clock;
    const first = await notifyRegisteredMessage({
      taskRoot,
      messageId: 'msg-recent-1',
      bindingFile: binding,
      apply: true,
      retry: false,
      transport,
      clock,
      observation: {
        maxSamples: 3,
        intervalMs: 1_000,
        windowMs: 3_000,
        probeTimeoutMs: 1_500,
        now: () => observationNow,
        sleep: async (milliseconds: number) => {
          observationNow += milliseconds;
        },
      },
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.observation?.reason, 'no_turn_activity_observed');

    // A retry that the transport refuses. Observation is not requested here, so
    // the most recent attempt carries no evidence of its own.
    const second = await notifyRegisteredMessage({
      taskRoot,
      messageId: 'msg-recent-1',
      bindingFile: binding,
      apply: true,
      retry: true,
      transport,
      clock,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.value.status, 'refused');
    assert.equal(second.value.observation, null);
    assert.equal(second.value.attempts, 2);

    const delivery = readDeliveryRecord(taskRoot, 'msg-recent-1');
    assert.equal(delivery?.attempts.length, 2);
    assert.equal(delivery?.attempts[0]?.observation?.receipt, 'unknown');
    assert.equal(delivery?.attempts[1]?.observation, undefined);

    // The human summary describes the most recent attempt, and says the
    // observation is missing rather than borrowing the earlier one.
    const human = run(
      [
        'collab',
        'message',
        'read',
        '--task-root',
        taskRoot,
        '--message-id',
        'msg-recent-1',
      ],
      root,
    );
    assert.equal(human.status, 0, human.stderr);
    assert.match(
      human.stdout,
      /receipt: unobserved for the most recent attempt \(refused\)/,
    );
    assert.doesNotMatch(human.stdout, /no_turn_activity_observed/);

    // JSON keeps every attempt, so the first observation is still readable.
    const json = run(
      [
        'collab',
        'message',
        'read',
        '--task-root',
        taskRoot,
        '--message-id',
        'msg-recent-1',
        '--json',
      ],
      root,
    );
    assert.equal(json.status, 0, json.stderr);
    const value = JSON.parse(json.stdout) as {
      delivery: {
        status: string;
        attempts: { status: string; observation?: { receipt: string } }[];
      };
    };
    assert.equal(value.delivery.status, 'refused');
    assert.equal(value.delivery.attempts.length, 2);
    assert.equal(value.delivery.attempts[0]?.status, 'submitted');
    assert.equal(value.delivery.attempts[0]?.observation?.receipt, 'unknown');
    assert.equal(value.delivery.attempts[1]?.status, 'refused');
    assert.equal(value.delivery.attempts[1]?.observation, undefined);
  } finally {
    cleanup(root);
  }
});
