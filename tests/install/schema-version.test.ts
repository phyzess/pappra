import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  createManifest,
  journalPath,
  readInstallJournal,
  readJsonDocument,
  readWorkspaceManifest,
  releaseInstallLock,
  workspaceInstallPaths,
} from '../../src/install/ownership.js';
import { repairInstall } from '../../src/install/repair.js';
import { rollbackWorkspaceInstall } from '../../src/install/rollback.js';
import {
  installLockSchema,
  LOCK_SCHEMA,
  RUNTIME_MANIFEST_SCHEMA,
  runtimeManifestSchema,
} from '../../src/schemas/install.js';
import { cleanup, makeTempDir } from './fixtures.js';

test('install state distinguishes another version of its schema family from invalid input', async () => {
  const root = realpathSync(makeTempDir('install-schema-version'));
  try {
    const paths = workspaceInstallPaths(root);
    const journal = journalPath(root, randomUUID());
    const runtime = join(root, 'runtime.json');
    const cases = [
      [
        'pappra/install-manifest/1',
        paths.manifestPath,
        () => readWorkspaceManifest(root),
      ],
      ['pappra/install-journal/1', journal, () => readInstallJournal(journal)],
      [
        LOCK_SCHEMA,
        paths.lockPath,
        () => readJsonDocument(paths.lockPath, installLockSchema, LOCK_SCHEMA),
      ],
      [
        RUNTIME_MANIFEST_SCHEMA,
        runtime,
        () =>
          readJsonDocument(
            runtime,
            runtimeManifestSchema,
            RUNTIME_MANIFEST_SCHEMA,
          ),
      ],
    ] as const;
    for (const [expected, file, read] of cases) {
      const family = expected.slice(0, expected.lastIndexOf('/') + 1);
      const future = `${family}99`;
      mkdirSync(dirname(file), { recursive: true });
      for (const schema of [
        future,
        expected,
        `${family}oops`,
        `${family}99\n`,
        'pappra/another-state/99',
        99,
        undefined,
      ]) {
        const bytes = JSON.stringify({ schema, unknown: true });
        writeFileSync(file, bytes);
        const result = await read();
        const versionMismatch = schema === future;
        assert.equal(result.value, null);
        assert.equal(result.exists, true);
        assert(result.digest);
        assert.equal(
          result.diagnostics[0]?.code,
          versionMismatch
            ? 'config_unsupported_schema'
            : 'config_schema_invalid',
        );
        if (versionMismatch) {
          assert.equal(result.diagnostics[0]?.pointer, '/schema');
          assert(result.diagnostics[0]?.message.includes(future));
          assert(result.diagnostics[0]?.message.includes(expected));
        }
        assert.equal(readFileSync(file, 'utf8'), bytes);
      }
    }
    const { dev, ino } = statSync(root);
    const valid = createManifest(root, { dev, ino });
    writeFileSync(paths.manifestPath, JSON.stringify(valid));
    assert.deepEqual((await readWorkspaceManifest(root)).value, valid);
    const withUnknownField = JSON.stringify({ ...valid, futureOptional: true });
    writeFileSync(paths.manifestPath, withUnknownField);
    const invalid = await readWorkspaceManifest(root);
    assert.equal(invalid.value, null);
    assert.equal(invalid.diagnostics[0]?.code, 'config_schema_invalid');
    assert.equal(readFileSync(paths.manifestPath, 'utf8'), withUnknownField);
  } finally {
    cleanup(root);
  }
});

test('repair and rollback preserve unsupported install state and report its version', async () => {
  const root = realpathSync(makeTempDir('install-schema-recovery'));
  try {
    const installId = randomUUID();
    const file = journalPath(root, installId);
    const paths = workspaceInstallPaths(root);
    mkdirSync(dirname(file), { recursive: true });
    const journal = JSON.stringify({ schema: 'pappra/install-journal/2' });
    const manifest = JSON.stringify({ schema: 'pappra/install-manifest/2' });
    const lock = JSON.stringify({
      schema: 'pappra/install-lock/2',
      token: installId,
    });
    writeFileSync(file, journal);
    writeFileSync(paths.manifestPath, manifest);
    writeFileSync(paths.lockPath, lock);

    const repair = await repairInstall({ root, installId, apply: true });
    assert.equal(repair.ok, false);
    assert.match(
      repair.errors.join('\n'),
      /Unsupported schema "pappra\/install-journal\/2"/,
    );
    assert.deepEqual(repair.repaired, []);
    const rollback = await rollbackWorkspaceInstall({ root, installId });
    assert.equal(rollback.status, 'unmanaged');
    assert.equal(rollback.diagnostics[0]?.code, 'config_unsupported_schema');
    assert.deepEqual(rollback.removedPaths, []);
    assert.equal(
      (await releaseInstallLock(paths.lockPath, installId)).ok,
      false,
    );

    assert.equal(readFileSync(file, 'utf8'), journal);
    assert.equal(readFileSync(paths.manifestPath, 'utf8'), manifest);
    assert.equal(readFileSync(paths.lockPath, 'utf8'), lock);
  } finally {
    cleanup(root);
  }
});

test('repair does not reclaim a future-version lock even when its PID has exited', async () => {
  const root = realpathSync(makeTempDir('install-schema-dead-lock'));
  try {
    const { lockPath } = workspaceInstallPaths(root);
    mkdirSync(dirname(lockPath), { recursive: true });
    const child = spawnSync(process.execPath, ['-e', '']);
    assert.equal(child.status, 0);
    const bytes = JSON.stringify({
      schema: 'pappra/install-lock/2',
      operation: 'apply-workspace-files',
      token: randomUUID(),
      target: root,
      pid: child.pid,
      createdAt: new Date().toISOString(),
    });
    writeFileSync(lockPath, bytes);
    const result = await repairInstall({ root, apply: true });
    assert.equal(result.ok, false);
    assert.match(
      result.errors.join(' '),
      /Unsupported schema "pappra\/install-lock\/2"/,
    );
    assert.deepEqual(result.repaired, []);
    assert.equal(readFileSync(lockPath, 'utf8'), bytes);
  } finally {
    cleanup(root);
  }
});
