import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ensurePrivateState } from '../../src/infra/private-state.js';
import {
  cleanup,
  createRepository,
  makeTempDir,
} from '../workspace/fixtures.js';

test('first private write creates a self-contained ignore boundary before any init', async () => {
  const root = makeTempDir('private-state-first');
  try {
    createRepository(root);
    const ready = await ensurePrivateState(root);
    assert.equal(ready.ok, true, JSON.stringify(ready));
    const local = join(root, '.pappra/local');
    assert.equal(readFileSync(join(local, '.gitignore'), 'utf8'), '*\n');
    assert.equal(existsSync(join(root, '.pappra/workspace.json')), false);
    writeFileSync(
      join(local, 'machine-secret.json'),
      '{"private":"local-only"}',
    );
    const status = spawnSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '--', '.pappra/local'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, '');
    const inode = statSync(join(local, '.gitignore')).ino;
    assert.equal((await ensurePrivateState(root)).ok, true);
    assert.equal(statSync(join(local, '.gitignore')).ino, inode);
    assert.equal(readFileSync(join(local, '.gitignore'), 'utf8'), '*\n');
  } finally {
    cleanup(root);
  }
});

test('private-state preparation preserves custom rules and comments while sealing later negations', async () => {
  const root = makeTempDir('private-state-rules');
  try {
    const local = join(root, '.pappra/local');
    mkdirSync(local, { recursive: true });
    const ignore = join(local, '.gitignore');
    const original = '# User rules are retained\n*.tmp\n!machine-secret.json';
    writeFileSync(ignore, original);
    assert.equal((await ensurePrivateState(root)).ok, true);
    assert.equal(readFileSync(ignore, 'utf8'), `${original}\n*\n`);
    writeFileSync(ignore, '*\n# A user comment after the wildcard\n');
    assert.equal((await ensurePrivateState(root)).ok, true);
    assert.equal(
      readFileSync(ignore, 'utf8'),
      '*\n# A user comment after the wildcard\n',
    );
  } finally {
    cleanup(root);
  }
});

test('private-state preparation rejects redirected namespaces and ignore files without altering targets', async () => {
  for (const redirected of ['local', 'ignore'] as const) {
    const root = makeTempDir(`private-state-${redirected}`);
    const outside = makeTempDir('private-state-outside');
    try {
      const secret = join(outside, 'keep.txt');
      writeFileSync(secret, 'user content');
      mkdirSync(join(root, '.pappra'), { recursive: true });
      if (redirected === 'local')
        symlinkSync(outside, join(root, '.pappra/local'), 'dir');
      else {
        mkdirSync(join(root, '.pappra/local'));
        symlinkSync(secret, join(root, '.pappra/local/.gitignore'));
      }
      assert.equal((await ensurePrivateState(root)).ok, false);
      assert.equal(readFileSync(secret, 'utf8'), 'user content');
      assert.equal(existsSync(join(outside, '.gitignore')), false);
    } finally {
      cleanup(root);
      cleanup(outside);
    }
  }
});

test('concurrent first private writes converge without a persistent helper lock', async () => {
  const root = makeTempDir('private-state-concurrent');
  try {
    const results = await Promise.all([
      ensurePrivateState(root),
      ensurePrivateState(root),
    ]);
    assert(
      results.every((result) => result.ok),
      JSON.stringify(results),
    );
    const text = readFileSync(join(root, '.pappra/local/.gitignore'), 'utf8');
    assert.match(text, /(?:^|\n)\*\n$/);
    assert.equal((await ensurePrivateState(root)).ok, true);
  } finally {
    cleanup(root);
  }
});
