import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { discoverWorkspace } from '../../src/workspace/index.js';
import {
  addLinkedWorktree,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  linkDirectory,
  makeTempDir,
  realpath,
  removeLinkedWorktree,
  runGit,
  snapshotTree,
  writeText,
  writeWorkspaceConfig,
} from './fixtures.js';

function codes(value: {
  readonly diagnostics: readonly { readonly code: string }[];
}): string[] {
  return value.diagnostics.map((entry) => entry.code);
}

test('an empty directory yields no repositories, documents, or writes', async () => {
  const root = makeTempDir('discovery-empty');
  try {
    const before = snapshotTree(root);
    const result = await discoverWorkspace(root);
    assert.equal(result.rootState, 'directory');
    assert.equal(result.configState, 'missing');
    assert.equal(result.machineState, 'missing');
    assert.deepEqual(result.repositories, []);
    assert.deepEqual(result.documents, []);
    assert.deepEqual(result.validationCandidates, []);
    assert.equal(
      result.diagnostics.some((entry) => entry.severity === 'error'),
      false,
    );
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('discovers a single repository and a dirty tree without changing git state', async () => {
  const root = makeTempDir('discovery-single');
  try {
    createRepository(root);
    writeFileSync(join(root, 'tracked.txt'), 'modified\n');
    writeFileSync(join(root, 'untracked.txt'), 'new\n');

    const before = snapshotTree(root);
    const result = await discoverWorkspace(root);
    const repository = result.repositories.find(
      (entry) => entry.root === realpath(root),
    );
    assert(repository !== undefined);
    assert.equal(repository.kind, 'regular');
    assert.equal(repository.access, 'read');
    assert.equal(repository.id, null);
    assert.equal(repository.git.dirty, true);
    assert.equal(repository.git.branch, 'main');
    assert.match(repository.git.head ?? '', /^[0-9a-f]{40}$/);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('discovers sibling repositories with excludes, nested boundaries, and outbound symlinks', async () => {
  const root = makeTempDir('discovery-multi');
  const outside = makeTempDir('discovery-multi-outside');
  try {
    createRepository(join(root, 'apps', 'api'));
    createRepository(join(root, 'libs', 'shared'));
    createRepository(join(root, 'node_modules', 'dependency'));
    createRepository(join(root, 'excluded-project'));
    createRepository(join(root, 'deep', 'level', 'repo'));
    createRepository(outside);
    linkDirectory(outside, join(root, 'linked outside'));
    mkdirSync(join(root, 'nested', '.pappra'), { recursive: true });
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({ excludes: ['excluded-project'] }),
    );

    const result = await discoverWorkspace(root);
    const relativeRoots = result.repositories
      .map((entry) => entry.relativePath)
      .filter((entry): entry is string => entry !== null)
      .sort();
    assert.deepEqual(relativeRoots, ['apps/api', 'libs/shared']);
    assert.equal(
      result.repositories.some((entry) => entry.root.includes('node_modules')),
      false,
    );
    assert.equal(
      result.repositories.some((entry) =>
        entry.root.includes('excluded-project'),
      ),
      false,
    );
    assert.equal(
      result.repositories.some((entry) => entry.root.includes('deep')),
      false,
    );
    assert.deepEqual(result.boundaries, [realpath(join(root, 'nested'))]);
    const found = codes(result);
    assert(found.includes('discovery_nested_workspace'));
    assert(found.includes('discovery_symlink_skipped'));
    assert(
      result.diagnostics.some(
        (entry) =>
          entry.code === 'discovery_symlink_skipped' &&
          entry.severity === 'warning',
      ),
    );

    const deeper = await discoverWorkspace(root, { scanDepth: 3 });
    assert(
      deeper.repositories.some(
        (entry) => entry.relativePath === 'deep/level/repo',
      ),
    );
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('recognizes a linked worktree from its .git pointer file', async () => {
  const root = makeTempDir('discovery-worktree');
  try {
    const main = join(root, 'main repo');
    const worktree = join(root, 'worktree 工作树');
    createRepository(main);
    addLinkedWorktree(main, worktree, 'feature');
    try {
      assert.equal(lstatSync(join(worktree, '.git')).isFile(), true);
      const before = snapshotTree(root);
      const result = await discoverWorkspace(root);
      const mainRepository = result.repositories.find(
        (entry) => entry.root === realpath(main),
      );
      const linked = result.repositories.find(
        (entry) => entry.root === realpath(worktree),
      );
      assert(mainRepository !== undefined);
      assert(linked !== undefined);
      assert.equal(mainRepository.kind, 'regular');
      assert.equal(linked.kind, 'linked-worktree');
      assert.equal(linked.git.branch, 'feature');
      assert.equal(linked.git.commonDir, realpath(join(main, '.git')));
      assert.deepEqual(snapshotTree(root), before);
    } finally {
      removeLinkedWorktree(main, worktree);
    }
  } finally {
    cleanup(root);
  }
});

test('rejects a configured repository inside a nested workspace', async () => {
  const root = makeTempDir('discovery-nested-config');
  try {
    const inner = join(root, 'inner');
    createRepository(inner);
    writeWorkspaceConfig(inner, baseWorkspaceConfig({ name: 'inner' }));
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [{ id: 'inner', path: 'inner', access: 'read' }],
      }),
    );

    const result = await discoverWorkspace(root);
    assert.deepEqual(result.repositories, []);
    assert.equal(result.unresolvedRepositories.length, 1);
    assert(
      codes(result).includes('repository_nested_workspace'),
      codes(result).join(', '),
    );
    assert.deepEqual(result.boundaries, [realpath(inner)]);
  } finally {
    cleanup(root);
  }
});

test('reports a configured regular file as not a repository', async () => {
  const root = makeTempDir('discovery-file-repo');
  try {
    writeText(join(root, 'README.md'), '# not a checkout\n');
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [{ id: 'file', path: 'README.md', access: 'read' }],
      }),
    );
    const result = await discoverWorkspace(root);
    assert.deepEqual(result.repositories, []);
    assert.equal(result.unresolvedRepositories.length, 1);
    assert(codes(result).includes('repository_not_git'));
  } finally {
    cleanup(root);
  }
});

test(
  'disables a configured fsmonitor program during Git observation',
  { skip: process.platform === 'win32' },
  async () => {
    const root = makeTempDir('discovery-fsmonitor');
    try {
      const repository = join(root, 'repo');
      createRepository(repository);
      const marker = join(root, 'fsmonitor-ran');
      const hook = join(root, 'fsmonitor-hook.sh');
      writeFileSync(hook, `#!/bin/sh\nprintf ran > '${marker}'\nexit 0\n`);
      chmodSync(hook, 0o755);
      runGit(repository, ['config', 'core.fsmonitor', hook]);

      // Prove this fixture really executes the configured program.
      runGit(repository, ['status', '--porcelain']);
      assert.equal(existsSync(marker), true);
      rmSync(marker);

      const result = await discoverWorkspace(root);
      assert.equal(existsSync(marker), false);
      assert(
        result.repositories.some(
          (entry) => entry.root === realpath(repository),
        ),
      );
    } finally {
      cleanup(root);
    }
  },
);
