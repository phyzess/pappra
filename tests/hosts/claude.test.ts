import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as core from '../../src/collab/index.js';
import type { ClaudeOptions } from '../../src/hosts/claude/native.js';
import { implementation } from './implementations.js';
const { queryClaudeSession, cancelClaudeSession } =
  await implementation('claude');
import { owner } from '../collab/scenarios.js';

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pappra-claude-'));
  const taskRoot = join(root, 'domain', 'tasks', 'sample');
  const executable = join(root, 'fake claude');
  copyFileSync(
    fileURLToPath(new URL('./fake-claude.js', import.meta.url)),
    executable,
  );
  chmodSync(executable, 0o755);
  const state = join(root, 'state.json');
  const trace = join(root, 'trace.jsonl');
  const nativeId = '12345678-1234-4234-8234-123456789012';
  const writer = {
    agent_id: 'writer',
    session_id: 'writer-session',
    harness: 'claude',
  };
  const row = {
    id: 'deadbeef',
    sessionId: nativeId,
    cwd: root,
    kind: 'background',
    pid: 12345,
    status: 'idle',
    state: 'blocked',
    startedAt: 123,
  };
  writeFileSync(state, JSON.stringify([row]));
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
        runner: 'claude-background-cli',
        sessionId: nativeId,
        runId: 'deadbeef',
        observation: 'confirmed',
        evidenceRef: 'fixture/native.json',
      });
      assert.equal(result.ok, true);
      return { record };
    },
  });
  assert.equal(
    core.resources.claimResources(taskRoot, {
      resources: [{ path: join(root, 'work') }],
      holder: writer,
      subtaskId: 'work',
      attempt: 1,
    }).ok,
    true,
  );
  const options: ClaudeOptions = {
    taskRoot,
    subtaskId: 'work',
    attempt: 1,
    ownerEpoch: 1,
    agentId: writer.agent_id,
    sessionId: writer.session_id,
    cwd: root,
    claudeBin: executable,
    nativeSessionId: nativeId,
    expectedPid: 12345,
    expectedStartedAt: 123,
    timeoutMs: 3000,
    pollMs: 20,
    stopTimeoutMs: 3000,
    env: { ...process.env, PAPPRA_FAKE_STATE: state, PAPPRA_FAKE_TRACE: trace },
  };
  return {
    root,
    taskRoot,
    options,
    state,
    trace,
    row,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('Claude queries the exact background UUID and command key; idle remains active', async () => {
  const box = fixture();
  try {
    const result = await queryClaudeSession(box.options);
    assert.equal(result['status'], 'active');
    assert.equal(result['task_result_claimed'], false);
    const calls = readFileSync(box.trace, 'utf8');
    assert.match(calls, /\["logs","deadbeef"\]/);
    assert(!calls.includes('prompt'));
    assert.equal(
      core.store.readRecord(box.taskRoot)?.attempts[0]?.state,
      'assigned',
    );
    assert.equal(
      core.store.readRecord(box.taskRoot)?.claims[0]?.released_at,
      null,
    );
  } finally {
    box.cleanup();
  }
});

test('Claude stop exit status is separate from terminal observation and retains claims', async () => {
  const box = fixture();
  try {
    const result = await cancelClaudeSession(box.options);
    assert.equal(result['status'], 'terminal');
    assert.equal(result['reconciliation_required'], true);
    assert.equal(result['claims_retained'], true);
    assert.equal(result['cancelled_message_sent'], false);
    const record = core.store.readRecord(box.taskRoot);
    assert.equal(record?.attempts[0]?.state, 'assigned');
    assert.equal(record?.claims[0]?.cancel_pending, true);
    assert.equal(record?.claims[0]?.released_at, null);
    assert.match(readFileSync(box.trace, 'utf8'), /\["stop","deadbeef"\]/);
  } finally {
    box.cleanup();
  }
});

test('Claude refuses identity drift and ambiguous native rows before issuing stop', async () => {
  const box = fixture();
  try {
    for (const rows of [
      [{ ...box.row, id: 'cafebabe' }],
      [box.row, box.row],
      [],
    ]) {
      writeFileSync(box.state, JSON.stringify(rows));
      const result = await cancelClaudeSession(box.options);
      assert.equal(result['status'], 'needs_input');
      assert.equal(result['reconciliation_required'], false);
    }
    assert(!readFileSync(box.trace, 'utf8').includes('["stop"'));
  } finally {
    box.cleanup();
  }
});
