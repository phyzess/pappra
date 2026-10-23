import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  KnowledgeService,
  type RegisterDocumentInput,
} from '../../src/knowledge/index.js';
import { scanDiscoveredDocuments } from '../../src/knowledge/scan.js';
import { diagnosticCodes } from '../../src/schemas/errors.js';
import { sha256Digest } from '../../src/infra/fs.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  snapshotTree,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

function makeWorkspace(
  overrides: Record<string, unknown> = {},
  taskVisibility: 'private' | 'shared' = 'private',
): string {
  const root = makeTempDir('knowledge');
  writeWorkspaceConfig(
    root,
    baseWorkspaceConfig({
      knowledge: {
        sources: [],
        newDocuments: 'knowledge',
        taskVisibility,
      },
      ...overrides,
    }),
  );
  writeMachineConfig(root, baseMachineConfig(root));
  return root;
}

function input(
  path: string,
  overrides: Partial<RegisterDocumentInput> = {},
): RegisterDocumentInput {
  return {
    location: { kind: 'workspace', path },
    kind: 'architecture',
    maturity: 'draft',
    owner: 'human',
    ...overrides,
  };
}

test('registers an existing document in place with a stable id', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'architecture.md'), '# Architecture\n');
    const before = snapshotTree(root);
    const service = new KnowledgeService(root);
    const first = await service.register(input('docs/architecture.md'));
    assert.equal(first.ok, true, first.diagnostics[0]?.message);
    assert(first.record !== null);
    assert.match(first.record.documentId, /^[0-9a-f-]{36}$/);
    assert.equal(first.record.digest.startsWith('sha256:'), true);
    assert.equal(
      readFileSync(join(root, 'docs', 'architecture.md'), 'utf8'),
      '# Architecture\n',
    );
    const after = snapshotTree(root);
    assert.equal(
      after.get('docs/architecture.md'),
      before.get('docs/architecture.md'),
    );

    const second = await service.register(input('docs/architecture.md'));
    assert.equal(second.ok, true);
    assert.equal(second.status, 'existing');
    assert.equal(second.record?.documentId, first.record.documentId);

    const catalog = JSON.parse(
      readFileSync(
        join(root, '.pappra', 'local', 'knowledge', 'catalog.json'),
        'utf8',
      ),
    ) as { records: unknown[] };
    assert.equal(catalog.records.length, 1);
  } finally {
    cleanup(root);
  }
});

test('rejects duplicate ids and location conflicts without overwriting catalogs', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    writeText(join(root, 'docs', 'b.md'), '# B\n');
    const service = new KnowledgeService(root);
    const first = await service.register(input('docs/a.md'));
    assert.equal(first.ok, true);
    assert(first.record !== null);
    const before = snapshotTree(root);
    const duplicateId = await service.register(
      input('docs/b.md', { documentId: first.record.documentId }),
    );
    assert.equal(duplicateId.ok, false);
    const second = await service.register(
      input('docs/a.md', { documentId: crypto.randomUUID() }),
    );
    assert.equal(second.ok, false);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('keeps private records out of the shared catalog and default views', async () => {
  const root = makeWorkspace({}, 'private');
  try {
    writeText(join(root, 'docs', 'private.md'), '# Private\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/private.md'));
    assert.equal(registered.ok, true);
    assert.equal(registered.record?.visibility, 'private');
    assert.equal(
      existsSync(join(root, '.pappra', 'knowledge', 'catalog.json')),
      false,
    );
    const defaultList = await service.list();
    assert.equal(defaultList.records.length, 0);
    const privateList = await service.list({ includePrivate: true });
    assert.equal(privateList.records.length, 1);
    const check = await service.check();
    assert.equal(check.entries.length, 0);
  } finally {
    cleanup(root);
  }
});

test('uses taskVisibility only as the default visibility and keeps shareable explicit', async () => {
  const root = makeWorkspace({}, 'shared');
  try {
    writeText(join(root, 'docs', 'shared.md'), '# Shared\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/shared.md'));
    assert.equal(registered.ok, true);
    assert.equal(registered.record?.visibility, 'shareable');
    assert.equal(
      existsSync(join(root, '.pappra', 'knowledge', 'catalog.json')),
      true,
    );
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'knowledge', 'catalog.json')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('reads content without changing it and reports unknown freshness without sources', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert.equal(registered.ok, true);
    assert(registered.record !== null);
    const before = snapshotTree(root);
    const read = await service.read(registered.record.documentId);
    assert.equal(read.ok, true);
    assert.equal(read.text, '# A\n');
    assert.equal(read.freshness?.freshness, 'current');
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('does not open special files or escape warehouse boundaries', async () => {
  const root = makeWorkspace();
  const outside = makeTempDir('knowledge-outside');
  try {
    writeText(join(outside, 'outside.md'), '# outside\n');
    symlinkSync(outside, join(root, 'docs-outside'), 'dir');
    symlinkSync(join(outside, 'outside.md'), join(root, 'docs-link.md'));
    mkdirSync(join(root, 'docs-dir.md'));
    const service = new KnowledgeService(root);
    const escape = await service.register(input('docs-outside/outside.md'));
    assert.equal(escape.ok, false);
    const link = await service.register(input('docs-link.md'));
    assert.equal(link.ok, false);
    const directory = await service.register(input('docs-dir.md'));
    assert.equal(directory.ok, false);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('rejects oversized documents and preserves the file', async () => {
  const root = makeWorkspace();
  try {
    writeFileSync(
      join(root, 'docs-big.md'),
      Buffer.alloc(8 * 1024 * 1024 + 1, 65),
    );
    const service = new KnowledgeService(root);
    const result = await service.register(input('docs-big.md'));
    assert.equal(result.ok, false);
    assert(
      result.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.fileTooLarge,
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('creates a new document inside newDocuments with a preview-first proposal', async () => {
  const root = makeWorkspace({}, 'shared');
  try {
    const service = new KnowledgeService(root);
    const proposed = await service.proposeWrite({
      mode: 'create',
      location: { kind: 'workspace', path: 'knowledge/new.md' },
      kind: 'research',
      maturity: 'draft',
      owner: 'agent',
      content: '# New\n',
      expectedDigest: null,
    });
    assert.equal(proposed.ok, true, proposed.diagnostics[0]?.message);
    assert(proposed.proposal !== null);
    assert.equal(existsSync(join(root, 'knowledge', 'new.md')), false);
    assert.equal(
      existsSync(join(root, '.pappra', 'knowledge', 'catalog.json')),
      false,
    );
    const applied = await service.applyWrite({
      proposal: proposed.proposal,
      content: proposed.content ?? '',
    });
    assert.equal(applied.ok, true, applied.diagnostics[0]?.message);
    assert.equal(
      readFileSync(join(root, 'knowledge', 'new.md'), 'utf8'),
      '# New\n',
    );
    assert.equal(applied.record?.visibility, 'shareable');
  } finally {
    cleanup(root);
  }
});

test('rejects create targets outside newDocuments and exclusive collisions', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'README.md'), '# root\n');
    const service = new KnowledgeService(root);
    const outside = await service.proposeWrite({
      mode: 'create',
      location: { kind: 'workspace', path: 'README2.md' },
      kind: 'research',
      maturity: 'draft',
      owner: 'agent',
      content: 'x',
      expectedDigest: null,
    });
    assert.equal(outside.ok, false);
    const proposed = await service.proposeWrite({
      mode: 'create',
      location: { kind: 'workspace', path: 'knowledge/new.md' },
      kind: 'research',
      maturity: 'draft',
      owner: 'agent',
      content: '# New\n',
      expectedDigest: null,
    });
    assert.equal(proposed.ok, true);
    assert(proposed.proposal !== null);
    writeText(join(root, 'knowledge', 'new.md'), 'raced\n');
    const applied = await service.applyWrite({
      proposal: proposed.proposal,
      content: proposed.content ?? '',
    });
    assert.equal(applied.ok, false);
    assert.equal(
      readFileSync(join(root, 'knowledge', 'new.md'), 'utf8'),
      'raced\n',
    );
  } finally {
    cleanup(root);
  }
});

test('archive changes only metadata and leaves path and bytes unchanged', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    const before = snapshotTree(root);
    const archived = await service.archive(registered.record.documentId);
    assert.equal(archived.ok, true);
    assert.equal(archived.record?.lifecycle, 'archived');
    assert.equal(readFileSync(join(root, 'docs', 'a.md'), 'utf8'), '# A\n');
    assert.equal(snapshotTree(root).get('docs/a.md'), before.get('docs/a.md'));
  } finally {
    cleanup(root);
  }
});

test('supersede preserves files and rejects self, cycles, and dangling targets', async () => {
  const root = makeWorkspace();
  try {
    for (const name of ['a', 'b', 'c']) {
      writeText(join(root, 'docs', `${name}.md`), `# ${name}\n`);
    }
    const service = new KnowledgeService(root);
    const a = await service.register(input('docs/a.md'));
    const b = await service.register(input('docs/b.md'));
    const c = await service.register(input('docs/c.md'));
    assert(a.record && b.record && c.record);
    assert.equal(
      (
        await service.supersede({
          documentId: a.record.documentId,
          supersededBy: b.record.documentId,
        })
      ).ok,
      true,
    );
    assert.equal(
      (
        await service.supersede({
          documentId: b.record.documentId,
          supersededBy: c.record.documentId,
        })
      ).ok,
      true,
    );
    const self = await service.supersede({
      documentId: c.record.documentId,
      supersededBy: c.record.documentId,
    });
    assert.equal(self.ok, false);
    const cycle = await service.supersede({
      documentId: c.record.documentId,
      supersededBy: a.record.documentId,
    });
    assert.equal(cycle.ok, false);
    const target = crypto.randomUUID();
    const dangling = await service.supersede({
      documentId: c.record.documentId,
      supersededBy: target,
    });
    assert.equal(dangling.ok, false);
    assert.equal(readFileSync(join(root, 'docs', 'a.md'), 'utf8'), '# a\n');
  } finally {
    cleanup(root);
  }
});

test('proposes an update without writing and applies it with expected digest checks', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    const before = snapshotTree(root);
    const proposed = await service.proposeWrite({
      mode: 'update',
      documentId: registered.record.documentId,
      expectedDigest: registered.record.digest,
      content: '# A changed\n',
    });
    assert.equal(proposed.ok, true, proposed.diagnostics[0]?.message);
    assert(proposed.proposal !== null);
    assert.equal(proposed.proposal.diff.includes('+# A changed'), true);
    assert.deepEqual(snapshotTree(root), before);
    const stale = await service.applyWrite({
      proposal: proposed.proposal,
      content: '# tampered\n',
    });
    assert.equal(stale.ok, false);
    const applied = await service.applyWrite({
      proposal: proposed.proposal,
      content: proposed.content ?? '',
    });
    assert.equal(applied.ok, true, applied.diagnostics[0]?.message);
    assert.equal(
      readFileSync(join(root, 'docs', 'a.md'), 'utf8'),
      '# A changed\n',
    );
  } finally {
    cleanup(root);
  }
});

test('rejects a stale expected digest and an overwritten generated document', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    const wrong = await service.proposeWrite({
      mode: 'update',
      documentId: registered.record.documentId,
      expectedDigest: `sha256:${'0'.repeat(64)}`,
      content: 'x',
    });
    assert.equal(wrong.ok, false);
    writeText(join(root, 'docs', 'generated.md'), 'generated\n');
    const generated = await service.register(
      input('docs/generated.md', { owner: 'generator' }),
    );
    assert(generated.record !== null);
    writeText(join(root, 'docs', 'generated.md'), 'human edit\n');
    const modified = await service.proposeWrite({
      mode: 'update',
      documentId: generated.record.documentId,
      expectedDigest: sha256Digest(Buffer.from('human edit\n')),
      content: 'new generated\n',
    });
    assert.equal(modified.ok, false);
    assert(
      modified.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_generated_modified,
      ),
    );
    assert.equal(
      readFileSync(join(root, 'docs', 'generated.md'), 'utf8'),
      'human edit\n',
    );
  } finally {
    cleanup(root);
  }
});

test('rejects an old proposal after another catalog change', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    writeText(join(root, 'docs', 'b.md'), '# B\n');
    const service = new KnowledgeService(root);
    const a = await service.register(input('docs/a.md'));
    assert(a.record !== null);
    const proposed = await service.proposeWrite({
      mode: 'update',
      documentId: a.record.documentId,
      expectedDigest: a.record.digest,
      content: '# A2\n',
    });
    assert(proposed.proposal !== null);
    await service.register(input('docs/b.md'));
    const applied = await service.applyWrite({
      proposal: proposed.proposal,
      content: proposed.content ?? '',
    });
    assert.equal(applied.ok, false);
    assert(applied.status === 'stale' || applied.status === 'conflict');
    assert.equal(readFileSync(join(root, 'docs', 'a.md'), 'utf8'), '# A\n');
  } finally {
    cleanup(root);
  }
});

test('reports source freshness without rewriting the document', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'source.md'), '# Source\n');
    writeText(join(root, 'docs', 'dependent.md'), '# Dependent\n');
    const service = new KnowledgeService(root);
    const source = await service.register(input('docs/source.md'));
    assert(source.record !== null);
    const dependent = await service.register(
      input('docs/dependent.md', {
        sources: [
          {
            kind: 'document',
            documentId: source.record.documentId,
            digest: source.record.digest,
          },
        ],
      }),
    );
    assert(dependent.record !== null);
    const current = await service.read(dependent.record.documentId);
    assert.equal(current.freshness?.freshness, 'current');
    writeText(join(root, 'docs', 'source.md'), '# Source changed\n');
    const stale = await service.read(dependent.record.documentId);
    assert.equal(stale.freshness?.freshness, 'needs-review');
    assert.equal(
      readFileSync(join(root, 'docs', 'dependent.md'), 'utf8'),
      '# Dependent\n',
    );
  } finally {
    cleanup(root);
  }
});

test('previews and explicitly deletes a file only after a current plan', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'delete.md'), '# Delete\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/delete.md'));
    assert(registered.record !== null);
    const preview = await service.previewDelete({
      documentId: registered.record.documentId,
      removeFile: true,
    });
    assert.equal(preview.ok, true);
    assert.equal(preview.status, 'ready');
    assert(preview.plan !== null);
    assert.equal(
      readFileSync(join(root, 'docs', 'delete.md'), 'utf8'),
      '# Delete\n',
    );
    const deleted = await service.deleteExplicit({ plan: preview.plan });
    assert.equal(deleted.ok, true, deleted.diagnostics[0]?.message);
    assert.equal(existsSync(join(root, 'docs', 'delete.md')), false);
    const read = await service.read(registered.record.documentId);
    assert.equal(read.status, 'not-found');
  } finally {
    cleanup(root);
  }
});

test('blocks deletion for references, task-linked documents, and stale files', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'target.md'), '# Target\n');
    writeText(join(root, 'docs', 'referrer.md'), '# Referrer\n');
    const service = new KnowledgeService(root);
    const target = await service.register(input('docs/target.md'));
    assert(target.record !== null);
    await service.register(
      input('docs/referrer.md', {
        sources: [
          {
            kind: 'document',
            documentId: target.record.documentId,
            digest: target.record.digest,
          },
        ],
      }),
    );
    const referenced = await service.previewDelete({
      documentId: target.record.documentId,
      removeFile: true,
    });
    assert.equal(referenced.status, 'blocked');
    assert.equal(
      (await service.deleteExplicit({ plan: referenced.plan! })).ok,
      false,
    );

    writeText(join(root, 'docs', 'task.md'), '# Task\n');
    const task = await service.register(
      input('docs/task.md', { taskId: 'task-1' }),
    );
    assert(task.record !== null);
    const taskPreview = await service.previewDelete({
      documentId: task.record.documentId,
      removeFile: true,
    });
    assert.equal(taskPreview.status, 'blocked');

    writeText(join(root, 'docs', 'unref.md'), '# Unref\n');
    const unref = await service.register(input('docs/unref.md'));
    assert(unref.record !== null);
    const preview = await service.previewDelete({
      documentId: unref.record.documentId,
      removeFile: true,
    });
    assert(preview.plan !== null);
    writeText(join(root, 'docs', 'unref.md'), '# changed\n');
    const stale = await service.deleteExplicit({ plan: preview.plan });
    assert.equal(stale.ok, false);
    assert.equal(
      readFileSync(join(root, 'docs', 'unref.md'), 'utf8'),
      '# changed\n',
    );
    const expired = await service.deleteExplicit({
      plan: { ...preview.plan, createdAt: '2020-01-01T00:00:00.000Z' },
    });
    assert.equal(expired.status, 'stale');
    assert.equal(
      readFileSync(join(root, 'docs', 'unref.md'), 'utf8'),
      '# changed\n',
    );
  } finally {
    cleanup(root);
  }
});

test('removes a catalog record without deleting its file', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'keep.md'), '# Keep\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/keep.md'));
    assert(registered.record !== null);
    const preview = await service.previewDelete({
      documentId: registered.record.documentId,
      removeFile: false,
    });
    assert.equal(preview.status, 'ready');
    const removed = await service.deleteExplicit({ plan: preview.plan! });
    assert.equal(removed.ok, true, removed.diagnostics[0]?.message);
    assert.equal(removed.status, 'unregistered');
    assert.equal(
      readFileSync(join(root, 'docs', 'keep.md'), 'utf8'),
      '# Keep\n',
    );
  } finally {
    cleanup(root);
  }
});

test('fails closed on corrupt and unsupported catalogs without replacing bytes', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert.equal(registered.ok, true);
    const privateCatalog = join(
      root,
      '.pappra',
      'local',
      'knowledge',
      'catalog.json',
    );
    const corrupt = Buffer.from('{broken\n');
    writeFileSync(privateCatalog, corrupt);
    const read = await service.read(registered.record!.documentId);
    assert.equal(read.ok, false);
    const listed = await service.list({ includePrivate: true });
    assert.equal(listed.ok, false);
    assert.deepEqual(readFileSync(privateCatalog), corrupt);
    assert.equal(readFileSync(join(root, 'docs', 'a.md'), 'utf8'), '# A\n');

    const unsupported = Buffer.from(
      `${JSON.stringify({ schema: 'pappra/document-catalog/2' })}\n`,
    );
    writeFileSync(privateCatalog, unsupported);
    const archive = await service.archive(registered.record!.documentId);
    assert.equal(archive.ok, false);
    assert.deepEqual(readFileSync(privateCatalog), unsupported);
  } finally {
    cleanup(root);
  }
});

test('detects duplicate ids and locations across shared and private catalogs', async () => {
  const root = makeWorkspace({}, 'shared');
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    const sharedPath = join(root, '.pappra', 'knowledge', 'catalog.json');
    const privatePath = join(
      root,
      '.pappra',
      'local',
      'knowledge',
      'catalog.json',
    );
    const record = registered.record;
    const shared = JSON.parse(readFileSync(sharedPath, 'utf8')) as {
      records: unknown[];
      [key: string]: unknown;
    };
    writeFileSync(
      privatePath,
      `${JSON.stringify({ ...shared, records: [record, { ...record, visibility: 'private' }] }, null, 2)}\n`,
    );
    const listed = await service.list({ includePrivate: true });
    assert.equal(listed.ok, false);
    assert(
      listed.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_catalog_conflict,
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('returns a real residual when the catalog write fails after the file write', async () => {
  const root = makeWorkspace({}, 'shared');
  try {
    const catalogDir = join(root, '.pappra', 'knowledge');
    mkdirSync(catalogDir, { recursive: true });
    chmodSync(catalogDir, 0o555);
    try {
      const service = new KnowledgeService(root);
      const proposed = await service.proposeWrite({
        mode: 'create',
        location: { kind: 'workspace', path: 'knowledge/residual.md' },
        kind: 'research',
        maturity: 'draft',
        owner: 'agent',
        content: '# Residual\n',
        expectedDigest: null,
      });
      assert.equal(proposed.ok, true, proposed.diagnostics[0]?.message);
      const applied = await service.applyWrite({
        proposal: proposed.proposal!,
        content: proposed.content ?? '',
      });
      assert.equal(applied.ok, false);
      assert.equal(applied.status, 'partial');
      assert.equal(existsSync(join(root, 'knowledge', 'residual.md')), true);
      assert(
        applied.residualPaths.some((path) =>
          path.endsWith('/knowledge/residual.md'),
        ),
      );
      assert(applied.journalPath !== null);
      assert.equal(existsSync(applied.journalPath), true);
    } finally {
      chmodSync(catalogDir, 0o755);
    }
  } finally {
    cleanup(root);
  }
});

test('fails before catalog mutation when the new file cannot be created', async () => {
  const root = makeWorkspace({}, 'shared');
  try {
    const targetDir = join(root, 'knowledge');
    mkdirSync(targetDir, { recursive: true });
    chmodSync(targetDir, 0o555);
    try {
      const service = new KnowledgeService(root);
      const proposed = await service.proposeWrite({
        mode: 'create',
        location: { kind: 'workspace', path: 'knowledge/unwritable.md' },
        kind: 'research',
        maturity: 'draft',
        owner: 'agent',
        content: '# Nope\n',
        expectedDigest: null,
      });
      assert.equal(proposed.ok, true, proposed.diagnostics[0]?.message);
      const applied = await service.applyWrite({
        proposal: proposed.proposal!,
        content: proposed.content ?? '',
      });
      assert.equal(applied.ok, false);
      assert.equal(existsSync(join(root, 'knowledge', 'unwritable.md')), false);
      assert.equal(
        existsSync(join(root, '.pappra', 'knowledge', 'catalog.json')),
        false,
      );
    } finally {
      chmodSync(targetDir, 0o755);
    }
  } finally {
    cleanup(root);
  }
});

test('reads an external read-only repository but refuses writes', async () => {
  const root = makeWorkspace({
    repositories: [{ id: 'ext', path: 'external:ext', access: 'read' }],
  });
  const external = makeTempDir('knowledge-external');
  try {
    createRepository(external);
    writeText(join(external, 'docs', 'external.md'), '# External\n');
    writeMachineConfig(
      root,
      baseMachineConfig(root, {
        externalRepositories: [{ id: 'ext', path: external }],
      }),
    );
    const service = new KnowledgeService(root);
    const registered = await service.register({
      location: { kind: 'source', sourceId: 'ext', path: 'docs/external.md' },
      kind: 'architecture',
      maturity: 'draft',
      owner: 'human',
    });
    assert.equal(registered.ok, true, registered.diagnostics[0]?.message);
    assert(registered.record !== null);
    const read = await service.read(registered.record.documentId);
    assert.equal(read.ok, true);
    assert.equal(read.text, '# External\n');
    const update = await service.proposeWrite({
      mode: 'update',
      documentId: registered.record.documentId,
      expectedDigest: registered.record.digest,
      content: '# Changed\n',
    });
    assert.equal(update.ok, false);
    assert(
      update.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_access_denied,
      ),
    );
    assert.equal(
      readFileSync(join(external, 'docs', 'external.md'), 'utf8'),
      '# External\n',
    );
    const preview = await service.previewDelete({
      documentId: registered.record.documentId,
      removeFile: true,
    });
    assert.equal(preview.status, 'blocked');
  } finally {
    cleanup(root);
    cleanup(external);
  }
});

test('sharing is an explicit private-to-shareable catalog move', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'share.md'), '# Share\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/share.md'));
    assert(registered.record !== null);
    assert.equal((await service.list()).records.length, 0);
    const shared = await service.share(registered.record.documentId);
    assert.equal(shared.ok, true, shared.diagnostics[0]?.message);
    assert.equal(shared.record?.visibility, 'shareable');
    assert.equal((await service.list()).records.length, 1);
    assert.equal(
      (await service.list({ includePrivate: true })).records.length,
      1,
    );
    assert.equal(
      existsSync(join(root, '.pappra', 'knowledge', 'catalog.json')),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test('rejects a FIFO document candidate without blocking', async () => {
  if (process.platform === 'win32') return;
  const root = makeWorkspace();
  try {
    mkdirSync(join(root, 'docs'), { recursive: true });
    execFileSync('mkfifo', [join(root, 'docs', 'pipe.md')]);
    const service = new KnowledgeService(root);
    const result = await service.register(input('docs/pipe.md'));
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(root, 'docs', 'pipe.md')), true);
  } finally {
    cleanup(root);
  }
});

test('does not lose the first write when two proposals race', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    const first = await service.proposeWrite({
      mode: 'update',
      documentId: registered.record.documentId,
      expectedDigest: registered.record.digest,
      content: '# First\n',
    });
    const second = await service.proposeWrite({
      mode: 'update',
      documentId: registered.record.documentId,
      expectedDigest: registered.record.digest,
      content: '# Second\n',
    });
    assert(first.proposal !== null && second.proposal !== null);
    assert.equal(
      (
        await service.applyWrite({
          proposal: first.proposal,
          content: first.content ?? '',
        })
      ).ok,
      true,
    );
    writeText(join(root, 'docs', 'a.md'), '# Human note\n');
    const stale = await service.applyWrite({
      proposal: second.proposal,
      content: second.content ?? '',
    });
    assert.equal(stale.ok, false);
    assert.equal(
      readFileSync(join(root, 'docs', 'a.md'), 'utf8'),
      '# Human note\n',
    );
  } finally {
    cleanup(root);
  }
});

test('records a code source version and reports HEAD changes as needs-review', async () => {
  const root = makeTempDir('knowledge-code-source');
  try {
    createRepository(root);
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [{ id: 'app', path: '.', access: 'write' }],
        knowledge: {
          sources: [],
          newDocuments: 'knowledge',
          taskVisibility: 'private',
        },
      }),
    );
    writeMachineConfig(root, baseMachineConfig(root));
    writeText(join(root, 'docs', 'code.md'), '# Code\n');
    writeText(join(root, 'src', 'code.ts'), 'export const value = 1;\n');
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const service = new KnowledgeService(root);
    const registered = await service.register(
      input('docs/code.md', {
        sources: [
          {
            kind: 'code',
            repositoryId: 'app',
            path: 'src/code.ts',
            version: head,
          },
        ],
      }),
    );
    assert.equal(registered.ok, true, registered.diagnostics[0]?.message);
    assert(registered.record !== null);
    assert.equal(
      (await service.read(registered.record.documentId)).freshness?.freshness,
      'current',
    );
    execFileSync('git', ['-C', root, 'add', 'src/code.ts'], {
      encoding: 'utf8',
    });
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'user.name=Fixture',
      'commit',
      '-q',
      '-m',
      'code change',
    ]);
    const fresh = await service.read(registered.record.documentId);
    assert.equal(fresh.freshness?.freshness, 'needs-review');
    assert.equal(
      readFileSync(join(root, 'docs', 'code.md'), 'utf8'),
      '# Code\n',
    );
  } finally {
    cleanup(root);
  }
});

test('does not let shared records cite private sources', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'private-source.md'), '# Private\n');
    writeText(join(root, 'docs', 'shared.md'), '# Shared\n');
    const service = new KnowledgeService(root);
    const privateSource = await service.register(
      input('docs/private-source.md'),
    );
    assert(privateSource.record !== null);
    const shared = await service.register(
      input('docs/shared.md', {
        visibility: 'shareable',
        sources: [
          {
            kind: 'document',
            documentId: privateSource.record.documentId,
            digest: privateSource.record.digest,
          },
        ],
      }),
    );
    assert.equal(shared.ok, false);
    assert(
      shared.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_visibility_invalid,
      ),
    );
    assert.equal(
      existsSync(join(root, '.pappra', 'knowledge', 'catalog.json')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('allows an explicit human/agent update after an unregistered on-disk edit', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    writeText(join(root, 'docs', 'a.md'), '# Manually edited\n');
    const actual = sha256Digest(Buffer.from('# Manually edited\n'));
    const proposed = await service.proposeWrite({
      mode: 'update',
      documentId: registered.record.documentId,
      expectedDigest: actual,
      content: '# Reviewed update\n',
    });
    assert.equal(proposed.ok, true, proposed.diagnostics[0]?.message);
    const applied = await service.applyWrite({
      proposal: proposed.proposal!,
      content: proposed.content ?? '',
    });
    assert.equal(applied.ok, true, applied.diagnostics[0]?.message);
    assert.equal(
      readFileSync(join(root, 'docs', 'a.md'), 'utf8'),
      '# Reviewed update\n',
    );
    const read = await service.read(registered.record.documentId);
    assert.equal(read.freshness?.freshness, 'current');
  } finally {
    cleanup(root);
  }
});

test('rejects a delete plan when the same bytes are replaced by a new inode', async () => {
  const root = makeWorkspace();
  try {
    const path = join(root, 'docs', 'replace.md');
    writeText(path, '# Same bytes\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/replace.md'));
    assert(registered.record !== null);
    const preview = await service.previewDelete({
      documentId: registered.record.documentId,
      removeFile: true,
    });
    assert.equal(preview.status, 'ready');
    const replacement = join(root, 'docs', 'replacement.tmp');
    writeText(replacement, '# Same bytes\n');
    renameSync(replacement, path);
    const stale = await service.deleteExplicit({ plan: preview.plan! });
    assert.equal(stale.status, 'stale');
    assert.equal(existsSync(path), true);
    assert.equal(
      (await service.list({ includePrivate: true })).records.length,
      1,
    );
  } finally {
    cleanup(root);
  }
});

test('rejects canonical location aliases for the same real file', async () => {
  const root = makeWorkspace({
    repositories: [{ id: 'app', path: '.', access: 'write' }],
  });
  try {
    createRepository(root);
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const first = await service.register(input('docs/a.md'));
    assert.equal(first.ok, true, first.diagnostics[0]?.message);
    const alias = await service.register({
      location: { kind: 'source', sourceId: 'app', path: 'docs/a.md' },
      kind: 'architecture',
      maturity: 'draft',
      owner: 'human',
    });
    assert.equal(alias.ok, false);
    assert(
      alias.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_location_conflict,
      ),
    );
    const listed = await service.list({ includePrivate: true });
    assert.equal(listed.records.length, 1);
  } finally {
    cleanup(root);
  }
});

test('binds workspace writes and deletes to the canonical containing repository access', async () => {
  const root = makeWorkspace({
    repositories: [{ id: 'app', path: '.', access: 'read' }],
  });
  try {
    createRepository(root);
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert.equal(registered.ok, true, registered.diagnostics[0]?.message);
    assert(registered.record !== null);
    const update = await service.proposeWrite({
      mode: 'update',
      documentId: registered.record.documentId,
      expectedDigest: registered.record.digest,
      content: '# Changed\n',
    });
    assert.equal(update.ok, false);
    assert(
      update.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_access_denied,
      ),
    );
    const preview = await service.previewDelete({
      documentId: registered.record.documentId,
      removeFile: true,
    });
    assert.equal(preview.status, 'blocked');
    assert.equal(readFileSync(join(root, 'docs', 'a.md'), 'utf8'), '# A\n');
  } finally {
    cleanup(root);
  }
});

test('preserves a same-inode user edit when exclusive creation sync fails', async () => {
  const root = makeWorkspace({}, 'shared');
  try {
    const service = new KnowledgeService(root, {
      beforeFileSync: (path) => {
        writeFileSync(path, 'user replacement\n');
      },
      failFileSync: true,
    });
    const proposed = await service.proposeWrite({
      mode: 'create',
      location: { kind: 'workspace', path: 'knowledge/sync-failure.md' },
      kind: 'research',
      maturity: 'draft',
      owner: 'agent',
      content: '# Intended\n',
      expectedDigest: null,
    });
    assert.equal(proposed.ok, true, proposed.diagnostics[0]?.message);
    const applied = await service.applyWrite({
      proposal: proposed.proposal!,
      content: proposed.content ?? '',
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'partial');
    const target = join(root, 'knowledge', 'sync-failure.md');
    assert.equal(readFileSync(target, 'utf8'), 'user replacement\n');
    assert(
      applied.residualPaths.some((path) =>
        path.endsWith('/knowledge/sync-failure.md'),
      ),
    );
    assert(applied.journalPath !== null);
    assert.equal(existsSync(applied.journalPath), true);
    const journal = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as {
      stage: string;
      residualPaths: string[];
    };
    assert.equal(journal.stage, 'failed');
    assert(
      journal.residualPaths.some((path) =>
        path.endsWith('/knowledge/sync-failure.md'),
      ),
    );
    assert.equal(
      existsSync(join(root, '.pappra', 'knowledge', 'catalog.json')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('cleans an ordinary partial exclusive write and reports no residual', async () => {
  const root = makeWorkspace({}, 'shared');
  try {
    const service = new KnowledgeService(root, {
      beforeFileSync: (path) => {
        truncateSync(path, 4);
      },
      failFileSync: true,
    });
    const proposed = await service.proposeWrite({
      mode: 'create',
      location: { kind: 'workspace', path: 'knowledge/partial.md' },
      kind: 'research',
      maturity: 'draft',
      owner: 'agent',
      content: '# Partial\n',
      expectedDigest: null,
    });
    assert.equal(proposed.ok, true, proposed.diagnostics[0]?.message);
    const applied = await service.applyWrite({
      proposal: proposed.proposal!,
      content: proposed.content ?? '',
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'failed');
    assert.equal(existsSync(join(root, 'knowledge', 'partial.md')), false);
    assert.deepEqual(applied.residualPaths, []);
    assert(applied.journalPath !== null);
    assert.equal(existsSync(applied.journalPath), true);
    assert.equal(
      existsSync(join(root, '.pappra', 'knowledge', 'catalog.json')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('scan reports missing sources and keeps private registrations discoverable', async () => {
  const root = makeWorkspace(
    {
      knowledge: {
        sources: ['docs', 'missing'],
        newDocuments: 'knowledge',
        taskVisibility: 'private',
      },
    },
    'private',
  );
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const before = snapshotTree(root);
    const plan = await scanDiscoveredDocuments(root, { apply: false });
    if ('message' in plan) assert.fail(plan.message);
    assert.equal(plan.ok, false);
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0]?.visibility, 'private');
    assert.equal(
      plan.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.knowledgeSourceMissing,
      ),
      true,
    );
    assert.equal(
      plan.nextActions.some((action) =>
        action.includes('pappra docs list --include-private'),
      ),
      true,
    );
    assert.deepEqual(snapshotTree(root), before);

    const applied = await scanDiscoveredDocuments(root, { apply: true });
    if ('message' in applied) assert.fail(applied.message);
    assert.equal(applied.ok, false);
    assert.equal(applied.registered.length, 1);
    assert.equal(applied.skipped, 0);
    assert.equal(
      applied.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.knowledgeSourceMissing,
      ),
      true,
    );
    assert.equal(
      applied.nextActions.some((action) =>
        action.includes('pappra docs list --include-private'),
      ),
      true,
    );

    const service = new KnowledgeService(root);
    const hidden = await service.list();
    assert.equal(hidden.records.length, 0);
    const visible = await service.list({ includePrivate: true });
    assert.equal(visible.records.length, 1);
    const documentId = visible.records[0]?.documentId;

    const repeated = await scanDiscoveredDocuments(root, { apply: true });
    if ('message' in repeated) assert.fail(repeated.message);
    assert.equal(repeated.ok, false);
    assert.equal(repeated.registered.length, 0);
    assert.equal(repeated.candidates.length, 0);
    assert.equal(
      (await service.list({ includePrivate: true })).records[0]?.documentId,
      documentId,
    );
  } finally {
    cleanup(root);
  }
});

test('scan reports truncated discovery as incomplete coverage', async () => {
  const root = makeWorkspace(
    {
      knowledge: {
        sources: ['docs'],
        newDocuments: 'knowledge',
        taskVisibility: 'private',
      },
    },
    'private',
  );
  try {
    for (let index = 0; index < 205; index += 1) {
      writeText(join(root, 'docs', `doc-${index}.md`), `# Doc ${index}\n`);
    }
    const plan = await scanDiscoveredDocuments(root, { apply: false });
    if ('message' in plan) assert.fail(plan.message);
    assert.equal(plan.ok, false);
    assert.equal(plan.candidates.length > 0, true);
    assert.equal(
      plan.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.discoveryLimitReached,
      ),
      true,
    );
    assert.equal(
      plan.diagnostics.some((entry) =>
        entry.message.includes('truncated; scan coverage is incomplete'),
      ),
      true,
    );
    assert.equal(
      plan.nextActions.some((action) =>
        action.includes('rerun the scan for complete coverage'),
      ),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test('scan refuses an invalid catalog without replacing it or registering', async () => {
  const root = makeWorkspace(
    {
      knowledge: {
        sources: ['docs'],
        newDocuments: 'knowledge',
        taskVisibility: 'private',
      },
    },
    'private',
  );
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const catalogDir = join(root, '.pappra', 'local', 'knowledge');
    mkdirSync(catalogDir, { recursive: true });
    const catalogPath = join(catalogDir, 'catalog.json');
    writeFileSync(catalogPath, '{not-json\n');
    const before = readFileSync(catalogPath);
    const plan = await scanDiscoveredDocuments(root, { apply: false });
    if ('message' in plan) assert.fail(plan.message);
    assert.equal(plan.ok, false);
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.registered.length, 0);
    assert.equal(
      plan.diagnostics.some((entry) => entry.severity === 'error'),
      true,
    );
    assert.deepEqual(readFileSync(catalogPath), before);

    const applied = await scanDiscoveredDocuments(root, { apply: true });
    if ('message' in applied) assert.fail(applied.message);
    assert.equal(applied.ok, false);
    assert.equal(applied.candidates.length, 0);
    assert.equal(applied.registered.length, 0);
    assert.deepEqual(readFileSync(catalogPath), before);
    assert.equal(
      existsSync(join(root, '.pappra', 'knowledge', 'catalog.json')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('scan deduplicates archived locations without changing records or catalog', async () => {
  const root = makeWorkspace(
    {
      knowledge: {
        sources: ['docs'],
        newDocuments: 'knowledge',
        taskVisibility: 'private',
      },
    },
    'private',
  );
  try {
    writeText(join(root, 'docs', 'private-archived.md'), '# Private\n');
    writeText(join(root, 'docs', 'shared-archived.md'), '# Shared\n');
    const service = new KnowledgeService(root);
    const privateRecord = await service.register({
      location: { kind: 'workspace', path: 'docs/private-archived.md' },
      kind: 'decision',
      maturity: 'reviewed',
      owner: 'agent',
      visibility: 'private',
    });
    const sharedRecord = await service.register({
      location: { kind: 'workspace', path: 'docs/shared-archived.md' },
      kind: 'research',
      maturity: 'draft',
      owner: 'human',
      visibility: 'shareable',
    });
    const privateId = privateRecord.record!.documentId;
    const sharedId = sharedRecord.record!.documentId;
    const archivedPrivate = await service.archive(privateId);
    const archivedShared = await service.archive(sharedId);
    assert.equal(
      archivedPrivate.ok,
      true,
      archivedPrivate.diagnostics[0]?.message,
    );
    assert.equal(
      archivedShared.ok,
      true,
      archivedShared.diagnostics[0]?.message,
    );
    const catalogPath = join(
      root,
      '.pappra',
      'local',
      'knowledge',
      'catalog.json',
    );
    const catalogBytes = readFileSync(catalogPath);

    const plan = await scanDiscoveredDocuments(root, { apply: false });
    if ('message' in plan) assert.fail(plan.message);
    assert.equal(plan.ok, true);
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.registered.length, 0);
    assert.equal(
      plan.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_already_registered,
      ),
      false,
    );
    assert.deepEqual(readFileSync(catalogPath), catalogBytes);

    const applied = await scanDiscoveredDocuments(root, { apply: true });
    if ('message' in applied) assert.fail(applied.message);
    assert.equal(applied.ok, true);
    assert.equal(applied.candidates.length, 0);
    assert.equal(applied.registered.length, 0);
    assert.deepEqual(readFileSync(catalogPath), catalogBytes);

    const archivedList = await service.list({
      includePrivate: true,
      includeArchived: true,
    });
    const preservedPrivate = archivedList.records.find(
      (record) => record.documentId === privateId,
    );
    const preservedShared = archivedList.records.find(
      (record) => record.documentId === sharedId,
    );
    assert.equal(preservedPrivate?.lifecycle, 'archived');
    assert.equal(preservedPrivate?.maturity, 'reviewed');
    assert.equal(preservedPrivate?.kind, 'decision');
    assert.equal(preservedPrivate?.owner, 'agent');
    assert.equal(preservedShared?.lifecycle, 'archived');
    assert.equal(preservedShared?.maturity, 'draft');
    assert.equal(preservedShared?.kind, 'research');
    assert.equal(preservedShared?.owner, 'human');

    writeText(
      join(root, 'docs', 'private-archived.md'),
      '# Changed archived content\n',
    );
    const changed = await scanDiscoveredDocuments(root, { apply: true });
    if ('message' in changed) assert.fail(changed.message);
    assert.equal(changed.ok, true);
    assert.equal(changed.candidates.length, 0);
    assert.equal(changed.registered.length, 0);
    assert.equal(
      changed.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_already_registered,
      ),
      false,
    );
    assert.deepEqual(readFileSync(catalogPath), catalogBytes);
  } finally {
    cleanup(root);
  }
});
