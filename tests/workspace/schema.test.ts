import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  diagnosticCodes,
  evidenceRefSchema,
  failed,
  succeeded,
} from '../../src/schemas/index.js';
import {
  inspectMachineConfig,
  inspectWorkspaceConfig,
  loadWorkspaceConfig,
} from '../../src/workspace/index.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  makeTempDir,
  realpath,
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

test('accepts a complete workspace configuration and preserves the digest', async () => {
  const root = makeTempDir('schema-valid');
  try {
    const config = baseWorkspaceConfig({
      repositories: [{ id: 'app', path: 'app', access: 'write' }],
      knowledge: {
        sources: ['README.md', 'docs'],
        newDocuments: '.pappra/knowledge',
        taskVisibility: 'private',
      },
      validation: [
        {
          id: 'test',
          repositoryId: 'app',
          executable: 'pnpm',
          args: ['run', 'test'],
        },
      ],
    });
    writeWorkspaceConfig(root, config);
    const inspection = await inspectWorkspaceConfig(root);
    assert.equal(inspection.value?.name, 'test-workspace');
    assert.equal(inspection.value?.repositories[0]?.id, 'app');
    assert.match(inspection.digest ?? '', /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(inspection.diagnostics, []);
  } finally {
    cleanup(root);
  }
});

test('reports unknown top-level and nested keys with migration advice', async () => {
  const root = makeTempDir('schema-unknown');
  try {
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        unexpected: true,
        knowledge: {
          sources: [],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
          legacyDocs: ['old'],
        },
      }),
    );
    const inspection = await inspectWorkspaceConfig(root);
    assert.equal(inspection.value, null);
    const unknown = inspection.diagnostics.filter(
      (entry) => entry.code === 'config_unknown_key',
    );
    assert.deepEqual(unknown.map((entry) => entry.pointer).sort(), [
      '/knowledge/legacyDocs',
      '/unexpected',
    ]);
    assert(unknown.every((entry) => entry.hint?.includes('extensions')));
  } finally {
    cleanup(root);
  }
});

test('reports an unsupported schema version without rewriting the file', async () => {
  const root = makeTempDir('schema-version');
  try {
    const configPath = writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({ schema: 'pappra/workspace/2' }),
    );
    const before = readFileSync(configPath);
    const inspection = await inspectWorkspaceConfig(root);
    assert.equal(inspection.value, null);
    assert.deepEqual(codes(inspection), ['config_unsupported_schema']);
    assert.match(
      inspection.diagnostics[0]?.hint ?? '',
      /will not migrate, overwrite/,
    );
    assert.deepEqual(readFileSync(configPath), before);
  } finally {
    cleanup(root);
  }
});

test('reports malformed JSON and keeps the original bytes intact', async () => {
  const root = makeTempDir('schema-json');
  try {
    const configPath = join(root, '.pappra', 'workspace.json');
    writeText(configPath, '{"schema": "pappra/workspace/1",');
    const before = readFileSync(configPath);
    const inspection = await inspectWorkspaceConfig(root);
    assert.equal(inspection.value, null);
    assert.deepEqual(codes(inspection), ['config_invalid_json']);
    assert.deepEqual(readFileSync(configPath), before);
  } finally {
    cleanup(root);
  }
});

test('detects duplicate ids, unknown repository references, and invalid paths', async () => {
  const root = makeTempDir('schema-semantics');
  try {
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [
          { id: 'app', path: 'app', access: 'write' },
          { id: 'app', path: 'other', access: 'read' },
          { id: 'absolute', path: '/tmp/outside', access: 'read' },
          { id: 'escape', path: '../outside', access: 'read' },
          { id: 'external', path: 'external:shared', access: 'read' },
        ],
        validation: [
          {
            id: 'test',
            repositoryId: 'missing',
            executable: 'pnpm',
            args: [],
          },
          {
            id: 'test',
            repositoryId: 'app',
            executable: 'pnpm',
            args: [],
          },
        ],
        excludes: ['generated/**'],
      }),
    );
    const inspection = await inspectWorkspaceConfig(root);
    assert.equal(inspection.value, null);
    const found = codes(inspection);
    for (const code of [
      'config_duplicate_repository_id',
      'config_path_absolute',
      'config_path_escapes_root',
      'config_duplicate_validation_id',
      'config_unknown_repository',
      'config_glob_not_supported',
    ]) {
      assert(found.includes(code), `missing ${code}: ${found.join(', ')}`);
    }
    assert(found.includes('config_path_invalid') === false);
  } finally {
    cleanup(root);
  }
});

test('reports schema type and enum failures with JSON pointers', async () => {
  const root = makeTempDir('schema-enum');
  try {
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        code: { graph: 'unknown', symbols: 'none', prepare: 'manual' },
      }),
    );
    const inspection = await inspectWorkspaceConfig(root);
    assert.equal(inspection.value, null);
    const invalid = inspection.diagnostics.find(
      (entry) => entry.code === 'config_schema_invalid',
    );
    assert(invalid !== undefined);
    assert.equal(invalid.pointer, '/code/graph');
  } finally {
    cleanup(root);
  }
});

test('missing workspace configuration is optional for discovery but fatal to load', async () => {
  const root = makeTempDir('schema-missing');
  try {
    const info = await inspectWorkspaceConfig(root, { missing: 'info' });
    assert.equal(info.value, null);
    assert.equal(info.exists, false);
    assert.equal(info.diagnostics[0]?.severity, 'info');
    const failed = await loadWorkspaceConfig(root);
    assert.equal(failed.ok, false);
    assert.equal(failed.ok ? '' : failed.code, 'config_missing');
  } finally {
    cleanup(root);
  }
});

test('rejects a workspace.json symlink that resolves outside the workspace', async () => {
  const root = makeTempDir('schema-symlink-root');
  const outside = makeTempDir('schema-symlink-target');
  try {
    writeJson(join(outside, 'workspace.json'), baseWorkspaceConfig());
    writeText(join(root, '.pappra', 'keep.txt'), 'keep\n');
    symlinkSync(
      join(outside, 'workspace.json'),
      join(root, '.pappra', 'workspace.json'),
    );
    const inspection = await inspectWorkspaceConfig(root);
    assert.equal(inspection.value, null);
    assert.deepEqual(codes(inspection), ['config_symlink_escape']);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('validates machine.json and reports workspace identity mismatch', async () => {
  const root = makeTempDir('schema-machine');
  const other = makeTempDir('schema-machine-other');
  try {
    writeMachineConfig(root, baseMachineConfig(root, { unknownField: 1 }));
    let inspection = await inspectMachineConfig(root);
    assert.equal(inspection.value, null);
    assert.deepEqual(codes(inspection), ['config_unknown_key']);

    writeMachineConfig(
      root,
      baseMachineConfig(root, { workspaceRealpath: realpath(other) }),
    );
    inspection = await inspectMachineConfig(root);
    assert.equal(inspection.value, null);
    assert(codes(inspection).includes('machine_workspace_mismatch'));

    writeMachineConfig(
      root,
      baseMachineConfig(root, {
        runtime: {
          version: '0.1.0-dev.0',
          executable: join(other, 'pappra'),
          verifiedAt: '2026-10-17T00:00:00.000Z',
        },
      }),
    );
    inspection = await inspectMachineConfig(root);
    assert.notEqual(inspection.value, null);
    assert.equal(inspection.value?.runtime?.version, '0.1.0-dev.0');

    writeMachineConfig(
      root,
      baseMachineConfig(root, {
        externalRepositories: [{ id: 'dep', path: 'relative/dep' }],
      }),
    );
    inspection = await inspectMachineConfig(root);
    assert.equal(inspection.value, null);
    assert(codes(inspection).includes('machine_external_path_invalid'));
  } finally {
    cleanup(root);
    cleanup(other);
  }
});

test('rejects a UTF-8 BOM instead of silently rewriting configuration', async () => {
  const root = makeTempDir('schema-bom');
  try {
    const configPath = join(root, '.pappra', 'workspace.json');
    writeText(configPath, `\uFEFF${JSON.stringify(baseWorkspaceConfig())}`);
    const inspection = await inspectWorkspaceConfig(root);
    assert.equal(inspection.value, null);
    assert.deepEqual(codes(inspection), ['config_invalid_json']);
  } finally {
    cleanup(root);
  }
});

test('evidence and outcome contracts reject malformed references and failures', () => {
  const valid = {
    kind: 'git',
    ref: 'git:rev-parse identity',
    digest: `sha256:${'a'.repeat(64)}`,
    observedAt: '2026-10-17T00:00:00.000Z',
    scope: 'live-owned',
  };
  assert.equal(evidenceRefSchema.safeParse(valid).success, true);
  assert.equal(
    evidenceRefSchema.safeParse({ ...valid, digest: 'sha256:short' }).success,
    false,
  );
  assert.equal(
    evidenceRefSchema.safeParse({ ...valid, scope: 'guessed' }).success,
    false,
  );

  const success = succeeded(42);
  assert.deepEqual(success, { ok: true, value: 42 });
  const failure = failed(diagnosticCodes.configMissing, 'missing', {
    nextAction: 'run init',
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'config_missing');
  assert.equal(failure.retryable, false);
  assert.equal(failure.nextAction, 'run init');
});

test(
  'rejects a FIFO configuration without opening and blocking',
  { skip: process.platform === 'win32' },
  async () => {
    const root = makeTempDir('schema-fifo');
    try {
      const pappra = join(root, '.pappra');
      mkdirSync(pappra, { recursive: true });
      const configPath = join(pappra, 'workspace.json');
      const created = spawnSync('mkfifo', [configPath], {
        encoding: 'utf8',
        shell: false,
        timeout: 5_000,
      });
      if (created.error) throw created.error;
      assert.equal(created.status, 0, created.stderr);

      const inspection = await inspectWorkspaceConfig(root);
      assert.equal(inspection.value, null);
      assert.deepEqual(codes(inspection), ['file_not_regular']);
    } finally {
      cleanup(root);
    }
  },
);
