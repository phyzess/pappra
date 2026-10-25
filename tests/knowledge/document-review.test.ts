import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  KnowledgeService,
  type ApplyReviewResult,
  type RegisterDocumentInput,
} from '../../src/knowledge/index.js';
import { scanDiscoveredDocuments } from '../../src/knowledge/scan.js';
import { applyReviewAt } from '../../src/knowledge/review.js';
import { loadKnowledgeContext } from '../../src/knowledge/context.js';
import { diagnosticCodes } from '../../src/schemas/errors.js';
import { sha256Digest } from '../../src/infra/fs.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  makeTempDir,
  snapshotTree,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

function makeWorkspace(
  taskVisibility: 'private' | 'shared' = 'private',
  sources: readonly string[] = [],
): string {
  const root = makeTempDir('knowledge-review');
  writeWorkspaceConfig(
    root,
    baseWorkspaceConfig({
      knowledge: {
        sources: [...sources],
        newDocuments: 'knowledge',
        taskVisibility,
      },
    }),
  );
  writeMachineConfig(root, baseMachineConfig(root));
  return root;
}

/** Snapshot of file contents only; a lock file changes its parent directory mtime. */
function fileEntries(root: string): Map<string, string> {
  return new Map(
    [...snapshotTree(root)].filter(([, value]) => value.startsWith('file:')),
  );
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

function sharedRecordsPath(root: string): string {
  return join(root, '.pappra', 'knowledge', 'records');
}

test('accepts reviewed bytes for the same documentId and preserves every other field', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'basis.md'), '# Basis\n');
    writeText(join(root, 'docs', 'guide.md'), '# Guide\n');
    const service = new KnowledgeService(root);
    const basis = await service.register(input('docs/basis.md'));
    assert(basis.record !== null);
    const registered = await service.register(
      input('docs/guide.md', {
        kind: 'decision',
        maturity: 'draft',
        owner: 'agent',
        taskId: 'task-guide',
        sources: [
          {
            kind: 'document',
            documentId: basis.record.documentId,
            digest: basis.record.digest,
          },
        ],
      }),
    );
    assert(registered.record !== null, registered.diagnostics[0]?.message);
    const before = registered.record;
    writeText(
      join(root, 'docs', 'guide.md'),
      '# Guide\n\nReviewed addition.\n',
    );
    const reviewedBytes = readFileSync(join(root, 'docs', 'guide.md'));
    const reviewedDigest = sha256Digest(reviewedBytes);
    const treeBefore = snapshotTree(root);

    const checked = await service.check({ includePrivate: true });
    assert.equal(checked.entries.length, 2);
    assert.equal(
      checked.entries.find((entry) => entry.documentId === before.documentId)
        ?.freshness,
      'needs-review',
    );

    const preview = await service.previewReview({
      documentId: before.documentId,
    });
    assert.equal(preview.ok, true, preview.diagnostics[0]?.message);
    assert.equal(preview.status, 'ready');
    assert(preview.plan !== null);
    assert.equal(preview.plan.expectedFileDigest, reviewedDigest);
    assert.equal(preview.plan.recordDigest, before.digest);
    assert.equal(preview.plan.scope, 'private');
    assert.equal(
      treeBefore.get('docs/guide.md'),
      snapshotTree(root).get('docs/guide.md'),
    );

    const applied = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: reviewedDigest,
    });
    assert.equal(applied.ok, true, applied.diagnostics[0]?.message);
    assert.equal(applied.status, 'reviewed');
    assert(applied.record !== null);
    assert.equal(applied.record.documentId, before.documentId);
    assert.equal(applied.record.digest, reviewedDigest);
    assert.equal(applied.record.lastReviewedAt, preview.plan.reviewedAt);
    assert.equal(applied.record.kind, before.kind);
    assert.equal(applied.record.maturity, before.maturity);
    assert.equal(applied.record.owner, before.owner);
    assert.equal(applied.record.taskId, before.taskId);
    assert.equal(applied.record.visibility, before.visibility);
    assert.equal(applied.record.lifecycle, 'active');
    assert.equal(applied.record.supersededBy, null);
    assert.deepEqual(applied.record.location, before.location);
    assert.deepEqual(applied.record.sources, before.sources);
    assert.deepEqual(
      readFileSync(join(root, 'docs', 'guide.md')),
      reviewedBytes,
    );
    assert.equal(
      treeBefore.get('docs/basis.md'),
      snapshotTree(root).get('docs/basis.md'),
    );

    assert(applied.journalPath !== null);
    const journal = JSON.parse(readFileSync(applied.journalPath, 'utf8')) as {
      operation: string;
      stage: string;
      fileDigest: string;
      expectedDigest: string;
    };
    assert.equal(journal.operation, 'review-document');
    assert.equal(journal.stage, 'complete');
    assert.equal(journal.fileDigest, reviewedDigest);
    assert.equal(journal.expectedDigest, before.digest);

    const after = await service.check({ includePrivate: true });
    assert.equal(
      after.entries.find((entry) => entry.documentId === before.documentId)
        ?.freshness,
      'current',
    );
    const listed = await service.list({ includePrivate: true });
    assert.equal(listed.records.length, 2);
    assert.equal(
      listed.records.filter((record) => record.documentId === before.documentId)
        .length,
      1,
    );

    const duplicate = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: reviewedDigest,
    });
    assert.equal(duplicate.status, 'unchanged');
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.record?.digest, reviewedDigest);
  } finally {
    cleanup(root);
  }
});

test('refuses a reviewed digest that does not match the pinned plan without mutating state', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    writeText(join(root, 'docs', 'a.md'), '# A reviewed\n');
    const preview = await service.previewReview({
      documentId: registered.record.documentId,
    });
    assert(preview.plan !== null);
    const before = snapshotTree(root);
    const wrong = sha256Digest(Buffer.from('# Something else\n'));
    assert.notEqual(wrong, preview.plan.expectedFileDigest);
    const applied = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: wrong,
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'stale');
    assert(
      applied.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_proposal_stale,
      ),
    );
    assert(applied.journalPath === null);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('refuses apply when the document bytes change after the plan', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    writeText(join(root, 'docs', 'a.md'), '# Reviewed A\n');
    const preview = await service.previewReview({
      documentId: registered.record.documentId,
    });
    assert(preview.plan !== null);
    writeText(join(root, 'docs', 'a.md'), '# Changed again\n');
    const before = fileEntries(root);
    const applied = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: preview.plan.expectedFileDigest,
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'stale');
    assert(
      applied.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_file_changed,
      ),
    );
    const read = await service.read(registered.record.documentId);
    assert.equal(read.record?.digest, registered.record.digest);
    assert.equal(read.freshness?.freshness, 'needs-review');
    assert.deepEqual(fileEntries(root), before);
  } finally {
    cleanup(root);
  }
});

test('refuses apply after a concurrent catalog change and keeps the other record intact', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    writeText(join(root, 'docs', 'b.md'), '# B\n');
    const service = new KnowledgeService(root);
    const first = await service.register(input('docs/a.md'));
    const second = await service.register(input('docs/b.md'));
    assert(first.record !== null);
    assert(second.record !== null);
    writeText(join(root, 'docs', 'a.md'), '# Reviewed A\n');
    const preview = await service.previewReview({
      documentId: first.record.documentId,
    });
    assert(preview.plan !== null);
    const archived = await service.archive(second.record.documentId);
    assert.equal(archived.ok, true, archived.diagnostics[0]?.message);
    const before = snapshotTree(root);
    const applied = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: preview.plan.expectedFileDigest,
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'stale');
    assert.deepEqual(snapshotTree(root), before);
    const read = await service.read(first.record.documentId);
    assert.equal(read.record?.digest, first.record.digest);
  } finally {
    cleanup(root);
  }
});

test('refuses a missing file, a symlink, and an unregistered document', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    writeText(join(root, 'docs', 'target.md'), '# Target\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);

    const missing = await service.previewReview({ documentId: randomUUID() });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 'not-found');

    unlinkSync(join(root, 'docs', 'a.md'));
    const gone = await service.previewReview({
      documentId: registered.record.documentId,
    });
    assert.equal(gone.ok, false);
    assert.equal(gone.status, 'failed');
    assert(
      gone.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_not_found,
      ),
    );

    symlinkSync(join(root, 'docs', 'target.md'), join(root, 'docs', 'a.md'));
    const symlinked = await service.previewReview({
      documentId: registered.record.documentId,
    });
    assert.equal(symlinked.ok, false);
    assert.equal(symlinked.plan, null);
    assert(
      symlinked.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_path_unsafe,
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('reviews a shared record with an explicit scope and rejects a mismatched scope', async () => {
  const root = makeWorkspace('shared');
  try {
    writeText(join(root, 'docs', 'shared.md'), '# Shared\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/shared.md'));
    assert(registered.record !== null);
    const shared = await service.share(registered.record.documentId);
    assert.equal(shared.ok, true, shared.diagnostics[0]?.message);
    writeText(join(root, 'docs', 'shared.md'), '# Shared reviewed\n');
    const reviewedDigest = sha256Digest(Buffer.from('# Shared reviewed\n'));

    const mismatched = await service.previewReview({
      documentId: registered.record.documentId,
      scope: 'private',
    });
    assert.equal(mismatched.ok, false);
    assert.equal(mismatched.status, 'conflict');
    assert(
      mismatched.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_visibility_invalid,
      ),
    );

    const preview = await service.previewReview({
      documentId: registered.record.documentId,
      scope: 'shared',
    });
    assert.equal(preview.ok, true, preview.diagnostics[0]?.message);
    assert.equal(preview.plan?.scope, 'shared');
    assert(preview.plan !== null);
    const applied = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: reviewedDigest,
    });
    assert.equal(applied.ok, true, applied.diagnostics[0]?.message);
    assert.equal(applied.status, 'reviewed');
    assert.equal(applied.record?.documentId, registered.record.documentId);
    assert.equal(applied.record?.visibility, 'shareable');
    assert.equal(applied.record?.digest, reviewedDigest);
    const visible = await service.list();
    assert.equal(visible.records.length, 1);
    const listed = JSON.parse(
      readFileSync(
        join(sharedRecordsPath(root), `${registered.record.documentId}.json`),
        'utf8',
      ),
    ) as { record: { digest: string; lastReviewedAt: string | null } };
    assert.equal(listed.record.digest, reviewedDigest);
    assert.equal(listed.record.lastReviewedAt, preview.plan.reviewedAt);
  } finally {
    cleanup(root);
  }
});

test('reports an ambiguous documentId registered in both catalogs', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    const record = {
      ...registered.record,
      visibility: 'shareable' as const,
    };
    mkdirSync(sharedRecordsPath(root), { recursive: true });
    writeFileSync(
      join(sharedRecordsPath(root), `${record.documentId}.json`),
      `${JSON.stringify(
        {
          schema: 'pappra/document-record-file/1',
          workspaceId: baseWorkspaceConfig().workspaceId,
          record,
        },
        null,
        2,
      )}\n`,
    );
    const preview = await service.previewReview({
      documentId: record.documentId,
    });
    assert.equal(preview.ok, false);
    assert.equal(preview.status, 'ambiguous');
    assert.equal(preview.plan, null);
    assert(
      preview.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_duplicate_id,
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('refuses to apply while the knowledge lock is held', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    writeText(join(root, 'docs', 'a.md'), '# Reviewed A\n');
    const preview = await service.previewReview({
      documentId: registered.record.documentId,
    });
    assert(preview.plan !== null);
    const lockPath = join(root, '.pappra', 'local', 'knowledge', 'apply.lock');
    writeFileSync(
      lockPath,
      `${JSON.stringify(
        {
          schema: 'pappra/knowledge-lock/1',
          token: randomUUID(),
          operation: 'review-document',
          pid: process.pid,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    const before = fileEntries(root);
    const applied = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: preview.plan.expectedFileDigest,
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.status, 'locked');
    assert.deepEqual(fileEntries(root), before);
    assert(
      applied.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_locked,
      ),
    );
    unlinkSync(lockPath);
    const retried = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: preview.plan.expectedFileDigest,
    });
    assert.equal(retried.ok, true, retried.diagnostics[0]?.message);
    assert.equal(retried.status, 'reviewed');
  } finally {
    cleanup(root);
  }
});

test('leaves no partial mutation and a recoverable journal when the catalog write fails', async () => {
  if (process.platform === 'win32') return;
  const root = makeWorkspace('shared');
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    const shared = await service.share(registered.record.documentId);
    assert.equal(shared.ok, true, shared.diagnostics[0]?.message);
    writeText(join(root, 'docs', 'a.md'), '# Reviewed A\n');
    const preview = await service.previewReview({
      documentId: registered.record.documentId,
      scope: 'shared',
    });
    assert(preview.plan !== null);
    const recordsPath = sharedRecordsPath(root);
    const before = snapshotTree(root);
    chmodSync(recordsPath, 0o500);
    let failed: ApplyReviewResult | null = null;
    try {
      failed = await service.applyReview({
        plan: preview.plan,
        expectedFileDigest: preview.plan.expectedFileDigest,
      });
    } finally {
      chmodSync(recordsPath, 0o700);
    }
    assert(failed !== null);
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 'failed');
    assert(failed.journalPath !== null);
    const journal = JSON.parse(readFileSync(failed.journalPath, 'utf8')) as {
      stage: string;
      detail: string | null;
    };
    assert.equal(journal.stage, 'failed');
    assert(journal.detail !== null);
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'knowledge', 'apply.lock')),
      false,
    );
    const afterFailure = snapshotTree(root);
    assert.equal(
      afterFailure.get(
        `.pappra/knowledge/records/${registered.record.documentId}.json`,
      ),
      before.get(
        `.pappra/knowledge/records/${registered.record.documentId}.json`,
      ),
    );
    const read = await service.read(registered.record.documentId);
    assert.equal(read.record?.digest, registered.record.digest);

    const retried = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: preview.plan.expectedFileDigest,
    });
    assert.equal(retried.ok, true, retried.diagnostics[0]?.message);
    assert.equal(retried.status, 'reviewed');
    assert.equal(retried.record?.digest, preview.plan.expectedFileDigest);
  } finally {
    cleanup(root);
  }
});

test('docs scan never accepts changed bytes for an existing registration', async () => {
  const root = makeWorkspace('private', ['knowledge']);
  try {
    writeText(join(root, 'knowledge', 'scan-target.md'), '# Scan\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(
      input('knowledge/scan-target.md'),
    );
    assert(registered.record !== null);
    writeText(join(root, 'knowledge', 'scan-target.md'), '# Scan changed\n');
    const scanned = await scanDiscoveredDocuments(root, { apply: true });
    assert(!('message' in scanned));
    assert.equal(scanned.candidates.length, 0);
    assert.equal(scanned.registered.length, 0);
    const read = await service.read(registered.record.documentId);
    assert.equal(read.record?.digest, registered.record.digest);
    assert.equal(read.freshness?.freshness, 'needs-review');
  } finally {
    cleanup(root);
  }
});

test('refuses a repeated plan once the reviewed bytes change', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    writeText(join(root, 'docs', 'a.md'), '# Reviewed A\n');
    const reviewedDigest = sha256Digest(Buffer.from('# Reviewed A\n'));
    const preview = await service.previewReview({
      documentId: registered.record.documentId,
    });
    assert(preview.plan !== null);
    const applied = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: reviewedDigest,
    });
    assert.equal(applied.status, 'reviewed');
    writeText(join(root, 'docs', 'a.md'), '# Rewritten later\n');
    const repeated = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: reviewedDigest,
    });
    assert.equal(repeated.ok, false);
    assert.equal(repeated.status, 'stale');
    assert.equal(repeated.journalPath, null);
    assert(
      repeated.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_file_changed,
      ),
    );
    const read = await service.read(registered.record.documentId);
    assert.equal(read.record?.digest, reviewedDigest);
    assert.equal(read.record?.lastReviewedAt, preview.plan.reviewedAt);
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'knowledge', 'apply.lock')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('refuses a repeated plan when the reviewed file is missing or a symlink', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    writeText(join(root, 'docs', 'target.md'), '# Target\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    writeText(join(root, 'docs', 'a.md'), '# Reviewed A\n');
    const reviewedDigest = sha256Digest(Buffer.from('# Reviewed A\n'));
    const preview = await service.previewReview({
      documentId: registered.record.documentId,
    });
    assert(preview.plan !== null);
    const applied = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: reviewedDigest,
    });
    assert.equal(applied.status, 'reviewed');

    unlinkSync(join(root, 'docs', 'a.md'));
    const missing = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: reviewedDigest,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 'failed');
    assert(
      missing.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_not_found,
      ),
    );

    writeText(join(root, 'docs', 'a.md'), '# Reviewed A\n');
    const restored = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: reviewedDigest,
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.status, 'unchanged');

    unlinkSync(join(root, 'docs', 'a.md'));
    symlinkSync(join(root, 'docs', 'target.md'), join(root, 'docs', 'a.md'));
    const linked = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: reviewedDigest,
    });
    assert.equal(linked.ok, false);
    assert.equal(linked.status, 'failed');
    assert(
      linked.diagnostics.some(
        (entry) => entry.code === diagnosticCodes.document_path_unsafe,
      ),
    );
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'knowledge', 'apply.lock')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('revalidates the pinned root identity before and after the lock', async () => {
  const root = makeWorkspace();
  const moved = `${root}-moved`;
  try {
    writeText(join(root, 'docs', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register(input('docs/a.md'));
    assert(registered.record !== null);
    writeText(join(root, 'docs', 'a.md'), '# Reviewed A\n');
    const reviewedDigest = sha256Digest(Buffer.from('# Reviewed A\n'));
    const preview = await service.previewReview({
      documentId: registered.record.documentId,
    });
    assert(preview.plan !== null);
    const pinned = await loadKnowledgeContext(root);
    assert.equal(pinned.ok, true);
    assert(pinned.context !== null);

    renameSync(root, moved);
    cpSync(moved, root, { recursive: true, preserveTimestamps: true });

    const replaced = await service.applyReview({
      plan: preview.plan,
      expectedFileDigest: reviewedDigest,
    });
    assert.equal(replaced.ok, false);
    assert.equal(replaced.status, 'stale');
    assert(
      replaced.diagnostics.some((entry) =>
        entry.message.includes(
          'Workspace root identity changed after the review plan',
        ),
      ),
    );

    const underLock = await applyReviewAt(pinned.context, {
      plan: preview.plan,
      expectedFileDigest: reviewedDigest,
    });
    assert.equal(underLock.ok, false);
    assert.equal(underLock.status, 'stale');
    assert(
      underLock.diagnostics.some((entry) =>
        entry.message.includes('while the review lock was held'),
      ),
    );
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'knowledge', 'apply.lock')),
      false,
    );
    const journals = join(root, '.pappra', 'local', 'knowledge', 'journals');
    assert.equal(existsSync(journals), false);
    const read = await service.read(registered.record.documentId);
    assert.equal(read.record?.digest, registered.record.digest);
    assert.equal(read.record?.lastReviewedAt, null);
  } finally {
    cleanup(root);
    cleanup(moved);
  }
});
