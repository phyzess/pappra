import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { initTask } from '../../src/collab/store.js';
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
  } finally {
    cleanup(root);
  }
});
