import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { KnowledgeService } from '../../src/knowledge/index.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  makeTempDir,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

const packageRoot = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);
const cli = join(packageRoot, 'dist/cli/main.js');

function invoke(args: string[], cwd: string, home: string) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 15_000,
    env: { ...process.env, HOME: home },
  });
  if (result.error) throw result.error;
  return result;
}

function parse(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  assert(typeof value === 'object' && value !== null);
  return value as Record<string, unknown>;
}

test('docs list/check keep private records out of default JSON and honor explicit flags', async () => {
  const root = makeTempDir('knowledge-cli');
  const home = mkdtempSync(join(tmpdir(), 'knowledge-cli-home-'));
  try {
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        knowledge: {
          sources: [],
          newDocuments: 'knowledge',
          taskVisibility: 'private',
        },
      }),
    );
    writeMachineConfig(root, baseMachineConfig(root));
    writeText(join(root, 'docs', 'private.md'), '# Private\n');
    writeText(join(root, 'docs', 'shared.md'), '# Shared\n');
    const service = new KnowledgeService(root);
    const privateRecord = await service.register({
      location: { kind: 'workspace', path: 'docs/private.md' },
      kind: 'research',
      maturity: 'draft',
      owner: 'human',
    });
    const sharedRecord = await service.register({
      location: { kind: 'workspace', path: 'docs/shared.md' },
      kind: 'research',
      maturity: 'draft',
      owner: 'human',
      visibility: 'shareable',
    });
    assert(privateRecord.record && sharedRecord.record);

    const list = invoke(['docs', 'list', '--json'], root, home);
    assert.equal(list.status, 0, list.stderr);
    assert.equal(list.stderr, '');
    const listValue = parse(list.stdout);
    assert.equal(listValue.schema, 'pappra/docs-list/1');
    const documents = listValue.documents as unknown[];
    assert.equal(documents.length, 1);
    assert(!list.stdout.includes(privateRecord.record.documentId));
    assert(!list.stdout.includes('docs/private.md'));

    const all = invoke(
      ['docs', 'list', '--include-private', '--json'],
      root,
      home,
    );
    assert.equal(all.status, 0, all.stderr);
    assert.equal((parse(all.stdout).documents as unknown[]).length, 2);

    const check = invoke(['docs', 'check', '--json'], root, home);
    assert.equal(check.status, 0, check.stdout);
    assert.equal(check.stderr, '');
    const checkValue = parse(check.stdout);
    assert.equal(checkValue.schema, 'pappra/docs-check/1');
    assert.equal((checkValue.entries as unknown[]).length, 1);
    assert(!check.stdout.includes(privateRecord.record.documentId));
    assert(!check.stdout.includes('docs/private.md'));
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
  }
});

test('docs archive is explicit and default list keeps archived records hidden', async () => {
  const root = makeTempDir('knowledge-cli-archive');
  const home = mkdtempSync(join(tmpdir(), 'knowledge-cli-home-'));
  try {
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        knowledge: {
          sources: [],
          newDocuments: 'knowledge',
          taskVisibility: 'shared',
        },
      }),
    );
    writeMachineConfig(root, baseMachineConfig(root));
    writeText(join(root, 'docs', 'archive.md'), '# Archive\n');
    const service = new KnowledgeService(root);
    const registered = await service.register({
      location: { kind: 'workspace', path: 'docs/archive.md' },
      kind: 'decision',
      maturity: 'reviewed',
      owner: 'human',
    });
    assert(registered.record !== null);
    const archived = invoke(
      ['docs', 'archive', registered.record.documentId, '--json'],
      root,
      home,
    );
    assert.equal(archived.status, 0, archived.stderr);
    assert.equal(archived.stderr, '');
    const archiveValue = parse(archived.stdout);
    assert.equal(archiveValue.schema, 'pappra/docs-archive/1');
    assert.equal(
      (archiveValue.document as Record<string, unknown>).lifecycle,
      'archived',
    );
    assert.equal(
      (
        parse(invoke(['docs', 'list', '--json'], root, home).stdout)
          .documents as unknown[]
      ).length,
      0,
    );
    assert.equal(
      (
        parse(
          invoke(['docs', 'list', '--include-archived', '--json'], root, home)
            .stdout,
        ).documents as unknown[]
      ).length,
      1,
    );
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
  }
});

test('docs rejects unknown actions and extra positionals with exit code 2', () => {
  const root = makeTempDir('knowledge-cli-invalid');
  const home = mkdtempSync(join(tmpdir(), 'knowledge-cli-home-'));
  try {
    for (const args of [
      ['docs', 'unknown', '--json'],
      ['docs', 'list', 'extra', '--json'],
      ['docs', 'archive', '--json'],
    ]) {
      const result = invoke(args, root, home);
      assert.equal(result.status, 2);
      assert.equal(result.stderr, '');
      const value = parse(result.stdout);
      assert.equal(value.ok, false);
    }
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
  }
});

test('docs scan previews and registers documents from configured sources', () => {
  const root = makeTempDir('knowledge-scan');
  const home = mkdtempSync(join(tmpdir(), 'knowledge-scan-home-'));
  try {
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        knowledge: {
          sources: ['AGENTS.md', 'docs'],
          newDocuments: 'knowledge',
          taskVisibility: 'shared',
        },
      }),
    );
    writeMachineConfig(root, baseMachineConfig(root));
    writeText(join(root, 'AGENTS.md'), '# Agents\n');
    writeText(join(root, 'docs/architecture/a.md'), '# Arch\n');
    writeText(join(root, 'docs/research/r.md'), '# Research\n');

    const planned = invoke(['docs', 'scan', '--json'], root, home);
    assert.equal(planned.status, 0, planned.stderr);
    const plan = parse(planned.stdout);
    assert.equal(plan.mode, 'plan');
    const candidates = plan.candidates as readonly Record<string, unknown>[];
    assert.deepEqual(
      candidates.map((candidate) => [candidate.kind, candidate.path]),
      [
        ['rule', 'AGENTS.md'],
        ['architecture', 'docs/architecture/a.md'],
        ['research', 'docs/research/r.md'],
      ],
    );

    const applied = invoke(['docs', 'scan', '--apply', '--json'], root, home);
    assert.equal(applied.status, 0, applied.stderr);
    const appliedValue = parse(applied.stdout);
    assert.equal(appliedValue.ok, true);
    assert.equal((appliedValue.registered as unknown[]).length, 3);

    const listed = invoke(
      ['docs', 'list', '--include-private', '--json'],
      root,
      home,
    );
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal((parse(listed.stdout).documents as unknown[]).length, 3);

    const rescan = invoke(['docs', 'scan', '--json'], root, home);
    assert.equal((parse(rescan.stdout).candidates as unknown[]).length, 0);
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
  }
});
