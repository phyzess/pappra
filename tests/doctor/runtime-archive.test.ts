import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runDoctor } from '../../src/app/doctor.js';
import { archiveRuntime } from '../../src/install/runtime-archive.js';
import { runtimeArchiveDirectory } from '../../src/install/runtime-archive-state.js';
import { installRuntime } from '../../src/install/runtime.js';
import { captureProcessIdentity } from '../../src/infra/process-identity.js';
import {
  doctorReportSchema,
  type DoctorReport,
} from '../../src/schemas/doctor.js';
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

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly data: string;
  readonly bin: string;
}

function isolated(): Fixture {
  return {
    root: makeTempDir('doctor-archive-root'),
    home: makeTempDir('doctor-archive-home'),
    data: realpathSync(makeTempDir('doctor-archive-data')),
    bin: makeTempDir('doctor-archive-bin'),
  };
}

function createWorkspace(fixture: Fixture): void {
  createRepository(fixture.root);
  writeText(join(fixture.root, 'README.md'), '# readme\n');
  writeWorkspaceConfig(
    fixture.root,
    baseWorkspaceConfig({
      runtimeVersion: version,
      repositories: [{ id: 'app', path: '.', access: 'write' }],
      knowledge: {
        sources: ['README.md'],
        newDocuments: '.pappra/knowledge',
        taskVisibility: 'private',
      },
      code: { graph: 'none', symbols: 'none', prepare: 'manual' },
    }),
  );
  writeMachineConfig(
    fixture.root,
    baseMachineConfig(fixture.root, { selectedHosts: [] }),
  );
}

async function installAndBind(fixture: Fixture): Promise<void> {
  const pack = makeTempDir('doctor-archive-pack');
  try {
    const tarball = createRuntimeTarball(pack, { version });
    const installed = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir: fixture.data,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(installed.ok, true, installed.diagnostics[0]?.message);
    assert(installed.manifest !== null);
    const manifest = installed.manifest;
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
  } finally {
    cleanup(pack);
  }
}

function doctor(fixture: Fixture): Promise<DoctorReport> {
  return runDoctor({
    root: fixture.root,
    dataDir: fixture.data,
    homeDir: fixture.home,
    pathEnv: fixture.bin,
  });
}

function check(report: DoctorReport, id: string) {
  const found = report.checks.find((entry) => entry.id === id);
  assert(found !== undefined, `missing check ${id}`);
  return found;
}

async function interruptArchive(
  dataDir: string,
  phase: string,
  allWritersStopped = false,
): Promise<void> {
  const result = await archiveRuntime({
    version,
    dataDir,
    apply: true,
    forceUnknownReferences: true,
    allWritersStopped,
    reason: 'Doctor fixture archive interruption',
    checkpoint: (actual) => {
      if (actual === phase)
        throw new Error(`fixture interruption at ${actual}`);
    },
  });
  assert.equal(result.status, 'failed');
}

function archiveControl(dataDir: string): string {
  return runtimeArchiveDirectory(realpathSync(dataDir), version);
}

function readPending(control: string): {
  status: string;
  items: { source: string; destination: string }[];
} {
  return JSON.parse(readFileSync(join(control, 'pending.json'), 'utf8')) as {
    status: string;
    items: { source: string; destination: string }[];
  };
}

test('reports a normal runtime without inventing an archive transaction', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture);
    await installAndBind(fixture);
    const dataBefore = snapshotTree(fixture.data);
    const rootBefore = snapshotTree(fixture.root);
    const report = await doctor(fixture);
    assert.equal(doctorReportSchema.safeParse(report).success, true);
    const archive = check(report, 'runtime.archive');
    assert.equal(archive.status, 'ok');
    assert.equal(archive.code, 'doctor_runtime_archive_ok');
    assert.match(archive.summary, /No runtime archive transaction/);
    assert.equal(
      existsSync(join(fixture.data, 'runtime-archives', version)),
      false,
    );
    assert.deepEqual(snapshotTree(fixture.data), dataBefore);
    assert.deepEqual(snapshotTree(fixture.root), rootBefore);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports an interrupted archive with an executable resume action', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture);
    await installAndBind(fixture);
    await interruptArchive(fixture.data, 'moved:runtime');
    const control = archiveControl(fixture.data);
    const pendingPath = join(control, 'pending.json');
    const pendingBefore = readFileSync(pendingPath, 'utf8');
    const pending = readPending(control);
    assert.equal(pending.status, 'prepared');
    assert(pending.items.length >= 2);
    assert.equal(existsSync(join(fixture.data, 'runtimes', version)), false);
    const dataBefore = snapshotTree(fixture.data);
    const report = await doctor(fixture);
    const archive = check(report, 'runtime.archive');
    assert.equal(archive.status, 'warning');
    assert.equal(archive.code, 'doctor_runtime_archive_interrupted');
    assert.match(archive.summary, /interrupted/);
    assert.match(archive.summary, /archived/);
    const resume = archive.nextActions.find((action) =>
      action.startsWith('pappra runtime archive'),
    );
    assert(resume !== undefined);
    assert.match(resume, /--runtime-version 9\.8\.7/);
    assert.match(resume, /--apply/);
    assert.match(resume, /--force/);
    assert.match(resume, /--reason/);
    assert.doesNotMatch(resume, /--all-writers-stopped/);
    assert.notEqual(report.summary.status, 'ok');
    assert.equal(report.summary.exitCode, 1);
    assert.equal(readFileSync(pendingPath, 'utf8'), pendingBefore);
    assert.deepEqual(snapshotTree(fixture.data), dataBefore);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('preserves an unknown runtime lock and recommends the stopped-writers resume', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture);
    await installAndBind(fixture);
    const locks = join(fixture.data, 'runtimes', '.locks');
    mkdirSync(locks, { recursive: true });
    const lockPath = join(locks, `${version}.lock`);
    const unknown = 'legacy unknown runtime lock\n';
    writeFileSync(lockPath, unknown);
    await interruptArchive(fixture.data, 'moved:runtime', true);
    const dataBefore = snapshotTree(fixture.data);
    const report = await doctor(fixture);
    const archive = check(report, 'runtime.archive');
    assert.equal(archive.status, 'warning');
    assert.equal(archive.code, 'doctor_runtime_archive_interrupted');
    assert.match(archive.summary, /stopped-writers/);
    const resume = archive.nextActions.find((action) =>
      action.startsWith('pappra runtime archive'),
    );
    assert(resume !== undefined);
    assert.match(resume, /--all-writers-stopped/);
    assert(
      archive.nextActions.some((action) =>
        action.includes('Stop every affected writer yourself'),
      ),
    );
    assert.notEqual(report.summary.status, 'ok');
    assert.equal(readFileSync(lockPath, 'utf8'), unknown);
    assert.deepEqual(snapshotTree(fixture.data), dataBefore);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports a verified live archive coordinator as in progress', async (t) => {
  const fixture = isolated();
  try {
    createWorkspace(fixture);
    await installAndBind(fixture);
    await interruptArchive(fixture.data, 'prepared');
    const identity = captureProcessIdentity();
    if (identity === null) {
      t.diagnostic('OS process identity is unavailable in this environment.');
      return;
    }
    const control = archiveControl(fixture.data);
    const lockPath = join(control, 'archive.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({
        token: randomUUID(),
        pid: process.pid,
        process_identity: identity,
      }),
    );
    const lockBefore = readFileSync(lockPath, 'utf8');
    const dataBefore = snapshotTree(fixture.data);
    const report = await doctor(fixture);
    const archive = check(report, 'runtime.archive');
    assert.equal(archive.status, 'partial');
    assert.equal(archive.code, 'doctor_runtime_archive_in_progress');
    assert.match(archive.summary, /in progress/);
    assert(
      archive.nextActions.some((action) =>
        action.includes('Wait for the verified live archive coordinator'),
      ),
    );
    assert.equal(
      archive.nextActions.some((action) =>
        action.startsWith('pappra runtime archive'),
      ),
      false,
    );
    assert.notEqual(report.summary.status, 'ok');
    assert.equal(readFileSync(lockPath, 'utf8'), lockBefore);
    assert.deepEqual(snapshotTree(fixture.data), dataBefore);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports an unknown archive lock instead of an all-clear', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture);
    await installAndBind(fixture);
    await interruptArchive(fixture.data, 'prepared');
    const control = archiveControl(fixture.data);
    const lockPath = join(control, 'archive.lock');
    const unknown = 'legacy unknown archive owner\n';
    writeFileSync(lockPath, unknown);
    const dataBefore = snapshotTree(fixture.data);
    const report = await doctor(fixture);
    const archive = check(report, 'runtime.archive');
    assert.equal(archive.status, 'warning');
    assert.equal(archive.code, 'doctor_runtime_archive_unknown');
    assert.match(archive.summary, /unverified/);
    assert.equal(
      archive.nextActions.some((action) =>
        action.startsWith('pappra runtime archive'),
      ),
      false,
    );
    assert.notEqual(report.summary.status, 'ok');
    assert.equal(readFileSync(lockPath, 'utf8'), unknown);
    assert.deepEqual(snapshotTree(fixture.data), dataBefore);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports an unreadable pending receipt as a blocking corrupt state', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture);
    await installAndBind(fixture);
    await interruptArchive(fixture.data, 'prepared');
    const control = archiveControl(fixture.data);
    const pendingPath = join(control, 'pending.json');
    const corrupt = '{ not a receipt';
    writeFileSync(pendingPath, corrupt);
    const dataBefore = snapshotTree(fixture.data);
    const report = await doctor(fixture);
    const archive = check(report, 'runtime.archive');
    assert.equal(archive.status, 'error');
    assert.equal(archive.code, 'doctor_runtime_archive_corrupt');
    assert.equal(report.summary.status, 'blocked');
    assert.equal(report.summary.exitCode, 1);
    assert.equal(readFileSync(pendingPath, 'utf8'), corrupt);
    assert.deepEqual(snapshotTree(fixture.data), dataBefore);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('refuses a receipt move outside the archive namespace', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture);
    await installAndBind(fixture);
    const control = archiveControl(fixture.data);
    const pendingPath = join(control, 'pending.json');
    mkdirSync(control, { recursive: true, mode: 0o700 });
    writeFileSync(
      pendingPath,
      `${JSON.stringify({
        schema: 'pappra/runtime-archive/1',
        id: randomUUID(),
        version,
        dataDir: realpathSync(fixture.data),
        status: 'prepared',
        createdAt: '2026-10-25T00:00:00.000Z',
        completedAt: null,
        reason: 'Tampered fixture receipt',
        forceUnknownReferences: true,
        allWritersStopped: false,
        references: null,
        lock: null,
        installIds: [],
        items: [
          {
            source: join(fixture.root, 'outside-data'),
            destination: 'runtime',
            identity: {
              dev: 1,
              ino: 1,
              kind: 'directory',
              size: 0,
              mtimeMs: 0,
              digest: null,
            },
          },
        ],
      })}\n`,
    );
    const pendingBefore = readFileSync(pendingPath, 'utf8');
    const dataBefore = snapshotTree(fixture.data);
    const report = await doctor(fixture);
    const archive = check(report, 'runtime.archive');
    assert.equal(archive.status, 'error');
    assert.equal(archive.code, 'doctor_runtime_archive_corrupt');
    assert.match(archive.summary, /unsafe or duplicate move/);
    assert.equal(report.summary.status, 'blocked');
    assert.equal(readFileSync(pendingPath, 'utf8'), pendingBefore);
    assert.deepEqual(snapshotTree(fixture.data), dataBefore);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports archive evidence missing from both pinned locations as corrupt', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture);
    await installAndBind(fixture);
    await interruptArchive(fixture.data, 'moved:runtime');
    const control = archiveControl(fixture.data);
    const pending = readPending(control);
    const remaining = pending.items.find((item) => existsSync(item.source));
    assert(remaining !== undefined);
    assert.notEqual(remaining.source, join(fixture.data, 'runtimes', version));
    rmSync(remaining.source);
    const dataBefore = snapshotTree(fixture.data);
    const report = await doctor(fixture);
    const archive = check(report, 'runtime.archive');
    assert.equal(archive.status, 'error');
    assert.equal(archive.code, 'doctor_runtime_archive_corrupt');
    assert.match(archive.summary, /missing or duplicated/);
    assert.equal(report.summary.status, 'blocked');
    assert.deepEqual(snapshotTree(fixture.data), dataBefore);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});

test('reports a completed archive as complete, not interrupted', async () => {
  const fixture = isolated();
  try {
    createWorkspace(fixture);
    await installAndBind(fixture);
    const archived = await archiveRuntime({
      version,
      dataDir: fixture.data,
      apply: true,
      forceUnknownReferences: true,
      reason: 'Doctor fixture completed archive',
    });
    assert.equal(archived.status, 'archived');
    const control = archiveControl(fixture.data);
    assert.equal(readPending(control).status, 'complete');
    const dataBefore = snapshotTree(fixture.data);
    const report = await doctor(fixture);
    const archive = check(report, 'runtime.archive');
    assert.equal(archive.status, 'ok');
    assert.equal(archive.code, 'doctor_runtime_archive_ok');
    assert.match(archive.summary, /is complete/);
    assert.equal(
      archive.nextActions.some((action) =>
        action.startsWith('pappra runtime archive'),
      ),
      false,
    );
    assert.equal(check(report, 'runtime.state').status, 'warning');
    assert.notEqual(report.summary.status, 'ok');
    assert.deepEqual(snapshotTree(fixture.data), dataBefore);
  } finally {
    for (const path of Object.values(fixture)) cleanup(path);
  }
});
