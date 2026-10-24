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

test('Git fixtures ignore inherited global/system config and Git routing variables', () => {
  const root = makeTempDir('fixture-git-isolation');
  const keys = [
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_DIR',
    'GIT_WORK_TREE',
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    const poisoned = join(root, 'poisoned.gitconfig');
    writeFileSync(poisoned, 'not valid git configuration\n');
    process.env.GIT_CONFIG_GLOBAL = poisoned;
    process.env.GIT_CONFIG_SYSTEM = poisoned;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'commit.gpgsign';
    process.env.GIT_CONFIG_VALUE_0 = 'true';
    process.env.GIT_DIR = join(root, 'unrelated-git-dir');
    process.env.GIT_WORK_TREE = join(root, 'unrelated-work-tree');
    createRepository(root);
    assert.equal(existsSync(join(root, '.git')), true);
    assert.equal(existsSync(join(root, 'unrelated-git-dir')), false);
    assert.equal(runGit(root, ['config', '--global', '--list']), '');
    assert.match(
      runGit(root, ['log', '-1', '--format=%an <%ae>']),
      /Fixture <fixture@example.com>/,
    );
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup(root);
  }
});
