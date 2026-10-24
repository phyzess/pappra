import assert from 'node:assert/strict';
import test from 'node:test';
import { runCollaborationRoleRunCommand } from '../../src/cli/commands/collaboration-role-run.js';
import type { CliOutput } from '../../src/cli/output.js';
import {
  COLLAB_ROLE_ORCHESTRATION_SCHEMA,
  type RoleOrchestrationResult,
} from '../../src/app/collab-role-orchestration.js';
import type { RoleEventWatcher } from '../../src/app/collab-role-events.js';
import { watchRoleOrchestration } from '../../src/app/collab-role-events.js';

function outputCapture() {
  const stdout: string[] = [];
  const output: CliOutput = {
    stdout: (text) => stdout.push(text),
    stderr: () => {},
  };
  return { output, stdout };
}

const waitingResult: RoleOrchestrationResult = {
  schema: COLLAB_ROLE_ORCHESTRATION_SCHEMA,
  status: 'waiting',
  event_id: 'event',
  plan_id: 'plan',
  round: 1,
  reserved_actions: 0,
  prior_outcome: null,
  aggregate: null,
  execution: null,
  updatedRequest: null,
  diagnostics: [],
};

test('watch mode requires apply and sanitizes loader errors', async () => {
  const captured = outputCapture();
  const noApply = await runCollaborationRoleRunCommand(
    { requestFile: null, apply: false, watch: true, json: true },
    captured.output,
  );
  assert.equal(noApply, 2);
  assert.match(captured.stdout.join(''), /watch_requires_apply/);

  const sanitized = outputCapture();
  const failed = await runCollaborationRoleRunCommand(
    {
      requestFile: '/private/tmp/secret-role-request.json',
      apply: true,
      watch: false,
      json: true,
    },
    sanitized.output,
  );
  assert.equal(failed, 2);
  assert.doesNotMatch(sanitized.stdout.join(''), /secret-role-request/);
});

test('watch mode closes its watcher and removes signal handlers on SIGTERM', async () => {
  const captured = outputCapture();
  let signalWatchReady!: () => void;
  const watchReady = new Promise<void>((resolve) => {
    signalWatchReady = resolve;
  });
  let closed = false;
  const handle: RoleEventWatcher = {
    refresh: async () => {},
    status: () => ({ result: waitingResult, error: null }),
    close: async () => {
      closed = true;
    },
  };
  const watch: typeof watchRoleOrchestration = async (_file, onResult) => {
    onResult?.(waitingResult);
    signalWatchReady();
    return handle;
  };
  const beforeInt = process.listenerCount('SIGINT');
  const beforeTerm = process.listenerCount('SIGTERM');
  const command = runCollaborationRoleRunCommand(
    {
      requestFile: '/not-read-by-injected-watcher/role.json',
      apply: true,
      watch: true,
      json: true,
    },
    captured.output,
    { watch },
  );
  try {
    await watchReady;
    assert.equal(process.listenerCount('SIGINT'), beforeInt + 1);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm + 1);
    process.emit('SIGTERM');
    assert.equal(await command, 143);
    assert.equal(closed, true);
    assert.equal(process.listenerCount('SIGINT'), beforeInt);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
    assert.match(captured.stdout.join(''), /"status":"stopped"/);
  } finally {
    if (!closed) process.emit('SIGTERM');
    await command;
  }
});
