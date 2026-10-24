import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptedManagedSdkStartReceipt,
  createHerdrBootstrapOps,
  managedSdkStartArgs,
  type BootstrapManagedSdkStartInput,
} from '../../src/app/collab-bootstrap-transport.js';
import type {
  CommandResult,
  HerdrAgentObservation,
  CommandRunner,
  HerdrListResult,
  HerdrPromptResult,
  HerdrTransport,
} from '../../src/app/collab-notify.js';
import { getPackageRoot } from '../../src/package-info.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

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
function fakeTransport(
  agents: readonly HerdrAgentObservation[] = [],
): HerdrTransport {
  return {
    id: 'fake-herdr',
    verifyCaller: async () => ({
      ok: false,
      status: 'unverified',
      code: 'unused',
      detail: 'unused',
    }),
    list: async (): Promise<HerdrListResult> => ({ ok: true, agents }),
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
    '180000',
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

test('explicit OpenRouter selection is passed as native argv and invalid selectors launch nothing', async () => {
  const calls: (readonly string[])[] = [];
  const ops = makeOps(async (_command, args) => {
    calls.push(args);
    return commandResult(
      envelope('agent_started', {
        agent: {
          ...basePane,
          agent: 'pi',
          name: 'pappra-test',
          agent_session: { kind: 'id', value: sessionId },
          interactive_ready: true,
        },
        argv: ['pi', ...args.slice(args.indexOf('--') + 1)],
      }),
    );
  });
  const input = {
    name: 'pappra-test',
    paneId: 'w1:p2',
    sessionId,
    extensionEntry,
    openrouterModel: 'openai/gpt-6-luna',
  };
  const selected = await ops.startAgent(input);
  assert.equal(selected.ok, true);
  assert.deepEqual(calls[0]?.slice(-4), [
    '--provider',
    'openrouter',
    '--model',
    'openai/gpt-6-luna',
  ]);
  for (const model of [
    '--no-tools',
    'model\n--approve',
    'model with spaces',
    '',
  ]) {
    const refused = await ops.startAgent({ ...input, openrouterModel: model });
    assert.equal(refused.ok, false);
  }
  assert.equal(calls.length, 1);
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

function managedStartFixture(): {
  readonly root: string;
  readonly input: BootstrapManagedSdkStartInput;
  cleanup(): void;
} {
  const root = fs.realpathSync(makeTempDir('managed-sdk-bootstrap-transport'));
  const configPath = path.join(root, "managed config ' $ `tick`.json");
  const inputFields = {
    name: 'pappra-managed',
    paneId: 'w1:p2',
    workspaceId: 'w1',
    terminalId: 'terminal-2',
    cwd: root,
    sessionId,
    openrouterModel: 'openai/gpt-6-luna',
    sdkModulePath: path.join(root, 'pi sdk entry.mjs'),
    journalPath: path.join(root, 'sdk journal.jsonl'),
    controlSocketPath: path.join(
      '/tmp',
      `.pappra-sdk-${createHash('sha256').update(root).digest('hex').slice(0, 12)}.sock`,
    ),
    bootstrapExtensionPath: path.join(root, 'pappra-bootstrap', 'index.ts'),
    automaticHandoffFile: path.join(root, 'future handoff.json'),
    handoffContextFile: path.join(root, 'handoff context.json'),
    configPath,
  };
  const config = {
    schema: 'pappra/managed-pi-session-request/1',
    cwd: inputFields.cwd,
    model: inputFields.openrouterModel,
    journalPath: inputFields.journalPath,
    controlSocketPath: inputFields.controlSocketPath,
    runtime: 'sdk',
    sdkModulePath: inputFields.sdkModulePath,
    sessionId: inputFields.sessionId,
    bootstrapExtensionPath: inputFields.bootstrapExtensionPath,
    herdrAgentName: inputFields.name,
    herdrPaneId: inputFields.paneId,
    automaticHandoffFile: inputFields.automaticHandoffFile,
    handoffContextFile: inputFields.handoffContextFile,
  };
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(configPath, bytes, { mode: 0o400 });
  const configDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return {
    root,
    input: { ...inputFields, configDigest, timeoutMs: 20 },
    cleanup: () => cleanup(root),
  };
}

function managedControlStatus(
  input: BootstrapManagedSdkStartInput,
  pid: number,
) {
  return JSON.stringify({
    ok: true,
    snapshot: {
      schema: 'harness-collab/pi-managed-sdk-session/1',
      process: { pid, exit: 'not_owned' },
      session: { sessionId: input.sessionId },
      ingress: { journalPath: input.journalPath },
    },
    automation: {
      launch: {
        runtime: 'sdk',
        sdk_module_path: input.sdkModulePath,
        bootstrap_extension_path: input.bootstrapExtensionPath,
        herdr_agent_name: input.name,
        journal_path: input.journalPath,
        session_id: input.sessionId,
        cwd: input.cwd,
        model: { provider: 'openrouter', id: input.openrouterModel },
        ready: true,
      },
    },
  });
}

function managedHerdrAgent(
  input: BootstrapManagedSdkStartInput,
): HerdrAgentObservation {
  return {
    name: input.name,
    harness: 'pi',
    paneId: input.paneId,
    cwd: input.cwd,
    sessionValue: null,
    sessionKind: null,
    status: 'working',
    focused: false,
  };
}

test('managed SDK pane-run command is fixed and Nushell-safe for special path characters', () => {
  const configPath = "/private/tmp/managed path ' $cash `tick`/sdk config.json";
  const args = managedSdkStartArgs({ paneId: 'w1:p2', configPath });
  assert.deepEqual(args.slice(0, 3), ['pane', 'run', 'w1:p2']);
  const command = args[3];
  assert.equal(
    command,
    `^'${process.execPath}' '${path.join(getPackageRoot(), 'dist', 'cli', 'main.js')}' session start --config '${configPath.replaceAll("'", "''")}'`,
  );
});

for (const queueFormat of ['typed', 'empty'] as const) {
  test(`managed SDK startup requires owned evidence after ${queueFormat} queue acknowledgement`, async () => {
    const value = managedStartFixture();
    try {
      const calls: { command: string; args: readonly string[] }[] = [];
      const pid = 77;
      const pane = {
        ...basePane,
        cwd: value.root,
        foreground_cwd: value.root,
        agent: 'pi',
        agent_status: 'working',
      };
      const run: CommandRunner = async (command, args) => {
        calls.push({ command, args });
        if (args[0] === 'pane' && args[1] === 'run')
          return commandResult(
            queueFormat === 'empty'
              ? ''
              : envelope('pane_run', { pane_id: value.input.paneId }),
          );
        if (args[0] === 'pane' && args[1] === 'get')
          return commandResult(envelope('pane_info', { pane }));
        if (args[0] === 'pane' && args[1] === 'process-info')
          return commandResult(
            envelope('pane_process_info', {
              process_info: {
                pane_id: value.input.paneId,
                shell_pid: 41,
                foreground_process_group_id: pid,
                tty: 'pts/2',
                foreground_processes: [{ pid, name: 'node' }],
              },
            }),
          );
        if (command === process.execPath) {
          assert.deepEqual(args, [
            path.join(getPackageRoot(), 'dist', 'cli', 'main.js'),
            'session',
            'status',
            '--config',
            value.input.configPath,
            '--json',
          ]);
          return commandResult(managedControlStatus(value.input, pid));
        }
        return commandResult('');
      };
      const ops = createHerdrBootstrapOps({
        env: { HERDR_BIN_PATH: 'herdr-test' },
        run,
        transport: fakeTransport([
          {
            ...managedHerdrAgent(value.input),
            status: queueFormat === 'empty' ? 'done' : 'working',
          },
        ]),
        peerPid: (socketPath) => {
          assert.equal(socketPath, value.input.controlSocketPath);
          return pid;
        },
      });
      const started = await ops.startManagedSdk!(value.input);
      assert.equal(started.ok, true, JSON.stringify(started));
      if (!started.ok) return;
      assert.equal(started.value.identityProvenance, 'owned-pi-sdk-control');
      assert.equal(started.value.sessionId, sessionId);
      assert.equal(started.value.launch.model.id, 'openai/gpt-6-luna');
      assert.equal(
        started.value.launch.bootstrapExtensionPath,
        value.input.bootstrapExtensionPath,
      );
      assert.equal(Object.hasOwn(started.value, 'sessionValue'), false);
      assert.equal(
        acceptedManagedSdkStartReceipt(started.receipt, {
          paneId: value.input.paneId,
          configPath: value.input.configPath,
        }),
        true,
      );
      assert.equal(
        calls.filter(
          (call) => call.args[0] === 'pane' && call.args[1] === 'run',
        ).length,
        1,
      );
      assert.ok(
        calls.some(
          (call) => call.args[0] === 'pane' && call.args[1] === 'process-info',
        ),
      );
    } finally {
      value.cleanup();
    }
  });
}

test('managed SDK startup returns unknown for a foreign foreground process and never requeues', async () => {
  const value = managedStartFixture();
  try {
    let runCount = 0;
    const calls: string[][] = [];
    const pid = 77;
    const run: CommandRunner = async (_command, args) => {
      runCount += 1;
      calls.push([...args]);
      if (args[0] === 'pane' && args[1] === 'run')
        return commandResult(
          envelope('pane_run', { pane_id: value.input.paneId }),
        );
      if (args[0] === 'pane' && args[1] === 'get')
        return commandResult(
          envelope('pane_info', {
            pane: {
              ...basePane,
              pane_id: value.input.paneId,
              workspace_id: value.input.workspaceId,
              terminal_id: value.input.terminalId,
              cwd: value.root,
              foreground_cwd: value.root,
              agent: 'pi',
              agent_status: 'working',
            },
          }),
        );
      if (args[0] === 'pane' && args[1] === 'process-info')
        return commandResult(
          envelope('pane_process_info', {
            process_info: {
              pane_id: value.input.paneId,
              shell_pid: 41,
              foreground_process_group_id: 88,
              tty: 'pts/2',
              foreground_processes: [{ pid: 88, name: 'foreign' }],
            },
          }),
        );
      if (_command === process.execPath)
        return commandResult(managedControlStatus(value.input, pid));
      return commandResult('');
    };
    const ops = createHerdrBootstrapOps({
      env: { HERDR_BIN_PATH: 'herdr-test' },
      run,
      transport: fakeTransport([managedHerdrAgent(value.input)]),
      peerPid: () => pid,
    });
    const started = await ops.startManagedSdk!({
      ...value.input,
      timeoutMs: 1,
    });
    assert.equal(started.ok, false);
    assert.equal(started.ok ? null : started.status, 'unknown');
    assert.equal(
      started.ok ? null : started.code,
      'managed_sdk_start_observation_timeout',
      JSON.stringify(started),
    );
    assert.equal(runCount, 4, JSON.stringify(calls));
  } finally {
    value.cleanup();
  }
});
