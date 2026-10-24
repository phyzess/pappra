import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { KnowledgeService } from '../../src/knowledge/service.js';
import { loadKnowledgeContext } from '../../src/knowledge/context.js';
import {
  loadKnowledgeCatalogs,
  setCatalogRecord,
  writeCatalogFile,
} from '../../src/knowledge/catalog.js';
import { scanDiscoveredDocuments } from '../../src/knowledge/scan.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

function workspace(shared = false): string {
  const root = makeTempDir('knowledge-daily');
  writeWorkspaceConfig(
    root,
    baseWorkspaceConfig({
      knowledge: {
        sources: ['docs'],
        newDocuments: 'knowledge',
        taskVisibility: shared ? 'shared' : 'private',
      },
    }),
  );
  writeMachineConfig(root, baseMachineConfig(root));
  return root;
}
async function register(service: KnowledgeService, path: string) {
  const result = await service.register({
    location: { kind: 'workspace', path },
    kind: 'architecture',
    maturity: 'draft',
    owner: 'human',
  });
  assert(result.ok && result.record, JSON.stringify(result));
  return result.record;
}

test('shared registrations touch independent records and merge across branches', async () => {
  const root = workspace(true);
  try {
    createRepository(root);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      });
    git('config', 'user.name', 'Pappra Tests');
    git('config', 'user.email', 'pappra-tests@example.invalid');
    git('add', '.pappra/workspace.json');
    git('commit', '-m', 'Declare workspace');
    const initial = git('rev-parse', 'HEAD').trim();
    git('checkout', '-b', 'knowledge-a');
    writeText(join(root, 'docs/a.md'), '# Branch A\n');
    const a = await register(new KnowledgeService(root), 'docs/a.md');
    const aPath = join(
      root,
      '.pappra/knowledge/records',
      `${a.documentId}.json`,
    );
    const aBytes = readFileSync(aPath);
    git('add', 'docs/a.md', '.pappra/knowledge/records');
    git('commit', '-m', 'Register A');
    git('checkout', '-b', 'knowledge-b', initial);
    writeText(join(root, 'docs/b.md'), '# Branch B\n');
    await register(new KnowledgeService(root), 'docs/b.md');
    git('add', 'docs/b.md', '.pappra/knowledge/records');
    git('commit', '-m', 'Register B');
    git('merge', '--no-edit', 'knowledge-a');
    const service = new KnowledgeService(root);
    assert.equal((await service.list()).records.length, 2);
    assert.deepEqual(readFileSync(aPath), aBytes);
    const before = statSync(aPath);
    writeText(join(root, 'docs/c.md'), '# Branch C\n');
    await register(service, 'docs/c.md');
    assert.equal(statSync(aPath).mtimeMs, before.mtimeMs);
    assert.equal(statSync(aPath).ino, before.ino);
    assert.equal(
      existsSync(join(root, '.pappra/knowledge/catalog.json')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('archive frees an active location and forget retains document content', async () => {
  const root = workspace();
  try {
    writeText(join(root, 'docs/a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const first = await register(service, 'docs/a.md');
    assert.equal((await service.archive(first.documentId)).ok, true);
    const next = await register(service, 'docs/a.md');
    assert.notEqual(next.documentId, first.documentId);
    assert.equal((await service.forget(first.documentId)).ok, true);
    assert.equal(readFileSync(join(root, 'docs/a.md'), 'utf8'), '# A\n');
  } finally {
    cleanup(root);
  }
});

test('per-record shared storage refuses a stale aggregate snapshot and preserves legacy state', async () => {
  const root = workspace(true);
  try {
    writeText(join(root, 'docs/a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const record = await register(service, 'docs/a.md');
    const loaded = await loadKnowledgeContext(root);
    assert(loaded.context);
    const catalogs = await loadKnowledgeCatalogs(loaded.context);
    const change = setCatalogRecord(loaded.context, catalogs, {
      ...record,
      kind: 'research',
    });
    const file = join(
      root,
      '.pappra/knowledge/records',
      `${record.documentId}.json`,
    );
    const edited = JSON.parse(readFileSync(file, 'utf8')) as {
      record: { owner: string };
    };
    edited.record.owner = 'agent';
    const editedBytes = JSON.stringify(edited);
    writeFileSync(file, editedBytes);
    const stale = await writeCatalogFile(
      loaded.context,
      'shared',
      change.catalog,
      catalogs.shared.digest,
    );
    assert.equal(stale.ok, false);
    assert.equal(readFileSync(file, 'utf8'), editedBytes);
    const legacy = join(root, '.pappra/knowledge/catalog.json');
    writeFileSync(legacy, 'legacy state is preserved');
    const listed = await service.list();
    assert.equal(listed.ok, false);
    assert(
      listed.diagnostics.some((entry) =>
        entry.message.includes('Legacy shared'),
      ),
    );
    assert.equal(readFileSync(legacy, 'utf8'), 'legacy state is preserved');
  } finally {
    cleanup(root);
  }
});

test('scan retains identity after ordinary and case-only renames; explicit relocation validates digest', async () => {
  const root = workspace();
  try {
    writeText(join(root, 'docs/a.md'), '# Identity\n');
    const service = new KnowledgeService(root);
    const first = await register(service, 'docs/a.md');
    renameSync(join(root, 'docs/a.md'), join(root, 'docs/renamed.md'));
    const scanned = await scanDiscoveredDocuments(root, { apply: true });
    assert(scanned.ok, JSON.stringify(scanned));
    assert.equal(
      (await service.list({ includePrivate: true })).records[0]?.documentId,
      first.documentId,
    );
    renameSync(join(root, 'docs/renamed.md'), join(root, 'docs/RENAMED.md'));
    const caseScan = await scanDiscoveredDocuments(root, { apply: true });
    assert(caseScan.ok, JSON.stringify(caseScan));
    const listed = await service.list({ includePrivate: true });
    assert.equal(listed.records.length, 1);
    assert.equal(listed.records[0]?.location.path, 'docs/RENAMED.md');
    writeText(join(root, 'docs/wrong.md'), '# Different\n');
    assert.equal(
      (
        await service.relocate(first.documentId, {
          kind: 'workspace',
          path: 'docs/wrong.md',
        })
      ).ok,
      false,
    );
    writeText(join(root, 'docs/new.md'), '# Identity\n');
    assert.equal(
      (
        await service.relocate(first.documentId, {
          kind: 'workspace',
          path: 'docs/new.md',
        })
      ).ok,
      true,
    );
    assert.equal(
      readFileSync(join(root, 'docs/RENAMED.md'), 'utf8'),
      '# Identity\n',
    );
  } finally {
    cleanup(root);
  }
});

test('scan reaches deep sources and counts only unregistered documents against its new-document budget', async () => {
  const root = workspace();
  try {
    for (let i = 0; i < 350; i += 1)
      writeText(
        join(root, 'docs/deep/a/b/c/d', `${i.toString().padStart(3, '0')}.md`),
        `# Document ${i}\n`,
      );
    const first = await scanDiscoveredDocuments(root, { apply: true });
    assert('registered' in first);
    assert.equal(first.registered.length, 300);
    assert.equal(
      first.ok,
      false,
      'the first batch explicitly reports remaining coverage',
    );
    const second = await scanDiscoveredDocuments(root, { apply: true });
    assert('registered' in second);
    assert.equal(second.registered.length, 50);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(
      (await new KnowledgeService(root).list({ includePrivate: true })).records
        .length,
      350,
    );
  } finally {
    cleanup(root);
  }
});

test('private/shared location conflicts remain visible and forget provides a content-preserving exit', async () => {
  const root = workspace(true);
  try {
    writeText(join(root, 'docs/a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const shared = await register(service, 'docs/a.md');
    const privateId = '998c7303-2c3b-4270-bdbf-e014cf054655';
    const privateDir = join(root, '.pappra/local/knowledge');
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(
      join(privateDir, 'catalog.json'),
      JSON.stringify({
        schema: 'pappra/document-catalog/1',
        workspaceId: baseWorkspaceConfig().workspaceId,
        updatedAt: new Date().toISOString(),
        records: [{ ...shared, documentId: privateId, visibility: 'private' }],
      }),
    );
    const listed = await service.list();
    assert.equal(listed.ok, false);
    assert(listed.diagnostics.some((item) => item.severity === 'error'));
    assert.equal(JSON.stringify(listed.diagnostics).includes(privateId), false);
    assert.equal((await service.forget(privateId)).ok, true);
    assert.equal((await service.list()).ok, true);
    assert.equal(readFileSync(join(root, 'docs/a.md'), 'utf8'), '# A\n');
  } finally {
    cleanup(root);
  }
});

test('docs relocate and forget plan without writes and apply through the current CLI', async () => {
  const root = workspace();
  try {
    writeText(join(root, 'docs/a.md'), '# A\n');
    const record = await register(new KnowledgeService(root), 'docs/a.md');
    renameSync(join(root, 'docs/a.md'), join(root, 'docs/b.md'));
    const cli = fileURLToPath(
      new URL('../../src/cli/main.js', import.meta.url),
    );
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, 'docs', ...args, '--json'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
      });
    assert.equal(run('relocate', record.documentId, 'docs/b.md').status, 0);
    assert.equal(
      (await new KnowledgeService(root).list({ includePrivate: true }))
        .records[0]?.location.path,
      'docs/a.md',
    );
    const applied = run('relocate', record.documentId, 'docs/b.md', '--apply');
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const forgotten = run('forget', record.documentId, '--apply');
    assert.equal(forgotten.status, 0, forgotten.stdout + forgotten.stderr);
    assert.equal(readFileSync(join(root, 'docs/b.md'), 'utf8'), '# A\n');
  } finally {
    cleanup(root);
  }
});

test('scoped forget resolves an interrupted share duplicate without choosing an identity implicitly', async () => {
  const root = workspace(true);
  try {
    writeText(join(root, 'docs/a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const shared = await register(service, 'docs/a.md');
    const privateDir = join(root, '.pappra/local/knowledge');
    mkdirSync(privateDir, { recursive: true });
    writeFileSync(
      join(privateDir, 'catalog.json'),
      JSON.stringify({
        schema: 'pappra/document-catalog/1',
        workspaceId: baseWorkspaceConfig().workspaceId,
        updatedAt: new Date().toISOString(),
        records: [{ ...shared, visibility: 'private' }],
      }),
    );
    assert.equal((await service.forget(shared.documentId)).ok, false);
    assert.equal((await service.forget(shared.documentId, 'private')).ok, true);
    const listed = await service.list({ includePrivate: true });
    assert.equal(listed.ok, true);
    assert.equal(listed.records.length, 1);
    assert.equal(listed.records[0]?.visibility, 'shareable');
    assert.equal(readFileSync(join(root, 'docs/a.md'), 'utf8'), '# A\n');
  } finally {
    cleanup(root);
  }
});

test('scoped forget cannot turn shared dependents into references to a private-only source', async () => {
  const root = workspace(true);
  try {
    writeText(join(root, 'docs/source.md'), '# Source\n');
    writeText(join(root, 'docs/dependent.md'), '# Dependent\n');
    const service = new KnowledgeService(root);
    const shared = await register(service, 'docs/source.md');
    const dependent = await service.register({
      location: { kind: 'workspace', path: 'docs/dependent.md' },
      kind: 'architecture',
      maturity: 'draft',
      owner: 'human',
      sources: [
        {
          kind: 'document',
          documentId: shared.documentId,
          digest: shared.digest,
        },
      ],
    });
    assert.equal(dependent.ok, true, JSON.stringify(dependent.diagnostics));
    const privateDir = join(root, '.pappra/local/knowledge');
    mkdirSync(privateDir, { recursive: true });
    const privatePath = join(privateDir, 'catalog.json');
    writeFileSync(
      privatePath,
      JSON.stringify({
        schema: 'pappra/document-catalog/1',
        workspaceId: baseWorkspaceConfig().workspaceId,
        updatedAt: new Date().toISOString(),
        records: [{ ...shared, visibility: 'private' }],
      }),
    );
    const sharedPath = join(
      root,
      '.pappra/knowledge/records',
      `${shared.documentId}.json`,
    );
    const sharedBytes = readFileSync(sharedPath);
    const privateBytes = readFileSync(privatePath);
    const refused = await service.forget(shared.documentId, 'shared');
    assert.equal(refused.ok, false);
    assert(
      refused.diagnostics.some((entry) => entry.message.includes('reference')),
    );
    assert.deepEqual(readFileSync(sharedPath), sharedBytes);
    assert.deepEqual(readFileSync(privatePath), privateBytes);
    assert.equal((await service.forget(shared.documentId, 'private')).ok, true);
    assert.equal((await service.list({ includePrivate: true })).ok, true);
    assert.deepEqual(readFileSync(sharedPath), sharedBytes);
  } finally {
    cleanup(root);
  }
});
