import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { initTask } from '../../src/collab/store.js';
import type { Message } from '../../src/collab/types.js';
import {
  readDeliveryRecord,
  readMessageFromTaskRoot,
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
 * Characterization of the transport/runtime contract boundaries. Each case pins
 * behaviour that exists today so a later extraction cannot change it silently.
 *
 * Two boundaries are pinned here because no existing test pinned them: a
 * registered message whose id does not match its registration, and a message
 * file that is valid while the task record has not accepted it. #17 decided the
 * second one: notification requires a matching accepted `record.messages` entry,
 * so that case is refused rather than delivered. Every other required case is
 * covered elsewhere and is listed with its file and test name in
 * `docs/transport-runtime-boundaries.md` §6. Nothing here starts a session or
 * calls a real host.
 */

const clock = Date.parse('2026-11-03T04:00:00Z');
const coordinator = {
  agent_id: 'coordinator',
  session_id: 'coordinator-session',
  harness: 'pi',
  owner_epoch: 1,
  since: '2026-11-03T12:00:00+08:00',
};
const worker = {
  agent_id: 'worker',
  session_id: 'worker-session',
  harness: 'codex',
} as const;

function statusQuery(messageId: string): Message {
  return buildMessage(
    {
      type: 'STATUS_QUERY',
      message_id: messageId,
      task_id: 'sample',
      from: coordinator,
      to: worker,
      reply_to: null,
      subtask_id: null,
      attempt: null,
      owner_epoch: null,
      body: { status: 'running' },
    },
    { clock },
  );
}

test('a registered message whose id does not match its registration is refused', async () => {
  const root = makeTempDir('transport-runtime-registration');
  try {
    const taskRoot = join(root, 'domain', 'tasks', 'sample');
    initTask(taskRoot, {
      taskId: 'sample',
      coordinator,
      domainRoot: join(root, 'domain'),
      clock,
    });

    const envelopeFile = join(root, 'envelope.json');
    writeFileSync(
      envelopeFile,
      `${JSON.stringify(statusQuery('msg-registered-1'), null, 2)}\n`,
    );
    const sent = await sendMessageFromFile(taskRoot, envelopeFile, {
      apply: true,
      clock,
    });
    assert.equal(sent.ok, true);

    // The untouched registration is readable: the refusal below is caused by the
    // id mismatch and not by a broken fixture.
    const baseline = await readMessageFromTaskRoot(
      taskRoot,
      'msg-registered-1',
    );
    assert.equal(baseline.ok, true);

    // Replace the registered file with a valid envelope that carries another id.
    writeFileSync(
      join(taskRoot, 'messages', 'msg-registered-1.json'),
      `${JSON.stringify(statusQuery('msg-registered-2'), null, 2)}\n`,
    );

    const read = await readMessageFromTaskRoot(taskRoot, 'msg-registered-1');
    assert.equal(read.ok, false);
    if (read.ok) return;
    assert.equal(read.code, 'message_registration_invalid');

    // The same refusal happens before any transport call, so a mismatched
    // registration can never become a delivered pointer.
    const notified = await notifyRegisteredMessage({
      taskRoot,
      messageId: 'msg-registered-1',
      bindingFile: join(taskRoot, 'binding.json'),
      apply: true,
      retry: false,
      clock,
    });
    assert.equal(notified.ok, false);
    if (notified.ok) return;
    assert.equal(notified.code, 'message_registration_invalid');
    assert.equal(readDeliveryRecord(taskRoot, 'msg-registered-1'), null);
  } finally {
    cleanup(root);
  }
});

function observation(
  overrides: Partial<HerdrAgentObservation> = {},
): HerdrAgentObservation {
  return {
    name: 'pappra-implement',
    harness: 'codex',
    paneId: 'w3:p3',
    cwd: '/tmp/task-root',
    sessionValue: null,
    sessionKind: null,
    status: 'idle',
    focused: false,
    ...overrides,
  };
}

/** Minimal stand-in for the transport seam; it records what it was asked to do. */
class FakeTransport implements HerdrTransport {
  readonly id = 'fake-herdr';
  readonly prompts: { readonly agent: string; readonly text: string }[] = [];
  constructor(
    private readonly agents: readonly HerdrAgentObservation[],
    private readonly callerPane: string,
    private readonly cwd: string,
  ) {}

  async verifyCaller(): Promise<HerdrCallerResult> {
    return {
      ok: true,
      caller: {
        paneId: this.callerPane,
        workspaceId: 'w3',
        tabId: 'w3:t1',
        harness: 'pi',
        cwd: this.cwd,
        sessionKind: null,
        sessionValue: null,
        source: 'current',
      },
    };
  }

  async list(): Promise<HerdrListResult> {
    return { ok: true, agents: this.agents };
  }

  async prompt(agent: string, text: string): Promise<HerdrPromptResult> {
    this.prompts.push({ agent, text });
    return { status: 'submitted', detail: null, effect: 'possible' };
  }
}

test('notify refuses delivery when the file is valid but the record has not accepted the message', async () => {
  const root = makeTempDir('transport-runtime-unaccepted');
  try {
    const taskRoot = join(root, 'domain', 'tasks', 'sample');
    initTask(taskRoot, {
      taskId: 'sample',
      coordinator,
      domainRoot: join(root, 'domain'),
      clock,
    });

    // A valid, well-formed message file that was never sent through the message
    // service: the task record has no entry for it.
    const message = statusQuery('msg-unaccepted-1');
    writeFileSync(
      join(taskRoot, 'messages', 'msg-unaccepted-1.json'),
      `${JSON.stringify(message, null, 2)}\n`,
    );

    const read = await readMessageFromTaskRoot(taskRoot, 'msg-unaccepted-1');
    assert.equal(read.ok, true);
    if (!read.ok) return;
    // File validation passed, but the record holds no entry: the two states are
    // separate, and the record-aware reader is the only one that reports this.
    assert.equal(read.value.entry, null);

    const bindingFile = join(root, 'binding.json');
    writeFileSync(
      bindingFile,
      `${JSON.stringify(
        {
          schema: 'pappra/collab-binding/1',
          task_id: 'sample',
          task_root: taskRoot,
          channel: 'herdr',
          participants: [
            {
              agent_id: 'coordinator',
              harness: 'pi',
              cwd: root,
              herdr_agent: 'pappra-coordinator',
              pane_id: 'w3:p1',
              native_session_id: 'coordinator-session',
            },
            {
              agent_id: 'worker',
              harness: 'codex',
              cwd: root,
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

    const transport = new FakeTransport(
      [
        observation({
          name: 'pappra-coordinator',
          harness: 'pi',
          paneId: 'w3:p1',
          cwd: root,
        }),
        observation({ cwd: root }),
      ],
      'w3:p1',
      root,
    );
    const notified = await notifyRegisteredMessage({
      taskRoot,
      messageId: 'msg-unaccepted-1',
      bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
    });

    // Decided behaviour (#17): file validation is not record acceptance, so the
    // pointer is refused before any transport call and no delivery is recorded.
    assert.equal(notified.ok, false);
    if (notified.ok) return;
    assert.equal(notified.code, 'message_not_recorded');
    assert.equal(notified.effect, 'none');
    assert.equal(transport.prompts.length, 0);
    assert.equal(readDeliveryRecord(taskRoot, 'msg-unaccepted-1'), null);
  } finally {
    cleanup(root);
  }
});
