import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runDoctor } from '../../src/app/doctor.js';
import { applyInitPlan, planWorkspaceInit } from '../../src/app/init.js';
import { inspectWorkspaceInstallReadiness } from '../../src/install/apply.js';
import {
  journalPath,
  readInstallJournal,
  readWorkspaceManifest,
  workspaceInstallPaths,
  writeInstallJournal,
} from '../../src/install/ownership.js';
import {
  rollbackWorkspaceInstall,
  uninstallWorkspaceManagedFiles,
} from '../../src/install/rollback.js';
import {
  beginRuntimeReference,
  inspectRuntimeReferences,
  runtimeReferencesDirectory,
} from '../../src/install/references.js';
import { repairInstall } from '../../src/install/repair.js';
import {
  inspectLocalResetState,
  resetLocalState,
} from '../../src/install/reset-local.js';
import { archiveRuntime } from '../../src/install/runtime-archive.js';
import { runtimeArchiveDirectory } from '../../src/install/runtime-archive-state.js';
import { runtimePaths } from '../../src/install/runtime.js';
import { observePath, sha256Digest } from '../../src/infra/fs.js';
import { persistedIdentityMatches } from '../../src/infra/persisted-identity.js';
import type {
  RuntimeManifest,
  WorkspaceInstallManifest,
} from '../../src/schemas/install.js';
import { baseInitChoices } from '../init/fixtures.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  createRepository,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';
import { cleanup, makeTempDir } from './fixtures.js';

const version = '9.8.7';
const now = '2026-10-25T00:00:00.000Z';

interface PersistedIdentity {
  dev?: number;
  ino: number;
}

/** Models a macOS reboot: the same volume is observed under another device number. */
function shiftDev(identity: PersistedIdentity): void {
  identity.dev = (identity.dev ?? 0) + 1;
}

function shiftIno(identity: PersistedIdentity): void {
  identity.ino += 1;
}

async function installWorkspace(
  root: string,
): Promise<WorkspaceInstallManifest> {
  createRepository(root);
  const prepared = await planWorkspaceInit({
    root,
    choices: baseInitChoices({
      repositories: [{ path: '.', access: 'write' }],
    }),
    runtimeVersion: version,
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  if (!prepared.ok) throw new Error('fixture planning failed');
  const applied = await applyInitPlan(prepared.bundle);
  assert.equal(applied.ok, true, JSON.stringify(applied.diagnostics));
  const manifest = (await readWorkspaceManifest(root)).value;
  assert(manifest !== null);
  return manifest;
}

/** Rewrites every persisted identity in the install manifest, as an old document. */
function rewriteManifestIdentities(
  root: string,
  mutate: (identity: PersistedIdentity) => void,
): void {
  const path = workspaceInstallPaths(root).manifestPath;
  const document = JSON.parse(readFileSync(path, 'utf8')) as {
    rootIdentity: PersistedIdentity;
    entries: { identity: PersistedIdentity }[];
  };
  mutate(document.rootIdentity);
  for (const entry of document.entries) mutate(entry.identity);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}

test('persisted identity matches on inode only and ignores the recorded device', () => {
  assert.equal(
    persistedIdentityMatches(
      { dev: 16777230, ino: 42 },
      { dev: 16777229, ino: 42 },
    ),
    true,
  );
  assert.equal(
    persistedIdentityMatches({ ino: 42 }, { dev: 7, ino: 42 }),
    true,
  );
  assert.equal(
    persistedIdentityMatches({ dev: 1, ino: 42 }, { dev: 1, ino: 43 }),
    false,
  );
  assert.equal(persistedIdentityMatches(null, { ino: 42 }), false);
  assert.equal(persistedIdentityMatches({ ino: 42 }, null), false);
});

test('readiness, rollback and doctor accept a changed device but reject a different inode', async () => {
  const root = realpathSync(makeTempDir('persisted-identity-manifest'));
  const rejected = realpathSync(makeTempDir('persisted-identity-manifest-ino'));
  try {
    await installWorkspace(root);
    rewriteManifestIdentities(root, shiftDev);
    const ready = await inspectWorkspaceInstallReadiness(root);
    assert.equal(ready.ok, true, ready.ok ? '' : ready.message);
    const report = await runDoctor({ root });
    assert.equal(
      report.checks.some((check) =>
        check.summary.includes(
          'manifest root identity does not match the current workspace',
        ),
      ),
      false,
    );
    const manifest = (await readWorkspaceManifest(root)).value!;
    const rollback = await rollbackWorkspaceInstall({
      root,
      installId: manifest.entries[0]!.installId,
    });
    assert.equal(rollback.ok, true, JSON.stringify(rollback.diagnostics));
    assert.equal(rollback.status, 'rolled-back');

    const inodeManifest = await installWorkspace(rejected);
    rewriteManifestIdentities(rejected, shiftIno);
    const stale = await inspectWorkspaceInstallReadiness(rejected);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, 'init_plan_stale');
    const rollbackRejected = await rollbackWorkspaceInstall({
      root: rejected,
      installId: inodeManifest.entries[0]!.installId,
    });
    assert.equal(rollbackRejected.ok, false);
    assert.equal(rollbackRejected.status, 'failed');
    const uninstallRejected = await uninstallWorkspaceManagedFiles({
      root: rejected,
    });
    assert.equal(uninstallRejected.ok, false);
    assert.equal(uninstallRejected.status, 'failed');
    assert.equal(existsSync(join(rejected, '.pappra', 'workspace.json')), true);
  } finally {
    cleanup(root);
    cleanup(rejected);
  }
});

test('a changed device still rolls back a matching owned file and a different inode is preserved', async () => {
  const accepted = realpathSync(makeTempDir('persisted-identity-owned'));
  const refused = realpathSync(makeTempDir('persisted-identity-owned-ino'));
  try {
    for (const [root, mutate] of [
      [accepted, shiftDev],
      [refused, shiftIno],
    ] as const) {
      const manifest = await installWorkspace(root);
      rewriteManifestIdentities(root, mutate);
      const result = await rollbackWorkspaceInstall({
        root,
        installId: manifest.entries[0]!.installId,
      });
      const target = join(root, '.pappra', 'workspace.json');
      if (mutate === shiftDev) {
        assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
        assert.equal(existsSync(target), false);
      } else {
        assert.equal(result.ok, false);
        assert.equal(result.status, 'failed');
        assert.equal(existsSync(target), true);
      }
    }
  } finally {
    cleanup(accepted);
    cleanup(refused);
  }
});

test('repair accepts a changed device in a replayed journal and keeps rejecting inode drift', async () => {
  const accepted = realpathSync(makeTempDir('persisted-identity-repair'));
  const refused = realpathSync(makeTempDir('persisted-identity-repair-ino'));
  try {
    for (const [root, mutate] of [
      [accepted, shiftDev],
      [refused, shiftIno],
    ] as const) {
      await installWorkspace(root);
      rewriteManifestIdentities(root, mutate);
      const target = join(root, '.pappra', 'workspace.json');
      const bytes = readFileSync(target);
      const observation = await observePath(target);
      assert(observation.stats !== null);
      const identity: PersistedIdentity = {
        dev: observation.stats.dev,
        ino: observation.stats.ino,
      };
      mutate(identity);
      const installId = randomUUID();
      const file = journalPath(root, installId);
      const written = await writeInstallJournal(file, {
        schema: 'pappra/install-journal/1',
        installId,
        operation: 'apply-workspace-files',
        target: 'interrupted-plan',
        workspaceRoot: root,
        runtimeVersion: null,
        status: 'applying',
        createdAt: now,
        updatedAt: now,
        steps: [],
        entries: [
          {
            path: '.pappra/workspace.json',
            status: 'created',
            digest: sha256Digest(bytes),
            identity,
            backupRef: null,
            backupDigest: null,
            detail: null,
          },
        ],
        residuals: [],
        manifestRef: workspaceInstallPaths(root).manifestPath,
      });
      assert.equal(written.ok, true);
      const repaired = await repairInstall({ root, apply: true });
      if (mutate === shiftDev) {
        assert.equal(repaired.ok, true, repaired.errors.join('; '));
        assert.equal(existsSync(target), false);
        assert.equal(
          (await readInstallJournal(file)).value?.status,
          'rolled-back',
        );
      } else {
        assert.equal(repaired.ok, false);
        assert.equal(existsSync(target), true);
      }
    }
  } finally {
    cleanup(accepted);
    cleanup(refused);
  }
});

test('repair verifies the manifest root identity by inode in a no-effect journal', async () => {
  const root = realpathSync(makeTempDir('persisted-identity-repair-noop'));
  try {
    await installWorkspace(root);
    rewriteManifestIdentities(root, shiftDev);
    const installId = randomUUID();
    const file = journalPath(root, installId);
    const written = await writeInstallJournal(file, {
      schema: 'pappra/install-journal/1',
      installId,
      operation: 'apply-workspace-files',
      target: 'interrupted-plan',
      workspaceRoot: root,
      runtimeVersion: null,
      status: 'applying',
      createdAt: now,
      updatedAt: now,
      steps: [],
      entries: [
        {
          path: '.pappra/never-written.json',
          status: 'pending',
          digest: sha256Digest('never written'),
          identity: null,
          backupRef: null,
          backupDigest: null,
          detail: null,
        },
      ],
      residuals: [],
      manifestRef: workspaceInstallPaths(root).manifestPath,
    });
    assert.equal(written.ok, true);
    const repaired = await repairInstall({ root, apply: true });
    assert.equal(repaired.ok, true, repaired.errors.join('; '));
    assert.equal((await readInstallJournal(file)).value?.status, 'rolled-back');
  } finally {
    cleanup(root);
  }
});

function referenceFixture() {
  const temp = makeTempDir('persisted-identity-reference');
  const root = realpathSync(temp);
  const dataDir = join(root, 'data');
  const paths = runtimePaths(version, dataDir);
  mkdirSync(paths.runtimeRoot, { recursive: true });
  writeWorkspaceConfig(root, baseWorkspaceConfig());
  writeMachineConfig(root, baseMachineConfig(root));
  const runtime: RuntimeManifest = {
    schema: 'pappra/runtime-manifest/3',
    installId: randomUUID(),
    runtimeVersion: version,
    packageName: '@phyzess/pappra',
    runtimeRoot: paths.runtimeRoot,
    executable: join(paths.runtimeRoot, 'cli.js'),
    source: {
      kind: 'version',
      version,
      packageName: '@phyzess/pappra',
      ref: `@phyzess/pappra@${version}`,
    },
    packageDigest: sha256Digest('fixture'),
    digestScheme: 'sha256-utf8-byte-order-v1',
    sourceFingerprint: sha256Digest('fixture'),
    smoke: { argv: [], exitCode: 0, stdoutDigest: sha256Digest('') },
    verifiedAt: now,
  };
  return { root, temp, dataDir, runtime };
}

test('runtime references accept a changed device and still reject inode drift', async () => {
  const fixture = referenceFixture();
  try {
    const first = await beginRuntimeReference(fixture.root, fixture.runtime);
    assert.equal(first.ok, true, JSON.stringify(first));
    if (!first.ok) return;
    assert.equal((await first.value.release()).ok, true);
    const directory = runtimeReferencesDirectory(fixture.dataDir);
    const files = readdirSync(directory);
    assert.equal(files.length, 1);
    const referencePath = join(directory, files[0]!);
    const reference = JSON.parse(readFileSync(referencePath, 'utf8')) as {
      rootIdentity: PersistedIdentity;
    };
    shiftDev(reference.rootIdentity);
    writeFileSync(referencePath, `${JSON.stringify(reference, null, 2)}\n`);
    const inspected = await inspectRuntimeReferences(fixture.dataDir, version);
    assert.equal(
      inspected.unknown.some((entry) =>
        entry.startsWith('workspace_missing_or_replaced'),
      ),
      false,
    );
    const repeated = await beginRuntimeReference(fixture.root, fixture.runtime);
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    if (repeated.ok) assert.equal((await repeated.value.release()).ok, true);

    const drifted = JSON.parse(readFileSync(referencePath, 'utf8')) as {
      rootIdentity: PersistedIdentity;
    };
    shiftIno(drifted.rootIdentity);
    writeFileSync(referencePath, `${JSON.stringify(drifted, null, 2)}\n`);
    const replaced = await inspectRuntimeReferences(fixture.dataDir, version);
    assert.equal(
      replaced.unknown.some((entry) =>
        entry.startsWith('workspace_missing_or_replaced'),
      ),
      true,
    );
    const refused = await beginRuntimeReference(fixture.root, fixture.runtime);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, 'init_apply_residual');
  } finally {
    cleanup(fixture.temp);
  }
});

function archiveFixture(mutate: (identity: PersistedIdentity) => void) {
  const temp = makeTempDir('persisted-identity-archive');
  const dataDir = join(realpathSync(temp), 'data');
  const paths = runtimePaths(version, dataDir);
  mkdirSync(paths.runtimeRoot, { recursive: true });
  writeFileSync(join(paths.runtimeRoot, 'evidence.bin'), Buffer.from([0, 255]));
  const installId = randomUUID();
  mkdirSync(paths.journalsDir, { recursive: true });
  const journalFile = join(paths.journalsDir, `${installId}.json`);
  writeFileSync(journalFile, '{interrupted');
  mkdirSync(join(paths.stagingRoot, installId), { recursive: true });
  writeFileSync(join(paths.stagingRoot, installId, 'partial'), 'staging');
  const directoryIdentity = (path: string) => {
    const stats = statSync(path);
    return {
      dev: stats.dev,
      ino: stats.ino,
      kind: 'directory',
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      digest: null,
    };
  };
  const fileIdentity = (path: string) => {
    const stats = statSync(path);
    const bytes = readFileSync(path);
    return {
      dev: stats.dev,
      ino: stats.ino,
      kind: 'file',
      size: bytes.length,
      mtimeMs: stats.mtimeMs,
      digest: sha256Digest(bytes),
    };
  };
  const runtimeIdentity = directoryIdentity(paths.runtimeRoot);
  const journalIdentity = fileIdentity(journalFile);
  const stagingIdentity = directoryIdentity(join(paths.stagingRoot, installId));
  for (const identity of [runtimeIdentity, journalIdentity, stagingIdentity])
    mutate(identity);
  const control = runtimeArchiveDirectory(dataDir, version);
  const archiveId = randomUUID();
  mkdirSync(join(control, archiveId), { recursive: true });
  writeFileSync(
    join(control, 'pending.json'),
    `${JSON.stringify(
      {
        schema: 'pappra/runtime-archive/1',
        id: archiveId,
        version,
        dataDir,
        status: 'prepared',
        createdAt: now,
        completedAt: null,
        reason: 'Retire interrupted runtime',
        forceUnknownReferences: true,
        allWritersStopped: false,
        references: null,
        lock: null,
        installIds: [installId],
        items: [
          {
            source: paths.runtimeRoot,
            destination: 'runtime',
            identity: runtimeIdentity,
          },
          {
            source: journalFile,
            destination: `journals/${installId}.json`,
            identity: journalIdentity,
          },
          {
            source: join(paths.stagingRoot, installId),
            destination: `staging/${installId}`,
            identity: stagingIdentity,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { temp, dataDir, paths };
}

test('resuming a runtime archive accepts a changed device and rejects inode drift', async () => {
  const accepted = archiveFixture(shiftDev);
  const refused = archiveFixture(shiftIno);
  try {
    const archived = await archiveRuntime({
      version,
      dataDir: accepted.dataDir,
      apply: true,
      forceUnknownReferences: true,
      reason: 'Resume interrupted archive',
    });
    assert.equal(archived.ok, true, JSON.stringify(archived));
    assert.equal(archived.status, 'archived');
    assert.equal(existsSync(accepted.paths.runtimeRoot), false);

    const blocked = await archiveRuntime({
      version,
      dataDir: refused.dataDir,
      apply: true,
      forceUnknownReferences: true,
      reason: 'Resume interrupted archive',
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 'failed');
    assert.equal(existsSync(refused.paths.runtimeRoot), true);
  } finally {
    cleanup(accepted.temp);
    cleanup(refused.temp);
  }
});

/** A document written before this change may omit the device entirely. */
function deleteDev(identity: { dev?: number }): void {
  delete identity.dev;
}

test('an install manifest without a dev field still verifies and rolls back', async () => {
  const root = realpathSync(makeTempDir('persisted-identity-no-dev'));
  try {
    const manifest = await installWorkspace(root);
    rewriteManifestIdentities(root, deleteDev);
    const stored = (await readWorkspaceManifest(root)).value!;
    assert.equal(stored.rootIdentity.dev, undefined);
    assert(stored.entries.every((entry) => entry.identity.dev === undefined));
    const ready = await inspectWorkspaceInstallReadiness(root);
    assert.equal(ready.ok, true, ready.ok ? '' : ready.message);
    const report = await runDoctor({ root });
    assert.equal(
      report.checks.some((check) =>
        check.summary.includes(
          'manifest root identity does not match the current workspace',
        ),
      ),
      false,
    );
    const rollback = await rollbackWorkspaceInstall({
      root,
      installId: manifest.entries[0]!.installId,
    });
    assert.equal(rollback.ok, true, JSON.stringify(rollback.diagnostics));
    assert.equal(rollback.status, 'rolled-back');
  } finally {
    cleanup(root);
  }
});

test('a runtime reference without a dev field still registers and is not reported as replaced', async () => {
  const fixture = referenceFixture();
  try {
    const first = await beginRuntimeReference(fixture.root, fixture.runtime);
    assert.equal(first.ok, true, JSON.stringify(first));
    if (!first.ok) return;
    assert.equal((await first.value.release()).ok, true);
    const directory = runtimeReferencesDirectory(fixture.dataDir);
    const referencePath = join(directory, readdirSync(directory)[0]!);
    const reference = JSON.parse(readFileSync(referencePath, 'utf8')) as {
      rootIdentity: { dev?: number };
    };
    deleteDev(reference.rootIdentity);
    writeFileSync(referencePath, `${JSON.stringify(reference, null, 2)}\n`);
    const inspected = await inspectRuntimeReferences(fixture.dataDir, version);
    assert.equal(
      inspected.unknown.some(
        (entry) =>
          entry.startsWith('workspace_missing_or_replaced') ||
          entry.startsWith('workspace_identity_unknown'),
      ),
      false,
    );
    const repeated = await beginRuntimeReference(fixture.root, fixture.runtime);
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    if (repeated.ok) assert.equal((await repeated.value.release()).ok, true);
    const after = JSON.parse(readFileSync(referencePath, 'utf8')) as {
      rootIdentity: { dev?: number };
    };
    assert.equal(after.rootIdentity.dev, undefined);
  } finally {
    cleanup(fixture.temp);
  }
});

test('an archive receipt without a dev field still resumes', async () => {
  const fixture = archiveFixture(deleteDev);
  try {
    const archived = await archiveRuntime({
      version,
      dataDir: fixture.dataDir,
      apply: true,
      forceUnknownReferences: true,
      reason: 'Resume interrupted archive',
    });
    assert.equal(archived.ok, true, JSON.stringify(archived));
    assert.equal(archived.status, 'archived');
    assert.equal(existsSync(fixture.paths.runtimeRoot), false);
  } finally {
    cleanup(fixture.temp);
  }
});

test('a reset journal without a dev field still resumes through its schema', async () => {
  const root = realpathSync(makeTempDir('persisted-identity-reset'));
  try {
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    const local = join(root, '.pappra', 'local');
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, 'evidence.txt'), 'local state\n');
    const archiveRoot = join(root, '.pappra', 'local-archive');
    mkdirSync(archiveRoot, { recursive: true });
    const id = randomUUID();
    const archive = join(archiveRoot, id);
    const localStats = statSync(local);
    writeFileSync(
      join(archiveRoot, 'pending-reset.json'),
      `${JSON.stringify(
        {
          schema: 'pappra/local-reset/1',
          id,
          root,
          archive,
          source: { ino: localStats.ino },
          fresh: null,
          status: 'prepared',
          createdAt: now,
          allWritersStopped: true,
          ownership: 'operator-assertion-and-bounded-live-owner-checks',
        },
        null,
        2,
      )}\n`,
    );
    assert.equal(await inspectLocalResetState(root), 'pending');
    const result = await resetLocalState(root, {
      apply: true,
      allWritersStopped: true,
      assertNoLiveLocks: async () => undefined,
    });
    assert.equal(result.status, 'reset');
    assert.equal(result.resumed, true);
    assert.equal(result.archive, archive);
    assert.equal(existsSync(join(archive, 'evidence.txt')), true);
    assert.equal(await inspectLocalResetState(root), 'complete');
    assert.equal(
      readdirSync(archiveRoot).some((name) =>
        name.startsWith('unreadable-reset-'),
      ),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('interrupted rollback still refuses an identity present on only one side', async () => {
  const root = realpathSync(makeTempDir('persisted-identity-repair-pair'));
  try {
    const bytes = Buffer.from('{"interrupted":true}\n');
    const target = join(root, '.pappra', 'workspace.json');
    writeText(target, bytes.toString('utf8'));
    const observation = await observePath(target);
    assert(observation.stats !== null);
    const manifestRef = workspaceInstallPaths(root).manifestPath;
    const sourceId = randomUUID();
    const rollbackId = randomUUID();
    const digest = sha256Digest(bytes);
    const entries = (identity: PersistedIdentity | null) => [
      {
        path: '.pappra/workspace.json',
        status:
          identity === null ? ('residual' as const) : ('created' as const),
        digest,
        identity,
        backupRef: null,
        backupDigest: null,
        detail: null,
      },
    ];
    const written = await Promise.all([
      writeInstallJournal(journalPath(root, sourceId), {
        schema: 'pappra/install-journal/1',
        installId: sourceId,
        operation: 'apply-workspace-files',
        target: 'interrupted-plan',
        workspaceRoot: root,
        runtimeVersion: null,
        status: 'rolled-back',
        createdAt: now,
        updatedAt: now,
        steps: [],
        entries: entries({
          dev: observation.stats.dev,
          ino: observation.stats.ino,
        }),
        residuals: [],
        manifestRef,
      }),
      writeInstallJournal(journalPath(root, rollbackId), {
        schema: 'pappra/install-journal/1',
        installId: rollbackId,
        operation: 'rollback-workspace-files',
        target: sourceId,
        workspaceRoot: root,
        runtimeVersion: null,
        status: 'applying',
        createdAt: now,
        updatedAt: now,
        steps: [],
        entries: entries(null),
        residuals: [],
        manifestRef,
      }),
    ]);
    assert(written.every((result) => result.ok));
    const repaired = await repairInstall({
      root,
      apply: true,
      installId: rollbackId,
    });
    assert.equal(repaired.ok, false);
    assert.equal(
      repaired.errors.some((error) =>
        error.includes('Interrupted rollback entries do not match'),
      ),
      true,
      repaired.errors.join('; '),
    );
    assert.equal(existsSync(target), true);
  } finally {
    cleanup(root);
  }
});
