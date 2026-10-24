import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { initTask, readRecord } from '../../src/collab/store.js';
import type {
  Coordinator,
  Identity,
  MessageInput,
} from '../../src/collab/types.js';
import { WORK_PLAN_SCHEMA } from '../../src/collab/work-plan.js';
import { inspectRecoveryProjection } from '../../src/app/collab-recovery-projection.js';
import type { RecoveryExecutionRequest } from '../../src/app/collab-recovery-executor.js';

const TASK = 'sample';
const INPUT = `sha256:${'1'.repeat(64)}`;
const OWNER: Coordinator = {
  agent_id: 'coordinator',
  session_id: 'coord-session',
  harness: 'pi',
  owner_epoch: 1,
  since: '2026-10-20T00:00:00Z',
};
const COORDINATOR: Identity = OWNER;
const WRITER: Identity = {
  agent_id: 'writer-a',
  session_id: 'writer-a-session',
  harness: 'pi',
};
const WORKER = fileURLToPath(
  new URL('./recovery-network-worker.js', import.meta.url),
);

type Dispatch = {
  readonly kind: string;
  readonly is_recovery_wake: boolean;
  readonly task_id: string | null;
  readonly action_key: string;
  readonly attempt: number;
};

interface Flow {
  readonly root: string;
  readonly task: string;
  readonly planFile: string;
  readonly request: RecoveryExecutionRequest;
  cleanup(): void;
}

function makeFlow(label: string): Flow {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `pappra-${label}-`)));
  const domainRoot = join(root, 'domain');
  mkdirSync(domainRoot, { recursive: true });
  const task = join(domainRoot, 'tasks', TASK);
  let clock = Date.parse('2026-10-20T00:00:00Z');
  initTask(task, { taskId: TASK, domainRoot, coordinator: OWNER, clock });
  const send = (input: MessageInput): void => {
    const message = buildMessage(input, { clock: (clock += 1000) });
    const outcome = submitMessage(task, message, { clock: (clock += 1000) });
    assert.equal(
      outcome.ok,
      true,
      `submit ${input.type}: ${JSON.stringify(outcome)}`,
    );
  };
  send({
    message_id: 'msg-assign-work-1',
    type: 'ASSIGN',
    task_id: TASK,
    from: COORDINATOR,
    to: WRITER,
    subtask_id: 'work',
    attempt: 1,
    owner_epoch: 1,
    body: {
      assignment_digest: `sha256:${'a'.repeat(64)}`,
      input_revision: INPUT,
    },
  });

  const planFile = join(root, 'plan.json');
  writeFileSync(
    planFile,
    `${JSON.stringify(
      {
        schema: WORK_PLAN_SCHEMA,
        plan_id: 'plan-network-restart',
        task_id: TASK,
        owner_epoch: 1,
        nodes: [
          {
            node_id: 'work',
            role: 'writer',
            assignment_id: 'work',
            attempt: 1,
            input_revision: INPUT,
            assignee: {
              agent_id: WRITER.agent_id,
              session_id: WRITER.session_id,
            },
            depends_on: [],
            resources: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const bindingFile = join(task, 'recovery-binding.json');
  const bindingText = `${JSON.stringify(
    {
      schema: 'pappra/collab-binding/1',
      task_id: TASK,
      task_root: task,
      channel: 'herdr',
      participants: [
        {
          agent_id: WRITER.agent_id,
          harness: 'pi',
          cwd: '/work',
          herdr_agent: 'writer-a',
          pane_id: 'w3:p4',
          native_session_id: WRITER.session_id,
        },
        {
          agent_id: COORDINATOR.agent_id,
          harness: 'pi',
          cwd: '/work',
          herdr_agent: 'coordinator',
          pane_id: 'w3:p1',
          native_session_id: COORDINATOR.session_id,
        },
      ],
    },
    null,
    2,
  )}\n`;
  writeFileSync(bindingFile, bindingText);
  const bindingDigest = `sha256:${createHash('sha256')
    .update(bindingText)
    .digest('hex')}`;
  return {
    root,
    task,
    planFile,
    request: {
      taskRoot: task,
      planFile,
      self: WRITER,
      policy: { role: 'writer' },
      requestId: 'network-restart-request',
      expectedSession: {
        session_id: WRITER.session_id,
        cwd: '/work',
        binding_digest: bindingDigest,
        binding_ref: bindingFile,
        target_agent: 'writer-a',
        pane_id: 'w3:p4',
        harness: 'pi',
      },
      mode: 'apply',
      maxRetries: 1,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

interface WorkerEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface WorkerHandle {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly exit: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  waitFor(type: string, timeoutMs?: number): Promise<WorkerEvent>;
  send(message: WorkerEvent): void;
}

function startWorker(
  request: RecoveryExecutionRequest,
  mode: 'crash-after-disconnect' | 'execute' | 'safe-retry',
  port: number,
): WorkerHandle {
  const child = fork(WORKER, [JSON.stringify({ mode, port, request })], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const messages: WorkerEvent[] = [];
  const waiters = new Map<string, Array<(message: WorkerEvent) => void>>();
  child.on('message', (value: unknown) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as Record<string, unknown>).type !== 'string'
    )
      return;
    const message = value as WorkerEvent;
    const waiting = waiters.get(message.type)?.shift();
    if (waiting) waiting(message);
    else messages.push(message);
  });
  const exit = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    pid: child.pid!,
    exit,
    waitFor(type, timeoutMs = 8_000) {
      const index = messages.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]!);
      const fatalIndex = messages.findIndex(
        (message) => message.type === 'fatal',
      );
      if (fatalIndex >= 0)
        return Promise.reject(
          new Error(
            `worker failed: ${JSON.stringify(messages.splice(fatalIndex, 1)[0])}`,
          ),
        );
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const listeners = waiters.get(type) ?? [];
          waiters.set(
            type,
            listeners.filter((listener) => listener !== onMessage),
          );
          reject(new Error(`timed out waiting for worker event ${type}`));
        }, timeoutMs);
        const onMessage = (message: WorkerEvent): void => {
          clearTimeout(timer);
          if (message.type === 'fatal')
            reject(new Error(`worker failed: ${JSON.stringify(message)}`));
          else resolve(message);
        };
        const listeners = waiters.get(type) ?? [];
        listeners.push(onMessage);
        waiters.set(type, listeners);
      });
    },
    send(message) {
      assert.equal(child.connected, true, 'worker IPC channel is connected');
      child.send(message);
    },
  };
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

interface RecordingServer {
  readonly server: Server;
  readonly port: number;
  readonly dispatches: Dispatch[];
  readonly firstDispatch: Promise<Dispatch>;
  close(): Promise<void>;
}

async function recordingServer(
  effectLog: string,
  behavior: 'disconnect-after-admission' | 'acknowledge-queued',
  port = 0,
): Promise<RecordingServer> {
  const dispatches: Dispatch[] = [];
  let resolveFirst!: (dispatch: Dispatch) => void;
  const firstDispatch = new Promise<Dispatch>((resolve) => {
    resolveFirst = resolve;
  });
  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      while (true) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length === 0) continue;
        const dispatch = JSON.parse(line) as Dispatch;
        appendFileSync(effectLog, `${JSON.stringify(dispatch)}\n`);
        dispatches.push(dispatch);
        if (dispatches.length === 1) resolveFirst(dispatch);
        if (behavior === 'disconnect-after-admission') socket.destroy();
        else socket.end(`${JSON.stringify({ status: 'queued' })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    port: address.port,
    dispatches,
    firstDispatch,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function effectLogFor(flow: Flow): string {
  const file = join(flow.root, 'controlled-loopback-effects.jsonl');
  writeFileSync(file, '');
  return file;
}

function readDispatchLog(file: string): Dispatch[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Dispatch);
}

test(
  'an admitted loopback dispatch followed by a socket disconnect stays unknown across process restart and is never replayed',
  { timeout: 30_000 },
  async () => {
    const flow = makeFlow('recovery-network-ambiguous');
    const effectLog = effectLogFor(flow);
    const service = await recordingServer(
      effectLog,
      'disconnect-after-admission',
    );
    try {
      const first = startWorker(
        flow.request,
        'crash-after-disconnect',
        service.port,
      );
      const admitted = await service.firstDispatch;
      await first.waitFor('post-dispatch-disconnect');
      const firstExit = await first.exit;
      assert.equal(
        firstExit.code,
        86,
        'first controller process stopped at disconnect',
      );
      assert.ok(first.pid > 0);

      const deliveredBeforeRestart = readDispatchLog(effectLog);
      assert.equal(deliveredBeforeRestart.length, 1);
      assert.equal(deliveredBeforeRestart[0]!.action_key, admitted.action_key);
      assert.equal(deliveredBeforeRestart[0]!.is_recovery_wake, true);

      const reservationDir = join(flow.task, '.recovery', 'reservations');
      const reservationFiles = readdirSync(reservationDir).filter((name) =>
        name.endsWith('.json'),
      );
      assert.equal(reservationFiles.length, 1);
      const reservationPath = join(reservationDir, reservationFiles[0]!);
      const interrupted = JSON.parse(readFileSync(reservationPath, 'utf8')) as {
        journal: Array<{
          intent_at: number;
          disposition: string | null;
          observation: string | null;
        }>;
        final?: unknown;
      };
      assert.equal(
        interrupted.journal.length,
        1,
        'dispatch intent was fsynced first',
      );
      assert.ok(interrupted.journal[0]!.intent_at > 0);
      assert.equal(interrupted.journal[0]!.disposition, null);
      assert.equal(interrupted.journal[0]!.observation, null);
      assert.equal(
        interrupted.final,
        undefined,
        'crash leaves an unresolved intent',
      );

      const restarted = startWorker(flow.request, 'execute', service.port);
      assert.notEqual(
        restarted.pid,
        first.pid,
        'recovery runs in a distinct process',
      );
      const outcome = await restarted.waitFor('result');
      const restartExit = await restarted.exit;
      assert.equal(restartExit.code, 0);
      assert.equal(outcome.status, 'unknown');
      assert.equal(
        outcome.controllerCalls,
        0,
        'unknown intent blocks controller dispatch',
      );
      assert.ok(
        (outcome.notes as string[]).some((note) =>
          note.includes('resolve via supported observation'),
        ),
        'the effect remains actionable for evidence-based reconciliation',
      );
      assert.equal(
        readDispatchLog(effectLog).length,
        1,
        'no duplicate delivery after restart',
      );
    } finally {
      await service.close();
      flow.cleanup();
    }
  },
);

test(
  'a refused loopback connection before connect is documented no-effect evidence and permits one bounded retry',
  { timeout: 30_000 },
  async () => {
    const flow = makeFlow('recovery-network-safe-retry');
    const effectLog = effectLogFor(flow);
    const port = await unusedLoopbackPort();
    let service: RecordingServer | null = null;
    try {
      const worker = startWorker(flow.request, 'safe-retry', port);
      const failure = await worker.waitFor('pre-dispatch-no-effect');
      assert.equal(failure.code, 'ECONNREFUSED');
      assert.equal(failure.bytesSent, false);
      await worker.waitFor('retry-waiting');

      service = await recordingServer(effectLog, 'acknowledge-queued', port);
      worker.send({ type: 'retry-proceed' });
      const admitted = await service.firstDispatch;
      const outcome = await worker.waitFor('result');
      const exit = await worker.exit;
      assert.equal(exit.code, 0);
      assert.equal(outcome.status, 'applied');
      assert.equal(outcome.retries, 1);
      assert.equal(outcome.controllerCalls, 2);
      assert.equal(
        admitted.attempt,
        2,
        'only the second connected attempt was delivered',
      );
      assert.equal(readDispatchLog(effectLog).length, 1);
    } finally {
      if (service) await service.close();
      flow.cleanup();
    }
  },
);

test(
  'an ordinary restart uses the public executor to wake known pending work without synthesizing acceptance',
  { timeout: 30_000 },
  async () => {
    const flow = makeFlow('recovery-network-ordinary-restart');
    const effectLog = effectLogFor(flow);
    const service = await recordingServer(effectLog, 'acknowledge-queued');
    try {
      const before = await inspectRecoveryProjection({
        taskRoot: flow.task,
        planFile: flow.planFile,
        self: WRITER,
        policy: { role: 'writer' },
      });
      assert.equal(before.ok, true, JSON.stringify(before));
      if (!before.ok) throw new Error('pending projection was unavailable');
      assert.ok(
        before.value.actions.some(
          (action) =>
            action.kind === 'resume_work' && action.status === 'pending',
        ),
        'fixture contains eligible known pending work before restart',
      );

      const restarted = startWorker(flow.request, 'execute', service.port);
      const admitted = await service.firstDispatch;
      const outcome = await restarted.waitFor('result');
      const exit = await restarted.exit;
      assert.equal(exit.code, 0);
      assert.equal(outcome.status, 'applied');
      assert.equal(outcome.controllerCalls, 1);
      assert.equal(admitted.kind, 'continue');
      assert.equal(admitted.is_recovery_wake, true);

      const record = readRecord(flow.task);
      assert.ok(record, 'task record remains readable');
      assert.equal(
        record.messages.some((message) => message.type === 'ANSWER'),
        false,
        'a queue acknowledgement does not synthesize coordinator acceptance',
      );
      const after = await inspectRecoveryProjection({
        taskRoot: flow.task,
        planFile: flow.planFile,
        self: WRITER,
        policy: { role: 'writer' },
      });
      assert.equal(after.ok, true, JSON.stringify(after));
      if (!after.ok) throw new Error('post-restart projection was unavailable');
      assert.ok(
        after.value.actions.some(
          (action) =>
            action.kind === 'resume_work' && action.status === 'pending',
        ),
        'the admitted recovery wake leaves completion/acceptance to later evidence',
      );
    } finally {
      await service.close();
      flow.cleanup();
    }
  },
);
