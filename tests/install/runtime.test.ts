import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  inspectRuntimeState,
  inspectRuntimeStatePassive,
  installRuntime,
  removeRuntime,
  resolveUserDataDir,
  runtimePaths,
} from '../../src/install/runtime.js';
import {
  acquireInstallLock,
  releaseInstallLock,
  writeJsonAtomic,
} from '../../src/install/ownership.js';
import type { InstallJournal } from '../../src/schemas/install.js';
import { cleanup, createRuntimeTarball, makeTempDir } from './fixtures.js';
import { snapshotTree } from '../workspace/fixtures.js';

const version = '9.8.7';

test('installs a local tarball into the isolated data dir without lifecycle scripts', async () => {
  const root = makeTempDir('runtime-install');
  try {
    const marker = join(root, 'postinstall-ran');
    const tarball = createRuntimeTarball(root, { version, markerPath: marker });
    const dataDir = join(root, 'data');
    const result = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'installed');
    assert(result.manifest !== null);
    assert.equal(result.manifest.runtimeVersion, version);
    assert.equal(result.manifest.source.kind, 'tarball');
    assert.match(result.manifest.source.digest ?? '', /^sha256:[0-9a-f]{64}$/);
    assert.equal(result.journal?.status, 'verified');
    assert.equal(existsSync(marker), false);
    const paths = runtimePaths(version, dataDir);
    assert.equal(result.runtimeRoot, paths.runtimeRoot);
    assert.equal(
      existsSync(join(paths.runtimeRoot, 'install-manifest.json')),
      true,
    );
    assert.equal(existsSync(result.manifest.executable), true);
    assert.equal(
      readFileSync(
        join(paths.runtimeRoot, 'install-manifest.json'),
        'utf8',
      ).includes('pappra/runtime-manifest/1'),
      true,
    );
    const state = await inspectRuntimeState(version, dataDir);
    assert.equal(state.status, 'complete');
  } finally {
    cleanup(root);
  }
});

test('reuses a complete runtime and detects a mismatched version without replacing it', async () => {
  const root = makeTempDir('runtime-reuse');
  try {
    const tarball = createRuntimeTarball(root, { version });
    const dataDir = join(root, 'data');
    const first = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(first.ok, true);
    const second = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(second.status, 'reused');
    assert.equal(second.manifest?.installId, first.manifest?.installId);

    const mismatch = await installRuntime({
      version: '1.2.3',
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.status, 'failed');
    assert.equal(existsSync(runtimePaths('1.2.3', dataDir).runtimeRoot), false);
    assert.equal(
      (await inspectRuntimeState(version, dataDir)).status,
      'complete',
    );
  } finally {
    cleanup(root);
  }
});

test('respects an existing lock and an interrupted journal instead of retrying', async () => {
  const root = makeTempDir('runtime-state');
  try {
    const tarball = createRuntimeTarball(root, { version });
    const dataDir = join(root, 'data');
    const paths = runtimePaths(version, dataDir);
    const lock = await acquireInstallLock(
      paths.lockPath,
      'install-runtime',
      paths.runtimeRoot,
    );
    assert.equal(lock.ok, true);
    const locked = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(locked.status, 'locked');
    assert.equal(existsSync(paths.runtimeRoot), false);
    assert(lock.lock !== null);
    assert.equal(
      (await releaseInstallLock(lock.path, lock.lock.token)).ok,
      true,
    );

    const journalId = '44444444-4444-4444-8444-444444444444';
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
    const journalFile = join(paths.journalsDir, `${journalId}.json`);
    const written = await writeJsonAtomic(journalFile, journal);
    assert.equal(written.ok, true);
    const partial = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(partial.status, 'partial');
    assert.equal(existsSync(paths.runtimeRoot), false);
  } finally {
    cleanup(root);
  }
});

test('treats an existing incomplete runtime directory as corrupt and preserves it', async () => {
  const root = makeTempDir('runtime-corrupt');
  try {
    const tarball = createRuntimeTarball(root, { version });
    const dataDir = join(root, 'data');
    const paths = runtimePaths(version, dataDir);
    mkdirSync(paths.runtimeRoot, { recursive: true });
    writeFileSync(join(paths.runtimeRoot, 'install-manifest.json'), '{broken');
    const result = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(result.status, 'corrupt');
    assert.equal(existsSync(paths.runtimeRoot), true);
    assert.equal(
      readFileSync(join(paths.runtimeRoot, 'install-manifest.json'), 'utf8'),
      '{broken',
    );
  } finally {
    cleanup(root);
  }
});

test('serializes concurrent installs of the same version', async () => {
  const root = makeTempDir('runtime-concurrent');
  try {
    const tarball = createRuntimeTarball(root, { version });
    const dataDir = join(root, 'data');
    const [left, right] = await Promise.all([
      installRuntime({
        version,
        source: { kind: 'tarball', path: tarball },
        dataDir,
        offline: true,
        timeoutMs: 60_000,
      }),
      installRuntime({
        version,
        source: { kind: 'tarball', path: tarball },
        dataDir,
        offline: true,
        timeoutMs: 60_000,
      }),
    ]);
    const statuses = [left.status, right.status].sort();
    assert(
      statuses[0] === 'installed' &&
        (statuses[1] === 'locked' || statuses[1] === 'reused'),
      `unexpected statuses: ${statuses.join(', ')}`,
    );
    assert.equal(
      (await inspectRuntimeState(version, dataDir)).status,
      'complete',
    );
  } finally {
    cleanup(root);
  }
});

test('removes only a complete runtime with an explicit no-reference result', async () => {
  const root = makeTempDir('runtime-remove');
  try {
    const tarball = createRuntimeTarball(root, { version });
    const dataDir = join(root, 'data');
    const installed = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(installed.ok, true);
    const blocked = await removeRuntime({ version, dataDir });
    assert.equal(blocked.status, 'in-use');
    assert.equal(existsSync(runtimePaths(version, dataDir).runtimeRoot), true);
    const removed = await removeRuntime({
      version,
      dataDir,
      activeReferences: [],
    });
    assert.equal(removed.status, 'removed');
    assert.equal(existsSync(runtimePaths(version, dataDir).runtimeRoot), false);
    assert.equal(
      (await removeRuntime({ version, dataDir, activeReferences: [] })).status,
      'missing',
    );
  } finally {
    cleanup(root);
  }
});

test('resolves platform data directories without touching the real home', () => {
  assert.equal(
    resolveUserDataDir(
      { PAPPRA_DATA_HOME: '/tmp/pappra-test' },
      'linux',
      '/home/x',
    ),
    '/tmp/pappra-test',
  );
  assert.equal(
    resolveUserDataDir({ XDG_DATA_HOME: '/tmp/xdg' }, 'linux', '/home/x'),
    '/tmp/xdg/pappra',
  );
  assert.equal(
    resolveUserDataDir({}, 'darwin', '/home/x'),
    '/home/x/Library/Application Support/Pappra',
  );
  assert.equal(
    resolveUserDataDir({ LOCALAPPDATA: 'C:/Data' }, 'win32', 'C:/Users/x'),
    join('C:/Data', 'Pappra'),
  );
});

test('reports an unwritable data directory as failure without creating a runtime', async () => {
  const root = makeTempDir('runtime-disk-failure');
  try {
    const tarball = createRuntimeTarball(root, { version });
    const dataDir = join(root, 'data');
    writeFileSync(dataDir, 'not a directory');
    const result = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(result.ok, false);
    assert(result.status === 'failed' || result.status === 'locked');
    assert.equal(existsSync(runtimePaths(version, dataDir).runtimeRoot), false);
  } finally {
    cleanup(root);
  }
});

test('reports partial and nonzero state when the final journal cannot persist', async () => {
  const root = makeTempDir('runtime-journal-failure');
  try {
    const tarball = createRuntimeTarball(root, { version });
    const dataDir = join(root, 'data');
    const journals = join(dataDir, 'journals');
    const result = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
      beforeVerifiedJournalPersist: async () => {
        await chmod(journals, 0o555);
      },
    });
    await chmod(journals, 0o755).catch(() => undefined);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'partial');
    assert(result.manifest !== null);
    assert.equal(existsSync(runtimePaths(version, dataDir).runtimeRoot), true);
    assert(result.residualPaths.length > 0);

    const retry = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(retry.status, 'partial');
    assert.equal(retry.ok, false);
  } finally {
    await chmod(join(root, 'data', 'journals'), 0o755).catch(() => undefined);
    cleanup(root);
  }
});

test('does not reuse a complete runtime while its installation lock remains', async () => {
  const root = makeTempDir('runtime-locked-reuse');
  try {
    const tarball = createRuntimeTarball(root, { version });
    const dataDir = join(root, 'data');
    const installed = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(installed.ok, true);
    const paths = runtimePaths(version, dataDir);
    const lock = await acquireInstallLock(
      paths.lockPath,
      'install-runtime',
      paths.runtimeRoot,
      dataDir,
    );
    assert.equal(lock.ok, true);
    const reused = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(reused.status, 'locked');
    assert.equal(reused.ok, false);
    assert(lock.lock !== null);
    await releaseInstallLock(lock.path, lock.lock.token);
    const recovered = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(recovered.status, 'reused');
  } finally {
    cleanup(root);
  }
});

test('passive runtime inspection does not execute the installed CLI smoke', async () => {
  const root = makeTempDir('runtime-passive');
  try {
    const marker = join(root, 'runtime-executed');
    const tarball = createRuntimeTarball(root, {
      version,
      executionMarkerPath: marker,
    });
    const dataDir = join(root, 'data');
    const installed = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(installed.ok, true);
    assert.equal(existsSync(marker), true);
    rmSync(marker, { force: true });
    const passive = await inspectRuntimeStatePassive(version, dataDir);
    assert.equal(passive.status, 'content-match');
    assert.equal(existsSync(marker), false);
  } finally {
    cleanup(root);
  }
});

test('runtime content hashes do not depend on locale collation', async (context) => {
  const root = makeTempDir('runtime-locale');
  try {
    const tarball = createRuntimeTarball(root, { version });
    const dataDir = join(root, 'data');
    const installed = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(installed.ok, true);
    context.mock.method(String.prototype, 'localeCompare', () => {
      throw new Error('Locale collation is unavailable');
    });
    assert.equal(
      (await inspectRuntimeStatePassive(version, dataDir)).status,
      'content-match',
    );
  } finally {
    context.mock.restoreAll();
    cleanup(root);
  }
});

test('passive runtime inspection rejects a package symlink outside the runtime root', async () => {
  const root = makeTempDir('runtime-passive-symlink');
  try {
    const tarball = createRuntimeTarball(root, { version });
    const dataDir = join(root, 'data');
    const installed = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert(installed.ok && installed.manifest !== null);
    const paths = runtimePaths(version, dataDir);
    const packageRoot = join(
      paths.runtimeRoot,
      'node_modules',
      ...installed.manifest.packageName.split('/'),
    );
    const outsidePackage = join(root, 'outside-package');
    renameSync(packageRoot, outsidePackage);
    symlinkSync(outsidePackage, packageRoot, 'dir');

    const passive = await inspectRuntimeStatePassive(version, dataDir);
    assert.equal(passive.status, 'corrupt');
    assert(
      passive.diagnostics.some((entry) =>
        entry.message.includes('escapes the runtime directory'),
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('passive runtime inspection treats incompatible journals as unreadable', async () => {
  const root = makeTempDir('runtime-passive-journal');
  try {
    const tarball = createRuntimeTarball(root, { version });
    const dataDir = join(root, 'data');
    const installed = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(installed.ok, true);
    const paths = runtimePaths(version, dataDir);
    writeFileSync(
      join(paths.journalsDir, 'unknown-version.json'),
      JSON.stringify({ schema: 'pappra/install-journal/999' }),
    );

    const passive = await inspectRuntimeStatePassive(version, dataDir);
    assert.equal(passive.status, 'unreadable');
    assert(
      passive.diagnostics.some((entry) =>
        entry.message.includes('unreadable or incompatible'),
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('treats non-regular .json journal candidates as unreadable and never follows them', async () => {
  const root = makeTempDir('runtime-journal-candidates');
  try {
    const tarball = createRuntimeTarball(root, { version });
    const dataDir = join(root, 'data');
    const installed = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(installed.ok, true);
    const paths = runtimePaths(version, dataDir);

    const validJournal: InstallJournal = {
      schema: 'pappra/install-journal/1',
      installId: '55555555-5555-4555-8555-555555555555',
      operation: 'install-runtime',
      target: paths.runtimeRoot,
      workspaceRoot: null,
      runtimeVersion: version,
      status: 'verified',
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
      steps: [],
      entries: [],
      residuals: [],
      manifestRef: join(paths.runtimeRoot, 'install-manifest.json'),
    };
    const written = await writeJsonAtomic(
      join(paths.journalsDir, `${validJournal.installId}.json`),
      validJournal,
    );
    assert.equal(written.ok, true);
    assert.equal(
      (await inspectRuntimeStatePassive(version, dataDir)).status,
      'content-match',
    );

    symlinkSync(
      join(paths.journalsDir, 'missing-target'),
      join(paths.journalsDir, 'broken.txt'),
      'file',
    );
    mkdirSync(join(paths.journalsDir, 'notes'));
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [join(paths.journalsDir, 'pipe.txt')]);
    }
    assert.equal(
      (await inspectRuntimeStatePassive(version, dataDir)).status,
      'content-match',
    );

    symlinkSync(
      join(paths.journalsDir, 'missing-target'),
      join(paths.journalsDir, 'broken.json'),
      'file',
    );
    mkdirSync(join(paths.journalsDir, 'directory.json'));
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [join(paths.journalsDir, 'fifo.json')]);
    }
    const before = snapshotTree(paths.journalsDir);

    const passive = await inspectRuntimeStatePassive(version, dataDir);
    assert.equal(passive.status, 'unreadable');
    assert(
      passive.diagnostics.some((entry) =>
        entry.message.includes('unreadable or incompatible'),
      ),
    );
    assert.equal(
      (await inspectRuntimeState(version, dataDir)).status,
      'partial',
    );

    const retry = await installRuntime({
      version,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      offline: true,
      timeoutMs: 60_000,
    });
    assert.equal(retry.ok, false);
    assert.equal(retry.status, 'partial');
    assert.deepEqual(snapshotTree(paths.journalsDir), before);
  } finally {
    cleanup(root);
  }
});

test('installs self runtimes from local dependencies without registry access', async () => {
  const root = makeTempDir('runtime-self-cold-cache');
  const dependencyName = 'pappra-runtime-fixture-dependency';
  const packageName = 'pappra-runtime-fixture';
  const packageRoot = join(root, 'self-package');
  const dependencyRoot = join(packageRoot, 'node_modules', dependencyName);
  const envKeys = [
    'HOME',
    'npm_config_cache',
    'npm_config_registry',
    'npm_config_fetch_retries',
    'npm_config_fetch_timeout',
  ];
  const originalEnvironment = new Map(
    envKeys.map((key) => [key, process.env[key]]),
  );
  try {
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    mkdirSync(dependencyRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      `${JSON.stringify(
        {
          name: packageName,
          version,
          type: 'module',
          bin: { pappra: 'dist/cli/main.js' },
          files: ['dist'],
          dependencies: { [dependencyName]: '1.0.0' },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(packageRoot, 'dist', 'cli', 'main.js'),
      [
        '#!/usr/bin/env node',
        `import { marker } from '${dependencyName}';`,
        `if (marker !== 'bundled') process.exitCode = 1;`,
        `else process.stdout.write(JSON.stringify({ version: '${version}' }) + '\\n');`,
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dependencyRoot, 'package.json'),
      `${JSON.stringify({
        name: dependencyName,
        version: '1.0.0',
        type: 'module',
        exports: './index.js',
      })}\n`,
    );
    writeFileSync(
      join(dependencyRoot, 'index.js'),
      "export const marker = 'bundled';\n",
    );

    process.env['HOME'] = join(root, 'fixture-home');
    process.env['npm_config_cache'] = join(root, 'empty-npm-cache');
    process.env['npm_config_registry'] = 'http://127.0.0.1:9/';
    process.env['npm_config_fetch_retries'] = '0';
    process.env['npm_config_fetch_timeout'] = '1000';
    const installed = await installRuntime({
      version,
      packageName,
      source: { kind: 'self', path: packageRoot },
      dataDir: join(root, 'data'),
      timeoutMs: 5_000,
    });

    assert.equal(
      installed.ok,
      true,
      JSON.stringify({
        diagnostics: installed.diagnostics,
        journal: installed.journal,
      }),
    );
    assert.equal(installed.status, 'installed');
    assert.equal(installed.manifest?.source.kind, 'self');
  } finally {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanup(root);
  }
});
