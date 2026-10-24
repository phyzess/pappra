import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { repairInstall } from '../../src/install/repair.js';
import { runCli } from '../../src/cli/run.js';
import { applyInitPlan, planWorkspaceInit } from '../../src/app/init.js';
import {
  beginManagedApply,
  recordManagedFile,
} from '../../src/install/apply.js';
import { installRuntime, runtimePaths } from '../../src/install/runtime.js';
import {
  journalPath,
  backupPath,
  readInstallJournal,
  readWorkspaceManifest,
  releaseInstallLock,
  workspaceInstallPaths,
  writeInstallJournal,
} from '../../src/install/ownership.js';
import { observePath, sha256Digest } from '../../src/infra/fs.js';
import type { InstallJournal } from '../../src/schemas/install.js';
import { cleanup, createRuntimeTarball, makeTempDir } from './fixtures.js';
import { baseInitChoices } from '../init/fixtures.js';
import { createRepository } from '../workspace/fixtures.js';

function deadPid(): number {
  const child = spawnSync(process.execPath, [
    '-e',
    'process.stdout.write(String(process.pid))',
  ]);
  assert.equal(child.status, 0);
  return Number(child.stdout.toString());
}

async function interruptedRollback(
  root: string,
  seam: 'beforeRemoval' | 'afterRemoval',
) {
  createRepository(root);
  const planned = await planWorkspaceInit({
    root,
    choices: baseInitChoices(),
    runtimeVersion: '0.1.0-dev.0',
  });
  assert(planned.ok);
  assert.equal((await applyInitPlan(planned.bundle)).ok, true);
  const manifest = (await readWorkspaceManifest(root)).value;
  assert(manifest !== null);
  const installId = manifest.entries[0]!.installId;
  const sourceFile = journalPath(root, installId);
  const source = (await readInstallJournal(sourceFile)).value;
  assert(source !== null);
  assert.equal(
    (
      await writeInstallJournal(
        sourceFile,
        { ...source, status: 'applying' },
        root,
      )
    ).ok,
    true,
  );
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { rollbackWorkspaceInstall } from ${JSON.stringify(import.meta.resolve('../../src/install/rollback.js'))};
await rollbackWorkspaceInstall({ root: ${JSON.stringify(root)}, installId: ${JSON.stringify(installId)},
${seam}: () => process.exit(73) });`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 73, child.stderr);
  const files = readdirSync(workspaceInstallPaths(root).journalsDir).filter(
    (name) => name !== `${installId}.json`,
  );
  assert.equal(files.length, 1);
  const rollbackFile = join(workspaceInstallPaths(root).journalsDir, files[0]!);
  const rollback = (await readInstallJournal(rollbackFile)).value;
  assert(rollback !== null);
  assert.equal(rollback.operation, 'rollback-workspace-files');
  assert.equal(rollback.status, 'applying');
  assert.equal(rollback.target, installId);
  return { sourceFile, rollbackFile, rollback };
}

test('repair resumes a hard-interrupted rollback and closes both journals with verified ownership', async () => {
  for (const seam of ['beforeRemoval', 'afterRemoval'] as const) {
    const root = realpathSync(makeTempDir(`repair-nested-${seam}`));
    try {
      const interrupted = await interruptedRollback(root, seam);
      assert.equal(existsSync(workspaceInstallPaths(root).lockPath), true);
      const recovered = await repairInstall({
        root,
        ...(seam === 'beforeRemoval'
          ? { installId: interrupted.rollback.installId }
          : {}),
        apply: true,
      });
      assert.equal(recovered.ok, true, JSON.stringify(recovered));
      assert.equal(
        (await readInstallJournal(interrupted.sourceFile)).value?.status,
        'rolled-back',
      );
      assert.equal(
        (await readInstallJournal(interrupted.rollbackFile)).value?.status,
        'rolled-back',
      );
      assert.equal(existsSync(join(root, '.pappra/workspace.json')), false);
      assert.equal(existsSync(join(root, '.pappra/local/machine.json')), false);
      assert.deepEqual((await readWorkspaceManifest(root)).value?.entries, []);
      assert.equal((await repairInstall({ root })).entries.length, 0);
      assert.equal((await repairInstall({ root, apply: true })).ok, true);
    } finally {
      cleanup(root);
    }
  }
});

test('interrupted rollback recovery preserves modified files and keeps unresolved journals open', async () => {
  const root = realpathSync(makeTempDir('repair-nested-modified'));
  try {
    const interrupted = await interruptedRollback(root, 'beforeRemoval');
    const file = join(root, '.pappra/workspace.json');
    writeFileSync(file, 'user changes after interrupted rollback');
    const result = await repairInstall({
      root,
      installId: interrupted.rollback.installId,
      apply: true,
    });
    assert.equal(result.ok, false);
    assert.equal(
      readFileSync(file, 'utf8'),
      'user changes after interrupted rollback',
    );
    assert.notEqual(
      (await readInstallJournal(interrupted.sourceFile)).value?.status,
      'rolled-back',
    );
    assert.equal(
      (await readInstallJournal(interrupted.rollbackFile)).value?.status,
      'applying',
    );
  } finally {
    cleanup(root);
  }
});

test('repair closes an interrupted rollback only after validating its already restored source', async () => {
  const root = realpathSync(makeTempDir('repair-nested-restored'));
  try {
    const interrupted = await interruptedRollback(root, 'beforeRemoval');
    const source = await repairInstall({
      root,
      installId: interrupted.rollback.target,
      apply: true,
    });
    assert.equal(source.ok, true, JSON.stringify(source));
    assert.equal(
      (await readInstallJournal(interrupted.rollbackFile)).value?.status,
      'applying',
    );
    const recovered = await repairInstall({
      root,
      installId: interrupted.rollback.installId,
      apply: true,
    });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(
      (await readInstallJournal(interrupted.rollbackFile)).value?.status,
      'rolled-back',
    );
  } finally {
    cleanup(root);
  }
});

test('interrupted rollback rejects unsupported source journals without reclaiming the lock', async () => {
  const root = realpathSync(makeTempDir('repair-nested-invalid'));
  try {
    const interrupted = await interruptedRollback(root, 'beforeRemoval');
    const source = (await readInstallJournal(interrupted.sourceFile)).value;
    assert(source !== null);
    await writeInstallJournal(
      interrupted.sourceFile,
      { ...source, operation: 'uninstall-workspace-files' },
      root,
    );
    const result = await repairInstall({
      root,
      installId: interrupted.rollback.installId,
      apply: true,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /supported source/);
    assert.equal(existsSync(workspaceInstallPaths(root).lockPath), true);
    assert.equal(existsSync(join(root, '.pappra/workspace.json')), true);
    assert.equal(
      (await readInstallJournal(interrupted.rollbackFile)).value?.status,
      'applying',
    );
  } finally {
    cleanup(root);
  }
});

test('reconfiguration holds the shared lock through replacement and writes a recoverable journal', async () => {
  const root = realpathSync(makeTempDir('repair-reconfigure-lock'));
  try {
    createRepository(root);
    const first = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
      runtimeVersion: '0.1.0-dev.0',
    });
    assert(first.ok);
    assert.equal((await applyInitPlan(first.bundle)).ok, true);
    const next = await planWorkspaceInit({
      root,
      choices: baseInitChoices({ name: 'reconfigured' }),
      reconfigure: true,
      runtimeVersion: '0.1.0-dev.0',
    });
    assert(next.ok);
    let checked = false;
    const applied = await applyInitPlan(next.bundle, {
      beforeWrite: async () => {
        if (checked) return;
        checked = true;
        const competing = await applyInitPlan(next.bundle);
        assert.equal(competing.ok, false);
        assert.equal(competing.status, 'conflict');
      },
    });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(checked, true);
    const manifest = (await readWorkspaceManifest(root)).value;
    assert(manifest !== null);
    const entry = manifest.entries.find(
      (entry) => entry.path === '.pappra/workspace.json',
    );
    assert(entry !== undefined);
    assert.equal(entry.operation, 'replace-managed');
    assert(entry.backupRef !== null);
    assert.equal(
      (await readInstallJournal(journalPath(root, entry.installId))).value
        ?.status,
      'verified',
    );
    assert.equal(
      manifest.entries.filter(
        (entry) => entry.path === '.pappra/workspace.json',
      ).length,
      1,
    );
  } finally {
    cleanup(root);
  }
});

test('repair restores journaled replacements after interruption and retains managed ownership', async () => {
  const root = realpathSync(makeTempDir('repair-reconfigure-interrupted'));
  try {
    createRepository(root);
    const first = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
      runtimeVersion: '0.1.0-dev.0',
    });
    assert(first.ok);
    assert.equal((await applyInitPlan(first.bundle)).ok, true);
    const before = readFileSync(join(root, '.pappra/workspace.json'));
    const next = await planWorkspaceInit({
      root,
      choices: baseInitChoices({ name: 'interrupted-name' }),
      reconfigure: true,
      runtimeVersion: '0.1.0-dev.0',
    });
    assert(next.ok);
    const started = await beginManagedApply(
      root,
      next.bundle.plan,
      next.bundle.writes,
      next.bundle.rootIdentity,
    );
    assert(started.ok);
    const context = started.context;
    const entry = next.bundle.plan.files[0]!;
    assert.equal(entry.operation, 'replace-managed');
    const backup = backupPath(root, context.installId, entry.path);
    mkdirSync(join(backup, '..'), { recursive: true });
    writeFileSync(backup, before);
    const target = join(root, entry.path);
    const temporary = `${target}.simulated-interruption`;
    writeFileSync(temporary, next.bundle.writes[0]!.bytes);
    const observation = await observePath(temporary);
    assert(observation.stats !== null);
    assert.equal(
      (
        await recordManagedFile(
          context,
          entry.path,
          entry.nextDigest,
          { dev: observation.stats.dev, ino: observation.stats.ino },
          {
            backupRef: backup.slice(root.length + 1),
            backupDigest: sha256Digest(before),
          },
        )
      ).ok,
      true,
    );
    renameSync(temporary, target);
    assert.equal(
      (await releaseInstallLock(context.lockPath, context.lockToken)).ok,
      true,
    );
    const recovered = await repairInstall({ root, apply: true });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.deepEqual(readFileSync(target), before);
    assert.equal(
      (await readInstallJournal(context.journalFile)).value?.status,
      'rolled-back',
    );
    const manifest = (await readWorkspaceManifest(root)).value;
    const restored = await observePath(target);
    const owned = manifest?.entries.find((item) => item.path === entry.path);
    assert.equal(owned?.afterDigest, sha256Digest(before));
    assert.equal(owned?.identity.ino, restored.stats?.ino);
    assert.equal((await applyInitPlan(next.bundle)).ok, true);
  } finally {
    cleanup(root);
  }
});

function journal(root: string, runtimeVersion?: string): InstallJournal {
  root = realpathSync(root);
  const installId = randomUUID();
  return {
    schema: 'pappra/install-journal/1',
    installId,
    operation:
      runtimeVersion === undefined
        ? 'apply-workspace-files'
        : 'install-runtime',
    target:
      runtimeVersion === undefined
        ? randomUUID()
        : runtimePaths(runtimeVersion, root).runtimeRoot,
    workspaceRoot: runtimeVersion === undefined ? root : null,
    runtimeVersion: runtimeVersion ?? null,
    status: 'applying',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [],
    entries: [],
    residuals: [],
    manifestRef:
      runtimeVersion === undefined
        ? workspaceInstallPaths(root).manifestPath
        : join(
            runtimePaths(runtimeVersion, root).runtimeRoot,
            'install-manifest.json',
          ),
  };
}

test('repair can release a dead install lock left before journal creation', async () => {
  const root = realpathSync(makeTempDir('repair-orphan-lock'));
  try {
    const lock = workspaceInstallPaths(root).lockPath;
    staleLock(lock, root);
    const preview = await repairInstall({ root });
    assert.deepEqual(preview.locks, [lock]);
    assert.equal(existsSync(lock), true);
    const applied = await repairInstall({ root, apply: true });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.deepEqual(applied.repaired, [lock]);
    assert.equal(existsSync(lock), false);
  } finally {
    cleanup(root);
  }
});

test('failed reconfiguration restores preexisting user edits and matching ownership', async () => {
  const root = realpathSync(makeTempDir('repair-reconfigure-failure'));
  try {
    createRepository(root);
    const first = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
      runtimeVersion: '0.1.0-dev.0',
    });
    assert(first.ok);
    assert.equal((await applyInitPlan(first.bundle)).ok, true);
    const target = join(root, '.pappra/workspace.json');
    const previous: unknown = JSON.parse(readFileSync(target, 'utf8'));
    assert(typeof previous === 'object' && previous !== null);
    const before = Buffer.from(
      `${JSON.stringify({ ...previous, name: 'user edited before reconfigure' }, null, 2)}\n`,
    );
    writeFileSync(target, before);
    const next = await planWorkspaceInit({
      root,
      choices: baseInitChoices({ name: 'requested replacement', hosts: [] }),
      reconfigure: true,
      runtimeVersion: '0.1.0-dev.0',
    });
    assert(next.ok);
    assert(next.bundle.plan.files.length >= 2);
    const applied = await applyInitPlan(next.bundle, {
      beforeWrite: (file) => {
        if (file === '.pappra/local/machine.json')
          throw new Error('Simulated second-file failure.');
      },
    });
    assert.equal(applied.ok, false);
    assert.deepEqual(readFileSync(target), before);
    assert.deepEqual(applied.residualPaths, []);
    const manifest = (await readWorkspaceManifest(root)).value;
    const owned = manifest?.entries.find(
      (entry) => entry.path === '.pappra/workspace.json',
    );
    assert.equal(owned?.afterDigest, sha256Digest(before));
    assert.equal(owned?.identity.ino, (await observePath(target)).stats?.ino);
  } finally {
    cleanup(root);
  }
});

function staleLock(file: string, target: string, pid = deadPid()): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schema: 'pappra/install-lock/1',
      token: randomUUID(),
      operation: 'apply-workspace-files',
      target,
      pid,
      createdAt: new Date().toISOString(),
    }),
  );
}

test('repair preview is read-only; explicit apply releases a dead owner and closes a recovered workspace journal', async () => {
  const root = realpathSync(makeTempDir('repair-workspace'));
  try {
    const item = journal(root);
    const owned = join(root, 'owned.json');
    writeFileSync(owned, '{}');
    const observation = await observePath(owned);
    assert(observation.stats !== null);
    item.entries.push(
      {
        path: 'owned.json',
        status: 'created',
        digest: sha256Digest('{}'),
        identity: { dev: observation.stats.dev, ino: observation.stats.ino },
        backupRef: null,
        backupDigest: null,
        detail: null,
      },
      {
        path: 'missing.json',
        status: 'pending',
        digest: sha256Digest('{}'),
        identity: null,
        backupRef: null,
        backupDigest: null,
        detail: null,
      },
    );
    const file = journalPath(root, item.installId);
    assert.equal((await writeInstallJournal(file, item, root)).ok, true);
    const lock = workspaceInstallPaths(root).lockPath;
    staleLock(lock, item.target);
    const preview = await repairInstall({ root });
    assert.equal(preview.ok, true);
    assert.equal(preview.entries.length, 1);
    assert.equal(existsSync(owned), true);
    assert.equal(existsSync(lock), true);
    const applied = await repairInstall({ root, apply: true });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(existsSync(owned), false);
    assert.equal(existsSync(lock), false);
    assert.equal((await readInstallJournal(file)).value?.status, 'rolled-back');
    assert.equal((await repairInstall({ root })).entries.length, 0);
  } finally {
    cleanup(root);
  }
});

test('repair refuses live owners and uncertain pending files', async () => {
  const root = realpathSync(makeTempDir('repair-live'));
  try {
    const item = journal(root);
    const file = journalPath(root, item.installId);
    await writeInstallJournal(file, item, root);
    const lock = workspaceInstallPaths(root).lockPath;
    staleLock(lock, item.target, process.pid);
    const before = readFileSync(lock, 'utf8');
    assert.equal((await repairInstall({ root, apply: true })).ok, false);
    assert.equal(readFileSync(lock, 'utf8'), before);
  } finally {
    cleanup(root);
  }

  const uncertain = realpathSync(makeTempDir('repair-uncertain'));
  try {
    const item = journal(uncertain);
    item.entries.push({
      path: 'user.txt',
      status: 'pending',
      digest: sha256Digest('user'),
      identity: null,
      backupRef: null,
      backupDigest: null,
      detail: null,
    });
    writeFileSync(join(uncertain, 'user.txt'), 'user');
    const file = journalPath(uncertain, item.installId);
    await writeInstallJournal(file, item, uncertain);
    assert.equal(
      (await repairInstall({ root: uncertain, apply: true })).ok,
      false,
    );
    assert.equal(readFileSync(join(uncertain, 'user.txt'), 'utf8'), 'user');
    assert.equal((await readInstallJournal(file)).value?.status, 'applying');
  } finally {
    cleanup(uncertain);
  }
});

test('runtime repair removes only the journal-owned staging directory and supports retry', async () => {
  const root = realpathSync(makeTempDir('repair-runtime'));
  try {
    const version = '9.8.7';
    const item = journal(root, version);
    const paths = runtimePaths(version, root);
    const stage = join(paths.stagingRoot, item.installId);
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'partial.json'), '{}');
    item.steps.push({
      name: 'staging-created',
      status: 'ok',
      at: item.createdAt,
      detail: stage,
    });
    const file = join(paths.journalsDir, `${item.installId}.json`);
    await writeInstallJournal(file, item, root);
    staleLock(paths.lockPath, paths.runtimeRoot);
    const applied = await repairInstall({
      root,
      dataDir: root,
      runtimeVersion: version,
      apply: true,
    });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(existsSync(stage), false);
    assert.equal((await readInstallJournal(file)).value?.status, 'rolled-back');
    assert.equal(
      (await repairInstall({ root, dataDir: root, runtimeVersion: version }))
        .entries.length,
      0,
    );
  } finally {
    cleanup(root);
  }
});

test('runtime repair finalizes a published runtime without executing its program', async () => {
  const root = realpathSync(makeTempDir('repair-published'));
  try {
    const version = '9.8.6';
    const executionMarkerPath = join(root, 'executed');
    const tarball = createRuntimeTarball(root, {
      version,
      executionMarkerPath,
    });
    const installed = await installRuntime({
      version,
      dataDir: root,
      source: { kind: 'tarball', path: tarball },
      offline: true,
    });
    assert.equal(installed.ok, true);
    assert(installed.journal !== null);
    const file = join(
      runtimePaths(version, root).journalsDir,
      `${installed.journal.installId}.json`,
    );
    await writeInstallJournal(
      file,
      { ...installed.journal, status: 'applied' },
      root,
    );
    writeFileSync(executionMarkerPath, 'unchanged');
    const applied = await repairInstall({
      root,
      dataDir: root,
      runtimeVersion: version,
      apply: true,
    });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(readFileSync(executionMarkerPath, 'utf8'), 'unchanged');
    assert.equal((await readInstallJournal(file)).value?.status, 'verified');
    assert.equal(existsSync(installed.runtimeRoot!), true);
  } finally {
    cleanup(root);
  }
});

test('repair rejects redirected state and invalid CLI options', async () => {
  const root = realpathSync(makeTempDir('repair-unsafe'));
  const outside = realpathSync(makeTempDir('repair-outside'));
  try {
    mkdirSync(join(root, '.pappra'), { recursive: true });
    symlinkSync(outside, join(root, '.pappra', 'local'), 'dir');
    assert.equal((await repairInstall({ root, apply: true })).ok, false);
    let stdout = '';
    let stderr = '';
    const output = {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    };
    assert.equal(await runCli(['repair', '--help'], output), 0);
    assert.match(stdout, /--install-id/);
    assert.equal(await runCli(['repair', '--root', root, '--json'], output), 1);
    assert.equal(await runCli(['repair', '--force'], output), 2);
    assert.match(stderr, /Unknown option/);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});
