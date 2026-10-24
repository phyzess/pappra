import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  rmSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import {
  CodeIntelligenceService,
  codeIdentityDigest,
  codeGraphConfigDigest,
} from '../../src/code/index.js';
import { computeCodeIdentity } from '../../src/code/identity.js';
import { runTextQuery } from '../../src/code/text.js';
import { codeQueryRequestSchema } from '../../src/schemas/code.js';
import {
  acquireCodePrepareLock,
  releaseCodePrepareLock,
} from '../../src/code/registration.js';
import {
  addLinkedWorktree,
  baseWorkspaceConfig,
  baseMachineConfig,
  cleanup,
  createRepository,
  makeTempDir,
  runGit,
  removeLinkedWorktree,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

const codeGraphInstalled =
  spawnSync('codegraph', ['--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
  }).status === 0;

function makeWorkspace(
  repositories: readonly {
    id: string;
    path: string;
    access?: 'read' | 'write';
  }[],
): string {
  const root = makeTempDir('code-p08');
  writeWorkspaceConfig(
    root,
    baseWorkspaceConfig({
      repositories: repositories.map((entry) => ({
        ...entry,
        access: entry.access ?? 'write',
      })),
    }),
  );
  writeMachineConfig(root, baseMachineConfig(root));
  return root;
}

function makeSingleWorkspace(extra: Record<string, unknown> = {}): string {
  const root = makeWorkspace([{ id: 'app', path: '.' }]);
  createRepository(root);
  if (typeof extra['source'] === 'string') {
    writeText(join(root, 'src/lib.ts'), extra['source']);
  }
  return root;
}

const source = [
  'export function alpha(value: string): string {',
  '  return beta(value);',
  '}',
  'export function beta(value: string): string {',
  '  return value.toUpperCase();',
  '}',
].join('\n');

test('status is passive and text fallback does not create an index', async () => {
  const root = makeSingleWorkspace({ source });
  try {
    const service = new CodeIntelligenceService(root);
    const before = await service.status({ repositoryId: 'app' });
    assert.notEqual(before.identity, null);
    assert.equal(
      before.health.state,
      codeGraphInstalled ? 'missing' : 'unsupported',
    );
    assert.equal(before.registrationPresent, false);
    assert.equal(existsSync(join(root, '.codegraph')), false);

    const fallback = await service.query({
      root,
      repositoryId: 'app',
      kind: 'text',
      query: 'alpha',
    });
    assert.equal(fallback.result?.coverage, 'fallback');
    assert.equal(fallback.result?.provider, 'text');
    assert.equal(fallback.result?.items[0]?.path, 'src/lib.ts');
    assert.equal(existsSync(join(root, '.codegraph')), false);

    const planned = await service.prepare({
      root,
      repositoryId: 'app',
      apply: false,
      rebuild: false,
    });
    assert.equal(planned.status, 'planned');
    if (codeGraphInstalled) {
      assert.equal(planned.plan.action, 'init');
      assert.equal(planned.plan.mutates, true);
    } else {
      assert.equal(planned.plan.action, 'none');
      assert.equal(planned.plan.mutates, false);
      assert(planned.plan.reasons.includes('prepare_unsupported'));
    }
    assert.equal(existsSync(join(root, '.codegraph')), false);
  } finally {
    cleanup(root);
  }
});

test(
  'real selected preparation reaches ready and source changes stale it',
  { skip: codeGraphInstalled ? false : 'codegraph CLI is not installed' },
  async () => {
    const root = makeSingleWorkspace({ source });
    try {
      const service = new CodeIntelligenceService(root);
      const prepared = await service.prepare({
        root,
        repositoryId: 'app',
        apply: true,
        rebuild: false,
      });
      assert.equal(
        prepared.status,
        'ready',
        JSON.stringify(prepared.diagnostics),
      );
      assert.equal(prepared.health.state, 'ready');
      assert.equal(prepared.registrationPath !== null, true);
      assert.equal(existsSync(join(root, '.codegraph')), true);
      assert.equal(existsSync(join(root, '.pappra/local/code/app.json')), true);

      const ready = await service.status({ repositoryId: 'app' });
      assert.equal(ready.ok, true);
      assert.equal(ready.health.state, 'ready');
      const native = await service.query({
        root,
        repositoryId: 'app',
        kind: 'symbol',
        query: 'alpha',
      });
      assert.equal(native.result?.provider, 'codegraph');
      assert.equal(native.result?.coverage, 'complete');
      assert.equal(native.result?.items[0]?.path, 'src/lib.ts');
      for (const kind of ['references', 'impact', 'explore'] as const) {
        const result = await service.query({
          root,
          repositoryId: 'app',
          kind,
          query: 'alpha',
        });
        assert.notEqual(
          result.result,
          null,
          `${kind}: ${result.diagnostics[0]?.message ?? 'null result'}`,
        );
        assert.equal(result.result?.provider, 'codegraph');
      }

      writeText(
        join(root, 'src/lib.ts'),
        `${source}\nexport function gamma(): string { return 'gamma'; }\n`,
      );
      const stale = await service.status({ repositoryId: 'app' });
      assert.equal(stale.health.state, 'stale');
      assert(
        stale.health.reasons.includes('source_changes_pending') ||
          stale.health.reasons.includes('registration_identity_changed'),
      );
      const fallback = await service.query({
        root,
        repositoryId: 'app',
        kind: 'symbol',
        query: 'gamma',
      });
      assert.equal(fallback.result?.provider, 'structure');
      assert.equal(fallback.result?.coverage, 'fallback');

      const synced = await service.prepare({
        root,
        repositoryId: 'app',
        apply: true,
        rebuild: false,
      });
      assert.equal(synced.status, 'ready', JSON.stringify(synced.diagnostics));
      const current = await service.status({ repositoryId: 'app' });
      assert.equal(current.health.state, 'ready');
    } finally {
      cleanup(root);
    }
  },
);

test(
  'absent optional engine reports unsupported without inventing an index',
  { skip: codeGraphInstalled ? 'codegraph CLI is present' : false },
  async () => {
    const root = makeSingleWorkspace({ source });
    try {
      const service = new CodeIntelligenceService(root);
      const status = await service.status({ repositoryId: 'app' });
      assert.notEqual(status.identity, null);
      assert.equal(status.health.state, 'unsupported');
      assert.equal(existsSync(join(root, '.codegraph')), false);
      const fallback = await service.query({
        root,
        repositoryId: 'app',
        kind: 'text',
        query: 'alpha',
      });
      assert.equal(fallback.result?.provider, 'text');
      assert.equal(fallback.result?.coverage, 'fallback');
      assert.equal(fallback.result?.items[0]?.path, 'src/lib.ts');
      assert.equal(existsSync(join(root, '.codegraph')), false);
    } finally {
      cleanup(root);
    }
  },
);

test('working-tree identity includes untracked file content and kind', async () => {
  const root = makeSingleWorkspace({ source });
  try {
    const service = new CodeIntelligenceService(root);
    const first = await service.status({ repositoryId: 'app' });
    assert.notEqual(first.identity, null);
    const firstDigest = first.identity!.workingTree.digest;
    writeText(join(root, 'untracked.txt'), 'value one\n');
    const second = await service.status({ repositoryId: 'app' });
    assert.notEqual(second.identity?.workingTree.digest, firstDigest);
    assert.equal(second.identity?.workingTree.completeness, 'complete');

    unlinkSync(join(root, 'untracked.txt'));
    writeText(join(root, 'target.txt'), 'target\n');
    symlinkSync('target.txt', join(root, 'untracked.txt'));
    const third = await service.status({ repositoryId: 'app' });
    assert.notEqual(
      third.identity?.workingTree.digest,
      second.identity?.workingTree.digest,
    );
    assert.equal(third.identity?.workingTree.completeness, 'complete');
    assert.equal(existsSync(join(root, '.codegraph')), false);
  } finally {
    cleanup(root);
  }
});

test('two linked worktrees keep distinct identities and selected-only indexes', async () => {
  const root = makeWorkspace([
    { id: 'main', path: '.' },
    { id: 'one', path: 'linked-one' },
    { id: 'two', path: 'linked-two' },
  ]);
  const one = join(root, 'linked-one');
  const two = join(root, 'linked-two');
  let addedOne = false;
  let addedTwo = false;
  try {
    createRepository(root);
    addLinkedWorktree(root, one, 'p08-linked-one');
    addedOne = true;
    addLinkedWorktree(root, two, 'p08-linked-two');
    addedTwo = true;
    writeText(join(root, 'src/lib.ts'), source);
    writeText(join(one, 'src/lib.ts'), source);
    writeText(join(two, 'src/lib.ts'), source);
    writeText(join(root, 'tracked.txt'), 'staged-only\n');
    runGit(root, ['add', 'tracked.txt']);
    writeText(join(root, 'tracked.txt'), 'tracked\n');
    writeText(join(one, 'tracked.txt'), 'unstaged-linked\n');
    writeText(join(two, 'untracked-only.txt'), 'untracked\n');
    const service = new CodeIntelligenceService(root);
    const main = await service.status({ repositoryId: 'main' });
    const first = await service.status({ repositoryId: 'one' });
    const second = await service.status({ repositoryId: 'two' });
    assert.notEqual(main.identity, null);
    assert.notEqual(first.identity, null);
    assert.notEqual(second.identity, null);
    assert.equal(
      new Set([
        main.identity?.checkoutId,
        first.identity?.checkoutId,
        second.identity?.checkoutId,
      ]).size,
      3,
    );
    const passiveState = codeGraphInstalled ? 'missing' : 'unsupported';
    assert.equal(main.health.state, passiveState);
    assert.equal(first.health.state, passiveState);
    assert.equal(second.health.state, passiveState);
    assert.equal(existsSync(join(root, '.codegraph')), false);
    assert.equal(existsSync(join(one, '.codegraph')), false);
    assert.equal(existsSync(join(two, '.codegraph')), false);

    if (codeGraphInstalled) {
      const prepared = await service.prepare({
        root,
        repositoryId: 'main',
        apply: true,
        rebuild: false,
      });
      assert.equal(
        prepared.status,
        'ready',
        JSON.stringify(prepared.diagnostics),
      );
      assert.equal(existsSync(join(root, '.codegraph')), true);
      assert.equal(existsSync(join(one, '.codegraph')), false);
      assert.equal(existsSync(join(two, '.codegraph')), false);
    }
  } finally {
    if (addedTwo) removeLinkedWorktree(root, two);
    if (addedOne) removeLinkedWorktree(root, one);
    cleanup(root);
  }
});

test('same basename at different paths does not share checkout identity', async () => {
  const root = makeTempDir('code-p08-paths');
  try {
    const left = join(root, 'left/app');
    const right = join(root, 'right/app');
    createRepository(left);
    createRepository(right);
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [
          { id: 'left-app', path: 'left/app', access: 'write' },
          { id: 'right-app', path: 'right/app', access: 'write' },
        ],
      }),
    );
    writeMachineConfig(root, baseMachineConfig(root));
    const service = new CodeIntelligenceService(root);
    const leftStatus = await service.status({ repositoryId: 'left-app' });
    const rightStatus = await service.status({ repositoryId: 'right-app' });
    assert.notEqual(leftStatus.identity?.root, rightStatus.identity?.root);
    assert.notEqual(
      leftStatus.identity?.checkoutId,
      rightStatus.identity?.checkoutId,
    );
    assert.notEqual(
      codeIdentityDigest(leftStatus.identity!),
      codeIdentityDigest(rightStatus.identity!),
    );
    assert.equal(existsSync(join(left, '.codegraph')), false);
    assert.equal(existsSync(join(right, '.codegraph')), false);
  } finally {
    cleanup(root);
  }
});

test('unselected repositories are never prepared by a selected operation', async () => {
  const root = makeWorkspace([
    { id: 'app', path: '.' },
    { id: 'other', path: 'other', access: 'read' },
  ]);
  try {
    createRepository(root);
    createRepository(join(root, 'other'));
    writeText(join(root, 'src/lib.ts'), source);
    writeText(
      join(root, 'other/src/lib.ts'),
      `${source}\nexport const otherOnlyMarker = 'other-only';\n`,
    );
    runGit(root, ['add', '.pappra/workspace.json']);
    const service = new CodeIntelligenceService(root);
    const isolated = await service.query({
      root,
      repositoryId: 'app',
      kind: 'text',
      query: 'otherOnlyMarker',
    });
    assert.equal(isolated.result?.items.length, 0);
    if (codeGraphInstalled) {
      const prepared = await service.prepare({
        root,
        repositoryId: 'app',
        apply: true,
        rebuild: false,
      });
      assert.equal(
        prepared.status,
        'ready',
        JSON.stringify(prepared.diagnostics),
      );
      assert.equal(existsSync(join(root, '.codegraph')), true);
    }
    assert.equal(existsSync(join(root, 'other/.codegraph')), false);
  } finally {
    cleanup(root);
  }
});

test('binary untracked input remains bounded and identity-stable', async () => {
  const root = makeSingleWorkspace();
  try {
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
    const service = new CodeIntelligenceService(root);
    const first = await service.status({ repositoryId: 'app' });
    const digest = first.identity?.workingTree.digest;
    assert.notEqual(digest, undefined);
    const second = await service.status({ repositoryId: 'app' });
    assert.equal(second.identity?.workingTree.digest, digest);
    assert.equal(existsSync(join(root, '.codegraph')), false);
  } finally {
    cleanup(root);
  }
});

test('staged changes cannot disappear when the working file matches HEAD', async () => {
  const root = makeSingleWorkspace({ source });
  try {
    const configDigest = `sha256:${'a'.repeat(64)}`;
    const input = {
      repositoryId: 'app',
      root,
      engineVersion: '1.4.1',
      configDigest,
    };
    const before = await computeCodeIdentity(input);
    assert.equal(before.ok, true);
    writeText(join(root, 'tracked.txt'), 'staged-only-change\n');
    runGit(root, ['add', 'tracked.txt']);
    writeText(join(root, 'tracked.txt'), 'tracked\n');
    const after = await computeCodeIdentity(input);
    assert.equal(after.ok, true);
    if (!before.ok || !after.ok) return;
    assert.equal(
      runGit(root, ['status', '--porcelain', '--', 'tracked.txt']).trim(),
      'MM tracked.txt',
    );
    assert.notEqual(
      before.value.workingTree.digest,
      after.value.workingTree.digest,
    );
    assert.equal(after.value.workingTree.completeness, 'complete');
  } finally {
    cleanup(root);
  }
});

test('tracked content below an excluded root and cancellation are bounded', async () => {
  const root = makeSingleWorkspace();
  try {
    const nested = join(root, 'nested');
    mkdirSync(nested, { recursive: true });
    writeText(join(nested, 'hidden.ts'), 'hidden one\n');
    runGit(root, ['add', 'nested/hidden.ts']);
    runGit(root, [
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'user.name=Fixture',
      'commit',
      '-qm',
      'nested',
    ]);
    const input = {
      repositoryId: 'app',
      root,
      engineVersion: '1.4.1',
      configDigest: `sha256:${'a'.repeat(64)}`,
      excludedRoots: [nested],
    };
    const before = await computeCodeIdentity(input);
    assert.equal(before.ok, true);
    writeText(join(nested, 'hidden.ts'), 'hidden two\n');
    runGit(root, ['add', 'nested/hidden.ts']);
    const after = await computeCodeIdentity(input);
    assert.equal(after.ok, true);
    if (!before.ok || !after.ok) return;
    assert.equal(
      before.value.workingTree.digest,
      after.value.workingTree.digest,
    );

    const controller = new AbortController();
    controller.abort();
    const cancelled = await computeCodeIdentity({
      ...input,
      signal: controller.signal,
    });
    assert.equal(cancelled.ok, false);
  } finally {
    cleanup(root);
  }
});

test('text fallback rejects an intermediate symlink outside the checkout', async () => {
  const root = makeSingleWorkspace({ source });
  const outside = makeTempDir('code-outside');
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeText(join(root, 'src/secret.ts'), 'ordinary source\n');
    runGit(root, ['add', 'src/secret.ts']);
    runGit(root, [
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'user.name=Fixture',
      'commit',
      '-qm',
      'source',
    ]);
    writeText(join(outside, 'secret.ts'), 'P08_ANOTHER_SENTINEL\n');
    rmSync(join(root, 'src'), { recursive: true, force: true });
    symlinkSync(outside, join(root, 'src'));
    const service = new CodeIntelligenceService(root);
    const observed = await service.status({ repositoryId: 'app' });
    assert.notEqual(observed.identity, null);
    const request = codeQueryRequestSchema.parse({
      schema: 'pappra/code-query/1',
      kind: 'text',
      query: 'P08_ANOTHER_SENTINEL',
      identity: observed.identity,
      limits: { maxResults: 10, maxBytes: 4096, maxFiles: 10 },
    });
    const result = await runTextQuery(request, 'text');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.items.length, 0);
      assert.equal(
        result.value.evidence.some((entry) => entry.ref.includes('outside')),
        false,
      );
    }
  } finally {
    cleanup(outside);
    cleanup(root);
  }
});

test('text fallback finds later matches after scanning beyond the output budget', async () => {
  const root = makeSingleWorkspace();
  try {
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(root, `a-${index}.ts`), 'x'.repeat(200_000));
    }
    writeFileSync(join(root, 'z.ts'), 'export const removeRuntime = 1;\n');
    const service = new CodeIntelligenceService(root);
    const observed = await service.status({ repositoryId: 'app' });
    assert.notEqual(observed.identity, null);
    for (const mode of ['text', 'structure'] as const) {
      const request = codeQueryRequestSchema.parse({
        schema: 'pappra/code-query/1',
        kind: mode === 'text' ? 'text' : 'symbol',
        query: 'removeRuntime',
        identity: observed.identity,
        limits: { maxResults: 10, maxBytes: 1024, maxFiles: 100 },
      });
      const result = await runTextQuery(request, mode);
      assert(result.ok);
      assert.equal(result.value.items[0]?.path, 'z.ts');
      assert(result.value.bytes <= 1024);
      assert.equal(result.value.truncated, false);
    }
  } finally {
    cleanup(root);
  }
});

test('text fallback bounds emitted item JSON, not only scanned bytes', async () => {
  const root = makeSingleWorkspace();
  try {
    writeFileSync(join(root, 'a.ts'), 'needle '.repeat(60));
    const service = new CodeIntelligenceService(root);
    const observed = await service.status({ repositoryId: 'app' });
    assert.notEqual(observed.identity, null);
    const request = codeQueryRequestSchema.parse({
      schema: 'pappra/code-query/1',
      kind: 'text',
      query: 'needle',
      identity: observed.identity,
      limits: { maxResults: 100, maxBytes: 1024, maxFiles: 100 },
    });
    const result = await runTextQuery(request, 'text');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.truncated, true);
    assert.equal(result.value.coverage, 'partial');
    assert(result.value.bytes <= 1024);
    assert(
      Buffer.byteLength(JSON.stringify(result.value.items), 'utf8') <= 1026,
    );
    assert(result.value.reasons.includes('output_budget'));
  } finally {
    cleanup(root);
  }
});

test('read-only repositories refuse prepare before engine mutation', async () => {
  const root = makeWorkspace([{ id: 'app', path: '.', access: 'read' }]);
  try {
    createRepository(root);
    writeText(join(root, 'src/lib.ts'), source);
    const prepared = await new CodeIntelligenceService(root).prepare({
      root,
      repositoryId: 'app',
      apply: true,
      rebuild: false,
    });
    assert.equal(prepared.status, 'conflict');
    assert.equal(prepared.plan.mutates, false);
    assert.equal(existsSync(join(root, '.codegraph')), false);
    assert.equal(existsSync(join(root, '.pappra/local/code/app.json')), false);
  } finally {
    cleanup(root);
  }
});

test('prepare refuses a symlinked engine directory outside the checkout', async () => {
  const root = makeSingleWorkspace({ source });
  const outside = makeTempDir('code-index-outside');
  try {
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, '.codegraph'));
    const prepared = await new CodeIntelligenceService(root).prepare({
      root,
      repositoryId: 'app',
      apply: true,
      rebuild: false,
    });
    assert.equal(prepared.status, 'conflict');
    assert.equal(existsSync(join(outside, 'marker')), false);
    assert.equal(existsSync(join(root, '.pappra/local/code/app.json')), false);
  } finally {
    cleanup(outside);
    cleanup(root);
  }
});

test('unknown engine configuration is distinct from missing default', async () => {
  const root = makeSingleWorkspace();
  try {
    const missing = await codeGraphConfigDigest(root);
    mkdirSync(join(root, '.codegraph'), { recursive: true });
    writeFileSync(
      join(root, '.codegraph/config.json'),
      `{${' '.repeat(70_000)}`,
    );
    const oversized = await codeGraphConfigDigest(root);
    assert.notEqual(oversized, missing);
  } finally {
    cleanup(root);
  }
});

test('canonical source guard rejects in-root excluded repository redirection', async () => {
  const root = makeSingleWorkspace();
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeText(join(root, 'src/a.ts'), 'ordinary\n');
    runGit(root, ['add', 'src/a.ts']);
    runGit(root, [
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'user.name=Fixture',
      'commit',
      '-qm',
      'source',
    ]);
    const other = join(root, 'other');
    mkdirSync(other, { recursive: true });
    writeText(join(other, 'a.ts'), 'P08_IN_ROOT_EXCLUDED\n');
    rmSync(join(root, 'src'), { recursive: true, force: true });
    symlinkSync(other, join(root, 'src'));
    const identity = await computeCodeIdentity({
      repositoryId: 'app',
      root,
      engineVersion: '1.4.1',
      configDigest: `sha256:${'a'.repeat(64)}`,
      excludedRoots: [other],
    });
    assert.equal(identity.ok, true);
    if (!identity.ok) return;
    const request = codeQueryRequestSchema.parse({
      schema: 'pappra/code-query/1',
      kind: 'text',
      query: 'P08_IN_ROOT_EXCLUDED',
      identity: identity.value,
      excludedRoots: [other],
      limits: { maxResults: 10, maxBytes: 4096, maxFiles: 10 },
    });
    const result = await runTextQuery(request, 'text');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.items.length, 0);
      assert.equal(result.value.evidence.length, 0);
    }
  } finally {
    cleanup(root);
  }
});

test('prepare lock release preserves replacement and redirected user files', async () => {
  const root = makeSingleWorkspace();
  const outside = makeTempDir('code-lock-outside');
  try {
    const lock = await acquireCodePrepareLock(root);
    assert.equal(lock.ok, true);
    if (!lock.ok) return;
    rmSync(lock.value);
    writeFileSync(lock.value, 'USER_REPLACEMENT_LOCK\n');
    const replaced = await releaseCodePrepareLock(lock.value);
    assert.equal(replaced.ok, false);
    assert.equal(readFileSync(lock.value, 'utf8'), 'USER_REPLACEMENT_LOCK\n');

    const redirectedRoot = makeSingleWorkspace();
    try {
      const acquired = await acquireCodePrepareLock(redirectedRoot);
      assert.equal(acquired.ok, true);
      if (!acquired.ok) return;
      const parent = join(redirectedRoot, '.pappra', 'local', 'code');
      renameSync(parent, `${parent}-old`);
      writeFileSync(join(outside, 'prepare.lock'), 'OUTSIDE_USER_LOCK\n');
      symlinkSync(outside, parent);
      const released = await releaseCodePrepareLock(acquired.value);
      assert.equal(released.ok, false);
      assert.equal(
        readFileSync(join(outside, 'prepare.lock'), 'utf8'),
        'OUTSIDE_USER_LOCK\n',
      );
    } finally {
      cleanup(redirectedRoot);
    }
  } finally {
    cleanup(outside);
    cleanup(root);
  }
});

test('redirected private registration is not trusted as ready', async () => {
  if (!codeGraphInstalled) return;
  const root = makeSingleWorkspace({ source });
  try {
    const service = new CodeIntelligenceService(root);
    const prepared = await service.prepare({
      root,
      repositoryId: 'app',
      apply: true,
      rebuild: false,
    });
    assert.equal(prepared.status, 'ready');
    const code = join(root, '.pappra', 'local', 'code');
    const shared = join(root, '.pappra', 'generated', 'shared-code');
    mkdirSync(join(root, '.pappra', 'generated'), { recursive: true });
    renameSync(code, shared);
    symlinkSync(shared, code);
    const status = await service.status({ repositoryId: 'app' });
    assert.notEqual(status.health.state, 'ready');
    assert.equal(status.registrationPresent, false);
  } finally {
    cleanup(root);
  }
});

test(
  'multi-repository preparation registers in the workspace, not inside the checkout',
  { skip: codeGraphInstalled ? false : 'codegraph CLI is not installed' },
  async () => {
    const root = makeWorkspace([
      { id: 'app', path: 'app' },
      { id: 'other', path: 'other' },
    ]);
    try {
      for (const path of ['app', 'other']) {
        const directory = join(root, path);
        mkdirSync(directory);
        createRepository(directory);
        writeText(join(directory, 'src/lib.ts'), source);
      }
      const service = new CodeIntelligenceService(root);
      const prepared = await service.prepare({
        root,
        repositoryId: 'app',
        apply: true,
        rebuild: false,
      });
      assert.equal(
        prepared.status,
        'ready',
        JSON.stringify(prepared.diagnostics),
      );
      assert.equal(existsSync(join(root, '.pappra/local/code/app.json')), true);
      assert.equal(existsSync(join(root, 'app/.pappra')), false);
      const ready = await service.status({ repositoryId: 'app' });
      assert.equal(ready.ok, true);
      assert.equal(ready.health.state, 'ready');
    } finally {
      cleanup(root);
    }
  },
);
