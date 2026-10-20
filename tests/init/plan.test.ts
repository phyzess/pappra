import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { inspectInitContext, planWorkspaceInit } from '../../src/app/init.js';
import { inspectWorkspaceConfig } from '../../src/workspace/index.js';
import {
  baseWorkspaceConfig,
  baseMachineConfig,
  cleanup,
  createRepository,
  makeTempDir,
  realpath,
  snapshotTree,
  writeJson,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';
import { baseInitChoices } from './fixtures.js';

const fixedPlanId = '33333333-3333-4333-8333-333333333333';
const fixedDiscoveredAt = '2026-10-17T00:00:00.000Z';

test('plans an empty directory without writing target files', async () => {
  const root = makeTempDir('init-plan-empty');
  try {
    const before = snapshotTree(root);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({ name: 'empty workspace' }),
      runtimeVersion: '0.1.0-dev.0',
      planId: fixedPlanId,
      discoveredAt: fixedDiscoveredAt,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const { plan, scope, writes } = prepared.bundle;
    assert.equal(plan.schema, 'pappra/init-plan/1');
    assert.deepEqual(
      plan.files.map((file) => file.path),
      ['.pappra/workspace.json', '.pappra/local/machine.json'],
    );
    assert(
      plan.files.every(
        (file) =>
          file.operation === 'create' &&
          file.expectedBeforeDigest === null &&
          file.owner === 'pappra',
      ),
    );
    assert.equal(plan.configurationDigest, plan.files[0]?.nextDigest);
    assert.deepEqual(plan.externalActions, [
      {
        kind: 'install-runtime',
        target: 'pappra',
        version: '0.1.0-dev.0',
      },
    ]);
    assert.equal(scope.configSource, 'planned');
    assert.deepEqual(scope.hosts, ['pi']);
    assert.equal(writes.length, 2);
    assert(writes[0]?.diff.includes('+++ b/.pappra/workspace.json'));
    const workspace = JSON.parse(writes[0]?.bytes.toString('utf8') ?? '{}');
    assert.equal(workspace.name, 'empty workspace');
    assert.equal(workspace.schema, 'pappra/workspace/1');
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('plans a single repository without writing or executing scripts', async () => {
  const root = makeTempDir('init-plan-single');
  try {
    createRepository(root);
    writeText(join(root, 'README.md'), '# single\n');
    const before = snapshotTree(root);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: '.', access: 'write' }],
        knowledge: {
          sources: ['README.md'],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
        },
      }),
      runtimeVersion: '0.1.0-dev.0',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal(prepared.bundle.scope.configSource, 'planned');
    assert.equal(prepared.bundle.scope.repositories.length, 1);
    assert.equal(prepared.bundle.scope.repositories[0]?.path, '.');
    assert.equal(prepared.bundle.scope.repositories[0]?.access, 'write');
    assert.equal(prepared.bundle.scope.repositories[0]?.kind, 'regular');
    const config = JSON.parse(
      prepared.bundle.writes[0]?.bytes.toString('utf8') ?? '{}',
    );
    assert.equal(config.repositories[0].path, '.');
    assert.equal(config.repositories[0].access, 'write');
    assert.deepEqual(config.knowledge.sources, ['README.md']);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('maps selected validation candidates to selected repositories', async () => {
  const root = makeTempDir('init-plan-validation');
  try {
    createRepository(join(root, 'apps', 'api'));
    createRepository(join(root, 'libs', 'shared'));
    writeJson(join(root, 'apps', 'api', 'package.json'), {
      name: 'api',
      scripts: { test: 'echo test', lint: 'echo lint' },
    });
    writeText(join(root, 'apps', 'api', 'pnpm-lock.yaml'), '');
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const context = contextResult.context;
    const candidate = context.discovery.validationCandidates.find(
      (entry) => entry.args[1] === 'test',
    );
    assert(candidate !== undefined);
    const prepared = await planWorkspaceInit({
      root,
      context,
      choices: baseInitChoices({
        repositories: [{ path: 'apps/api', access: 'read' }],
        validation: [candidate.id],
      }),
      runtimeVersion: '0.1.0-dev.0',
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const config = JSON.parse(
      prepared.bundle.writes[0]?.bytes.toString('utf8') ?? '{}',
    );
    assert.equal(config.repositories[0].path, 'apps/api');
    assert.equal(config.repositories[0].access, 'read');
    assert.equal(config.validation[0].repositoryId, config.repositories[0].id);
    assert.equal(config.validation[0].executable, 'pnpm');
    assert.deepEqual(config.validation[0].args, ['run', 'test']);
  } finally {
    cleanup(root);
  }
});

test('reuses existing configuration and creates only missing machine state', async () => {
  const root = makeTempDir('init-plan-existing');
  try {
    createRepository(root);
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        name: 'existing',
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    const missingMachine = await planWorkspaceInit({
      root,
      choices: baseInitChoices({ hosts: ['codex'] }),
      runtimeVersion: '0.1.0-dev.0',
    });
    assert.equal(missingMachine.ok, true);
    if (!missingMachine.ok) return;
    assert.deepEqual(
      missingMachine.bundle.plan.files.map((file) => file.path),
      ['.pappra/local/machine.json'],
    );
    const configInspection = await inspectWorkspaceConfig(root);
    assert.equal(
      missingMachine.bundle.plan.configurationDigest,
      configInspection.digest,
    );
    const machine = JSON.parse(
      missingMachine.bundle.writes[0]?.bytes.toString('utf8') ?? '{}',
    );
    assert.deepEqual(machine.selectedHosts, ['codex']);
    assert.equal(machine.workspaceRealpath, realpath(root));

    writeMachineConfig(
      root,
      baseMachineConfig(root, { selectedHosts: ['codex'] }),
    );
    const before = snapshotTree(root);
    const complete = await planWorkspaceInit({
      root,
      runtimeVersion: '0.1.0-dev.0',
    });
    assert.equal(complete.ok, true);
    if (!complete.ok) return;
    assert.deepEqual(complete.bundle.plan.files, []);
    assert.deepEqual(complete.bundle.plan.externalActions, [
      {
        kind: 'install-runtime',
        target: 'pappra',
        version: '0.1.0-dev.0',
      },
    ]);
    assert.equal(complete.bundle.scope.configSource, 'existing');
    assert.deepEqual(complete.bundle.scope.hosts, ['codex']);
    assert.deepEqual(snapshotTree(root), before);

    writeMachineConfig(
      root,
      baseMachineConfig(root, {
        selectedHosts: ['codex'],
        runtime: {
          version: '0.1.0-dev.0',
          executable: process.execPath,
          verifiedAt: '2026-10-17T00:00:00.000Z',
        },
      }),
    );
    const verified = await planWorkspaceInit({ root });
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.deepEqual(verified.bundle.plan.files, []);
    assert.deepEqual(verified.bundle.plan.externalActions, []);
  } finally {
    cleanup(root);
  }
});

test('fails closed when init selections are missing or reference nested repositories', async () => {
  const root = makeTempDir('init-plan-missing');
  try {
    createRepository(root);
    const missing = await planWorkspaceInit({ root });
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.equal(missing.status, 'needs_input');
    assert.equal(missing.code, 'init_input_required');
  } finally {
    cleanup(root);
  }

  const outer = makeTempDir('init-plan-nested');
  try {
    const inner = join(outer, 'inner');
    createRepository(inner);
    writeWorkspaceConfig(inner, baseWorkspaceConfig({ name: 'inner' }));
    const prepared = await planWorkspaceInit({
      root: outer,
      choices: baseInitChoices({
        repositories: [{ path: 'inner', access: 'read' }],
      }),
    });
    assert.equal(prepared.ok, false);
    if (prepared.ok) return;
    assert.equal(prepared.status, 'invalid');
    assert(
      prepared.diagnostics.some(
        (entry) => entry.code === 'init_repository_unknown',
      ),
    );
  } finally {
    cleanup(outer);
  }
});

test('reuses a read-only external repository from existing local state', async () => {
  const root = makeTempDir('init-plan-external');
  const external = makeTempDir('init-plan-external-repo');
  try {
    createRepository(external);
    writeText(join(external, 'README.md'), '# external\n');
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [
          { id: 'dependency', path: 'external:dependency', access: 'read' },
        ],
      }),
    );
    writeMachineConfig(
      root,
      baseMachineConfig(root, {
        externalRepositories: [{ id: 'dependency', path: external }],
      }),
    );
    const before = snapshotTree(root);
    const externalBefore = snapshotTree(external);
    const prepared = await planWorkspaceInit({ root });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.deepEqual(prepared.bundle.plan.files, []);
    const repository = prepared.bundle.scope.repositories[0];
    assert(repository !== undefined);
    assert.equal(repository.id, 'dependency');
    assert.equal(repository.external, true);
    assert.equal(repository.access, 'read');
    assert.equal(repository.root, realpath(external));
    assert.deepEqual(snapshotTree(root), before);
    assert.deepEqual(snapshotTree(external), externalBefore);
  } finally {
    cleanup(root);
    cleanup(external);
  }
});

test('reports invalid existing configuration before planning', async () => {
  const root = makeTempDir('init-plan-invalid');
  try {
    writeText(join(root, '.pappra', 'workspace.json'), '{broken');
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
    });
    assert.equal(prepared.ok, false);
    if (prepared.ok) return;
    assert.equal(prepared.status, 'invalid');
    assert.equal(prepared.code, 'config_invalid_json');
  } finally {
    cleanup(root);
  }
});

test('rejects a context whose root directory was replaced after discovery', async () => {
  const root = makeTempDir('init-plan-context-replaced');
  const old = `${root}-old`;
  try {
    createRepository(root);
    writeText(join(root, 'README.md'), '# original\n');
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    renameSync(root, old);
    mkdirSync(root, { recursive: true });

    const prepared = await planWorkspaceInit({
      root,
      context: contextResult.context,
      choices: baseInitChoices(),
    });
    assert.equal(prepared.ok, false);
    if (prepared.ok) return;
    assert.equal(prepared.status, 'conflict');
    assert.equal(prepared.code, 'init_plan_stale');
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
