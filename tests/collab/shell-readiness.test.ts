import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  BootstrapCommandReceipt,
  BootstrapOperationResult,
  BootstrapPaneSnapshot,
  BootstrapProcessSnapshot,
  HerdrBootstrapOps,
} from '../../src/app/collab-bootstrap-transport.js';
import { verifyAvailableShell } from '../../src/app/shell-readiness.js';

const identity = {
  paneId: 'w1:p2',
  workspaceId: 'w1',
  terminalId: 'terminal-2',
  cwd: '/workspace/project',
};

function receipt(operation: string): BootstrapCommandReceipt {
  return {
    operation,
    argv: [],
    code: 0,
    signal: null,
    spawned: true,
    timed_out: false,
    spawn_error: null,
    stdout: '',
    stderr: '',
  };
}
function ok<T>(operation: string, value: T): BootstrapOperationResult<T> {
  return {
    ok: true,
    value,
    correlationId: 'correlation-1',
    receipt: receipt(operation),
  };
}
function pane(
  overrides: Partial<BootstrapPaneSnapshot> = {},
): BootstrapPaneSnapshot {
  return {
    paneId: identity.paneId,
    terminalId: identity.terminalId,
    workspaceId: identity.workspaceId,
    tabId: 'w1:t1',
    cwd: identity.cwd,
    foregroundCwd: identity.cwd,
    agent: null,
    agentStatus: 'idle',
    focused: false,
    revision: 4,
    ...overrides,
  };
}
function processInfo(
  overrides: Partial<BootstrapProcessSnapshot> = {},
): BootstrapProcessSnapshot {
  return {
    paneId: identity.paneId,
    shellPid: 41,
    foregroundProcessGroupId: 41,
    tty: 'pts/2',
    foregroundProcesses: [{ pid: 41, name: '/bin/zsh' }],
    ...overrides,
  };
}
function opsFor(
  options: {
    readonly panes?: readonly BootstrapPaneSnapshot[];
    readonly processes?: readonly BootstrapProcessSnapshot[];
    readonly onPaneGet?: () => void;
    readonly onProcessInfo?: () => void;
  } = {},
): HerdrBootstrapOps {
  let paneIndex = 0;
  let processIndex = 0;
  return {
    id: 'test-herdr',
    transport: {} as HerdrBootstrapOps['transport'],
    verifyCaller: async () => ({
      ok: false,
      status: 'unavailable',
      code: 'unused',
      detail: 'unused',
    }),
    listAgents: async () => ({ ok: true, agents: [] }),
    paneGet: async () => {
      options.onPaneGet?.();
      const values = options.panes ?? [pane()];
      const value = values[Math.min(paneIndex++, values.length - 1)]!;
      return ok('pane.get', value);
    },
    paneProcessInfo: async () => {
      options.onProcessInfo?.();
      const values = options.processes ?? [processInfo()];
      const value = values[Math.min(processIndex++, values.length - 1)]!;
      return ok('pane.process-info', value);
    },
    paneLayout: async () => {
      throw new Error('not used');
    },
    splitPane: async () => {
      throw new Error('not used');
    },
    startAgent: async () => {
      throw new Error('not used');
    },
    closePane: async () => {
      throw new Error('not used');
    },
  };
}

test('available shell requires the exact shell process group and final pane identity', async () => {
  const result = await verifyAvailableShell(opsFor(), identity, {
    clock: () => 1_000,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.evidence.attempts, 1);
  assert.equal(result.evidence.shell_name, 'zsh');
  assert.equal(result.evidence.pane_id, identity.paneId);
  assert.equal(result.evidence.terminal_id, identity.terminalId);
});

test('transient foreground activity is polled locally until the shell predicate passes', async () => {
  let clock = 1_000;
  let processCalls = 0;
  const ops = opsFor({
    processes: [
      processInfo({
        foregroundProcessGroupId: 77,
        foregroundProcesses: [{ pid: 77, name: 'git' }],
      }),
      processInfo(),
    ],
    onProcessInfo: () => {
      processCalls += 1;
    },
  });
  const result = await verifyAvailableShell(ops, identity, {
    clock: () => clock,
    sleeper: async (milliseconds) => {
      clock += milliseconds;
    },
    intervalMs: 100,
    maxSamples: 3,
  });
  assert.equal(result.status, 'ready');
  assert.equal(processCalls, 2);
  assert.equal(result.evidence.samples[0]?.code, 'foreground_group_not_shell');
  assert.equal(result.evidence.samples[1]?.state, 'ready');
});

test('sample limit is a timeout and does not fabricate readiness', async () => {
  let clock = 2_000;
  const result = await verifyAvailableShell(
    opsFor({
      processes: [
        processInfo({
          foregroundProcessGroupId: 9,
          foregroundProcesses: [{ pid: 9, name: 'git' }],
        }),
      ],
    }),
    identity,
    {
      budgetMs: 10_000,
      intervalMs: 100,
      maxSamples: 2,
      clock: () => clock,
      sleeper: async (milliseconds) => {
        clock += milliseconds;
      },
    },
  );
  assert.equal(result.status, 'timeout');
  assert.equal(result.code, 'sample_limit_reached');
  assert.equal(result.evidence.attempts, 2);
  assert.equal(result.evidence.samples.length, 2);
  assert.equal(result.evidence.last_state, 'not_ready');
});

test('an awaited process-info result arriving after the shared deadline is rejected', async () => {
  let clock = 0;
  const result = await verifyAvailableShell(
    opsFor({
      onProcessInfo: () => {
        clock = 11;
      },
    }),
    identity,
    {
      budgetMs: 10,
      intervalMs: 1,
      maxSamples: 10,
      clock: () => clock,
    },
  );
  assert.equal(result.status, 'timeout');
  assert.equal(result.code, 'deadline_after_process_info');
  assert.equal(result.evidence.attempts, 1);
  assert.equal(result.evidence.samples.length, 0);
});

test('readiness fails closed on pane, workspace, terminal, cwd and agent drift', async () => {
  const cases: readonly [string, Partial<BootstrapPaneSnapshot>][] = [
    ['pane_id_mismatch', { paneId: 'w2:p9' }],
    ['workspace_id_mismatch', { workspaceId: 'w2' }],
    ['terminal_id_mismatch', { terminalId: 'terminal-other' }],
    ['pane_cwd_mismatch', { cwd: '/workspace/other' }],
    ['existing_agent', { agent: 'pi' }],
  ];
  for (const [code, drift] of cases) {
    const result = await verifyAvailableShell(
      opsFor({ panes: [pane(drift)] }),
      identity,
      { clock: () => 1_000 },
    );
    assert.equal(result.status, 'failed', code);
    assert.equal(result.code, code);
    assert.equal(result.evidence.attempts, 0);
  }
});

test('final identity reconciliation detects a replaced pane after a ready sample', async () => {
  const result = await verifyAvailableShell(
    opsFor({
      panes: [pane(), pane({ terminalId: 'replacement-terminal' })],
    }),
    identity,
    { clock: () => 1_000 },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'terminal_id_mismatch');
  assert.equal(result.evidence.samples[0]?.state, 'ready');
});

test('abort during the local wait stops before another process-info sample', async () => {
  let aborted = false;
  let processCalls = 0;
  const result = await verifyAvailableShell(
    opsFor({
      processes: [
        processInfo({
          foregroundProcessGroupId: 9,
          foregroundProcesses: [{ pid: 9, name: 'git' }],
        }),
      ],
      onProcessInfo: () => {
        processCalls += 1;
      },
    }),
    identity,
    {
      clock: () => 1_000,
      sleeper: async () => {
        aborted = true;
      },
      shouldAbort: () => aborted,
    },
  );
  assert.equal(result.status, 'aborted');
  assert.equal(result.code, 'abort_requested');
  assert.equal(processCalls, 1);
});

test('captured evidence contains sanitized process facts only', async () => {
  const result = await verifyAvailableShell(
    opsFor({
      processes: [
        processInfo({ foregroundProcesses: [{ pid: 41, name: '/bin/zsh' }] }),
      ],
    }),
    identity,
    { clock: () => 1_000 },
  );
  const text = JSON.stringify(result.evidence);
  assert.match(text, /"shell_name":"zsh"/);
  assert.doesNotMatch(text, /argv|cmdline|environment|stdout|stderr/i);
});
