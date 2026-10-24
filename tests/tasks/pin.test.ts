import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  pinTask,
  readAutoResume,
  readTaskPin,
  setAutoResume,
  unpinTask,
} from '../../src/app/task-pin.js';
import { continuityTaskPaths } from '../../src/continuity/paths.js';
import {
  baseWorkspaceConfig,
  cleanup,
  makeTempDir,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

const config = () =>
  baseWorkspaceConfig({
    name: 'reliability-workspace',
    extensions: { 'pappra.test': { keep: true } },
  });

function workspaceWithOutside(label: string) {
  const root = makeTempDir(label);
  const outside = join(root, 'outside');
  fs.mkdirSync(outside);
  writeWorkspaceConfig(root, config());
  return { root, outside, local: join(root, '.pappra', 'local') };
}

function hasMessage(value: unknown): value is { message: string } {
  return typeof value === 'object' && value !== null && 'message' in value;
}

async function withPatched<T>(
  patch: () => () => void,
  action: () => Promise<T>,
): Promise<T> {
  const restore = patch();
  syncBuiltinESMExports();
  try {
    return await action();
  } finally {
    restore();
    syncBuiltinESMExports();
  }
}

test('task pin is explicit and auto-resume is a private checkout preference', async () => {
  const root = makeTempDir('task-pin');
  try {
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    assert.equal((await readTaskPin(root)) !== null, false);
    const pinned = await pinTask(root, 'FIJI-123456');
    assert.equal('message' in pinned, false);
    assert.equal((await readTaskPin(root))?.taskId, 'FIJI-123456');
    assert.equal(await readAutoResume(root), false);

    const switched = await setAutoResume(root, true);
    assert.equal('message' in switched, false);
    assert.equal(await readAutoResume(root), true);

    await unpinTask(root);
    assert.equal((await readTaskPin(root)) !== null, false);
    assert.equal(await readAutoResume(root), true);

    const invalid = await pinTask(root, 'not a task id');
    assert.equal('message' in invalid, true);
  } finally {
    cleanup(root);
  }
});

test('pin and continuity share the 64-character single-segment task id rule', async () => {
  const root = makeTempDir('task-id-rule');
  try {
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    const accepted = 'a'.repeat(64);
    assert.equal('message' in (await pinTask(root, accepted)), false);
    assert.equal((await readTaskPin(root))?.taskId, accepted);
    assert.equal(
      continuityTaskPaths(root, accepted).taskDir.endsWith(accepted),
      true,
    );

    const before = fs.readFileSync(
      join(root, '.pappra', 'local', 'current-task'),
    );
    const tooLong = 'a'.repeat(65);
    const refused = await pinTask(root, tooLong);
    if (!hasMessage(refused)) assert.fail('65-character id must be refused.');
    assert.match(refused.message, /64 characters/);
    assert.deepEqual(
      fs.readFileSync(join(root, '.pappra', 'local', 'current-task')),
      before,
    );
    assert.throws(() => continuityTaskPaths(root, tooLong), RangeError);

    for (const invalid of [
      '',
      '../escape',
      '/absolute',
      'nested/id',
      'bad id',
      '-leading',
      '.dot-leading',
      `a${'b'.repeat(64)}`,
    ]) {
      const rejected = await pinTask(root, invalid);
      assert.ok(hasMessage(rejected), invalid);
      assert.throws(
        () => continuityTaskPaths(root, invalid),
        RangeError,
        invalid,
      );
    }
    assert.equal((await readTaskPin(root))?.taskId, accepted);
  } finally {
    cleanup(root);
  }
});

test('static redirected private state refuses without outside effects', async () => {
  const { root, outside, local } = workspaceWithOutside('task-pin-static');
  try {
    fs.symlinkSync(outside, local, 'dir');
    const pinned = await pinTask(root, 'T-STATIC');
    assert.ok(hasMessage(pinned));
    assert.match(pinned.message, /symlink|redirected|outside/i);
    assert.equal(await readTaskPin(root), null);
    assert.equal(await readAutoResume(root), false);
    assert.ok(hasMessage(await unpinTask(root)));
    assert.ok(hasMessage(await setAutoResume(root, true)));
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(
      JSON.parse(
        fs.readFileSync(join(root, '.pappra', 'workspace.json'), 'utf8'),
      ).continuity,
      undefined,
    );
  } finally {
    cleanup(root);
  }
});

test('redirected .pappra and pin/config entries preserve outside bytes', async () => {
  const root = makeTempDir('task-pin-entries');
  try {
    writeWorkspaceConfig(root, config());
    const pappra = join(root, '.pappra');
    const realPappra = join(root, 'real-pappra');
    const outsidePappra = join(root, 'outside-pappra');
    fs.mkdirSync(outsidePappra);
    fs.writeFileSync(
      join(outsidePappra, 'workspace.json'),
      '{"outside":true}\n',
    );
    fs.renameSync(pappra, realPappra);
    fs.symlinkSync(outsidePappra, pappra, 'dir');
    assert.ok(hasMessage(await pinTask(root, 'T-PAPPRA')));
    assert.ok(hasMessage(await setAutoResume(root, true)));
    assert.equal(
      fs.readFileSync(join(outsidePappra, 'workspace.json'), 'utf8'),
      '{"outside":true}\n',
    );
    assert.deepEqual(fs.readdirSync(outsidePappra).sort(), ['workspace.json']);

    fs.rmSync(pappra);
    fs.renameSync(realPappra, pappra);
    const outsideConfig = join(root, 'outside-config.json');
    fs.writeFileSync(outsideConfig, '{"outside":true}\n');
    fs.rmSync(join(pappra, 'workspace.json'));
    fs.symlinkSync(outsideConfig, join(pappra, 'workspace.json'));
    assert.ok(hasMessage(await setAutoResume(root, true)));
    assert.equal(fs.readFileSync(outsideConfig, 'utf8'), '{"outside":true}\n');

    fs.rmSync(join(pappra, 'workspace.json'));
    writeWorkspaceConfig(root, config());
    const local = join(pappra, 'local');
    fs.mkdirSync(local, { recursive: true });
    const outsidePin = join(root, 'outside-pin');
    fs.writeFileSync(
      outsidePin,
      '{"schema":"pappra/task-pin/1","taskId":"OUTSIDE","pinnedAt":"2026-01-01T00:00:00.000Z"}\n',
    );
    fs.symlinkSync(outsidePin, join(local, 'current-task'));
    assert.equal(await readTaskPin(root), null);
    assert.ok(hasMessage(await pinTask(root, 'T-SYMLINK')));
    assert.ok(hasMessage(await unpinTask(root)));
    assert.equal(fs.existsSync(outsidePin), true);
  } finally {
    cleanup(root);
  }
});

test(
  'special-file task state and configuration refuse without blocking',
  { timeout: 10_000 },
  async () => {
    const root = makeTempDir('task-pin-special');
    try {
      writeWorkspaceConfig(root, config());
      const local = join(root, '.pappra', 'local');
      fs.mkdirSync(local, { recursive: true });
      const fifo = join(local, 'current-task');
      const mkfifo = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
      if (mkfifo.status !== 0) return;
      assert.equal(await readTaskPin(root), null);
      assert.ok(hasMessage(await pinTask(root, 'T-FIFO')));
      assert.ok(hasMessage(await unpinTask(root)));
      assert.equal(fs.lstatSync(fifo).isFIFO(), true);

      fs.rmSync(fifo);
      const configPath = join(root, '.pappra', 'workspace.json');
      const configFifo = join(root, '.pappra', 'config-fifo');
      const created = spawnSync('mkfifo', [configFifo], { encoding: 'utf8' });
      if (created.status === 0) {
        fs.rmSync(configPath);
        fs.symlinkSync(configFifo, configPath);
        const started = Date.now();
        assert.equal(await readAutoResume(root), false);
        assert.ok(hasMessage(await setAutoResume(root, true)));
        assert.ok(Date.now() - started < 5_000);
      }
    } finally {
      cleanup(root);
    }
  },
);

test('pin write aborts before publication when the local directory is redirected at an awaited seam', async () => {
  const { root, outside, local } = workspaceWithOutside('task-pin-write-seam');
  const realLocal = join(root, '.pappra', 'local-real');
  try {
    const original = fsPromises.writeFile;
    let intercepted = false;
    const result = await withPatched(
      () => {
        (fsPromises as unknown as Record<string, unknown>)['writeFile'] =
          async (...args: Parameters<typeof fsPromises.writeFile>) => {
            const written = await original(...args);
            if (!intercepted && String(args[0]).includes('.tmp-')) {
              intercepted = true;
              fs.renameSync(local, realLocal);
              fs.symlinkSync(outside, local, 'dir');
            }
            return written;
          };
        return () => {
          (fsPromises as unknown as Record<string, unknown>)['writeFile'] =
            original;
        };
      },
      () => pinTask(root, 'T-SEAM'),
    );
    assert.equal(intercepted, true);
    assert.ok(hasMessage(result));
    assert.match(
      result.message,
      /namespace|changed|redirected|real directory/i,
    );
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.existsSync(join(local, 'current-task')), false);
  } finally {
    cleanup(root);
  }
});

test('pin removal revalidates before deletion and preserves outside files', async () => {
  const { root, outside, local } = workspaceWithOutside('task-pin-unpin-seam');
  try {
    assert.equal('message' in (await pinTask(root, 'T-UNPIN')), false);
    const localReal = join(root, '.pappra', 'local-real');
    fs.writeFileSync(
      join(outside, 'current-task'),
      '{"schema":"pappra/task-pin/1","taskId":"OUTSIDE","pinnedAt":"2026-01-01T00:00:00.000Z"}\n',
    );
    const original = fsPromises.lstat;
    let observations = 0;
    let intercepted = false;
    const result = await withPatched(
      () => {
        (fsPromises as unknown as Record<string, unknown>)['lstat'] = async (
          ...args: Parameters<typeof fsPromises.lstat>
        ) => {
          const stats = await original(...args);
          if (
            String(args[0]).endsWith('/.pappra/local/current-task') &&
            !intercepted
          ) {
            observations += 1;
            if (observations === 2) {
              intercepted = true;
              fs.renameSync(local, localReal);
              fs.symlinkSync(outside, local, 'dir');
            }
          }
          return stats;
        };
        return () => {
          (fsPromises as unknown as Record<string, unknown>)['lstat'] =
            original;
        };
      },
      () => unpinTask(root),
    );
    assert.equal(intercepted, true);
    assert.ok(hasMessage(result));
    assert.equal(fs.existsSync(join(outside, 'current-task')), true);
    assert.equal(fs.existsSync(join(localReal, 'current-task')), true);
  } finally {
    cleanup(root);
  }
});

test('auto-resume is private, shared configuration is byte-identical, and cloned workspaces inherit no preference', async () => {
  const root = makeTempDir('task-pin-private-preference');
  const clone = makeTempDir('task-pin-clone');
  try {
    writeWorkspaceConfig(root, {
      ...config(),
      continuity: { autoResume: true },
    });
    const configPath = join(root, '.pappra/workspace.json');
    const before = fs.readFileSync(configPath);
    assert.equal(
      await readAutoResume(root),
      false,
      'shared legacy preference is never inferred',
    );
    assert.equal('message' in (await setAutoResume(root, true)), false);
    assert.equal(await readAutoResume(root), true);
    assert.deepEqual(fs.readFileSync(configPath), before);
    const preferencePath = join(root, '.pappra/local/task-preferences.json');
    const preference = JSON.parse(
      fs.readFileSync(preferencePath, 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(preference.schema, 'pappra/task-preferences/1');
    assert.equal(preference.autoResume, true);
    assert.equal(preference.workspaceId, config().workspaceId);
    assert.equal(
      fs.readFileSync(join(root, '.pappra/local/.gitignore'), 'utf8'),
      '*\n',
    );
    assert.equal(fs.existsSync(join(root, '.pappra/local/backups')), false);
    assert.equal(fs.existsSync(join(root, '.pappra/local/apply.lock')), false);
    if (process.platform !== 'win32')
      assert.equal(fs.statSync(preferencePath).mode & 0o777, 0o600);
    fs.mkdirSync(join(clone, '.pappra'), { recursive: true });
    fs.writeFileSync(join(clone, '.pappra/workspace.json'), before);
    assert.equal(await readAutoResume(clone), false);
    await pinTask(root, 'T-PRIVATE');
    await unpinTask(root);
    assert.equal(await readAutoResume(root), true);
    assert.equal('message' in (await setAutoResume(root, false)), false);
    assert.equal(await readAutoResume(root), false);
    assert.deepEqual(fs.readFileSync(configPath), before);
  } finally {
    cleanup(root);
    cleanup(clone);
  }
});

test('private preference edit before publication is preserved and the lock is released', async () => {
  const root = makeTempDir('task-pin-preference-cas');
  try {
    writeWorkspaceConfig(root, config());
    const path = join(root, '.pappra/local/task-preferences.json');
    const edited = JSON.stringify({
      schema: 'pappra/task-preferences/1',
      workspaceId: config().workspaceId,
      autoResume: false,
    });
    const original = fsPromises.writeFile;
    let intercepted = false;
    const result = await withPatched(
      () => {
        (fsPromises as unknown as Record<string, unknown>)['writeFile'] =
          async (...args: Parameters<typeof fsPromises.writeFile>) => {
            const written = await original(...args);
            if (
              !intercepted &&
              String(args[0]).includes('/task-preferences.json.tmp-')
            ) {
              intercepted = true;
              fs.writeFileSync(path, edited);
            }
            return written;
          };
        return () => {
          (fsPromises as unknown as Record<string, unknown>)['writeFile'] =
            original;
        };
      },
      () => setAutoResume(root, true),
    );
    assert.equal(intercepted, true);
    assert(hasMessage(result));
    assert.match(result.message, /preferences changed before publication/i);
    assert.equal(fs.readFileSync(path, 'utf8'), edited);
    assert.equal(fs.existsSync(join(root, '.pappra/local/apply.lock')), false);
    assert.equal(
      fs
        .readdirSync(join(root, '.pappra/local'))
        .some((name) => name.startsWith('task-preferences.json.tmp-')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('unrelated concurrent shared configuration edits survive preference publication', async () => {
  const root = makeTempDir('task-pin-shared-edit');
  try {
    writeWorkspaceConfig(root, config());
    const configPath = join(root, '.pappra/workspace.json');
    const original = fsPromises.writeFile;
    let intercepted = false;
    let editedBytes = '';
    const result = await withPatched(
      () => {
        (fsPromises as unknown as Record<string, unknown>)['writeFile'] =
          async (...args: Parameters<typeof fsPromises.writeFile>) => {
            const written = await original(...args);
            if (
              !intercepted &&
              String(args[0]).includes('/task-preferences.json.tmp-')
            ) {
              intercepted = true;
              editedBytes = JSON.stringify({
                ...config(),
                name: 'user-config-edit',
              });
              fs.writeFileSync(configPath, editedBytes);
            }
            return written;
          };
        return () => {
          (fsPromises as unknown as Record<string, unknown>)['writeFile'] =
            original;
        };
      },
      () => setAutoResume(root, true),
    );
    assert.equal(intercepted, true);
    assert.equal('message' in result, false, JSON.stringify(result));
    assert.equal(fs.readFileSync(configPath, 'utf8'), editedBytes);
    assert.equal(await readAutoResume(root), true);
  } finally {
    cleanup(root);
  }
});

test('redirected or foreign private preferences are disabled and preserved', async () => {
  const { root, outside, local } = workspaceWithOutside(
    'task-pin-private-unsafe',
  );
  try {
    fs.mkdirSync(local, { recursive: true });
    const target = join(outside, 'preferences.json');
    const value = JSON.stringify({
      schema: 'pappra/task-preferences/1',
      workspaceId: config().workspaceId,
      autoResume: true,
    });
    fs.writeFileSync(target, value);
    const path = join(local, 'task-preferences.json');
    fs.symlinkSync(target, path);
    assert.equal(await readAutoResume(root), false);
    assert(hasMessage(await setAutoResume(root, true)));
    assert.equal(fs.readFileSync(target, 'utf8'), value);
    fs.rmSync(path);
    fs.writeFileSync(
      path,
      JSON.stringify({
        schema: 'pappra/task-preferences/1',
        workspaceId: 'af90ab7c-9e86-4ad0-9548-c4c2ccb7375e',
        autoResume: true,
      }),
    );
    const foreign = fs.readFileSync(path);
    assert.equal(await readAutoResume(root), false);
    assert(hasMessage(await setAutoResume(root, true)));
    assert.deepEqual(fs.readFileSync(path), foreign);
    fs.writeFileSync(path, '{malformed');
    assert.equal(await readAutoResume(root), false);
    assert(hasMessage(await setAutoResume(root, true)));
    assert.equal(fs.readFileSync(path, 'utf8'), '{malformed');
  } finally {
    cleanup(root);
  }
});

test('a foreign or malformed lock blocks the update without stealing it', async () => {
  const root = makeTempDir('task-pin-config-lock');
  try {
    writeWorkspaceConfig(root, config());
    const lockPath = join(root, '.pappra', 'local', 'apply.lock');
    fs.mkdirSync(join(root, '.pappra', 'local'), { recursive: true });
    const lock = {
      schema: 'pappra/install-lock/1',
      token: 'foreign-token',
      operation: 'set-auto-resume',
      target: '.pappra/workspace.json',
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    const before = fs.readFileSync(join(root, '.pappra', 'workspace.json'));
    const result = await setAutoResume(root, true);
    assert.ok(hasMessage(result));
    assert.match(result.message, /lock/i);
    assert.deepEqual(
      fs.readFileSync(join(root, '.pappra', 'workspace.json')),
      before,
    );
    assert.equal(
      fs.readFileSync(lockPath, 'utf8'),
      `${JSON.stringify(lock, null, 2)}\n`,
    );
  } finally {
    cleanup(root);
  }
});

test('unusable pin bytes are reported as absent and unpin remains deliberate', async () => {
  const root = makeTempDir('task-pin-bytes');
  try {
    writeWorkspaceConfig(root, config());
    const local = join(root, '.pappra', 'local');
    fs.mkdirSync(local, { recursive: true });
    const pin = join(local, 'current-task');
    fs.writeFileSync(pin, '{"schema":"pappra/task-pin/1","taskId":"bad id"}\n');
    assert.equal(await readTaskPin(root), null);
    assert.equal('message' in (await unpinTask(root)), false);
    assert.equal(fs.existsSync(pin), false);
  } finally {
    cleanup(root);
  }
});

test('unpin is idempotent when no pin exists and leaves local state alone', async () => {
  const root = makeTempDir('task-pin-missing');
  try {
    writeWorkspaceConfig(root, config());
    const local = join(root, '.pappra', 'local');
    fs.mkdirSync(local, { recursive: true });
    const unrelated = join(local, 'unrelated.txt');
    fs.writeFileSync(unrelated, 'keep\n');
    assert.equal('message' in (await unpinTask(root)), false);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep\n');
    assert.equal(fs.existsSync(join(local, 'current-task')), false);
  } finally {
    cleanup(root);
  }
});
