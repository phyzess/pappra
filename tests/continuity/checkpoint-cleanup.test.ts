import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CheckpointService } from '../../src/continuity/service.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  makeTempDir,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

function workspace() {
  const root = realpathSync(makeTempDir('checkpoint-cleanup'));
  writeWorkspaceConfig(root, baseWorkspaceConfig());
  writeMachineConfig(root, baseMachineConfig(root));
  return { root, taskDir: join(root, '.pappra/local/tasks/failed') };
}

test('failed first checkpoints reclaim only their exclusively created empty task directories', async () => {
  for (const input of [
    { taskId: 'failed' },
    { taskId: 'failed', objective: '', acceptance: [] },
  ]) {
    const { root, taskDir } = workspace();
    try {
      const result = await new CheckpointService(root).save(input);
      assert.equal(result.ok, false);
      assert.deepEqual(result.residualPaths, []);
      assert.equal(existsSync(taskDir), false);
      // Retry sees a genuinely new task and can persist normal state.
      const retry = await new CheckpointService(root).save({
        taskId: 'failed',
        objective: 'Retry',
        acceptance: ['Save'],
      });
      assert.equal(retry.ok, true, JSON.stringify(retry.diagnostics));
    } finally {
      cleanup(root);
    }
  }
});

test('lock publication failures also reclaim the newly created empty directory', async () => {
  const { root, taskDir } = workspace();
  try {
    const result = await new CheckpointService(root, {
      beforeTaskLockPublish: () => {
        throw new Error('isolated lock failure');
      },
    }).save({ taskId: 'failed' });
    assert.equal(result.ok, false);
    assert.match(result.diagnostics[0]!.message, /isolated lock failure/);
    assert.equal(existsSync(taskDir), false);
    assert.deepEqual(result.residualPaths, []);
  } finally {
    cleanup(root);
  }
});

test('a directory created by another caller at the exclusive creation boundary is never adopted', async () => {
  const { root, taskDir } = workspace();
  try {
    const result = await new CheckpointService(root, {
      beforeTaskDirectoryCreate: () => mkdirSync(taskDir),
    }).save({ taskId: 'failed' });
    assert.equal(result.ok, false);
    assert.deepEqual(readdirSync(taskDir), []);
    assert.deepEqual(result.residualPaths, [taskDir]);
  } finally {
    cleanup(root);
  }
});

test('replacement queued at creation cannot be adopted at the first asynchronous boundary', async () => {
  const { root, taskDir } = workspace();
  try {
    const result = await new CheckpointService(root, {
      beforeTaskDirectoryCreate: () =>
        queueMicrotask(() => {
          renameSync(taskDir, `${taskDir}-original`);
          mkdirSync(taskDir);
        }),
    }).save({ taskId: 'failed' });
    assert.equal(result.ok, false);
    assert.deepEqual(readdirSync(taskDir), []);
    assert.deepEqual(readdirSync(`${taskDir}-original`), []);
    assert.deepEqual(result.residualPaths, [taskDir]);
    assert(result.diagnostics.some((d) => /namespace changed/.test(d.message)));
  } finally {
    cleanup(root);
  }
});

test('a second checkpoint saved after lock release survives failed cleanup', async () => {
  const { root, taskDir } = workspace();
  try {
    const result = await new CheckpointService(root, {
      beforeFailedTaskCleanup: async () => {
        const concurrent = await new CheckpointService(root).save({
          taskId: 'failed',
          objective: 'Concurrent save',
          acceptance: ['Keep checkpoint'],
        });
        assert.equal(
          concurrent.ok,
          true,
          JSON.stringify(concurrent.diagnostics),
        );
      },
    }).save({ taskId: 'failed' });
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(taskDir, 'latest.json')), true);
    assert.deepEqual(result.residualPaths, [taskDir]);
    const resume = await new CheckpointService(root).resume({
      taskId: 'failed',
    });
    assert.equal(resume.packet?.boundedContext.objective, 'Concurrent save');
  } finally {
    cleanup(root);
  }
});

test('pre-existing empty task directories are preserved and reported', async () => {
  const { root, taskDir } = workspace();
  try {
    mkdirSync(taskDir, { recursive: true });
    const before = lstatSync(taskDir);
    const result = await new CheckpointService(root).save({ taskId: 'failed' });
    assert.equal(result.ok, false);
    assert.equal(lstatSync(taskDir).ino, before.ino);
    assert.deepEqual(readdirSync(taskDir), []);
    assert.deepEqual(result.residualPaths, [taskDir]);
  } finally {
    cleanup(root);
  }
});

test('durable context left by a later failure is retained and reported', async () => {
  const { root, taskDir } = workspace();
  try {
    const result = await new CheckpointService(root).save({
      taskId: 'failed',
      objective: 'Keep context',
      acceptance: ['Save'],
      decisions: ['x'.repeat(100_000)],
    });
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(taskDir, 'task-context.json')), true);
    assert.equal(existsSync(join(taskDir, 'checkpoint.lock')), false);
    assert.equal(existsSync(join(taskDir, 'latest.json')), false);
    assert.deepEqual(result.residualPaths, [taskDir]);
  } finally {
    cleanup(root);
  }
});

test('concurrent writes and a competing lock survive failed cleanup', async () => {
  for (const file of ['concurrent.txt', 'checkpoint.lock']) {
    const { root, taskDir } = workspace();
    try {
      const result = await new CheckpointService(root, {
        beforeFailedTaskCleanup: () =>
          writeFileSync(join(taskDir, file), 'foreign bytes'),
      }).save({ taskId: 'failed' });
      assert.equal(result.ok, false);
      assert.equal(readFileSync(join(taskDir, file), 'utf8'), 'foreign bytes');
      assert.deepEqual(result.residualPaths, [taskDir]);
    } finally {
      cleanup(root);
    }
  }
});

test('concurrent task acquisition cannot have its lock or directory removed', async () => {
  const { root, taskDir } = workspace();
  try {
    const result = await new CheckpointService(root, {
      beforeTaskLockPublish: () =>
        writeFileSync(
          join(taskDir, 'checkpoint.lock'),
          '{"token":"foreign"}\n',
        ),
    }).save({ taskId: 'failed' });
    assert.equal(result.ok, false);
    assert.equal(
      readFileSync(join(taskDir, 'checkpoint.lock'), 'utf8'),
      '{"token":"foreign"}\n',
    );
    assert.deepEqual(result.residualPaths, [taskDir]);
  } finally {
    cleanup(root);
  }
});

for (const replacement of ['directory', 'symlink', 'file', 'parent'] as const) {
  test(`failed cleanup preserves a ${replacement} replacement`, async () => {
    const { root, taskDir } = workspace();
    try {
      let replacedPath = taskDir;
      const result = await new CheckpointService(root, {
        beforeFailedTaskCleanup: () => {
          if (replacement === 'parent') {
            const parent = join(root, '.pappra/local/tasks');
            renameSync(parent, `${parent}-original`);
            mkdirSync(taskDir, { recursive: true });
            replacedPath = join(`${parent}-original`, 'failed');
          } else {
            renameSync(taskDir, `${taskDir}-original`);
            replacedPath = `${taskDir}-original`;
            if (replacement === 'directory') mkdirSync(taskDir);
            if (replacement === 'file') writeFileSync(taskDir, 'replacement');
            if (replacement === 'symlink')
              symlinkSync(replacedPath, taskDir, 'dir');
          }
        },
      }).save({ taskId: 'failed' });
      assert.equal(result.ok, false);
      assert.equal(existsSync(taskDir), true);
      assert.equal(existsSync(replacedPath), true);
      assert.deepEqual(readdirSync(replacedPath), []);
      assert.deepEqual(result.residualPaths, [taskDir]);
      assert(result.diagnostics.some((d) => /cleanup refused/.test(d.message)));
    } finally {
      cleanup(root);
    }
  });
}

test('an uninspectable namespace is retained and conservatively reported', async () => {
  const { root, taskDir } = workspace();
  try {
    const result = await new CheckpointService(root, {
      beforeFailedTaskCleanup: () => {
        const parent = join(root, '.pappra/local/tasks');
        renameSync(parent, `${parent}-original`);
        // ELOOP, not ENOENT: absence cannot be proven.
        symlinkSync('tasks', parent, 'dir');
      },
    }).save({ taskId: 'failed' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.residualPaths, [taskDir]);
    assert.deepEqual(
      readdirSync(join(root, '.pappra/local/tasks-original/failed')),
      [],
    );
  } finally {
    cleanup(root);
  }
});

test('absence after concurrent removal does not invent residual paths', async () => {
  const { root, taskDir } = workspace();
  try {
    const result = await new CheckpointService(root, {
      beforeFailedTaskCleanup: () => rmdirSync(taskDir),
    }).save({ taskId: 'failed' });
    assert.equal(result.ok, false);
    assert.equal(existsSync(taskDir), false);
    assert.deepEqual(result.residualPaths, []);
  } finally {
    cleanup(root);
  }
});
