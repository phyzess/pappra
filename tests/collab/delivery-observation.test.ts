import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { initTask, notificationsDir } from '../../src/collab/store.js';
import type { Identity, Message } from '../../src/collab/types.js';
import {
  readDeliveryRecord,
  sendMessageFromFile,
} from '../../src/app/collab-messages.js';
import {
  notifyRegisteredMessage,
  type HerdrAgentObservation,
  type HerdrCallerResult,
  type HerdrListResult,
  type HerdrPromptResult,
  type HerdrTransport,
} from '../../src/app/collab-notify.js';
import {
  DEFAULT_DELIVERY_OBSERVATION_POLICY,
  delay,
  normalizeDeliveryObservationPolicy,
  observeDeliveryReceipt,
  type DeliveryObservationPolicy,
  type DeliveryObservationProbe,
} from '../../src/app/collab-delivery-observation.js';
import type {
  CollabDeliveryAgentState,
  CollabDeliveryObservation,
} from '../../src/schemas/collaboration.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

/**
 * Receipt observation is a bounded, evidence-gated fact recorded beside a
 * delivery. These tests pin four things: what the transport signals can prove,
 * what they may never prove, the bound on probes and wall-clock time, and that a
 * missing observation (an older record) reads as unobserved instead of being
 * rewritten. Nothing here contacts a real host or presses a key.
 */

const clock = Date.parse('2026-11-12T08:00:00Z');
const coordinator = {
  agent_id: 'pappra-coordinator',
  session_id: 'coordinator-session',
  harness: 'codex',
  owner_epoch: 1,
  since: '2026-11-12T08:00:00+08:00',
};
const worker = {
  agent_id: 'pappra-implement',
  session_id: 'worker-session',
  harness: 'pi',
} as const satisfies Identity;

// ---------------------------------------------------------------------------
// Pure classification
// ---------------------------------------------------------------------------

const policy: DeliveryObservationPolicy = {
  maxSamples: 3,
  intervalMs: 1_000,
  windowMs: 3_000,
};

function state(
  overrides: Partial<CollabDeliveryAgentState> = {},
): CollabDeliveryAgentState {
  return {
    observed_at: new Date(clock).toISOString(),
    agent_status: 'idle',
    terminal_id: 'terminal-1',
    state_change_seq: 5,
    completion_seq: 4,
    revision: 10,
    interactive_ready: true,
    launch_pending: false,
    ...overrides,
  };
}

interface Harness {
  readonly observation: Promise<CollabDeliveryObservation>;
  readonly probes: () => number;
  readonly elapsed: () => number;
}

function observe(
  options: {
    readonly before?: CollabDeliveryAgentState;
    readonly samples?: readonly (DeliveryObservationProbe | Error)[];
    readonly submitted?: boolean;
    readonly policy?: DeliveryObservationPolicy;
    readonly now?: () => number;
  } = {},
): Harness {
  let current = clock;
  let probes = 0;
  const now = options.now ?? (() => current);
  const samples = options.samples ?? [];
  const observation = observeDeliveryReceipt({
    submitted: options.submitted ?? true,
    before: options.before ?? state(),
    probe: async () => {
      const next = samples[probes] ?? samples[samples.length - 1];
      probes += 1;
      if (next === undefined) throw new Error('no scripted probe');
      if (next instanceof Error) throw next;
      return next;
    },
    policy: options.policy ?? policy,
    now,
    sleep: async (milliseconds) => {
      current += milliseconds;
    },
  });
  return {
    observation,
    probes: () => probes,
    elapsed: () => current - clock,
  };
}

const workingProbe: DeliveryObservationProbe = {
  ok: true,
  state: state({
    agent_status: 'working',
    state_change_seq: 6,
    completion_seq: 4,
    revision: 11,
    observed_at: new Date(clock + 1_000).toISOString(),
  }),
};

const quietProbe: DeliveryObservationProbe = {
  ok: true,
  state: state({ observed_at: new Date(clock + 1_000).toISOString() }),
};

test('a corroborated turn start is taken, within the first sample', async () => {
  const harness = observe({ samples: [workingProbe] });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'taken');
  assert.equal(observation.reason, 'turn_observed');
  assert.equal(observation.samples, 1);
  assert.equal(observation.window_ms, 0);
  assert.equal(observation.before.agent_status, 'idle');
  assert.equal(observation.after?.agent_status, 'working');
  assert.equal(observation.after?.terminal_id, 'terminal-1');
  assert.equal(harness.probes(), 1);
});

test('a complete quiet window is not_taken and stops at the sample budget', async () => {
  const harness = observe({
    samples: [quietProbe, quietProbe, quietProbe, workingProbe],
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'not_taken');
  assert.equal(observation.reason, 'no_observed_turn');
  assert.equal(observation.samples, 3);
  assert.equal(observation.window_ms, 2_000);
  // The fourth scripted sample is never read: the budget is the bound.
  assert.equal(harness.probes(), 3);
  assert.match(String(observation.detail), /may still be sitting unsubmitted/);
});

test('a moved counter without a turn stays unknown rather than a success', async () => {
  const redraw = observe({
    samples: [{ ok: true, state: state({ revision: 11 }) }],
  });
  const observation = await redraw.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'unattributed_activity');
  assert.equal(observation.samples, 1);
  assert.match(String(observation.detail), /redraw is not proof/);

  const moved = observe({
    samples: [{ ok: true, state: state({ state_change_seq: 6 }) }],
  });
  const movedObservation = await moved.observation;
  assert.equal(movedObservation.receipt, 'unknown');
  assert.equal(movedObservation.reason, 'unattributed_activity');

  const completed = observe({
    samples: [{ ok: true, state: state({ completion_seq: 5 }) }],
  });
  const completedObservation = await completed.observation;
  assert.equal(completedObservation.receipt, 'unknown');
  assert.equal(completedObservation.reason, 'unattributed_activity');
});

test('a state that leaves rest without a working turn stays unknown', async () => {
  const harness = observe({
    samples: [{ ok: true, state: state({ agent_status: 'blocked' }) }],
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'recipient_state_changed');

  const done = observe({
    samples: [{ ok: true, state: state({ agent_status: 'done' }) }],
  });
  const doneObservation = await done.observation;
  assert.equal(doneObservation.receipt, 'unknown');
  assert.equal(doneObservation.reason, 'recipient_state_changed');
});

test('an already-working recipient proves nothing and is not probed', async () => {
  const harness = observe({
    before: state({ agent_status: 'working', state_change_seq: 3 }),
    samples: [workingProbe],
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'recipient_already_working');
  assert.equal(observation.samples, 0);
  assert.equal(harness.probes(), 0);
  assert.equal(observation.after, null);
});

test('a blocked or unanswered recipient is never treated as receipt', async () => {
  const blocked = await observe({
    before: state({ agent_status: 'blocked' }),
  }).observation;
  assert.equal(blocked.reason, 'recipient_blocked');
  assert.equal(blocked.receipt, 'unknown');

  const unknown = await observe({
    before: state({ agent_status: 'unknown' }),
  }).observation;
  assert.equal(unknown.reason, 'recipient_state_unknown');

  const launching = await observe({
    before: state({ launch_pending: true }),
  }).observation;
  assert.equal(launching.reason, 'recipient_not_ready');

  const notInteractive = await observe({
    samples: [{ ok: true, state: state({ interactive_ready: false }) }],
  }).observation;
  assert.equal(notInteractive.reason, 'recipient_not_ready');
  assert.equal(notInteractive.receipt, 'unknown');
});

test('missing signals leave receipt unknown without any probe', async () => {
  for (const before of [
    state({ terminal_id: null }),
    state({ state_change_seq: null }),
  ]) {
    const harness = observe({ before, samples: [workingProbe] });
    const observation = await harness.observation;
    assert.equal(observation.receipt, 'unknown');
    assert.equal(observation.reason, 'signals_unavailable');
    assert.equal(harness.probes(), 0);
  }
});

test('a changed terminal identity is unknown, not receipt or non-receipt', async () => {
  const harness = observe({
    samples: [{ ok: true, state: state({ terminal_id: 'terminal-2' }) }],
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'terminal_changed');
  assert.equal(observation.samples, 1);
});

test('a probe carrying no counter is incomplete evidence, not a negative', async () => {
  const harness = observe({
    samples: [{ ok: true, state: state({ state_change_seq: null }) }],
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'evidence_incomplete');
});

test('a working state without a moved counter cannot be placed after the submit', async () => {
  const harness = observe({
    samples: [
      {
        ok: true,
        state: state({ agent_status: 'working', state_change_seq: 5 }),
      },
    ],
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'evidence_incomplete');
});

test('identity, session and probe problems stay unknown with their own reason', async () => {
  const cases: readonly (readonly [DeliveryObservationProbe, string])[] = [
    [{ ok: false, reason: 'target_missing', detail: 'gone' }, 'target_missing'],
    [
      { ok: false, reason: 'target_identity_changed', detail: 'pane' },
      'target_identity_changed',
    ],
    [
      { ok: false, reason: 'target_session_changed', detail: 'session' },
      'target_session_changed',
    ],
    [{ ok: false, reason: 'probe_failed', detail: 'exit 1' }, 'probe_failed'],
  ];
  for (const [sample, reason] of cases) {
    const observation = await observe({ samples: [sample] }).observation;
    assert.equal(observation.receipt, 'unknown');
    assert.equal(observation.reason, reason);
    assert.equal(observation.samples, 1);
  }

  const thrown = await observe({ samples: [new Error('transport died')] })
    .observation;
  assert.equal(thrown.receipt, 'unknown');
  assert.equal(thrown.reason, 'probe_failed');
});

test('an expired window reports unknown instead of guessing', async () => {
  const harness = observe({
    samples: [quietProbe, quietProbe, quietProbe],
    policy: { maxSamples: 3, intervalMs: 1_000, windowMs: 0 },
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'window_expired');
  assert.equal(observation.samples, 1);
});

test('a submission that never happened is not a negative either', async () => {
  const harness = observe({ submitted: false, samples: [workingProbe] });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'submission_not_established');
  assert.equal(harness.probes(), 0);
});

test('the observation policy is bounded no matter what a caller passes', () => {
  assert.deepEqual(normalizeDeliveryObservationPolicy(), {
    ...DEFAULT_DELIVERY_OBSERVATION_POLICY,
  });
  assert.deepEqual(
    normalizeDeliveryObservationPolicy({
      maxSamples: 99,
      intervalMs: 10_000_000,
      windowMs: 10_000_000,
    }),
    { maxSamples: 8, intervalMs: 30_000, windowMs: 60_000 },
  );
  assert.deepEqual(
    normalizeDeliveryObservationPolicy({
      maxSamples: 0,
      intervalMs: -5,
      windowMs: Number.NaN,
    }),
    {
      maxSamples: 2,
      intervalMs: 0,
      windowMs: DEFAULT_DELIVERY_OBSERVATION_POLICY.windowMs,
    },
  );
  // The default pause is a timer that a zero bound skips entirely.
  return delay(0).then(() => undefined);
});

// ---------------------------------------------------------------------------
// Notification wiring, persistence and the read contract
// ---------------------------------------------------------------------------

interface Fixture {
  readonly root: string;
  readonly taskRoot: string;
  readonly bindingFile: string;
}

function fixture(label: string): Fixture {
  const root = makeTempDir(label);
  const domain = join(root, 'domain');
  mkdirSync(domain, { recursive: true });
  const taskRoot = join(domain, 'tasks', 'smoke');
  initTask(taskRoot, {
    taskId: 'smoke',
    coordinator,
    domainRoot: domain,
    clock,
  });
  const bindingFile = join(root, 'binding.json');
  writeFileSync(
    bindingFile,
    `${JSON.stringify(
      {
        schema: 'pappra/collab-binding/1',
        task_id: 'smoke',
        task_root: taskRoot,
        channel: 'herdr',
        participants: [
          {
            agent_id: coordinator.agent_id,
            harness: coordinator.harness,
            cwd: taskRoot,
            herdr_agent: 'pappra-coordinator',
            pane_id: 'w3:p1',
            native_session_id: coordinator.session_id,
          },
          {
            agent_id: worker.agent_id,
            harness: worker.harness,
            cwd: taskRoot,
            herdr_agent: 'pappra-implement',
            pane_id: 'w3:p3',
            native_session_id: worker.session_id,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { root, taskRoot, bindingFile };
}

function envelope(messageId: string): Message {
  return buildMessage(
    {
      type: 'STATUS_QUERY',
      message_id: messageId,
      task_id: 'smoke',
      from: coordinator,
      to: worker,
      reply_to: null,
      subtask_id: null,
      attempt: null,
      owner_epoch: null,
      body: { status: 'running' },
    },
    { clock },
  );
}

async function accepted(value: Fixture, messageId: string): Promise<void> {
  const file = join(value.root, `envelope-${messageId}.json`);
  writeFileSync(file, `${JSON.stringify(envelope(messageId), null, 2)}\n`);
  const sent = await sendMessageFromFile(value.taskRoot, file, {
    apply: true,
    clock,
  });
  assert.equal(sent.ok, true);
  assert(sent.ok);
  assert.equal(sent.value.status, 'accepted');
}

function agent(
  cwd: string,
  overrides: Partial<HerdrAgentObservation> = {},
): HerdrAgentObservation {
  return {
    name: 'pappra-implement',
    harness: 'pi',
    paneId: 'w3:p3',
    cwd,
    sessionValue: 'worker-session',
    sessionKind: 'id',
    status: 'idle',
    focused: false,
    terminalId: 'terminal-1',
    stateChangeSeq: 5,
    completionSeq: 4,
    revision: 10,
    interactiveReady: true,
    launchPending: false,
    ...overrides,
  };
}

function coordinatorAgent(
  cwd: string,
  overrides: Partial<HerdrAgentObservation> = {},
): HerdrAgentObservation {
  return {
    name: 'pappra-coordinator',
    harness: 'codex',
    paneId: 'w3:p1',
    cwd,
    sessionValue: null,
    sessionKind: null,
    status: 'idle',
    focused: false,
    ...overrides,
  };
}

/** Scripted roster: call 0 verifies participants, later calls answer probes. */
class ScriptedTransport implements HerdrTransport {
  readonly id = 'scripted-herdr';
  readonly prompts: { readonly agent: string; readonly text: string }[] = [];
  readonly listCalls: { readonly timeoutMs?: number }[] = [];
  constructor(
    private readonly script: {
      readonly cwd: string;
      readonly agents?: (
        call: number,
        cwd: string,
      ) => readonly HerdrAgentObservation[];
      readonly prompt?: HerdrPromptResult;
    },
  ) {}

  async verifyCaller(): Promise<HerdrCallerResult> {
    return {
      ok: true,
      caller: {
        paneId: 'w3:p1',
        workspaceId: 'w3',
        tabId: 'w3:t1',
        harness: 'codex',
        cwd: this.script.cwd,
        sessionKind: 'id',
        sessionValue: coordinator.session_id,
        source: 'current',
      },
    };
  }

  async list(
    options: { readonly timeoutMs?: number } = {},
  ): Promise<HerdrListResult> {
    this.listCalls.push(options);
    const call = this.listCalls.length - 1;
    const cwd = this.script.cwd;
    const agents =
      this.script.agents?.(call, cwd) ??
      ([coordinatorAgent(cwd), agent(cwd)] as readonly HerdrAgentObservation[]);
    return { ok: true, agents };
  }

  /** Records the pointer the caller asked for; used to prove no resend. */
  async prompt(agentName: string, text: string): Promise<HerdrPromptResult> {
    this.prompts.push({ agent: agentName, text });
    return this.script.prompt ?? { status: 'submitted', detail: null };
  }
}

function observationOptions(
  overrides: {
    readonly maxSamples?: number;
    readonly intervalMs?: number;
    readonly windowMs?: number;
  } = {},
) {
  let current = clock;
  return {
    options: {
      maxSamples: overrides.maxSamples ?? 3,
      intervalMs: overrides.intervalMs ?? 1_000,
      windowMs: overrides.windowMs ?? 3_000,
      now: () => current,
      sleep: async (milliseconds: number) => {
        current += milliseconds;
      },
      probeTimeoutMs: 1_234,
    },
    elapsed: () => current - clock,
  };
}

test('a legitimately accepted message still submits one pointer and records taken', async () => {
  const value = fixture('observation-taken');
  try {
    await accepted(value, 'msg-observe-1');
    const transport = new ScriptedTransport({
      cwd: value.taskRoot,
      agents: (call, cwd) =>
        call === 0
          ? [coordinatorAgent(cwd), agent(cwd)]
          : [
              coordinatorAgent(cwd),
              agent(cwd, {
                status: 'working',
                stateChangeSeq: 6,
                revision: 11,
              }),
            ],
    });
    const timing = observationOptions();
    const notified = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-1',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
      observation: timing.options,
    });
    assert.equal(notified.ok, true);
    assert(notified.ok);
    const result = notified.value;
    assert.equal(result.status, 'submitted');
    assert.equal(result.consumed, false);
    assert.equal(result.taskAccepted, false);
    assert.equal(result.observation?.receipt, 'taken');
    assert.equal(result.observation?.reason, 'turn_observed');
    // One pointer, one verify list, one probe.
    assert.equal(transport.prompts.length, 1);
    assert.equal(transport.listCalls.length, 2);
    assert.deepEqual(transport.listCalls[1], { timeoutMs: 1_234 });

    const delivery = readDeliveryRecord(value.taskRoot, 'msg-observe-1');
    assert(delivery);
    assert.equal(delivery.status, 'submitted');
    assert.equal(delivery.attempts.length, 1);
    assert.equal(delivery.attempts[0]?.status, 'submitted');
    assert.equal(delivery.attempts[0]?.observation?.receipt, 'taken');
    assert.equal(
      delivery.attempts[0]?.observation?.after?.agent_status,
      'working',
    );
  } finally {
    cleanup(value.root);
  }
});

test('a quiet recipient records not_taken without a second submission', async () => {
  const value = fixture('observation-quiet');
  try {
    await accepted(value, 'msg-observe-2');
    const transport = new ScriptedTransport({ cwd: value.taskRoot });
    const timing = observationOptions();
    const notified = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-2',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
      observation: timing.options,
    });
    assert(notified.ok);
    if (!notified.ok) return;
    assert.equal(notified.value.observation?.receipt, 'not_taken');
    assert.equal(notified.value.observation?.samples, 3);
    assert.equal(notified.value.observation?.window_ms, 2_000);
    assert.equal(timing.elapsed(), 2_000);
    // No resend and no key press: still exactly one pointer.
    assert.equal(transport.prompts.length, 1);
    assert.equal(transport.listCalls.length, 4);
    const delivery = readDeliveryRecord(value.taskRoot, 'msg-observe-2');
    assert.equal(delivery?.attempts[0]?.observation?.receipt, 'not_taken');
    assert.equal(delivery?.status, 'submitted');
  } finally {
    cleanup(value.root);
  }
});

test('a refused prompt records no receipt claim and never probes', async () => {
  const value = fixture('observation-refused');
  try {
    await accepted(value, 'msg-observe-3');
    const transport = new ScriptedTransport({
      cwd: value.taskRoot,
      prompt: { status: 'refused', detail: 'Herdr refused', effect: 'none' },
    });
    const timing = observationOptions();
    const notified = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-3',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
      observation: timing.options,
    });
    assert(notified.ok);
    if (!notified.ok) return;
    assert.equal(notified.value.status, 'refused');
    assert.equal(notified.value.observation?.receipt, 'unknown');
    assert.equal(
      notified.value.observation?.reason,
      'submission_not_established',
    );
    assert.equal(notified.value.observation?.samples, 0);
    assert.equal(transport.listCalls.length, 1);
    const delivery = readDeliveryRecord(value.taskRoot, 'msg-observe-3');
    assert.equal(delivery?.status, 'refused');
    assert.equal(
      delivery?.attempts[0]?.observation?.reason,
      'submission_not_established',
    );
  } finally {
    cleanup(value.root);
  }
});

test('a failed probe leaves the recorded submission and never resends', async () => {
  const value = fixture('observation-probe-failure');
  try {
    await accepted(value, 'msg-observe-4');
    let calls = 0;
    const transport = new ScriptedTransport({ cwd: value.taskRoot });
    const failingProbe = new ScriptedTransport({
      cwd: value.taskRoot,
    });
    const timing = observationOptions();
    const notified = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-4',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport: {
        id: transport.id,
        verifyCaller: () => transport.verifyCaller(),
        // Only the probe fails; participant verification still succeeds.
        list: (options) =>
          calls++ === 0
            ? transport.list(options)
            : Promise.resolve({
                ok: false as const,
                status: 'failed' as const,
                detail: 'agent list failed during the probe',
              }),
        prompt: (agentName, text) => transport.prompt(agentName, text),
      },
      clock,
      observation: timing.options,
    });
    assert(notified.ok);
    if (!notified.ok) return;
    assert.equal(failingProbe.prompts.length, 0);
    assert.equal(notified.value.status, 'submitted');
    assert.equal(notified.value.observation?.receipt, 'unknown');
    assert.equal(notified.value.observation?.reason, 'probe_failed');
    assert.equal(transport.prompts.length, 1);
    const delivery = readDeliveryRecord(value.taskRoot, 'msg-observe-4');
    assert.equal(delivery?.status, 'submitted');
    assert.equal(delivery?.attempts[0]?.observation?.reason, 'probe_failed');
  } finally {
    cleanup(value.root);
  }
});

test('an observation that cannot run leaves the attempt unobserved, not rewritten', async () => {
  const value = fixture('observation-disabled');
  try {
    await accepted(value, 'msg-observe-5');
    // A roster without the observation signals: the old transport shape.
    const transport = new ScriptedTransport({
      cwd: value.taskRoot,
      agents: (_call, cwd) => [
        coordinatorAgent(cwd),
        // The pre-#20 roster shape: a status and no counters or identity.
        {
          name: 'pappra-implement',
          harness: 'pi',
          paneId: 'w3:p3',
          cwd,
          sessionValue: 'worker-session',
          sessionKind: 'id',
          status: 'idle',
          focused: false,
        },
      ],
    });
    const timing = observationOptions();
    const notified = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-5',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
      observation: timing.options,
    });
    assert(notified.ok);
    if (!notified.ok) return;
    assert.equal(notified.value.observation?.receipt, 'unknown');
    assert.equal(notified.value.observation?.reason, 'signals_unavailable');
    assert.equal(transport.listCalls.length, 1);
    assert.equal(transport.prompts.length, 1);
    assert.equal(
      readDeliveryRecord(value.taskRoot, 'msg-observe-5')?.status,
      'submitted',
    );

    // Explicitly disabled observation writes no observation at all.
    const second = fixture('observation-off');
    try {
      await accepted(second, 'msg-observe-6');
      const offTransport = new ScriptedTransport({ cwd: second.taskRoot });
      const off = await notifyRegisteredMessage({
        taskRoot: second.taskRoot,
        messageId: 'msg-observe-6',
        bindingFile: second.bindingFile,
        apply: true,
        retry: false,
        transport: offTransport,
        clock,
        observation: false,
      });
      assert(off.ok);
      if (!off.ok) return;
      assert.equal(off.value.observation, null);
      assert.equal(offTransport.listCalls.length, 1);
      const delivery = readDeliveryRecord(second.taskRoot, 'msg-observe-6');
      assert.equal(delivery?.attempts[0]?.observation, undefined);
    } finally {
      cleanup(second.root);
    }
  } finally {
    cleanup(value.root);
  }
});

test('planned notification observes nothing and writes no delivery state', async () => {
  const value = fixture('observation-planned');
  try {
    await accepted(value, 'msg-observe-7');
    const transport = new ScriptedTransport({ cwd: value.taskRoot });
    const planned = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-7',
      bindingFile: value.bindingFile,
      apply: false,
      retry: false,
      transport,
      clock,
    });
    assert(planned.ok);
    if (!planned.ok) return;
    assert.equal(planned.value.status, 'planned');
    assert.equal(planned.value.observation, null);
    assert.equal(transport.listCalls.length, 0);
    assert.equal(transport.prompts.length, 0);
    assert.equal(readDeliveryRecord(value.taskRoot, 'msg-observe-7'), null);
  } finally {
    cleanup(value.root);
  }
});

test('an older delivery record without an observation still reads as unobserved', async () => {
  const value = fixture('observation-legacy');
  try {
    await accepted(value, 'msg-observe-8');
    const directory = notificationsDir(value.taskRoot);
    mkdirSync(directory, { recursive: true });
    // A record written before #20: no observation key anywhere.
    const legacy = {
      schema: 'pappra/collab-delivery/1',
      message_id: 'msg-observe-8',
      message_path: join(value.taskRoot, 'messages', 'msg-observe-8.json'),
      message_digest: `sha256:${'0'.repeat(64)}`,
      task_id: 'smoke',
      task_root: value.taskRoot,
      recipient: { agent_id: worker.agent_id, harness: worker.harness },
      target: {
        herdr_agent: 'pappra-implement',
        pane_id: 'w3:p3',
        native_session: 'unknown',
      },
      status: 'submitted',
      attempts: [
        {
          at: new Date(clock).toISOString(),
          status: 'submitted',
          detail: null,
          reservation_id: 'legacy-reservation',
        },
      ],
      created_at: new Date(clock).toISOString(),
      updated_at: new Date(clock).toISOString(),
    };
    const file = join(directory, 'msg-observe-8.json');
    writeFileSync(file, `${JSON.stringify(legacy, null, 2)}\n`);
    const before = readFileSync(file, 'utf8');
    const delivery = readDeliveryRecord(value.taskRoot, 'msg-observe-8');
    assert(delivery);
    assert.equal(delivery.status, 'submitted');
    assert.equal(delivery.attempts[0]?.reservation_id, 'legacy-reservation');
    // Missing is unobserved; reading never rewrites the file.
    assert.equal(delivery.attempts[0]?.observation, undefined);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    cleanup(value.root);
  }
});
