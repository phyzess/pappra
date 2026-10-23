import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openUncertainty } from '../../src/collab/lifecycle.js';
import { claimResources } from '../../src/collab/resources.js';
import {
  acquireLock,
  lockPath,
  releaseLock,
  transact,
} from '../../src/collab/store.js';
import {
  CLAIMANT,
  makeTaskDomain,
  snapshotTree,
} from './task-resources-fixtures.js';

const ROOT = join(
  dirname(fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json'))),
);
const CLI = join(ROOT, 'dist/cli/main.js');

function run(args: readonly string[], cwd: string, timeout = 30_000) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function json(result: ReturnType<typeof run>): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test('state show and doctor are read-only projections with bounded locks', () => {
  const fixture = makeTaskDomain('c4-state', ['sample']);
  const task = fixture.tasks.sample!;
  try {
    const clean = run(
      ['collab', 'state', 'doctor', '--task-root', task, '--json'],
      fixture.root,
    );
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(json(clean).ok, true);
    assert.equal((json(clean).counts as Record<string, unknown>).findings, 0);
    const seeded = claimResources(task, {
      resources: [{ kind: 'path', path: join(fixture.root, 'work') }],
      holder: CLAIMANT,
    });
    assert.equal(seeded.ok, true);
    const lock = acquireLock(task, {
      actor: 'test',
      purpose: 'state-fixture',
      waitMs: 1000,
    });
    try {
      const irrelevant = join(fixture.root, 'elsewhere');
      mkdirSync(irrelevant, { recursive: true });
      const before = snapshotTree(fixture.root);

      const shown = run(
        ['collab', 'state', 'show', '--task-root', task, '--json'],
        irrelevant,
      );
      assert.equal(shown.status, 0, shown.stderr);
      const state = json(shown);
      assert.equal(state.schema, 'pappra/collaboration-state/1');
      assert.equal(state.action, 'show');
      assert.equal(state.task_id, 'sample');
      assert.equal(state.messages, 0);
      assert.equal((state.claims as unknown[]).length, 1);
      assert.equal((state.lock as Record<string, unknown>).held, true);
      assert.equal((state.counts as Record<string, unknown>).claims, 1);

      const doctor = run(
        ['collab', 'state', 'doctor', '--task-root', task, '--json'],
        irrelevant,
      );
      assert.equal(doctor.status, 0, doctor.stderr);
      const diagnosis = json(doctor);
      assert.equal(diagnosis.schema, 'pappra/collaboration-state/1');
      assert.equal(diagnosis.action, 'doctor');
      assert.equal(diagnosis.ok, true);
      assert.ok(
        (diagnosis.findings as Record<string, unknown>[]).some(
          (finding) => finding.code === 'lock_held',
        ),
      );
      assert.equal((diagnosis.counts as Record<string, unknown>).active, 1);
      assert.equal((diagnosis.counts as Record<string, unknown>).uncertain, 0);
      assert.deepEqual(snapshotTree(fixture.root), before);
    } finally {
      releaseLock(task, lock);
    }
  } finally {
    fixture.cleanup();
  }
});

test('doctor treats unresolved uncertainty as needs input without writes', () => {
  const fixture = makeTaskDomain('c4-doctor-uncertainty', ['sample']);
  const task = fixture.tasks.sample!;
  try {
    const outcome = transact(task, {
      actor: 'test',
      purpose: 'open-uncertainty',
      apply: (record) => {
        const opened = openUncertainty(record, {
          kind: 'session_unobserved',
          detail: 'fixture unresolved uncertainty',
        });
        if (!opened.ok) return opened;
        return {
          record,
          op: 'open-uncertainty',
          summary: { uncertainty_id: opened.uncertainty_id },
          result: opened,
        };
      },
    });
    assert.equal(outcome.ok, true);
    const before = snapshotTree(fixture.root);
    const doctor = run(
      ['collab', 'state', 'doctor', '--task-root', task, '--json'],
      fixture.root,
    );
    assert.equal(doctor.status, 1, doctor.stderr);
    const body = json(doctor);
    assert.equal(body.ok, false);
    const counts = body.counts as Record<string, unknown>;
    assert.equal(counts.blocking, 0);
    assert.equal(counts.uncertain, 1);
    assert.ok(
      (body.findings as Record<string, unknown>[]).some(
        (finding) => finding.code === 'open_uncertainty',
      ),
    );
    assert.deepEqual(snapshotTree(fixture.root), before);
  } finally {
    fixture.cleanup();
  }
});

test('doctor needs input for a dead lock and interrupted transaction', () => {
  const fixture = makeTaskDomain('c4-doctor-dead-lock', ['sample']);
  const task = fixture.tasks.sample!;
  try {
    mkdirSync(lockPath(task), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(lockPath(task), 'holder.json'),
      `${JSON.stringify(
        {
          schema: 'harness-collab/lock/1',
          nonce: 'dead-holder',
          actor: 'stale-test',
          purpose: 'stale-test',
          pid: 2147483647,
          hostname: hostname(),
          acquired_at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(lockPath(task), 'txn-2-dead.json'), '{}\n');
    const before = snapshotTree(fixture.root);
    const doctor = run(
      ['collab', 'state', 'doctor', '--task-root', task, '--json'],
      fixture.root,
    );
    assert.equal(doctor.status, 1, doctor.stderr);
    const body = json(doctor);
    assert.equal(body.ok, false);
    const counts = body.counts as Record<string, unknown>;
    assert.equal(counts.blocking, 0);
    assert.ok(Number(counts.uncertain) >= 2);
    const codes = (body.findings as Record<string, unknown>[]).map(
      (finding) => finding.code,
    );
    assert.ok(codes.includes('lock_held'));
    assert.ok(codes.includes('uncommitted_transaction'));
    assert.deepEqual(snapshotTree(fixture.root), before);
  } finally {
    fixture.cleanup();
  }
});

test('epoch-check reports current and stale coordinator epochs', () => {
  const fixture = makeTaskDomain('c4-epoch', ['sample']);
  try {
    const current = run(
      [
        'collab',
        'state',
        'epoch-check',
        '--task-root',
        fixture.tasks.sample!,
        '--owner-epoch',
        '1',
        '--json',
      ],
      fixture.root,
    );
    assert.equal(current.status, 0, current.stderr);
    const currentBody = json(current);
    assert.equal(currentBody.ok, true);
    assert.equal(currentBody.owner_epoch, 1);
    assert.equal(currentBody.expected, 1);
    assert.equal(currentBody.actual, 1);

    const stale = run(
      [
        'collab',
        'state',
        'epoch-check',
        '--task-root',
        fixture.tasks.sample!,
        '--owner-epoch',
        '2',
        '--json',
      ],
      fixture.root,
    );
    assert.equal(stale.status, 1, stale.stderr);
    const staleBody = json(stale);
    assert.equal(staleBody.ok, false);
    assert.equal(staleBody.reason, 'stale_epoch');
    assert.equal(staleBody.expected, 1);
    assert.equal(staleBody.actual, 2);
  } finally {
    fixture.cleanup();
  }
});

test('state refuses nested lock and transaction redirects before reading them', () => {
  const fixture = makeTaskDomain('c4-state-redirect', ['sample']);
  try {
    const task = fixture.tasks.sample!;
    const lock = join(fixture.outside, 'redirected.lock');
    mkdirSync(lock, { recursive: true });
    symlinkSync(lock, lockPath(task));
    const state = run(
      ['collab', 'state', 'show', '--task-root', task, '--json'],
      fixture.root,
    );
    assert.equal(state.status, 1, state.stderr);
    const stateBody = json(state);
    assert.equal(stateBody.code, 'task_lock_unsafe');
    assert.equal(lstatSync(lock).isDirectory(), true);

    rmSync(lockPath(task), { recursive: true, force: true });
    mkdirSync(lockPath(task), { recursive: true });
    writeFileSync(join(lockPath(task), 'holder.json'), '{}\n');
    symlinkSync(
      join(fixture.outside, 'missing-txn.json'),
      join(lockPath(task), 'txn-2-x.json'),
    );
    const doctor = run(
      ['collab', 'state', 'doctor', '--task-root', task, '--json'],
      fixture.root,
    );
    assert.equal(doctor.status, 1, doctor.stderr);
    assert.equal(json(doctor).code, 'task_transaction_unsafe');
  } finally {
    fixture.cleanup();
  }
});

test('state rejects invalid options and oversized task roots', () => {
  const fixture = makeTaskDomain('c4-state-options', ['sample']);
  try {
    const task = fixture.tasks.sample!;
    const relative = run(
      ['collab', 'state', 'show', '--task-root', 'tasks/sample', '--json'],
      fixture.root,
    );
    assert.equal(relative.status, 2);

    const missingEpoch = run(
      ['collab', 'state', 'epoch-check', '--task-root', task, '--json'],
      fixture.root,
    );
    assert.equal(missingEpoch.status, 2);

    const zeroEpoch = run(
      [
        'collab',
        'state',
        'epoch-check',
        '--task-root',
        task,
        '--owner-epoch',
        '0',
        '--json',
      ],
      fixture.root,
    );
    assert.equal(zeroEpoch.status, 2);

    const unknown = run(
      [
        'collab',
        'state',
        'show',
        '--task-root',
        task,
        '--owner-epoch',
        '1',
        '--json',
      ],
      fixture.root,
    );
    assert.equal(unknown.status, 2);

    const duplicate = run(
      [
        'collab',
        'state',
        'show',
        '--task-root',
        task,
        '--task-root',
        task,
        '--json',
      ],
      fixture.root,
    );
    assert.equal(duplicate.status, 2);
  } finally {
    fixture.cleanup();
  }
});
