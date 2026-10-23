import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { WORK_PLAN_SCHEMA } from '../../src/collab/work-plan.js';
import type { Identity } from '../../src/collab/types.js';
import {
  executeRecovery,
  herdrRecoveryController,
  type RecoveryController,
  type RecoveryControllerRequest,
  type RecoveryControllerResult,
  type RecoveryExecutionResult,
  type RecoveryExpectedSession,
} from '../../src/app/collab-recovery-executor.js';
import type { HerdrTransport } from '../../src/app/collab-notify.js';
import {
  PI_RECOVERY_CONFIG_SCHEMA,
  createRecoveryReconciler,
  observeHostFacts,
  readPiRecoveryConfig,
  type PiRecoveryConfig,
  type RecoveryHostFacts,
} from '../../src/hosts/integration/pi-recovery-extension.js';
import { makeTaskDomain } from '../collab/task-resources-fixtures.js';

const WRITER_A: Identity = {
  agent_id: 'writer-a',
  session_id: 'writer-a-session',
  harness: 'pi',
};
const MATCHING_FACTS: RecoveryHostFacts = {
  session_id: WRITER_A.session_id,
  cwd: '/work',
};
const controllerBindingRoot = mkdtempSync(
  join(tmpdir(), 'pappra-recovery-controller-'),
);
test.after(() =>
  rmSync(controllerBindingRoot, { recursive: true, force: true }),
);
function config(over: Partial<PiRecoveryConfig> = {}): PiRecoveryConfig {
  return {
    schema: PI_RECOVERY_CONFIG_SCHEMA,
    taskRoot: '/tmp/task',
    planFile: '/tmp/plan.json',
    self: WRITER_A,
    policy: { role: 'writer' },
    expected: {
      session_id: WRITER_A.session_id,
      cwd: '/work',
      binding_ref: '/tmp/task/recovery-binding.json',
      binding_digest: `sha256:${'1'.repeat(64)}`,
      pane_id: 'w3:p4',
      harness: 'pi',
    },
    mode: 'apply',
    target: { agent: 'writer-a' },
    requestId: 'req-1',
    ...over,
  };
}

const NOOP_CONTROLLER: RecoveryController = {
  id: 'noop',
  perform: async () => ({
    disposition: 'unknown',
    detail: null,
    observation: 'none',
  }),
};

function stubResult(key: string): RecoveryExecutionResult {
  return {
    schema: 'pappra/collab-recovery-executor/1',
    ok: true,
    status: 'applied',
    action: null,
    cause: null,
    reservation: { key, path: '/tmp/x', created: true, outcome: 'applied' },
    performed: null,
    retries: 0,
    notes: [],
    limits: [],
  };
}

interface AgentSpec {
  readonly name: string | null;
  readonly cwd: string | null;
  readonly sessionValue: string | null;
  readonly sessionKind?: string | null;
  readonly paneId?: string | null;
  readonly harness?: string;
}

function fakeTransport(
  agents: AgentSpec[],
  prompt: { status: string; detail: string | null } = {
    status: 'submitted',
    detail: null,
  },
): HerdrTransport {
  return {
    id: 'fake-herdr',
    verifyCaller: async () => ({
      ok: false,
      status: 'unverified',
      code: 'test',
      detail: 'test',
    }),
    list: async () => ({
      ok: true,
      agents: agents.map((a) => ({
        name: a.name,
        harness: a.harness ?? 'pi',
        paneId: a.paneId ?? 'w3:p4',
        cwd: a.cwd,
        sessionValue: a.sessionValue,
        sessionKind: a.sessionKind ?? 'id',
        status: 'idle',
        focused: false,
      })),
    }),
    prompt: async () => prompt as never,
  } as HerdrTransport;
}

function controllerRequest(
  overExpected: Partial<RecoveryExpectedSession> = {},
  confirmAuthority: () => Promise<boolean> = async () => true,
): RecoveryControllerRequest {
  const pins: RecoveryExpectedSession = {
    session_id: WRITER_A.session_id,
    cwd: '/work',
    binding_digest: `sha256:${'1'.repeat(64)}`,
    binding_ref: join(controllerBindingRoot, 'recovery-binding.json'),
    target_agent: 'writer-a',
    pane_id: 'w3:p4',
    harness: 'pi',
    ...overExpected,
  };
  const binding = {
    schema: 'pappra/collab-binding/1',
    task_id: 'sample',
    task_root: controllerBindingRoot,
    channel: 'herdr',
    participants: [
      {
        agent_id: 'writer-a',
        harness: pins.harness,
        cwd: pins.cwd,
        herdr_agent: pins.target_agent,
        pane_id: pins.pane_id,
        native_session_id: pins.session_id,
      },
    ],
  };
  const bindingText = `${JSON.stringify(binding, null, 2)}\n`;
  writeFileSync(pins.binding_ref!, bindingText);
  const expected = {
    ...pins,
    binding_digest: `sha256:${createHash('sha256').update(bindingText).digest('hex')}`,
  };
  return {
    kind: 'continue',
    taskRoot: controllerBindingRoot,
    target: {
      agent_id: 'writer-a',
      session_id: WRITER_A.session_id,
      harness: 'pi',
      pane_id: expected.pane_id ?? null,
    },
    expected,
    cause: {
      reason: 'resume_unfinished',
      task_id: 'sample',
      role: 'writer',
      actor: { agent_id: 'writer-a', session_id: WRITER_A.session_id },
      action_key: 'resume_work:-:-:work:1:x:1',
      subtask_id: 'work',
      attempt: 1,
      input_revision: null,
      report_digest: null,
      owner_epoch: 1,
      request_id: 'req-1',
      is_recovery_wake: true,
    },
    text: 'wake',
    confirmAuthority,
  };
}

// --- observeHostFacts reads the actual installed Pi context shape ---

test('observeHostFacts reads ctx.sessionManager.getSessionId() and ctx.cwd, else null', () => {
  assert.deepEqual(
    observeHostFacts(null, {
      sessionManager: { getSessionId: () => 'sX' },
      cwd: '/w',
    }),
    { session_id: 'sX', cwd: '/w' },
  );
  assert.deepEqual(
    observeHostFacts(null, { sessionManager: { getSessionId: () => 'sY' } }),
    { session_id: 'sY', cwd: null },
  );
  assert.equal(
    observeHostFacts(null, {
      sessionManager: {
        getSessionId: () => {
          throw new Error('boom');
        },
      },
    }),
    null,
    'a throwing getter stays null',
  );
  assert.equal(
    observeHostFacts(null, {}),
    null,
    'a missing manager stays null',
  );
  assert.equal(
    observeHostFacts(null, { sessionManager: { getSessionId: () => 42 } }),
    null,
    'a non-string id stays null',
  );
});

test('a null host observation is skipped (no fabrication, no reconcile)', async () => {
  let calls = 0;
  const reconciler = createRecoveryReconciler(config(), {
    controller: NOOP_CONTROLLER,
    execute: (async () => {
      calls += 1;
      return stubResult('k');
    }) as typeof executeRecovery,
  });
  const outcome = await reconciler.reconcile('session_start', null);
  assert.equal(outcome.skipped, true);
  assert.equal(calls, 0);
});

test('a foreign actual host session is skipped even if the config asserts otherwise', async () => {
  let calls = 0;
  const reconciler = createRecoveryReconciler(config(), {
    controller: NOOP_CONTROLLER,
    execute: (async () => {
      calls += 1;
      return stubResult('k');
    }) as typeof executeRecovery,
  });
  const outcome = await reconciler.reconcile('manual', {
    session_id: 'a-foreign-live-session',
    cwd: null,
  });
  assert.equal(outcome.skipped, true);
  assert.equal(calls, 0);
});

test('a matching actual host session reconciles', async () => {
  let calls = 0;
  const reconciler = createRecoveryReconciler(config(), {
    controller: NOOP_CONTROLLER,
    execute: (async () => {
      calls += 1;
      return stubResult('k');
    }) as typeof executeRecovery,
  });
  const outcome = await reconciler.reconcile('session_start', MATCHING_FACTS);
  assert.equal(outcome.skipped, false);
  assert.equal(calls, 1);
});

test('reconciliations never overlap (single-flight)', async () => {
  let release: () => void = () => {};
  let calls = 0;
  const reconciler = createRecoveryReconciler(config(), {
    controller: NOOP_CONTROLLER,
    execute: (async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return stubResult('k');
    }) as typeof executeRecovery,
  });
  const inflight = reconciler.reconcile('manual', MATCHING_FACTS);
  const overlapped = await reconciler.reconcile(
    'session_start',
    MATCHING_FACTS,
  );
  assert.equal(overlapped.skipped, true);
  release();
  await inflight;
  assert.equal(calls, 1);
});

test('readPiRecoveryConfig loads a valid sibling config and rejects a bad or symlinked one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pappra-recovery-config-'));
  const good = join(dir, 'recovery.json');
  writeFileSync(good, `${JSON.stringify(config())}\n`);
  assert.equal(readPiRecoveryConfig(good).ok, true);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, `${JSON.stringify({ schema: 'wrong' })}\n`);
  assert.equal(readPiRecoveryConfig(bad).ok, false);
  const link = join(dir, 'linked.json');
  symlinkSync(good, link);
  assert.equal(
    readPiRecoveryConfig(link).ok,
    false,
    'symlinked config is refused',
  );
});

test('status reports mode, task root, digest, reconcile count and issued causes', async () => {
  const reconciler = createRecoveryReconciler(
    config({ taskRoot: '/tmp/pinned-task' }),
    {
      controller: NOOP_CONTROLLER,
      execute: (async () =>
        stubResult('cause-key-1')) as typeof executeRecovery,
    },
    'sha256:configdigest',
  );
  await reconciler.reconcile('session_start', MATCHING_FACTS);
  const status = reconciler.status();
  assert.equal(status.mode, 'apply');
  assert.equal(status.task_root, '/tmp/pinned-task');
  assert.equal(status.config_digest, 'sha256:configdigest');
  assert.equal(status.reconcile_count, 1);
  assert.deepEqual(status.issued_causes, ['cause-key-1']);
  assert.ok(
    status.limitations.some((l) => l.includes('no_known_reconnect_event')),
  );
});

// --- exact live-target verification of the concrete Herdr controller ---

test('the Herdr controller refuses null expected identity and missing final guard', async () => {
  const live: AgentSpec = {
    name: 'writer-a',
    cwd: '/work',
    sessionValue: WRITER_A.session_id,
    sessionKind: 'id',
    paneId: 'w3:p4',
    harness: 'pi',
  };
  const controller = herdrRecoveryController(fakeTransport([live]), {
    agent: 'writer-a',
  });
  const request = controllerRequest();
  const missingExpected = await controller.perform({
    ...request,
    expected: null,
  });
  assert.equal(missingExpected.disposition, 'refused');
  const { confirmAuthority, ...withoutGuard } = request;
  void confirmAuthority;
  const missingGuard = await controller.perform(withoutGuard);
  assert.equal(missingGuard.disposition, 'refused');
});

test('the Herdr controller refuses a target that is not a live participant', async () => {
  const controller = herdrRecoveryController(
    fakeTransport([
      { name: 'someone-else', cwd: '/work', sessionValue: WRITER_A.session_id },
    ]),
    { agent: 'writer-a' },
  );
  const out = await controller.perform(controllerRequest());
  assert.equal(out.disposition, 'refused');
  assert.equal(out.observation, 'none');
});

test('the Herdr controller refuses a foreign session that merely contains the expected id', async () => {
  const controller = herdrRecoveryController(
    fakeTransport([
      {
        name: 'writer-a',
        cwd: '/work',
        sessionValue: `foreign-${WRITER_A.session_id}-other`,
        sessionKind: 'id',
      },
    ]),
    { agent: 'writer-a' },
  );
  const out = await controller.perform(controllerRequest());
  assert.equal(out.disposition, 'refused', 'substring is not exact equality');
});

test('the Herdr controller refuses a live target with a missing cwd when a cwd is expected', async () => {
  const controller = herdrRecoveryController(
    fakeTransport([
      { name: 'writer-a', cwd: null, sessionValue: WRITER_A.session_id },
    ]),
    { agent: 'writer-a' },
  );
  const out = await controller.perform(controllerRequest({ cwd: '/work' }));
  assert.equal(
    out.disposition,
    'refused',
    'missing live cwd is insufficient evidence',
  );
});

test('the Herdr controller refuses a live target whose cwd does not match', async () => {
  const controller = herdrRecoveryController(
    fakeTransport([
      {
        name: 'writer-a',
        cwd: '/elsewhere',
        sessionValue: WRITER_A.session_id,
      },
    ]),
    { agent: 'writer-a' },
  );
  const out = await controller.perform(controllerRequest());
  assert.equal(out.disposition, 'refused');
});

test('the Herdr controller submits to an exactly-verified live target (id and path kinds)', async () => {
  const idController = herdrRecoveryController(
    fakeTransport([
      {
        name: 'writer-a',
        cwd: '/work',
        sessionValue: WRITER_A.session_id,
        sessionKind: 'id',
      },
    ]),
    { agent: 'writer-a' },
  );
  const idOut = await idController.perform(controllerRequest());
  assert.equal(idOut.disposition, 'submitted', JSON.stringify(idOut));
  assert.equal(
    idOut.observation,
    'queued',
    'a queue acceptance is not completion',
  );

  const pathController = herdrRecoveryController(
    fakeTransport([
      {
        name: 'writer-a',
        cwd: '/work',
        sessionValue: `/sessions/host_${WRITER_A.session_id}.jsonl`,
        sessionKind: 'path',
      },
    ]),
    { agent: 'writer-a' },
  );
  const pathOut = await pathController.perform(controllerRequest());
  assert.equal(
    pathOut.disposition,
    'submitted',
    'a valid path representation verifies',
  );
});

test('the Herdr controller requires canonical task binding membership and refuses a live mismatch', async () => {
  const live: AgentSpec = {
    name: 'writer-a',
    cwd: '/work',
    sessionValue: WRITER_A.session_id,
    sessionKind: 'id',
    paneId: 'w3:p4',
    harness: 'pi',
  };
  const ok = await herdrRecoveryController(fakeTransport([live]), {
    agent: 'writer-a',
  }).perform(controllerRequest());
  assert.equal(ok.disposition, 'submitted', JSON.stringify(ok));

  const wrong = await herdrRecoveryController(
    fakeTransport([{ ...live, paneId: 'w9:p9' }]),
    { agent: 'writer-a' },
  ).perform(controllerRequest());
  assert.equal(wrong.disposition, 'refused');
});

test('the Herdr controller rechecks task authority after the live lookup before prompting', async () => {
  const live: AgentSpec = {
    name: 'writer-a',
    cwd: '/work',
    sessionValue: WRITER_A.session_id,
    sessionKind: 'id',
  };
  const out = await herdrRecoveryController(fakeTransport([live]), {
    agent: 'writer-a',
  }).perform(controllerRequest({ cwd: '/work' }, async () => false));
  assert.equal(
    out.disposition,
    'refused',
    'authority revoked after the live lookup stops the prompt',
  );
});

// --- end to end with the real executor: no permanent lock, no self-wake loop ---

function seed(label: string): {
  root: string;
  task: string;
  planFile: string;
  bindingFile: string;
  bindingDigest: string;
  cleanup: () => void;
} {
  const domain = makeTaskDomain(label, ['sample']);
  const task = domain.tasks.sample!;
  const planFile = join(domain.root, 'plan.json');
  writeFileSync(
    planFile,
    `${JSON.stringify({
      schema: WORK_PLAN_SCHEMA,
      plan_id: 'plan-recovery',
      task_id: 'sample',
      owner_epoch: 1,
      nodes: [
        {
          node_id: 'work',
          role: 'writer',
          assignment_id: 'work',
          attempt: 1,
          input_revision: `sha256:${'1'.repeat(64)}`,
          assignee: {
            agent_id: WRITER_A.agent_id,
            session_id: WRITER_A.session_id,
          },
          depends_on: [],
          resources: [],
        },
      ],
    })}\n`,
  );
  const binding = {
    schema: 'pappra/collab-binding/1',
    task_id: 'sample',
    task_root: task,
    channel: 'herdr',
    participants: [
      {
        agent_id: WRITER_A.agent_id,
        harness: 'pi',
        cwd: '/work',
        herdr_agent: 'writer-a',
        pane_id: 'w3:p4',
        native_session_id: WRITER_A.session_id,
      },
    ],
  };
  const bindingText = `${JSON.stringify(binding, null, 2)}\n`;
  const bindingFile = join(task, 'recovery-binding.json');
  writeFileSync(bindingFile, bindingText);
  const bindingDigest = `sha256:${createHash('sha256').update(bindingText).digest('hex')}`;
  return {
    root: domain.root,
    task,
    planFile,
    bindingFile,
    bindingDigest,
    cleanup: domain.cleanup,
  };
}

function configForSeed(seeded: ReturnType<typeof seed>): PiRecoveryConfig {
  return config({
    taskRoot: seeded.task,
    planFile: seeded.planFile,
    expected: {
      ...config().expected,
      binding_ref: seeded.bindingFile,
      binding_digest: seeded.bindingDigest,
    },
  });
}

function assignWork(task: string): void {
  let clock = Date.parse('2026-10-20T00:00:00Z');
  const tick = (): number => (clock += 1000);
  const outcome = submitMessage(
    task,
    buildMessage(
      {
        message_id: 'msg-assign-work-1',
        type: 'ASSIGN',
        task_id: 'sample',
        from: {
          agent_id: 'coordinator',
          session_id: 'coord-session',
          harness: 'pi',
        },
        to: WRITER_A,
        subtask_id: 'work',
        attempt: 1,
        owner_epoch: 1,
        body: {
          assignment_digest: `sha256:${'a'.repeat(64)}`,
          input_revision: `sha256:${'1'.repeat(64)}`,
        },
      },
      { clock: tick() },
    ),
    { clock: tick() },
  );
  assert.equal(outcome.ok, true);
}

function recorder(): {
  controller: RecoveryController;
  calls: RecoveryControllerRequest[];
} {
  const calls: RecoveryControllerRequest[] = [];
  const result: RecoveryControllerResult = {
    disposition: 'submitted',
    detail: null,
    observation: 'queued',
  };
  return {
    calls,
    controller: {
      id: 'fake',
      perform: async (request) => {
        calls.push(request);
        return result;
      },
    },
  };
}

test('an initial no-op does not suppress a later genuine cause (no permanent event lock)', async () => {
  const seeded = seed('ext-noop-then-cause');
  try {
    const rec = recorder();
    const reconciler = createRecoveryReconciler(configForSeed(seeded), {
      controller: rec.controller,
      execute: executeRecovery,
    });
    const first = await reconciler.reconcile('session_start', MATCHING_FACTS);
    assert.equal(first.skipped, false);
    if (!first.skipped) assert.equal(first.result.status, 'noop');
    assert.equal(rec.calls.length, 0);
    assignWork(seeded.task);
    const second = await reconciler.reconcile('agent_settled', MATCHING_FACTS);
    assert.equal(second.skipped, false);
    if (!second.skipped) assert.equal(second.result.status, 'applied');
    assert.equal(rec.calls.length, 1, 'the later cause progresses');
  } finally {
    seeded.cleanup();
  }
});

test("recovery's own settled event cannot repeatedly wake the same cause", async () => {
  const seeded = seed('ext-no-self-loop');
  try {
    assignWork(seeded.task);
    const rec = recorder();
    const reconciler = createRecoveryReconciler(configForSeed(seeded), {
      controller: rec.controller,
      execute: executeRecovery,
    });
    const first = await reconciler.reconcile('session_start', MATCHING_FACTS);
    assert.equal(first.skipped, false);
    if (!first.skipped) assert.equal(first.result.status, 'applied');
    const second = await reconciler.reconcile('agent_settled', MATCHING_FACTS);
    assert.equal(second.skipped, false);
    if (!second.skipped) assert.equal(second.result.status, 'noop');
    assert.equal(
      rec.calls.length,
      1,
      'the same cause is not re-issued (durable dedup)',
    );
  } finally {
    seeded.cleanup();
  }
});
