import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { bindNative } from '../../src/collab/lifecycle.js';
import { applyMessage, submitMessage } from '../../src/collab/messages.js';
import { claimResources } from '../../src/collab/resources.js';
import * as rollover from '../../src/collab/rollover.js';
import { initTask, readRecord, transact } from '../../src/collab/store.js';
import type {
  Identity,
  Message,
  MessageInput,
  TaskRecord,
} from '../../src/collab/types.js';
import {
  decideBootstrapWrite,
  registerPiBootstrapGuard,
  type BootstrapGuardOptions,
  type PiBootstrapGuardHost,
  type PiToolCallHandler,
  type TrustedRecordReader,
} from '../../src/hosts/integration/pi-bootstrap-guard.js';

// --- genuine protocol fixture: drive the real reducers to a completed writer transfer ---

const INPUT = `sha256:${'1'.repeat(64)}`;
const COORD: Identity = {
  agent_id: 'coordinator',
  session_id: 'coord-session',
  harness: 'pi',
};
const OLD: Identity = {
  agent_id: 'writer-a',
  session_id: 'session-a',
  harness: 'pi',
};
const NEXT: Identity = {
  agent_id: 'writer-b',
  session_id: 'session-b',
  harness: 'pi',
};

interface Fixture {
  readonly task: string;
  readonly root: string;
  readonly claims: string[];
  cleanup(): void;
}

function makeFixture(label: string): Fixture {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `pappra-guard-${label}-`)),
  );
  const domainRoot = join(root, 'domain');
  const task = join(domainRoot, 'tasks', 'sample');
  initTask(task, {
    taskId: 'sample',
    domainRoot,
    coordinator: {
      agent_id: COORD.agent_id,
      session_id: COORD.session_id,
      harness: 'pi',
      owner_epoch: 1,
      since: '2026-10-22T00:00:00Z',
    },
  });
  let clock = Date.parse('2026-10-22T00:00:00Z');
  const send = (input: MessageInput) => {
    const message = buildMessage(input, { clock: (clock += 1000) });
    const outcome = submitMessage(task, message, { clock: (clock += 1000) });
    assert.equal(
      outcome.ok,
      true,
      `submit ${input.type}: ${JSON.stringify(outcome)}`,
    );
    return message;
  };
  const claimed = claimResources(task, {
    resources: [
      { kind: 'path', path: join(root, 'work-a') },
      { kind: 'path', path: join(root, 'work-b') },
    ],
    holder: OLD,
    subtaskId: 'work',
    attempt: 1,
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const claims = claimed.ok
    ? claimed.claims.map((claim) => claim.claim_id)
    : [];
  send({
    message_id: 'msg-assign-work',
    type: 'ASSIGN',
    task_id: 'sample',
    from: COORD,
    to: OLD,
    subtask_id: 'work',
    attempt: 1,
    owner_epoch: 1,
    body: {
      assignment_digest: `sha256:${'a'.repeat(64)}`,
      input_revision: INPUT,
    },
  });
  const bound = transact(task, {
    actor: 'fixture',
    purpose: 'bind-source-native',
    apply: (record) => {
      const outcome = bindNative(record, {
        subtaskId: 'work',
        attempt: 1,
        runner: 'pi',
        sessionId: OLD.session_id,
        runId: 'run-source',
        missionId: null,
        observation: 'confirmed',
        evidenceRef: 'herdr:agent:w3:p3:settled',
        observedAt: '2026-10-22T00:30:00Z',
      });
      if (!outcome.ok) return outcome;
      return { record, op: 'bind-source-native', summary: {}, result: outcome };
    },
  });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  return {
    task,
    root,
    claims,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function load(task: string): TaskRecord {
  const record = readRecord(task);
  assert.ok(record, 'task record must exist');
  return record;
}

function claimEpochs(record: TaskRecord): Map<string, number> {
  return new Map(
    (record.claims ?? []).map((claim) => [
      claim.claim_id,
      claim.resource_epoch ?? 0,
    ]),
  );
}

function intentInput(fixture: Fixture): rollover.CreateRolloverIntentInput {
  const record = load(fixture.task);
  const epochs = claimEpochs(record);
  return {
    intent_id: 'intent-1',
    generation: 1,
    handoff_id: 'handoff-1',
    subtask_id: 'work',
    attempt: 1,
    input_revision: INPUT,
    from: OLD,
    to: NEXT,
    claims: fixture.claims.map((claimId) => ({
      claim_id: claimId,
      resource_epoch: epochs.get(claimId) ?? 0,
    })),
    bundle: {
      ref: 'handoff-bundles/bundle-1.json',
      digest: `sha256:${'b'.repeat(64)}`,
    },
    coordinator_epoch: 1,
    clock: Date.parse('2026-10-22T01:00:00Z'),
  };
}

const COMPLETE_INVENTORY: rollover.RolloverInventory = {
  completeness: 'complete',
  inflight: [],
  pending_approvals: [],
  pending_messages: [],
};

function applyTo(record: TaskRecord, message: Message): void {
  const outcome = applyMessage(record, message, {
    clock: Date.parse('2026-10-22T01:00:02Z'),
  });
  assert.equal(
    'ok' in outcome ? outcome.ok !== false : true,
    true,
    `apply ${message.type}: ${JSON.stringify(outcome)}`,
  );
}

function ackMessage(record: TaskRecord): Message {
  const message = buildMessage(
    {
      message_id: 'msg-ack-successor',
      type: 'ACK',
      task_id: 'sample',
      from: NEXT,
      to: COORD,
      reply_to: 'msg-assign-work',
      subtask_id: 'work',
      attempt: 1,
      owner_epoch: 1,
      body: {
        handoff_id: 'handoff-1',
        rollover_intent_id: 'intent-1',
        rollover_generation: 1,
        input_revision: INPUT,
      },
    },
    { clock: Date.parse('2026-10-22T01:00:01Z') },
  );
  applyTo(record, message);
  return message;
}

const SUCCESSOR_NATIVE = {
  agent_id: NEXT.agent_id,
  runner: 'pi',
  session_id: NEXT.session_id,
  run_id: 'run-successor',
  mission_id: null,
  evidence_ref: 'herdr:agent:w4:p2',
  observed_at: '2026-10-22T01:00:05Z',
};

function driveToConfirmed(fixture: Fixture): TaskRecord {
  const record = load(fixture.task);
  assert.equal(
    rollover.createRolloverIntent(record, intentInput(fixture)).ok,
    true,
  );
  assert.equal(
    rollover.prepareRolloverTransfer(record, {
      intent_id: 'intent-1',
      observation: 'confirmed',
      evidence_ref: 'herdr:agent:w3:p3:settled',
      inventory: COMPLETE_INVENTORY,
      clock: Date.parse('2026-10-22T01:00:00Z'),
    } as never).ok,
    true,
  );
  const ack = ackMessage(record);
  assert.equal(
    rollover.confirmRolloverReceiver(record, {
      intent_id: 'intent-1',
      message: ack,
      clock: Date.parse('2026-10-22T01:00:02Z'),
    }).ok,
    true,
  );
  return record;
}

function driveToCompleted(fixture: Fixture): TaskRecord {
  const record = driveToConfirmed(fixture);
  assert.equal(
    rollover.completeRolloverTransfer(record, {
      intent_id: 'intent-1',
      successor_native: SUCCESSOR_NATIVE,
      clock: Date.parse('2026-10-22T01:00:05Z'),
    }).ok,
    true,
  );
  return record;
}

function clone(record: TaskRecord): TaskRecord {
  return structuredClone(record);
}

// --- guard harness ---

class FakePi implements PiBootstrapGuardHost {
  handler: PiToolCallHandler | null = null;
  onCalls = 0;
  on(event: 'tool_call', handler: PiToolCallHandler): void {
    assert.equal(event, 'tool_call');
    this.onCalls += 1;
    this.handler = handler;
  }
}

interface CtxOptions {
  readonly throwSession?: boolean;
  readonly noManager?: boolean;
  readonly switchTo?: string | null;
}

function ctx(sessionId: string | null, options: CtxOptions = {}): unknown {
  let calls = 0;
  if (options.noManager) return {};
  return {
    sessionManager: {
      getSessionId: (): string | null => {
        calls += 1;
        if (options.throwSession) throw new Error('getSessionId failed');
        if (options.switchTo !== undefined && calls >= 2)
          return options.switchTo;
        return sessionId;
      },
    },
  };
}

function guardOptions(
  fixture: Fixture,
  originalEpochs: Map<string, number>,
  readRecord: TrustedRecordReader,
  overrides: Partial<BootstrapGuardOptions> = {},
): BootstrapGuardOptions {
  return {
    taskId: 'sample',
    intentId: 'intent-1',
    handoffId: 'handoff-1',
    generation: 1,
    subtaskId: 'work',
    attempt: 1,
    inputRevision: INPUT,
    coordinatorEpoch: 1,
    successor: {
      agentId: NEXT.agent_id,
      sessionId: NEXT.session_id,
      harness: 'pi',
    },
    claims: fixture.claims.map((claimId) => ({
      claimId,
      originalResourceEpoch: originalEpochs.get(claimId) ?? 0,
    })),
    readRecord,
    ...overrides,
  };
}

const WRITE = { toolName: 'write', input: {} };
const BASH = { toolName: 'bash', input: {} };
const READ = { toolName: 'read', input: {} };

function setup(label: string): {
  fixture: Fixture;
  originalEpochs: Map<string, number>;
  completed: TaskRecord;
} {
  const fixture = makeFixture(label);
  const originalEpochs = claimEpochs(load(fixture.task));
  const completed = driveToCompleted(fixture);
  return { fixture, originalEpochs, completed };
}

function workAttempt(record: TaskRecord) {
  return (record.attempts ?? []).find(
    (item) => item.subtask_id === 'work' && item.attempt === 1,
  );
}

test('denies non-read tools before the writer transfer is completed', async () => {
  const fixture = makeFixture('before');
  try {
    const originalEpochs = claimEpochs(load(fixture.task));
    const confirmed = driveToConfirmed(fixture); // receiver_confirmed, NOT completed
    const pi = new FakePi();
    registerPiBootstrapGuard(
      pi,
      guardOptions(fixture, originalEpochs, () => confirmed),
    );
    assert.ok(pi.handler);
    const decision = await pi.handler(WRITE, ctx(NEXT.session_id));
    assert.ok(decision);
    assert.equal(decision.block, true);
    assert.match(decision.reason, /handoff_not_completed/);
  } finally {
    fixture.cleanup();
  }
});

test('allows the first write (and vetted reads) after every completed-transfer condition matches', async () => {
  const { fixture, originalEpochs, completed } = setup('allow');
  try {
    const pi = new FakePi();
    const guard = registerPiBootstrapGuard(
      pi,
      guardOptions(fixture, originalEpochs, () => completed),
    );
    assert.ok(pi.handler);
    assert.equal(await pi.handler(WRITE, ctx(NEXT.session_id)), undefined);
    assert.equal(await pi.handler(BASH, ctx(NEXT.session_id)), undefined);
    assert.equal(await pi.handler(READ, ctx(NEXT.session_id)), undefined);
    assert.equal((completed.successions ?? []).length, 0); // first-work NOT required
    assert.equal(guard.status().mode, 'deny-until-completed-transfer');
  } finally {
    fixture.cleanup();
  }
});

test('a vetted read is refused for a mismatched or unknown native session', async () => {
  const { fixture, originalEpochs, completed } = setup('read-session');
  try {
    const pi = new FakePi();
    registerPiBootstrapGuard(
      pi,
      guardOptions(fixture, originalEpochs, () => completed),
    );
    assert.ok(pi.handler);
    const wrong = await pi.handler(READ, ctx('session-x'));
    assert.ok(wrong && wrong.block === true);
    const unknown = await pi.handler(READ, ctx(null, { noManager: true }));
    assert.ok(unknown && unknown.block === true);
  } finally {
    fixture.cleanup();
  }
});

test('re-denies on claim release, reassignment, coordinator-epoch drift and unraised resource epoch', async () => {
  const { fixture, originalEpochs, completed } = setup('claims');
  try {
    const run = async (
      mutate: (record: TaskRecord) => void,
      pattern: RegExp,
    ) => {
      const copy = clone(completed);
      mutate(copy);
      const pi = new FakePi();
      registerPiBootstrapGuard(
        pi,
        guardOptions(fixture, originalEpochs, () => copy),
      );
      assert.ok(pi.handler);
      const decision = await pi.handler(WRITE, ctx(NEXT.session_id));
      assert.ok(decision && decision.block === true);
      assert.match(decision.reason, pattern);
    };
    await run((r) => {
      const claim = (r.claims ?? [])[0];
      if (claim) claim.released_at = '2026-10-22T02:00:00Z';
    }, /claim_released/);
    await run((r) => {
      const claim = (r.claims ?? [])[0];
      if (claim) claim.holder = OLD;
    }, /claim_not_held_by_successor/);
    await run((r) => {
      if (r.coordinator) r.coordinator.owner_epoch = 2;
    }, /coordinator_epoch_drift/);
    await run((r) => {
      const claim = (r.claims ?? [])[0];
      if (claim) claim.resource_epoch = (claim.resource_epoch ?? 1) + 5;
    }, /claim_resource_epoch_not_raised/);
  } finally {
    fixture.cleanup();
  }
});

test('re-denies on current attempt input drift, a newer attempt, needs_input and native runner/session drift', async () => {
  const { fixture, originalEpochs, completed } = setup('attempt');
  try {
    const run = async (
      mutate: (record: TaskRecord) => void,
      pattern: RegExp,
    ) => {
      const copy = clone(completed);
      mutate(copy);
      const pi = new FakePi();
      registerPiBootstrapGuard(
        pi,
        guardOptions(fixture, originalEpochs, () => copy),
      );
      assert.ok(pi.handler);
      const decision = await pi.handler(WRITE, ctx(NEXT.session_id));
      assert.ok(decision && decision.block === true);
      assert.match(decision.reason, pattern);
    };
    // 1. Only the current attempt's input drifts; the immutable intent stays pinned.
    await run((r) => {
      const a = workAttempt(r);
      if (a) a.input_revision = `sha256:${'5'.repeat(64)}`;
    }, /attempt_input_drift/);
    // 2. A newer attempt for the same subtask supersedes the pinned one.
    await run((r) => {
      const a = workAttempt(r);
      if (a) {
        const newer = structuredClone(a);
        newer.attempt = 2;
        newer.state = 'assigned';
        (r.attempts ?? []).push(newer);
      }
    }, /attempt_superseded/);
    // 3. needs_input with no awaiting field is still a block.
    await run((r) => {
      const a = workAttempt(r);
      if (a) {
        a.state = 'needs_input';
        delete a.awaiting;
      }
    }, /attempt_not_actionable/);
    // 4. The native runner drifts to codex while the session string is unchanged.
    await run((r) => {
      const a = workAttempt(r);
      if (a) a.native.runner = 'codex';
    }, /native_binding_mismatch/);
    // The native session string drifts.
    await run((r) => {
      const a = workAttempt(r);
      if (a) a.native.session_id = 'session-drifted';
    }, /native_session_binding_mismatch/);
    // A terminal attempt is not actionable.
    await run((r) => {
      const a = workAttempt(r);
      if (a) a.state = 'failed';
    }, /attempt_not_actionable/);
  } finally {
    fixture.cleanup();
  }
});

test('refuses a conflicting handoff by same attempt and by overlapping claim resources', async () => {
  const { fixture, originalEpochs, completed } = setup('handoff');
  try {
    const run = async (mutate: (record: TaskRecord) => void) => {
      const copy = clone(completed);
      mutate(copy);
      const pi = new FakePi();
      registerPiBootstrapGuard(
        pi,
        guardOptions(fixture, originalEpochs, () => copy),
      );
      assert.ok(pi.handler);
      const decision = await pi.handler(WRITE, ctx(NEXT.session_id));
      assert.ok(decision && decision.block === true);
      assert.match(decision.reason, /conflicting_handoff/);
    };
    // Same subtask/attempt.
    await run((r) => {
      const base = (r.handoffs ?? [])[0];
      if (base) {
        const second = structuredClone(base);
        second.handoff_id = 'handoff-same';
        second.state = 'requested';
        (r.handoffs ?? []).push(second);
      }
    });
    // A different subtask that overlaps the same original claim resources (ownership snapshot).
    await run((r) => {
      const base = (r.handoffs ?? [])[0];
      if (base) {
        const overlap = structuredClone(base);
        overlap.handoff_id = 'handoff-overlap';
        overlap.subtask_id = 'other';
        overlap.attempt = 7;
        overlap.state = 'requested';
        (r.handoffs ?? []).push(overlap);
      }
    });
  } finally {
    fixture.cleanup();
  }
});

test('re-denies on ownership, handoff kind/target and out-of-range transfer boundary (R2)', async () => {
  const { fixture, originalEpochs, completed } = setup('r2');
  try {
    const run = async (
      mutate: (record: TaskRecord) => void,
      pattern: RegExp,
    ) => {
      const copy = clone(completed);
      mutate(copy);
      const pi = new FakePi();
      registerPiBootstrapGuard(
        pi,
        guardOptions(fixture, originalEpochs, () => copy),
      );
      assert.ok(pi.handler);
      const decision = await pi.handler(WRITE, ctx(NEXT.session_id));
      assert.ok(decision && decision.block === true);
      assert.match(decision.reason, pattern);
    };
    const findHandoff1 = (r: TaskRecord) =>
      (r.handoffs ?? []).find((h) => h.handoff_id === 'handoff-1');
    const findIntent1 = (r: TaskRecord) =>
      (r.rollover ?? []).find((i) => i.intent_id === 'intent-1');
    // 1. Ownership not transferred (unknown) despite an otherwise-matching attempt.
    await run((r) => {
      const a = workAttempt(r);
      if (a) a.ownership = 'unknown';
    }, /ownership_not_transferred/);
    // 2. Completed handoff `to` redirected to the old writer.
    await run((r) => {
      const h = findHandoff1(r);
      if (h) h.to = OLD;
    }, /handoff_to_mismatch/);
    // 3. Handoff kind is coordinator, not a writer transfer.
    await run((r) => {
      const h = findHandoff1(r);
      if (h) h.kind = 'coordinator';
    }, /handoff_not_writer/);
    // 4. Transfer boundary state_revision beyond the current record.
    await run((r) => {
      const i = findIntent1(r);
      if (i && i.transfer_boundary)
        i.transfer_boundary.state_revision = r.state_revision + 100;
    }, /transfer_boundary_state_revision_out_of_range/);
    // 5. Transfer boundary message_count beyond present history.
    await run((r) => {
      const i = findIntent1(r);
      if (i && i.transfer_boundary)
        i.transfer_boundary.message_count = (r.messages ?? []).length + 100;
    }, /transfer_boundary_message_count_out_of_range/);
  } finally {
    fixture.cleanup();
  }
});

test('guards ambiguous/duplicate ids so a first-match lookup cannot resolve a contradiction to allow', async () => {
  const { fixture, originalEpochs, completed } = setup('ambiguous');
  try {
    const run = async (
      mutate: (record: TaskRecord) => void,
      pattern: RegExp,
    ) => {
      const copy = clone(completed);
      mutate(copy);
      const pi = new FakePi();
      registerPiBootstrapGuard(
        pi,
        guardOptions(fixture, originalEpochs, () => copy),
      );
      assert.ok(pi.handler);
      const decision = await pi.handler(WRITE, ctx(NEXT.session_id));
      assert.ok(decision && decision.block === true);
      assert.match(decision.reason, pattern);
    };
    await run((r) => {
      const i = (r.rollover ?? [])[0];
      if (i) (r.rollover ?? []).push(structuredClone(i));
    }, /ambiguous_or_missing_intent/);
    await run((r) => {
      const h = (r.handoffs ?? [])[0];
      if (h) (r.handoffs ?? []).push(structuredClone(h));
    }, /ambiguous_or_missing_handoff/);
    await run((r) => {
      const a = workAttempt(r);
      if (a) (r.attempts ?? []).push(structuredClone(a));
    }, /ambiguous_or_missing_attempt/);
    await run((r) => {
      const c = (r.claims ?? [])[0];
      if (c) (r.claims ?? []).push(structuredClone(c));
    }, /ambiguous_or_missing_claim/);
  } finally {
    fixture.cleanup();
  }
});

test('rejects duplicate, empty or unsafe claim configuration at registration', () => {
  const pi = new FakePi();
  const base = {
    taskId: 'sample',
    intentId: 'intent-1',
    handoffId: 'handoff-1',
    generation: 1,
    subtaskId: 'work',
    attempt: 1,
    inputRevision: INPUT,
    coordinatorEpoch: 1,
    successor: {
      agentId: NEXT.agent_id,
      sessionId: NEXT.session_id,
      harness: 'pi',
    },
    readRecord: () => ({}),
  };
  assert.throws(
    () =>
      registerPiBootstrapGuard(pi, {
        ...base,
        claims: [
          { claimId: 'c1', originalResourceEpoch: 1 },
          { claimId: 'c1', originalResourceEpoch: 1 },
        ],
      }),
    /duplicate pinned claim id/,
  );
  assert.throws(
    () => registerPiBootstrapGuard(pi, { ...base, claims: [] }),
    /non-empty bounded set/,
  );
  assert.throws(
    () =>
      registerPiBootstrapGuard(pi, {
        ...base,
        claims: [
          { claimId: 'c1', originalResourceEpoch: Number.MAX_SAFE_INTEGER },
        ],
      }),
    /invalid claim reference/,
  );
});

test('requires exact claim set equality: an omitted/released original claim blocks', async () => {
  const { fixture, originalEpochs, completed } = setup('omit');
  try {
    const copy = clone(completed);
    const second = (copy.claims ?? [])[1];
    if (second) second.released_at = '2026-10-22T02:00:00Z'; // release the omitted claim in the record
    const firstClaim = fixture.claims[0];
    assert.ok(firstClaim);
    const pi = new FakePi();
    registerPiBootstrapGuard(
      pi,
      guardOptions(fixture, originalEpochs, () => copy, {
        claims: [
          {
            claimId: firstClaim,
            originalResourceEpoch: originalEpochs.get(firstClaim) ?? 0,
          },
        ],
      }),
    );
    assert.ok(pi.handler);
    const decision = await pi.handler(WRITE, ctx(NEXT.session_id));
    assert.ok(decision && decision.block === true);
    assert.match(decision.reason, /claim_set_mismatch/);
  } finally {
    fixture.cleanup();
  }
});

test('blocks on reader failure, non-record, a throwing tool-name getter and a throwing record accessor', async () => {
  const { fixture, originalEpochs, completed } = setup('throws');
  try {
    const mk = (reader: TrustedRecordReader) => {
      const pi = new FakePi();
      registerPiBootstrapGuard(
        pi,
        guardOptions(fixture, originalEpochs, reader),
      );
      assert.ok(pi.handler);
      return pi.handler;
    };
    const failed = await mk(() => {
      throw new Error('reader exploded');
    })(WRITE, ctx(NEXT.session_id));
    assert.ok(failed && failed.block === true);
    assert.match(failed.reason, /trusted_record_read_failed/);

    const invalid = await mk(() => ({ not: 'a record' }))(
      WRITE,
      ctx(NEXT.session_id),
    );
    assert.ok(invalid && invalid.block === true);
    assert.match(invalid.reason, /record_invalid/);

    // A throwing toolName accessor returns an explicit block, never a rejected promise.
    const evilEvent: unknown = {
      input: {},
      get toolName(): string {
        throw new Error('toolName accessor explodes');
      },
    };
    const handler = mk(() => completed);
    const malformed = await handler(evilEvent as never, ctx(NEXT.session_id));
    assert.ok(malformed && malformed.block === true);
    assert.match(malformed.reason, /malformed_tool_event/);

    // A throwing record accessor (proxy) fails closed during traversal.
    const evilRecord = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'then') return undefined; // stay awaitable; throw only on real traversal
          throw new Error('record accessor explodes');
        },
      },
    );
    const traversal = await mk(() => evilRecord)(WRITE, ctx(NEXT.session_id));
    assert.ok(traversal && traversal.block === true);
    assert.match(traversal.reason, /record_invalid|record_traversal_failed/);
  } finally {
    fixture.cleanup();
  }
});

test('a throwing session accessor blocks even reads; options and status are copied and frozen', async () => {
  const { fixture, originalEpochs, completed } = setup('copy');
  try {
    const options = guardOptions(fixture, originalEpochs, () => completed);
    const pi = new FakePi();
    const guard = registerPiBootstrapGuard(pi, options);
    assert.ok(pi.handler);
    const thrown = await pi.handler(
      READ,
      ctx(NEXT.session_id, { throwSession: true }),
    );
    assert.ok(thrown && thrown.block === true);
    (
      options.claims as { claimId: string; originalResourceEpoch: number }[]
    )[0] = {
      claimId: 'tampered',
      originalResourceEpoch: 999,
    };
    (options.successor as { sessionId: string }).sessionId = 'session-tampered';
    const status = guard.status();
    assert.equal(status.successor.sessionId, NEXT.session_id);
    assert.equal(status.pinnedClaimCount, fixture.claims.length);
    assert.equal(Object.isFrozen(status), true);
    assert.equal(await pi.handler(WRITE, ctx(NEXT.session_id)), undefined);
  } finally {
    fixture.cleanup();
  }
});

test('a native session switch during the async read denies conservatively', async () => {
  const { fixture, originalEpochs, completed } = setup('switch');
  try {
    const pi = new FakePi();
    registerPiBootstrapGuard(
      pi,
      guardOptions(fixture, originalEpochs, async () => completed),
    );
    assert.ok(pi.handler);
    const decision = await pi.handler(
      WRITE,
      ctx(NEXT.session_id, { switchTo: 'session-moved' }),
    );
    assert.ok(decision && decision.block === true);
    assert.match(decision.reason, /native_session_drift/);
  } finally {
    fixture.cleanup();
  }
});

test('overlapping callbacks stay isolated: one allows, the other blocks', async () => {
  const { fixture, originalEpochs, completed } = setup('overlap');
  try {
    const drifted = clone(completed);
    if (drifted.coordinator) drifted.coordinator.owner_epoch = 2;
    let toggle = false;
    const pi = new FakePi();
    registerPiBootstrapGuard(
      pi,
      guardOptions(fixture, originalEpochs, async () => {
        toggle = !toggle;
        return toggle ? completed : drifted;
      }),
    );
    assert.ok(pi.handler);
    const [first, second] = await Promise.all([
      pi.handler(WRITE, ctx(NEXT.session_id)),
      pi.handler(WRITE, ctx(NEXT.session_id)),
    ]);
    const outcomes = [first, second];
    assert.equal(outcomes.filter((d) => d === undefined).length, 1);
    assert.equal(outcomes.filter((d) => d && d.block === true).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('no model-accessible release surface and no first-work dependency', () => {
  const { fixture, originalEpochs, completed } = setup('surface');
  try {
    const pi = new FakePi();
    const guard = registerPiBootstrapGuard(
      pi,
      guardOptions(fixture, originalEpochs, () => completed),
    );
    assert.equal(pi.onCalls, 1);
    for (const forbidden of ['thaw', 'release', 'allow', 'unlock']) {
      assert.equal(
        (guard as unknown as Record<string, unknown>)[forbidden],
        undefined,
      );
    }
    const firstClaim = fixture.claims[0];
    const secondClaim = fixture.claims[1];
    assert.ok(firstClaim && secondClaim);
    const decision = decideBootstrapWrite(
      completed,
      {
        taskId: 'sample',
        intentId: 'intent-1',
        handoffId: 'handoff-1',
        generation: 1,
        subtaskId: 'work',
        attempt: 1,
        inputRevision: INPUT,
        coordinatorEpoch: 1,
        successor: {
          agentId: NEXT.agent_id,
          sessionId: NEXT.session_id,
          harness: 'pi',
        },
        claims: [
          {
            claimId: firstClaim,
            originalResourceEpoch: originalEpochs.get(firstClaim) ?? 0,
          },
          {
            claimId: secondClaim,
            originalResourceEpoch: originalEpochs.get(secondClaim) ?? 0,
          },
        ],
      },
      NEXT.session_id,
    );
    assert.equal(decision.allow, true);
    assert.equal((completed.successions ?? []).length, 0);
  } finally {
    fixture.cleanup();
  }
});
