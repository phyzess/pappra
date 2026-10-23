import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  existingInitChoices,
  inspectInitContext,
  inspectInitPathAddition,
  planWorkspaceInit,
} from '../../src/app/init.js';
import { diagnosticCodes } from '../../src/schemas/errors.js';
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

const w9RepositoryPath = 'projects/one/two/three/explicit-repo';
const w9RuntimeVersion = '0.1.0-dev.0';
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

test('reconfigure preserves extensions, continuity, custom validation and machine identity', async () => {
  const root = makeTempDir('init-plan-reconfigure-preserve');
  try {
    createRepository(root);
    writeJson(join(root, 'package.json'), {
      name: 'reconfigure-fixture',
      scripts: { test: 'echo package-test' },
    });
    const originalConfig = baseWorkspaceConfig({
      name: 'existing',
      repositories: [{ id: 'app', path: '.', access: 'write' }],
      knowledge: {
        sources: ['missing-docs'],
        newDocuments: '.pappra/knowledge',
        taskVisibility: 'private',
      },
      validation: [
        {
          id: 'app-test',
          repositoryId: 'app',
          executable: 'echo',
          args: ['custom'],
        },
      ],
      extensions: { 'pappra.test': { keep: [1, 2] } },
      continuity: { autoResume: true },
    });
    writeWorkspaceConfig(root, originalConfig);
    const originalMachine = baseMachineConfig(root, {
      selectedHosts: ['pi'],
    });
    writeMachineConfig(root, originalMachine);
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const seed = existingInitChoices(
      contextResult.context.workspaceInspection.value!,
      contextResult.context.machineInspection.value,
    );
    const prepared = await planWorkspaceInit({
      root,
      context: contextResult.context,
      choices: {
        ...seed,
        name: 'edited',
        hosts: ['codex'],
        validation: ['package-script:app:test', 'workspace-config:app-test'],
      },
      reconfigure: true,
    });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    if (!prepared.ok) return;
    const workspaceWrite = prepared.bundle.writes.find(
      (write) => write.path === '.pappra/workspace.json',
    );
    const machineWrite = prepared.bundle.writes.find(
      (write) => write.path === '.pappra/local/machine.json',
    );
    assert.notEqual(workspaceWrite, undefined);
    assert.notEqual(machineWrite, undefined);
    const workspace = JSON.parse(
      workspaceWrite!.bytes.toString('utf8'),
    ) as Record<string, unknown>;
    assert.equal(workspace.workspaceId, originalConfig.workspaceId);
    assert.deepEqual(workspace.extensions, { 'pappra.test': { keep: [1, 2] } });
    assert.deepEqual(workspace.continuity, { autoResume: true });
    assert.deepEqual((workspace.knowledge as Record<string, unknown>).sources, [
      'missing-docs',
    ]);
    const validation = workspace.validation as Array<Record<string, unknown>>;
    assert.deepEqual(
      validation.map((entry) => entry.id),
      ['app-test-2', 'app-test'],
    );
    const custom = validation.find((entry) => entry.id === 'app-test');
    assert.equal(custom?.executable, 'echo');
    assert.deepEqual(custom?.args, ['custom']);

    const machine = JSON.parse(machineWrite!.bytes.toString('utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(machine.checkoutId, originalMachine.checkoutId);
    assert.deepEqual(machine.selectedHosts, ['codex']);
    assert.equal(machine.workspaceRealpath, originalMachine.workspaceRealpath);
    assert.deepEqual(machine.externalRepositories, []);
  } finally {
    cleanup(root);
  }
});

test('configured validation stays bound to its original checkout across identity edits', async () => {
  const makeRoot = () => {
    const root = makeTempDir('init-plan-binding');
    createRepository(join(root, 'a'));
    createRepository(join(root, 'b'));
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [
          { id: 'a', path: 'a', access: 'read' },
          { id: 'b', path: 'b', access: 'read' },
        ],
        validation: [
          {
            id: 'check-a',
            repositoryId: 'a',
            executable: 'a-specific-check',
            args: ['--only-a'],
          },
          {
            id: 'check-b',
            repositoryId: 'b',
            executable: 'b-specific-check',
            args: ['--only-b'],
          },
        ],
      }),
    );
    return root;
  };
  const renameRoot = makeRoot();
  const swapRoot = makeRoot();
  const reuseRoot = makeRoot();
  try {
    const renameContext = await inspectInitContext(renameRoot);
    assert.equal(renameContext.ok, true);
    if (!renameContext.ok) return;
    const renameSeed = existingInitChoices(
      renameContext.context.workspaceInspection.value!,
      renameContext.context.machineInspection.value,
    );
    const renamed = await planWorkspaceInit({
      root: renameRoot,
      context: renameContext.context,
      choices: {
        ...renameSeed,
        repositories: [{ path: 'a', id: 'renamed', access: 'read' }],
        validation: ['workspace-config:check-a'],
      },
      reconfigure: true,
    });
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    if (!renamed.ok) return;
    assert.deepEqual(renamed.bundle.scope.validation, [
      {
        id: 'check-a',
        repositoryId: 'renamed',
        executable: 'a-specific-check',
        args: ['--only-a'],
      },
    ]);

    const swapContext = await inspectInitContext(swapRoot);
    assert.equal(swapContext.ok, true);
    if (!swapContext.ok) return;
    const swapSeed = existingInitChoices(
      swapContext.context.workspaceInspection.value!,
      swapContext.context.machineInspection.value,
    );
    const swapped = await planWorkspaceInit({
      root: swapRoot,
      context: swapContext.context,
      choices: {
        ...swapSeed,
        repositories: [
          { path: 'b', id: 'a', access: 'read' },
          { path: 'a', id: 'b', access: 'read' },
        ],
        validation: ['workspace-config:check-a', 'workspace-config:check-b'],
      },
      reconfigure: true,
    });
    assert.equal(swapped.ok, true, JSON.stringify(swapped));
    if (!swapped.ok) return;
    const swappedValidation = swapped.bundle.scope.validation;
    assert.equal(
      swappedValidation.find((entry) => entry.id === 'check-a')?.repositoryId,
      'b',
    );
    assert.equal(
      swappedValidation.find((entry) => entry.id === 'check-b')?.repositoryId,
      'a',
    );
    assert.deepEqual(
      swappedValidation.find((entry) => entry.id === 'check-a')?.args,
      ['--only-a'],
    );

    const reuseContext = await inspectInitContext(reuseRoot);
    assert.equal(reuseContext.ok, true);
    if (!reuseContext.ok) return;
    const reuseSeed = existingInitChoices(
      reuseContext.context.workspaceInspection.value!,
      reuseContext.context.machineInspection.value,
    );
    const reused = await planWorkspaceInit({
      root: reuseRoot,
      context: reuseContext.context,
      choices: {
        ...reuseSeed,
        repositories: [{ path: 'b', id: 'a', access: 'read' }],
        validation: ['workspace-config:check-a'],
      },
      reconfigure: true,
    });
    assert.equal(reused.ok, false);
    assert.equal(reused.status, 'invalid');
    assert.equal(
      reused.diagnostics.some(
        (entry) =>
          entry.code === 'init_validation_unbound' &&
          entry.severity === 'error',
      ),
      true,
    );
  } finally {
    cleanup(renameRoot);
    cleanup(swapRoot);
    cleanup(reuseRoot);
  }
});

test('reconfigure fails when a selected existing validation loses its repository', async () => {
  const root = makeTempDir('init-plan-reconfigure-unbound');
  try {
    createRepository(root);
    const config = baseWorkspaceConfig({
      repositories: [{ id: 'app', path: '.', access: 'write' }],
      validation: [
        {
          id: 'custom',
          repositoryId: 'app',
          executable: 'echo',
          args: ['custom'],
        },
      ],
    });
    writeWorkspaceConfig(root, config);
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const seed = existingInitChoices(
      contextResult.context.workspaceInspection.value!,
      contextResult.context.machineInspection.value,
    );
    const prepared = await planWorkspaceInit({
      root,
      context: contextResult.context,
      choices: {
        ...seed,
        repositories: [],
        validation: ['workspace-config:custom'],
      },
      reconfigure: true,
    });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.status, 'invalid');
    assert.equal(
      prepared.diagnostics.some(
        (entry) =>
          entry.code === 'init_validation_unbound' &&
          entry.severity === 'error',
      ),
      true,
    );
  } finally {
    cleanup(root);
  }
});
test('reconfigure rejects a conflicting workspace identity', async () => {
  const root = makeTempDir('init-plan-reconfigure-id');
  try {
    createRepository(root);
    const originalConfig = baseWorkspaceConfig({
      name: 'existing',
      repositories: [{ id: 'app', path: '.', access: 'write' }],
    });
    writeWorkspaceConfig(root, originalConfig);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        workspaceId: '44444444-4444-4444-8444-444444444444',
      }),
      reconfigure: true,
    });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.status, 'invalid');
    assert.match(prepared.message, /cannot change workspaceId/);
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
        (entry) => entry.code === 'repository_nested_workspace',
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

test('plans explicit undiscovered repository and empty knowledge paths through app authority', async () => {
  const root = makeTempDir('init-plan-explicit-paths');
  try {
    const repositoryRoot = join(root, w9RepositoryPath);
    createRepository(repositoryRoot);
    mkdirSync(join(root, 'notes', 'empty'), { recursive: true });
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    assert.equal(
      contextResult.context.discovery.repositories.some(
        (repository) => repository.relativePath === w9RepositoryPath,
      ),
      false,
    );
    const before = snapshotTree(root);
    const prepared = await planWorkspaceInit({
      root,
      context: contextResult.context,
      choices: baseInitChoices({
        repositories: [{ path: w9RepositoryPath, access: 'read' }],
        knowledge: {
          sources: ['notes/empty'],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
        },
      }),
      runtimeVersion: w9RuntimeVersion,
    });

    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    if (!prepared.ok) return;
    assert.equal(prepared.bundle.scope.repositories[0]?.path, w9RepositoryPath);
    assert.equal(
      prepared.bundle.scope.repositories[0]?.root,
      realpath(repositoryRoot),
    );
    assert.deepEqual(prepared.bundle.scope.knowledge.sources, ['notes/empty']);
    const workspaceWrite = prepared.bundle.writes.find(
      (write) => write.path === '.pappra/workspace.json',
    );
    assert(workspaceWrite !== undefined);
    const config = JSON.parse(workspaceWrite.bytes.toString('utf8')) as {
      readonly repositories: readonly { readonly path: string }[];
      readonly knowledge: { readonly sources: readonly string[] };
    };
    assert.deepEqual(
      config.repositories.map((repository) => repository.path),
      [w9RepositoryPath],
    );
    assert.deepEqual(config.knowledge.sources, ['notes/empty']);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('reconfigure retains unavailable sources, allocates a collision-free id, and preserves validation binding', async () => {
  const root = makeTempDir('init-plan-explicit-reconfigure');
  try {
    createRepository(root);
    createRepository(join(root, w9RepositoryPath));
    mkdirSync(join(root, 'notes', 'empty'), { recursive: true });
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        name: 'before reconfigure',
        repositories: [{ id: 'explicit-repo', path: '.', access: 'write' }],
        knowledge: {
          sources: ['legacy/missing.md'],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
        },
        validation: [
          {
            id: 'bound-check',
            repositoryId: 'explicit-repo',
            executable: 'echo',
            args: ['check'],
          },
        ],
      }),
    );
    writeMachineConfig(root, baseMachineConfig(root, { selectedHosts: [] }));
    const before = snapshotTree(root);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        name: 'after reconfigure',
        repositories: [
          { path: '.', id: 'explicit-repo', access: 'write' },
          { path: w9RepositoryPath, access: 'read' },
        ],
        knowledge: {
          sources: ['legacy/missing.md', 'notes/empty'],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
        },
        validation: ['workspace-config:bound-check'],
        hosts: [],
      }),
      reconfigure: true,
      runtimeVersion: w9RuntimeVersion,
    });

    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    if (!prepared.ok) return;
    const workspaceWrite = prepared.bundle.writes.find(
      (write) => write.path === '.pappra/workspace.json',
    );
    assert(workspaceWrite !== undefined);
    const config = JSON.parse(workspaceWrite.bytes.toString('utf8')) as {
      readonly repositories: readonly {
        readonly id: string;
        readonly path: string;
      }[];
      readonly knowledge: { readonly sources: readonly string[] };
      readonly validation: readonly {
        readonly id: string;
        readonly repositoryId: string;
      }[];
    };
    const original = config.repositories.find(
      (repository) => repository.path === '.',
    );
    const added = config.repositories.find(
      (repository) => repository.path === w9RepositoryPath,
    );
    assert.equal(original?.id, 'explicit-repo');
    assert(added !== undefined);
    assert.notEqual(added.id, original?.id);
    assert.equal(
      new Set(config.repositories.map((repository) => repository.id)).size,
      2,
    );
    assert.deepEqual(config.knowledge.sources, [
      'legacy/missing.md',
      'notes/empty',
    ]);
    assert.deepEqual(config.validation, [
      {
        id: 'bound-check',
        repositoryId: 'explicit-repo',
        executable: 'echo',
        args: ['check'],
      },
    ]);
    assert(
      prepared.bundle.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === diagnosticCodes.initKnowledgeUnknown &&
          diagnostic.severity === 'warning',
      ),
    );
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('normal init reuses existing config without inspecting new selection strings', async () => {
  const root = makeTempDir('init-plan-explicit-normal-reuse');
  try {
    writeWorkspaceConfig(root, baseWorkspaceConfig({ repositories: [] }));
    writeMachineConfig(root, baseMachineConfig(root));
    const before = snapshotTree(root);
    const prepared = await planWorkspaceInit({
      root,
      choices: baseInitChoices({
        repositories: [{ path: 'future/repository', access: 'read' }],
        knowledge: {
          sources: ['future/knowledge.md'],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
        },
      }),
      runtimeVersion: w9RuntimeVersion,
    });

    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    if (!prepared.ok) return;
    assert.equal(prepared.bundle.scope.configSource, 'existing');
    assert.deepEqual(prepared.bundle.scope.repositories, []);
    assert.deepEqual(prepared.bundle.scope.knowledge.sources, []);
    assert.deepEqual(prepared.bundle.plan.files, []);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('path identity drift is rejected before producing a plan', async () => {
  const root = makeTempDir('init-plan-explicit-path-stale');
  try {
    const workspaceRoot = realpath(root);
    const sourcePath = join(workspaceRoot, 'notes', 'source.md');
    writeText(sourcePath, '# initial\n');
    const observation = await inspectInitPathAddition(
      workspaceRoot,
      'knowledge',
      'notes/source.md',
    );
    assert.equal(observation.ok, true);
    if (!observation.ok) return;
    const replacement = join(root, 'notes', 'replacement.md');
    writeText(replacement, '# replacement\n');
    renameSync(replacement, sourcePath);
    const before = snapshotTree(root);
    const prepared = await planWorkspaceInit({
      root: workspaceRoot,
      choices: baseInitChoices({
        knowledge: {
          sources: ['notes/source.md'],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
        },
      }),
      pathObservations: [observation.observation],
      runtimeVersion: w9RuntimeVersion,
    });

    assert.equal(prepared.ok, false);
    if (prepared.ok) return;
    assert.equal(prepared.status, 'conflict');
    assert(
      prepared.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.initPlanStale,
      ),
    );
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('explicit path planning rejects unsafe containment, exclusions, nested workspaces and duplicate checkouts', async () => {
  const root = makeTempDir('init-plan-explicit-path-invalid');
  const outside = makeTempDir('init-plan-explicit-path-outside');
  try {
    writeText(join(outside, 'secret.md'), 'outside\n');
    symlinkSync(join(outside, 'secret.md'), join(root, 'escape.md'));
    mkdirSync(join(root, 'excluded', 'empty'), { recursive: true });
    mkdirSync(join(root, 'nested', 'docs'), { recursive: true });
    writeWorkspaceConfig(
      join(root, 'nested'),
      baseWorkspaceConfig({ name: 'nested' }),
    );
    const checkout = join(root, 'repos', 'main');
    createRepository(checkout);
    mkdirSync(join(checkout, 'subdirectory'), { recursive: true });
    createRepository(join(root, 'excluded', 'repository'));
    createRepository(join(root, w9RepositoryPath));
    const absolutePath = join(root, 'absolute.md');
    writeText(absolutePath, 'absolute\n');
    const cases: readonly {
      readonly name: string;
      readonly choices: ReturnType<typeof baseInitChoices>;
      readonly code?: string;
    }[] = [
      {
        name: 'parent traversal',
        choices: baseInitChoices({
          knowledge: {
            sources: ['../outside/secret.md'],
            newDocuments: '.pappra/knowledge',
            taskVisibility: 'private',
          },
        }),
      },
      {
        name: 'absolute path',
        choices: baseInitChoices({
          knowledge: {
            sources: [absolutePath],
            newDocuments: '.pappra/knowledge',
            taskVisibility: 'private',
          },
        }),
      },
      {
        name: 'outward symlink',
        choices: baseInitChoices({
          knowledge: {
            sources: ['escape.md'],
            newDocuments: '.pappra/knowledge',
            taskVisibility: 'private',
          },
        }),
        code: diagnosticCodes.knowledgeSourceSymlinkEscape,
      },
      {
        name: 'knowledge exclusion',
        choices: baseInitChoices({
          knowledge: {
            sources: ['excluded/empty'],
            newDocuments: '.pappra/knowledge',
            taskVisibility: 'private',
          },
          excludes: ['excluded'],
        }),
        code: diagnosticCodes.initKnowledgeUnknown,
      },
      {
        name: 'repository exclusion',
        choices: baseInitChoices({
          repositories: [{ path: 'excluded/repository', access: 'read' }],
          excludes: ['excluded'],
        }),
        code: diagnosticCodes.initRepositoryUnknown,
      },
      {
        name: 'nested workspace',
        choices: baseInitChoices({
          knowledge: {
            sources: ['nested/docs'],
            newDocuments: '.pappra/knowledge',
            taskVisibility: 'private',
          },
        }),
        code: diagnosticCodes.discoveryNestedWorkspace,
      },
      {
        name: 'not an exact checkout root',
        choices: baseInitChoices({
          repositories: [{ path: 'repos/main/subdirectory', access: 'read' }],
        }),
        code: diagnosticCodes.repositoryNotGit,
      },
      {
        name: 'canonical duplicate checkout',
        choices: baseInitChoices({
          repositories: [
            { path: w9RepositoryPath, access: 'read' },
            {
              path: 'projects/one/two/three/../three/explicit-repo',
              access: 'read',
            },
          ],
        }),
        code: diagnosticCodes.initRepositoryDuplicate,
      },
    ];

    for (const entry of cases) {
      const before = snapshotTree(root);
      const prepared = await planWorkspaceInit({
        root,
        choices: entry.choices,
        runtimeVersion: w9RuntimeVersion,
      });
      assert.equal(prepared.ok, false, entry.name);
      if (prepared.ok) continue;
      if (entry.code !== undefined) {
        assert(
          prepared.diagnostics.some(
            (diagnostic) => diagnostic.code === entry.code,
          ),
          `${entry.name}: ${JSON.stringify(prepared.diagnostics)}`,
        );
      }
      assert.deepEqual(
        snapshotTree(root),
        before,
        `${entry.name} performs no writes`,
      );
    }
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});
