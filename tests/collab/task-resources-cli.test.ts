import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { claimResources, releaseClaim } from '../../src/collab/resources.js';
import { ledgerPath, readRecord, transact } from '../../src/collab/store.js';
import { cleanup } from '../workspace/fixtures.js';
import {
  CLAIMANT,
  OTHER,
  claimRequest,
  makeTaskDomain,
  releaseRequest,
  snapshotTree,
  writeRequest,
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
    maxBuffer: 8 * 1024 * 1024,
  });
}

function json(result: ReturnType<typeof run>): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function seedClaim(taskRoot: string, target: string, holder = OTHER): string {
  const seeded = claimResources(taskRoot, {
    resources: [{ kind: 'path', path: target }],
    holder,
  });
  assert.equal(seeded.ok, true);
  return seeded.claims[0]!.claim_id;
}

function requestArgs(
  action: 'claim' | 'release',
  taskRoot: string,
  requestFile: string,
  apply: boolean,
): string[] {
  return [
    'collab',
    'resource',
    action,
    '--task-root',
    taskRoot,
    '--request',
    requestFile,
    ...(apply ? ['--apply'] : []),
    '--json',
  ];
}

test('resource list/plan/apply/release separate plans from real conflicts', () => {
  const fixture = makeTaskDomain('c4-resources', ['a', 'b']);
  const taskA = fixture.tasks.a!;
  const taskB = fixture.tasks.b!;
  try {
    const contested = join(fixture.root, 'contested');
    const free = join(fixture.root, 'free');
    const seeded = seedClaim(taskB, contested);
    assert.ok(seeded);

    const contestedRequest = writeRequest(
      fixture.root,
      'a-contested.json',
      claimRequest(CLAIMANT, [{ kind: 'path', path: contested }]),
    );
    const beforePlan = snapshotTree(fixture.root);
    const plan = run(
      requestArgs('claim', taskA, contestedRequest, false),
      fixture.root,
    );
    assert.equal(plan.status, 0, plan.stderr);
    const planned = json(plan);
    assert.equal(planned.action, 'claim');
    assert.equal(planned.applied, false);
    assert.equal(planned.status, 'planned');
    assert.deepEqual(snapshotTree(fixture.root), beforePlan);

    const conflictApply = run(
      requestArgs('claim', taskA, contestedRequest, true),
      fixture.root,
    );
    assert.equal(conflictApply.status, 1, conflictApply.stderr);
    const conflict = json(conflictApply);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, 'resource_conflict');
    assert.equal(readRecord(taskA)?.claims?.length, 0);

    const freeRequest = writeRequest(
      fixture.root,
      'a-free.json',
      claimRequest(CLAIMANT, [{ path: free }]),
    );
    const freePlan = run(
      requestArgs('claim', taskA, freeRequest, false),
      fixture.root,
    );
    assert.equal(freePlan.status, 0, freePlan.stderr);
    assert.equal(readRecord(taskA)?.claims?.length, 0);
    const freeApply = run(
      requestArgs('claim', taskA, freeRequest, true),
      fixture.root,
    );
    assert.equal(freeApply.status, 0, freeApply.stderr);
    const applied = json(freeApply);
    assert.equal(applied.ok, true);
    assert.equal(applied.applied, true);
    const claim = readRecord(taskA)?.claims?.[0];
    assert.ok(claim);

    const list = run(
      ['collab', 'resource', 'list', '--task-root', taskA, '--json'],
      fixture.root,
    );
    assert.equal(list.status, 0, list.stderr);
    const inventory = json(list);
    assert.equal(inventory.ok, true);
    assert.equal(inventory.state, 'known');
    assert.equal((inventory.counts as Record<string, unknown>).claims, 2);

    const wrongHolderRelease = writeRequest(
      fixture.root,
      'release-wrong.json',
      releaseRequest(OTHER, claim.claim_id),
    );
    const releasePlan = run(
      requestArgs('release', taskA, wrongHolderRelease, false),
      fixture.root,
    );
    assert.equal(releasePlan.status, 0, releasePlan.stderr);
    assert.equal(json(releasePlan).applied, false);
    const beforeWrongApply = snapshotTree(fixture.root);
    const wrongApply = run(
      requestArgs('release', taskA, wrongHolderRelease, true),
      fixture.root,
    );
    assert.equal(wrongApply.status, 1, wrongApply.stderr);
    assert.equal(json(wrongApply).reason, 'holder_mismatch');
    assert.deepEqual(snapshotTree(fixture.root), beforeWrongApply);

    const correctRelease = writeRequest(
      fixture.root,
      'release-correct.json',
      releaseRequest(CLAIMANT, claim.claim_id),
    );
    const released = run(
      requestArgs('release', taskA, correctRelease, true),
      fixture.root,
    );
    assert.equal(released.status, 0, released.stderr);
    assert.equal(json(released).applied, true);
    assert.ok(readRecord(taskA)?.claims?.[0]?.released_at);

    const again = run(
      requestArgs('release', taskA, correctRelease, true),
      fixture.root,
    );
    assert.equal(again.status, 1, again.stderr);
    assert.equal(json(again).reason, 'already_released');
  } finally {
    fixture.cleanup();
  }
});

test('resource list applies one global claim output budget across tasks', () => {
  const fixture = makeTaskDomain('c4-resource-budget', ['a', 'b']);
  const taskA = fixture.tasks.a!;
  const taskB = fixture.tasks.b!;
  try {
    for (const [taskRoot, label, holder] of [
      [taskA, 'a', CLAIMANT],
      [taskB, 'b', OTHER],
    ] as const) {
      const resources = Array.from({ length: 300 }, (_, index) => ({
        kind: 'path',
        path: join(fixture.root, `${label}-target-${index}`),
      }));
      const seeded = claimResources(taskRoot, { resources, holder });
      assert.equal(seeded.ok, true);
      assert.equal(seeded.claims.length, 300);
    }
    const unrelated = join(fixture.root, 'elsewhere');
    mkdirSync(unrelated, { recursive: true });
    const before = snapshotTree(fixture.root);
    const list = run(
      ['collab', 'resource', 'list', '--task-root', taskA, '--json'],
      unrelated,
    );
    assert.equal(list.status, 0, list.stderr);
    const body = json(list);
    const tasks = body.tasks as { claims: unknown[] }[];
    const emitted = tasks.reduce(
      (total, task) => total + task.claims.length,
      0,
    );
    assert.equal(emitted, 500);
    assert.equal((body.counts as Record<string, unknown>).claims, 600);
    assert.equal((body.counts as Record<string, unknown>).tasks, 2);
    assert.deepEqual(body.omitted, {
      tasks: 0,
      claims: 100,
      unreadable_tasks: 0,
    });
    assert.equal(body.truncated, true);
    assert.deepEqual(snapshotTree(fixture.root), before);
  } finally {
    fixture.cleanup();
  }
});

test('resource list and claim preserve unreadable-domain uncertainty', () => {
  const fixture = makeTaskDomain('c4-unreadable', ['a', 'b']);
  const taskA = fixture.tasks.a!;
  const taskB = fixture.tasks.b!;
  try {
    writeFileSync(join(taskB, 'task.json'), '{not-json\n');
    const list = run(
      ['collab', 'resource', 'list', '--task-root', taskA, '--json'],
      fixture.root,
    );
    assert.equal(list.status, 1, list.stderr);
    const inventory = json(list);
    assert.equal(inventory.ok, false);
    assert.equal(inventory.state, 'unknown');
    assert.deepEqual(inventory.unreadable_tasks, ['b']);

    const request = writeRequest(
      fixture.root,
      'unknown.json',
      claimRequest(CLAIMANT, [
        { kind: 'path', path: join(fixture.root, 'unknown-target') },
      ]),
    );
    const plan = run(requestArgs('claim', taskA, request, false), fixture.root);
    assert.equal(plan.status, 0, plan.stderr);
    const apply = run(requestArgs('claim', taskA, request, true), fixture.root);
    assert.equal(apply.status, 1, apply.stderr);
    assert.equal(json(apply).reason, 'domain_state_unknown');
    assert.equal(readRecord(taskA)?.claims?.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('resource operations refuse nested ledger and domain-lock redirects', () => {
  const ledgerFixture = makeTaskDomain('c4-ledger-redirect', ['a']);
  try {
    const task = ledgerFixture.tasks.a!;
    const outsideLedger = join(ledgerFixture.outside, 'ledger.jsonl');
    writeFileSync(outsideLedger, 'outside\n');
    unlinkSync(ledgerPath(task));
    symlinkSync(outsideLedger, ledgerPath(task));
    const request = writeRequest(
      ledgerFixture.root,
      'claim.json',
      claimRequest(CLAIMANT, [
        { kind: 'path', path: join(ledgerFixture.root, 'target') },
      ]),
    );
    const applied = run(
      requestArgs('claim', task, request, true),
      ledgerFixture.root,
    );
    assert.equal(applied.status, 1, applied.stderr);
    assert.equal(json(applied).code, 'task_ledger_unsafe');
    assert.equal(readFileSync(outsideLedger, 'utf8'), 'outside\n');
    assert.equal(readRecord(task)?.claims?.length, 0);
  } finally {
    ledgerFixture.cleanup();
  }

  const domainFixture = makeTaskDomain('c4-domain-lock-redirect', ['a']);
  try {
    const task = domainFixture.tasks.a!;
    const outsideLock = join(domainFixture.outside, 'domain-lock');
    mkdirSync(outsideLock, { recursive: true });
    symlinkSync(outsideLock, join(domainFixture.domainRoot, '.domain.lock'));
    const request = writeRequest(
      domainFixture.root,
      'claim.json',
      claimRequest(CLAIMANT, [
        { kind: 'path', path: join(domainFixture.root, 'target') },
      ]),
    );
    const plan = run(
      requestArgs('claim', task, request, false),
      domainFixture.root,
    );
    assert.equal(plan.status, 1, plan.stderr);
    assert.equal(json(plan).code, 'domain_lock_unsafe');
    assert.deepEqual(
      lstatSync(
        join(domainFixture.domainRoot, '.domain.lock'),
      ).isSymbolicLink(),
      true,
    );
  } finally {
    domainFixture.cleanup();
  }
});

test('resource scans refuse neighboring task/record redirects', () => {
  const fixture = makeTaskDomain('c4-neighbor-redirect', ['a', 'b']);
  const taskA = fixture.tasks.a!;
  const taskB = fixture.tasks.b!;
  try {
    const outsideRecord = join(fixture.outside, 'task.json');
    writeFileSync(
      outsideRecord,
      JSON.stringify(readRecord(taskB), null, 2) + '\n',
    );
    unlinkSync(join(taskB, 'task.json'));
    symlinkSync(outsideRecord, join(taskB, 'task.json'));
    const list = run(
      ['collab', 'resource', 'list', '--task-root', taskA, '--json'],
      fixture.root,
    );
    assert.equal(list.status, 1, list.stderr);
    assert.equal(json(list).code, 'domain_state_unsafe');

    const request = writeRequest(
      fixture.root,
      'neighbor.json',
      claimRequest(CLAIMANT, [
        { kind: 'path', path: join(fixture.root, 'neighbor-target') },
      ]),
    );
    const plan = run(requestArgs('claim', taskA, request, false), fixture.root);
    assert.equal(plan.status, 1, plan.stderr);
    assert.equal(json(plan).code, 'domain_state_unsafe');
  } finally {
    fixture.cleanup();
  }
});

test('separate CLI processes cannot both claim one cross-task resource', async () => {
  const fixture = makeTaskDomain('c4-parallel', ['a', 'b']);
  const taskA = fixture.tasks.a!;
  const taskB = fixture.tasks.b!;
  const contested = join(fixture.root, 'contended');
  try {
    const requestA = writeRequest(
      fixture.root,
      'parallel-a.json',
      claimRequest(CLAIMANT, [{ kind: 'path', path: contested }]),
    );
    const requestB = writeRequest(
      fixture.root,
      'parallel-b.json',
      claimRequest(OTHER, [{ kind: 'path', path: contested }]),
    );
    const results = await Promise.all(
      [
        requestArgs('claim', taskA, requestA, true),
        requestArgs('claim', taskB, requestB, true),
      ].map(
        (args) =>
          new Promise<{ code: number | null; stdout: string; stderr: string }>(
            (resolve, reject) => {
              const child = spawn(process.execPath, [CLI, ...args], {
                cwd: fixture.root,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false,
                timeout: 20_000,
              });
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
    const bodies = results.map((result, index) => {
      if (!result.stdout.trim())
        throw new Error(
          `empty stdout for child ${index}: code=${String(result.code)} stderr=${result.stderr}`,
        );
      return JSON.parse(result.stdout) as Record<string, unknown>;
    });
    assert.equal(bodies.filter((body) => body.ok === true).length, 1);
    assert.equal(
      bodies.filter((body) => body.reason === 'resource_conflict').length,
      1,
    );
    assert.equal(
      [taskA, taskB].flatMap((task) => readRecord(task)?.claims ?? []).length,
      1,
    );
  } finally {
    fixture.cleanup();
  }
});

test('public claims derive worktree Git resources and honor shared-Git opt-in', () => {
  const fixture = makeTaskDomain('c4-git-resources', ['a', 'b']);
  const taskA = fixture.tasks.a!;
  const taskB = fixture.tasks.b!;
  try {
    const common = join(fixture.root, 'main', '.git');
    const one = join(fixture.root, 'one');
    const two = join(fixture.root, 'two');
    for (const [name, tree] of [
      ['one', one],
      ['two', two],
    ] as const) {
      mkdirSync(tree, { recursive: true });
      const git = join(common, 'worktrees', name);
      mkdirSync(git, { recursive: true });
      writeFileSync(join(git, 'commondir'), '../..');
      writeFileSync(join(tree, '.git'), `gitdir: ${git}\n`);
    }
    const oneRequest = writeRequest(
      fixture.root,
      'one.json',
      claimRequest(CLAIMANT, [{ kind: 'path', path: one }]),
    );
    const oneApply = run(
      requestArgs('claim', taskA, oneRequest, true),
      fixture.root,
    );
    assert.equal(oneApply.status, 0, `${oneApply.stdout}\n${oneApply.stderr}`);
    const oneKinds = (readRecord(taskA)?.claims ?? []).map(
      (claim) => claim.kind,
    );
    assert.ok(oneKinds.includes('git-index'));
    assert.ok(oneKinds.includes('git-head'));
    assert.ok(!oneKinds.includes('git-common-dir'));

    const twoRequest = writeRequest(
      fixture.root,
      'two.json',
      claimRequest(OTHER, [{ kind: 'path', path: two }], {
        include_shared_git: true,
      }),
    );
    for (const claim of readRecord(taskA)?.claims ?? [])
      assert.equal(
        releaseClaim(taskA, {
          claimId: claim.claim_id,
          holder: CLAIMANT,
        }).ok,
        true,
      );
    const twoApply = run(
      requestArgs('claim', taskB, twoRequest, true),
      fixture.root,
    );
    assert.equal(twoApply.status, 0, `${twoApply.stdout}\n${twoApply.stderr}`);
    assert.ok(
      (readRecord(taskB)?.claims ?? []).some(
        (claim) => claim.kind === 'git-common-dir',
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test('resource requests fail closed on strict, unsafe and oversized input', () => {
  const fixture = makeTaskDomain('c4-strict', ['a']);
  const task = fixture.tasks.a!;
  try {
    const unrelated = join(fixture.root, 'elsewhere');
    mkdirSync(unrelated, { recursive: true });
    const valid = writeRequest(
      fixture.root,
      'valid.json',
      claimRequest(CLAIMANT, [
        { kind: 'path', path: join(fixture.root, 'target') },
      ]),
    );
    const list = run(
      ['collab', 'resource', 'list', '--task-root', task, '--json'],
      unrelated,
    );
    assert.equal(list.status, 0, list.stderr);
    assert.equal(json(list).schema, 'pappra/collaboration-resources/1');

    const secret = 'SECRET-REQUEST-BODY';
    const malformed = join(fixture.root, 'malformed.json');
    writeFileSync(malformed, `{"schema":"bad","secret":"${secret}"`);
    const bad = run(requestArgs('claim', task, malformed, false), unrelated);
    assert.equal(bad.status, 2);
    assert.ok(!bad.stdout.includes(secret));

    const unknownField = writeRequest(
      fixture.root,
      'unknown-field.json',
      claimRequest(CLAIMANT, [
        { kind: 'path', path: join(fixture.root, 'target'), origin: 'fake' },
      ]),
    );
    const unknown = run(
      requestArgs('claim', task, unknownField, false),
      unrelated,
    );
    assert.equal(unknown.status, 2);

    const relativePath = writeRequest(
      fixture.root,
      'relative.json',
      claimRequest(CLAIMANT, [{ kind: 'path', path: 'relative' }]),
    );
    const relative = run(
      requestArgs('claim', task, relativePath, false),
      unrelated,
    );
    assert.equal(relative.status, 2);

    const mismatch = writeRequest(
      fixture.root,
      'mismatch.json',
      releaseRequest(CLAIMANT, 'claim-missing'),
    );
    const actionMismatch = run(
      requestArgs('claim', task, mismatch, false),
      unrelated,
    );
    assert.equal(actionMismatch.status, 2);

    const missing = run(
      ['collab', 'resource', 'claim', '--task-root', task, '--json'],
      unrelated,
    );
    assert.equal(missing.status, 2);

    const listApply = run(
      ['collab', 'resource', 'list', '--task-root', task, '--apply', '--json'],
      unrelated,
    );
    assert.equal(listApply.status, 2);

    const duplicate = run(
      [
        'collab',
        'resource',
        'claim',
        '--task-root',
        task,
        '--request',
        valid,
        '--request',
        valid,
        '--json',
      ],
      unrelated,
    );
    assert.equal(duplicate.status, 2);

    const oversize = join(fixture.root, 'oversize.json');
    writeFileSync(oversize, '');
    truncateSync(oversize, 1024 * 1024 + 1);
    const big = run(requestArgs('claim', task, oversize, false), unrelated);
    assert.equal(big.status, 2);

    const fifo = join(fixture.root, 'request.fifo');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const started = Date.now();
    const blocked = run(
      requestArgs('claim', task, fifo, false),
      unrelated,
      2000,
    );
    assert.ok(Date.now() - started < 2000);
    assert.equal(blocked.status, 2);
    assert.equal(readRecord(task)?.claims?.length, 0);
  } finally {
    cleanup(fixture.root);
  }
});

test('release API retains a claim with a pending cancel', () => {
  const fixture = makeTaskDomain('c4-release-boundary', ['a']);
  const task = fixture.tasks.a!;
  try {
    const claimId = seedClaim(task, join(fixture.root, 'held'), CLAIMANT);
    const mismatch = releaseClaim(task, {
      claimId,
      holder: OTHER,
      reason: 'wrong holder',
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'holder_mismatch');
    assert.equal(readRecord(task)?.claims?.[0]?.released_at, null);

    transact(task, {
      actor: 'test',
      purpose: 'mark-cancel-pending',
      apply: (record) => {
        record.claims[0]!.cancel_pending = true;
        return {
          record,
          op: 'mark-cancel-pending',
          summary: { claim_id: claimId },
        };
      },
    });
    const releaseFile = writeRequest(
      fixture.root,
      'release-cancel.json',
      releaseRequest(CLAIMANT, claimId),
    );
    const refused = run(
      requestArgs('release', task, releaseFile, true),
      fixture.root,
    );
    assert.equal(refused.status, 1, refused.stderr);
    assert.equal(json(refused).reason, 'cancel_unconfirmed');
    assert.equal(readRecord(task)?.claims?.[0]?.released_at, null);
  } finally {
    fixture.cleanup();
  }
});
