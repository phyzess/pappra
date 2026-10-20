import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runDoctor } from '../../src/app/doctor.js';
import { applyInitPlan, planWorkspaceInit } from '../../src/app/init.js';
import {
  acquireInstallLock,
  readInstallJournal,
  readWorkspaceManifest,
  releaseInstallLock,
  workspaceInstallPaths,
  writeInstallJournal,
  writeWorkspaceManifest,
} from '../../src/install/ownership.js';
import { installRuntime, runtimePaths } from '../../src/install/runtime.js';
import type {
  InstallJournal,
  ManagedFileEntry,
} from '../../src/schemas/install.js';
import { sha256Digest } from '../../src/infra/fs.js';
import {
  doctorReportSchema,
  type DoctorReport,
} from '../../src/schemas/doctor.js';
import { baseInitChoices } from '../init/fixtures.js';
import { createRuntimeTarball } from '../install/fixtures.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  snapshotTree,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

const version = '9.8.7';

function isolated(): {
  readonly root: string;
  readonly home: string;
  readonly data: string;
  readonly bin: string;
} {
  return {
    root: makeTempDir('doctor-root'),
    home: makeTempDir('doctor-home'),
    data: makeTempDir('doctor-data'),
    bin: makeTempDir('doctor-bin'),
  };
}

function workspaceConfig(
  root: string,
  overrides: Record<string, unknown> = {},
) {
  writeWorkspaceConfig(
    root,
    baseWorkspaceConfig({
      runtimeVersion: version,
      repositories: [{ id: 'app', path: '.', access: 'write' }],
      knowledge: {
        sources: ['README.md'],
        newDocuments: '.pappra/knowledge',
        taskVisibility: 'private',
      },
      code: { graph: 'none', symbols: 'none', prepare: 'manual' },
      ...overrides,
    }),
  );
}

function createWorkspace(
  root: string,
  overrides: Record<string, unknown> = {},
  hosts: readonly ('pi' | 'codex' | 'claude')[] = [],
) {
  createRepository(root);
  writeText(join(root, 'README.md'), '# readme\n');
  workspaceConfig(root, overrides);
  writeMachineConfig(root, baseMachineConfig(root, { selectedHosts: hosts }));
}

async function installFor(
  temp: string,
  dataDir: string,
  runtimeVersion = version,
) {
  const tarball = createRuntimeTarball(temp, { version: runtimeVersion });
  const result = await installRuntime({
    version: runtimeVersion,
    source: { kind: 'tarball', path: tarball },
    dataDir,
    offline: true,
    timeoutMs: 60_000,
  });
  assert.equal(result.ok, true, result.diagnostics[0]?.message);
  assert(result.manifest !== null);
  return result.manifest;
}

async function applyBasicWorkspace(root: string): Promise<void> {
  const prepared = await planWorkspaceInit({
    root,
    choices: baseInitChoices({ repositories: [], hosts: [] }),
  });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const applied = await applyInitPlan(prepared.bundle);
  assert.equal(applied.ok, true);
}

function check(report: DoctorReport, id: string) {
  const found = report.checks.find((entry) => entry.id === id);
  assert(found !== undefined, `missing check ${id}`);
  return found;
}

test('reports an uninitialized workspace without writing anything', async () => {
  const fixture = isolated();
  try {
    const before = snapshotTree(fixture.root);
    const homeBefore = snapshotTree(fixture.home);
    const dataBefore = snapshotTree(fixture.data);
    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(report.schema, 'pappra/doctor-report/1');
    assert.equal(doctorReportSchema.safeParse(report).success, true);
    assert.equal(report.workspace.state, 'missing');
    assert.equal(check(report, 'workspace.root').status, 'warning');
    assert.equal(report.summary.exitCode, 1);
    assert.deepEqual(snapshotTree(fixture.root), before);
    assert.deepEqual(snapshotTree(fixture.home), homeBefore);
    assert.deepEqual(snapshotTree(fixture.data), dataBefore);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('checks a valid workspace, missing runtime, and unverified validation candidates', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture.root);
    const before = snapshotTree(fixture.root);
    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(check(report, 'workspace.config').status, 'ok');
    assert.equal(check(report, 'workspace.machine').status, 'ok');
    assert.equal(check(report, 'workspace.repositories').status, 'ok');
    assert.equal(check(report, 'workspace.knowledge').status, 'ok');
    assert.equal(check(report, 'workspace.validation').status, 'ok');
    assert.equal(check(report, 'runtime.state').status, 'warning');
    assert.equal(check(report, 'runtime.state').code, 'doctor_runtime_missing');
    assert.equal(check(report, 'host.integration').status, 'unsupported');
    assert.equal(report.summary.exitCode, 1);
    assert.deepEqual(snapshotTree(fixture.root), before);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports passive runtime content match without claiming current callability', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture.root);
    const manifest = await installFor(fixture.root, fixture.data);
    writeMachineConfig(
      fixture.root,
      baseMachineConfig(fixture.root, {
        selectedHosts: [],
        runtime: {
          version: manifest.runtimeVersion,
          executable: manifest.executable,
          verifiedAt: manifest.verifiedAt,
        },
      }),
    );
    const before = snapshotTree(fixture.root);
    const dataBefore = snapshotTree(fixture.data);
    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(report.runtime.passiveStatus, 'content-match');
    const runtime = check(report, 'runtime.state');
    assert.equal(runtime.status, 'partial');
    assert.equal(runtime.code, 'doctor_runtime_unverified');
    assert.equal(check(report, 'runtime.references').status, 'unknown');
    assert(
      check(report, 'runtime.references').nextActions.some((action) =>
        action.includes('Do not remove runtime'),
      ),
    );
    assert.equal(report.summary.exitCode, 1);
    assert.deepEqual(snapshotTree(fixture.root), before);
    assert.deepEqual(snapshotTree(fixture.data), dataBefore);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports corrupted runtime content without repairing it', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture.root);
    const manifest = await installFor(fixture.root, fixture.data);
    writeMachineConfig(
      fixture.root,
      baseMachineConfig(fixture.root, {
        selectedHosts: [],
        runtime: {
          version: manifest.runtimeVersion,
          executable: manifest.executable,
          verifiedAt: manifest.verifiedAt,
        },
      }),
    );
    const executablePath = manifest.executable;
    writeFileSync(executablePath, 'changed executable\n');
    const before = snapshotTree(fixture.data);
    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(report.runtime.passiveStatus, 'corrupt');
    assert.equal(check(report, 'runtime.state').status, 'error');
    assert.equal(report.summary.status, 'blocked');
    assert.deepEqual(snapshotTree(fixture.data), before);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports runtime locks and incomplete journals without clearing them', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture.root);
    const manifest = await installFor(fixture.root, fixture.data);
    writeMachineConfig(
      fixture.root,
      baseMachineConfig(fixture.root, {
        selectedHosts: [],
        runtime: {
          version: manifest.runtimeVersion,
          executable: manifest.executable,
          verifiedAt: manifest.verifiedAt,
        },
      }),
    );
    const paths = runtimePaths(version, fixture.data);
    const lock = await acquireInstallLock(
      paths.lockPath,
      'install-runtime',
      paths.runtimeRoot,
      fixture.data,
    );
    assert.equal(lock.ok, true);
    let report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(report.runtime.passiveStatus, 'locked');
    assert.equal(check(report, 'runtime.state').code, 'doctor_runtime_locked');
    assert.equal(existsSync(paths.lockPath), true);

    assert(lock.lock !== null);
    await releaseInstallLock(lock.path, lock.lock.token);
    const journalId = '77777777-7777-4777-8777-777777777777';
    const journal: InstallJournal = {
      schema: 'pappra/install-journal/1',
      installId: journalId,
      operation: 'install-runtime',
      target: paths.runtimeRoot,
      workspaceRoot: null,
      runtimeVersion: version,
      status: 'applying',
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
      steps: [],
      entries: [],
      residuals: [],
      manifestRef: join(paths.runtimeRoot, 'install-manifest.json'),
    };
    const runtimeJournalPath = join(
      fixture.data,
      'journals',
      `${journalId}.json`,
    );
    const written = await writeInstallJournal(runtimeJournalPath, journal);
    assert.equal(written.ok, true);
    report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(report.runtime.passiveStatus, 'partial');
    assert.equal(check(report, 'runtime.state').code, 'doctor_runtime_partial');
    assert.equal(
      (await readInstallJournal(runtimeJournalPath)).value?.status,
      'applying',
    );
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports corrupted and incompatible configuration without migration', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture.root);
    writeText(join(fixture.root, '.pappra', 'workspace.json'), '{broken');
    const before = snapshotTree(fixture.root);
    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(check(report, 'workspace.config').status, 'error');
    assert.equal(report.summary.status, 'blocked');
    assert.deepEqual(snapshotTree(fixture.root), before);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports host and tool discovery without executing fixtures', async () => {
  const fixture = isolated();
  try {
    createWorkspace(
      fixture.root,
      { code: { graph: 'codegraph', symbols: 'none', prepare: 'manual' } },
      ['codex'],
    );
    mkdirSync(join(fixture.home, '.codex'), { recursive: true });
    writeText(
      join(fixture.home, '.codex', 'config.toml'),
      'model = "fixture"\n',
    );
    const marker = join(fixture.root, 'host-executed');
    const script = join(fixture.bin, 'codex');
    writeFileSync(
      script,
      `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 0\n`,
    );
    chmodSync(script, 0o755);
    const before = snapshotTree(fixture.root);
    const homeBefore = snapshotTree(fixture.home);
    const dataBefore = snapshotTree(fixture.data);
    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    const host = check(report, 'host.codex');
    assert.equal(host.status, 'unsupported');
    assert(host.evidence.some((entry) => entry.ref === script));
    assert(host.evidence.some((entry) => entry.ref.endsWith('config.toml')));
    const tool = check(report, 'tool.codegraph');
    assert.equal(tool.status, 'warning');
    assert.equal(tool.code, 'doctor_tool_preference_unavailable');
    assert.equal(existsSync(marker), false);
    assert.deepEqual(snapshotTree(fixture.root), before);
    assert.deepEqual(snapshotTree(fixture.home), homeBefore);
    assert.deepEqual(snapshotTree(fixture.data), dataBefore);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports missing selected hosts and unavailable tools', async () => {
  const fixture = isolated();
  try {
    createWorkspace(
      fixture.root,
      { code: { graph: 'none', symbols: 'serena', prepare: 'manual' } },
      ['claude'],
    );
    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(check(report, 'host.claude').code, 'doctor_host_missing');
    assert.equal(check(report, 'host.claude').status, 'warning');
    assert.equal(
      check(report, 'tool.serena').code,
      'doctor_tool_preference_unavailable',
    );
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports managed install ownership and modified files', async () => {
  const fixture = isolated();
  try {
    const prepared = await planWorkspaceInit({
      root: fixture.root,
      choices: baseInitChoices({ repositories: [], hosts: [] }),
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal((await applyInitPlan(prepared.bundle)).ok, true);
    let report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(check(report, 'install.workspace').status, 'ok');
    assert.equal(check(report, 'install.workspace').code, 'doctor_install_ok');

    writeText(
      join(fixture.root, '.pappra', 'workspace.json'),
      '{"user":true}\n',
    );
    report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(check(report, 'install.workspace').status, 'warning');
    assert(check(report, 'install.workspace').summary.includes('changed'));
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports old journal records missing newly required fields as incompatible', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture.root);
    mkdirSync(join(fixture.root, '.pappra', 'local', 'journals'), {
      recursive: true,
    });
    const journalId = '88888888-8888-4888-8888-888888888888';
    writeFileSync(
      join(fixture.root, '.pappra', 'local', 'journals', `${journalId}.json`),
      JSON.stringify({
        schema: 'pappra/install-journal/1',
        installId: journalId,
        operation: 'apply-workspace-files',
        target: 'old',
        workspaceRoot: fixture.root,
        runtimeVersion: null,
        status: 'verified',
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
        steps: [],
        entries: [
          {
            path: '.pappra/workspace.json',
            status: 'verified',
            digest: `sha256:${'a'.repeat(64)}`,
            identity: { dev: 1, ino: 1 },
            detail: null,
          },
        ],
        residuals: [],
        manifestRef: null,
      }),
    );
    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(check(report, 'install.workspace').status, 'error');
    assert.equal(
      check(report, 'install.workspace').code,
      'doctor_install_state_invalid',
    );
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports nested boundaries and symlinks without leaving the workspace scope', async () => {
  const fixture = isolated();
  const outside = makeTempDir('doctor-nested-outside');
  try {
    writeWorkspaceConfig(
      fixture.root,
      baseWorkspaceConfig({ runtimeVersion: version }),
    );
    writeMachineConfig(fixture.root, baseMachineConfig(fixture.root));
    mkdirSync(join(fixture.root, 'nested', '.pappra'), { recursive: true });
    writeText(join(outside, 'outside.txt'), 'outside\n');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(outside, join(fixture.root, 'linked-outside'), 'dir');
    const outsideBefore = snapshotTree(outside);
    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    const repositories = check(report, 'workspace.repositories');
    assert.equal(repositories.status, 'warning');
    assert(repositories.summary.includes('Nested workspace boundaries'));
    assert.deepEqual(snapshotTree(outside), outsideBefore);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
    cleanup(outside);
  }
});

test('reports a missing explicit external repository mapping', async () => {
  const fixture = isolated();
  try {
    writeWorkspaceConfig(
      fixture.root,
      baseWorkspaceConfig({
        runtimeVersion: version,
        repositories: [
          { id: 'dependency', path: 'external:dependency', access: 'read' },
        ],
      }),
    );
    writeMachineConfig(
      fixture.root,
      baseMachineConfig(fixture.root, { externalRepositories: [] }),
    );
    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(check(report, 'workspace.repositories').status, 'error');
    assert.equal(report.summary.status, 'blocked');
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports a machine runtime version that differs from the workspace target', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture.root);
    const manifest = await installFor(fixture.root, fixture.data, '9.8.8');
    writeMachineConfig(
      fixture.root,
      baseMachineConfig(fixture.root, {
        selectedHosts: [],
        runtime: {
          version: manifest.runtimeVersion,
          executable: manifest.executable,
          verifiedAt: manifest.verifiedAt,
        },
      }),
    );
    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(check(report, 'runtime.state').status, 'error');
    assert.equal(
      check(report, 'runtime.state').code,
      'doctor_runtime_mismatch',
    );
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('does not open a FIFO backup while checking managed ownership', async () => {
  if (process.platform === 'win32') return;
  const fixture = isolated();
  try {
    await applyBasicWorkspace(fixture.root);
    writeText(join(fixture.root, 'README.md'), '# readme\n');
    const readme = join(fixture.root, 'README.md');
    const stats = statSync(readme);
    const bytes = readFileSync(readme);
    const paths = workspaceInstallPaths(fixture.root);
    const read = await readWorkspaceManifest(fixture.root);
    assert(read.value !== null);
    const backupRef = '.pappra/local/backups/manual/readme.bak';
    const backup = join(fixture.root, ...backupRef.split('/'));
    mkdirSync(dirname(backup), { recursive: true });
    execFileSync('mkfifo', [backup]);
    const entry: ManagedFileEntry = {
      path: 'README.md',
      installId: randomUUID(),
      operation: 'create',
      beforeDigest: null,
      afterDigest: sha256Digest(bytes),
      backupRef,
      backupDigest: null,
      identity: { dev: stats.dev, ino: stats.ino },
      owner: 'pappra',
      verifiedAt: new Date().toISOString(),
    };
    const written = await writeWorkspaceManifest(fixture.root, {
      ...read.value,
      entries: [...read.value.entries, entry],
    });
    assert.equal(written.ok, true);

    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    const install = check(report, 'install.workspace');
    assert.equal(install.status, 'warning');
    assert(install.summary.includes('file_not_regular'));
    assert.equal(doctorReportSchema.safeParse(report).success, true);
    assert.equal(paths.backupsDir.endsWith('backups'), true);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports an unreadable workspace journal directory instead of treating it as empty', async () => {
  const fixture = isolated();
  try {
    await applyBasicWorkspace(fixture.root);
    const paths = workspaceInstallPaths(fixture.root);
    rmSync(paths.journalsDir, { recursive: true, force: true });
    writeFileSync(paths.journalsDir, 'not a directory\n');

    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    const install = check(report, 'install.workspace');
    assert.equal(install.status, 'error');
    assert(install.summary.includes('not a directory'));
    assert.equal(doctorReportSchema.safeParse(report).success, true);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('bounds workspace journal evidence and actions without invalidating the report', async () => {
  const fixture = isolated();
  try {
    await applyBasicWorkspace(fixture.root);
    const paths = workspaceInstallPaths(fixture.root);
    for (let index = 0; index < 33; index += 1) {
      const installId = randomUUID();
      const journal: InstallJournal = {
        schema: 'pappra/install-journal/1',
        installId,
        operation: 'apply-workspace-files',
        target: fixture.root,
        workspaceRoot: fixture.root,
        runtimeVersion: null,
        status: 'verified',
        createdAt: '2026-10-17T00:00:00.000Z',
        updatedAt: '2026-10-17T00:00:00.000Z',
        steps: [],
        entries: [],
        residuals: [],
        manifestRef: null,
      };
      const written = await writeInstallJournal(
        join(paths.journalsDir, `${installId}.json`),
        journal,
      );
      assert.equal(written.ok, true);
    }

    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(doctorReportSchema.safeParse(report).success, true);
    const install = check(report, 'install.workspace');
    assert(install.evidence.length <= 32);
    assert(install.nextActions.length <= 16);
    assert(install.coverage?.includes('truncated') ?? false);
    assert(install.summary.includes('journal candidates observed'));
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports target-version install state when machine.json is not bound', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture.root);
    const paths = runtimePaths(version, fixture.data);
    const installId = randomUUID();
    const journal: InstallJournal = {
      schema: 'pappra/install-journal/1',
      installId,
      operation: 'install-runtime',
      target: paths.runtimeRoot,
      workspaceRoot: null,
      runtimeVersion: version,
      status: 'applying',
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
      steps: [],
      entries: [],
      residuals: [],
      manifestRef: join(paths.runtimeRoot, 'install-manifest.json'),
    };
    const written = await writeInstallJournal(
      join(fixture.data, 'journals', `${installId}.json`),
      journal,
    );
    assert.equal(written.ok, true);

    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    assert.equal(report.runtime.passiveStatus, 'partial');
    assert.equal(check(report, 'runtime.state').status, 'partial');
    assert.equal(check(report, 'runtime.state').code, 'doctor_runtime_partial');
    assert.equal(doctorReportSchema.safeParse(report).success, true);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('does not read a backup symlink that escapes the workspace', async () => {
  if (process.platform === 'win32') return;
  const fixture = isolated();
  const outside = makeTempDir('doctor-backup-outside');
  try {
    await applyBasicWorkspace(fixture.root);
    writeText(join(fixture.root, 'README.md'), '# readme\n');
    writeText(join(outside, 'backup.bak'), 'external\n');
    const readme = join(fixture.root, 'README.md');
    const stats = statSync(readme);
    const bytes = readFileSync(readme);
    const read = await readWorkspaceManifest(fixture.root);
    assert(read.value !== null);
    const backupRef = '.pappra/local/backups/manual/readme.bak';
    const backup = join(fixture.root, ...backupRef.split('/'));
    mkdirSync(dirname(backup), { recursive: true });
    symlinkSync(join(outside, 'backup.bak'), backup, 'file');
    const entry: ManagedFileEntry = {
      path: 'README.md',
      installId: randomUUID(),
      operation: 'create',
      beforeDigest: null,
      afterDigest: sha256Digest(bytes),
      backupRef,
      backupDigest: sha256Digest(Buffer.from('external\n')),
      identity: { dev: stats.dev, ino: stats.ino },
      owner: 'pappra',
      verifiedAt: new Date().toISOString(),
    };
    const written = await writeWorkspaceManifest(fixture.root, {
      ...read.value,
      entries: [...read.value.entries, entry],
    });
    assert.equal(written.ok, true);

    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    const install = check(report, 'install.workspace');
    assert.equal(install.status, 'warning');
    assert(install.summary.includes('backup path is unsafe'));
    assert.equal(doctorReportSchema.safeParse(report).success, true);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
    cleanup(outside);
  }
});

test('reports non-regular workspace journal candidates without reading them', async () => {
  const fixture = isolated();
  try {
    await applyBasicWorkspace(fixture.root);
    const paths = workspaceInstallPaths(fixture.root);
    symlinkSync(
      join(paths.journalsDir, 'missing-target'),
      join(paths.journalsDir, 'broken.json'),
      'file',
    );
    mkdirSync(join(paths.journalsDir, 'directory.json'));
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [join(paths.journalsDir, 'fifo.json')]);
    }
    const before = snapshotTree(fixture.root);

    const report = await runDoctor({
      root: fixture.root,
      dataDir: fixture.data,
      homeDir: fixture.home,
      pathEnv: fixture.bin,
    });
    const install = check(report, 'install.workspace');
    assert.equal(install.status, 'error');
    assert(install.summary.includes('not a regular file'));
    assert(install.summary.includes('broken.json'));
    assert.equal(report.summary.exitCode, 1);
    assert.equal(doctorReportSchema.safeParse(report).success, true);
    assert.deepEqual(snapshotTree(fixture.root), before);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});
