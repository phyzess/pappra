import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { discoverWorkspace } from '../../src/workspace/index.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  linkDirectory,
  makeTempDir,
  realpath,
  snapshotTree,
  writeJson,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from './fixtures.js';

function codes(value: {
  readonly diagnostics: readonly { readonly code: string }[];
}): string[] {
  return value.diagnostics.map((entry) => entry.code);
}

test('resolves an explicit external mapping as read-only without writing either tree', async () => {
  const root = makeTempDir('knowledge-external');
  const external = makeTempDir('knowledge-external-repo');
  try {
    createRepository(external);
    writeText(join(external, 'README.md'), '# external docs\n');
    writeText(
      join(external, '.pappra', 'workspace.json'),
      JSON.stringify(baseWorkspaceConfig({ name: 'external-workspace' })),
    );
    writeText(join(external, 'docs', 'guide.md'), '# external guide\n');
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
        externalRepositories: [{ id: 'dependency', path: realpath(external) }],
      }),
    );
    const workspaceBefore = snapshotTree(root);
    const externalBefore = snapshotTree(external);

    let result = await discoverWorkspace(root);
    assert.equal(result.machineState, 'valid');
    const repository = result.repositories.find(
      (entry) => entry.id === 'dependency',
    );
    assert(repository !== undefined);
    assert.equal(repository.external, true);
    assert.equal(repository.access, 'read');
    assert.equal(repository.relativePath, null);
    assert.equal(repository.root, realpath(external));
    const externalDocument = result.documents.find(
      (entry) => entry.path === realpath(join(external, 'README.md')),
    );
    assert(externalDocument !== undefined);
    assert.equal(externalDocument.repositoryId, 'dependency');
    assert.equal(externalDocument.workspaceRelativePath, null);
    const externalGuide = result.documents.find(
      (entry) => entry.path === realpath(join(external, 'docs', 'guide.md')),
    );
    assert(externalGuide !== undefined);
    assert.equal(externalGuide.repositoryId, 'dependency');
    assert.deepEqual(snapshotTree(root), workspaceBefore);
    assert.deepEqual(snapshotTree(external), externalBefore);

    writeMachineConfig(
      root,
      baseMachineConfig(root, {
        workspaceRealpath: realpath(external),
      }),
    );
    result = await discoverWorkspace(root);
    assert.equal(result.machineState, 'invalid');
    assert.equal(result.repositories.length, 0);
    assert.equal(result.unresolvedRepositories.length, 1);
    const found = codes(result);
    assert(found.includes('machine_workspace_mismatch'));
    assert(found.includes('external_repository_unmapped'));

    rmSync(join(root, '.pappra', 'local', 'machine.json'));
    result = await discoverWorkspace(root);
    assert.equal(result.machineState, 'missing');
    assert(codes(result).includes('external_repository_unmapped'));
    assert.equal(result.repositories.length, 0);
  } finally {
    cleanup(root);
    cleanup(external);
  }
});

test('rejects a workspace repository symlink that escapes and allows one that stays inside', async () => {
  const root = makeTempDir('knowledge-symlink');
  const outside = makeTempDir('knowledge-symlink-outside');
  try {
    createRepository(join(root, 'actual'));
    createRepository(outside);
    linkDirectory(outside, join(root, 'outbound'));
    linkDirectory(join(root, 'actual'), join(root, 'alias'));
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [
          { id: 'outbound', path: 'outbound', access: 'read' },
          { id: 'alias', path: 'alias', access: 'read' },
        ],
      }),
    );

    const result = await discoverWorkspace(root);
    assert(codes(result).includes('repository_symlink_escape'));
    assert.equal(
      result.repositories.some((entry) => entry.id === 'outbound'),
      false,
    );
    const alias = result.repositories.find((entry) => entry.id === 'alias');
    assert(alias !== undefined);
    assert.equal(alias.root, realpath(join(root, 'actual')));
    assert.equal(alias.relativePath, 'actual');
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('finds rules and docs in place and filters gitignored documents', async () => {
  const root = makeTempDir('knowledge-documents');
  try {
    createRepository(root);
    writeText(join(root, '.gitignore'), 'SECURITY.md\ndocs/ignored-docs/\n');
    writeText(join(root, 'README.md'), '# readme\n');
    writeText(join(root, 'AGENTS.md'), '# rules\n');
    writeText(join(root, 'SECURITY.md'), '# ignored\n');
    writeText(join(root, 'docs', 'guide.md'), '# guide\n');
    writeText(join(root, 'docs', 'adr', '0001.md'), '# decision\n');
    writeText(join(root, 'docs', 'ignored-docs', 'secret.md'), '# secret\n');
    writeText(
      join(root, '.github', 'copilot-instructions.md'),
      '# instructions\n',
    );
    writeText(join(root, '.cursor', 'rules', 'style.mdc'), '# style\n');

    const before = snapshotTree(root);
    const result = await discoverWorkspace(root);
    const byPath = new Map(
      result.documents.map((entry) => [entry.workspaceRelativePath, entry]),
    );
    assert.equal(byPath.get('AGENTS.md')?.kind, 'rule');
    assert.equal(byPath.get('AGENTS.md')?.origin, 'repository-scan');
    assert.equal(byPath.get('README.md')?.kind, 'documentation');
    assert.equal(byPath.get('docs/guide.md')?.kind, 'documentation');
    assert.equal(byPath.get('docs/adr/0001.md')?.kind, 'decision-record');
    assert.equal(byPath.get('.github/copilot-instructions.md')?.kind, 'rule');
    assert.equal(byPath.get('.cursor/rules/style.mdc')?.kind, 'rule');
    assert.equal(byPath.has('SECURITY.md'), false);
    assert.equal(byPath.has('docs/ignored-docs/secret.md'), false);
    assert(codes(result).includes('document_ignored'));
    assert.equal(existsSync(join(root, 'SECURITY.md')), true);
    assert.equal(
      existsSync(join(root, 'docs', 'ignored-docs', 'secret.md')),
      true,
    );
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('reports validation declarations and package scripts without executing them', async () => {
  const root = makeTempDir('knowledge-validation');
  try {
    createRepository(root);
    const marker = join(root, 'executed-marker.txt');
    writeJson(join(root, 'package.json'), {
      name: 'fixture-app',
      scripts: {
        test: `node -e "require('node:fs').writeFileSync('executed-marker.txt','ran')"`,
        lint: 'echo lint',
        dev: 'echo dev',
      },
    });
    writeText(join(root, 'pnpm-lock.yaml'), '');
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [{ id: 'app', path: '.', access: 'write' }],
        validation: [
          {
            id: 'declared-test',
            repositoryId: 'app',
            executable: 'pnpm',
            args: ['run', 'test'],
          },
        ],
      }),
    );

    const before = snapshotTree(root);
    const result = await discoverWorkspace(root);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(snapshotTree(root), before);
    const candidates = result.validationCandidates;
    const declared = candidates.find(
      (entry) => entry.id === 'workspace-config:declared-test',
    );
    assert(declared !== undefined);
    assert.equal(declared.executable, 'pnpm');
    assert.deepEqual(declared.args, ['run', 'test']);
    assert.equal(declared.repositoryAccess, 'write');
    assert.equal(declared.workingDirectory, realpath(root));
    assert.equal(declared.verification, 'not-verified');

    const scripts = candidates.filter(
      (entry) => entry.origin === 'package-script',
    );
    assert.deepEqual(scripts.map((entry) => entry.args[1]).sort(), [
      'lint',
      'test',
    ]);
    assert(scripts.every((entry) => entry.executable === 'pnpm'));
    assert(scripts.every((entry) => entry.runnerSource === 'lockfile'));
    assert(scripts.every((entry) => entry.verification === 'not-verified'));
    assert.equal(
      candidates.some((entry) => entry.args.includes('dev')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('does not guess a runner for an unsupported packageManager', async () => {
  const root = makeTempDir('knowledge-runner');
  try {
    createRepository(root);
    writeJson(join(root, 'package.json'), {
      name: 'deno-app',
      packageManager: 'deno@2.0.0',
      scripts: { test: 'deno test' },
    });
    const result = await discoverWorkspace(root);
    assert.equal(
      result.validationCandidates.some(
        (entry) => entry.origin === 'package-script',
      ),
      false,
    );
    assert(codes(result).includes('validation_runner_unsupported'));
  } finally {
    cleanup(root);
  }
});

test('reports invalid configuration and continues only with capability-truthful scan data', async () => {
  const root = makeTempDir('knowledge-invalid-config');
  try {
    createRepository(root);
    writeText(join(root, '.pappra', 'workspace.json'), '{"schema":');
    const before = snapshotTree(root);
    const result = await discoverWorkspace(root);
    assert.equal(result.configState, 'invalid');
    assert.equal(result.config, null);
    assert(codes(result).includes('config_invalid_json'));
    assert.deepEqual(snapshotTree(root), before);

    const repository = result.repositories.find(
      (entry) => entry.root === realpath(root),
    );
    assert(repository !== undefined);
    assert.equal(repository.id, null);
    assert.equal(repository.access, 'read');
    assert.deepEqual(result.validationCandidates, []);
  } finally {
    cleanup(root);
  }
});

test('reports missing knowledge sources and runtime warnings without executing anything', async () => {
  const root = makeTempDir('knowledge-source-missing');
  try {
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        knowledge: {
          sources: ['missing-docs'],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
        },
      }),
    );
    writeMachineConfig(
      root,
      baseMachineConfig(root, {
        runtime: {
          version: '9.9.9',
          executable: join(root, 'missing-runtime'),
          verifiedAt: '2026-10-17T00:00:00.000Z',
        },
      }),
    );
    const result = await discoverWorkspace(root);
    const found = codes(result);
    assert(found.includes('knowledge_source_missing'));
    assert(found.includes('runtime_missing'));
    assert(found.includes('runtime_version_mismatch'));
  } finally {
    cleanup(root);
  }
});

test('reports a knowledge source symlink that escapes the workspace', async () => {
  const root = makeTempDir('knowledge-source-symlink');
  const outside = makeTempDir('knowledge-source-symlink-outside');
  try {
    writeText(join(outside, 'secret.md'), '# outside\n');
    linkDirectory(outside, join(root, 'docs-link'));
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        knowledge: {
          sources: ['docs-link'],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
        },
      }),
    );
    const result = await discoverWorkspace(root);
    assert(codes(result).includes('knowledge_source_symlink_escape'));
    assert.equal(
      result.documents.some((entry) => entry.path.includes('secret.md')),
      false,
    );
    assert.equal(existsSync(join(outside, 'secret.md')), true);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('rejects documents reached through an ancestor symlink outside the workspace', async () => {
  const root = makeTempDir('knowledge-ancestor-symlink');
  const outside = makeTempDir('knowledge-ancestor-symlink-target');
  try {
    createRepository(root);
    writeText(join(outside, 'copilot-instructions.md'), '# external rules\n');
    writeText(join(outside, 'rules', 'style.mdc'), '# external style\n');
    linkDirectory(outside, join(root, '.github'));
    linkDirectory(outside, join(root, '.cursor'));

    const result = await discoverWorkspace(root);
    assert.equal(
      result.documents.some((entry) =>
        entry.path.startsWith(realpath(outside)),
      ),
      false,
    );
    assert(codes(result).includes('document_path_escapes_root'));
    assert.equal(existsSync(join(outside, 'copilot-instructions.md')), true);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('does not enter a nested workspace while scanning documents', async () => {
  const root = makeTempDir('knowledge-nested-docs');
  try {
    createRepository(root);
    const inner = join(root, 'docs', 'inner');
    writeText(join(root, 'README.md'), '# outer\n');
    writeText(join(root, 'docs', 'guide.md'), '# guide\n');
    writeText(
      join(inner, '.pappra', 'workspace.json'),
      JSON.stringify(baseWorkspaceConfig({ name: 'inner' })),
    );
    writeText(join(inner, 'README.md'), '# inner\n');

    const result = await discoverWorkspace(root);
    assert.equal(
      result.documents.some(
        (entry) => entry.path === realpath(join(inner, 'README.md')),
      ),
      false,
    );
    assert.equal(
      result.documents.some(
        (entry) => entry.path === realpath(join(root, 'docs', 'guide.md')),
      ),
      true,
    );
    assert.deepEqual(result.boundaries, [realpath(inner)]);
    assert(codes(result).includes('discovery_nested_workspace'));
  } finally {
    cleanup(root);
  }
});

test('does not enter nested workspaces reached through well-known ancestor symlinks', async () => {
  const root = makeTempDir('knowledge-nested-ancestor');
  try {
    const inner = join(root, 'inner');
    writeText(
      join(inner, '.pappra', 'workspace.json'),
      JSON.stringify(baseWorkspaceConfig({ name: 'inner' })),
    );
    writeText(join(inner, 'copilot-instructions.md'), '# inner rules\n');
    writeText(join(inner, 'rules', 'style.mdc'), '# inner style\n');
    writeText(join(root, 'README.md'), '# outer docs\n');
    linkDirectory(inner, join(root, '.github'));
    linkDirectory(inner, join(root, '.cursor'));

    const result = await discoverWorkspace(root);
    const paths = result.documents.map((entry) => entry.path);
    assert.equal(paths.includes(realpath(join(root, 'README.md'))), true);
    assert.equal(
      paths.includes(realpath(join(inner, 'copilot-instructions.md'))),
      false,
    );
    assert.equal(
      paths.includes(realpath(join(inner, 'rules', 'style.mdc'))),
      false,
    );
    assert.deepEqual(result.boundaries, [realpath(inner)]);
    assert(codes(result).includes('discovery_nested_workspace'));
  } finally {
    cleanup(root);
  }
});

test('does not follow knowledge.sources into a nested workspace', async () => {
  const root = makeTempDir('knowledge-nested-sources');
  try {
    const inner = join(root, 'inner');
    writeText(
      join(inner, '.pappra', 'workspace.json'),
      JSON.stringify(baseWorkspaceConfig({ name: 'inner' })),
    );
    writeText(join(inner, 'note.md'), '# inner note\n');
    writeText(join(inner, 'rules', 'style.mdc'), '# inner style\n');
    writeText(join(root, 'README.md'), '# outer docs\n');
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        knowledge: {
          sources: ['README.md', 'inner/note.md', 'inner/rules'],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
        },
      }),
    );

    const result = await discoverWorkspace(root);
    const paths = result.documents.map((entry) => entry.path);
    assert.equal(paths.includes(realpath(join(root, 'README.md'))), true);
    assert.equal(paths.includes(realpath(join(inner, 'note.md'))), false);
    assert.equal(
      paths.includes(realpath(join(inner, 'rules', 'style.mdc'))),
      false,
    );
    assert.deepEqual(result.boundaries, [realpath(inner)]);
    assert(codes(result).includes('discovery_nested_workspace'));
  } finally {
    cleanup(root);
  }
});
