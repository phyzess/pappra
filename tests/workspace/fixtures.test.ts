import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  cleanup,
  createRepository,
  makeTempDir,
  runGit,
  snapshotTree,
} from './fixtures.js';

test('Git fixtures disable automatic maintenance without hiding .git changes', () => {
  const root = makeTempDir('fixture-git-maintenance');
  try {
    createRepository(root);
    const lock = join(root, '.git', 'objects', 'maintenance.lock');
    assert.equal(existsSync(lock), false);

    assert.equal(
      runGit(root, ['config', '--get', 'maintenance.auto']),
      'false',
    );
    assert.equal(
      runGit(root, ['config', '--get', 'maintenance.autoDetach']),
      'false',
    );
    assert.equal(runGit(root, ['config', '--get', 'gc.auto']), '0');
    assert.equal(runGit(root, ['config', '--get', 'gc.autoDetach']), 'false');

    const before = snapshotTree(root);
    writeFileSync(lock, 'transient maintenance metadata\n');
    const after = snapshotTree(root);
    assert.equal(after.has('.git/objects/maintenance.lock'), true);
    assert.notDeepEqual(after, before);
    rmSync(lock);
  } finally {
    cleanup(root);
  }
});
