import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { applyInitPlan, planWorkspaceInit } from '../../src/app/init.js';
import { installRuntime, runtimePaths } from '../../src/install/runtime.js';
import { updateMachineRuntime } from '../../src/install/apply.js';
import {
  acquireInstallLock,
  journalPath,
  readInstallJournal,
  readWorkspaceManifest,
  releaseInstallLock,
  workspaceInstallPaths,
  writeInstallJournal,
} from '../../src/install/ownership.js';
import {
  rollbackWorkspaceInstall,
  uninstallWorkspaceManagedFiles,
} from '../../src/install/rollback.js';
import { cleanup, createRuntimeTarball, makeTempDir } from './fixtures.js';
import type { InstallJournal } from '../../src/schemas/install.js';
import { observePath, sha256Digest } from '../../src/infra/fs.js';
import { baseInitChoices } from '../init/fixtures.js';
import { createRepository, writeText } from '../workspace/fixtures.js';

test('P04 managed apply records ownership and journal for created config files', async () => {
  const root = makeTempDir('managed-apply');
  try {
    createRepository(root);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const applied = await applyInitPlan(prepared.bundle);
    assert.equal(applied.ok, true);
    const manifestRead = await readWorkspaceManifest(root);
    assert(manifestRead.value !== null);
    const manifest = manifestRead.value;
    assert.equal(manifest.entries.length, 2);
    assert(
      manifest.entries.every(
        (entry) => entry.owner === 'pappra' && entry.operation === 'create',
      ),
    );
    const installId = manifest.entries[0]!.installId;
    const journal = await readInstallJournal(
      join(workspaceInstallPaths(root).journalsDir, `${installId}.json`),
    );
    assert.equal(journal.value?.status, 'verified');
    assert.equal(existsSync(workspaceInstallPaths(root).lockPath), false);
  } finally {
    cleanup(root);
  }
});

test('rollback removes only matching owned files and preserves knowledge', async () => {
  const root = makeTempDir('managed-rollback');
  try {
    createRepository(root);
    writeText(join(root, 'docs', 'keep.md'), '# keep\n');
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal((await applyInitPlan(prepared.bundle)).ok, true);
    const manifest = (await readWorkspaceManifest(root)).value;
    assert(manifest !== null);
    const installId = manifest.entries[0]!.installId;
    const result = await rollbackWorkspaceInstall({ root, installId });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'rolled-back');
    assert.equal(existsSync(join(root, '.pappra', 'workspace.json')), false);
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'machine.json')),
      false,
    );
    assert.equal(existsSync(join(root, 'docs', 'keep.md')), true);
    assert.equal((await readWorkspaceManifest(root)).value?.entries.length, 0);
  } finally {
    cleanup(root);
  }
});

test('rollback preserves user-modified managed files and reports residual paths', async () => {
  const root = makeTempDir('managed-rollback-conflict');
  try {
    createRepository(root);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal((await applyInitPlan(prepared.bundle)).ok, true);
    const manifest = (await readWorkspaceManifest(root)).value;
    assert(manifest !== null);
    const installId = manifest.entries[0]!.installId;
    writeFileSync(
      join(root, '.pappra', 'workspace.json'),
      '{"user":"modified"}\n',
    );
    const result = await rollbackWorkspaceInstall({ root, installId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'partial');
    assert.equal(result.residualPaths.includes('.pappra/workspace.json'), true);
    assert.equal(
      readFileSync(join(root, '.pappra', 'workspace.json'), 'utf8'),
      '{"user":"modified"}\n',
    );
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'machine.json')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('uninstall removes managed files but leaves knowledge and user files', async () => {
  const root = makeTempDir('managed-uninstall');
  try {
    createRepository(root);
    writeText(join(root, 'docs', 'keep.md'), '# keep\n');
    writeText(join(root, 'notes.txt'), 'user notes\n');
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal((await applyInitPlan(prepared.bundle)).ok, true);
    const result = await uninstallWorkspaceManagedFiles({ root });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'uninstalled');
    assert.equal(existsSync(join(root, '.pappra', 'workspace.json')), false);
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'machine.json')),
      false,
    );
    assert.equal(
      readFileSync(join(root, 'docs', 'keep.md'), 'utf8'),
      '# keep\n',
    );
    assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'user notes\n');
  } finally {
    cleanup(root);
  }
});

test('records a verified runtime only through owned machine.json and keeps a backup', async () => {
  const root = makeTempDir('managed-runtime-update');
  const runtimeRoot = makeTempDir('managed-runtime-source');
  try {
    createRepository(root);
    const tarball = createRuntimeTarball(runtimeRoot, { version: '9.8.7' });
    const runtime = await installRuntime({
      version: '9.8.7',
      source: { kind: 'tarball', path: tarball },
      dataDir: join(runtimeRoot, 'data'),
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(runtime.ok, true);
    assert(runtime.manifest !== null);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal((await applyInitPlan(prepared.bundle)).ok, true);
    const updated = await updateMachineRuntime(root, runtime.manifest);
    assert.equal(updated.ok, true, updated.diagnostics[0]?.message);
    const machine = JSON.parse(
      readFileSync(join(root, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime.version, '9.8.7');
    assert.equal(machine.runtime.executable, runtime.manifest.executable);
    const manifest = (await readWorkspaceManifest(root)).value;
    const machineEntry = manifest?.entries.find(
      (entry) => entry.path === '.pappra/local/machine.json',
    );
    assert(machineEntry?.backupRef !== null);
    assert.equal(
      existsSync(join(root, ...(machineEntry?.backupRef ?? '').split('/'))),
      true,
    );
    const runtimePathsValue = runtimePaths('9.8.7', join(runtimeRoot, 'data'));
    assert.equal(existsSync(runtimePathsValue.runtimeRoot), true);
  } finally {
    cleanup(root);
    cleanup(runtimeRoot);
  }
});

test('refuses a machine runtime update when a workspace journal candidate is not regular', async () => {
  const root = makeTempDir('managed-runtime-broken-journal');
  const runtimeRoot = makeTempDir('managed-runtime-broken-source');
  try {
    createRepository(root);
    const tarball = createRuntimeTarball(runtimeRoot, { version: '9.8.7' });
    const runtime = await installRuntime({
      version: '9.8.7',
      source: { kind: 'tarball', path: tarball },
      dataDir: join(runtimeRoot, 'data'),
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(runtime.ok, true);
    assert(runtime.manifest !== null);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal((await applyInitPlan(prepared.bundle)).ok, true);
    const broken = join(workspaceInstallPaths(root).journalsDir, 'broken.json');
    symlinkSync(
      join(workspaceInstallPaths(root).journalsDir, 'missing'),
      broken,
    );

    const result = await updateMachineRuntime(root, runtime.manifest);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'partial');
    assert(
      result.diagnostics[0]?.message.includes('unreadable or incompatible'),
    );
    assert.equal(lstatSync(broken).isSymbolicLink(), true);
    const machine = JSON.parse(
      readFileSync(join(root, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime, null);
  } finally {
    cleanup(root);
    cleanup(runtimeRoot);
  }
});

test('does not adopt an unowned machine.json for runtime updates', async () => {
  const root = makeTempDir('managed-unowned');
  const runtimeRoot = makeTempDir('managed-unowned-runtime');
  try {
    createRepository(root);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    // Write configs without P04 ownership, as an older P03 install could have.
    for (const write of prepared.bundle.writes) {
      const path = join(root, ...write.path.split('/'));
      writeText(path, write.bytes.toString('utf8'));
    }
    const tarball = createRuntimeTarball(runtimeRoot, { version: '9.8.7' });
    const runtime = await installRuntime({
      version: '9.8.7',
      source: { kind: 'tarball', path: tarball },
      dataDir: join(runtimeRoot, 'data'),
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(runtime.ok, true);
    assert(runtime.manifest !== null);
    const updated = await updateMachineRuntime(root, runtime.manifest);
    assert.equal(updated.ok, false);
    assert.equal(updated.status, 'unmanaged');
  } finally {
    cleanup(root);
    cleanup(runtimeRoot);
  }
});

test('rolls back files recorded only in an interrupted apply journal', async () => {
  const root = makeTempDir('managed-journal-recovery');
  try {
    createRepository(root);
    writeText(join(root, 'docs', 'keep.md'), '# keep\n');
    const target = join(root, '.pappra', 'workspace.json');
    writeText(target, '{"interrupted":true}\n');
    const bytes = readFileSync(target);
    const observation = await observePath(target);
    assert(observation.stats !== null);
    const installId = '55555555-5555-4555-8555-555555555555';
    const journal: InstallJournal = {
      schema: 'pappra/install-journal/1',
      installId,
      operation: 'apply-workspace-files',
      target: 'interrupted-plan',
      workspaceRoot: root,
      runtimeVersion: null,
      status: 'applying',
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
      steps: [],
      entries: [
        {
          path: '.pappra/workspace.json',
          status: 'created',
          digest: sha256Digest(bytes),
          identity: {
            dev: observation.stats.dev,
            ino: observation.stats.ino,
          },
          backupRef: null,
          backupDigest: null,
          detail: null,
        },
      ],
      residuals: [],
      manifestRef: workspaceInstallPaths(root).manifestPath,
    };
    const written = await writeInstallJournal(
      journalPath(root, installId),
      journal,
    );
    assert.equal(written.ok, true);
    const result = await rollbackWorkspaceInstall({ root, installId });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'rolled-back');
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(join(root, 'docs', 'keep.md')), true);
    assert.equal((await readWorkspaceManifest(root)).exists, false);
  } finally {
    cleanup(root);
  }
});

test('refuses managed apply while the workspace lock is held', async () => {
  const root = makeTempDir('managed-apply-lock');
  try {
    createRepository(root);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const lock = await acquireInstallLock(
      workspaceInstallPaths(root).lockPath,
      'apply-workspace-files',
      root,
    );
    assert.equal(lock.ok, true);
    const applied = await applyInitPlan(prepared.bundle);
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'conflict');
    assert.equal(existsSync(join(root, '.pappra', 'workspace.json')), false);
    assert(lock.lock !== null);
    await releaseInstallLock(lock.path, lock.lock.token);
  } finally {
    cleanup(root);
  }
});

test('reports unknown pending entries when recovering a mixed apply journal', async () => {
  const root = makeTempDir('managed-journal-mixed');
  try {
    createRepository(root);
    const workspacePath = join(root, '.pappra', 'workspace.json');
    const machinePath = join(root, '.pappra', 'local', 'machine.json');
    writeText(workspacePath, '{"created":true}\n');
    writeText(machinePath, '{"pending":true}\n');
    const bytes = readFileSync(workspacePath);
    const observation = await observePath(workspacePath);
    assert(observation.stats !== null);
    const installId = '66666666-6666-4666-8666-666666666666';
    const journal: InstallJournal = {
      schema: 'pappra/install-journal/1',
      installId,
      operation: 'apply-workspace-files',
      target: 'mixed-plan',
      workspaceRoot: root,
      runtimeVersion: null,
      status: 'applying',
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
      steps: [],
      entries: [
        {
          path: '.pappra/workspace.json',
          status: 'created',
          digest: sha256Digest(bytes),
          identity: {
            dev: observation.stats.dev,
            ino: observation.stats.ino,
          },
          backupRef: null,
          backupDigest: null,
          detail: null,
        },
        {
          path: '.pappra/local/machine.json',
          status: 'pending',
          digest: sha256Digest('unknown'),
          identity: null,
          backupRef: null,
          backupDigest: null,
          detail: null,
        },
      ],
      residuals: [],
      manifestRef: workspaceInstallPaths(root).manifestPath,
    };
    const written = await writeInstallJournal(
      journalPath(root, installId),
      journal,
    );
    assert.equal(written.ok, true);
    const result = await rollbackWorkspaceInstall({ root, installId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'partial');
    assert.equal(existsSync(workspacePath), false);
    assert.equal(existsSync(machinePath), true);
    assert.deepEqual(result.residualPaths, ['.pappra/local/machine.json']);
  } finally {
    cleanup(root);
  }
});

test('rejects managed metadata paths that escape through a symlinked state directory', async () => {
  const root = makeTempDir('managed-symlink-state');
  const outside = makeTempDir('managed-symlink-state-outside');
  try {
    createRepository(root);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    mkdirSync(join(root, '.pappra', 'local'), { recursive: true });
    writeText(join(outside, 'keep.txt'), 'outside\n');
    symlinkSync(outside, join(root, '.pappra', 'local', 'journals'), 'dir');
    const applied = await applyInitPlan(prepared.bundle);
    assert.equal(applied.ok, false);
    assert.equal(existsSync(join(root, '.pappra', 'workspace.json')), false);
    assert.deepEqual(readdirSync(outside), ['keep.txt']);
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'apply.lock')),
      false,
    );
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('does not advance machine ownership when the machine write fails', async () => {
  const root = makeTempDir('managed-machine-write-failure');
  const runtimeRoot = makeTempDir('managed-machine-write-runtime');
  try {
    createRepository(root);
    const tarball = createRuntimeTarball(runtimeRoot, { version: '9.8.7' });
    const runtime = await installRuntime({
      version: '9.8.7',
      source: { kind: 'tarball', path: tarball },
      dataDir: join(runtimeRoot, 'data'),
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(runtime.ok, true);
    assert(runtime.manifest !== null);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal((await applyInitPlan(prepared.bundle)).ok, true);
    const before = (await readWorkspaceManifest(root)).value;
    const machineBefore = before?.entries.find(
      (entry) => entry.path === '.pappra/local/machine.json',
    );
    const failed = await updateMachineRuntime(root, runtime.manifest, {
      beforeWrite: async () => {
        await chmod(join(root, '.pappra', 'local'), 0o555);
      },
    });
    await chmod(join(root, '.pappra', 'local'), 0o755);
    assert.equal(failed.ok, false);
    const machine = JSON.parse(
      readFileSync(join(root, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime, null);
    const after = (await readWorkspaceManifest(root)).value;
    const machineAfter = after?.entries.find(
      (entry) => entry.path === '.pappra/local/machine.json',
    );
    assert.equal(machineAfter?.afterDigest, machineBefore?.afterDigest);
  } finally {
    await chmod(join(root, '.pappra', 'local'), 0o755).catch(() => undefined);
    cleanup(root);
    cleanup(runtimeRoot);
  }
});

test('rolls back a managed machine runtime update by update installId', async () => {
  const root = makeTempDir('managed-machine-update-rollback');
  const runtimeRoot = makeTempDir('managed-machine-update-runtime');
  try {
    createRepository(root);
    const tarball = createRuntimeTarball(runtimeRoot, { version: '9.8.7' });
    const runtime = await installRuntime({
      version: '9.8.7',
      source: { kind: 'tarball', path: tarball },
      dataDir: join(runtimeRoot, 'data'),
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(runtime.ok, true);
    assert(runtime.manifest !== null);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal((await applyInitPlan(prepared.bundle)).ok, true);
    const updated = await updateMachineRuntime(root, runtime.manifest);
    assert.equal(updated.ok, true);
    assert(updated.updateInstallId !== undefined);
    const result = await rollbackWorkspaceInstall({
      root,
      installId: updated.updateInstallId,
    });
    assert.equal(result.ok, true, result.diagnostics[0]?.message);
    assert.equal(result.status, 'rolled-back');
    const machine = JSON.parse(
      readFileSync(join(root, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime, null);
  } finally {
    cleanup(root);
    cleanup(runtimeRoot);
  }
});

test('makes a repeated identical machine runtime update idempotent', async () => {
  const root = makeTempDir('managed-machine-idempotent');
  const runtimeRoot = makeTempDir('managed-machine-idempotent-runtime');
  try {
    createRepository(root);
    const tarball = createRuntimeTarball(runtimeRoot, { version: '9.8.7' });
    const runtime = await installRuntime({
      version: '9.8.7',
      source: { kind: 'tarball', path: tarball },
      dataDir: join(runtimeRoot, 'data'),
      offline: true,
      timeoutMs: 60_000,
    });
    assert(runtime.ok && runtime.manifest !== null);
    if (!runtime.ok || runtime.manifest === null) return;
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal((await applyInitPlan(prepared.bundle)).ok, true);
    const first = await updateMachineRuntime(root, runtime.manifest);
    assert.equal(first.ok, true);
    const second = await updateMachineRuntime(root, runtime.manifest);
    assert.equal(second.ok, true);
    assert.equal(second.status, 'unchanged');

    const lock = await acquireInstallLock(
      workspaceInstallPaths(root).lockPath,
      'update-machine-runtime',
      root,
      root,
    );
    assert.equal(lock.ok, true);
    const locked = await updateMachineRuntime(root, runtime.manifest);
    assert.equal(locked.ok, false);
    assert.equal(locked.status, 'locked');
    assert(lock.lock !== null);
    await releaseInstallLock(lock.path, lock.lock.token);
  } finally {
    cleanup(root);
    cleanup(runtimeRoot);
  }
});

test('refuses to restore a machine update from a corrupted backup', async () => {
  const root = makeTempDir('managed-machine-backup-corrupt');
  const runtimeRoot = makeTempDir('managed-machine-backup-corrupt-runtime');
  try {
    createRepository(root);
    const tarball = createRuntimeTarball(runtimeRoot, { version: '9.8.7' });
    const runtime = await installRuntime({
      version: '9.8.7',
      source: { kind: 'tarball', path: tarball },
      dataDir: join(runtimeRoot, 'data'),
      offline: true,
      timeoutMs: 60_000,
    });
    assert(runtime.ok && runtime.manifest !== null);
    if (!runtime.ok || runtime.manifest === null) return;
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal((await applyInitPlan(prepared.bundle)).ok, true);
    const updated = await updateMachineRuntime(root, runtime.manifest);
    assert(updated.ok && updated.updateInstallId !== undefined);
    if (!updated.ok || updated.updateInstallId === undefined) return;
    const manifest = (await readWorkspaceManifest(root)).value;
    const entry = manifest?.entries.find(
      (item) => item.path === '.pappra/local/machine.json',
    );
    assert(entry?.backupRef !== null && entry?.backupRef !== undefined);
    const backup = join(root, ...entry.backupRef.split('/'));
    writeFileSync(backup, 'corrupted backup');
    const result = await rollbackWorkspaceInstall({
      root,
      installId: updated.updateInstallId,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'partial');
    const machine = JSON.parse(
      readFileSync(join(root, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime.version, '9.8.7');
  } finally {
    cleanup(root);
    cleanup(runtimeRoot);
  }
});

test('does not report completion when the machine update journal cannot persist', async () => {
  const root = makeTempDir('managed-machine-journal-failure');
  const runtimeRoot = makeTempDir('managed-machine-journal-failure-runtime');
  try {
    createRepository(root);
    const tarball = createRuntimeTarball(runtimeRoot, { version: '9.8.7' });
    const runtime = await installRuntime({
      version: '9.8.7',
      source: { kind: 'tarball', path: tarball },
      dataDir: join(runtimeRoot, 'data'),
      offline: true,
      timeoutMs: 60_000,
    });
    assert(runtime.ok && runtime.manifest !== null);
    if (!runtime.ok || runtime.manifest === null) return;
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal((await applyInitPlan(prepared.bundle)).ok, true);
    const journals = workspaceInstallPaths(root).journalsDir;
    const updated = await updateMachineRuntime(root, runtime.manifest, {
      beforeFinalJournalPersist: async () => {
        await chmod(journals, 0o555);
      },
    });
    await chmod(journals, 0o755).catch(() => undefined);
    assert.equal(updated.ok, false);
    assert.equal(updated.status, 'partial');
    assert(updated.residualPaths.length > 0);
    const retry = await updateMachineRuntime(root, runtime.manifest);
    assert.equal(retry.ok, false);
    assert.equal(retry.status, 'partial');
  } finally {
    await chmod(join(root, '.pappra', 'local', 'journals'), 0o755).catch(
      () => undefined,
    );
    cleanup(root);
    cleanup(runtimeRoot);
  }
});

test('rollback by update ID does not undo a later runtime update', async () => {
  const root = makeTempDir('managed-update-sequence');
  const runtimeRoot = makeTempDir('managed-update-sequence-runtime');
  try {
    createRepository(root);
    const tarballA = createRuntimeTarball(runtimeRoot, { version: '9.8.7' });
    const runtimeA = await installRuntime({
      version: '9.8.7',
      source: { kind: 'tarball', path: tarballA },
      dataDir: join(runtimeRoot, 'data'),
      offline: true,
      timeoutMs: 60_000,
    });
    assert(runtimeA.ok && runtimeA.manifest !== null);
    if (!runtimeA.ok || runtimeA.manifest === null) return;
    const tarballB = createRuntimeTarball(runtimeRoot, { version: '9.8.8' });
    const runtimeB = await installRuntime({
      version: '9.8.8',
      source: { kind: 'tarball', path: tarballB },
      dataDir: join(runtimeRoot, 'data'),
      offline: true,
      timeoutMs: 60_000,
    });
    assert(runtimeB.ok && runtimeB.manifest !== null);
    if (!runtimeB.ok || runtimeB.manifest === null) return;
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
      }),
      runtimeVersion: '9.8.7',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal((await applyInitPlan(prepared.bundle)).ok, true);
    const updateA = await updateMachineRuntime(root, runtimeA.manifest);
    assert(updateA.ok && updateA.updateInstallId !== undefined);
    if (!updateA.ok || updateA.updateInstallId === undefined) return;
    const updateB = await updateMachineRuntime(root, runtimeB.manifest);
    assert(updateB.ok && updateB.updateInstallId !== undefined);
    if (!updateB.ok || updateB.updateInstallId === undefined) return;

    const oldRollback = await rollbackWorkspaceInstall({
      root,
      installId: updateA.updateInstallId,
    });
    assert.equal(oldRollback.ok, false);
    assert.equal(oldRollback.status, 'partial');
    let machine = JSON.parse(
      readFileSync(join(root, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime.version, '9.8.8');

    const latestRollback = await rollbackWorkspaceInstall({
      root,
      installId: updateB.updateInstallId,
    });
    assert.equal(
      latestRollback.ok,
      true,
      latestRollback.diagnostics[0]?.message,
    );
    machine = JSON.parse(
      readFileSync(join(root, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime.version, '9.8.7');
  } finally {
    cleanup(root);
    cleanup(runtimeRoot);
  }
});
