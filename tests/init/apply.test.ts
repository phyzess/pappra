import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import {
  applyInitPlan,
  inspectInitContext,
  planWorkspaceInit,
} from '../../src/app/init.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  linkDirectory,
  makeTempDir,
  snapshotTree,
  writeJson,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';
import { baseInitChoices } from './fixtures.js';

test('applies a new plan with exclusive create and reports pending runtime actions', async () => {
  const root = makeTempDir('init-apply-new');
  try {
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
      runtimeVersion: '0.1.0-dev.0',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const before = snapshotTree(root);
    const applied = await applyInitPlan(prepared.bundle);
    assert.equal(applied.ok, true);
    assert.equal(applied.status, 'external-actions-pending');
    assert.deepEqual(applied.appliedFiles, [
      '.pappra/workspace.json',
      '.pappra/local/machine.json',
    ]);
    assert.deepEqual(applied.pendingExternalActions, [
      {
        kind: 'install-runtime',
        target: 'pappra',
        version: '0.1.0-dev.0',
      },
    ]);
    assert.notDeepEqual(snapshotTree(root), before);
    const workspace = JSON.parse(
      readFileSync(join(root, '.pappra', 'workspace.json'), 'utf8'),
    );
    assert.equal(workspace.schema, 'pappra/workspace/1');
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'machine.json')),
      true,
    );

    const repeatedPlan = await planWorkspaceInit({ root });
    assert.equal(repeatedPlan.ok, true);
    if (!repeatedPlan.ok) return;
    assert.deepEqual(repeatedPlan.bundle.plan.files, []);
    assert.deepEqual(repeatedPlan.bundle.plan.externalActions, [
      {
        kind: 'install-runtime',
        target: 'pappra',
        version: '0.1.0-dev.0',
      },
    ]);
    const pending = await applyInitPlan(repeatedPlan.bundle);
    assert.equal(pending.ok, true);
    assert.equal(pending.status, 'external-actions-pending');
    assert.deepEqual(pending.appliedFiles, []);

    const machinePath = join(root, '.pappra', 'local', 'machine.json');
    const machine = JSON.parse(readFileSync(machinePath, 'utf8'));
    machine.runtime = {
      version: '0.1.0-dev.0',
      executable: process.execPath,
      verifiedAt: '2026-10-17T00:00:00.000Z',
    };
    writeFileSync(machinePath, `${JSON.stringify(machine, null, 2)}\n`);
    const settledPlan = await planWorkspaceInit({ root });
    assert.equal(settledPlan.ok, true);
    if (!settledPlan.ok) return;
    assert.deepEqual(settledPlan.bundle.plan.externalActions, []);
    const noChanges = await applyInitPlan(settledPlan.bundle);
    assert.equal(noChanges.ok, true);
    assert.equal(noChanges.status, 'no-changes');
  } finally {
    cleanup(root);
  }
});

test('refuses to apply an old plan after configuration changes', async () => {
  const root = makeTempDir('init-apply-stale-config');
  try {
    createRepository(root);
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        name: 'before',
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({ hosts: ['pi'] }),
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        name: 'changed',
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    const applied = await applyInitPlan(prepared.bundle);
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'stale');
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'machine.json')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('refuses to overwrite a target that appeared after planning', async () => {
  const root = makeTempDir('init-apply-target');
  try {
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    writeWorkspaceConfig(root, baseWorkspaceConfig({ name: 'appeared' }));
    const applied = await applyInitPlan(prepared.bundle);
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'conflict');
    assert.equal(applied.diagnostics[0]?.code, 'init_target_exists');
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'machine.json')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('rejects a plan after the workspace root identity changes', async () => {
  const root = makeTempDir('init-apply-root');
  const moved = `${root}-moved`;
  try {
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    renameSync(root, moved);
    const applied = await applyInitPlan(prepared.bundle);
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'stale');
    assert.deepEqual(applied.appliedFiles, []);
    assert.equal(existsSync(join(moved, '.pappra', 'workspace.json')), false);
  } finally {
    cleanup(root);
    cleanup(moved);
  }
});

test('rejects tampered in-memory bytes before writing', async () => {
  const root = makeTempDir('init-apply-tamper');
  try {
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const tampered = {
      ...prepared.bundle,
      writes: prepared.bundle.writes.map((write, index) =>
        index === 0
          ? { ...write, bytes: Buffer.from('{"tampered":true}\n') }
          : write,
      ),
    };
    const applied = await applyInitPlan(tampered);
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'stale');
    assert.equal(existsSync(join(root, '.pappra', 'workspace.json')), false);
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'machine.json')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('does not follow a symlinked .pappra outside the workspace', async () => {
  const root = makeTempDir('init-apply-symlink');
  const outside = makeTempDir('init-apply-symlink-outside');
  try {
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    linkDirectory(outside, join(root, '.pappra'));
    const applied = await applyInitPlan(prepared.bundle);
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'conflict');
    assert.equal(applied.diagnostics[0]?.code, 'init_target_unsafe');
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('rejects an old empty plan when existing configuration changes', async () => {
  const root = makeTempDir('init-apply-empty-stale');
  try {
    createRepository(root);
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        name: 'complete',
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    writeMachineConfig(
      root,
      baseMachineConfig(root, { selectedHosts: ['pi'] }),
    );
    const prepared = await planWorkspaceInit({ root });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.deepEqual(prepared.bundle.plan.files, []);
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        name: 'changed',
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    const applied = await applyInitPlan(prepared.bundle);
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'stale');
  } finally {
    cleanup(root);
  }
});

test('code graph and host choices do not execute installs, indexes, scripts, or wiring', async () => {
  const root = makeTempDir('init-apply-preferences');
  try {
    createRepository(root);
    const marker = join(root, 'script-ran.txt');
    writeJson(join(root, 'package.json'), {
      name: 'fixture',
      scripts: {
        test: `node -e "require('node:fs').writeFileSync('script-ran.txt','ran')"`,
      },
    });
    writeText(join(root, 'pnpm-lock.yaml'), '');
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const context = contextResult.context;
    const candidate = context.discovery.validationCandidates.find(
      (entry) => entry.args[1] === 'test',
    );
    assert(candidate !== undefined);
    const before = snapshotTree(root);
    const prepared = await planWorkspaceInit({
      root,
      context,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'read' }],
        validation: [candidate.id],
        code: { graph: 'codegraph', symbols: 'serena', prepare: 'manual' },
        hosts: ['pi', 'codex', 'claude'],
      }),
      runtimeVersion: '0.1.0-dev.0',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.deepEqual(prepared.bundle.plan.externalActions, [
      {
        kind: 'install-runtime',
        target: 'pappra',
        version: '0.1.0-dev.0',
      },
    ]);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(root, '.codegraph')), false);
    assert.deepEqual(snapshotTree(root), before);

    const applied = await applyInitPlan(prepared.bundle);
    assert.equal(applied.ok, true);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(root, '.codegraph')), false);
    assert.deepEqual(applied.pendingExternalActions, [
      {
        kind: 'install-runtime',
        target: 'pappra',
        version: '0.1.0-dev.0',
      },
    ]);
    const machine = JSON.parse(
      readFileSync(join(root, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.deepEqual(machine.selectedHosts, ['pi', 'codex', 'claude']);
    const workspace = JSON.parse(
      readFileSync(join(root, '.pappra', 'workspace.json'), 'utf8'),
    );
    assert.deepEqual(workspace.code, {
      graph: 'codegraph',
      symbols: 'serena',
      prepare: 'manual',
    });
  } finally {
    cleanup(root);
  }
});

test('does not delete a user file that appeared before the exclusive create', async () => {
  const root = makeTempDir('init-apply-race-user');
  try {
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const userPath = join(root, '.pappra', 'workspace.json');
    const applied = await applyInitPlan(prepared.bundle, {
      beforeWrite: async (path, index) => {
        if (index === 0 && path === '.pappra/workspace.json') {
          mkdirSync(join(root, '.pappra'), { recursive: true });
          writeFileSync(userPath, 'user file\n');
        }
      },
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'conflict');
    assert.deepEqual(applied.residualPaths, []);
    assert.equal(readFileSync(userPath, 'utf8'), 'user file\n');
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'machine.json')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('reports residual files when cleanup cannot prove its own content and identity', async () => {
  const root = makeTempDir('init-apply-residual');
  try {
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const workspacePath = join(root, '.pappra', 'workspace.json');
    const machinePath = join(root, '.pappra', 'local', 'machine.json');
    const applied = await applyInitPlan(prepared.bundle, {
      beforeWrite: async (_path, index) => {
        if (index !== 1) return;
        writeFileSync(workspacePath, 'user changed first file\n');
        mkdirSync(join(root, '.pappra', 'local'), { recursive: true });
        writeFileSync(machinePath, 'user machine file\n');
      },
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'conflict');
    assert.deepEqual(applied.residualPaths, ['.pappra/workspace.json']);
    assert.equal(
      readFileSync(workspacePath, 'utf8'),
      'user changed first file\n',
    );
    assert.equal(readFileSync(machinePath, 'utf8'), 'user machine file\n');
    assert(
      applied.diagnostics.some((entry) => entry.code === 'init_apply_residual'),
    );
  } finally {
    cleanup(root);
  }
});

test('rejects an old plan when the same path is replaced by a new directory', async () => {
  const root = makeTempDir('init-apply-root-replaced');
  const old = `${root}-old`;
  try {
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    renameSync(root, old);
    mkdirSync(root, { recursive: true });
    const applied = await applyInitPlan(prepared.bundle);
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'stale');
    assert.equal(existsSync(join(root, '.pappra', 'workspace.json')), false);
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'machine.json')),
      false,
    );
  } finally {
    cleanup(root);
    cleanup(old);
  }
});
