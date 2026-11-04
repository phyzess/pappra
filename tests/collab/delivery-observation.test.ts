import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  MAX_OBSERVATION_DETAIL_CHARS,
  boundDetail,
  delay,
  normalizeDeliveryObservationPolicy,
  observeDeliveryReceipt,
  type DeliveryObservationPolicy,
  type DeliveryObservationProbe,
} from '../../src/app/collab-delivery-observation.js';
import {
  collabDeliveryObservationSchema,
  type CollabDeliveryAgentState,
  type CollabDeliveryObservation,
} from '../../src/schemas/collaboration.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

/**
 * Receipt observation is a bounded, evidence-gated record beside a delivery.
 * These tests pin four things: that roster signals never become a message-level
 * receipt, what the activity reasons may say, the budget that covers both the
 * waits and the probes, and the read contract for old records. Nothing here
 * contacts a real host, presses a key or resends.
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
  probeTimeoutMs: 1_000,
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
  readonly budgets: readonly number[];
  readonly elapsed: () => number;
}

/**
 * Drives the classifier with a scripted probe sequence. A `number` entry is the
 * cost of that probe in milliseconds, so a slow or overrunning transport is
 * simulated on the injected clock instead of by sleeping.
 */
function observe(
  options: {
    readonly before?: CollabDeliveryAgentState;
    readonly samples?: readonly (DeliveryObservationProbe | Error)[];
    readonly costs?: readonly number[];
    readonly submitted?: boolean;
    readonly policy?: DeliveryObservationPolicy;
  } = {},
): Harness {
  let current = clock;
  let probes = 0;
  const budgets: number[] = [];
  const samples = options.samples ?? [];
  const costs = options.costs ?? [];
  const observation = observeDeliveryReceipt({
    submitted: options.submitted ?? true,
    before: options.before ?? state(),
    probe: async (budgetMs) => {
      budgets.push(budgetMs);
      const next = samples[probes] ?? samples[samples.length - 1];
      probes += 1;
      current += costs[probes - 1] ?? 0;
      if (next === undefined) throw new Error('no scripted probe');
      if (next instanceof Error) throw next;
      return next;
    },
    policy: options.policy ?? policy,
    now: () => current,
    sleep: async (milliseconds) => {
      current += milliseconds;
    },
  });
  return {
    observation,
    probes: () => probes,
    budgets,
    elapsed: () => current - clock,
  };
}

const workingProbe: DeliveryObservationProbe = {
  ok: true,
  state: state({
    agent_status: 'working',
    state_change_seq: 6,
    revision: 11,
  }),
};

const quietProbe: DeliveryObservationProbe = {
  ok: true,
  state: state(),
};

test('a started turn stays unknown: no roster signal ties it to this pointer', async () => {
  const harness = observe({ samples: [workingProbe] });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'turn_activity_observed');
  assert.equal(observation.samples, 1);
  assert.equal(observation.before.agent_status, 'idle');
  assert.equal(observation.after?.agent_status, 'working');
  assert.equal(observation.after?.terminal_id, 'terminal-1');
  assert.match(String(observation.detail), /not receipt/);
  assert.equal(harness.probes(), 1);
});

test('another input waking the recipient is activity, never receipt', async () => {
  // The pointer is delivered, then a different message (or a human) starts the
  // turn. The roster read cannot tell the two apart, so the record must not.
  const harness = observe({
    before: state({ agent_status: 'idle', state_change_seq: 5 }),
    samples: [
      { ok: true, state: state({ state_change_seq: 5, revision: 10 }) },
      workingProbe,
    ],
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'turn_activity_observed');
  assert.equal(observation.samples, 2);
  assert.match(String(observation.detail), /another input/);
});

test('a queued pointer with no started turn is unknown, not non-receipt', async () => {
  // The text is sitting in the recipient's input: no state change, no turn.
  const harness = observe({ samples: [quietProbe, quietProbe, quietProbe] });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'no_turn_activity_observed');
  assert.equal(observation.samples, 3);
  assert.equal(observation.window_ms, 2_000);
  assert.match(String(observation.detail), /not non-receipt/);
});

test('a working sample that cannot be attributed to the pointer stays unknown', async () => {
  // Already mid-turn when the pointer arrived, so later activity belongs to earlier work.
  const alreadyWorking = await observe({
    before: state({ agent_status: 'working', state_change_seq: 3 }),
    samples: [
      {
        ok: true,
        state: state({ agent_status: 'working', state_change_seq: 9 }),
      },
    ],
  }).observation;
  assert.equal(alreadyWorking.receipt, 'unknown');
  assert.equal(alreadyWorking.reason, 'recipient_already_working');
  assert.equal(alreadyWorking.samples, 0);

  // A restarted terminal invalidates the comparison even if it now looks busy.
  const restarted = await observe({
    samples: [
      {
        ok: true,
        state: state({
          agent_status: 'working',
          state_change_seq: 6,
          terminal_id: 'terminal-2',
        }),
      },
    ],
  }).observation;
  assert.equal(restarted.receipt, 'unknown');
  assert.equal(restarted.reason, 'terminal_changed');

  // Working without a moved counter cannot be placed after the submission.
  const unmoved = await observe({
    samples: [
      {
        ok: true,
        state: state({ agent_status: 'working', state_change_seq: 5 }),
      },
    ],
  }).observation;
  assert.equal(unmoved.receipt, 'unknown');
  assert.equal(unmoved.reason, 'evidence_incomplete');
});

test('a moved counter without a turn stays unknown rather than activity', async () => {
  const redraw = await observe({
    samples: [{ ok: true, state: state({ revision: 11 }) }],
  });
  const observation = await redraw.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'unattributed_activity');
  assert.match(String(observation.detail), /redraw is not proof/);

  const moved = await observe({
    samples: [{ ok: true, state: state({ state_change_seq: 6 }) }],
  }).observation;
  assert.equal(moved.receipt, 'unknown');
  assert.equal(moved.reason, 'unattributed_activity');

  const completed = await observe({
    samples: [{ ok: true, state: state({ completion_seq: 5 }) }],
  }).observation;
  assert.equal(completed.receipt, 'unknown');
  assert.equal(completed.reason, 'unattributed_activity');

  const blocked = await observe({
    samples: [{ ok: true, state: state({ agent_status: 'blocked' }) }],
  }).observation;
  assert.equal(blocked.receipt, 'unknown');
  assert.equal(blocked.reason, 'recipient_state_changed');
});

test('a blocked or unready recipient is never treated as activity', async () => {
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

test('missing signals leave the receipt unknown without any probe', async () => {
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

test('a submission that never happened is not observed at all', async () => {
  const harness = observe({ submitted: false, samples: [workingProbe] });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'submission_not_established');
  assert.equal(harness.probes(), 0);
});

// ---------------------------------------------------------------------------
// The budget covers waits and probes
// ---------------------------------------------------------------------------

test('a probe that returns after the budget is recorded but never classified', async () => {
  // The coordinator's reproduction: a 3000 ms window, a first probe that only
  // returns at 4000 ms reporting a started turn. That may not become activity.
  const harness = observe({
    samples: [workingProbe],
    costs: [4_000],
    policy: { ...policy, windowMs: 3_000, probeTimeoutMs: 4_000 },
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'window_expired');
  assert.equal(observation.samples, 1);
  assert.equal(observation.window_ms, 4_000);
  assert.equal(observation.after?.agent_status, 'working');
  assert.match(String(observation.detail), /never classified/);
});

test('a final quiet probe that overruns is not a quiet window either', async () => {
  // Third quiet probe returns at 5000 ms for a 3000 ms window: the coordinator's
  // second reproduction, where an overrunning sample used to become a negative.
  const harness = observe({
    samples: [quietProbe, quietProbe, quietProbe],
    costs: [0, 0, 3_000],
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'window_expired');
  assert.equal(observation.samples, 3);
  assert.equal(observation.window_ms, 5_000);
  assert.equal(observation.after?.agent_status, 'idle');
  assert.notEqual(observation.reason, 'no_turn_activity_observed');
});

test('the window can be exhausted before a probe starts', async () => {
  // One probe, then a 2000 ms wait that consumes the whole 2000 ms budget.
  const harness = observe({
    samples: [quietProbe, quietProbe],
    policy: { ...policy, windowMs: 2_000, intervalMs: 2_000 },
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'window_expired');
  assert.equal(observation.samples, 1);
  assert.equal(harness.probes(), 1);
  assert.equal(harness.elapsed(), 2_000);
});

test('a probe is never asked for more time than the window has left', async () => {
  const full = observe({ samples: [quietProbe, quietProbe, quietProbe] });
  await full.observation;
  // min(probeTimeoutMs, remaining): 1000, then 1000 with 2000 left, then 1000.
  assert.deepEqual(full.budgets, [1_000, 1_000, 1_000]);

  const capped = observe({
    samples: [quietProbe, quietProbe],
    policy: { ...policy, windowMs: 500, probeTimeoutMs: 4_000 },
  });
  await capped.observation;
  assert.deepEqual(capped.budgets, [500]);
  assert.equal(capped.elapsed(), 500);
});

test('a transport that hangs records the overrun instead of claiming a bound', async () => {
  const harness = observe({
    samples: [quietProbe],
    costs: [30_000],
    policy: { ...policy, windowMs: 3_000, probeTimeoutMs: 4_000 },
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'window_expired');
  assert.equal(observation.window_ms, 30_000);
  // The budget it was handed was still inside the window.
  assert.deepEqual(harness.budgets, [3_000]);

  // An overrun beyond the persisted bound is capped so the record stays
  // readable, and the real elapsed time is stated in the detail.
  const extreme = observe({
    samples: [quietProbe],
    costs: [700_000],
    policy: { ...policy, windowMs: 3_000, probeTimeoutMs: 4_000 },
  });
  const extremeObservation = await extreme.observation;
  assert.equal(extremeObservation.reason, 'window_expired');
  assert.equal(extremeObservation.window_ms, 600_000);
  assert.match(String(extremeObservation.detail), /capped at 600000 ms/);
});

test('a zero window performs no probe and asks no transport wait', async () => {
  const harness = observe({
    samples: [workingProbe],
    policy: { ...policy, windowMs: 0 },
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'window_expired');
  assert.equal(observation.samples, 0);
  assert.equal(harness.probes(), 0);
});

test('the observation policy is bounded no matter what a caller passes', async () => {
  assert.deepEqual(normalizeDeliveryObservationPolicy(), {
    ...DEFAULT_DELIVERY_OBSERVATION_POLICY,
  });
  assert.deepEqual(
    normalizeDeliveryObservationPolicy({
      maxSamples: 99,
      intervalMs: 10_000_000,
      windowMs: 10_000_000,
      probeTimeoutMs: 10_000_000,
    }),
    {
      maxSamples: 8,
      intervalMs: 30_000,
      windowMs: 60_000,
      probeTimeoutMs: 30_000,
    },
  );
  assert.deepEqual(
    normalizeDeliveryObservationPolicy({
      maxSamples: 0,
      intervalMs: -5,
      windowMs: Number.NaN,
      probeTimeoutMs: 0,
    }),
    {
      maxSamples: 2,
      intervalMs: 0,
      windowMs: DEFAULT_DELIVERY_OBSERVATION_POLICY.windowMs,
      probeTimeoutMs: 1,
    },
  );
  // The default pause is a timer that a zero bound skips entirely.
  await delay(0);
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
  overrides: Partial<DeliveryObservationPolicy> = {},
): {
  readonly options: {
    readonly maxSamples: number;
    readonly intervalMs: number;
    readonly windowMs: number;
    readonly probeTimeoutMs: number;
    readonly now: () => number;
    readonly sleep: (milliseconds: number) => Promise<void>;
  };
  readonly elapsed: () => number;
} {
  let current = clock;
  return {
    options: {
      maxSamples: overrides.maxSamples ?? 3,
      intervalMs: overrides.intervalMs ?? 1_000,
      windowMs: overrides.windowMs ?? 3_000,
      probeTimeoutMs: overrides.probeTimeoutMs ?? 1_500,
      now: () => current,
      sleep: async (milliseconds: number) => {
        current += milliseconds;
      },
    },
    elapsed: () => current - clock,
  };
}

test('an admitted message still submits one pointer and keeps the delivery contract', async () => {
  const value = fixture('observation-record');
  try {
    await accepted(value, 'msg-observe-1');
    // The pointer is delivered, then a turn starts on the same terminal.
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
    // Observed activity, no message-level receipt.
    assert.equal(result.observation?.receipt, 'unknown');
    assert.equal(result.observation?.reason, 'turn_activity_observed');
    assert.equal(transport.prompts.length, 1);
    assert.equal(transport.listCalls.length, 2);
    // The probe is bounded by the remaining budget, not by a separate cap.
    assert.deepEqual(transport.listCalls[1], { timeoutMs: 1_500 });

    const delivery = readDeliveryRecord(value.taskRoot, 'msg-observe-1');
    assert(delivery);
    assert.equal(delivery.status, 'submitted');
    assert.equal(delivery.attempts.length, 1);
    assert.equal(delivery.attempts[0]?.status, 'submitted');
    assert.equal(delivery.attempts[0]?.observation?.receipt, 'unknown');
    assert.equal(
      delivery.attempts[0]?.observation?.reason,
      'turn_activity_observed',
    );
    assert.equal(
      delivery.attempts[0]?.observation?.after?.agent_status,
      'working',
    );
  } finally {
    cleanup(value.root);
  }
});

test('a quiet recipient records no activity without a second submission', async () => {
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
    assert.equal(notified.value.status, 'submitted');
    assert.equal(notified.value.observation?.receipt, 'unknown');
    assert.equal(
      notified.value.observation?.reason,
      'no_turn_activity_observed',
    );
    assert.equal(notified.value.observation?.samples, 3);
    assert.equal(notified.value.observation?.window_ms, 2_000);
    assert.equal(timing.elapsed(), 2_000);
    // No resend and no key press: still exactly one pointer.
    assert.equal(transport.prompts.length, 1);
    assert.equal(transport.listCalls.length, 4);
    const delivery = readDeliveryRecord(value.taskRoot, 'msg-observe-2');
    assert.equal(
      delivery?.attempts[0]?.observation?.reason,
      'no_turn_activity_observed',
    );
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
  const value = fixture('observation-no-signals');
  try {
    await accepted(value, 'msg-observe-5');
    // A roster without the observation signals: the pre-#20 transport shape.
    const transport = new ScriptedTransport({
      cwd: value.taskRoot,
      agents: (_call, cwd) => [
        coordinatorAgent(cwd),
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

// ---------------------------------------------------------------------------
// On demand: nothing is observed unless a caller asks for it
// ---------------------------------------------------------------------------

test('a notification without an explicit request observes nothing and waits for nothing', async () => {
  const value = fixture('observation-default-off');
  try {
    await accepted(value, 'msg-observe-off');
    const transport = new ScriptedTransport({ cwd: value.taskRoot });
    const notified = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-off',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert(notified.ok);
    if (!notified.ok) return;
    assert.equal(notified.value.status, 'submitted');
    assert.equal(notified.value.observation, null);
    // Exactly the pre-#20 traffic: one caller resolution, one roster read, one
    // prompt. No probe, no wait.
    assert.equal(transport.prompts.length, 1);
    assert.equal(transport.listCalls.length, 1);
    assert.deepEqual(transport.listCalls[0], {});
    const delivery = readDeliveryRecord(value.taskRoot, 'msg-observe-off');
    assert.equal(delivery?.status, 'submitted');
    assert.equal(delivery?.attempts[0]?.observation, undefined);
  } finally {
    cleanup(value.root);
  }
});

// ---------------------------------------------------------------------------
// A broken observation never damages the delivery record
// ---------------------------------------------------------------------------

const TRUNCATION_MARKER = /…\[truncated\]/;

test('an over-long diagnostic is bounded and marked, and the observation is kept', async () => {
  const value = fixture('observation-long-detail');
  try {
    await accepted(value, 'msg-observe-long');
    const transport = new ScriptedTransport({ cwd: value.taskRoot });
    const timing = observationOptions();
    const notified = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-long',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport: {
        id: transport.id,
        verifyCaller: () => transport.verifyCaller(),
        list: (options) =>
          transport.listCalls.length === 0
            ? transport.list(options)
            : Promise.resolve({
                ok: false as const,
                status: 'failed' as const,
                detail: `agent list failed: ${'x'.repeat(5_000)}`,
              }),
        prompt: (agentName, text) => transport.prompt(agentName, text),
      },
      clock,
      observation: timing.options,
    });
    assert(notified.ok);
    if (!notified.ok) return;
    const observation = notified.value.observation;
    assert(observation);
    assert.equal(observation.receipt, 'unknown');
    assert.equal(observation.reason, 'probe_failed');
    assert(observation.detail !== null);
    assert(observation.detail.length <= MAX_OBSERVATION_DETAIL_CHARS);
    assert.match(observation.detail, TRUNCATION_MARKER);
    // It is still stored: only the free-text diagnostic was shortened.
    const delivery = readDeliveryRecord(value.taskRoot, 'msg-observe-long');
    assert.equal(delivery?.attempts[0]?.observation?.reason, 'probe_failed');
  } finally {
    cleanup(value.root);
  }
});

test('an over-long attempt detail is bounded and marked, and the status is kept', async () => {
  const value = fixture('observation-long-transport-detail');
  try {
    await accepted(value, 'msg-observe-long-transport');
    const transport = new ScriptedTransport({
      cwd: value.taskRoot,
      prompt: {
        status: 'submitted',
        detail: `herdr said: ${'y'.repeat(5_000)}`,
      },
    });
    const notified = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-long-transport',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert(notified.ok);
    if (!notified.ok) return;
    assert.equal(notified.value.status, 'submitted');
    const delivery = readDeliveryRecord(
      value.taskRoot,
      'msg-observe-long-transport',
    );
    assert(delivery);
    assert.equal(delivery.status, 'submitted');
    const attemptDetail = delivery.attempts[0]?.detail ?? '';
    assert(attemptDetail.length <= 4_096);
    assert.match(attemptDetail, TRUNCATION_MARKER);
  } finally {
    cleanup(value.root);
  }
});

test('an observation the schema would reject is not recorded, and the status survives', async () => {
  const value = fixture('observation-invalid');
  try {
    await accepted(value, 'msg-observe-invalid');
    // A transport reporting a 300-character status: the state field is not
    // trimmed into shape, so the observation is refused instead.
    const transport = new ScriptedTransport({
      cwd: value.taskRoot,
      agents: (call, cwd) =>
        call === 0
          ? [coordinatorAgent(cwd), agent(cwd)]
          : [coordinatorAgent(cwd), agent(cwd, { status: `z`.repeat(300) })],
    });
    const timing = observationOptions();
    const notified = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-invalid',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
      observation: timing.options,
    });
    assert(notified.ok);
    if (!notified.ok) return;
    assert.equal(notified.value.status, 'submitted');
    // The unrecorded value is not presented as stored evidence.
    assert.equal(notified.value.observation, null);
    assert.match(String(notified.value.detail), /not recorded/);
    assert.match(String(notified.value.detail), /delivery_record_invalid/);
    assert.match(String(notified.value.detail), /agent_status/);

    // The already-valid status and attempts are intact and readable.
    const delivery = readDeliveryRecord(value.taskRoot, 'msg-observe-invalid');
    assert(delivery);
    assert.equal(delivery.status, 'submitted');
    assert.equal(delivery.attempts.length, 1);
    assert.equal(delivery.attempts[0]?.status, 'submitted');
    assert.equal(delivery.attempts[0]?.observation, undefined);

    // A later notify reports the recorded outcome, not a broken record.
    const again = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-invalid',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert(again.ok);
    if (!again.ok) return;
    assert.equal(again.value.status, 'already_recorded');
  } finally {
    cleanup(value.root);
  }
});

test('a failed observation write leaves the delivery record intact', async () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const value = fixture('observation-write-failure');
  const directory = notificationsDir(value.taskRoot);
  try {
    await accepted(value, 'msg-observe-write');
    mkdirSync(directory, { recursive: true });
    const transport = new ScriptedTransport({ cwd: value.taskRoot });
    const timing = observationOptions();
    let failed = false;
    const baseSleep = timing.options.sleep;
    const notified = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-write',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
      observation: {
        ...timing.options,
        // Once the observation is running, the delivery directory stops
        // accepting writes: the status is already durable, so only the additive
        // observation write can fail.
        sleep: async (milliseconds: number) => {
          if (!failed) {
            failed = true;
            chmodSync(directory, 0o500);
          }
          await baseSleep(milliseconds);
        },
      },
    });
    assert(notified.ok);
    if (!notified.ok) return;
    assert.equal(notified.value.status, 'submitted');
    assert.equal(notified.value.observation, null);
    assert.match(String(notified.value.detail), /not recorded/);
    assert.match(String(notified.value.detail), /delivery_state_unwritable/);

    chmodSync(directory, 0o700);
    const delivery = readDeliveryRecord(value.taskRoot, 'msg-observe-write');
    assert(delivery);
    assert.equal(delivery.status, 'submitted');
    assert.equal(delivery.attempts.length, 1);
    assert.equal(delivery.attempts[0]?.status, 'submitted');
    assert.equal(delivery.attempts[0]?.observation, undefined);

    const again = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-write',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert(again.ok);
    if (!again.ok) return;
    assert.equal(again.value.status, 'already_recorded');
  } finally {
    try {
      chmodSync(directory, 0o700);
    } catch {
      // The directory may not exist when the fixture was never completed.
    }
    cleanup(value.root);
  }
});

test('a retry keeps its own attempt and observation', async () => {
  const value = fixture('observation-retry');
  try {
    await accepted(value, 'msg-observe-retry');
    const transport = new ScriptedTransport({ cwd: value.taskRoot });
    const timing = observationOptions();
    const first = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-retry',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
      observation: timing.options,
    });
    assert(first.ok);
    if (!first.ok) return;
    assert.equal(first.value.observation?.reason, 'no_turn_activity_observed');

    const second = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-retry',
      bindingFile: value.bindingFile,
      apply: true,
      retry: true,
      transport,
      clock,
      observation: observationOptions().options,
    });
    assert(second.ok);
    if (!second.ok) return;
    assert.equal(second.value.attempts, 2);
    assert.equal(second.value.observation?.reason, 'no_turn_activity_observed');

    const delivery = readDeliveryRecord(value.taskRoot, 'msg-observe-retry');
    assert(delivery);
    assert.equal(delivery.attempts.length, 2);
    for (const attempt of delivery.attempts) {
      assert.equal(attempt.status, 'submitted');
      assert.equal(attempt.observation?.receipt, 'unknown');
      assert.equal(attempt.observation?.reason, 'no_turn_activity_observed');
    }
    // One pointer per attempt, never a resend inside one attempt.
    assert.equal(transport.prompts.length, 2);
  } finally {
    cleanup(value.root);
  }
});

// ---------------------------------------------------------------------------
// Late failure versus late reading
// ---------------------------------------------------------------------------

test('a late failure keeps its diagnosis while a late reading does not', async () => {
  const lateFailure = await observe({
    samples: [
      { ok: false, reason: 'probe_failed', detail: 'agent list timed out' },
    ],
    costs: [4_000],
    policy: { ...policy, windowMs: 3_000, probeTimeoutMs: 4_000 },
  }).observation;
  // "the read failed" is a diagnosis about the probe, not about the budget.
  assert.equal(lateFailure.receipt, 'unknown');
  assert.equal(lateFailure.reason, 'probe_failed');
  assert.equal(lateFailure.samples, 1);

  const lateReading = await observe({
    samples: [workingProbe],
    costs: [4_000],
    policy: { ...policy, windowMs: 3_000, probeTimeoutMs: 4_000 },
  }).observation;
  // A reading that arrives after the budget is never classified.
  assert.equal(lateReading.receipt, 'unknown');
  assert.equal(lateReading.reason, 'window_expired');
  assert.equal(lateReading.after?.agent_status, 'working');
});

// ---------------------------------------------------------------------------
// Two clocks, two jobs
// ---------------------------------------------------------------------------

test('the record clock and the observation clock stay independent', async () => {
  const value = fixture('observation-clocks');
  const recordClock = Date.parse('2026-11-12T08:00:00Z');
  const observationBase = Date.parse('2030-05-06T07:08:09Z');
  try {
    await accepted(value, 'msg-observe-clocks');
    const transport = new ScriptedTransport({ cwd: value.taskRoot });
    let observationNowMs = observationBase;
    const notified = await notifyRegisteredMessage({
      taskRoot: value.taskRoot,
      messageId: 'msg-observe-clocks',
      bindingFile: value.bindingFile,
      apply: true,
      retry: false,
      transport,
      // The record says when the attempt happened.
      clock: recordClock,
      observation: {
        maxSamples: 3,
        intervalMs: 1_000,
        windowMs: 3_000,
        probeTimeoutMs: 1_500,
        // The budget is measured on its own clock.
        now: () => observationNowMs,
        sleep: async (milliseconds: number) => {
          observationNowMs += milliseconds;
        },
      },
    });
    assert(notified.ok);
    if (!notified.ok) return;
    const observation = notified.value.observation;
    assert(observation);
    assert.equal(
      observation.started_at,
      new Date(observationBase).toISOString(),
    );
    assert.equal(
      observation.ended_at,
      new Date(observationBase + 2_000).toISOString(),
    );
    assert.equal(observation.window_ms, 2_000);

    const delivery = readDeliveryRecord(value.taskRoot, 'msg-observe-clocks');
    assert(delivery);
    // The persisted record keeps the record clock, never the budget clock.
    assert.equal(delivery.attempts[0]?.at, new Date(recordClock).toISOString());
    assert.equal(delivery.created_at, new Date(recordClock).toISOString());
    assert.equal(delivery.updated_at, new Date(recordClock).toISOString());
  } finally {
    cleanup(value.root);
  }
});

test('the truncation marker is exact and never exceeds the field bound', () => {
  const long = 'a'.repeat(2_000);
  const bounded = boundDetail(long, 1_024);
  assert(bounded !== null);
  // Exactly the field bound, ending in the fixed marker: no digit count can be
  // off, and no off-by-one can push the value over the schema limit.
  assert.equal(bounded.length, 1_024);
  assert.match(bounded, /…\[truncated\]$/);
  assert.equal(
    bounded.slice(0, 1_024 - ' …[truncated]'.length),
    'a'.repeat(1_024 - ' …[truncated]'.length),
  );
  assert.equal(boundDetail('short', 1_024), 'short');
  assert.equal(boundDetail(null, 1_024), null);
  // A bound smaller than the marker still yields a value inside the bound.
  assert.equal(boundDetail(long, 3), ' …[');
});

test('an over-long error and an over-run window are both kept inside the bound', async () => {
  // Both facts at once: a 5 000-character transport error and a probe that
  // overran the 600 000 ms recordable window. The composed detail must fit the
  // schema, keep the real elapsed time and keep the cap explanation.
  const harness = observe({
    samples: [
      {
        ok: false,
        reason: 'probe_failed',
        detail: `agent list failed: ${'x'.repeat(5_000)}`,
      },
    ],
    costs: [700_000],
    policy: { ...policy, windowMs: 3_000, probeTimeoutMs: 4_000 },
  });
  const observation = await harness.observation;
  assert.equal(observation.receipt, 'unknown');
  assert.equal(observation.reason, 'probe_failed');
  assert.equal(observation.window_ms, 600_000);
  const detail = String(observation.detail);
  assert(detail.length <= MAX_OBSERVATION_DETAIL_CHARS);
  assert.match(detail, TRUNCATION_MARKER);
  assert.match(detail, /capped at 600000 ms/);
  assert.match(detail, /ran for 700000 ms/);
  // The finished observation still validates against the persisted schema.
  const validated = collabDeliveryObservationSchema.safeParse(observation);
  assert.equal(validated.success, true);
});

test('an over-run window without a long error keeps the whole note', async () => {
  const harness = observe({
    samples: [quietProbe],
    costs: [700_000],
    policy: { ...policy, windowMs: 3_000, probeTimeoutMs: 4_000 },
  });
  const observation = await harness.observation;
  assert.equal(observation.window_ms, 600_000);
  assert.equal(
    observation.detail,
    'Sample 1 returned after the 3000 ms budget; its reading is recorded but never classified. The recorded window is capped at 600000 ms; the prober ran for 700000 ms.',
  );
  assert.equal(
    collabDeliveryObservationSchema.safeParse(observation).success,
    true,
  );
});
