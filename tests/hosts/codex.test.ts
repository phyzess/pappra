import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AttemptOptions } from '../../src/hosts/codex/native.js';
import { implementation } from './implementations.js';
const {
  openCodexTransport,
  queryCodexAttempt,
  cancelCodexAttempt,
  recoverCodexCompleted,
  queryPersistedHistory,
} = await implementation('codex');
import * as core from '../../src/collab/index.js';
import { owner, writer } from '../collab/scenarios.js';

async function fixture(completed = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pappra-codex-'));
  const executable = fileURLToPath(new URL('./fake-codex.js', import.meta.url));
  chmodSync(executable, 0o755);
  const env = { ...process.env, PAPPRA_FAKE_COMPLETED: completed ? '1' : '0' };
  const transport = await openCodexTransport({
    codexBin: executable,
    cwd: root,
    env,
  });
  try {
    const { threadId } = await transport.startThread({ cwd: root });
    const { turnId } = await transport.startTurn({ threadId, input: [] });
    const taskRoot = join(root, 'domain', 'tasks', 'sample');
    core.store.initTask(taskRoot, { taskId: 'sample', coordinator: owner });
    assert.equal(
      core.messages.submitMessage(
        taskRoot,
        core.envelope.buildMessage({
          type: 'ASSIGN',
          task_id: 'sample',
          from: owner,
          to: writer,
          subtask_id: 'work',
          attempt: 1,
          owner_epoch: 1,
          body: { assignment_digest: 'sha256:fixture' },
        }),
      ).ok,
      true,
    );
    core.store.transact(taskRoot, {
      apply: (record) => {
        const result = core.lifecycle.bindNative(record, {
          subtaskId: 'work',
          attempt: 1,
          runner: 'codex-app-server',
          sessionId: threadId,
          runId: turnId,
          observation: 'confirmed',
          evidenceRef: 'fixture/native.json',
        });
        assert.equal(result.ok, true);
        return { record };
      },
    });
    const options: AttemptOptions = {
      taskRoot,
      subtaskId: 'work',
      attempt: 1,
      ownerEpoch: 1,
      agentId: writer.agent_id,
      sessionId: writer.session_id,
      threadId,
      turnId,
      transport,
      cwd: root,
      timeoutMs: 3000,
    };
    return {
      root,
      executable,
      env,
      options,
      transport,
      cleanup: async () => {
        await transport.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await transport.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('Codex queries the owned original turn and correlates a terminal event before interrupt ack', async () => {
  const box = await fixture();
  try {
    assert.equal((await queryCodexAttempt(box.options)).status, 'active');
    const result = await cancelCodexAttempt(box.options);
    assert.equal(result.status, 'terminal');
    assert.equal(result['reconciliation_required'], true);
    assert.equal(result['cancelled_message_sent'], false);
    assert.equal(result.claims_retained, true);
    const requests = box.transport.requestLog().map((entry) => entry.method);
    assert.equal(
      requests.filter((method) => method === 'turn/start').length,
      1,
    );
    assert.equal(
      requests.filter((method) => method === 'turn/interrupt').length,
      1,
    );
  } finally {
    await box.cleanup();
  }
});

test('Codex rejects foreign turns and model overrides before dispatch', async () => {
  const box = await fixture();
  try {
    const before = box.transport.requestLog().length;
    const foreign = await cancelCodexAttempt({
      ...box.options,
      turnId: 'foreign',
    });
    assert.equal(foreign.status, 'needs_input');
    assert.equal(box.transport.requestLog().length, before);
    await assert.rejects(
      box.transport.startThread({ cwd: box.root, model: 'override' }),
      /override_not_supported/,
    );
    assert.equal(box.transport.requestLog().length, before);
  } finally {
    await box.cleanup();
  }
});

test('Codex recovery reads the original native output; a fresh server reports history scope', async () => {
  const box = await fixture(true);
  try {
    const result = await recoverCodexCompleted(box.options);
    assert.equal(result.status, 'recovered');
    assert.equal(result['agent_message'], 'Original fixture output.');
    assert.equal(result['receipt'], null);
    const history = await queryPersistedHistory({
      codexBin: box.executable,
      cwd: box.root,
      env: box.env,
      threadId: 'thread-fixture',
      turnId: 'turn-fixture',
    });
    assert.equal(history.status, 'persisted_history_only');
    assert.equal(history['in_flight_status'], null);
    assert(
      !box.transport
        .requestLog()
        .some((entry) => /resume|fork/.test(entry.method)),
    );
  } finally {
    await box.cleanup();
  }
});
