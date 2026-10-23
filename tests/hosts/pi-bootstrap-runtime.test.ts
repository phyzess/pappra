import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { applyMessage, submitMessage } from '../../src/collab/messages.js';
import { bindNative } from '../../src/collab/lifecycle.js';
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
  createLocalTaskRecordReader,
  registerPiBootstrapRuntime,
  type BootstrapGuardPinned,
  type BootstrapRuntimeConfig,
} from '../../src/hosts/integration/pi-bootstrap-runtime.js';
import type {
  PiBootstrapGuardHost,
  PiToolCallHandler,
} from '../../src/hosts/integration/pi-bootstrap-guard.js';

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
  readonly root: string;
  readonly domainRoot: string;
  readonly task: string;
  readonly taskId: string;
  readonly claims: string[];
  cleanup(): void;
}

function makeFixture(label: string): Fixture {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `pappra-runtime-${label}-`)),
  );
  const domainRoot = join(root, 'domain');
  const taskId = 'sample';
  const task = join(domainRoot, TASKS('sample'));
  initTask(task, {
    taskId,
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
    root,
    domainRoot: realpathSync(domainRoot),
    task,
    taskId,
    claims,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function TASKS(id: string): string {
  return join('tasks', id);
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
  const epochs = claimEpochs(load(fixture.task));
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
const SUCCESSOR_NATIVE = {
  agent_id: NEXT.agent_id,
  runner: 'pi',
  session_id: NEXT.session_id,
  run_id: 'run-successor',
  mission_id: null,
  evidence_ref: 'herdr:agent:w4:p2',
  observed_at: '2026-10-22T01:00:05Z',
};

function ackMessage(): Message {
  return buildMessage(
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
}

/** Commit one rollover step to disk through the real store transaction. */
function step(
  task: string,
  apply: (record: TaskRecord) => { ok: boolean; reason?: string },
): void {
  const outcome = transact(task, {
    actor: 'fixture',
    purpose: 'rollover-step',
    apply: (record) => {
      const result = apply(record);
      if (!result || result.ok !== true)
        return { ok: false as const, reason: result?.reason ?? 'step-failed' };
      return { record, op: 'rollover-step', summary: {}, result };
    },
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
}

function driveToConfirmed(fixture: Fixture): void {
  step(fixture.task, (r) =>
    rollover.createRolloverIntent(r, intentInput(fixture)),
  );
  step(fixture.task, (r) =>
    rollover.prepareRolloverTransfer(r, {
      intent_id: 'intent-1',
      observation: 'confirmed',
      evidence_ref: 'herdr:agent:w3:p3:settled',
      inventory: COMPLETE_INVENTORY,
      clock: Date.parse('2026-10-22T01:00:00Z'),
    } as never),
  );
  const ack = ackMessage();
  step(fixture.task, (r) => {
    applyMessage(r, ack, { clock: Date.parse('2026-10-22T01:00:02Z') });
    return rollover.confirmRolloverReceiver(r, {
      intent_id: 'intent-1',
      message: ack,
      clock: Date.parse('2026-10-22T01:00:02Z'),
    });
  });
}

function driveToCompleted(fixture: Fixture): void {
  driveToConfirmed(fixture);
  step(fixture.task, (r) =>
    rollover.completeRolloverTransfer(r, {
      intent_id: 'intent-1',
      successor_native: SUCCESSOR_NATIVE,
      clock: Date.parse('2026-10-22T01:00:05Z'),
    }),
  );
}

function guardPinned(
  fixture: Fixture,
  originalEpochs: Map<string, number>,
): BootstrapGuardPinned {
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
  };
}

function runtimeConfig(
  fixture: Fixture,
  originalEpochs: Map<string, number>,
): BootstrapRuntimeConfig {
  return {
    domainRoot: fixture.domainRoot,
    taskId: fixture.taskId,
    guard: guardPinned(fixture, originalEpochs),
  };
}

class FakePi implements PiBootstrapGuardHost {
  handler: PiToolCallHandler | null = null;
  on(_event: 'tool_call', handler: PiToolCallHandler): void {
    this.handler = handler;
  }
}

function ctx(sessionId: string | null): unknown {
  return { sessionManager: { getSessionId: (): string | null => sessionId } };
}

const WRITE = { toolName: 'write', input: {} };
const READ = { toolName: 'read', input: {} };

function taskRootOf(fixture: Fixture): string {
  return join(fixture.domainRoot, 'tasks', fixture.taskId);
}

function writeRecordRaw(fixture: Fixture, record: TaskRecord): void {
  const file = join(taskRootOf(fixture), 'task.json');
  const tmp = `${file}.tmp-test-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Patch the shared `fs.readSync` (used by the accepted bounded reader) to run `onFirst` exactly once at
 * the start of the first read, simulating an atomic replacement DURING the read. Returns a restorer. This
 * is a test-only wrap of the real fs read; no production mutation hook exists.
 */
function hookFirstReadSync(onFirst: () => void): () => void {
  const fsObject = fs as { readSync: typeof fs.readSync };
  const original = fsObject.readSync;
  let fired = false;
  const patched = ((fd: number, ...rest: unknown[]): number => {
    if (!fired) {
      fired = true;
      onFirst();
    }
    return (original as unknown as (fd: number, ...rest: unknown[]) => number)(
      fd,
      ...rest,
    );
  }) as unknown as typeof fs.readSync;
  fsObject.readSync = patched;
  return () => {
    fsObject.readSync = original;
  };
}

test('the registered gate denies a non-read before the on-disk transfer is completed', async () => {
  const fixture = makeFixture('before');
  try {
    const originalEpochs = claimEpochs(load(fixture.task));
    driveToConfirmed(fixture); // receiver_confirmed on disk, NOT completed
    const pi = new FakePi();
    registerPiBootstrapRuntime(pi, runtimeConfig(fixture, originalEpochs));
    assert.ok(pi.handler);
    const decision = await pi.handler(WRITE, ctx(NEXT.session_id));
    assert.ok(decision && decision.block === true);
    assert.match(decision.reason, /handoff_not_completed/);
  } finally {
    fixture.cleanup();
  }
});

test('after a real atomic completed transfer the first write (and vetted read) is allowed, later drift denied', async () => {
  const fixture = makeFixture('allow');
  try {
    const originalEpochs = claimEpochs(load(fixture.task));
    driveToCompleted(fixture);
    const pi = new FakePi();
    registerPiBootstrapRuntime(pi, runtimeConfig(fixture, originalEpochs));
    assert.ok(pi.handler);
    assert.equal(await pi.handler(WRITE, ctx(NEXT.session_id)), undefined); // first write allowed
    assert.equal(await pi.handler(READ, ctx(NEXT.session_id)), undefined); // vetted read allowed
    // A later legitimate transaction drifts the coordinator epoch; the next write is denied.
    step(fixture.task, (r) => {
      if (r.coordinator) r.coordinator.owner_epoch = 2;
      return { ok: true };
    });
    const denied = await pi.handler(WRITE, ctx(NEXT.session_id));
    assert.ok(denied && denied.block === true);
    assert.match(denied.reason, /coordinator_epoch_drift/);
  } finally {
    fixture.cleanup();
  }
});

test('the reader observes successive legitimate transactions (atomic rename supported)', () => {
  const fixture = makeFixture('successive');
  try {
    driveToCompleted(fixture);
    const reader = createLocalTaskRecordReader(
      fixture.domainRoot,
      fixture.taskId,
    );
    const first = reader.read();
    // Another legitimate committed transaction raises state_revision; the reader accepts it.
    step(fixture.task, (r) => {
      if (r.coordinator) r.coordinator.owner_epoch = 2;
      return { ok: true };
    });
    const second = reader.read();
    assert.ok(second.state_revision > first.state_revision);
    // Same revision + same bytes read is repeatable.
    const third = reader.read();
    assert.equal(third.state_revision, second.state_revision);
  } finally {
    fixture.cleanup();
  }
});

test('the reader rejects rollback and same-revision byte changes and keeps its floor after an error', () => {
  const fixture = makeFixture('floor');
  try {
    driveToCompleted(fixture);
    const reader = createLocalTaskRecordReader(
      fixture.domainRoot,
      fixture.taskId,
    );
    const current = reader.read();
    const floorRevision = current.state_revision;
    // Rollback: a lower state_revision is refused.
    const rolledBack = structuredClone(current);
    rolledBack.state_revision = floorRevision - 1;
    writeRecordRaw(fixture, rolledBack);
    assert.throws(() => reader.read(), /rolled back/);
    // The floor is not reset by the failed read: the same current revision/bytes still reads.
    writeRecordRaw(fixture, current);
    const repeat = reader.read();
    assert.equal(repeat.state_revision, floorRevision);
    // Same revision, different bytes is refused.
    const tampered = structuredClone(current);
    tampered.updated_at = '2099-01-01T00:00:00Z';
    writeRecordRaw(fixture, tampered);
    assert.throws(
      () => reader.read(),
      /bytes changed at the same state_revision/,
    );
    // Floor still intact after that error: a rollback is still refused.
    writeRecordRaw(fixture, rolledBack);
    assert.throws(() => reader.read(), /rolled back/);
  } finally {
    fixture.cleanup();
  }
});

test('the reader rejects wrong task/domain identity, malformed, oversized and non-regular records', () => {
  const fixture = makeFixture('identity');
  try {
    driveToCompleted(fixture);
    const current = load(fixture.task);
    // Wrong domain id in the record bytes.
    const wrongDomain = structuredClone(current);
    wrongDomain.domain_id = 'domain:deadbeefdeadbeefdeadbeef';
    writeRecordRaw(fixture, wrongDomain);
    assert.throws(
      () =>
        createLocalTaskRecordReader(fixture.domainRoot, fixture.taskId).read(),
      /domain id does not derive/,
    );
    // Wrong task id in the record bytes.
    const wrongTask = structuredClone(current);
    wrongTask.task_id = 'other-task';
    writeRecordRaw(fixture, wrongTask);
    assert.throws(
      () =>
        createLocalTaskRecordReader(fixture.domainRoot, fixture.taskId).read(),
      /task id mismatch/,
    );
    // Malformed JSON.
    const file = join(taskRootOf(fixture), 'task.json');
    writeFileSync(file, '{ not valid json');
    assert.throws(
      () =>
        createLocalTaskRecordReader(fixture.domainRoot, fixture.taskId).read(),
      /not valid JSON/,
    );
    // Schema-invalid (valid JSON, wrong shape).
    writeFileSync(file, '{"hello":"world"}');
    assert.throws(
      () =>
        createLocalTaskRecordReader(fixture.domainRoot, fixture.taskId).read(),
      /schema validation/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('the reader refuses a symlinked record, a redirected parent and a disappeared record', () => {
  const fixture = makeFixture('redirect');
  try {
    driveToCompleted(fixture);
    const file = join(taskRootOf(fixture), 'task.json');
    // Symlinked record file.
    const sidecar = join(fixture.root, 'elsewhere.json');
    writeFileSync(sidecar, `${JSON.stringify(load(fixture.task), null, 2)}\n`);
    rmSync(file, { force: true });
    symlinkSync(sidecar, file);
    assert.throws(
      () =>
        createLocalTaskRecordReader(fixture.domainRoot, fixture.taskId).read(),
      /record read failed/,
    );
    rmSync(file, { force: true });
    // Disappeared record.
    assert.throws(
      () =>
        createLocalTaskRecordReader(fixture.domainRoot, fixture.taskId).read(),
      /record read failed/,
    );
    // Redirected task-root parent: a reader pinned before the swap invalidates on the next read.
    const fresh = makeFixture('redirect2');
    try {
      driveToCompleted(fresh);
      const reader = createLocalTaskRecordReader(
        fresh.domainRoot,
        fresh.taskId,
      );
      assert.equal(reader.read().task_id, 'sample'); // one good read pins identities
      const taskRoot = taskRootOf(fresh);
      const moved = `${taskRoot}-moved`;
      renameSync(taskRoot, moved); // ancestor disappears / is replaced
      assert.throws(
        () => reader.read(),
        /directory disappeared|directory identity changed/,
      );
    } finally {
      fresh.cleanup();
    }
  } finally {
    fixture.cleanup();
  }
});

test('a non-regular (FIFO) record is refused on POSIX hosts', () => {
  if (process.platform === 'win32') return;
  const fixture = makeFixture('fifo');
  try {
    driveToCompleted(fixture);
    const file = join(taskRootOf(fixture), 'task.json');
    rmSync(file, { force: true });
    execSync(`mkfifo ${JSON.stringify(file)}`);
    assert.throws(
      () =>
        createLocalTaskRecordReader(fixture.domainRoot, fixture.taskId).read(),
      /record read failed/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('registration requires the runtime task id to equal the guard task id', () => {
  const fixture = makeFixture('consistency');
  try {
    const originalEpochs = claimEpochs(load(fixture.task));
    const pi = new FakePi();
    assert.throws(
      () =>
        registerPiBootstrapRuntime(pi, {
          domainRoot: fixture.domainRoot,
          taskId: 'different',
          guard: guardPinned(fixture, originalEpochs),
        }),
      /runtime task id must equal the guard task id/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('config and returned record mutation do not affect pinned identities or the revision floor', () => {
  const fixture = makeFixture('isolation');
  try {
    driveToCompleted(fixture);
    const reader = createLocalTaskRecordReader(
      fixture.domainRoot,
      fixture.taskId,
    );
    const first = reader.read();
    const floorRevision = first.state_revision;
    // Mutate the returned record; the floor and identities are unaffected.
    first.state_revision = floorRevision + 1000;
    first.task_id = 'tampered';
    const second = reader.read();
    assert.equal(second.state_revision, floorRevision); // same on-disk revision, not the mutated value
    assert.equal(second.task_id, 'sample');
  } finally {
    fixture.cleanup();
  }
});

test('a pinned ancestor replaced DURING the read denies the call (not stale old bytes)', () => {
  const fixture = makeFixture('during-parent');
  try {
    driveToCompleted(fixture);
    const reader = createLocalTaskRecordReader(
      fixture.domainRoot,
      fixture.taskId,
    );
    const taskRoot = taskRootOf(fixture);
    const snapshot = load(fixture.task);
    const restore = hookFirstReadSync(() => {
      // Rename the pinned task directory away and put a fresh directory in its place mid-read.
      const moved = `${taskRoot}-old`;
      renameSync(taskRoot, moved);
      mkdirSync(taskRoot, { recursive: true });
      writeFileSync(
        join(taskRoot, 'task.json'),
        `${JSON.stringify(snapshot, null, 2)}\n`,
      );
    });
    try {
      assert.throws(
        () => reader.read(),
        /directory identity changed|directory disappeared/,
      );
    } finally {
      restore();
    }
  } finally {
    fixture.cleanup();
  }
});

test('the record replaced in place DURING the read is not returned as stale old bytes', () => {
  const fixture = makeFixture('during-record');
  try {
    driveToCompleted(fixture);
    const old = load(fixture.task);
    const oldRevision = old.state_revision;
    const higher = structuredClone(old);
    higher.state_revision = oldRevision + 5;
    higher.updated_at = '2099-01-01T00:00:00Z';
    const reader = createLocalTaskRecordReader(
      fixture.domainRoot,
      fixture.taskId,
    );
    const file = join(taskRootOf(fixture), 'task.json');
    const restore = hookFirstReadSync(() => {
      const tmp = `${file}.tmp-swap`;
      writeFileSync(tmp, `${JSON.stringify(higher, null, 2)}\n`);
      renameSync(tmp, file); // atomic in-place replacement (new inode) during the read
    });
    try {
      const record = reader.read();
      // The bounded coherent retry re-read the new bytes; the stale old revision is never returned.
      assert.equal(record.state_revision, oldRevision + 5);
    } finally {
      restore();
    }
  } finally {
    fixture.cleanup();
  }
});

test('the reader rejects a record whose domain_root or task_root does not match the selected root', () => {
  const fixture = makeFixture('root-identity');
  try {
    driveToCompleted(fixture);
    const current = load(fixture.task);
    const wrongDomainRoot = structuredClone(current);
    wrongDomainRoot.domain_root = '/some/other/domain'; // task_id + domain_id unchanged
    writeRecordRaw(fixture, wrongDomainRoot);
    assert.throws(
      () =>
        createLocalTaskRecordReader(fixture.domainRoot, fixture.taskId).read(),
      /domain_root does not match/,
    );
    const wrongTaskRoot = structuredClone(current);
    wrongTaskRoot.task_root = '/some/other/domain/tasks/sample';
    writeRecordRaw(fixture, wrongTaskRoot);
    assert.throws(
      () =>
        createLocalTaskRecordReader(fixture.domainRoot, fixture.taskId).read(),
      /task_root does not match/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('registration rejects a noncanonical (symlink-prefix) domain root', () => {
  const fixture = makeFixture('symlink-prefix');
  try {
    driveToCompleted(fixture);
    const alias = join(
      fixture.root,
      '..',
      `alias-${Math.random().toString(36).slice(2)}`,
    );
    symlinkSync(fixture.root, alias);
    try {
      const aliasedDomain = join(alias, 'domain');
      assert.throws(
        () => createLocalTaskRecordReader(aliasedDomain, fixture.taskId),
        /must be canonical/,
      );
    } finally {
      rmSync(alias, { force: true });
    }
  } finally {
    fixture.cleanup();
  }
});
