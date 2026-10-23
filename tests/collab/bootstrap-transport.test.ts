import assert from 'node:assert/strict';
import test from 'node:test';
import { createHerdrBootstrapOps } from '../../src/app/collab-bootstrap-transport.js';
import type {
  CommandResult,
  CommandRunner,
  HerdrListResult,
  HerdrPromptResult,
  HerdrTransport,
} from '../../src/app/collab-notify.js';

const sessionId = '22222222-2222-4222-8222-222222222222';
const extensionEntry = '/tmp/bootstrap/extensions/pappra-bootstrap/index.ts';
const basePane = {
  pane_id: 'w1:p2',
  terminal_id: 'terminal-2',
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  cwd: '/workspace/project',
  foreground_cwd: '/workspace/project',
  agent: null,
  agent_status: 'idle',
  focused: false,
  revision: 7,
};

function envelope(
  type: string,
  result: Record<string, unknown>,
  id = 'correlation-not-a-pane-id',
): string {
  return JSON.stringify({ id, result: { type, ...result } });
}
function commandResult(
  stdout: string,
  overrides: Partial<CommandResult> = {},
): CommandResult {
  return {
    spawned: true,
    code: 0,
    signal: null,
    stdout,
    stderr: '',
    timedOut: false,
    spawnError: null,
    ...overrides,
  };
}
function fakeTransport(): HerdrTransport {
  return {
    id: 'fake-herdr',
    verifyCaller: async () => ({
      ok: false,
      status: 'unverified',
      code: 'unused',
      detail: 'unused',
    }),
    list: async (): Promise<HerdrListResult> => ({ ok: true, agents: [] }),
    prompt: async (): Promise<HerdrPromptResult> => ({
      status: 'failed',
      detail: 'unused',
    }),
  };
}
function makeOps(run: CommandRunner) {
  return createHerdrBootstrapOps({
    env: { HERDR_BIN_PATH: 'herdr-test' },
    run,
    transport: fakeTransport(),
  });
}

test('typed pane reads use nested resource ids, not the correlation id', async () => {
  const calls: {
    command: string;
    args: readonly string[];
    timeoutMs: number;
  }[] = [];
  const run: CommandRunner = async (command, args, timeoutMs) => {
    calls.push({ command, args, timeoutMs });
    if (args[0] === 'pane' && args[1] === 'get')
      return commandResult(envelope('pane_info', { pane: basePane }));
    return commandResult(
      envelope('pane_process_info', {
        process_info: {
          pane_id: 'w1:p2',
          shell_pid: 41,
          foreground_process_group_id: 41,
          tty: 'pts/2',
          foreground_processes: [{ pid: 41, name: '/bin/zsh' }],
        },
      }),
    );
  };
  const ops = makeOps(run);
  const pane = await ops.paneGet('w1:p2');
  const process = await ops.paneProcessInfo('w1:p2');
  assert.equal(pane.ok, true);
  assert.equal(pane.ok && pane.value.paneId, 'w1:p2');
  assert.equal(pane.ok && pane.correlationId, 'correlation-not-a-pane-id');
  assert.equal(process.ok, true);
  assert.equal(process.ok && process.value.paneId, 'w1:p2');
  assert.equal(process.ok && process.value.shellPid, 41);
  assert.equal(calls[0]?.command, 'herdr-test');
  assert.deepEqual(calls[1]?.args, ['pane', 'process-info', '--pane', 'w1:p2']);
});

test('malformed typed pane payload is rejected instead of using its correlation id', async () => {
  const ops = makeOps(async () =>
    commandResult(
      envelope('pane_info', {
        pane: { ...basePane, pane_id: undefined },
      }),
    ),
  );
  const result = await ops.paneGet('w1:p2');
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.code, 'herdr_payload_invalid');
  assert.equal(result.ok ? null : result.receipt.argv[0], 'herdr');
});

test('split preserves focus and start passes only the exact Pi session and gate extension', async () => {
  const calls: {
    command: string;
    args: readonly string[];
    timeoutMs: number;
  }[] = [];
  const run: CommandRunner = async (command, args, timeoutMs) => {
    calls.push({ command, args, timeoutMs });
    if (args[0] === 'pane')
      return commandResult(envelope('pane_info', { pane: basePane }));
    const argv = [
      'pi',
      '--session-id',
      sessionId,
      '--name',
      'pappra-test',
      '--extension',
      extensionEntry,
    ];
    return commandResult(
      envelope('agent_started', {
        agent: {
          ...basePane,
          agent: 'pi',
          agent_status: 'working',
          name: 'pappra-test',
          agent_session: { kind: 'id', value: sessionId },
          interactive_ready: true,
          launch_pending: false,
        },
        argv,
      }),
    );
  };
  const ops = makeOps(run);
  const split = await ops.splitPane({
    paneId: 'w1:p1',
    cwd: '/workspace/project',
    direction: 'down',
  });
  const start = await ops.startAgent({
    name: 'pappra-test',
    paneId: 'w1:p2',
    sessionId,
    extensionEntry,
  });
  assert.equal(split.ok, true);
  assert.deepEqual(calls[0]?.args, [
    'pane',
    'split',
    '--pane',
    'w1:p1',
    '--cwd',
    '/workspace/project',
    '--no-focus',
    '--direction',
    'down',
  ]);
  assert.equal(start.ok, true);
  assert.deepEqual(calls[1]?.args, [
    'agent',
    'start',
    'pappra-test',
    '--kind',
    'pi',
    '--pane',
    'w1:p2',
    '--timeout',
    '45000',
    '--',
    '--session-id',
    sessionId,
    '--name',
    'pappra-test',
    '--extension',
    extensionEntry,
  ]);
  assert.equal(calls[1]?.args.includes('--model'), false);
  assert.equal(start.ok && start.value.sessionValue, sessionId);
  assert.equal(start.ok && start.value.interactiveReady, true);
});

test('unknown effect outcome retains a bounded receipt and is not reported as a typed failure', async () => {
  const ops = makeOps(async () =>
    commandResult('', { timedOut: true, code: null, signal: 'SIGKILL' }),
  );
  const result = await ops.splitPane({
    paneId: 'w1:p1',
    cwd: '/workspace/project',
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.status, 'unknown');
  assert.equal(result.ok ? null : result.code, 'herdr_command_timeout');
  assert.equal(result.ok ? null : result.receipt.timed_out, true);
});

test('owned-pane close is an explicit typed operation', async () => {
  let called: readonly string[] = [];
  const ops = makeOps(async (_command, args) => {
    called = args;
    return commandResult(envelope('ok', { type: 'ok' }));
  });
  const result = await ops.closePane({ paneId: 'w1:p2' });
  assert.equal(result.ok, true);
  assert.deepEqual(called, ['pane', 'close', 'w1:p2']);
});
