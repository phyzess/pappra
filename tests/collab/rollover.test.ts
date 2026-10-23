import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { findHandoff } from '../../src/collab/handoff.js';
import { bindNative } from '../../src/collab/lifecycle.js';
import { applyMessage, submitMessage } from '../../src/collab/messages.js';
import { claimResources } from '../../src/collab/resources.js';
import { initTask, readRecord, transact } from '../../src/collab/store.js';
import * as rollover from '../../src/collab/rollover.js';
import { isTaskRecord } from '../../src/collab/validation.js';
import type {
  Identity,
  Message,
  MessageInput,
  TaskRecord,
} from '../../src/collab/types.js';

const INPUT = `sha256:${'1'.repeat(64)}`;
const OTHER_INPUT = `sha256:${'9'.repeat(64)}`;
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
    mkdtempSync(join(tmpdir(), `pappra-rollover-${label}-`)),
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
  // Fixtures bind truthful confirmed source-native evidence.
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

function intentInput(
  fixture: Fixture,
  overrides: Partial<rollover.CreateRolloverIntentInput> = {},
): rollover.CreateRolloverIntentInput {
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
    ...overrides,
  };
}

const COMPLETE_INVENTORY: rollover.RolloverInventory = {
  completeness: 'complete',
  inflight: [],
  pending_approvals: [],
  pending_messages: [],
};

/** Applies a protocol message to the in-memory record, the same path the store uses. */
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

function ackMessage(record: TaskRecord, body: Record<string, unknown> = {}) {
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
        ...body,
      },
    },
    { clock: Date.parse('2026-10-22T01:00:01Z') },
  );
  applyTo(record, message);
  return message;
}

function prepare(
  record: TaskRecord,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof rollover.prepareRolloverTransfer> {
  return rollover.prepareRolloverTransfer(record, {
    intent_id: 'intent-1',
    observation: 'confirmed',
    evidence_ref: 'herdr:agent:w3:p3:settled',
    inventory: COMPLETE_INVENTORY,
    clock: Date.parse('2026-10-22T01:00:00Z'),
    ...overrides,
  } as never);
}

function reportMessage(
  record: TaskRecord,
  {
    messageId = 'msg-report-first-work',
    from = NEXT,
    status = 'completed',
    body = {},
  }: {
    messageId?: string;
    from?: Identity;
    status?: string;
    body?: Record<string, unknown>;
  } = {},
) {
  const message = buildMessage(
    {
      message_id: messageId,
      type: 'REPORT',
      task_id: 'sample',
      from,
      to: COORD,
      subtask_id: 'work',
      attempt: 1,
      body: {
        status,
        input_revision: INPUT,
        handoff_id: 'handoff-1',
        rollover_generation: 1,
        ...body,
      },
    },
    { clock: Date.parse('2026-10-22T01:00:03Z') },
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

/** Drives intent → stop → ACK → complete, returning the live record. */
function driveToCompleted(fixture: Fixture): TaskRecord {
  const record = load(fixture.task);
  const created = rollover.createRolloverIntent(record, intentInput(fixture));
  assert.equal(created.ok, true, JSON.stringify(created));
  const prepared = prepare(record);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const ack = ackMessage(record);
  const confirmed = rollover.confirmRolloverReceiver(record, {
    intent_id: 'intent-1',
    message: ack,
    clock: Date.parse('2026-10-22T01:00:02Z'),
  });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  const completed = rollover.completeRolloverTransfer(record, {
    intent_id: 'intent-1',
    successor_native: SUCCESSOR_NATIVE,
    clock: Date.parse('2026-10-22T01:00:05Z'),
  });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  return record;
}

test('a writer rollover moves claims, reassigns the attempt and archives only the old session', () => {
  const fixture = makeFixture('happy');
  try {
    const before = load(fixture.task);
    const ownerEpochBefore = before.coordinator?.owner_epoch;
    const epochsBefore = claimEpochs(before);
    const record = driveToCompleted(fixture);

    assert.equal(record.coordinator?.owner_epoch, ownerEpochBefore);
    for (const claim of record.claims ?? []) {
      assert.equal(claim.holder?.agent_id, NEXT.agent_id);
      assert.equal(claim.holder?.session_id, NEXT.session_id);
      assert.equal(
        claim.resource_epoch,
        (epochsBefore.get(claim.claim_id) ?? 0) + 1,
      );
      assert.equal(claim.transferred_from?.session_id, OLD.session_id);
    }
    const attempt = (record.attempts ?? []).find(
      (item) => item.subtask_id === 'work' && item.attempt === 1,
    );
    assert.ok(attempt);
    assert.equal(attempt.assignee.session_id, NEXT.session_id);
    assert.equal(attempt.ownership, 'transferred');
    assert.equal(attempt.native.session_id, NEXT.session_id);
    assert.equal(attempt.native.run_id, 'run-successor');

    const report = reportMessage(record);
    const firstWork = rollover.recordRolloverFirstWork(record, {
      intent_id: 'intent-1',
      message: report,
      clock: Date.parse('2026-10-22T01:00:06Z'),
    });
    assert.equal(firstWork.ok, true, JSON.stringify(firstWork));
    if (!firstWork.ok) return;
    assert.equal(firstWork.succession.old_native.session_id, OLD.session_id);
    assert.equal(firstWork.succession.old_native.run_id, 'run-source');
    assert.equal(
      firstWork.succession.successor_native.session_id,
      NEXT.session_id,
    );
    assert.equal(firstWork.succession.routing, 'pending');
    assert.equal(firstWork.succession.native_archive, 'unavailable');
    assert.equal(firstWork.succession.history_retained, true);
    assert.equal('routing_removed' in firstWork.succession, false);
    assert.equal('archived' in attempt, false);
    assert.equal(
      'archived' in
        ((record.successions ?? [])[0] as unknown as Record<string, unknown>),
      false,
    );

    const replayed = rollover.recordRolloverFirstWork(record, {
      intent_id: 'intent-1',
      message: report,
    });
    assert.equal(replayed.ok, true);
    assert.equal(replayed.ok && replayed.replayed, true);
    assert.equal((record.successions ?? []).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('the intent stores immutable inputs, pins the source native identity and replays as a no-op', () => {
  const fixture = makeFixture('replay');
  try {
    const record = load(fixture.task);
    const created = rollover.createRolloverIntent(record, intentInput(fixture));
    assert.equal(created.ok, true, JSON.stringify(created));
    const snapshot = structuredClone(record);

    const replay = rollover.createRolloverIntent(record, intentInput(fixture));
    assert.equal(replay.ok, true);
    assert.equal(replay.ok && replay.replayed, true);
    assert.deepEqual(record, snapshot);

    const conflict = rollover.createRolloverIntent(
      record,
      intentInput(fixture, { input_revision: OTHER_INPUT }),
    );
    assert.equal(
      conflict.ok === false && conflict.reason,
      'intent_input_conflict',
    );
    assert.deepEqual(record, snapshot);

    // Caller-owned references cannot alter the pinned fields afterwards.
    const mutable = intentInput(fixture, { intent_id: 'intent-copy' });
    const mutableClaims = mutable.claims as {
      claim_id: string;
      resource_epoch: number;
    }[];
    const mutableBundle = mutable.bundle as { ref: string; digest: string };
    const createdCopy = rollover.createRolloverIntent(record, {
      ...mutable,
      subtask_id: 'other-work',
      handoff_id: 'handoff-copy',
      claims: mutableClaims.map((claim) => ({ ...claim })),
    });
    // A live intent already owns this writer, so the copy is refused without mutation.
    assert.equal(createdCopy.ok === false, true);
    mutableClaims[0]!.resource_epoch = 999;
    mutableBundle.ref = 'tampered';
    assert.equal(record.rollover?.[0]?.claims[0]?.resource_epoch, 1);
    assert.equal(
      record.rollover?.[0]?.bundle.ref,
      'handoff-bundles/bundle-1.json',
    );
  } finally {
    fixture.cleanup();
  }
});

test('source native identity must be confirmed, matching and retained', () => {
  const missing = makeFixture('source-native-missing');
  try {
    transact(missing.task, {
      actor: 'fixture',
      purpose: 'clear-native',
      apply: (record) => {
        const attempt = (record.attempts ?? []).find(
          (item) => item.subtask_id === 'work' && item.attempt === 1,
        );
        if (attempt) attempt.native.observation = 'unknown';
        return { record, op: 'clear-native', summary: {}, result: {} };
      },
    });
    const record = load(missing.task);
    const created = rollover.createRolloverIntent(record, intentInput(missing));
    assert.equal(
      created.ok === false && created.reason,
      'source_native_unconfirmed',
    );
    assert.equal((record.rollover ?? []).length, 0);
  } finally {
    missing.cleanup();
  }

  const mismatched = makeFixture('source-native-mismatch');
  try {
    transact(mismatched.task, {
      actor: 'fixture',
      purpose: 'foreign-native',
      apply: (record) => {
        const attempt = (record.attempts ?? []).find(
          (item) => item.subtask_id === 'work' && item.attempt === 1,
        );
        if (attempt) attempt.native.session_id = 'foreign-session';
        return { record, op: 'foreign-native', summary: {}, result: {} };
      },
    });
    const record = load(mismatched.task);
    const created = rollover.createRolloverIntent(
      record,
      intentInput(mismatched),
    );
    assert.equal(
      created.ok === false && created.reason,
      'source_native_mismatch',
    );
    assert.equal((record.rollover ?? []).length, 0);
  } finally {
    mismatched.cleanup();
  }
});

test('a competing live intent for the same writer is refused', () => {
  const fixture = makeFixture('competing');
  try {
    const record = load(fixture.task);
    const first = rollover.createRolloverIntent(record, intentInput(fixture));
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = rollover.createRolloverIntent(
      record,
      intentInput(fixture, { intent_id: 'intent-2', handoff_id: 'handoff-2' }),
    );
    assert.equal(second.ok === false && second.reason, 'intent_conflict');
    assert.equal((record.handoffs ?? []).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('a closed intent reports its state and never reopens the handoff', () => {
  const fixture = makeFixture('closed');
  try {
    const record = driveToCompleted(fixture);
    const replay = rollover.createRolloverIntent(record, intentInput(fixture));
    assert.equal(replay.ok && replay.replayed, true);
    assert.equal(replay.ok && replay.handoff_state, 'completed');
    const reopened = rollover.createRolloverIntent(
      record,
      intentInput(fixture, {
        intent_id: 'intent-reopen',
        handoff_id: 'handoff-1',
      }),
    );
    assert.equal(reopened.ok === false && reopened.reason, 'handoff_closed');
    const inspection = rollover.inspectRolloverIntent(record, 'intent-1');
    assert.equal(inspection.ok && inspection.handoff_state, 'completed');
  } finally {
    fixture.cleanup();
  }
});

test('unknown quiescence and non-complete inventory never authorize transfer', () => {
  const fixture = makeFixture('quiescence');
  try {
    const record = load(fixture.task);
    const created = rollover.createRolloverIntent(record, intentInput(fixture));
    assert.equal(created.ok, true, JSON.stringify(created));
    const before = structuredClone(record);

    const unknown = prepare(record, {
      observation: 'unknown',
      evidence_ref: null,
    });
    assert.equal(
      unknown.ok === false && unknown.reason,
      'old_writer_not_stopped',
    );
    assert.equal(findHandoff(record, 'handoff-1')?.state, 'requested');
    assert.deepEqual(record, before);

    const noEvidence = prepare(record, { evidence_ref: null });
    assert.equal(
      noEvidence.ok === false && noEvidence.reason,
      'stop_evidence_required',
    );

    const absent = rollover.prepareRolloverTransfer(record, {
      intent_id: 'intent-1',
      observation: 'confirmed',
      evidence_ref: 'herdr:agent:settled',
    } as never);
    assert.equal(absent.ok === false && absent.reason, 'inventory_required');

    for (const completeness of ['partial', 'unknown'] as const) {
      const incomplete = prepare(record, {
        inventory: { completeness, inflight: [], pending_approvals: [] },
      });
      assert.equal(
        incomplete.ok === false && incomplete.reason,
        'inventory_incomplete',
        completeness,
      );
    }

    const inflight = prepare(record, {
      inventory: {
        completeness: 'complete',
        inflight: ['tool'],
        pending_approvals: [],
        pending_messages: [],
      },
    });
    assert.equal(
      inflight.ok === false && inflight.reason,
      'incomplete_inventory',
    );
    const approvals = prepare(record, {
      inventory: {
        completeness: 'complete',
        inflight: [],
        pending_approvals: ['approval'],
        pending_messages: [],
      },
    });
    assert.equal(
      approvals.ok === false && approvals.reason,
      'incomplete_inventory',
    );
    const messages = prepare(record, {
      inventory: {
        completeness: 'complete',
        inflight: [],
        pending_approvals: [],
        pending_messages: ['msg'],
      },
    });
    assert.equal(
      messages.ok === false && messages.reason,
      'incomplete_inventory',
    );
    assert.deepEqual(record, before);
  } finally {
    fixture.cleanup();
  }
});

test('a blocked writer cannot open a rollover intent', () => {
  const fixture = makeFixture('blocked');
  try {
    const blocked = submitMessage(
      fixture.task,
      buildMessage({
        message_id: 'msg-block-work',
        type: 'BLOCK',
        task_id: 'sample',
        from: OLD,
        to: COORD,
        subtask_id: 'work',
        attempt: 1,
        body: { kind: 'clarification' },
      }),
    );
    assert.equal(blocked.ok, true);
    const record = load(fixture.task);
    const created = rollover.createRolloverIntent(record, intentInput(fixture));
    assert.equal(created.ok === false && created.reason, 'attempt_not_active');
  } finally {
    fixture.cleanup();
  }
});

test('an ACK must be stored, current and fully correlated to the intent', () => {
  const cases: readonly {
    readonly name: string;
    readonly reason: string;
    readonly submit: boolean;
    readonly from?: Identity;
    readonly to?: Identity;
    readonly replyTo?: string;
    readonly epoch?: number | null;
    readonly body?: Record<string, unknown>;
    readonly tamper?: boolean;
  }[] = [
    { name: 'unregistered', reason: 'ack_not_registered', submit: false },
    {
      name: 'old writer',
      reason: 'ack_identity_mismatch',
      submit: true,
      from: OLD,
    },
    {
      name: 'wrong recipient',
      reason: 'ack_recipient_mismatch',
      submit: true,
      to: OLD,
    },
    { name: 'stale epoch', reason: 'stale_epoch', submit: true, epoch: 2 },
    {
      name: 'wrong input',
      reason: 'ack_input_mismatch',
      submit: true,
      body: { input_revision: OTHER_INPUT },
    },
    {
      name: 'missing intent bootstrap',
      reason: 'ack_correlation_mismatch',
      submit: true,
      body: { rollover_intent_id: 'other-intent' },
    },
    {
      name: 'wrong handoff',
      reason: 'ack_correlation_mismatch',
      submit: true,
      body: { handoff_id: 'other-handoff' },
    },
    {
      name: 'wrong generation',
      reason: 'ack_correlation_mismatch',
      submit: true,
      body: { rollover_generation: 2 },
    },
    {
      name: 'wrong assignment bootstrap',
      reason: 'ack_bootstrap_mismatch',
      submit: true,
      replyTo: 'msg-assign-other',
    },
    {
      name: 'tampered',
      reason: 'ack_content_mismatch',
      submit: true,
      tamper: true,
    },
  ];
  for (const item of cases) {
    const fixture = makeFixture(`ack-${item.name.replace(/\s/g, '-')}`);
    try {
      const record = load(fixture.task);
      const created = rollover.createRolloverIntent(
        record,
        intentInput(fixture),
      );
      assert.equal(created.ok, true, JSON.stringify(created));
      const prepared = prepare(record);
      assert.equal(prepared.ok, true, JSON.stringify(prepared));

      const ack = buildMessage({
        message_id: 'msg-ack-case',
        type: 'ACK',
        task_id: 'sample',
        from: item.from ?? NEXT,
        to: item.to ?? COORD,
        reply_to: item.replyTo ?? 'msg-assign-work',
        subtask_id: 'work',
        attempt: 1,
        owner_epoch: item.epoch ?? 1,
        body: {
          handoff_id: 'handoff-1',
          rollover_intent_id: 'intent-1',
          rollover_generation: 1,
          input_revision: INPUT,
          ...item.body,
        },
      });
      if (item.submit) applyTo(record, ack);
      let supplied: Message = ack;
      if (item.tamper) {
        const copy = JSON.parse(JSON.stringify(ack)) as Message;
        copy.body['handoff_id'] = 'tampered';
        supplied = copy;
      }
      const confirmed = rollover.confirmRolloverReceiver(record, {
        intent_id: 'intent-1',
        message: supplied,
      });
      assert.equal(confirmed.ok, false, item.name);
      assert.equal(
        confirmed.ok === false && confirmed.reason,
        item.reason,
        item.name,
      );
      assert.equal(findHandoff(record, 'handoff-1')?.state, 'transferring');
    } finally {
      fixture.cleanup();
    }
  }
});

test('confirmation must precede completion, a stale epoch blocks it and steps replay as no-ops', () => {
  const fixture = makeFixture('ordering');
  try {
    const record = load(fixture.task);
    const created = rollover.createRolloverIntent(record, intentInput(fixture));
    assert.equal(created.ok, true);
    const early = rollover.completeRolloverTransfer(record, {
      intent_id: 'intent-1',
      successor_native: SUCCESSOR_NATIVE,
    });
    assert.equal(early.ok === false && early.reason, 'handoff_not_ready');

    const prepared = prepare(record);
    assert.equal(prepared.ok, true);
    const preparedAgain = prepare(record);
    assert.equal(preparedAgain.ok && preparedAgain.replayed, true);
    const conflictingPrepare = prepare(record, {
      evidence_ref: 'other-evidence',
    });
    assert.equal(
      conflictingPrepare.ok === false && conflictingPrepare.reason,
      'prepare_conflict',
    );

    const ack = ackMessage(record);
    const confirmed = rollover.confirmRolloverReceiver(record, {
      intent_id: 'intent-1',
      message: ack,
    });
    assert.equal(confirmed.ok, true);
    const confirmedAgain = rollover.confirmRolloverReceiver(record, {
      intent_id: 'intent-1',
      message: ack,
    });
    assert.equal(confirmedAgain.ok && confirmedAgain.replayed, true);

    record.coordinator = {
      ...(record.coordinator ?? {
        agent_id: COORD.agent_id,
        session_id: COORD.session_id,
        harness: 'pi',
        since: '2026-10-22T00:00:00Z',
      }),
      owner_epoch: 2,
    };
    const stale = rollover.completeRolloverTransfer(record, {
      intent_id: 'intent-1',
      successor_native: SUCCESSOR_NATIVE,
    });
    assert.equal(stale.ok === false && stale.reason, 'stale_epoch');
    assert.equal(record.attempts?.[0]?.assignee.agent_id, OLD.agent_id);

    record.coordinator = { ...record.coordinator, owner_epoch: 1 };
    const completed = rollover.completeRolloverTransfer(record, {
      intent_id: 'intent-1',
      successor_native: SUCCESSOR_NATIVE,
    });
    assert.equal(completed.ok, true, JSON.stringify(completed));
    const completedAgain = rollover.completeRolloverTransfer(record, {
      intent_id: 'intent-1',
      successor_native: { ...SUCCESSOR_NATIVE, runner: 'other-runner' },
    });
    assert.equal(
      completedAgain.ok === false && completedAgain.reason,
      'transfer_already_completed',
    );
  } finally {
    fixture.cleanup();
  }
});

test('ownership drift refuses the transfer without partial mutation', () => {
  const fixture = makeFixture('drift');
  try {
    const record = load(fixture.task);
    const created = rollover.createRolloverIntent(record, intentInput(fixture));
    assert.equal(created.ok, true);
    prepare(record);
    const ack = ackMessage(record);
    const confirmed = rollover.confirmRolloverReceiver(record, {
      intent_id: 'intent-1',
      message: ack,
    });
    assert.equal(confirmed.ok, true);
    const claim = record.claims[0]!;
    claim.resource_epoch = (claim.resource_epoch ?? 0) + 1;
    const before = structuredClone(record);
    const result = rollover.completeRolloverTransfer(record, {
      intent_id: 'intent-1',
      successor_native: SUCCESSOR_NATIVE,
    });
    assert.equal(result.ok === false && result.reason, 'claim_epoch_mismatch');
    assert.equal(record.attempts?.[0]?.assignee.agent_id, OLD.agent_id);
    assert.equal(record.rollover?.[0]?.transfer_boundary, null);
    assert.equal(record.claims[0]?.holder?.agent_id, OLD.agent_id);
    assert.deepEqual(
      record.claims.map((item) => item.resource_epoch),
      before.claims.map((item) => item.resource_epoch),
    );
  } finally {
    fixture.cleanup();
  }
});

test('successor native identity must match the intent receiver', () => {
  const fixture = makeFixture('successor-native');
  try {
    const record = load(fixture.task);
    rollover.createRolloverIntent(record, intentInput(fixture));
    prepare(record);
    const ack = ackMessage(record);
    rollover.confirmRolloverReceiver(record, {
      intent_id: 'intent-1',
      message: ack,
    });
    const snapshot = structuredClone(record);
    const unrelatedAgent = rollover.completeRolloverTransfer(record, {
      intent_id: 'intent-1',
      successor_native: { ...SUCCESSOR_NATIVE, agent_id: 'unrelated-agent' },
    });
    assert.equal(
      unrelatedAgent.ok === false && unrelatedAgent.reason,
      'successor_native_mismatch',
    );
    const unrelatedSession = rollover.completeRolloverTransfer(record, {
      intent_id: 'intent-1',
      successor_native: { ...SUCCESSOR_NATIVE, session_id: 'unrelated-native' },
    });
    assert.equal(
      unrelatedSession.ok === false && unrelatedSession.reason,
      'successor_native_mismatch',
    );
    assert.deepEqual(record, snapshot);
  } finally {
    fixture.cleanup();
  }
});

test('first work needs current input, exact epochs and the pinned successor native', () => {
  const fixture = makeFixture('first-work');
  try {
    const record = load(fixture.task);
    const created = rollover.createRolloverIntent(record, intentInput(fixture));
    assert.equal(created.ok, true, JSON.stringify(created));
    const early = rollover.recordRolloverFirstWork(record, {
      intent_id: 'intent-1',
      message: reportMessage(record),
    });
    assert.equal(early.ok === false && early.reason, 'transfer_not_completed');

    const completed = driveToCompleted(fixture);
    const recordAfter = completed;

    const stale = reportMessage(recordAfter, {
      messageId: 'msg-report-old',
      from: OLD,
    });
    const staleResult = rollover.recordRolloverFirstWork(recordAfter, {
      intent_id: 'intent-1',
      message: stale,
    });
    assert.equal(
      staleResult.ok === false && staleResult.reason,
      'report_sender_mismatch',
    );
    const staleEntry = (recordAfter.results ?? []).find(
      (entry) => entry.message_id === stale.message_id,
    );
    assert.equal(staleEntry?.classification, 'stale_sender');

    const wrongGeneration = reportMessage(recordAfter, {
      messageId: 'msg-report-generation',
      status: 'running',
      body: { rollover_generation: 3 },
    });
    const generationResult = rollover.recordRolloverFirstWork(recordAfter, {
      intent_id: 'intent-1',
      message: wrongGeneration,
    });
    assert.equal(
      generationResult.ok === false && generationResult.reason,
      'report_correlation_mismatch',
    );

    const good = reportMessage(recordAfter, { messageId: 'msg-report-good' });
    const ok = rollover.recordRolloverFirstWork(recordAfter, {
      intent_id: 'intent-1',
      message: good,
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const other = reportMessage(recordAfter, { messageId: 'msg-report-later' });
    const again = rollover.recordRolloverFirstWork(recordAfter, {
      intent_id: 'intent-1',
      message: other,
    });
    assert.equal(
      again.ok === false && again.reason,
      'first_work_already_recorded',
    );
    assert.equal((recordAfter.successions ?? []).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('input, claim epoch, native and attempt drift all block the history marker', () => {
  const cases: readonly {
    readonly name: string;
    readonly reason: string;
    readonly mutate: (record: TaskRecord) => void;
  }[] = [
    {
      name: 'input drift',
      reason: 'input_changed',
      mutate: (record) => {
        const attempt = (record.attempts ?? []).find(
          (item) => item.subtask_id === 'work' && item.attempt === 1,
        );
        if (attempt) attempt.input_revision = OTHER_INPUT;
      },
    },
    {
      name: 'claim epoch drift',
      reason: 'claim_epoch_mismatch',
      mutate: (record) => {
        const claim = record.claims[0]!;
        claim.resource_epoch = (claim.resource_epoch ?? 0) + 10;
      },
    },
    {
      name: 'native run drift',
      reason: 'native_identity_mismatch',
      mutate: (record) => {
        const attempt = (record.attempts ?? []).find(
          (item) => item.subtask_id === 'work' && item.attempt === 1,
        );
        if (attempt) attempt.native.run_id = 'run-drifted';
      },
    },
    {
      name: 'superseded attempt',
      reason: 'attempt_superseded',
      mutate: (record) => {
        const attempt = (record.attempts ?? []).find(
          (item) => item.subtask_id === 'work' && item.attempt === 1,
        );
        if (attempt) {
          record.attempts = [
            ...(record.attempts ?? []),
            { ...structuredClone(attempt), attempt: 2, state: 'assigned' },
          ];
        }
      },
    },
  ];
  for (const item of cases) {
    const fixture = makeFixture(`first-work-${item.name.replace(/\s/g, '-')}`);
    try {
      const record = driveToCompleted(fixture);
      const report = reportMessage(record, { messageId: 'msg-report-case' });
      item.mutate(record);
      const before = (record.successions ?? []).length;
      const result = rollover.recordRolloverFirstWork(record, {
        intent_id: 'intent-1',
        message: report,
      });
      assert.equal(result.ok, false, item.name);
      assert.equal(
        result.ok === false && result.reason,
        item.reason,
        item.name,
      );
      assert.equal((record.successions ?? []).length, before, item.name);
    } finally {
      fixture.cleanup();
    }
  }
});

test('a failed successor report closes the attempt and never authorizes history', () => {
  const fixture = makeFixture('first-work-failed');
  try {
    const record = driveToCompleted(fixture);
    const failed = reportMessage(record, {
      messageId: 'msg-report-failed',
      status: 'failed',
    });
    const failedResult = rollover.recordRolloverFirstWork(record, {
      intent_id: 'intent-1',
      message: failed,
    });
    assert.equal(
      failedResult.ok === false && failedResult.reason,
      'report_not_admitted',
    );
    assert.equal(failedResult.ok === false && failedResult['status'], 'failed');
    assert.equal((record.successions ?? []).length, 0);

    const late = reportMessage(record, { messageId: 'msg-report-late' });
    const lateResult = rollover.recordRolloverFirstWork(record, {
      intent_id: 'intent-1',
      message: late,
    });
    assert.equal(
      lateResult.ok === false && lateResult.reason,
      'report_not_admitted',
    );
    assert.equal(
      lateResult.ok === false && lateResult['classification'],
      'late',
    );
    assert.equal((record.successions ?? []).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('malformed or oversized rollover collections are refused instead of throwing', () => {
  const fixture = makeFixture('malformed');
  try {
    const record = load(fixture.task);
    const created = rollover.createRolloverIntent(record, intentInput(fixture));
    assert.equal(created.ok, true, JSON.stringify(created));

    const objectRollover = {
      ...record,
      rollover: {},
    } as unknown as TaskRecord;
    const createdBad = rollover.createRolloverIntent(
      objectRollover,
      intentInput(fixture),
    );
    assert.equal(
      createdBad.ok === false && createdBad.reason,
      'record_invalid',
    );
    const inspectedBad = rollover.inspectRolloverIntent(
      objectRollover,
      'intent-1',
    );
    assert.equal(
      inspectedBad.ok === false && inspectedBad.reason,
      'record_invalid',
    );

    const badSuccessions = {
      ...record,
      successions: 'nope',
    } as unknown as TaskRecord;
    const preparedBad = prepare(badSuccessions);
    assert.equal(
      preparedBad.ok === false && preparedBad.reason,
      'record_invalid',
    );

    const oversized = {
      ...record,
      rollover: Array.from({ length: 33 }, (_value, index) => ({
        ...(record.rollover ?? [])[0]!,
        intent_id: `intent-extra-${index}`,
      })),
    } as unknown as TaskRecord;
    const createdOversized = rollover.createRolloverIntent(
      oversized,
      intentInput(fixture),
    );
    assert.equal(
      createdOversized.ok === false && createdOversized.reason,
      'record_too_large',
    );

    const invalidShape = {
      ...record,
      rollover: [{ ...(record.rollover ?? [])[0]!, bundle: { ref: 'x' } }],
    } as unknown as TaskRecord;
    const createdInvalid = rollover.createRolloverIntent(
      invalidShape,
      intentInput(fixture),
    );
    assert.equal(
      createdInvalid.ok === false && createdInvalid.reason,
      'record_invalid',
    );
  } finally {
    fixture.cleanup();
  }
});

test('legacy records without rollover fields still validate and inspect cleanly', () => {
  const fixture = makeFixture('legacy');
  try {
    const record = load(fixture.task);
    delete record.rollover;
    delete record.successions;
    assert.equal(isTaskRecord(record), true);
    const inspection = rollover.inspectRolloverIntent(record, 'missing');
    assert.equal(
      inspection.ok === false && inspection.reason,
      'unknown_intent',
    );
  } finally {
    fixture.cleanup();
  }
});

test('the whole rollover persists through the guarded task store', () => {
  const fixture = makeFixture('persist');
  try {
    const created = transact(fixture.task, {
      actor: 'test',
      purpose: 'rollover-intent',
      apply: (record) => {
        const result = rollover.createRolloverIntent(
          record,
          intentInput(fixture),
        );
        if (!result.ok) return result;
        return {
          record,
          op: 'rollover-intent',
          summary: { intent_id: result.intent.intent_id },
          result,
        };
      },
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(isTaskRecord(load(fixture.task)), true);

    const prepared = transact(fixture.task, {
      actor: 'test',
      purpose: 'rollover-prepare',
      apply: (record) => {
        const result = prepare(record);
        if (!result.ok) return result;
        return { record, op: 'rollover-prepare', summary: {}, result };
      },
    });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));

    const ackMessageValue = buildMessage({
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
    });
    const ackOutcome = submitMessage(fixture.task, ackMessageValue);
    assert.equal(ackOutcome.ok, true, JSON.stringify(ackOutcome));

    const confirmed = transact(fixture.task, {
      actor: 'test',
      purpose: 'rollover-confirm',
      apply: (record) => {
        const result = rollover.confirmRolloverReceiver(record, {
          intent_id: 'intent-1',
          message: ackMessageValue,
        });
        if (!result.ok) return result;
        return { record, op: 'rollover-confirm', summary: {}, result };
      },
    });
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));

    const completed = transact(fixture.task, {
      actor: 'test',
      purpose: 'rollover-complete',
      apply: (record) => {
        const result = rollover.completeRolloverTransfer(record, {
          intent_id: 'intent-1',
          successor_native: SUCCESSOR_NATIVE,
        });
        if (!result.ok) return result;
        return { record, op: 'rollover-complete', summary: {}, result };
      },
    });
    assert.equal(completed.ok, true, JSON.stringify(completed));

    const report = buildMessage({
      message_id: 'msg-report-first-work',
      type: 'REPORT',
      task_id: 'sample',
      from: NEXT,
      to: COORD,
      subtask_id: 'work',
      attempt: 1,
      body: {
        status: 'completed',
        input_revision: INPUT,
        handoff_id: 'handoff-1',
        rollover_generation: 1,
      },
    });
    const reportOutcome = submitMessage(fixture.task, report);
    assert.equal(reportOutcome.ok, true, JSON.stringify(reportOutcome));

    const firstWork = transact(fixture.task, {
      actor: 'test',
      purpose: 'rollover-first-work',
      apply: (record) => {
        const result = rollover.recordRolloverFirstWork(record, {
          intent_id: 'intent-1',
          message: report,
        });
        if (!result.ok) return result;
        return { record, op: 'rollover-first-work', summary: {}, result };
      },
    });
    assert.equal(firstWork.ok, true, JSON.stringify(firstWork));

    const persisted = load(fixture.task);
    assert.equal(persisted.rollover?.[0]?.transfer_boundary !== null, true);
    assert.equal(
      persisted.successions?.[0]?.old_native.session_id,
      OLD.session_id,
    );
    assert.equal(persisted.successions?.[0]?.routing, 'pending');
    assert.equal(persisted.coordinator?.owner_epoch, 1);
    assert.equal(isTaskRecord(persisted), true);
  } finally {
    fixture.cleanup();
  }
});

test('source native drift blocks every pre-transfer step', () => {
  for (const field of ['session_id', 'run_id'] as const) {
    const fixture = makeFixture(`source-drift-${field}`);
    try {
      const record = load(fixture.task);
      rollover.createRolloverIntent(record, intentInput(fixture));
      const prepared = prepare(record);
      assert.equal(prepared.ok, true, JSON.stringify(prepared));

      const attempt = (record.attempts ?? []).find(
        (item) => item.subtask_id === 'work' && item.attempt === 1,
      );
      assert.ok(attempt);
      if (field === 'session_id') attempt.native.session_id = 'foreign-session';
      else attempt.native.run_id = 'foreign-run';

      const ack = ackMessage(record);
      const confirmed = rollover.confirmRolloverReceiver(record, {
        intent_id: 'intent-1',
        message: ack,
      });
      assert.equal(confirmed.ok, false, field);
      assert.equal(
        confirmed.ok === false && confirmed.reason,
        'source_native_drift',
        field,
      );
      assert.equal(findHandoff(record, 'handoff-1')?.state, 'transferring');
    } finally {
      fixture.cleanup();
    }
  }
});

test('a superseded source attempt cannot transfer ownership', () => {
  const fixture = makeFixture('superseded-transfer');
  try {
    const record = load(fixture.task);
    rollover.createRolloverIntent(record, intentInput(fixture));
    prepare(record);
    const ack = ackMessage(record);
    const confirmed = rollover.confirmRolloverReceiver(record, {
      intent_id: 'intent-1',
      message: ack,
    });
    assert.equal(confirmed.ok, true);

    const attempt = (record.attempts ?? []).find(
      (item) => item.subtask_id === 'work' && item.attempt === 1,
    );
    assert.ok(attempt);
    record.attempts = [
      ...(record.attempts ?? []),
      { ...structuredClone(attempt), attempt: 2, state: 'assigned' },
    ];
    const completed = rollover.completeRolloverTransfer(record, {
      intent_id: 'intent-1',
      successor_native: SUCCESSOR_NATIVE,
    });
    assert.equal(
      completed.ok === false && completed.reason,
      'attempt_superseded',
    );
    assert.equal(findHandoff(record, 'handoff-1')?.state, 'receiver_confirmed');
    assert.equal(record.claims[0]?.holder?.agent_id, OLD.agent_id);
  } finally {
    fixture.cleanup();
  }
});

test('malformed record entries are refused instead of throwing', () => {
  const fixture = makeFixture('malformed-entry');
  try {
    const record = load(fixture.task);
    rollover.createRolloverIntent(record, intentInput(fixture));
    const malformed = {
      ...record,
      attempts: [null],
    } as unknown as TaskRecord;

    const created = rollover.createRolloverIntent(
      malformed,
      intentInput(fixture),
    );
    assert.equal(created.ok === false && created.reason, 'record_invalid');
    const inspected = rollover.inspectRolloverIntent(malformed, 'intent-1');
    assert.equal(inspected.ok === false && inspected.reason, 'record_invalid');
    const prepared = prepare(malformed);
    assert.equal(prepared.ok === false && prepared.reason, 'record_invalid');
    const ack = buildMessage({
      message_id: 'msg-ack-malformed',
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
    });
    const confirmed = rollover.confirmRolloverReceiver(malformed, {
      intent_id: 'intent-1',
      message: ack,
    });
    assert.equal(confirmed.ok === false && confirmed.reason, 'record_invalid');
    const completed = rollover.completeRolloverTransfer(malformed, {
      intent_id: 'intent-1',
      successor_native: SUCCESSOR_NATIVE,
    });
    assert.equal(completed.ok === false && completed.reason, 'record_invalid');
    const firstWork = rollover.recordRolloverFirstWork(malformed, {
      intent_id: 'intent-1',
      message: ack,
    });
    assert.equal(firstWork.ok === false && firstWork.reason, 'record_invalid');
  } finally {
    fixture.cleanup();
  }
});

test('a malformed successor native is refused and leaves a persistable record', () => {
  const fixture = makeFixture('malformed-successor');
  try {
    const record = load(fixture.task);
    rollover.createRolloverIntent(record, intentInput(fixture));
    prepare(record);
    const ack = ackMessage(record);
    rollover.confirmRolloverReceiver(record, {
      intent_id: 'intent-1',
      message: ack,
    });
    const snapshot = structuredClone(record);

    const badRun = rollover.completeRolloverTransfer(record, {
      intent_id: 'intent-1',
      successor_native: {
        ...SUCCESSOR_NATIVE,
        run_id: { invalid: true },
      } as unknown as typeof SUCCESSOR_NATIVE,
    });
    assert.equal(
      badRun.ok === false && badRun.reason,
      'successor_native_invalid',
    );
    assert.deepEqual(record, snapshot);
    assert.equal(isTaskRecord(record), true);
    assert.equal(record.claims[0]?.holder?.agent_id, OLD.agent_id);
  } finally {
    fixture.cleanup();
  }
});

test('claim epoch drift blocks confirmation, and inventory replay needs exact content', () => {
  const drift = makeFixture('ack-epoch-drift');
  try {
    const record = load(drift.task);
    rollover.createRolloverIntent(record, intentInput(drift));
    prepare(record);
    const claim = record.claims[0]!;
    claim.resource_epoch = (claim.resource_epoch ?? 0) + 5;
    const ack = ackMessage(record);
    const confirmed = rollover.confirmRolloverReceiver(record, {
      intent_id: 'intent-1',
      message: ack,
    });
    assert.equal(
      confirmed.ok === false && confirmed.reason,
      'claim_epoch_mismatch',
    );
    assert.equal(findHandoff(record, 'handoff-1')?.state, 'transferring');
  } finally {
    drift.cleanup();
  }

  const inventory = makeFixture('inventory-replay');
  try {
    const record = load(inventory.task);
    rollover.createRolloverIntent(record, intentInput(inventory));
    const prepared = prepare(record);
    assert.equal(prepared.ok, true);
    const replaySame = prepare(record);
    assert.equal(replaySame.ok && replaySame.replayed, true);

    // Same counts, different content: the pinned inventory fingerprint must differ.
    const changed = prepare(record, {
      inventory: {
        completeness: 'complete',
        inflight: [],
        pending_approvals: [],
        pending_messages: [],
        partial_outputs: ['different'],
      },
    });
    assert.equal(changed.ok === false && changed.reason, 'prepare_conflict');

    // A partial inventory cannot replay a completed preparation.
    const partial = prepare(record, {
      inventory: {
        completeness: 'partial',
        inflight: [],
        pending_approvals: [],
        pending_messages: [],
      },
    });
    assert.equal(
      partial.ok === false && partial.reason,
      'inventory_incomplete',
    );

    const missingMessages = rollover.prepareRolloverTransfer(record, {
      intent_id: 'intent-1',
      observation: 'confirmed',
      evidence_ref: 'herdr:agent:w3:p3:settled',
      inventory: {
        completeness: 'complete',
        inflight: [],
        pending_approvals: [],
      },
    } as never);
    assert.equal(
      missingMessages.ok === false && missingMessages.reason,
      'inventory_incomplete',
    );

    const oversized = prepare(record, {
      inventory: {
        completeness: 'complete',
        inflight: [],
        pending_approvals: [],
        pending_messages: [],
        partial_outputs: Array.from(
          { length: 65 },
          (_value, index) => `item-${index}`,
        ),
      },
    });
    assert.equal(
      oversized.ok === false && oversized.reason,
      'inventory_too_large',
    );
  } finally {
    inventory.cleanup();
  }
});
