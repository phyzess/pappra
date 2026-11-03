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
import { notifyRegisteredMessage } from '../../src/app/collab-notify.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

/**
 * Characterization of the transport/runtime contract boundaries. Each case pins
 * behaviour that exists today so a later extraction cannot change it silently.
 *
 * This file adds only the boundary that no existing test pinned: a registered
 * message whose id does not match its registration. The other six required
 * cases are covered elsewhere and are listed with their file and test name in
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
