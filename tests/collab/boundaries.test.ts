import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import test from 'node:test';
import {
  pathRelation,
  claimsOverlap,
  describeResource,
} from '../../src/collab/canonical.js';
import { expandResources, claimResources } from '../../src/collab/resources.js';
import { initTask, readRecord, recordPath } from '../../src/collab/store.js';
import { messageFile } from '../../src/collab/envelope.js';
import { owner, writer } from './scenarios.js';

test('filesystem roots overlap their descendants and message identifiers cannot escape their directory', () => {
  const root = parse(process.cwd()).root;
  assert.equal(pathRelation(root, join(root, 'child')), 'ancestor');
  assert.equal(pathRelation(join(root, 'child'), root), 'descendant');
  assert.equal(
    pathRelation(join(root, 'repo-a'), join(root, 'repo-ab')),
    'disjoint',
  );
  assert(
    claimsOverlap(
      describeResource({ path: root }),
      describeResource({ path: process.cwd() }),
    ),
  );
  for (const id of ['../escaped', 'nested/file', 'nested\\file', 'bad\0id'])
    assert.throws(() => messageFile(root, id), /message_id/);
});

test('linked worktrees derive distinct index/HEAD claims and opt in to the shared common directory', () => {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), 'pappra-git-resources-'),
  );
  try {
    const common = join(root, 'main', '.git');
    const first = join(root, 'one');
    const second = join(root, 'two');
    for (const [name, tree] of [
      ['one', first],
      ['two', second],
    ] as const) {
      mkdirSync(tree, { recursive: true });
      const git = join(common, 'worktrees', name);
      mkdirSync(git, { recursive: true });
      writeFileSync(join(git, 'commondir'), '../..');
      writeFileSync(join(tree, '.git'), `gitdir: ${git}\n`);
    }
    const one = expandResources([{ path: first }]);
    const two = expandResources([{ path: second }]);
    assert.equal(one.length, 3);
    assert.equal(two.length, 3);
    assert.notEqual(
      one.find((item) => item.kind === 'git-index')?.key,
      two.find((item) => item.kind === 'git-index')?.key,
    );
    const sharedOne = expandResources([{ path: first }], {
      includeSharedGit: true,
    }).find((item) => item.kind === 'git-common-dir');
    const sharedTwo = expandResources([{ path: second }], {
      includeSharedGit: true,
    }).find((item) => item.kind === 'git-common-dir');
    assert(sharedOne && sharedTwo);
    assert.equal(sharedOne.key, sharedTwo.key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unsupported neighboring record or malformed reservation makes domain ownership unknown', () => {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), 'pappra-unknown-domain-'),
  );
  try {
    const task = join(root, 'domain', 'tasks', 'sample');
    const neighbor = join(root, 'domain', 'tasks', 'neighbor');
    initTask(task, { taskId: 'sample', coordinator: owner });
    const initial = initTask(neighbor, {
      taskId: 'neighbor',
      coordinator: owner,
    }).record;
    assert(initial);
    for (const record of [
      { ...initial, schema: 'harness-collab/state/999' },
      { ...initial, launch_reservations: 'corrupt' },
    ]) {
      writeFileSync(recordPath(neighbor), JSON.stringify(record));
      const outcome = claimResources(task, {
        resources: [{ path: join(root, 'work') }],
        holder: writer,
      });
      assert(!outcome.ok);
      assert.equal(outcome.reason, 'domain_state_unknown');
      assert.equal(readRecord(task)?.claims.length, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
