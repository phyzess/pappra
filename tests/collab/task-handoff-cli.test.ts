import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildMessage,
  messageFile,
  registerMessage,
} from '../../src/collab/envelope.js';
import { claimResources, releaseClaim } from '../../src/collab/resources.js';
import { readRecord } from '../../src/collab/store.js';
import {
  COORDINATOR,
  NEXT_COORDINATOR,
  RECEIVER,
  WRITER,
  makeHandoffFixture,
  seedConfirmation,
  writeRequest,
  type HandoffFixture,
} from './handoff-fixtures.js';
import { snapshotTree } from './task-resources-fixtures.js';

const ROOT = join(
  dirname(fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json'))),
);
const CLI = join(ROOT, 'dist/cli/main.js');
const SCHEMA = 'pappra/collaboration-handoff-request/1';
const HANDOFF = 'handoff-writer';

function run(args: readonly string[], cwd: string, timeout = 30_000) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function json(result: ReturnType<typeof run>): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function base(action: string, overrides: Record<string, unknown> = {}) {
  return {
    schema: SCHEMA,
    action,
    actor: 'fixture-actor',
    owner_epoch: 1,
    ...overrides,
  };
}

function beginWriter(fixture: HandoffFixture): Record<string, unknown> {
  return base('begin', {
    handoff_id: HANDOFF,
    kind: 'writer',
    from: WRITER,
    to: RECEIVER,
    resources: [fixture.claimId],
    subtask_id: 'work',
    attempt: 1,
  });
}

function stopped(): Record<string, unknown> {
  return base('stopped', {
    handoff_id: HANDOFF,
    observation: 'confirmed',
    evidence_ref: '/abs/stop-evidence.json',
  });
}

function transfer(): Record<string, unknown> {
  return base('transfer', {
    handoff_id: HANDOFF,
    partial_outputs: [{ ref: '/abs/output.json', digest: 'sha256:x' }],
    inflight: [],
    pending_approvals: [],
  });
}

function confirm(messageId: string, overrides: Record<string, unknown> = {}) {
  return base('confirm', {
    handoff_id: HANDOFF,
    confirmation_message_id: messageId,
    ...overrides,
  });
}

function handoffArgs(
  action: string,
  task: string,
  requestFile: string,
  apply: boolean,
): string[] {
  return [
    'collab',
    'handoff',
    action,
    '--task-root',
    task,
    '--request',
    requestFile,
    ...(apply ? ['--apply'] : []),
    '--json',
  ];
}

function applyFile(
  fixture: HandoffFixture,
  action: string,
  name: string,
  value: unknown,
) {
  const file = writeRequest(fixture.domain, name, value);
  return run(
    handoffArgs(action, fixture.task, file, true),
    fixture.domain.root,
  );
}

function seedWriterTransferring(fixture: HandoffFixture): void {
  const begin = applyFile(fixture, 'begin', 'begin.json', beginWriter(fixture));
  assert.equal(begin.status, 0, begin.stderr);
  const stop = applyFile(fixture, 'stopped', 'stopped.json', stopped());
  assert.equal(stop.status, 0, stop.stderr);
  const move = applyFile(fixture, 'transfer', 'transfer.json', transfer());
  assert.equal(move.status, 0, move.stderr);
}

test('installed writer handoff plans, stops, transfers, confirms and completes', () => {
  const fixture = makeHandoffFixture('c5-writer');
  try {
    const beginFile = writeRequest(
      fixture.domain,
      'begin.json',
      beginWriter(fixture),
    );
    const before = snapshotTree(fixture.domain.root);
    const plan = run(
      handoffArgs('begin', fixture.task, beginFile, false),
      fixture.domain.root,
    );
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(json(plan).applied, false);
    assert.equal(json(plan).status, 'planned');
    assert.deepEqual(snapshotTree(fixture.domain.root), before);

    const begin = run(
      handoffArgs('begin', fixture.task, beginFile, true),
      fixture.domain.root,
    );
    assert.equal(begin.status, 0, begin.stderr);
    assert.equal(json(begin).applied, true);
    assert.equal(readRecord(fixture.task)?.handoffs?.[0]?.state, 'requested');

    const unknown = applyFile(
      fixture,
      'stopped',
      'unknown-stop.json',
      base('stopped', {
        handoff_id: HANDOFF,
        observation: 'unknown',
        evidence_ref: '/abs/stop-evidence.json',
      }),
    );
    assert.equal(unknown.status, 1, unknown.stderr);
    assert.equal(json(unknown).reason, 'old_writer_not_stopped');
    assert.equal(readRecord(fixture.task)?.handoffs?.[0]?.state, 'requested');

    const stop = applyFile(fixture, 'stopped', 'stopped.json', stopped());
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(
      readRecord(fixture.task)?.handoffs?.[0]?.state,
      'old_writer_stopped',
    );
    const move = applyFile(fixture, 'transfer', 'transfer.json', transfer());
    assert.equal(move.status, 0, move.stderr);
    assert.equal(
      readRecord(fixture.task)?.handoffs?.[0]?.state,
      'transferring',
    );

    const missing = applyFile(
      fixture,
      'confirm',
      'confirm-missing.json',
      confirm('msg-does-not-exist'),
    );
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(
      readRecord(fixture.task)?.handoffs?.[0]?.state,
      'transferring',
    );

    const message = seedConfirmation(fixture.task, { handoffId: HANDOFF });
    const confirmed = applyFile(
      fixture,
      'confirm',
      'confirm.json',
      confirm(message.message_id),
    );
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.equal(
      readRecord(fixture.task)?.handoffs?.[0]?.state,
      'receiver_confirmed',
    );

    const rebound = applyFile(
      fixture,
      'rebind',
      'rebind.json',
      base('rebind', {
        handoff_id: HANDOFF,
        to: NEXT_COORDINATOR,
        evidence_ref: '/abs/rebind.json',
      }),
    );
    assert.equal(rebound.status, 1, rebound.stderr);
    assert.equal(json(rebound).reason, 'already_confirmed');

    const complete = applyFile(
      fixture,
      'complete',
      'complete.json',
      base('complete', { handoff_id: HANDOFF }),
    );
    assert.equal(complete.status, 0, complete.stderr);
    const record = readRecord(fixture.task)!;
    assert.equal(record.handoffs?.[0]?.state, 'completed');
    assert.equal(
      record.handoffs?.[0]?.confirmation_message_id,
      message.message_id,
    );
    assert.equal(record.claims?.[0]?.holder?.agent_id, RECEIVER.agent_id);
    assert.equal(record.claims?.[0]?.resource_epoch, 2);
    assert.equal(record.attempts?.[0]?.ownership, 'transferred');

    const inventory = run(
      ['collab', 'handoff', 'inventory', '--task-root', fixture.task, '--json'],
      fixture.domain.root,
    );
    assert.equal(inventory.status, 0, inventory.stderr);
    assert.equal(
      (json(inventory).counts as Record<string, unknown>).handoffs,
      1,
    );
    assert.equal(
      (json(inventory).handoffs as Record<string, unknown>[])[0]!.state,
      'completed',
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test('coordinator handoff freezes dispatch and requires an explicit current-epoch release', () => {
  const fixture = makeHandoffFixture('c5-coordinator');
  const coordinatorHandoff = 'handoff-coordinator';
  try {
    const begin = applyFile(
      fixture,
      'begin',
      'begin-coordinator.json',
      base('begin', {
        handoff_id: coordinatorHandoff,
        kind: 'coordinator',
        from: COORDINATOR,
        to: NEXT_COORDINATOR,
      }),
    );
    assert.equal(begin.status, 0, begin.stderr);
    assert.equal(readRecord(fixture.task)?.dispatch_frozen, true);

    const move = applyFile(
      fixture,
      'transfer',
      'transfer-coordinator.json',
      base('transfer', {
        handoff_id: coordinatorHandoff,
        partial_outputs: [],
        inflight: [],
        pending_approvals: [],
      }),
    );
    assert.equal(move.status, 0, move.stderr);
    const message = seedConfirmation(fixture.task, {
      handoffId: coordinatorHandoff,
      messageId: 'msg-c5-coordinator-confirmation',
      from: NEXT_COORDINATOR,
      to: COORDINATOR,
      ownerEpoch: 1,
    });
    const confirmed = applyFile(
      fixture,
      'confirm',
      'confirm-coordinator.json',
      base('confirm', {
        handoff_id: coordinatorHandoff,
        confirmation_message_id: message.message_id,
      }),
    );
    assert.equal(confirmed.status, 0, confirmed.stderr);
    const complete = applyFile(
      fixture,
      'complete',
      'complete-coordinator.json',
      base('complete', { handoff_id: coordinatorHandoff }),
    );
    assert.equal(complete.status, 0, complete.stderr);
    let record = readRecord(fixture.task)!;
    assert.equal(record.coordinator?.agent_id, NEXT_COORDINATOR.agent_id);
    assert.equal(record.coordinator?.owner_epoch, 2);
    assert.equal(record.dispatch_frozen, true);

    const stale = applyFile(
      fixture,
      'release-dispatch',
      'release-stale.json',
      base('release-dispatch', { owner_epoch: 1 }),
    );
    assert.equal(stale.status, 1, stale.stderr);
    assert.equal(json(stale).reason, 'stale_epoch');
    assert.equal(readRecord(fixture.task)?.dispatch_frozen, true);

    const release = applyFile(
      fixture,
      'release-dispatch',
      'release.json',
      base('release-dispatch', { owner_epoch: 2 }),
    );
    assert.equal(release.status, 0, release.stderr);
    record = readRecord(fixture.task)!;
    assert.equal(record.dispatch_frozen, false);
  } finally {
    fixture.domain.cleanup();
  }
});

test('confirmation boundary rejects absent, unregistered, wrong and replayed evidence', () => {
  const fixture = makeHandoffFixture('c5-confirmation');
  try {
    seedWriterTransferring(fixture);
    const missing = applyFile(
      fixture,
      'confirm',
      'missing.json',
      confirm('msg-never-registered'),
    );
    assert.equal(missing.status, 1, missing.stderr);

    const unregisteredMessage = (() => {
      const message = buildMessage({
        message_id: 'msg-c5-unapplied',
        type: 'HANDOFF',
        task_id: 'sample',
        from: RECEIVER,
        to: COORDINATOR,
        subtask_id: 'work',
        owner_epoch: 1,
        body: { handoff_id: HANDOFF, phase: 'confirmation' },
      });
      // Registration writes the file; without an applied record entry it is
      // not accepted confirmation evidence.
      registerMessage(fixture.task, message);
      return message;
    })();
    const unapplied = applyFile(
      fixture,
      'confirm',
      'unapplied.json',
      confirm(unregisteredMessage.message_id),
    );
    assert.equal(unapplied.status, 1, unapplied.stderr);
    assert.equal(json(unapplied).code, 'confirmation_not_recorded');

    const wrongRecipient = seedConfirmation(fixture.task, {
      handoffId: HANDOFF,
      messageId: 'msg-c5-wrong-recipient',
      to: WRITER,
    });
    const recipient = applyFile(
      fixture,
      'confirm',
      'wrong-recipient.json',
      confirm(wrongRecipient.message_id),
    );
    assert.equal(recipient.status, 1, recipient.stderr);
    assert.equal(json(recipient).code, 'confirmation_recipient_mismatch');

    const wrongSender = seedConfirmation(fixture.task, {
      handoffId: HANDOFF,
      messageId: 'msg-c5-wrong-sender',
      from: WRITER,
    });
    const sender = applyFile(
      fixture,
      'confirm',
      'wrong-sender.json',
      confirm(wrongSender.message_id),
    );
    assert.equal(sender.status, 1, sender.stderr);
    assert.equal(json(sender).code, 'confirmation_identity_mismatch');

    const wrongEpoch = (() => {
      const message = buildMessage({
        message_id: 'msg-c5-wrong-epoch',
        type: 'HANDOFF',
        task_id: 'sample',
        from: RECEIVER,
        to: COORDINATOR,
        subtask_id: 'work',
        owner_epoch: 2,
        body: { handoff_id: HANDOFF, phase: 'confirmation' },
      });
      registerMessage(fixture.task, message);
      return message;
    })();
    const epoch = applyFile(
      fixture,
      'confirm',
      'wrong-epoch.json',
      confirm(wrongEpoch.message_id),
    );
    assert.equal(epoch.status, 1, epoch.stderr);
    assert.equal(json(epoch).code, 'confirmation_epoch_mismatch');

    const wrongHandoff = buildMessage({
      message_id: 'msg-c5-wrong-handoff',
      type: 'HANDOFF',
      task_id: 'sample',
      from: RECEIVER,
      to: COORDINATOR,
      subtask_id: 'work',
      owner_epoch: 1,
      body: { handoff_id: 'other-handoff', phase: 'confirmation' },
    });
    // Invalid correlation is refused during apply; retain only the envelope to
    // exercise the confirmation boundary's independent validation.
    registerMessage(fixture.task, wrongHandoff);
    const handoffMismatch = applyFile(
      fixture,
      'confirm',
      'wrong-handoff.json',
      confirm(wrongHandoff.message_id),
    );
    assert.equal(handoffMismatch.status, 1, handoffMismatch.stderr);
    assert.equal(json(handoffMismatch).code, 'confirmation_handoff_mismatch');

    const valid = seedConfirmation(fixture.task, {
      handoffId: HANDOFF,
      messageId: 'msg-c5-valid',
    });
    const ok = applyFile(
      fixture,
      'confirm',
      'valid.json',
      confirm(valid.message_id),
    );
    assert.equal(ok.status, 0, ok.stderr);
    const replay = applyFile(
      fixture,
      'confirm',
      'replay.json',
      confirm(valid.message_id),
    );
    assert.equal(replay.status, 1, replay.stderr);
    assert.equal(
      readRecord(fixture.task)?.handoffs?.[0]?.state,
      'receiver_confirmed',
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test('confirmation symlink and FIFO are refused before ownership transfer', () => {
  const fixture = makeHandoffFixture('c5-confirmation-file');
  try {
    seedWriterTransferring(fixture);
    const message = buildMessage({
      message_id: 'msg-c5-confirm-file',
      type: 'HANDOFF',
      task_id: 'sample',
      from: RECEIVER,
      to: COORDINATOR,
      subtask_id: 'work',
      owner_epoch: 1,
      body: { handoff_id: HANDOFF, phase: 'confirmation' },
    });
    registerMessage(fixture.task, message);
    const file = messageFile(fixture.task, message.message_id);
    const outside = join(fixture.domain.outside, 'confirmation.json');
    writeFileSync(outside, `${JSON.stringify(message, null, 2)}\n`);
    unlinkSync(file);
    symlinkSync(outside, file);
    const link = applyFile(
      fixture,
      'confirm',
      'confirm-link.json',
      confirm(message.message_id),
    );
    assert.equal(link.status, 1, link.stderr);
    assert.equal(json(link).code, 'message_registration_invalid');
    assert.equal(
      readRecord(fixture.task)?.handoffs?.[0]?.state,
      'transferring',
    );

    rmSync(file);
    assert.equal(spawnSync('mkfifo', [file]).status, 0);
    const fifo = applyFile(
      fixture,
      'confirm',
      'confirm-fifo.json',
      confirm(message.message_id),
    );
    assert.equal(fifo.status, 1, fifo.stderr);
    assert.equal(json(fifo).code, 'message_registration_invalid');
    assert.equal(
      readRecord(fixture.task)?.handoffs?.[0]?.state,
      'transferring',
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test('handoff refusals preserve state for stale epoch, revision and claim drift', () => {
  const fixture = makeHandoffFixture('c5-refusals');
  try {
    const begin = applyFile(
      fixture,
      'begin',
      'begin.json',
      beginWriter(fixture),
    );
    assert.equal(begin.status, 0, begin.stderr);
    const overlap = applyFile(
      fixture,
      'begin',
      'overlap.json',
      base('begin', {
        handoff_id: 'handoff-overlap',
        kind: 'writer',
        from: WRITER,
        to: RECEIVER,
        resources: [fixture.claimId],
        subtask_id: 'work',
        attempt: 1,
      }),
    );
    assert.equal(overlap.status, 1, overlap.stderr);
    assert.equal(json(overlap).reason, 'overlapping_handoff');
    assert.equal(readRecord(fixture.task)?.handoffs?.length, 1);
    const stale = applyFile(
      fixture,
      'stopped',
      'stale.json',
      base('stopped', {
        handoff_id: HANDOFF,
        observation: 'confirmed',
        evidence_ref: '/abs/stop.json',
        owner_epoch: 2,
      }),
    );
    assert.equal(stale.status, 1, stale.stderr);
    assert.equal(json(stale).reason, 'stale_epoch');
    assert.equal(readRecord(fixture.task)?.handoffs?.[0]?.state, 'requested');

    const revision = applyFile(
      fixture,
      'stopped',
      'revision.json',
      base('stopped', {
        handoff_id: HANDOFF,
        observation: 'confirmed',
        evidence_ref: '/abs/stop.json',
        expect_revision: 999,
      }),
    );
    assert.equal(revision.status, 1, revision.stderr);
    assert.equal(json(revision).reason, 'revision_conflict');
    assert.equal(readRecord(fixture.task)?.handoffs?.[0]?.state, 'requested');

    const stop = applyFile(fixture, 'stopped', 'stop.json', stopped());
    assert.equal(stop.status, 0, stop.stderr);
    const move = applyFile(fixture, 'transfer', 'transfer.json', transfer());
    assert.equal(move.status, 0, move.stderr);
    const released = releaseClaim(fixture.task, {
      claimId: fixture.claimId,
      holder: WRITER,
    });
    assert.equal(released.ok, true);
    const drift = applyFile(
      fixture,
      'complete',
      'complete.json',
      base('complete', { handoff_id: HANDOFF }),
    );
    assert.equal(drift.status, 1, drift.stderr);
    assert.equal(json(drift).reason, 'ownership_changed');
    assert.equal(
      readRecord(fixture.task)?.handoffs?.[0]?.state,
      'transferring',
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test('handoff inventory is bounded and read-only', () => {
  const fixture = makeHandoffFixture('c5-inventory');
  try {
    const more = Array.from({ length: 59 }, (_, index) => ({
      kind: 'path',
      path: join(fixture.domain.root, `extra-${index}`),
    }));
    const extra = claimResources(fixture.task, {
      resources: more,
      holder: WRITER,
      subtaskId: 'work',
      attempt: 1,
    });
    assert.equal(extra.ok, true);
    const before = snapshotTree(fixture.domain.root);
    const inventory = run(
      [
        'collab',
        'handoff',
        'inventory',
        '--task-root',
        fixture.task,
        '--subtask-id',
        'work',
        '--attempt',
        '1',
        '--json',
      ],
      fixture.domain.root,
    );
    assert.equal(inventory.status, 0, inventory.stderr);
    const body = json(inventory);
    assert.equal((body.counts as Record<string, unknown>).resources, 60);
    assert.equal((body.resources as unknown[]).length, 50);
    assert.equal((body.omitted as Record<string, unknown>).resources, 10);
    assert.equal(body.truncated, true);
    assert.deepEqual(snapshotTree(fixture.domain.root), before);
  } finally {
    fixture.domain.cleanup();
  }
});

test('handoff refuses nested redirects and strict invalid input', () => {
  const fixture = makeHandoffFixture('c5-strict');
  try {
    const lock = join(fixture.domain.outside, 'lock');
    mkdirSync(lock, { recursive: true });
    symlinkSync(lock, join(fixture.task, '.write.lock'));
    const blocked = applyFile(
      fixture,
      'begin',
      'blocked.json',
      beginWriter(fixture),
    );
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.equal(json(blocked).code, 'task_lock_unsafe');
  } finally {
    fixture.domain.cleanup();
  }

  const strict = makeHandoffFixture('c5-strict-options');
  try {
    const begin = writeRequest(
      strict.domain,
      'begin.json',
      beginWriter(strict),
    );
    const relative = run(
      handoffArgs('begin', strict.task, 'begin.json', false),
      strict.domain.root,
    );
    assert.equal(relative.status, 2);
    const wrongAction = writeRequest(
      strict.domain,
      'wrong-action.json',
      base('release', { handoff_id: HANDOFF }),
    );
    const wrong = run(
      handoffArgs('begin', strict.task, wrongAction, false),
      strict.domain.root,
    );
    assert.equal(wrong.status, 2);
    const unknownField = writeRequest(strict.domain, 'unknown-field.json', {
      ...beginWriter(strict),
      secret: 'SECRET-VALUE',
    });
    const unknown = run(
      handoffArgs('begin', strict.task, unknownField, false),
      strict.domain.root,
    );
    assert.equal(unknown.status, 2);
    assert.ok(!unknown.stdout.includes('SECRET-VALUE'));

    const missing = run(
      ['collab', 'handoff', 'begin', '--task-root', strict.task, '--json'],
      strict.domain.root,
    );
    assert.equal(missing.status, 2);
    const inventoryApply = run(
      [
        'collab',
        'handoff',
        'inventory',
        '--task-root',
        strict.task,
        '--apply',
        '--json',
      ],
      strict.domain.root,
    );
    assert.equal(inventoryApply.status, 2);
    const badAttempt = run(
      [
        'collab',
        'handoff',
        'inventory',
        '--task-root',
        strict.task,
        '--attempt',
        '0',
        '--json',
      ],
      strict.domain.root,
    );
    assert.equal(badAttempt.status, 2);
    const duplicate = run(
      [
        'collab',
        'handoff',
        'begin',
        '--task-root',
        strict.task,
        '--request',
        begin,
        '--request',
        begin,
        '--json',
      ],
      strict.domain.root,
    );
    assert.equal(duplicate.status, 2);

    const oversize = join(strict.domain.root, 'oversize.json');
    writeFileSync(oversize, '');
    truncateSync(oversize, 1024 * 1024 + 1);
    const big = run(
      handoffArgs('begin', strict.task, oversize, false),
      strict.domain.root,
    );
    assert.equal(big.status, 2);

    const fifo = join(strict.domain.root, 'request.fifo');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const started = Date.now();
    const blockedInput = run(
      handoffArgs('begin', strict.task, fifo, false),
      strict.domain.root,
      2_000,
    );
    assert.ok(Date.now() - started < 2_000);
    assert.equal(blockedInput.status, 2);
    assert.equal(readRecord(strict.task)?.handoffs?.length ?? 0, 0);
    assert.ok(lstatSync(fifo).isFIFO());
  } finally {
    strict.domain.cleanup();
  }
});

test('separate CLI processes cannot create the same handoff twice', async () => {
  const fixture = makeHandoffFixture('c5-parallel');
  try {
    const request = writeRequest(
      fixture.domain,
      'begin.json',
      beginWriter(fixture),
    );
    const results = await Promise.all(
      Array.from(
        { length: 2 },
        () =>
          new Promise<{ code: number | null; stdout: string; stderr: string }>(
            (resolve, reject) => {
              const child = spawn(
                process.execPath,
                [CLI, ...handoffArgs('begin', fixture.task, request, true)],
                {
                  cwd: fixture.domain.root,
                  stdio: ['ignore', 'pipe', 'pipe'],
                  shell: false,
                  timeout: 20_000,
                },
              );
              let stdout = '';
              let stderr = '';
              child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
                stdout += chunk;
              });
              child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
                stderr += chunk;
              });
              child.on('error', reject);
              child.on('close', (code) => resolve({ code, stdout, stderr }));
            },
          ),
      ),
    );
    assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
    assert.equal(readRecord(fixture.task)?.handoffs?.length, 1);
    assert.equal(readRecord(fixture.task)?.handoffs?.[0]?.state, 'requested');
  } finally {
    fixture.domain.cleanup();
  }
});
