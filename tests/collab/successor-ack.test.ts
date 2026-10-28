import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { applyHandoffRequest } from '../../src/app/collab-handoff.js';
import {
  applySuccessorAck,
  type SuccessorAckOptions,
} from '../../src/app/collab-successor/ack.js';
import { readSuccessorAck } from '../../src/app/collab-successor/journal.js';
import {
  SUCCESSOR_INTENT_SCHEMA,
  SUCCESSOR_OUTCOME_SCHEMA,
  successorDir,
  successorFile,
  type SuccessorIdentity,
} from '../../src/app/collab-successor/types.js';
import {
  type TaskStoreFailure,
  type TaskStoreResult,
} from '../../src/app/collab-task-store.js';
import { writeJsonExclusive } from '../../src/app/collab-workflow/context.js';
import { buildMessage, registerMessage } from '../../src/collab/envelope.js';
import {
  beginHandoff,
  confirmReceiver,
  markTransferring,
  rebindReceiver,
} from '../../src/collab/handoff.js';
import { submitMessage } from '../../src/collab/messages.js';
import { readRecord, transact } from '../../src/collab/store.js';
import type { Identity } from '../../src/collab/types.js';
import { COLLAB_HANDOFF_REQUEST_SCHEMA } from '../../src/schemas/collaboration.js';
import { COORDINATOR } from './handoff-fixtures.js';
import {
  makeTaskDomain,
  snapshotTree,
  type TaskDomainFixture,
} from './task-resources-fixtures.js';

const REQUEST_ID = 'suc-1';
const HANDOFF_ID = 'handoff-coord-1';
const PANE = 'w9:p3';
const CLOCK = Date.parse('2026-10-27T07:00:00.000Z');
const CHECKPOINT_TEXT =
  '# Checkpoint\n\nPhase 3 successor briefing for the sample task.\n';

const SUCCESSOR: Identity = {
  agent_id: 'successor',
  session_id: 'successor-session',
  harness: 'claude',
};
const PLACEHOLDER: Identity = {
  agent_id: 'successor',
  session_id: 'pending-identity',
  harness: 'claude',
};
const IMPOSTOR = {
  agent_id: 'impostor',
  session_id: 'impostor-session',
  harness: 'codex',
} as const;

const digestOf = (value: string | Buffer): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

type AckValue = {
  schema: string;
  ok: boolean;
  status: string;
  task_id: string;
  request_id: string;
  handoff_id: string;
  identity: {
    agent_id: string;
    session_id: string;
    harness: string;
    cwd: string;
  };
  message: { message_id: string; digest: string; duplicate: boolean };
  briefing: {
    checkpoint: { file: string; digest: string; bytes: number; text: string };
    handoff: {
      state: string;
      owner_epoch: number;
      counts: Record<string, number>;
    };
    next: string;
  };
  warning?: { code: string; detail: string };
  limits: string[];
};

interface FixtureOptions {
  readonly rebind?: boolean;
  readonly transfer?: boolean;
  readonly identity?: SuccessorIdentity | null;
  readonly status?: 'launched' | 'identity_unavailable';
  readonly paneId?: string;
  readonly requestId?: string;
  readonly checkpointText?: string;
  readonly checkpointDigest?: string;
  readonly checkpoint?: 'file' | 'symlink' | 'missing';
}

interface Fixture {
  readonly domain: TaskDomainFixture;
  readonly taskRoot: string;
  readonly requestId: string;
  readonly handoffId: string;
  readonly checkpointFile: string;
}

interface AckOverrides {
  readonly callerPane?: string | null;
  readonly callerCodexThread?: string | null;
  readonly apply?: boolean;
  readonly maxCheckpointBytes?: number;
}

/**
 * Drives one coordinator handoff to the recorded state and writes the launcher journal the
 * acknowledgement reads. Every knob exists so a single failure branch can be reached without
 * touching the module under test.
 */
function makeFixture(label: string, options: FixtureOptions = {}): Fixture {
  const domain = makeTaskDomain(label, ['sample']);
  const taskRoot = domain.tasks.sample!;
  const requestId = options.requestId ?? REQUEST_ID;
  const directory = successorDir(taskRoot);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const text = options.checkpointText ?? CHECKPOINT_TEXT;
  const checkpointFile = join(directory, 'checkpoint.md');
  if (options.checkpoint === 'symlink') {
    const target = join(directory, 'checkpoint-target.md');
    writeFileSync(target, text);
    symlinkSync(target, checkpointFile);
  } else if (options.checkpoint !== 'missing') {
    writeFileSync(checkpointFile, text);
  }

  const rebind = options.rebind ?? true;
  const transfer = options.transfer ?? true;
  const seeded = transact(taskRoot, {
    actor: 'fixture',
    purpose: 'seed-coordinator-handoff',
    apply: (record) => {
      const began = beginHandoff(record, {
        handoffId: HANDOFF_ID,
        kind: 'coordinator',
        from: COORDINATOR,
        to: PLACEHOLDER,
        ownerEpoch: record.coordinator?.owner_epoch ?? 1,
      });
      if (!began.ok) return began;
      if (rebind) {
        const rebound = rebindReceiver(record, {
          handoffId: HANDOFF_ID,
          to: SUCCESSOR,
          evidenceRef: 'herdr:agent:successor:w9:p3',
          actor: 'fixture',
        });
        if (!rebound.ok) return rebound;
      }
      if (transfer) {
        const moving = markTransferring(record, {
          handoffId: HANDOFF_ID,
          partialOutputs: [],
          inflight: [],
          pendingApprovals: [],
          actor: 'fixture',
        });
        if (!moving.ok) return moving;
      }
      return { record, op: 'seed-handoff', summary: {}, result: { ok: true } };
    },
  });
  assert.ok(seeded.ok, `handoff seed: ${JSON.stringify(seeded)}`);

  const identity =
    options.identity === undefined
      ? { ...SUCCESSOR, cwd: taskRoot }
      : options.identity;
  const requestDigest = digestOf(`request:${requestId}`);
  const seed = `successor seed for ${requestId}`;
  const intent = writeJsonExclusive(
    taskRoot,
    successorFile.intent(taskRoot, requestId),
    {
      schema: SUCCESSOR_INTENT_SCHEMA,
      request_id: requestId,
      request_digest: requestDigest,
      recorded_at: '2026-10-27T06:59:00.000Z',
      harness: 'claude',
      agent_name: 'successor',
      cwd: taskRoot,
      handoff_id: HANDOFF_ID,
      claude_session_id: '6c7d9f2e-1c4b-4c5f-9e21-0f0b8f6a1d33',
      seed,
      seed_digest: digestOf(seed),
      checkpoint: {
        file: checkpointFile,
        digest: options.checkpointDigest ?? digestOf(text),
      },
    },
  );
  assert.equal(intent.status, 'created', JSON.stringify(intent));
  const outcome = writeJsonExclusive(
    taskRoot,
    successorFile.outcome(taskRoot, requestId),
    {
      schema: SUCCESSOR_OUTCOME_SCHEMA,
      request_id: requestId,
      request_digest: requestDigest,
      recorded_at: '2026-10-27T06:59:30.000Z',
      status: options.status ?? 'launched',
      pane_id: options.paneId ?? PANE,
      agent_name: 'successor',
      identity,
      evidence: {
        kind: 'herdr-agent-session',
        detail: 'herdr agent get reported the session id',
      },
      detail: null,
    },
  );
  assert.equal(outcome.status, 'created', JSON.stringify(outcome));
  return { domain, taskRoot, requestId, handoffId: HANDOFF_ID, checkpointFile };
}

function ack(
  fixture: Fixture,
  overrides: AckOverrides = {},
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const options: SuccessorAckOptions = {
    taskRoot: fixture.taskRoot,
    requestId: fixture.requestId,
    callerPane:
      overrides.callerPane === undefined ? PANE : overrides.callerPane,
    ...(overrides.callerCodexThread === undefined
      ? {}
      : { callerCodexThread: overrides.callerCodexThread }),
    apply: overrides.apply ?? true,
    clock: CLOCK,
    ...(overrides.maxCheckpointBytes === undefined
      ? {}
      : { maxCheckpointBytes: overrides.maxCheckpointBytes }),
  };
  return applySuccessorAck(options);
}

function failure(
  result: TaskStoreResult<Record<string, unknown>>,
): TaskStoreFailure {
  if (result.ok)
    assert.fail(`expected a refusal: ${JSON.stringify(result.value)}`);
  return result;
}

function valueOf(result: TaskStoreResult<Record<string, unknown>>): AckValue {
  if (!result.ok) assert.fail(`expected success: ${JSON.stringify(result)}`);
  return result.value as AckValue;
}

async function refusal(
  fixture: Fixture,
  code: string,
  overrides: AckOverrides = {},
): Promise<TaskStoreFailure> {
  const refused = failure(await ack(fixture, overrides));
  assert.equal(refused.code, code, refused.message);
  return refused;
}

/** No message file, no protocol entry and no ack marker may exist. */
function assertNothingRegistered(fixture: Fixture): void {
  const messageId = `handoff-ack-${fixture.requestId}`;
  assert.throws(
    () => lstatSync(join(fixture.taskRoot, 'messages', `${messageId}.json`)),
    /ENOENT/,
  );
  const record = readRecord(fixture.taskRoot)!;
  assert.equal(
    (record.messages ?? []).some((item) => item.message_id === messageId),
    false,
  );
  assert.equal(readSuccessorAck(fixture.taskRoot, fixture.requestId).ok, false);
}

test('acknowledges a transferring coordinator handoff and the confirmation then succeeds', async () => {
  const fixture = makeFixture('sa-success');
  try {
    const result = await ack(fixture);
    const value = valueOf(result);
    assert.equal(value.schema, 'pappra/collab-successor-ack-result/1');
    assert.equal(value.ok, true);
    assert.equal(value.status, 'acknowledged');
    assert.equal(value.task_id, 'sample');
    assert.equal(value.request_id, REQUEST_ID);
    assert.equal(value.handoff_id, HANDOFF_ID);
    assert.deepEqual(value.identity, { ...SUCCESSOR, cwd: fixture.taskRoot });
    assert.equal(value.message.message_id, `handoff-ack-${REQUEST_ID}`);
    assert.equal(value.message.duplicate, false);

    // The briefing is the checkpoint text plus counted inventory.
    assert.equal(value.briefing.checkpoint.file, fixture.checkpointFile);
    assert.equal(value.briefing.checkpoint.digest, digestOf(CHECKPOINT_TEXT));
    assert.equal(value.briefing.checkpoint.text, CHECKPOINT_TEXT);
    assert.equal(
      value.briefing.checkpoint.bytes,
      Buffer.byteLength(CHECKPOINT_TEXT),
    );
    assert.equal(value.briefing.handoff.state, 'transferring');
    assert.equal(value.briefing.handoff.owner_epoch, 1);
    assert.deepEqual(Object.keys(value.briefing.handoff.counts).sort(), [
      'closed',
      'handoffs',
      'inflight',
      'pending_approvals',
      'resources',
      'results',
      'uncertainty',
    ]);
    assert.equal(value.briefing.handoff.counts.handoffs, 1);
    assert.equal(typeof value.briefing.next, 'string');
    assert.ok(value.briefing.next.length > 0);
    assert.ok(value.limits.includes('briefing_counts_only'));

    // The registered envelope is the confirmation the protocol expects.
    const stored = JSON.parse(
      readFileSync(
        join(fixture.taskRoot, 'messages', `handoff-ack-${REQUEST_ID}.json`),
        'utf8',
      ),
    ) as Record<string, unknown> & {
      from: Identity;
      to: Identity;
      body: Record<string, unknown>;
    };
    assert.equal(stored.type, 'HANDOFF');
    assert.equal(stored.task_id, 'sample');
    assert.equal(stored.message_id, `handoff-ack-${REQUEST_ID}`);
    assert.equal(stored.reply_to, HANDOFF_ID);
    assert.equal(stored.owner_epoch, 1);
    assert.equal(stored.content_digest, value.message.digest);
    assert.deepEqual(stored.from, SUCCESSOR);
    assert.deepEqual(stored.to, COORDINATOR);
    assert.equal(stored.body.handoff_id, HANDOFF_ID);
    assert.equal(stored.body.phase, 'confirmation');
    assert.equal(stored.body.successor_request, REQUEST_ID);

    const marker = readSuccessorAck(fixture.taskRoot, REQUEST_ID);
    assert.ok(marker.ok);
    assert.equal(marker.value.request_id, REQUEST_ID);
    assert.equal(marker.value.handoff_id, HANDOFF_ID);
    assert.equal(marker.value.message_id, value.message.message_id);
    assert.equal(marker.value.message_digest, value.message.digest);

    // The ack really satisfies the coordinator's confirm boundary.
    const confirmed = await applyHandoffRequest(fixture.taskRoot, {
      schema: COLLAB_HANDOFF_REQUEST_SCHEMA,
      action: 'confirm',
      actor: 'coordinator',
      owner_epoch: 1,
      handoff_id: HANDOFF_ID,
      confirmation_message_id: value.message.message_id,
    });
    assert.ok(confirmed.ok, `confirm: ${JSON.stringify(confirmed)}`);
    const record = readRecord(fixture.taskRoot)!;
    const handoff = (record.handoffs ?? []).find(
      (item) => item.handoff_id === HANDOFF_ID,
    )!;
    assert.equal(handoff.state, 'receiver_confirmed');
    assert.equal(handoff.confirmation_message_id, value.message.message_id);
  } finally {
    fixture.domain.cleanup();
  }
});

test('is idempotent: a second run reports already_acknowledged and registers nothing', async () => {
  const fixture = makeFixture('sa-idempotent');
  try {
    const first = valueOf(await ack(fixture));
    assert.equal(first.status, 'acknowledged');
    const before = readRecord(fixture.taskRoot)!;
    const beforeBytes = readFileSync(
      join(fixture.taskRoot, 'messages', `${first.message.message_id}.json`),
      'utf8',
    );

    const second = valueOf(await ack(fixture));
    assert.equal(second.status, 'already_acknowledged');
    assert.equal(second.message.duplicate, true);
    assert.equal(second.message.digest, first.message.digest);
    assert.equal(second.briefing.checkpoint.text, CHECKPOINT_TEXT);

    const after = readRecord(fixture.taskRoot)!;
    assert.equal(after.state_revision, before.state_revision);
    const entries = (after.messages ?? []).filter(
      (item) => item.message_id === first.message.message_id,
    );
    assert.equal(entries.length, 1);
    assert.equal(
      readFileSync(
        join(fixture.taskRoot, 'messages', `${first.message.message_id}.json`),
        'utf8',
      ),
      beforeBytes,
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test('plan mode runs every check and writes nothing', async () => {
  const fixture = makeFixture('sa-plan');
  try {
    const before = snapshotTree(fixture.taskRoot);
    const planned = valueOf(await ack(fixture, { apply: false }));
    assert.equal(planned.status, 'planned');
    assert.equal(planned.message.duplicate, false);
    assert.equal(planned.briefing.checkpoint.text, CHECKPOINT_TEXT);
    assert.deepEqual(snapshotTree(fixture.taskRoot), before);
    assertNothingRegistered(fixture);
  } finally {
    fixture.domain.cleanup();
  }
});

test('refuses before registering when the launch journal is unusable', async () => {
  const missing = makeFixture('sa-no-outcome');
  try {
    rmSync(successorFile.outcome(missing.taskRoot, REQUEST_ID));
    const refused = await refusal(missing, 'successor_not_recorded');
    assert.match(refused.message, /recording the successor identity/);
    assertNothingRegistered(missing);
  } finally {
    missing.domain.cleanup();
  }

  const noIdentity = makeFixture('sa-null-identity', { identity: null });
  try {
    await refusal(noIdentity, 'successor_not_recorded');
    assertNothingRegistered(noIdentity);
  } finally {
    noIdentity.domain.cleanup();
  }

  const unavailable = makeFixture('sa-identity-unavailable', {
    identity: null,
    status: 'identity_unavailable',
  });
  try {
    await refusal(unavailable, 'successor_not_recorded');
    assertNothingRegistered(unavailable);
  } finally {
    unavailable.domain.cleanup();
  }
});

test('refuses an unverified or foreign caller pane', async () => {
  const fixture = makeFixture('sa-pane');
  try {
    await refusal(fixture, 'herdr_caller_unverified', { callerPane: null });
    await refusal(fixture, 'caller_pane_mismatch', { callerPane: 'w9:p9' });
    assertNothingRegistered(fixture);
  } finally {
    fixture.domain.cleanup();
  }
});

test('refuses a handoff that is still requested', async () => {
  const fixture = makeFixture('sa-requested', {
    rebind: false,
    transfer: false,
  });
  try {
    const refused = await refusal(fixture, 'handoff_not_ready');
    assert.match(refused.message, /is requested, not transferring/);
    assertNothingRegistered(fixture);
  } finally {
    fixture.domain.cleanup();
  }
});

test('refuses a transferring handoff whose receiver was not rebound', async () => {
  const fixture = makeFixture('sa-not-rebound', { rebind: false });
  try {
    const refused = await refusal(fixture, 'handoff_not_ready');
    assert.match(
      refused.message,
      /has not been rebound to the recorded identity/,
    );
    assertNothingRegistered(fixture);
  } finally {
    fixture.domain.cleanup();
  }
});

test('refuses a bad checkpoint before any registration', async () => {
  const mismatch = makeFixture('sa-digest-mismatch', {
    checkpointDigest: digestOf('a different briefing'),
  });
  try {
    await refusal(mismatch, 'checkpoint_digest_mismatch');
    assertNothingRegistered(mismatch);
  } finally {
    mismatch.domain.cleanup();
  }

  const sized = makeFixture('sa-checkpoint-size');
  try {
    await refusal(sized, 'checkpoint_unavailable', {
      maxCheckpointBytes: Buffer.byteLength(CHECKPOINT_TEXT) - 1,
    });
    assertNothingRegistered(sized);
    // The cap is inclusive: exactly the file size is readable, so the briefing stays bounded
    // rather than silently truncating.
    const exact = valueOf(
      await ack(sized, {
        maxCheckpointBytes: Buffer.byteLength(CHECKPOINT_TEXT),
      }),
    );
    assert.equal(exact.status, 'acknowledged');
    assert.equal(
      exact.briefing.checkpoint.bytes,
      Buffer.byteLength(CHECKPOINT_TEXT),
    );
  } finally {
    sized.domain.cleanup();
  }

  const linked = makeFixture('sa-checkpoint-symlink', {
    checkpoint: 'symlink',
  });
  try {
    const refused = await refusal(linked, 'checkpoint_unavailable');
    assert.match(refused.message, /symlink/);
    assertNothingRegistered(linked);
  } finally {
    linked.domain.cleanup();
  }

  const absent = makeFixture('sa-checkpoint-missing', {
    checkpoint: 'missing',
  });
  try {
    await refusal(absent, 'checkpoint_unavailable');
    assertNothingRegistered(absent);
  } finally {
    absent.domain.cleanup();
  }
});

test('refuses to overwrite a same-id message with different content', async () => {
  const fixture = makeFixture('sa-content-conflict');
  try {
    const messageId = `handoff-ack-${REQUEST_ID}`;
    const conflicting = buildMessage({
      message_id: messageId,
      type: 'HANDOFF',
      task_id: 'sample',
      from: SUCCESSOR,
      to: COORDINATOR,
      reply_to: HANDOFF_ID,
      subtask_id: 'a-different-subtask',
      owner_epoch: 1,
      body: {
        handoff_id: HANDOFF_ID,
        phase: 'confirmation',
        note: 'different bytes',
      },
    });
    assert.equal(
      registerMessage(fixture.taskRoot, conflicting).status,
      'registered',
    );
    const refused = await refusal(fixture, 'ack_registration_refused');
    assert.match(refused.message, /content_conflict/);
    // The registered file keeps the bytes that were registered; it is never overwritten.
    const stored = JSON.parse(
      readFileSync(
        join(fixture.taskRoot, 'messages', `${messageId}.json`),
        'utf8',
      ),
    ) as { message_id: string; body: { note: string } };
    assert.equal(stored.message_id, messageId);
    assert.equal(stored.body.note, 'different bytes');
    // A refused registration leaves no protocol entry and no ack marker behind.
    assert.equal(readSuccessorAck(fixture.taskRoot, REQUEST_ID).ok, false);
    const record = readRecord(fixture.taskRoot)!;
    assert.equal(
      (record.messages ?? []).some((item) => item.message_id === messageId),
      false,
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test('an unrelated recorded identity cannot acknowledge and cannot confirm', async () => {
  const fixture = makeFixture('sa-impostor', {
    identity: { ...IMPOSTOR, cwd: '/tmp' },
  });
  try {
    // The impostor runs in its own (codex) session, so the caller check passes and the
    // handoff itself must still refuse an identity it never bound.
    await refusal(fixture, 'handoff_not_ready', {
      callerCodexThread: IMPOSTOR.session_id,
    });
    assertNothingRegistered(fixture);

    // Even if such a message reached the coordinator, the core confirmation refuses it.
    const record = readRecord(fixture.taskRoot)!;
    const impostor = buildMessage({
      message_id: 'msg-impostor-confirmation',
      type: 'HANDOFF',
      task_id: record.task_id,
      from: { ...IMPOSTOR },
      to: COORDINATOR,
      reply_to: HANDOFF_ID,
      subtask_id: `handoff:${HANDOFF_ID}`,
      owner_epoch: 1,
      body: { handoff_id: HANDOFF_ID, phase: 'confirmation' },
    });
    const confirmed = confirmReceiver(record, {
      handoffId: HANDOFF_ID,
      message: impostor,
    });
    assert.equal(confirmed.ok, false);
    assert.equal(confirmed.reason, 'confirmation_identity_mismatch');
    assert.equal(
      readRecord(fixture.taskRoot)!.state_revision,
      record.state_revision,
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test('reports the acknowledgement with a warning when the ack marker cannot be written', async () => {
  const fixture = makeFixture('sa-marker-warning');
  try {
    const real = join(fixture.domain.root, 'successor-real');
    renameSync(successorDir(fixture.taskRoot), real);
    symlinkSync(real, successorDir(fixture.taskRoot));

    const value = valueOf(await ack(fixture));
    assert.equal(value.status, 'acknowledged');
    assert.equal(value.warning?.code, 'ack_marker_not_written');
    // The message really was registered; only the marker is missing.
    const record = readRecord(fixture.taskRoot)!;
    assert.ok(
      (record.messages ?? []).some(
        (item) => item.message_id === `handoff-ack-${REQUEST_ID}`,
      ),
    );
    assert.equal(readSuccessorAck(fixture.taskRoot, REQUEST_ID).ok, false);
  } finally {
    fixture.domain.cleanup();
  }
});

test('briefs with the checkpoint text and counts only', async () => {
  const fixture = makeFixture('sa-briefing');
  try {
    const secret = 'MESSAGE-BODY-MUST-NOT-BE-PRINTED';
    const notification = buildMessage({
      message_id: 'msg-secret-note',
      type: 'ACK',
      task_id: 'sample',
      from: SUCCESSOR,
      to: COORDINATOR,
      reply_to: HANDOFF_ID,
      owner_epoch: 1,
      body: { handoff_id: HANDOFF_ID, note: secret },
    });
    assert.ok(submitMessage(fixture.taskRoot, notification).ok);

    const value = valueOf(await ack(fixture));
    assert.equal(value.status, 'acknowledged');
    assert.deepEqual(Object.keys(value.briefing).sort(), [
      'checkpoint',
      'handoff',
      'next',
    ]);
    assert.deepEqual(Object.keys(value.briefing.handoff).sort(), [
      'counts',
      'owner_epoch',
      'state',
    ]);
    for (const count of Object.values(value.briefing.handoff.counts))
      assert.equal(typeof count, 'number');
    assert.equal(JSON.stringify(value.briefing).includes(secret), false);
    assert.ok(
      value.limits.includes(
        'checkpoint_text_is_the_only_stored_content_printed',
      ),
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test('a codex successor is bound by its thread id, not by the daemon-inherited pane', async () => {
  const fixture = makeFixture('ack-codex', {
    identity: { ...SUCCESSOR, harness: 'codex', cwd: '/tmp' },
  });
  try {
    // HERDR_PANE_ID inside Codex is the shared daemon's (observed: a different workspace).
    await refusal(fixture, 'codex_thread_unverified', {
      callerPane: 'w1:p1',
      callerCodexThread: null,
    });
    await refusal(fixture, 'caller_session_mismatch', {
      callerPane: PANE,
      callerCodexThread: 'some-other-thread',
    });
    const accepted = await ack(fixture, {
      callerPane: 'w1:p1',
      callerCodexThread: SUCCESSOR.session_id,
    });
    assert.ok(accepted.ok, JSON.stringify(accepted));
    assert.equal(valueOf(accepted).status, 'acknowledged');
  } finally {
    fixture.domain.cleanup();
  }
});

test('a claude successor is still bound by its pane and ignores a codex thread variable', async () => {
  const fixture = makeFixture('ack-claude-pane');
  try {
    await refusal(fixture, 'caller_pane_mismatch', {
      callerPane: 'w1:p1',
      callerCodexThread: SUCCESSOR.session_id,
    });
  } finally {
    fixture.domain.cleanup();
  }
});
