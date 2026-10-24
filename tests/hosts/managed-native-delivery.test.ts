import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { initTask, transact } from '../../src/collab/store.js';
import {
  openMessageTask,
  readRegisteredMessageSafe,
} from '../../src/app/collab-messages.js';
import { deliverManagedPiMessage } from '../../src/app/managed-pi-delivery.js';
import type { ManagedPiSdkSessionController } from '../../src/hosts/pi/managed-sdk-session.js';

test('owned native delivery accepts registered pointers and refuses forged, stale or approval-blocked inputs', async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pappra-native-delivery-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const domain = path.join(root, 'domain');
  fs.mkdirSync(domain);
  const taskRoot = path.join(domain, 'tasks', 'delivery');
  const coordinator = {
    agent_id: 'coordinator',
    session_id: 'coordinator-native',
    harness: 'codex',
    owner_epoch: 1,
    since: new Date().toISOString(),
  };
  const worker = {
    agent_id: 'writer',
    session_id: 'owned-native',
    harness: 'pi',
  };
  initTask(taskRoot, { taskId: 'delivery', coordinator, domainRoot: domain });
  const message = buildMessage({
    message_id: 'native-pointer',
    type: 'STATUS_QUERY',
    task_id: 'delivery',
    from: coordinator,
    to: worker,
    owner_epoch: 1,
  });
  assert.equal(submitMessage(taskRoot, message).ok, true);
  const opened = await openMessageTask(taskRoot);
  assert(opened.ok);
  const registered = await readRegisteredMessageSafe(
    opened.value,
    message.message_id,
  );
  assert(registered.ok);
  let pending = false;
  const inputs: string[] = [];
  const runtime = {
    observe: () => ({ native: { sessionId: worker.session_id }, cwd: root }),
    snapshot: () => ({
      ownedRuntime: {
        extensionDialogs: {
          completeness: 'complete',
          pending: pending ? ['approval'] : [],
        },
        queues: { internal: { activeSelector: null } },
      },
    }),
    submitInput: (_id: string, text: string) => {
      inputs.push(text);
      return { status: 'submitted' };
    },
  } as unknown as ManagedPiSdkSessionController;
  const authorization = { taskRoot, agentId: worker.agent_id };
  const request = {
    task_root: taskRoot,
    message_id: message.message_id,
    digest: registered.value.digest,
    expected_session_id: worker.session_id,
  };
  assert.equal(
    (
      await deliverManagedPiMessage(
        runtime,
        { ...request, digest: 'sha256:forged' },
        authorization,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await deliverManagedPiMessage(
        runtime,
        { ...request, expected_session_id: 'other' },
        authorization,
      )
    ).ok,
    false,
  );
  pending = true;
  assert.equal(
    (await deliverManagedPiMessage(runtime, request, authorization)).ok,
    false,
  );
  assert.equal(inputs.length, 0);
  pending = false;
  assert.equal(
    (await deliverManagedPiMessage(runtime, request, authorization)).ok,
    true,
  );
  assert.equal(inputs.length, 1);
  assert.match(inputs[0]!, /COLLAB_MESSAGE task=delivery type=STATUS_QUERY/);
  assert(!inputs[0]!.includes('token'));
  assert.equal(
    transact(taskRoot, {
      actor: 'test',
      purpose: 'epoch-change',
      apply(record) {
        record.coordinator!.owner_epoch++;
        return { record, result: null };
      },
    }).ok,
    true,
  );
  assert.equal(
    (await deliverManagedPiMessage(runtime, request, authorization)).ok,
    false,
  );
  assert.equal(inputs.length, 1);
});
