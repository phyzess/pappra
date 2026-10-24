import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  beginRuntimeReference,
  inspectRuntimeReferences,
  runtimeReferencesDirectory,
} from '../../src/install/references.js';
import { installRuntime, removeRuntime } from '../../src/install/runtime.js';
import type { RuntimeManifest } from '../../src/schemas/install.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';
import { cleanup, createRuntimeTarball, makeTempDir } from './fixtures.js';

async function install(
  root: string,
  dataDir: string,
  version: string,
): Promise<RuntimeManifest> {
  const tarball = createRuntimeTarball(root, { version });
  const installed = await installRuntime({
    version,
    source: { kind: 'tarball', path: tarball },
    dataDir,
    offline: true,
    timeoutMs: 60_000,
  });
  assert(
    installed.ok && installed.manifest,
    JSON.stringify(installed.diagnostics),
  );
  return installed.manifest;
}
function workspace(root: string, runtime: RuntimeManifest | null): void {
  mkdirSync(root, { recursive: true });
  writeWorkspaceConfig(root, baseWorkspaceConfig());
  writeMachineConfig(
    root,
    baseMachineConfig(root, {
      runtime:
        runtime === null
          ? null
          : {
              version: runtime.runtimeVersion,
              executable: runtime.executable,
              verifiedAt: runtime.verifiedAt,
            },
    }),
  );
}

test('references register before binding, serialize removal, and verified bindings are never bypassed by force', async () => {
  const root = makeTempDir('runtime-reference');
  const dataDir = join(root, 'data');
  try {
    const runtime = await install(root, dataDir, '9.8.7');
    const a = join(root, 'workspace-a');
    workspace(a, null);
    const lease = await beginRuntimeReference(a, runtime);
    assert(lease.ok, JSON.stringify(lease));
    assert.equal(readdirSync(runtimeReferencesDirectory(dataDir)).length, 1);
    assert.equal(
      (
        await removeRuntime({
          version: '9.8.7',
          dataDir,
          forceUnknownReferences: true,
        })
      ).status,
      'locked',
    );
    workspace(a, runtime);
    assert.equal((await lease.value.release()).ok, true);
    const bound = await inspectRuntimeReferences(dataDir, '9.8.7');
    assert.equal(bound.active.length, 1);
    assert.equal(bound.unregisteredCoverage, 'unknown');
    const locksDirectory = join(dataDir, 'runtimes', '.locks');
    const locksBefore = statSync(locksDirectory).mtimeMs;
    const referenceBefore = statSync(lease.value.path).mtimeMs;
    const repeated = await beginRuntimeReference(a, runtime);
    assert(repeated.ok, JSON.stringify(repeated));
    assert.equal(existsSync(repeated.value.lockPath), false);
    assert.equal((await repeated.value.release()).ok, true);
    assert.equal(statSync(locksDirectory).mtimeMs, locksBefore);
    assert.equal(statSync(lease.value.path).mtimeMs, referenceBefore);
    const alias = join(root, 'data-alias');
    symlinkSync(dataDir, alias, 'dir');
    assert.equal(
      (await inspectRuntimeReferences(alias, '9.8.7')).active.length,
      1,
    );
    assert.equal(
      (
        await removeRuntime({
          version: '9.8.7',
          dataDir: alias,
          forceUnknownReferences: true,
        })
      ).status,
      'in-use',
    );
    const protectedRuntime = await removeRuntime({
      version: '9.8.7',
      dataDir,
      activeReferences: [],
      forceUnknownReferences: true,
    });
    assert.equal(protectedRuntime.status, 'in-use');
    assert.equal(existsSync(runtime.runtimeRoot), true);
    workspace(a, null);
    const unknown = await removeRuntime({
      version: '9.8.7',
      dataDir,
      activeReferences: [],
    });
    assert.equal(
      unknown.status,
      'unknown',
      'an empty caller list never establishes complete coverage',
    );
    renameSync(a, `${a}-moved`);
    const stale = await inspectRuntimeReferences(dataDir, '9.8.7');
    assert(
      stale.unknown.some((reason) =>
        reason.startsWith('workspace_missing_or_replaced'),
      ),
    );
    assert.equal(
      (await removeRuntime({ version: '9.8.7', dataDir })).status,
      'unknown',
    );
    const removed = await removeRuntime({
      version: '9.8.7',
      dataDir,
      forceUnknownReferences: true,
    });
    assert.equal(removed.status, 'removed', JSON.stringify(removed));
  } finally {
    cleanup(root);
  }
});

test('runtime GC plans without mutation and force retains registered bindings while removing an unbound version', async () => {
  const root = makeTempDir('runtime-gc');
  const dataDir = join(root, 'data');
  try {
    const used = await install(root, dataDir, '9.8.7');
    const unused = await install(root, dataDir, '9.8.8');
    const checkout = join(root, 'workspace');
    workspace(checkout, used);
    const lease = await beginRuntimeReference(checkout, used);
    assert(lease.ok);
    assert.equal((await lease.value.release()).ok, true);
    const cli = fileURLToPath(
      new URL('../../src/cli/main.js', import.meta.url),
    );
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, 'runtime', 'gc', '--json', ...args], {
        cwd: checkout,
        env: { ...process.env, PAPPRA_DATA_HOME: dataDir },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const plan = run();
    assert.equal(plan.status, 0, plan.stdout + plan.stderr);
    const planned = JSON.parse(plan.stdout) as {
      entries: { version: string; status: string }[];
    };
    assert.equal(
      planned.entries.find((entry) => entry.version === '9.8.7')?.status,
      'retained',
    );
    assert.equal(
      planned.entries.find((entry) => entry.version === '9.8.8')?.status,
      'unknown',
    );
    assert.equal(existsSync(unused.runtimeRoot), true);
    const forced = run('--apply', '--force');
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    assert.equal(existsSync(used.runtimeRoot), true);
    assert.equal(existsSync(unused.runtimeRoot), false);
  } finally {
    cleanup(root);
  }
});

test('unreadable reference entries preserve unknown coverage instead of becoming an empty list', async () => {
  const root = makeTempDir('runtime-reference-unknown');
  try {
    const directory = runtimeReferencesDirectory(root);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `sha256-${'a'.repeat(64)}.json`),
      '{incomplete',
    );
    const report = await inspectRuntimeReferences(root, '9.8.7');
    assert.equal(report.active.length, 0);
    assert(
      report.unknown.some((reason) =>
        reason.startsWith('reference_unreadable'),
      ),
    );
    assert.equal(report.unregisteredCoverage, 'unknown');
  } finally {
    cleanup(root);
  }
});
