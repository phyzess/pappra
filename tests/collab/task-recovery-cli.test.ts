import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs, {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyRecovery } from '../../src/app/collab-recovery.js';
import {
  openUncertainty,
  transitionAttempt,
} from '../../src/collab/lifecycle.js';
import {
  acquireLock,
  brokenLocksDir,
  ledgerPath,
  lockPath,
  readLock,
  readRecord,
  releaseLock,
  transact,
} from '../../src/collab/store.js';
import {
  makeHandoffFixture,
  writeRequest,
  type HandoffFixture,
} from './handoff-fixtures.js';
import { snapshotTree } from './task-resources-fixtures.js';
import type { CollaborationRecoveryRequest } from '../../src/schemas/collaboration.js';

const ROOT = join(
  dirname(fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json'))),
);
const CLI = join(ROOT, 'dist/cli/main.js');
const SCHEMA = 'pappra/collaboration-recovery-request/1';

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

function inspect(task: string, cwd: string) {
  return run(
    ['collab', 'recovery', 'inspect', '--task-root', task, '--json'],
    cwd,
  );
}

function recoveryArgs(
  action: string,
  task: string,
  requestFile: string,
  apply: boolean,
): string[] {
  return [
    'collab',
    'recovery',
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
    recoveryArgs(action, fixture.task, file, true),
    fixture.domain.root,
  );
}

function seedUncertainty(
  task: string,
  options: {
    subtask?: string | null;
    attempt?: number | null;
    kind?: string;
  } = {},
): string {
  let uncertaintyId = '';
  const outcome = transact(task, {
    actor: 'fixture',
    purpose: 'seed-uncertainty',
    apply: (record) => {
      const opened = openUncertainty(record, {
        kind: options.kind ?? 'session_unobserved',
        subtaskId: options.subtask === undefined ? 'work' : options.subtask,
        attempt: options.attempt === undefined ? 1 : options.attempt,
        detail: 'fixture uncertainty',
      });
      if (!opened.ok) return opened;
      uncertaintyId = opened.uncertainty_id;
      return {
        record,
        op: 'seed-uncertainty',
        summary: { uncertainty_id: uncertaintyId },
        result: opened,
      };
    },
  });
  assert.equal(outcome.ok, true);
  return uncertaintyId;
}

function reconcileRequest(
  uncertaintyId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: SCHEMA,
    action: 'reconcile',
    actor: 'fixture-actor',
    owner_epoch: 1,
    uncertainty_id: uncertaintyId,
    resolution: 'fixture conclusion',
    resolution_evidence: '/abs/resolution-evidence.json',
    ...overrides,
  };
}

function lockBreakRequest(
  fingerprint: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: SCHEMA,
    action: 'lock-break',
    actor: 'fixture-operator',
    owner_epoch: 1,
    reason: 'fixture lock recovery',
    confirm_holder_stopped: true,
    expected_lock_fingerprint: fingerprint,
    ...overrides,
  };
}

test('recovery inspect is read-only and reports clean state', () => {
  const fixture = makeHandoffFixture('c6-inspect');
  try {
    const unrelated = join(fixture.domain.root, 'elsewhere');
    mkdirSync(unrelated, { recursive: true });
    const before = snapshotTree(fixture.domain.root);
    const result = inspect(fixture.task, unrelated);
    assert.equal(result.status, 0, result.stderr);
    const body = json(result);
    assert.equal(body.schema, 'pappra/collaboration-recovery/1');
    assert.equal(body.action, 'inspect');
    assert.equal(body.status, 'ready');
    assert.equal(
      (body.uncertainty as { counts: Record<string, unknown> }).counts.open,
      0,
    );
    assert.equal(
      (body.uncertainty as { counts: Record<string, unknown> }).counts.resolved,
      0,
    );
    assert.equal((body.lock as Record<string, unknown>).held, false);
    assert.match(
      String((body.lock as Record<string, unknown>).fingerprint),
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.deepEqual(snapshotTree(fixture.domain.root), before);
  } finally {
    fixture.domain.cleanup();
  }
});

test('reconcile records resolution without an implicit state transition', () => {
  const fixture = makeHandoffFixture('c6-reconcile');
  try {
    const uncertaintyId = seedUncertainty(fixture.task);
    const beforeInspect = snapshotTree(fixture.domain.root);
    const inspected = inspect(fixture.task, fixture.domain.root);
    assert.equal(inspected.status, 1, inspected.stderr);
    assert.equal(
      (json(inspected).uncertainty as { counts: Record<string, unknown> })
        .counts.open,
      1,
    );
    assert.deepEqual(snapshotTree(fixture.domain.root), beforeInspect);

    const requestFile = writeRequest(
      fixture.domain,
      'reconcile.json',
      reconcileRequest(uncertaintyId),
    );
    const beforePlan = snapshotTree(fixture.domain.root);
    const plan = run(
      recoveryArgs('reconcile', fixture.task, requestFile, false),
      fixture.domain.root,
    );
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(json(plan).applied, false);
    assert.deepEqual(snapshotTree(fixture.domain.root), beforePlan);

    const applied = run(
      recoveryArgs('reconcile', fixture.task, requestFile, true),
      fixture.domain.root,
    );
    assert.equal(applied.status, 0, applied.stderr);
    const body = json(applied);
    assert.equal(body.applied, true);
    assert.equal(
      (body.result as Record<string, unknown>).resolution_recorded,
      true,
    );
    assert.equal(
      (body.result as Record<string, unknown>).state_transition,
      null,
    );
    const record = readRecord(fixture.task)!;
    assert.ok(record.uncertainty?.[0]?.resolved_at);
    assert.equal(record.attempts?.[0]?.state, 'assigned');

    const replay = applyFile(
      fixture,
      'reconcile',
      'reconcile-replay.json',
      reconcileRequest(uncertaintyId),
    );
    assert.equal(replay.status, 1, replay.stderr);
    assert.equal(json(replay).reason, 'already_resolved');
  } finally {
    fixture.domain.cleanup();
  }
});

test('reconcile applies an explicitly requested transition atomically', () => {
  const fixture = makeHandoffFixture('c6-reconcile-transition');
  try {
    const uncertaintyId = seedUncertainty(fixture.task);
    const applied = applyFile(
      fixture,
      'reconcile',
      'reconcile-state.json',
      reconcileRequest(uncertaintyId, { set_state: 'accepted' }),
    );
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(
      (json(applied).result as Record<string, unknown>).state_transition,
      'accepted',
    );
    const record = readRecord(fixture.task)!;
    assert.equal(record.attempts?.[0]?.state, 'accepted');
    assert.ok(record.uncertainty?.[0]?.resolved_at);

    const illegalFixture = makeHandoffFixture('c6-reconcile-illegal');
    try {
      const illegalId = seedUncertainty(illegalFixture.task);
      const refused = applyFile(
        illegalFixture,
        'reconcile',
        'illegal.json',
        reconcileRequest(illegalId, { set_state: 'completed' }),
      );
      assert.equal(refused.status, 1, refused.stderr);
      assert.equal(json(refused).reason, 'invalid_transition');
      const illegalRecord = readRecord(illegalFixture.task)!;
      assert.equal(illegalRecord.uncertainty?.[0]?.resolved_at, null);
      assert.equal(illegalRecord.attempts?.[0]?.state, 'assigned');
    } finally {
      illegalFixture.domain.cleanup();
    }
  } finally {
    fixture.domain.cleanup();
  }
});

test('reconcile refuses missing attempt context and preserves approval/cancel boundaries', () => {
  const missingFixture = makeHandoffFixture('c6-reconcile-missing-context');
  try {
    const missingId = seedUncertainty(missingFixture.task, {
      subtask: null,
      attempt: null,
    });
    const refused = applyFile(
      missingFixture,
      'reconcile',
      'missing-context.json',
      reconcileRequest(missingId, { set_state: 'running' }),
    );
    assert.equal(refused.status, 1, refused.stderr);
    assert.equal(json(refused).reason, 'transition_context_missing');
    assert.equal(
      readRecord(missingFixture.task)?.uncertainty?.[0]?.resolved_at,
      null,
    );
  } finally {
    missingFixture.domain.cleanup();
  }

  const approvalFixture = makeHandoffFixture('c6-reconcile-approval');
  try {
    const approvalId = seedUncertainty(approvalFixture.task);
    const observed = transact(approvalFixture.task, {
      actor: 'fixture',
      purpose: 'needs-approval',
      apply: (record) => {
        const transition = transitionAttempt(record, {
          subtaskId: 'work',
          attempt: 1,
          to: 'needs_input',
          actor: 'fixture',
        });
        if (!transition.ok) return transition;
        record.attempts![0]!.awaiting = 'approval';
        return { record, op: 'needs-approval', summary: {} };
      },
    });
    assert.equal(observed.ok, true);
    const refused = applyFile(
      approvalFixture,
      'reconcile',
      'approval.json',
      reconcileRequest(approvalId, { set_state: 'running' }),
    );
    assert.equal(refused.status, 1, refused.stderr);
    assert.equal(json(refused).reason, 'approval_required');
    const record = readRecord(approvalFixture.task)!;
    assert.equal(record.uncertainty?.[0]?.resolved_at, null);
    assert.equal(record.attempts?.[0]?.state, 'needs_input');

    const cancelFixture = makeHandoffFixture('c6-reconcile-cancel');
    try {
      const cancelId = seedUncertainty(cancelFixture.task);
      transact(cancelFixture.task, {
        actor: 'fixture',
        purpose: 'cancel-pending',
        apply: (record) => {
          record.claims![0]!.cancel_pending = true;
          return { record, op: 'cancel-pending', summary: {} };
        },
      });
      const resolved = applyFile(
        cancelFixture,
        'reconcile',
        'cancel.json',
        reconcileRequest(cancelId),
      );
      assert.equal(resolved.status, 0, resolved.stderr);
      const cancelRecord = readRecord(cancelFixture.task)!;
      assert.equal(cancelRecord.claims?.[0]?.cancel_pending, true);
      assert.equal(cancelRecord.claims?.[0]?.released_at, null);
    } finally {
      cancelFixture.domain.cleanup();
    }
  } finally {
    approvalFixture.domain.cleanup();
  }
});

test('reconcile refuses stale epoch, stale revision and unknown uncertainty', () => {
  const fixture = makeHandoffFixture('c6-reconcile-stale');
  try {
    const uncertaintyId = seedUncertainty(fixture.task);
    const staleEpoch = applyFile(
      fixture,
      'reconcile',
      'stale-epoch.json',
      reconcileRequest(uncertaintyId, { owner_epoch: 2 }),
    );
    assert.equal(staleEpoch.status, 1, staleEpoch.stderr);
    assert.equal(json(staleEpoch).reason, 'stale_epoch');
    const staleRevision = applyFile(
      fixture,
      'reconcile',
      'stale-revision.json',
      reconcileRequest(uncertaintyId, { expect_revision: 999 }),
    );
    assert.equal(staleRevision.status, 1, staleRevision.stderr);
    assert.equal(json(staleRevision).reason, 'revision_conflict');
    const unknown = applyFile(
      fixture,
      'reconcile',
      'unknown.json',
      reconcileRequest('unc-missing'),
    );
    assert.equal(unknown.status, 1, unknown.stderr);
    assert.equal(json(unknown).reason, 'unknown_uncertainty');
    assert.equal(readRecord(fixture.task)?.uncertainty?.[0]?.resolved_at, null);
  } finally {
    fixture.domain.cleanup();
  }
});

test('lock-break requires the inspected fingerprint and archives evidence', () => {
  const fixture = makeHandoffFixture('c6-lock-break');
  try {
    const holder = acquireLock(fixture.task, {
      actor: 'lock-holder',
      purpose: 'fixture-lock',
      waitMs: 1000,
    });
    try {
      const inspected = inspect(fixture.task, fixture.domain.root);
      assert.equal(inspected.status, 0, inspected.stderr);
      const fingerprint = String(
        (json(inspected).lock as Record<string, unknown>).fingerprint,
      );
      assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/);
      const requestFile = writeRequest(
        fixture.domain,
        'break.json',
        lockBreakRequest(fingerprint),
      );
      const beforePlan = snapshotTree(fixture.domain.root);
      const plan = run(
        recoveryArgs('lock-break', fixture.task, requestFile, false),
        fixture.domain.root,
      );
      assert.equal(plan.status, 0, plan.stderr);
      assert.deepEqual(snapshotTree(fixture.domain.root), beforePlan);

      const applied = run(
        recoveryArgs('lock-break', fixture.task, requestFile, true),
        fixture.domain.root,
      );
      assert.equal(applied.status, 0, applied.stderr);
      const body = json(applied);
      assert.equal(body.applied, true);
      assert.equal(existsSync(lockPath(fixture.task)), false);
      const archives = readdirSync(brokenLocksDir(fixture.task));
      assert.equal(archives.length, 1);
      const archive = join(brokenLocksDir(fixture.task), archives[0]!);
      const breakRecord = JSON.parse(
        readFileSync(join(archive, 'break-record.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(breakRecord.confirm_holder_stopped, true);
      assert.equal(
        (breakRecord.previous_holder as Record<string, unknown>).actor,
        holder.actor,
      );
      const after = inspect(fixture.task, fixture.domain.root);
      assert.equal(after.status, 0, after.stderr);
      assert.equal((json(after).lock as Record<string, unknown>).held, false);
    } finally {
      // The lock is archived; releaseLock is safe/no-op if it is already gone.
      releaseLock(fixture.task, holder);
    }
  } finally {
    fixture.domain.cleanup();
  }
});

test('lock-break refuses changed locks, missing locks and stale epochs', () => {
  const fixture = makeHandoffFixture('c6-lock-changed');
  try {
    const holder = acquireLock(fixture.task, {
      actor: 'first-holder',
      purpose: 'fixture',
      waitMs: 1000,
    });
    try {
      const fingerprint = String(
        (
          json(inspect(fixture.task, fixture.domain.root)).lock as Record<
            string,
            unknown
          >
        ).fingerprint,
      );
      releaseLock(fixture.task, holder);
      const replacement = acquireLock(fixture.task, {
        actor: 'replacement-holder',
        purpose: 'fixture',
        waitMs: 1000,
      });
      try {
        const changed = applyFile(
          fixture,
          'lock-break',
          'changed.json',
          lockBreakRequest(fingerprint),
        );
        assert.equal(changed.status, 1, changed.stderr);
        assert.equal(json(changed).code, 'lock_changed');
        assert.equal(readLock(fixture.task).held, true);
      } finally {
        releaseLock(fixture.task, replacement);
      }
    } finally {
      // Original holder may already be released.
      releaseLock(fixture.task, holder);
    }

    const absentFingerprint = String(
      (
        json(inspect(fixture.task, fixture.domain.root)).lock as Record<
          string,
          unknown
        >
      ).fingerprint,
    );
    const noLock = applyFile(
      fixture,
      'lock-break',
      'no-lock.json',
      lockBreakRequest(absentFingerprint),
    );
    assert.equal(noLock.status, 1, noLock.stderr);
    assert.equal(json(noLock).code, 'no_lock');

    const staleHolder = acquireLock(fixture.task, {
      actor: 'stale-holder',
      purpose: 'fixture',
      waitMs: 1000,
    });
    try {
      const staleFingerprint = String(
        (
          json(inspect(fixture.task, fixture.domain.root)).lock as Record<
            string,
            unknown
          >
        ).fingerprint,
      );
      const stale = applyFile(
        fixture,
        'lock-break',
        'stale.json',
        lockBreakRequest(staleFingerprint, { owner_epoch: 2 }),
      );
      assert.equal(stale.status, 1, stale.stderr);
      assert.equal(json(stale).code, 'stale_epoch');
      assert.equal(readLock(fixture.task).held, true);
    } finally {
      releaseLock(fixture.task, staleHolder);
    }
  } finally {
    fixture.domain.cleanup();
  }
});

test('inspect reports oversized lock snapshots without recovery', () => {
  const fixture = makeHandoffFixture('c6-lock-limit');
  try {
    mkdirSync(lockPath(fixture.task), { recursive: true, mode: 0o700 });
    writeFileSync(join(lockPath(fixture.task), 'holder.json'), '{}\n');
    for (let index = 0; index < 257; index += 1)
      writeFileSync(join(lockPath(fixture.task), `txn-${index}.json`), '{}\n');
    const result = inspect(fixture.task, fixture.domain.root);
    assert.equal(result.status, 1, result.stderr);
    const body = json(result);
    const lock = body.lock as Record<string, unknown>;
    assert.equal(lock.fingerprint_status, 'unavailable');
    assert.equal(lock.fingerprint_reason, 'lock_snapshot_entry_limit');
    const request = writeRequest(
      fixture.domain,
      'limit-break.json',
      lockBreakRequest('sha256:unavailable'),
    );
    const applied = run(
      recoveryArgs('lock-break', fixture.task, request, true),
      fixture.domain.root,
    );
    assert.equal(applied.status, 1, applied.stderr);
    assert.equal(json(applied).code, 'lock_fingerprint_unavailable');
    assert.equal(lstatSync(lockPath(fixture.task)).isDirectory(), true);
  } finally {
    fixture.domain.cleanup();
  }
});

test('recovery requests reject strict, unsafe and wrong-action input', () => {
  const fixture = makeHandoffFixture('c6-strict');
  try {
    const uncertaintyId = seedUncertainty(fixture.task);
    const valid = writeRequest(
      fixture.domain,
      'valid.json',
      reconcileRequest(uncertaintyId),
    );
    const unrelated = join(fixture.domain.root, 'elsewhere');
    mkdirSync(unrelated, { recursive: true });
    const relative = run(
      recoveryArgs('reconcile', fixture.task, 'valid.json', false),
      unrelated,
    );
    assert.equal(relative.status, 2);
    const wrong = writeRequest(
      fixture.domain,
      'wrong.json',
      lockBreakRequest('sha256:abc'),
    );
    const wrongAction = run(
      recoveryArgs('reconcile', fixture.task, wrong, false),
      unrelated,
    );
    assert.equal(wrongAction.status, 2);
    const unknownField = writeRequest(fixture.domain, 'unknown.json', {
      ...reconcileRequest(uncertaintyId),
      secret: 'SECRET-RECOVERY-VALUE',
    });
    const unknown = run(
      recoveryArgs('reconcile', fixture.task, unknownField, false),
      unrelated,
    );
    assert.equal(unknown.status, 2);
    assert.ok(!unknown.stdout.includes('SECRET-RECOVERY-VALUE'));
    const missing = run(
      [
        'collab',
        'recovery',
        'reconcile',
        '--task-root',
        fixture.task,
        '--json',
      ],
      unrelated,
    );
    assert.equal(missing.status, 2);
    const inspectApply = run(
      [
        'collab',
        'recovery',
        'inspect',
        '--task-root',
        fixture.task,
        '--apply',
        '--json',
      ],
      unrelated,
    );
    assert.equal(inspectApply.status, 2);
    const duplicate = run(
      [
        'collab',
        'recovery',
        'reconcile',
        '--task-root',
        fixture.task,
        '--request',
        valid,
        '--request',
        valid,
        '--json',
      ],
      unrelated,
    );
    assert.equal(duplicate.status, 2);
    const noConfirm = writeRequest(
      fixture.domain,
      'no-confirm.json',
      lockBreakRequest('sha256:abc', { confirm_holder_stopped: false }),
    );
    const noConfirmRun = run(
      recoveryArgs('lock-break', fixture.task, noConfirm, false),
      unrelated,
    );
    assert.equal(noConfirmRun.status, 2);

    const oversize = join(fixture.domain.root, 'oversize.json');
    writeFileSync(oversize, '');
    truncateSync(oversize, 1024 * 1024 + 1);
    const big = run(
      recoveryArgs('reconcile', fixture.task, oversize, false),
      unrelated,
    );
    assert.equal(big.status, 2);
    const fifo = join(fixture.domain.root, 'request.fifo');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const started = Date.now();
    const blocked = run(
      recoveryArgs('reconcile', fixture.task, fifo, false),
      unrelated,
      2_000,
    );
    assert.ok(Date.now() - started < 2_000);
    assert.equal(blocked.status, 2);
    assert.equal(readRecord(fixture.task)?.uncertainty?.[0]?.resolved_at, null);
  } finally {
    fixture.domain.cleanup();
  }
});

test('separate CLI processes cannot break one lock twice', async () => {
  const fixture = makeHandoffFixture('c6-lock-race');
  try {
    const holder = acquireLock(fixture.task, {
      actor: 'race-holder',
      purpose: 'fixture',
      waitMs: 1000,
    });
    try {
      const fingerprint = String(
        (
          json(inspect(fixture.task, fixture.domain.root)).lock as Record<
            string,
            unknown
          >
        ).fingerprint,
      );
      const request = writeRequest(
        fixture.domain,
        'race-break.json',
        lockBreakRequest(fingerprint),
      );
      const results = await Promise.all(
        Array.from(
          { length: 2 },
          () =>
            new Promise<{ code: number | null; stdout: string }>(
              (resolve, reject) => {
                const child = spawn(
                  process.execPath,
                  [
                    CLI,
                    ...recoveryArgs('lock-break', fixture.task, request, true),
                  ],
                  {
                    cwd: fixture.domain.root,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    shell: false,
                    timeout: 20_000,
                  },
                );
                let stdout = '';
                child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
                  stdout += chunk;
                });
                child.stderr.setEncoding('utf8').on('data', () => undefined);
                child.on('error', reject);
                child.on('close', (code) => resolve({ code, stdout }));
              },
            ),
        ),
      );
      assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
      assert.equal(readdirSync(brokenLocksDir(fixture.task)).length, 1);
      assert.equal(existsSync(lockPath(fixture.task)), false);
    } finally {
      releaseLock(fixture.task, holder);
    }
  } finally {
    fixture.domain.cleanup();
  }
});

test('human recovery plans say no write and never report applied', () => {
  const fixture = makeHandoffFixture('c6-human-plan');
  try {
    const uncertaintyId = seedUncertainty(fixture.task);
    const reconcileFile = writeRequest(
      fixture.domain,
      'human-reconcile.json',
      reconcileRequest(uncertaintyId),
    );
    const beforeReconcile = snapshotTree(fixture.domain.root);
    const reconcile = run(
      [
        'collab',
        'recovery',
        'reconcile',
        '--task-root',
        fixture.task,
        '--request',
        reconcileFile,
      ],
      fixture.domain.root,
    );
    assert.equal(reconcile.status, 0, reconcile.stderr);
    assert.match(reconcile.stdout, /plan/i);
    assert.match(reconcile.stdout, /nothing was written/i);
    assert.ok(!/Reconcile applied/i.test(reconcile.stdout));
    assert.deepEqual(snapshotTree(fixture.domain.root), beforeReconcile);
    assert.equal(readRecord(fixture.task)?.uncertainty?.[0]?.resolved_at, null);

    const lockFile = writeRequest(
      fixture.domain,
      'human-lock.json',
      lockBreakRequest(`sha256:${'0'.repeat(64)}`),
    );
    const beforeLock = snapshotTree(fixture.domain.root);
    const lockPlan = run(
      [
        'collab',
        'recovery',
        'lock-break',
        '--task-root',
        fixture.task,
        '--request',
        lockFile,
      ],
      fixture.domain.root,
    );
    assert.equal(lockPlan.status, 0, lockPlan.stderr);
    assert.match(lockPlan.stdout, /plan/i);
    assert.match(lockPlan.stdout, /nothing was archived/i);
    assert.ok(!/archived /i.test(lockPlan.stdout));
    assert.deepEqual(snapshotTree(fixture.domain.root), beforeLock);
  } finally {
    fixture.domain.cleanup();
  }
});

test('reconcile reports uncertain effects after late and early transaction faults', async () => {
  const mutableFs = fs as unknown as {
    appendFileSync: typeof fs.appendFileSync;
    renameSync: typeof fs.renameSync;
  };
  const lateFixture = makeHandoffFixture('c6-late-ledger');
  const earlyFixture = makeHandoffFixture('c6-early-rename');
  try {
    const lateId = seedUncertainty(lateFixture.task);
    const ledgerBefore = readFileSync(ledgerPath(lateFixture.task));
    const originalAppend = mutableFs.appendFileSync;
    mutableFs.appendFileSync = () => {
      const error = new Error('injected EIO');
      (error as Error & { code: string }).code = 'EIO';
      throw error;
    };
    try {
      const late = await applyRecovery(
        lateFixture.task,
        reconcileRequest(lateId) as unknown as CollaborationRecoveryRequest,
      );
      assert.equal(late.ok, false);
      if (!late.ok) {
        assert.equal(late.code, 'reconcile_uncertain');
        assert.ok(!late.message.includes('EIO'));
      }
      const record = readRecord(lateFixture.task)!;
      assert.ok(record.uncertainty?.[0]?.resolved_at);
      assert.deepEqual(
        readFileSync(ledgerPath(lateFixture.task)),
        ledgerBefore,
      );
    } finally {
      mutableFs.appendFileSync = originalAppend;
    }

    const earlyId = seedUncertainty(earlyFixture.task);
    const originalRename = mutableFs.renameSync;
    mutableFs.renameSync = () => {
      const error = new Error('injected rename EIO');
      (error as Error & { code: string }).code = 'EIO';
      throw error;
    };
    try {
      const early = await applyRecovery(
        earlyFixture.task,
        reconcileRequest(earlyId) as unknown as CollaborationRecoveryRequest,
      );
      assert.equal(early.ok, false);
      if (!early.ok) {
        assert.equal(early.code, 'reconcile_uncertain');
        assert.ok(!early.message.includes('EIO'));
      }
      assert.equal(
        readRecord(earlyFixture.task)?.uncertainty?.[0]?.resolved_at,
        null,
      );
    } finally {
      mutableFs.renameSync = originalRename;
    }
  } finally {
    lateFixture.domain.cleanup();
    earlyFixture.domain.cleanup();
  }
});
