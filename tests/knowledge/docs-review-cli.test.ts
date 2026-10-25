import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { KnowledgeService } from '../../src/knowledge/index.js';
import { sha256Digest } from '../../src/infra/fs.js';
import { runDocsCommand } from '../../src/cli/commands/docs.js';
import { runDocsReviewCli } from '../../src/cli/commands/docs-review.js';
import type { CliOutput } from '../../src/cli/output.js';
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

const cli = fileURLToPath(new URL('../../src/cli/main.js', import.meta.url));

interface Captured {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function makeWorkspace(): string {
  const root = makeTempDir('knowledge-review-cli');
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
  return root;
}

async function invokeReview(
  args: readonly string[],
  cwd: string,
): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const output: CliOutput = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    const status = await runDocsReviewCli(args, output);
    return { status, stdout, stderr };
  } finally {
    process.chdir(previous);
  }
}

function parse(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  assert(typeof value === 'object' && value !== null);
  return value as Record<string, unknown>;
}

function reviewDigest(root: string, path: string): string {
  return sha256Digest(readFileSync(join(root, path)));
}

test('docs review plans through the real CLI without changing bytes or metadata', async () => {
  const root = makeWorkspace();
  const home = mkdtempSync(join(tmpdir(), 'pappra-review-home-'));
  try {
    writeText(join(root, 'knowledge', 'guide.md'), '# Guide\n');
    const service = new KnowledgeService(root);
    const registered = await service.register({
      location: { kind: 'workspace', path: 'knowledge/guide.md' },
      kind: 'architecture',
      maturity: 'draft',
      owner: 'human',
    });
    assert(registered.record !== null);
    writeText(join(root, 'knowledge', 'guide.md'), '# Guide reviewed\n');
    const before = snapshotTree(root);
    const result = spawnSync(
      process.execPath,
      [cli, 'docs', 'review', registered.record.documentId, '--json'],
      {
        cwd: root,
        encoding: 'utf8',
        shell: false,
        timeout: 30_000,
        env: { ...process.env, HOME: home },
      },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    const report = parse(result.stdout);
    assert.equal(report.schema, 'pappra/docs-review/1');
    assert.equal(report.ok, true);
    assert.equal(report.applied, false);
    assert.equal(report.status, 'ready');
    const plan = report.plan as Record<string, unknown>;
    assert.equal(
      plan.expectedFileDigest,
      reviewDigest(root, 'knowledge/guide.md'),
    );
    assert.equal(plan.recordDigest, registered.record.digest);
    assert.equal(plan.documentId, registered.record.documentId);
    assert.equal(plan.scope, 'private');
    const after = snapshotTree(root);
    assert.equal(
      after.get('knowledge/guide.md'),
      before.get('knowledge/guide.md'),
    );
    const read = await service.read(registered.record.documentId);
    assert.equal(read.record?.digest, registered.record.digest);
    assert.equal(read.record?.lastReviewedAt, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
    cleanup(root);
  }
});

test('docs review applies the pinned digest and keeps the same documentId', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'knowledge', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register({
      location: { kind: 'workspace', path: 'knowledge/a.md' },
      kind: 'architecture',
      maturity: 'draft',
      owner: 'human',
    });
    assert(registered.record !== null);
    writeText(join(root, 'knowledge', 'a.md'), '# A reviewed\n');
    const digest = reviewDigest(root, 'knowledge/a.md');
    const applied = await invokeReview(
      [
        registered.record.documentId,
        '--apply',
        '--expected-digest',
        digest,
        '--json',
      ],
      root,
    );
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.stderr, '');
    const report = parse(applied.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.status, 'reviewed');
    assert.equal(report.applied, true);
    const document = report.document as Record<string, unknown>;
    assert.equal(document.documentId, registered.record.documentId);
    assert.equal(document.digest, digest);
    assert.equal(document.kind, 'architecture');
    assert.equal(document.maturity, 'draft');
    assert.equal(document.owner, 'human');
    const checked = await service.check({ includePrivate: true });
    assert.equal(checked.entries[0]?.freshness, 'current');
  } finally {
    cleanup(root);
  }
});

test('docs review refuses to repeat a successful pinned plan after the file changes', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'knowledge', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register({
      location: { kind: 'workspace', path: 'knowledge/a.md' },
      kind: 'architecture',
      maturity: 'draft',
      owner: 'human',
    });
    assert(registered.record !== null);
    writeText(join(root, 'knowledge', 'a.md'), '# A reviewed\n');
    const digest = reviewDigest(root, 'knowledge/a.md');
    const args = [
      registered.record.documentId,
      '--apply',
      '--expected-digest',
      digest,
      '--json',
    ];
    const first = await invokeReview(args, root);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(parse(first.stdout).status, 'reviewed');

    writeText(join(root, 'knowledge', 'a.md'), '# A rewritten\n');
    const repeated = await invokeReview(args, root);
    assert.equal(repeated.status, 1);
    const report = parse(repeated.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.status, 'stale');
    assert.equal(report.applied, false);
    const read = await service.read(registered.record.documentId);
    assert.equal(read.record?.digest, digest);
  } finally {
    cleanup(root);
  }
});

test('docs review refuses a stale digest without mutating the catalog', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'knowledge', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register({
      location: { kind: 'workspace', path: 'knowledge/a.md' },
      kind: 'architecture',
      maturity: 'draft',
      owner: 'human',
    });
    assert(registered.record !== null);
    writeText(join(root, 'knowledge', 'a.md'), '# A reviewed\n');
    const before = snapshotTree(root);
    const wrong = sha256Digest(Buffer.from('# Never reviewed\n'));
    const refused = await invokeReview(
      [
        registered.record.documentId,
        '--apply',
        '--expected-digest',
        wrong,
        '--json',
      ],
      root,
    );
    assert.equal(refused.status, 1);
    const report = parse(refused.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.status, 'stale');
    assert.equal(report.applied, false);
    assert.deepEqual(snapshotTree(root), before);
    const read = await service.read(registered.record.documentId);
    assert.equal(read.record?.digest, registered.record.digest);
  } finally {
    cleanup(root);
  }
});

test('docs review requires an explicit reviewed digest to apply and a valid scope', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'knowledge', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register({
      location: { kind: 'workspace', path: 'knowledge/a.md' },
      kind: 'architecture',
      maturity: 'draft',
      owner: 'human',
    });
    assert(registered.record !== null);
    writeText(join(root, 'knowledge', 'a.md'), '# A reviewed\n');

    const noDigest = await invokeReview(
      [registered.record.documentId, '--apply'],
      root,
    );
    assert.equal(noDigest.status, 2);
    assert.match(noDigest.stderr, /requires --expected-digest/);

    const badDigest = await invokeReview(
      [registered.record.documentId, '--expected-digest', 'sha256:abc'],
      root,
    );
    assert.equal(badDigest.status, 2);
    assert.match(badDigest.stderr, /--expected-digest requires/);

    const badScope = await invokeReview(
      [registered.record.documentId, '--scope', 'project'],
      root,
    );
    assert.equal(badScope.status, 2);
    assert.match(badScope.stderr, /--scope accepts only private or shared/);

    const missingId = await invokeReview(['--json'], root);
    assert.equal(missingId.status, 2);
    assert.equal(parse(missingId.stdout).code, 'invalid_arguments');

    const unknown = await invokeReview(
      [registered.record.documentId, '--force'],
      root,
    );
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /does not accept --force/);

    const digest = reviewDigest(root, 'knowledge/a.md');
    const duplicateScope = await invokeReview(
      [registered.record.documentId, '--scope', 'private', '--scope', 'shared'],
      root,
    );
    assert.equal(duplicateScope.status, 2);
    assert.match(duplicateScope.stderr, /accepts --scope once/);

    const duplicateDigest = await invokeReview(
      [
        registered.record.documentId,
        '--expected-digest',
        digest,
        '--expected-digest',
        digest,
      ],
      root,
    );
    assert.equal(duplicateDigest.status, 2);
    assert.match(duplicateDigest.stderr, /accepts --expected-digest once/);

    const jsonAfterInvalid = await invokeReview(
      [registered.record.documentId, '--force', '--json'],
      root,
    );
    assert.equal(jsonAfterInvalid.status, 2);
    assert.equal(jsonAfterInvalid.stderr, '');
    assert.equal(parse(jsonAfterInvalid.stdout).code, 'invalid_arguments');

    const mismatchedScope = await invokeReview(
      [registered.record.documentId, '--scope', 'shared', '--json'],
      root,
    );
    assert.equal(mismatchedScope.status, 1);
    assert.equal(parse(mismatchedScope.stdout).status, 'conflict');
  } finally {
    cleanup(root);
  }
});

test('docs command routing keeps the review scope wording and rejects other scope actions', async () => {
  const root = makeWorkspace();
  try {
    writeText(join(root, 'knowledge', 'a.md'), '# A\n');
    const service = new KnowledgeService(root);
    const registered = await service.register({
      location: { kind: 'workspace', path: 'knowledge/a.md' },
      kind: 'architecture',
      maturity: 'draft',
      owner: 'human',
    });
    assert(registered.record !== null);
    writeText(join(root, 'knowledge', 'a.md'), '# A reviewed\n');

    let listError = '';
    const listStatus = await runDocsCommand(
      {
        cwd: root,
        action: 'list',
        argument: null,
        scope: 'private',
        json: false,
        includePrivate: false,
        includeArchived: false,
        apply: false,
      },
      { stdout: () => undefined, stderr: (text) => (listError += text) },
    );
    assert.equal(listStatus, 2);
    assert.match(
      listError,
      /Only docs forget and docs review accept --scope private\|shared\./,
    );

    let reviewError = '';
    const reviewStatus = await runDocsCommand(
      {
        cwd: root,
        action: 'review',
        argument: registered.record.documentId,
        scope: 'private',
        json: true,
        includePrivate: false,
        includeArchived: false,
        apply: false,
      },
      {
        stdout: (text) => {
          const report = parse(text);
          assert.equal(report.schema, 'pappra/docs-review/1');
          assert.equal(report.applied, false);
        },
        stderr: (text) => (reviewError += text),
      },
    );
    assert.equal(reviewStatus, 0, reviewError);
    assert.equal(reviewError, '');

    writeFileSync(join(root, 'knowledge', 'a.md'), '# A reviewed twice\n');
    let applyError = '';
    const applyStatus = await runDocsCommand(
      {
        cwd: root,
        action: 'review',
        argument: registered.record.documentId,
        scope: null,
        json: true,
        includePrivate: false,
        includeArchived: false,
        apply: true,
      },
      {
        stdout: (text) => {
          assert.equal(parse(text).code, 'invalid_arguments');
        },
        stderr: (text) => (applyError += text),
      },
    );
    assert.equal(applyStatus, 2);
    assert.equal(applyError, '');
  } finally {
    cleanup(root);
  }
});
