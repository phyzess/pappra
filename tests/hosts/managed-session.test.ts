import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  openSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import test from 'node:test';
import {
  ManagedPiJournal,
  ManagedPiSessionError,
  buildManagedPiArgv,
  forwardJournaledManagedInput,
  isOwnedManagedPiExit,
  managedPiPtyBridgeSourceForTests,
  requestManagedPiControl,
  validateManagedPiArchiveEvidence,
} from '../../src/hosts/pi/managed-session.js';

import managedPiSessionExtension from '../../src/hosts/pi/managed-session-extension.js';

function tempDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'pappra-managed-pi-'));
}

test('managed extension publishes the native settled session receipt', () => {
  const directory = tempDirectory();
  const metadataPath = path.join(directory, 'session.pi-events.jsonl');
  const previousMetadataPath = process.env['PAPPRA_MANAGED_PI_METADATA_FILE'];
  process.env['PAPPRA_MANAGED_PI_METADATA_FILE'] = metadataPath;
  const handlers: Record<string, (event: unknown, context: unknown) => void> =
    {};
  try {
    managedPiSessionExtension({
      on: (event: string, handler: unknown) => {
        handlers[event] = handler as (event: unknown, context: unknown) => void;
      },
    } as never);
    handlers['agent_settled']?.(null, {
      cwd: '/repo/project',
      sessionManager: {
        getSessionId: () => 'session-settled',
        getSessionFile: () => '/sessions/session-settled.jsonl',
      },
    });

    const [record] = readJournal(metadataPath);
    assert.deepEqual(
      Object.keys(record).sort(),
      ['at', 'cwd', 'schema', 'session_file', 'session_id', 'type'].sort(),
    );
    assert.equal(record['schema'], 'harness-collab/pi-managed-session/1');
    assert.equal(record['type'], 'agent_settled');
    assert.equal(record['session_id'], 'session-settled');
    assert.equal(record['cwd'], '/repo/project');
    assert.equal(record['session_file'], '/sessions/session-settled.jsonl');
    assert.equal(typeof record['at'], 'string');
    assert.ok(Number.isFinite(Date.parse(String(record['at']))));
  } finally {
    if (previousMetadataPath === undefined)
      delete process.env['PAPPRA_MANAGED_PI_METADATA_FILE'];
    else process.env['PAPPRA_MANAGED_PI_METADATA_FILE'] = previousMetadataPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

function readJournal(file: string) {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

class JsonLineReader {
  private buffer = '';
  private readonly lines: Record<string, unknown>[] = [];
  private readonly waiters: Array<{
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(stream: Readable) {
    stream.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.deliver(JSON.parse(line) as Record<string, unknown>);
        newline = this.buffer.indexOf('\n');
      }
    });
    stream.on('end', () => this.fail(new Error('bridge status stream ended')));
    stream.on('error', (error) => this.fail(error));
  }

  next(timeoutMs = 8_000): Promise<Record<string, unknown>> {
    const queued = this.lines.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('timed out waiting for PTY bridge record'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private deliver(value: Record<string, unknown>) {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.lines.push(value);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  private fail(error: Error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function waitForOutput(
  child: ChildProcess,
  contains: string,
  getOutput: () => string,
  timeoutMs = 8_000,
) {
  if (getOutput().includes(contains)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.stdout?.removeListener('data', onData);
      reject(new Error(`timed out waiting for PTY output ${contains}`));
    }, timeoutMs);
    const onData = () => {
      if (!getOutput().includes(contains)) return;
      clearTimeout(timer);
      child.stdout?.removeListener('data', onData);
      resolve();
    };
    child.stdout?.on('data', onData);
  });
}

test('managed Pi argv explicitly selects OpenRouter without replacing native defaults', () => {
  const args = buildManagedPiArgv({
    model: 'openai/gpt-6-luna',
    sessionId: '11111111-2222-4333-8444-555555555555',
    extensionPath: '/repo/src/hosts/pi/managed-session-extension.ts',
  });
  assert.deepEqual(args, [
    '--provider',
    'openrouter',
    '--model',
    'openai/gpt-6-luna',
    '--session-id',
    '11111111-2222-4333-8444-555555555555',
    '--extension',
    '/repo/src/hosts/pi/managed-session-extension.ts',
  ]);
  for (const disabled of [
    '--no-session',
    '--no-extensions',
    '--no-mcp',
    '--no-skills',
    '--no-tools',
  ])
    assert.equal(args.includes(disabled), false);
});

test('managed ingress is fsynced before forwarding and is fenced fail-closed', () => {
  const directory = tempDirectory();
  const journalPath = path.join(directory, 'ingress.jsonl');
  const fd = openSync(journalPath, 'wx', 0o600);
  const journal = new ManagedPiJournal(journalPath, fd, 'run-managed-test');
  try {
    const input = Buffer.from([0x1b, 0x5b, 0x41, 0x0a]);
    let forwarded: Buffer | null = null;
    const forwardedOk = forwardJournaledManagedInput(
      journal,
      input,
      (bytes) => {
        const records = readJournal(journalPath);
        assert.equal(records.at(-1)?.kind, 'terminal_input');
        assert.equal(records.at(-1)?.bytes, input.toString('base64'));
        forwarded = Buffer.from(bytes);
      },
    );
    assert.equal(forwardedOk, true);
    assert.deepEqual(forwarded, input);

    journal.fence('test_fence');
    let sentAfterFence = false;
    assert.equal(
      forwardJournaledManagedInput(journal, input, () => {
        sentAfterFence = true;
      }),
      false,
    );
    assert.equal(sentAfterFence, false);
    assert.equal(readJournal(journalPath).at(-1)?.kind, 'ingress_fenced');
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a journal write failure fences without forwarding terminal input', () => {
  const directory = tempDirectory();
  const journalPath = path.join(directory, 'ingress.jsonl');
  const journal = new ManagedPiJournal(
    journalPath,
    openSync(journalPath, 'wx', 0o600),
    'run-write-failure',
  );
  journal.close();
  let forwarded = false;
  try {
    assert.equal(
      forwardJournaledManagedInput(
        journal,
        Buffer.from('must-not-send'),
        () => {
          forwarded = true;
        },
      ),
      false,
    );
    assert.equal(forwarded, false);
    assert.equal(journal.fenced, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('owned Pi exit requires matching run, helper, and Pi process identity', () => {
  const identity = { runId: 'run-a', helperPid: 100, piPid: 101 };
  assert.equal(
    isOwnedManagedPiExit({ ...identity, exitCode: 0, signal: null }, identity),
    true,
  );
  assert.equal(
    isOwnedManagedPiExit(
      { ...identity, piPid: 102, exitCode: 0, signal: null },
      identity,
    ),
    false,
  );
  assert.equal(
    isOwnedManagedPiExit(
      { ...identity, helperPid: 99, exitCode: 0, signal: null },
      identity,
    ),
    false,
  );
});

test('transcript archival waits for exact source exit, receiver confirmation, then first work', () => {
  const transcript = {
    status: 'verified' as const,
    path: '/sessions/source.jsonl',
    sessionId: 'source-session',
    cwd: '/repo',
    sha256: 'a'.repeat(64),
    bytes: 10,
    detail: null,
  };
  const receiverConfirmation = {
    receiverSessionId: 'receiver-session',
    confirmationId: 'ack-1',
    confirmedAt: '2026-10-23T12:00:00.000Z',
  };
  const firstWork = {
    receiverSessionId: 'receiver-session',
    workId: 'work-1',
    observedAt: '2026-10-23T12:01:00.000Z',
  };
  assert.equal(
    validateManagedPiArchiveEvidence({
      sourceExited: false,
      transcript,
      receiverConfirmation,
      firstWork,
    }),
    'source_child_not_confirmed_exited',
  );
  assert.equal(
    validateManagedPiArchiveEvidence({
      sourceExited: true,
      transcript,
      receiverConfirmation: { ...receiverConfirmation, confirmationId: '' },
      firstWork,
    }),
    'receiver_confirmation_missing',
  );
  assert.equal(
    validateManagedPiArchiveEvidence({
      sourceExited: true,
      transcript,
      receiverConfirmation,
      firstWork: { ...firstWork, observedAt: '2026-10-23T11:59:00.000Z' },
    }),
    'first_work_precedes_receiver_confirmation',
  );
  assert.equal(
    validateManagedPiArchiveEvidence({
      sourceExited: true,
      transcript,
      receiverConfirmation,
      firstWork,
    }),
    null,
  );
});

test(
  'real stdlib PTY bridge reports exact child identity, TTY input, and owned signal exit',
  { timeout: 15_000 },
  async (t) => {
    const directory = tempDirectory();
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const fakePi = path.join(directory, 'fake-pi.py');
    writeFileSync(
      fakePi,
      [
        'import os, signal, sys',
        'print("TTY=" + str(os.isatty(0)), flush=True)',
        'line = sys.stdin.readline().strip()',
        'print("INPUT=" + line, flush=True)',
        'signal.pause()',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    const pythonBin = 'python3';
    const runId = 'managed-pty-regression';
    const child = spawn(
      pythonBin,
      ['-u', '-c', managedPiPtyBridgeSourceForTests, runId, pythonBin, fakePi],
      {
        cwd: directory,
        env: {
          ...process.env,
          PAPPRA_MANAGED_PI_ROWS: '24',
          PAPPRA_MANAGED_PI_COLUMNS: '80',
        },
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const status = new JsonLineReader(child.stdio[3] as Readable);
    const control = child.stdio[4] as Writable;
    const started = await status.next();
    assert.equal(started['kind'], 'pi_started');
    assert.equal(started['runId'], runId);
    assert.equal(started['helperPid'], child.pid);
    assert.equal(typeof started['piPid'], 'number');
    assert.notEqual(started['piPid'], child.pid);

    child.stdin?.write('go\n');
    await waitForOutput(child, 'INPUT=go', () => output);
    control.write(`${JSON.stringify({ command: 'signal', signal: 'TERM' })}\n`);
    const exited = await status.next();
    assert.equal(exited['kind'], 'pi_exit');
    assert.equal(exited['runId'], runId);
    assert.equal(exited['helperPid'], child.pid);
    assert.equal(exited['piPid'], started['piPid']);
    assert.equal(exited['signal'], 'SIGTERM');
    assert.match(output, /TTY=True/);
    assert.match(output, /INPUT=go/);
    await once(child, 'close');
    assert.equal(child.exitCode, 0);
  },
);

test(
  'private control client sends one request and rejects truncated socket responses',
  { timeout: 10_000 },
  async (t) => {
    const directory = tempDirectory();
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const socketPath = path.join(directory, 'control.sock');
    const descriptorPath = path.join(directory, 'session.control.json');
    const token = 'c'.repeat(64);
    const descriptor = {
      schema: 'harness-collab/pi-managed-control/1',
      socketPath,
      token,
      runId: 'run-control-test',
      sessionId: 'session-control-test',
    };
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`, {
      mode: 0o600,
    });
    let calls = 0;
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        calls += 1;
        const request = JSON.parse(chunk.toString('utf8')) as {
          command?: string;
          token?: string;
        };
        assert.equal(request.command, 'snapshot');
        assert.equal(request.token, token);
        socket.end(`${JSON.stringify({ ok: true })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    chmodSync(socketPath, 0o600);
    t.after(() => server.close());

    assert.deepEqual(
      await requestManagedPiControl(descriptorPath, 'snapshot'),
      { ok: true },
    );
    assert.equal(calls, 1);

    const brokenSocketPath = path.join(directory, 'broken.sock');
    const brokenDescriptorPath = path.join(directory, 'broken.control.json');
    const brokenServer = net.createServer((socket) => {
      socket.once('data', () => socket.end('{"partial":'));
    });
    await new Promise<void>((resolve) =>
      brokenServer.listen(brokenSocketPath, resolve),
    );
    chmodSync(brokenSocketPath, 0o600);
    t.after(() => brokenServer.close());
    writeFileSync(
      brokenDescriptorPath,
      `${JSON.stringify({ ...descriptor, socketPath: brokenSocketPath })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      requestManagedPiControl(brokenDescriptorPath, 'stop'),
      (error: unknown) =>
        error instanceof ManagedPiSessionError &&
        error.code === 'control_response_incomplete',
    );
  },
);

test(
  'a missing native waitpid receipt cannot become a successful Pi exit',
  { timeout: 10_000 },
  async (t) => {
    // SIGCHLD=SIG_IGN makes the OS auto-reap the child, so waitpid cannot
    // supply the authenticated exit status on which this controller relies.
    const source = managedPiPtyBridgeSourceForTests.replace(
      'import termios\n',
      'import termios\nsignal.signal(signal.SIGCHLD, signal.SIG_IGN)\n',
    );
    const child = spawn(
      'python3',
      ['-u', '-c', source, 'missing-wait-receipt', 'python3', '-c', 'pass'],
      { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
    });
    const closed = once(child, 'close');
    let records = '';
    (child.stdio[3] as Readable).on('data', (chunk: Buffer) => {
      records += chunk.toString('utf8');
    });
    child.stdout?.resume();
    child.stderr?.resume();
    await closed;
    assert.equal(child.exitCode, 70);
    const events = records
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string });
    assert.ok(events.some((event) => event.kind === 'pi_started'));
    assert.ok(!events.some((event) => event.kind === 'pi_exit'));
  },
);

test('malformed private control descriptors fail generically without echoing bearer material', async (t) => {
  const directory = tempDirectory();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const descriptorPath = path.join(directory, 'malformed.control.json');
  const secret = 'bearer-secret-that-must-not-leak';
  writeFileSync(descriptorPath, `{"token":"${secret}"`, { mode: 0o600 });
  await assert.rejects(
    requestManagedPiControl(descriptorPath, 'snapshot'),
    (error: unknown) =>
      error instanceof ManagedPiSessionError &&
      error.code === 'control_descriptor_invalid' &&
      !error.message.includes(secret),
  );
});
