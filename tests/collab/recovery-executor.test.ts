import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { readRecord, transact } from '../../src/collab/store.js';
import { bindNative } from '../../src/collab/lifecycle.js';
import { WORK_PLAN_SCHEMA } from '../../src/collab/work-plan.js';
import { runCli } from '../../src/cli/run.js';
import type {
  Identity,
  Message,
  MessageInput,
} from '../../src/collab/types.js';
import {
  executeRecovery,
  type RecoveryController,
  type RecoveryControllerRequest,
  type RecoveryControllerResult,
  type RecoveryExecutionRequest,
} from '../../src/app/collab-recovery-executor.js';
import { makeTaskDomain } from './task-resources-fixtures.js';

const TASK = 'sample';
const PLAN_ID = 'plan-recovery';
const INPUT = `sha256:${'1'.repeat(64)}`;
const COORDINATOR: Identity = {
  agent_id: 'coordinator',
  session_id: 'coord-session',
  harness: 'pi',
};
const WRITER_A: Identity = {
  agent_id: 'writer-a',
  session_id: 'writer-a-session',
  harness: 'pi',
};

interface Flow {
  readonly root: string;
  readonly task: string;
  send(input: MessageInput): Message;
  planFile(value: unknown): string;
  cleanup(): void;
}

function makeFlow(label: string): Flow {
  const domain = makeTaskDomain(label, [TASK]);
  const task = domain.tasks[TASK]!;
  let clock = Date.parse('2026-10-20T00:00:00Z');
  const tick = (): number => (clock += 1000);
  return {
    root: domain.root,
    task,
    send: (input) => {
      const message = buildMessage(input, { clock: tick() });
      const outcome = submitMessage(task, message, { clock: tick() });
      assert.equal(outcome.ok, true, `submit ${input.type}`);
      return message;
    },
    planFile: (value) => {
      const file = join(domain.root, 'plan.json');
      writeFileSync(file, `${JSON.stringify(value)}\n`);
      return file;
    },
    cleanup: domain.cleanup,
  };
}

function node(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    node_id: 'work',
    role: 'writer',
    assignment_id: 'work',
    attempt: 1,
    input_revision: INPUT,
    assignee: { agent_id: WRITER_A.agent_id, session_id: WRITER_A.session_id },
    depends_on: [],
    resources: [],
    ...overrides,
  };
}
function planOf(nodes: Record<string, unknown>[]): unknown {
  return {
    schema: WORK_PLAN_SCHEMA,
    plan_id: PLAN_ID,
    task_id: TASK,
    owner_epoch: 1,
    nodes,
  };
}
function assign(flow: Flow): Message {
  return flow.send({
    message_id: 'msg-assign-work-1',
    type: 'ASSIGN',
    task_id: TASK,
    from: COORDINATOR,
    to: WRITER_A,
    subtask_id: 'work',
    attempt: 1,
    owner_epoch: 1,
    body: {
      assignment_digest: `sha256:${'a'.repeat(64)}`,
      input_revision: INPUT,
    },
  });
}
function report(flow: Flow): Message {
  return flow.send({
    message_id: 'msg-report-work-1',
    type: 'REPORT',
    task_id: TASK,
    from: WRITER_A,
    to: COORDINATOR,
    subtask_id: 'work',
    attempt: 1,
    body: { status: 'completed', input_revision: INPUT },
  });
}
function answer(flow: Flow): Message {
  flow.send({
    message_id: 'msg-ask-work-1',
    type: 'ASK',
    task_id: TASK,
    from: WRITER_A,
    to: COORDINATOR,
    subtask_id: 'work',
    attempt: 1,
    body: { question: 'May I continue?', input_revision: INPUT },
  });
  return flow.send({
    message_id: 'msg-answer-work-1',
    type: 'ANSWER',
    task_id: TASK,
    from: COORDINATOR,
    to: WRITER_A,
    reply_to: 'msg-ask-work-1',
    subtask_id: 'work',
    attempt: 1,
    owner_epoch: 1,
    body: { input_revision: INPUT, note: 'continue' },
  });
}
function cancel(flow: Flow): Message {
  return flow.send({
    message_id: 'msg-cancel-work-1',
    type: 'CANCEL',
    task_id: TASK,
    from: COORDINATOR,
    to: WRITER_A,
    subtask_id: 'work',
    attempt: 1,
    owner_epoch: 1,
    body: { reason: 'stop' },
  });
}
function bindWriterNative(flow: Flow, sessionId: string): void {
  const outcome = transact(flow.task, {
    actor: 'fixture',
    purpose: 'bind-native',
    apply: (record) => {
      const bound = bindNative(record, {
        subtaskId: 'work',
        attempt: 1,
        runner: 'pi',
        sessionId,
        observation: 'confirmed',
        evidenceRef: 'herdr:agent:fixture:settled',
        observedAt: '2026-10-20T00:30:00Z',
      });
      if (!bound.ok) return bound;
      return { record, op: 'bind-native', summary: {}, result: bound };
    },
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
}

interface Recorder {
  readonly controller: RecoveryController;
  readonly calls: RecoveryControllerRequest[];
}
function recorder(
  result: RecoveryControllerResult | RecoveryControllerResult[],
): Recorder {
  const calls: RecoveryControllerRequest[] = [];
  const queue = Array.isArray(result) ? [...result] : null;
  const controller: RecoveryController = {
    id: 'fake',
    perform: async (request) => {
      calls.push(request);
      if (queue) return queue.shift() ?? queue[queue.length - 1]!;
      return result as RecoveryControllerResult;
    },
  };
  return { controller, calls };
}
function installTaskBinding(flow: Flow): {
  readonly file: string;
  readonly digest: string;
} {
  const participant = (
    agentId: string,
    herdrAgent: string,
    sessionId: string,
    paneId: string,
    cwd: string,
  ) => ({
    agent_id: agentId,
    harness: 'pi',
    cwd,
    herdr_agent: herdrAgent,
    pane_id: paneId,
    native_session_id: sessionId,
  });
  const content = `${JSON.stringify(
    {
      schema: 'pappra/collab-binding/1',
      task_id: TASK,
      task_root: flow.task,
      channel: 'herdr',
      participants: [
        participant(
          'writer-a',
          'writer-a',
          WRITER_A.session_id,
          'w3:p4',
          '/work',
        ),
        participant(
          'coordinator',
          'coordinator',
          COORDINATOR.session_id,
          'w3:p1',
          '/work',
        ),
      ],
    },
    null,
    2,
  )}\n`;
  const file = join(flow.task, 'recovery-binding.json');
  writeFileSync(file, content);
  return {
    file,
    digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
}

function expectedFor(
  flow: Flow,
  self: Identity,
): NonNullable<RecoveryExecutionRequest['expectedSession']> {
  const binding = installTaskBinding(flow);
  const coordinator = self.agent_id === COORDINATOR.agent_id;
  return {
    session_id: self.session_id,
    cwd: '/work',
    binding_digest: binding.digest,
    binding_ref: binding.file,
    target_agent: coordinator ? 'coordinator' : 'writer-a',
    pane_id: coordinator ? 'w3:p1' : 'w3:p4',
    harness: 'pi',
  };
}

const SUBMITTED: RecoveryControllerResult = {
  disposition: 'submitted',
  detail: null,
  observation: 'queued',
};

function baseRequest(
  flow: Flow,
  planFile: string,
  over: Partial<RecoveryExecutionRequest> = {},
): RecoveryExecutionRequest {
  return {
    taskRoot: flow.task,
    planFile,
    self: WRITER_A,
    policy: { role: 'writer' },
    requestId: 'req-1',
    expectedSession: expectedFor(flow, over.self ?? WRITER_A),
    mode: 'apply',
    ...over,
  };
}

test('dry plan issues no effect and writes no reservation', async () => {
  const flow = makeFlow('exec-plan');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder(SUBMITTED);
    const r = await executeRecovery(
      baseRequest(flow, planFile, { mode: 'plan' }),
      {
        controller: rec.controller,
      },
    );
    assert.equal(r.status, 'planned');
    assert.equal(rec.calls.length, 0);
    assert.equal(existsSync(join(flow.task, '.recovery')), false);
  } finally {
    flow.cleanup();
  }
});

test('apply reserves atomically with a per-attempt journal and issues one wake', async () => {
  const flow = makeFlow('exec-apply');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder(SUBMITTED);
    const r = await executeRecovery(baseRequest(flow, planFile), {
      controller: rec.controller,
    });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0]!.kind, 'continue');
    const saved = JSON.parse(readFileSync(r.reservation!.path, 'utf8'));
    assert.equal(saved.final.status, 'applied');
    assert.ok(Array.isArray(saved.journal) && saved.journal.length === 1);
    assert.equal(saved.journal[0].observation, 'queued');
  } finally {
    flow.cleanup();
  }
});

test('truly concurrent duplicate applies issue the effect exactly once', async () => {
  const flow = makeFlow('exec-concurrent');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder(SUBMITTED);
    const req = baseRequest(flow, planFile);
    const [a, b] = await Promise.all([
      executeRecovery(req, { controller: rec.controller }),
      executeRecovery(req, { controller: rec.controller }),
    ]);
    assert.equal(rec.calls.length, 1, 'exactly one effect under concurrency');
    const statuses = [a.status, b.status].sort();
    assert.ok(
      statuses.includes('applied') &&
        (statuses.includes('unknown') || statuses.includes('noop')),
      JSON.stringify(statuses),
    );
  } finally {
    flow.cleanup();
  }
});

test('a repeated apply with the same cause returns the recorded outcome (no re-issue)', async () => {
  const flow = makeFlow('exec-idempotent');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder(SUBMITTED);
    const req = baseRequest(flow, planFile);
    const first = await executeRecovery(req, { controller: rec.controller });
    const second = await executeRecovery(req, { controller: rec.controller });
    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'noop', JSON.stringify(second));
    assert.equal(rec.calls.length, 1);
  } finally {
    flow.cleanup();
  }
});

test('a different requestId for the same cause is deduplicated (no second wake)', async () => {
  const flow = makeFlow('exec-cause-dedup');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder(SUBMITTED);
    const first = await executeRecovery(
      baseRequest(flow, planFile, { requestId: 'req-1' }),
      { controller: rec.controller },
    );
    const second = await executeRecovery(
      baseRequest(flow, planFile, { requestId: 'req-2' }),
      { controller: rec.controller },
    );
    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'noop', JSON.stringify(second));
    assert.equal(
      first.reservation!.key,
      second.reservation!.key,
      'same cause key',
    );
    assert.equal(
      rec.calls.length,
      1,
      'a new request id is not a new right to send',
    );
  } finally {
    flow.cleanup();
  }
});

test('a legitimately changed cause issues a distinct wake and is not suppressed', async () => {
  const flow = makeFlow('exec-new-cause');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder(SUBMITTED);
    const first = await executeRecovery(baseRequest(flow, planFile), {
      controller: rec.controller,
    });
    assert.equal(first.status, 'applied');
    // A new coordinator answer advances the state to a distinct recovery cause.
    answer(flow);
    const second = await executeRecovery(baseRequest(flow, planFile), {
      controller: rec.controller,
    });
    assert.equal(second.status, 'applied', JSON.stringify(second));
    assert.notEqual(first.reservation!.key, second.reservation!.key);
    assert.equal(rec.calls.length, 2, 'the later legitimate cause progresses');
  } finally {
    flow.cleanup();
  }
});

test('a reservation with an in-flight intent and no final outcome stays an actionable unknown', async () => {
  const flow = makeFlow('exec-crash');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder(SUBMITTED);
    const req = baseRequest(flow, planFile);
    const first = await executeRecovery(req, { controller: rec.controller });
    const saved = JSON.parse(readFileSync(first.reservation!.path, 'utf8'));
    delete saved.final; // simulate a crash after reserve/intent, before the final outcome.
    writeFileSync(
      first.reservation!.path,
      `${JSON.stringify(saved, null, 2)}\n`,
    );
    const second = await executeRecovery(req, { controller: rec.controller });
    assert.equal(second.status, 'unknown', JSON.stringify(second));
    assert.equal(
      rec.calls.length,
      1,
      'never blindly replays an unknown effect',
    );
  } finally {
    flow.cleanup();
  }
});

test('an expected-session mismatch refuses without reserving or issuing', async () => {
  const flow = makeFlow('exec-identity');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder(SUBMITTED);
    const r = await executeRecovery(
      baseRequest(flow, planFile, {
        expectedSession: {
          session_id: 'a-different-session',
          cwd: null,
          binding_digest: null,
        },
      }),
      { controller: rec.controller },
    );
    assert.equal(r.status, 'refused', JSON.stringify(r));
    assert.equal(rec.calls.length, 0);
    assert.equal(existsSync(join(flow.task, '.recovery')), false);
  } finally {
    flow.cleanup();
  }
});
test('apply refuses missing, null, stale or redirected binding pins before reservation or controller', async () => {
  const flow = makeFlow('exec-required-pins');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder(SUBMITTED);
    const valid = expectedFor(flow, WRITER_A);
    const invalidPins: RecoveryExecutionRequest['expectedSession'][] = [
      undefined,
      null,
      { ...valid, binding_digest: `sha256:${'0'.repeat(64)}` },
      { ...valid, binding_ref: join(flow.root, 'unregistered-binding.json') },
      { ...valid, cwd: '/different-project' },
      { ...valid, target_agent: 'unbound-participant' },
      { ...valid, pane_id: 'w9:p9' },
      { ...valid, harness: 'codex' },
    ];
    for (const expectedSession of invalidPins) {
      let request: RecoveryExecutionRequest;
      if (expectedSession === undefined) {
        const base = baseRequest(flow, planFile);
        const { expectedSession: defaultExpected, ...withoutExpected } = base;
        void defaultExpected;
        request = withoutExpected;
      } else {
        request = baseRequest(flow, planFile, { expectedSession });
      }
      const result = await executeRecovery(request, {
        controller: rec.controller,
      });
      assert.equal(result.status, 'refused', JSON.stringify(result));
      assert.equal(result.reservation, null);
    }
    assert.equal(rec.calls.length, 0);
    assert.equal(existsSync(join(flow.task, '.recovery')), false);
  } finally {
    flow.cleanup();
  }
});

test('a busy recipient defers and records the deferral', async () => {
  const flow = makeFlow('exec-busy');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder({
      disposition: 'deferred',
      detail: 'busy',
      observation: 'none',
    });
    const r = await executeRecovery(baseRequest(flow, planFile), {
      controller: rec.controller,
    });
    assert.equal(r.status, 'deferred', JSON.stringify(r));
    assert.equal(rec.calls.length, 1);
  } finally {
    flow.cleanup();
  }
});

test('a thrown controller is a possible effect: not retried, recorded unknown', async () => {
  const flow = makeFlow('exec-throw');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    let calls = 0;
    const controller: RecoveryController = {
      id: 'throwing',
      perform: async () => {
        calls += 1;
        throw new Error('connection lost after possible enqueue');
      },
    };
    const sleeps: number[] = [];
    const r = await executeRecovery(
      baseRequest(flow, planFile, { maxRetries: 3 }),
      {
        controller,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    assert.equal(r.status, 'unknown', JSON.stringify(r));
    assert.equal(calls, 1, 'a throw is never retried');
    assert.equal(sleeps.length, 0, 'no backoff for an ambiguous effect');
  } finally {
    flow.cleanup();
  }
});

test('a post-dispatch failure with an unknown observation is not retried', async () => {
  const flow = makeFlow('exec-postsubmit-fail');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder({
      disposition: 'failed',
      detail: 'after submit',
      observation: 'unknown',
    });
    const r = await executeRecovery(
      baseRequest(flow, planFile, { maxRetries: 3 }),
      {
        controller: rec.controller,
      },
    );
    assert.equal(r.status, 'unknown', JSON.stringify(r));
    assert.equal(rec.calls.length, 1, 'a possible effect is never retried');
  } finally {
    flow.cleanup();
  }
});

test('only a known-no-effect failure retries within the bounded budget', async () => {
  const flow = makeFlow('exec-retry');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder({
      disposition: 'unavailable',
      detail: 'never connected',
      observation: 'none',
    });
    const sleeps: number[] = [];
    const r = await executeRecovery(
      baseRequest(flow, planFile, { maxRetries: 2 }),
      {
        controller: rec.controller,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    assert.equal(r.status, 'unknown', JSON.stringify(r));
    assert.equal(r.retries, 2);
    assert.equal(rec.calls.length, 3, 'initial attempt plus two retries');
    assert.equal(sleeps.length, 2);
  } finally {
    flow.cleanup();
  }
});

test('exhausted no-effect retries can be retried later without a new cause', async () => {
  const flow = makeFlow('exec-retry-later');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const req = baseRequest(flow, planFile, { maxRetries: 0 });
    const unavailable = recorder({
      disposition: 'unavailable',
      detail: 'route is temporarily unavailable before dispatch',
      observation: 'none',
    });
    // Retain only bounded evidence, while keeping sequence and resume claims
    // unique after more than one journal window of no-effect invocations.
    for (let i = 0; i < 34; i += 1) {
      const r = await executeRecovery(req, {
        controller: unavailable.controller,
      });
      assert.equal(r.ok, false);
      assert.equal(r.status, 'unknown', JSON.stringify(r));
    }
    assert.equal(unavailable.calls.length, 34);
    const delivered = recorder(SUBMITTED);
    const [a, b] = await Promise.all([
      executeRecovery(req, { controller: delivered.controller }),
      executeRecovery(req, { controller: delivered.controller }),
    ]);
    assert.equal(delivered.calls.length, 1, 'only one resumed dispatcher');
    assert.ok([a.status, b.status].includes('applied'));
    const successful = a.status === 'applied' ? a : b;
    const saved = JSON.parse(
      readFileSync(successful.reservation!.path, 'utf8'),
    );
    assert.equal(saved.journal.length, 32);
    assert.equal(saved.journal.at(-1).seq, 34);
    const again = await executeRecovery(req, {
      controller: delivered.controller,
    });
    assert.equal(again.status, 'noop');
    assert.equal(again.ok, true);
    assert.equal(delivered.calls.length, 1);
  } finally {
    flow.cleanup();
  }
});

test('a finalized ambiguous effect stays unsuccessful and is never replayed', async () => {
  const flow = makeFlow('exec-repeat-unknown');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const req = baseRequest(flow, planFile);
    const rec = recorder({
      disposition: 'unknown',
      detail: 'disconnected after possible dispatch',
      observation: 'unknown',
    });
    const first = await executeRecovery(req, { controller: rec.controller });
    const second = await executeRecovery(req, { controller: rec.controller });
    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
    assert.equal(second.status, 'unknown');
    assert.equal(second.reservation!.outcome, 'unknown');
    assert.equal(rec.calls.length, 1);
  } finally {
    flow.cleanup();
  }
});

function crashReservationWorker(
  request: RecoveryExecutionRequest,
  mode: 'initial-empty' | 'resume-claim' | 'resumed-empty',
): void {
  const worker = new URL(
    './recovery-reservation-crash-worker.js',
    import.meta.url,
  );
  const child = spawnSync(
    process.execPath,
    [worker.pathname, JSON.stringify({ request, mode })],
    {
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  assert.equal(child.signal, 'SIGKILL', `${child.stdout}\n${child.stderr}`);
}

test('dead owners before the first durable intent can resume initial and successor reservations', async () => {
  const flow = makeFlow('exec-empty-intent-crash');
  try {
    assign(flow);
    const req = baseRequest(flow, flow.planFile(planOf([node()])));
    crashReservationWorker(req, 'initial-empty');
    crashReservationWorker(req, 'resumed-empty');
    const delivered = recorder(SUBMITTED);
    const resumed = await executeRecovery(req, {
      controller: delivered.controller,
    });
    assert.equal(resumed.status, 'applied', JSON.stringify(resumed));
    assert.equal(delivered.calls.length, 1);
    assert.equal(
      (await executeRecovery(req, { controller: delivered.controller })).status,
      'noop',
    );
    assert.equal(delivered.calls.length, 1);
  } finally {
    flow.cleanup();
  }
});

test('dead generation claims recover without deleting or stealing concurrent claims', async () => {
  const flow = makeFlow('exec-claim-crash');
  try {
    assign(flow);
    const req = baseRequest(flow, flow.planFile(planOf([node()])), {
      maxRetries: 0,
    });
    const unavailable = recorder({
      disposition: 'unavailable',
      observation: 'none',
      detail: 'no effect',
    });
    const first = await executeRecovery(req, {
      controller: unavailable.controller,
    });
    assert.equal(first.status, 'unknown');
    crashReservationWorker(req, 'resume-claim');
    crashReservationWorker(req, 'resume-claim');
    const directory = join(flow.task, '.recovery', 'reservations');
    const claims = readdirSync(directory).filter((name) =>
      name.includes('.resume-'),
    );
    assert.equal(claims.length, 2);
    const delivered = recorder(SUBMITTED);
    const results = await Promise.all([
      executeRecovery(req, { controller: delivered.controller }),
      executeRecovery(req, { controller: delivered.controller }),
    ]);
    assert.ok(results.some((value) => value.status === 'applied'));
    assert.equal(delivered.calls.length, 1);
    for (const claim of claims) assert.ok(existsSync(join(directory, claim)));
  } finally {
    flow.cleanup();
  }
});

test('live and malformed pre-dispatch generation claim owners stay unknown', async () => {
  const flow = makeFlow('exec-live-claim');
  try {
    assign(flow);
    const req = baseRequest(flow, flow.planFile(planOf([node()])), {
      maxRetries: 0,
    });
    const unavailable = recorder({
      disposition: 'unavailable',
      observation: 'none',
      detail: 'no effect',
    });
    const first = await executeRecovery(req, {
      controller: unavailable.controller,
    });
    crashReservationWorker(req, 'resume-claim');
    const claim = `${first.reservation!.path}.resume-0.lock`;
    const original = readFileSync(claim, 'utf8');
    const value = JSON.parse(original) as Record<string, unknown>;
    const delivered = recorder(SUBMITTED);
    for (const raw of [
      JSON.stringify({ ...value, owner_pid: process.pid }),
      '{}',
    ]) {
      writeFileSync(claim, raw);
      const refused = await executeRecovery(req, {
        controller: delivered.controller,
      });
      assert.equal(refused.status, 'unknown');
      assert.equal(refused.ok, false);
      assert.equal(readFileSync(claim, 'utf8'), raw);
      assert.equal(delivered.calls.length, 0);
    }
    writeFileSync(claim, original);
    assert.equal(
      (await executeRecovery(req, { controller: delivered.controller })).status,
      'applied',
    );
  } finally {
    flow.cleanup();
  }
});

test('a replaced regular reservation inode is preserved before any truncation', async () => {
  const flow = makeFlow('exec-replaced-reservation');
  try {
    assign(flow);
    const req = baseRequest(flow, flow.planFile(planOf([node()])));
    const replacement = 'replacement reservation must remain intact\n';
    let replacedFile = '';
    const controller: RecoveryController = {
      id: 'replace-inode',
      perform: async () => {
        const directory = join(flow.task, '.recovery', 'reservations');
        const file = readdirSync(directory).find((name) =>
          name.endsWith('.json'),
        )!;
        replacedFile = join(directory, file);
        renameSync(replacedFile, `${replacedFile}.original`);
        writeFileSync(replacedFile, replacement);
        return SUBMITTED;
      },
    };
    const outcome = await executeRecovery(req, { controller });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, 'unknown');
    assert.equal(readFileSync(replacedFile, 'utf8'), replacement);
  } finally {
    flow.cleanup();
  }
});

test('a temporary binding obstruction can be cleared and retried safely', async () => {
  const flow = makeFlow('exec-retry-binding-restored');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const req = baseRequest(flow, planFile, { maxRetries: 1 });
    const bindingFile = req.expectedSession!.binding_ref!;
    const binding = readFileSync(bindingFile, 'utf8');
    const rec = recorder({
      disposition: 'unavailable',
      detail: 'known no effect',
      observation: 'none',
    });
    const first = await executeRecovery(req, {
      controller: rec.controller,
      sleep: async () => writeFileSync(bindingFile, '{}'),
    });
    assert.equal(first.status, 'blocked', JSON.stringify(first));
    assert.equal(first.ok, false);
    writeFileSync(bindingFile, binding);
    const delivered = recorder(SUBMITTED);
    const second = await executeRecovery(req, {
      controller: delivered.controller,
    });
    assert.equal(second.status, 'applied', JSON.stringify(second));
    assert.equal(delivered.calls.length, 1);
    assert.equal(second.reservation!.key, first.reservation!.key);
  } finally {
    flow.cleanup();
  }
});

test('a cancellation admitted during backoff stops before the next attempt', async () => {
  const flow = makeFlow('exec-cancel-backoff');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    let calls = 0;
    const controller: RecoveryController = {
      id: 'retriable-once',
      perform: async () => {
        calls += 1;
        return {
          disposition: 'unavailable',
          detail: 'retry me',
          observation: 'none',
        };
      },
    };
    const r = await executeRecovery(
      baseRequest(flow, planFile, { maxRetries: 3 }),
      {
        controller,
        // A CANCEL is admitted during the backoff window before the next attempt.
        sleep: async () => {
          cancel(flow);
        },
      },
    );
    assert.equal(r.status, 'blocked', JSON.stringify(r));
    assert.equal(
      calls,
      1,
      'authority is revalidated each attempt and the cancel stops retries',
    );
    assert.ok(
      typeof readRecord(flow.task)!.attempts[0]!.cancel_requested_at ===
        'string',
    );
  } finally {
    flow.cleanup();
  }
});

test('a changed task binding during backoff stops before a retry', async () => {
  const flow = makeFlow('exec-binding-backoff');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    let calls = 0;
    const req = baseRequest(flow, planFile, { maxRetries: 2 });
    const controller: RecoveryController = {
      id: 'binding-retry',
      perform: async () => {
        calls += 1;
        return {
          disposition: 'unavailable',
          detail: 'known no effect',
          observation: 'none',
        };
      },
    };
    const result = await executeRecovery(req, {
      controller,
      sleep: async () => {
        writeFileSync(req.expectedSession!.binding_ref!, '{}');
      },
    });
    assert.equal(result.status, 'blocked', JSON.stringify(result));
    assert.equal(calls, 1);
  } finally {
    flow.cleanup();
  }
});

test('a symlinked .recovery directory is refused: no outside write and no wake', async () => {
  const flow = makeFlow('exec-symlink');
  const outside = mkdtempSync(join(tmpdir(), 'pappra-recovery-escape-'));
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    symlinkSync(outside, join(flow.task, '.recovery'), 'dir');
    const rec = recorder(SUBMITTED);
    const r = await executeRecovery(baseRequest(flow, planFile), {
      controller: rec.controller,
    });
    assert.equal(r.status, 'blocked', JSON.stringify(r));
    assert.equal(rec.calls.length, 0, 'no wake was issued');
    assert.equal(
      readdirSync(outside).length,
      0,
      'nothing was written outside the task root',
    );
  } finally {
    flow.cleanup();
  }
});

test('a non-finite maxRetries falls back to the default bounded budget', async () => {
  const flow = makeFlow('exec-nan-retries');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder({
      disposition: 'unavailable',
      detail: 'x',
      observation: 'none',
    });
    const r = await executeRecovery(
      baseRequest(flow, planFile, { maxRetries: Number.NaN }),
      {
        controller: rec.controller,
        sleep: async () => {},
      },
    );
    assert.equal(r.retries, 2, 'NaN retries clamps to the default of 2');
    assert.equal(rec.calls.length, 3);
  } finally {
    flow.cleanup();
  }
});

test('a resume whose bound native session differs from self is refused', async () => {
  const flow = makeFlow('exec-native-mismatch');
  try {
    assign(flow);
    bindWriterNative(flow, 'a-foreign-native-session');
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder(SUBMITTED);
    const r = await executeRecovery(baseRequest(flow, planFile), {
      controller: rec.controller,
    });
    assert.equal(r.status, 'refused', JSON.stringify(r));
    assert.equal(rec.calls.length, 0);
  } finally {
    flow.cleanup();
  }
});

test('a coordinator review is not blocked by the completed writer bound native session', async () => {
  const flow = makeFlow('exec-review-native');
  try {
    assign(flow);
    bindWriterNative(flow, WRITER_A.session_id);
    report(flow);
    const planFile = flow.planFile(planOf([node()]));
    const coordinator = readRecord(flow.task)!.coordinator as Identity;
    const rec = recorder(SUBMITTED);
    const r = await executeRecovery(
      baseRequest(flow, planFile, {
        self: coordinator,
        policy: { role: 'coordinator' },
      }),
      { controller: rec.controller },
    );
    assert.equal(r.status, 'applied', JSON.stringify(r));
    assert.equal(rec.calls[0]!.kind, 'review');
  } finally {
    flow.cleanup();
  }
});

test('a reservation file swapped for a symlink during backoff is refused with no outside write', async () => {
  const flow = makeFlow('exec-file-symlink-backoff');
  const outside = mkdtempSync(join(tmpdir(), 'pappra-recovery-sentinel-'));
  const sentinel = join(outside, 'sentinel.json');
  writeFileSync(sentinel, 'ORIGINAL');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    let calls = 0;
    const controller: RecoveryController = {
      id: 'retriable-once',
      perform: async () => {
        calls += 1;
        return {
          disposition: 'unavailable',
          detail: 'retry me',
          observation: 'none',
        };
      },
    };
    const r = await executeRecovery(
      baseRequest(flow, planFile, { maxRetries: 3 }),
      {
        controller,
        // During the backoff before the next attempt, replace the reservation file with a symlink.
        sleep: async () => {
          const dir = join(flow.task, '.recovery', 'reservations');
          const name = readdirSync(dir).find((entry) =>
            entry.endsWith('.json'),
          );
          if (name) {
            const reservation = join(dir, name);
            rmSync(reservation);
            symlinkSync(sentinel, reservation);
          }
        },
      },
    );
    assert.equal(r.status, 'blocked', JSON.stringify(r));
    assert.equal(
      calls,
      1,
      'no second send after the reservation file became unsafe',
    );
    assert.equal(
      readFileSync(sentinel, 'utf8'),
      'ORIGINAL',
      'the outside sentinel was not overwritten through the symlink',
    );
  } finally {
    flow.cleanup();
  }
});

test('the executor confirmAuthority guard reflects a cancellation after the live lookup', async () => {
  const flow = makeFlow('exec-confirm-authority');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    let confirmed: boolean | null = null;
    const controller: RecoveryController = {
      id: 'authority-probe',
      perform: async (request) => {
        cancel(flow); // authority changes between the live lookup and the prompt
        confirmed = request.confirmAuthority
          ? await request.confirmAuthority()
          : true;
        if (!confirmed)
          return {
            disposition: 'refused',
            detail: 'authority revoked',
            observation: 'none',
          };
        return SUBMITTED;
      },
    };
    const r = await executeRecovery(baseRequest(flow, planFile), {
      controller,
    });
    assert.equal(
      confirmed,
      false,
      'confirmAuthority reflects the fresh cancellation',
    );
    assert.equal(r.status, 'refused', JSON.stringify(r));
  } finally {
    flow.cleanup();
  }
});

test('a completed report routes to review without rerunning the writer', async () => {
  const flow = makeFlow('exec-review');
  try {
    assign(flow);
    report(flow);
    const planFile = flow.planFile(planOf([node()]));
    const coordinator = readRecord(flow.task)!.coordinator as Identity;
    const rec = recorder(SUBMITTED);
    const r = await executeRecovery(
      baseRequest(flow, planFile, {
        self: coordinator,
        policy: { role: 'coordinator' },
      }),
      { controller: rec.controller },
    );
    assert.equal(r.status, 'applied', JSON.stringify(r));
    assert.equal(rec.calls[0]!.kind, 'review');
    assert.ok(rec.calls[0]!.text.includes('do not rerun the writer'));
  } finally {
    flow.cleanup();
  }
});

test('nothing actionable yields a zero-effect noop', async () => {
  const flow = makeFlow('exec-noop');
  try {
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder(SUBMITTED);
    const r = await executeRecovery(baseRequest(flow, planFile), {
      controller: rec.controller,
    });
    assert.equal(r.status, 'noop', JSON.stringify(r));
    assert.equal(rec.calls.length, 0);
    assert.equal(existsSync(join(flow.task, '.recovery')), false);
  } finally {
    flow.cleanup();
  }
});

test('a missing requestId is refused before any projection or effect', async () => {
  const flow = makeFlow('exec-no-request-id');
  try {
    assign(flow);
    const planFile = flow.planFile(planOf([node()]));
    const rec = recorder(SUBMITTED);
    const r = await executeRecovery(
      baseRequest(flow, planFile, { requestId: '' }),
      {
        controller: rec.controller,
      },
    );
    assert.equal(r.status, 'refused');
    assert.equal(rec.calls.length, 0);
  } finally {
    flow.cleanup();
  }
});

test('public CLI routes recovery-run help and rejects malformed request files', async () => {
  const captured: { stdout: string; stderr: string } = {
    stdout: '',
    stderr: '',
  };
  const output = {
    stdout: (text: string) => {
      captured.stdout += text;
    },
    stderr: (text: string) => {
      captured.stderr += text;
    },
  };
  assert.equal(await runCli(['collab', 'recovery-run', '--help'], output), 0);
  assert.match(captured.stdout, /pappra collab recovery-run/);
  captured.stdout = '';
  assert.equal(await runCli(['collab', 'work-run', '--help'], output), 0);
  assert.match(captured.stdout, /pappra collab work-run/);

  const flow = makeFlow('exec-cli-malformed');
  try {
    const request = join(flow.root, 'malformed-recovery-run.json');
    writeFileSync(request, '{not-json');
    captured.stdout = '';
    captured.stderr = '';
    const code = await runCli(
      ['collab', 'recovery-run', '--request', request, '--apply', '--json'],
      output,
    );
    assert.equal(code, 2);
    assert.match(captured.stdout, /"status":"invalid"/);
    assert.match(captured.stdout, /request file is not valid JSON/);
    const missingExpected = join(
      flow.root,
      'missing-identity-recovery-run.json',
    );
    writeFileSync(
      missingExpected,
      `${JSON.stringify({
        schema: 'pappra/collab-recovery-run-request/1',
        taskRoot: flow.task,
        planFile: flow.planFile(planOf([node()])),
        self: WRITER_A,
        policy: { role: 'writer' },
        expected: null,
        requestId: 'req-cli-missing-identity',
        target: { agent: 'writer-a' },
      })}\n`,
    );
    captured.stdout = '';
    const missingCode = await runCli(
      [
        'collab',
        'recovery-run',
        '--request',
        missingExpected,
        '--apply',
        '--json',
      ],
      output,
    );
    assert.equal(missingCode, 2);
    assert.match(captured.stdout, /complete expected session/);
  } finally {
    flow.cleanup();
  }
});
