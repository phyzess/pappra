import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  archiveRuntime,
  type ArchiveRuntimeResult,
} from '../../src/install/runtime-archive.js';
import { runtimeArchiveDirectory } from '../../src/install/runtime-archive-state.js';
import {
  runtimePaths,
  installRuntime,
  removeRuntime,
} from '../../src/install/runtime.js';
import { beginRuntimeReference } from '../../src/install/references.js';
import { repairInstall } from '../../src/install/repair.js';
import { captureProcessIdentity } from '../../src/infra/process-identity.js';
import { inspectPrivateLock } from '../../src/infra/private-lock.js';
import { sha256Digest } from '../../src/infra/fs.js';
import type {
  InstallJournal,
  RuntimeManifest,
} from '../../src/schemas/install.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';
import { cleanup, createRuntimeTarball, makeTempDir } from './fixtures.js';

const version = '9.8.7';
const now = '2026-10-25T00:00:00.000Z';

function fixture() {
  const root = realpathSync(makeTempDir('runtime-archive'));
  const dataDir = join(root, 'data');
  const paths = runtimePaths(version, dataDir);
  mkdirSync(paths.runtimeRoot, { recursive: true });
  writeFileSync(
    join(paths.runtimeRoot, 'install-manifest.json'),
    '{broken raw manifest\x00',
  );
  writeFileSync(
    join(paths.runtimeRoot, 'evidence.bin'),
    Buffer.from([0, 255, 1, 127]),
  );
  return { root, dataDir, paths };
}
function options(dataDir: string) {
  return {
    version,
    dataDir,
    apply: true,
    forceUnknownReferences: true,
    reason: 'Retire broken beta runtime',
  };
}
function journal(dataDir: string, id = randomUUID()): InstallJournal {
  return {
    schema: 'pappra/install-journal/1',
    installId: id,
    operation: 'install-runtime',
    target: runtimePaths(version, dataDir).runtimeRoot,
    workspaceRoot: null,
    runtimeVersion: version,
    status: 'rollback-required',
    createdAt: now,
    updatedAt: now,
    steps: [],
    entries: [],
    residuals: [],
    manifestRef: null,
  };
}
function writeJournal(dataDir: string, value: InstallJournal) {
  const paths = runtimePaths(version, dataDir);
  mkdirSync(paths.journalsDir, { recursive: true });
  writeFileSync(
    join(paths.journalsDir, `${value.installId}.json`),
    JSON.stringify(value),
  );
  mkdirSync(join(paths.stagingRoot, value.installId), { recursive: true });
  writeFileSync(
    join(paths.stagingRoot, value.installId, 'partial'),
    'unmodified staged bytes',
  );
}
function writeLock(file: string, value: unknown) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(
    file,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}
function manifest(dataDir: string): RuntimeManifest {
  const paths = runtimePaths(version, dataDir);
  return {
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
}

test('archive preview is read-only, requires explicit unknown coverage acceptance and retains raw evidence', async () => {
  const { root, dataDir, paths } = fixture();
  try {
    const item = journal(dataDir);
    writeJournal(dataDir, item);
    const journalFile = join(paths.journalsDir, `${item.installId}.json`);
    const beforeJournal = readFileSync(journalFile);
    const inode = statSync(paths.runtimeRoot).ino;
    const plan = await archiveRuntime({ version, dataDir });
    assert.equal(plan.status, 'planned');
    assert(plan.blockers.some((message) => message.includes('--force')));
    assert.equal(existsSync(join(dataDir, 'runtime-archives')), false);
    assert.equal(existsSync(paths.lockPath), false);
    assert.equal(
      (
        await archiveRuntime({
          version,
          dataDir,
          apply: true,
          reason: 'reviewed',
        })
      ).status,
      'blocked',
    );
    assert.equal(
      (await archiveRuntime({ ...options(dataDir), reason: '' })).status,
      'blocked',
    );
    const archived = await archiveRuntime(options(dataDir));
    assert.equal(archived.ok, true, JSON.stringify(archived));
    assert(archived.archive && archived.receipt);
    assert.equal(existsSync(paths.runtimeRoot), false);
    assert.equal(existsSync(journalFile), false);
    assert.equal(statSync(join(archived.archive, 'runtime')).ino, inode);
    assert.deepEqual(
      readFileSync(
        join(archived.archive, 'journals', `${item.installId}.json`),
      ),
      beforeJournal,
    );
    assert.deepEqual(
      readFileSync(join(archived.archive, 'runtime/evidence.bin')),
      Buffer.from([0, 255, 1, 127]),
    );
    assert.equal(
      readFileSync(
        join(archived.archive, `staging/${item.installId}/partial`),
        'utf8',
      ),
      'unmodified staged bytes',
    );
    const receipt = JSON.parse(
      readFileSync(archived.receipt, 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(receipt.status, 'complete');
    assert.equal(receipt.forceUnknownReferences, true);
    assert.equal(receipt.reason, options(dataDir).reason);
    const repeated = await archiveRuntime(options(dataDir));
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.equal(repeated.archive, archived.archive);
    assert.equal(repeated.resumed, true);
    assert.equal(existsSync(paths.lockPath), false);
    // A later install can have the same version without reusing the old archive.
    mkdirSync(paths.runtimeRoot);
    writeFileSync(join(paths.runtimeRoot, 'new'), 'new generation');
    const next = await archiveRuntime(options(dataDir));
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.notEqual(next.archive, archived.archive);
    assert.equal(
      readFileSync(
        join(archived.archive, 'runtime/install-manifest.json'),
        'utf8',
      ),
      '{broken raw manifest\x00',
    );
  } finally {
    cleanup(root);
  }
});

test('malformed and legacy journals require explicit selection; unrelated evidence is preserved', async () => {
  const { root, dataDir, paths } = fixture();
  try {
    const id = randomUUID();
    const other = randomUUID();
    mkdirSync(paths.journalsDir, { recursive: true });
    writeFileSync(join(paths.journalsDir, `${id}.json`), '{old unfinished');
    writeFileSync(
      join(paths.journalsDir, `${other}.json`),
      'unrelated broken evidence',
    );
    mkdirSync(join(paths.stagingRoot, id), { recursive: true });
    writeFileSync(join(paths.stagingRoot, id, 'old'), 'old staging');
    const plan = await archiveRuntime({ version, dataDir });
    assert.equal(plan.unselectedJournals.length, 2);
    assert.equal(plan.items.length, 1);
    const archived = await archiveRuntime({
      ...options(dataDir),
      installIds: [id],
    });
    assert.equal(archived.ok, true, JSON.stringify(archived));
    assert(archived.archive);
    assert.equal(
      readFileSync(join(archived.archive, `journals/${id}.json`), 'utf8'),
      '{old unfinished',
    );
    assert.equal(
      readFileSync(join(archived.archive, `staging/${id}/old`), 'utf8'),
      'old staging',
    );
    assert.equal(
      readFileSync(join(paths.journalsDir, `${other}.json`), 'utf8'),
      'unrelated broken evidence',
    );
  } finally {
    cleanup(root);
  }
});

test('verified references including another workspace and path aliases cannot be bypassed', async () => {
  const { root, dataDir, paths } = fixture();
  try {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeWorkspaceConfig(workspace, baseWorkspaceConfig());
    writeMachineConfig(workspace, baseMachineConfig(workspace));
    const runtime = manifest(dataDir);
    const lease = await beginRuntimeReference(workspace, runtime);
    assert(lease.ok, JSON.stringify(lease));
    const alias = join(root, 'alias');
    symlinkSync(dataDir, alias, 'dir');
    const executable = join(alias, 'runtimes', version, 'cli.js');
    // A corrupt runtime can lack its executable; the alias binding still
    // positively identifies this runtime and must remain protective.
    writeMachineConfig(
      workspace,
      baseMachineConfig(workspace, {
        runtime: { version, executable, verifiedAt: now },
      }),
    );
    assert.equal((await lease.value.release()).ok, true);
    const blocked = await archiveRuntime({
      ...options(alias),
      allWritersStopped: true,
    });
    assert.equal(blocked.status, 'blocked');
    assert(
      blocked.blockers.some((message) =>
        message.includes('Verified workspace'),
      ),
    );
    assert.equal(existsSync(paths.runtimeRoot), true);
    assert.equal(existsSync(join(dataDir, 'runtime-archives')), false);
    // Local unregistered bindings receive the same positive protection.
    renameSync(
      join(dataDir, 'runtime-references'),
      join(dataDir, 'registry-evidence'),
    );
    const local = await archiveRuntime({
      ...options(dataDir),
      workspaceRoot: workspace,
    });
    assert.equal(local.status, 'blocked');
  } finally {
    cleanup(root);
  }
});

test('live locks are never forced, unknown locks need a stopped-writers assertion and raw locks are preserved', async (t) => {
  const { root, dataDir, paths } = fixture();
  try {
    const identity = captureProcessIdentity();
    if (identity) {
      writeLock(paths.lockPath, {
        token: randomUUID(),
        pid: process.pid,
        process_identity: identity,
      });
      assert.equal((await inspectPrivateLock(paths.lockPath)).state, 'alive');
      const blocked = await archiveRuntime({
        ...options(dataDir),
        allWritersStopped: true,
      });
      assert.equal(blocked.status, 'blocked');
      assert(blocked.blockers.some((message) => message.includes('live lock')));
    } else {
      t.diagnostic(
        'OS process identity unavailable; verified-live assertion cannot be exercised in this environment.',
      );
    }
    writeLock(paths.lockPath, '{malformed lock evidence');
    const blocked = await archiveRuntime(options(dataDir));
    assert.equal(blocked.status, 'blocked');
    assert.equal(existsSync(join(dataDir, 'runtime-archives')), false);
    const archived = await archiveRuntime({
      ...options(dataDir),
      allWritersStopped: true,
    });
    assert.equal(archived.ok, true, JSON.stringify(archived));
    assert(archived.archive);
    assert.equal(
      readFileSync(join(archived.archive, 'original.lock'), 'utf8'),
      '{malformed lock evidence',
    );
  } finally {
    cleanup(root);
  }
});

test('pending archive fences install, remove, repair and binding; changed sources or redirected parents fail closed', async () => {
  const { root, dataDir, paths } = fixture();
  try {
    const failed = await archiveRuntime({
      ...options(dataDir),
      checkpoint: (phase) => {
        if (phase === 'prepared') throw new Error('fixture interruption');
      },
    });
    assert.equal(failed.ok, false);
    assert.equal(
      (await removeRuntime({ version, dataDir, forceUnknownReferences: true }))
        .status,
      'locked',
    );
    assert.equal(
      (await installRuntime({ version, dataDir, source: { kind: 'version' } }))
        .status,
      'partial',
    );
    assert.equal(
      (
        await repairInstall({
          root,
          dataDir,
          runtimeVersion: version,
          apply: true,
        })
      ).ok,
      false,
    );
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeWorkspaceConfig(workspace, baseWorkspaceConfig());
    const binding = await beginRuntimeReference(workspace, manifest(dataDir));
    assert.equal(binding.ok, false);
    renameSync(paths.runtimeRoot, `${paths.runtimeRoot}-original`);
    mkdirSync(paths.runtimeRoot);
    writeFileSync(join(paths.runtimeRoot, 'new-owner'), 'must retain');
    const resumed = await archiveRuntime(options(dataDir));
    assert.equal(resumed.ok, false);
    assert.equal(
      readFileSync(join(paths.runtimeRoot, 'new-owner'), 'utf8'),
      'must retain',
    );
  } finally {
    cleanup(root);
  }
  const second = fixture();
  try {
    const failed = await archiveRuntime({
      ...options(second.dataDir),
      checkpoint: (phase) => {
        if (phase === 'prepared') {
          renameSync(
            join(second.dataDir, 'runtimes'),
            join(second.dataDir, 'original-runtimes'),
          );
          symlinkSync(
            join(second.dataDir, 'original-runtimes'),
            join(second.dataDir, 'runtimes'),
            'dir',
          );
        }
      },
    });
    assert.equal(failed.ok, false);
    assert.equal(
      existsSync(
        join(second.dataDir, 'original-runtimes', version, 'evidence.bin'),
      ),
      true,
    );
  } finally {
    cleanup(second.root);
  }
});

test('references are rechecked after reservation and a concurrent archive cannot enter', async () => {
  const { root, dataDir, paths } = fixture();
  try {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeWorkspaceConfig(workspace, baseWorkspaceConfig());
    writeMachineConfig(workspace, baseMachineConfig(workspace));
    const failed = await archiveRuntime({
      ...options(dataDir),
      workspaceRoot: workspace,
      checkpoint: async (phase) => {
        if (phase !== 'prepared') return;
        const concurrent = await archiveRuntime(options(dataDir));
        assert.equal(concurrent.status, 'blocked');
        writeMachineConfig(
          workspace,
          baseMachineConfig(workspace, {
            runtime: {
              version,
              executable: join(paths.runtimeRoot, 'cli.js'),
              verifiedAt: now,
            },
          }),
        );
      },
    });
    assert.equal(failed.ok, false);
    assert(
      failed.errors.some((message) => message.includes('Verified workspace')),
    );
    assert.equal(existsSync(paths.runtimeRoot), true);
  } finally {
    cleanup(root);
  }
});

test('foreign journals, unsafe roots and corrupted archive receipts are retained', async () => {
  const { root, dataDir, paths } = fixture();
  try {
    const foreign = {
      ...journal(dataDir),
      runtimeVersion: '1.0.0',
      target: join(dataDir, 'runtimes/1.0.0'),
    };
    writeJournal(dataDir, foreign);
    const wrong = await archiveRuntime({
      ...options(dataDir),
      installIds: [foreign.installId],
    });
    assert.equal(wrong.ok, false);
    assert.equal(existsSync(paths.runtimeRoot), true);
    renameSync(paths.runtimeRoot, `${paths.runtimeRoot}-evidence`);
    symlinkSync(`${paths.runtimeRoot}-evidence`, paths.runtimeRoot, 'dir');
    const unsafe = await archiveRuntime(options(dataDir));
    assert.equal(unsafe.ok, false);
    assert.equal(
      readFileSync(join(paths.runtimeRoot, 'install-manifest.json'), 'utf8'),
      '{broken raw manifest\x00',
    );
    const control = runtimeArchiveDirectory(dataDir, version);
    mkdirSync(control, { recursive: true });
    writeFileSync(join(control, 'pending.json'), '{"status":"complete"}');
    const invalid = await archiveRuntime(options(dataDir));
    assert.equal(invalid.ok, false);
    assert.equal(
      readFileSync(join(control, 'pending.json'), 'utf8'),
      '{"status":"complete"}',
    );
    assert.equal(
      (await installRuntime({ version, dataDir, source: { kind: 'version' } }))
        .status,
      'partial',
    );
  } finally {
    cleanup(root);
  }
});

test('archival retires an unrepaired journal so repair converges and a fresh install can proceed', async () => {
  const { root, dataDir, paths } = fixture();
  try {
    const item = {
      ...journal(dataDir),
      manifestRef: join(paths.runtimeRoot, 'install-manifest.json'),
    };
    writeJournal(dataDir, item);
    const original = readFileSync(
      join(paths.journalsDir, `${item.installId}.json`),
    );
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const repair = await repairInstall({
        root,
        dataDir,
        runtimeVersion: version,
        apply: true,
      });
      assert.equal(repair.ok, false);
      assert.deepEqual(
        readFileSync(join(paths.journalsDir, `${item.installId}.json`)),
        original,
      );
    }
    const archived = await archiveRuntime(options(dataDir));
    assert.equal(archived.ok, true, JSON.stringify(archived));
    const repair = await repairInstall({
      root,
      dataDir,
      runtimeVersion: version,
      apply: true,
    });
    assert.equal(repair.ok, true, JSON.stringify(repair));
    assert.equal(repair.entries.length, 0);
    const tarball = createRuntimeTarball(root, { version });
    const installed = await installRuntime({
      version,
      dataDir,
      source: { kind: 'tarball', path: tarball },
      offline: true,
    });
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.deepEqual(
      readFileSync(join(archived.archive!, `journals/${item.installId}.json`)),
      original,
    );
  } finally {
    cleanup(root);
  }
});

test('a conflicting permanent receipt is never overwritten after the evidence has moved', async () => {
  const { root, dataDir } = fixture();
  try {
    let auditFile = '';
    const failed = await archiveRuntime({
      ...options(dataDir),
      checkpoint: (phase) => {
        if (phase !== 'moved:runtime') return;
        const pending = JSON.parse(
          readFileSync(
            join(runtimeArchiveDirectory(dataDir, version), 'pending.json'),
            'utf8',
          ),
        ) as { id: string };
        auditFile = join(
          runtimeArchiveDirectory(dataDir, version),
          pending.id,
          'receipt.json',
        );
        writeFileSync(auditFile, 'conflicting audit evidence');
      },
    });
    assert.equal(failed.ok, false);
    assert(
      failed.errors.some((message) => message.includes('receipt conflicts')),
    );
    assert.equal(readFileSync(auditFile, 'utf8'), 'conflicting audit evidence');
    assert.equal((await archiveRuntime(options(dataDir))).ok, false);
    assert.equal(readFileSync(auditFile, 'utf8'), 'conflicting audit evidence');
    assert.equal(
      readFileSync(
        join(failed.archive!, 'runtime/install-manifest.json'),
        'utf8',
      ),
      '{broken raw manifest\x00',
    );
  } finally {
    cleanup(root);
  }
});

for (const originalLock of [false, true]) {
  const phases = [
    'prepared',
    'moved:runtime',
    'moved:journal',
    'moved:staging',
    ...(originalLock ? ['moved:original.lock'] : []),
    'receipt',
    'complete',
  ];
  for (const phase of phases)
    test(`SIGKILL recovery preserves evidence and resumes one archive (${originalLock ? 'unknown lock' : 'new fence'}: ${phase})`, async () => {
      const { root, dataDir, paths } = fixture();
      try {
        const item = journal(dataDir);
        writeJournal(dataDir, item);
        if (originalLock) writeLock(paths.lockPath, 'unknown owner raw lock');
        const module = new URL(
          '../../src/install/runtime-archive.js',
          import.meta.url,
        ).href;
        const crash = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
        import { archiveRuntime } from ${JSON.stringify(module)};
        const phase = ${JSON.stringify(phase)};
        const result = await archiveRuntime({ ...${JSON.stringify(options(dataDir))}, allWritersStopped: true,
          checkpoint(actual) {
            if (actual === phase || (phase === 'moved:journal' && actual.startsWith('moved:journals/')) ||
                (phase === 'moved:staging' && actual.startsWith('moved:staging/'))) process.kill(process.pid, 'SIGKILL');
          }
        });
        console.error(JSON.stringify(result)); process.exit(23);
      `,
          ],
          {
            encoding: 'utf8',
            cwd: root,
            timeout: 30_000,
            env: { ...process.env, PAPPRA_DATA_HOME: dataDir },
          },
        );
        assert.equal(
          crash.signal,
          'SIGKILL',
          `${crash.stderr} ${crash.error?.message ?? ''}`,
        );
        const control = runtimeArchiveDirectory(dataDir, version);
        const pendingBefore = JSON.parse(
          readFileSync(join(control, 'pending.json'), 'utf8'),
        ) as { id: string };
        // Resume through the actual built CLI, with the same isolated data home.
        const cli = new URL('../../../../dist/cli/main.js', import.meta.url);
        const recovery = spawnSync(
          process.execPath,
          [
            cli.pathname,
            'runtime',
            'archive',
            '--runtime-version',
            version,
            '--apply',
            '--force',
            '--all-writers-stopped',
            '--reason',
            'Resume interrupted archive',
            '--json',
          ],
          {
            cwd: root,
            encoding: 'utf8',
            timeout: 30_000,
            env: { ...process.env, PAPPRA_DATA_HOME: dataDir },
            shell: false,
          },
        );
        assert.ifError(recovery.error);
        assert.equal(
          recovery.status,
          0,
          `${recovery.stdout} ${recovery.stderr}`,
        );
        const resumed = JSON.parse(recovery.stdout) as ArchiveRuntimeResult;
        assert.equal(resumed.ok, true, JSON.stringify(resumed));
        assert.equal(resumed.resumed, true);
        assert.equal(resumed.archive, join(control, pendingBefore.id));
        assert.equal(
          readdirSync(control).filter((name) => /^[0-9a-f-]{36}$/.test(name))
            .length,
          1,
        );
        assert.deepEqual(
          readFileSync(join(resumed.archive!, 'runtime/evidence.bin')),
          Buffer.from([0, 255, 1, 127]),
        );
        assert.equal(existsSync(paths.runtimeRoot), false);
        assert.equal(existsSync(paths.lockPath), false);
        assert.equal(
          existsSync(join(paths.journalsDir, `${item.installId}.json`)),
          false,
        );
        if (originalLock)
          assert.equal(
            readFileSync(join(resumed.archive!, 'original.lock'), 'utf8'),
            'unknown owner raw lock',
          );
        const repeated = await archiveRuntime({
          ...options(dataDir),
          allWritersStopped: true,
        });
        assert.equal(repeated.ok, true, JSON.stringify(repeated));
        assert.equal(repeated.archive, resumed.archive);
      } finally {
        cleanup(root);
      }
    });
}
