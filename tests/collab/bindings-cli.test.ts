import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { transact } from '../../src/collab/store.js';
import { makeHandoffFixture } from './handoff-fixtures.js';
import { snapshotTree } from './task-resources-fixtures.js';
import {
  baseWorkspaceConfig,
  cleanup,
  makeTempDir,
  workspaceId as fixtureWorkspaceId,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

const ROOT = join(
  dirname(fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json'))),
);
const CLI = join(ROOT, 'dist/cli/main.js');
const INDEX_SCHEMA = 'pappra/collaboration-bindings/1';
const MAX_INDEX_BYTES = 1024 * 1024;

function run(args: readonly string[], cwd: string, timeout = 30_000) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function json(result: ReturnType<typeof run>): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function makeWorkspace(label: string): string {
  const root = realpathSync(makeTempDir(label));
  writeWorkspaceConfig(root, baseWorkspaceConfig());
  return root;
}

function bindingArgs(
  action: string,
  root: string,
  extra: readonly string[] = [],
): string[] {
  return ['collab', 'binding', action, '--root', root, ...extra, '--json'];
}

function indexFile(root: string): string {
  return join(root, '.pappra', 'local', 'collab-bindings.json');
}

function readIndex(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(indexFile(root), 'utf8')) as Record<
    string,
    unknown
  >;
}

function writeNearLimitIndex(workspace: string): {
  readonly file: string;
  readonly contents: Buffer;
  readonly bytes: number;
  readonly existingAlias: string;
} {
  const unbound: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const table = {
    schema: INDEX_SCHEMA,
    workspace_id: fixtureWorkspaceId,
    bindings: Object.create(null) as Record<string, unknown>,
    unbound,
  };
  let next = 0;
  const aliasAt = (index: number) => `old-${String(index).padStart(5, '0')}`;
  const encode = () => `${JSON.stringify(table, null, 2)}\n`;
  const add = () => {
    const alias = aliasAt(next++);
    unbound[alias] = {
      alias,
      at: '2026-10-21T00:00:00.000Z',
      previous: null,
    };
  };
  let bytes = Buffer.byteLength(encode());
  while (bytes < MAX_INDEX_BYTES - 16_384) {
    for (let index = 0; index < 128; index += 1) add();
    bytes = Buffer.byteLength(encode());
  }
  while (bytes < MAX_INDEX_BYTES - 16) {
    add();
    bytes = Buffer.byteLength(encode());
  }
  while (bytes > MAX_INDEX_BYTES) {
    delete unbound[aliasAt(--next)];
    bytes = Buffer.byteLength(encode());
  }
  if (bytes <= MAX_INDEX_BYTES - 512)
    throw new Error(`The boundary fixture is too small: ${bytes} bytes.`);
  const file = indexFile(workspace);
  mkdirSync(dirname(file), { recursive: true });
  const contents = Buffer.from(encode(), 'utf8');
  writeFileSync(file, contents);
  return {
    file,
    contents,
    bytes: contents.byteLength,
    existingAlias: aliasAt(0),
  };
}

function writeRoots(file: string, roots: readonly string[]): void {
  writeFileSync(file, `${JSON.stringify(roots, null, 2)}\n`);
}

function targetRecord(fixture: ReturnType<typeof makeHandoffFixture>): string {
  return join(fixture.task, 'task.json');
}

function bind(
  workspace: string,
  alias: string,
  record: string,
  apply = true,
  cwd = workspace,
) {
  return run(
    bindingArgs('bind', workspace, [
      '--task-id',
      alias,
      '--record',
      record,
      ...(apply ? ['--apply'] : []),
    ]),
    cwd,
  );
}

function resolveAlias(
  workspace: string,
  alias: string,
  extra: readonly string[] = [],
  cwd = workspace,
) {
  return run(
    bindingArgs('resolve', workspace, ['--task-id', alias, ...extra]),
    cwd,
  );
}

test('binding plans are read-only and bind/resolve preserves revision usability', () => {
  const workspace = makeWorkspace('c7-basic');
  const target = makeHandoffFixture('c7-basic-target');
  try {
    const alias = 'alias-basic';
    const unrelated = join(workspace, 'elsewhere');
    mkdirSync(unrelated, { recursive: true });
    const before = snapshotTree(workspace);
    const list = run(bindingArgs('list', workspace), unrelated);
    assert.equal(list.status, 0, list.stderr);
    assert.equal((json(list).counts as Record<string, unknown>).bindings, 0);
    const none = resolveAlias(workspace, alias, [], unrelated);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(json(none).status, 'none');
    assert.deepEqual(snapshotTree(workspace), before);

    const plan = bind(workspace, alias, targetRecord(target), false, unrelated);
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(json(plan).status, 'planned');
    assert.equal(json(plan).applied, false);
    assert.deepEqual(snapshotTree(workspace), before);

    const bound = bind(workspace, alias, targetRecord(target), true, unrelated);
    assert.equal(bound.status, 0, bound.stderr);
    assert.equal(json(bound).status, 'bound');
    assert.equal(json(bound).applied, true);
    const first = resolveAlias(workspace, alias, [], unrelated);
    assert.equal(first.status, 0, first.stderr);
    const firstBody = json(first);
    assert.equal(firstBody.status, 'binding');
    assert.equal(firstBody.usable, true);
    assert.equal(firstBody.scope, 'persisted-history');
    assert.equal(firstBody.liveStatus, 'unknown');
    const firstRevision = (firstBody.target as Record<string, unknown>)
      .state_revision;
    assert.ok(typeof firstRevision === 'number');
    assert.ok(!JSON.stringify(firstBody).includes('"messages"'));
    assert.ok(!JSON.stringify(firstBody).includes('"claims"'));

    const changed = transact(target.task, {
      actor: 'fixture',
      purpose: 'normal-revision',
      apply: (record) => {
        record.uncertainty = record.uncertainty ?? [];
        record.uncertainty.push({
          uncertainty_id: `unc-${Date.now()}`,
          kind: 'late_result',
          subtask_id: null,
          attempt: null,
          detail: null,
          evidence_ref: null,
          resolution_hint: null,
          opened_at: new Date().toISOString(),
          resolved_at: null,
          resolution: null,
          resolution_evidence: null,
          auto_restart: false,
        });
        return { record, op: 'revision', summary: {} };
      },
    });
    assert.equal(changed.ok, true);
    const afterRevision = resolveAlias(workspace, alias, [], unrelated);
    assert.equal(afterRevision.status, 0, afterRevision.stderr);
    assert.equal(json(afterRevision).status, 'binding');
    assert.ok(
      Number(
        (json(afterRevision).target as Record<string, unknown>).state_revision,
      ) > Number(firstRevision),
    );
    const secondAlias = 'alias-basic-second';
    const rebindAlias = bind(
      workspace,
      secondAlias,
      targetRecord(target),
      true,
      unrelated,
    );
    assert.equal(rebindAlias.status, 0, rebindAlias.stderr);
    assert.equal(json(rebindAlias).status, 'bound');
    const second = resolveAlias(workspace, secondAlias, [], unrelated);
    assert.equal(second.status, 0, second.stderr);
    const secondBody = json(second);
    assert.equal(secondBody.usable, true);
    assert.equal(
      (secondBody.pointer as Record<string, unknown>).record_realpath,
      (firstBody.pointer as Record<string, unknown>).record_realpath,
    );
    assert.equal(
      (secondBody.pointer as Record<string, unknown>).record_created_at,
      (firstBody.pointer as Record<string, unknown>).record_created_at,
    );

    const beforeUnbindPlan = snapshotTree(workspace);
    const unbindPlan = run(
      bindingArgs('unbind', workspace, ['--task-id', alias]),
      unrelated,
    );
    assert.equal(unbindPlan.status, 0, unbindPlan.stderr);
    assert.equal(json(unbindPlan).status, 'planned');
    assert.deepEqual(snapshotTree(workspace), beforeUnbindPlan);
    const unbound = run(
      bindingArgs('unbind', workspace, ['--task-id', alias, '--apply']),
      unrelated,
    );
    assert.equal(unbound.status, 0, unbound.stderr);
    assert.equal(json(unbound).status, 'unbound');
    const afterUnbind = resolveAlias(workspace, alias, [], unrelated);
    assert.equal(afterUnbind.status, 0, afterUnbind.stderr);
    assert.equal(json(afterUnbind).status, 'unbound');
    assert.equal(json(afterUnbind).usable, false);
    const rebound = bind(workspace, alias, targetRecord(target));
    assert.equal(rebound.status, 0, rebound.stderr);
    assert.equal(json(rebound).status, 'bound');
    assert.equal(
      Object.hasOwn(
        readIndex(workspace).unbound as Record<string, unknown>,
        alias,
      ),
      false,
    );
    assert.equal(readIndex(workspace).workspace_id, fixtureWorkspaceId);
  } finally {
    target.domain.cleanup();
    cleanup(workspace);
  }
});

test('binding detects reinitialized and missing targets without fallback', () => {
  const workspace = makeWorkspace('c7-identity');
  const target = makeHandoffFixture('c7-identity-target');
  try {
    const alias = 'alias-identity';
    assert.equal(bind(workspace, alias, targetRecord(target)).status, 0);
    const record = JSON.parse(
      readFileSync(targetRecord(target), 'utf8'),
    ) as Record<string, unknown>;
    record.created_at = new Date(Date.now() + 1000).toISOString();
    writeFileSync(targetRecord(target), `${JSON.stringify(record, null, 2)}\n`);
    const changed = resolveAlias(workspace, alias);
    assert.equal(changed.status, 1, changed.stderr);
    assert.equal(json(changed).status, 'binding-identity-changed');
    assert.equal(json(changed).target, null);
    const conflict = bind(workspace, alias, targetRecord(target), true);
    assert.equal(conflict.status, 1, conflict.stderr);
    assert.equal(json(conflict).code, 'binding_conflict');
    const unbind = run(
      bindingArgs('unbind', workspace, ['--task-id', alias, '--apply']),
      workspace,
    );
    assert.equal(unbind.status, 0, unbind.stderr);
    assert.equal(json(unbind).status, 'unbound');

    const missingAlias = 'alias-missing';
    assert.equal(bind(workspace, missingAlias, targetRecord(target)).status, 0);
    unlinkSync(targetRecord(target));
    const missing = resolveAlias(workspace, missingAlias);
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(json(missing).status, 'binding-missing');
    assert.equal(json(missing).target, null);
    const unbindMissing = run(
      bindingArgs('unbind', workspace, ['--task-id', missingAlias, '--apply']),
      workspace,
    );
    assert.equal(unbindMissing.status, 0, unbindMissing.stderr);
    assert.equal(json(unbindMissing).status, 'unbound');
  } finally {
    target.domain.cleanup();
    cleanup(workspace);
  }
});

test('corrupt or unsafe indexes are preserved and mutations refuse', () => {
  const workspace = makeWorkspace('c7-corrupt');
  const target = makeHandoffFixture('c7-corrupt-target');
  try {
    const alias = 'alias-corrupt';
    assert.equal(bind(workspace, alias, targetRecord(target)).status, 0);
    const file = indexFile(workspace);
    const corrupt = Buffer.from('{"bad":');
    writeFileSync(file, corrupt);
    const before = readFileSync(file);
    for (const args of [
      bindingArgs('list', workspace),
      bindingArgs('resolve', workspace, ['--task-id', alias]),
      bindingArgs('bind', workspace, [
        '--task-id',
        alias,
        '--record',
        targetRecord(target),
        '--apply',
      ]),
      bindingArgs('unbind', workspace, ['--task-id', alias, '--apply']),
    ]) {
      const result = run(args, workspace);
      assert.equal(result.status, 2, result.stderr);
      assert.deepEqual(readFileSync(file), before);
    }

    const other = makeWorkspace('c7-corrupt-link');
    try {
      const local = join(other, '.pappra', 'local');
      mkdirSync(local, { recursive: true });
      const outside = join(other, 'outside.json');
      writeFileSync(
        outside,
        JSON.stringify({
          schema: INDEX_SCHEMA,
          workspace_id: fixtureWorkspaceId,
          bindings: {},
          unbound: {},
        }),
      );
      symlinkSync(outside, indexFile(other));
      const list = run(bindingArgs('list', other), other);
      assert.equal(list.status, 2, list.stderr);
      assert.equal(existsSync(outside), true);
    } finally {
      cleanup(other);
    }
  } finally {
    target.domain.cleanup();
    cleanup(workspace);
  }
});

test('explicit roots resolve uniquely, ambiguously and incompletely', () => {
  const workspace = makeWorkspace('c7-discovery');
  const first = makeHandoffFixture('c7-discovery-a');
  const second = makeHandoffFixture('c7-discovery-b');
  try {
    const rootsFile = join(workspace, 'roots.json');
    writeRoots(rootsFile, [first.domain.domainRoot]);
    const unique = resolveAlias(workspace, 'sample', ['--roots', rootsFile]);
    assert.equal(unique.status, 0, unique.stderr);
    assert.equal(json(unique).status, 'discovery-unique');
    assert.equal(json(unique).usable, true);
    assert.equal(json(unique).source, 'discovery');
    assert.equal(existsSync(indexFile(workspace)), false);

    writeRoots(rootsFile, [first.domain.domainRoot, second.domain.domainRoot]);
    const ambiguous = resolveAlias(workspace, 'sample', ['--roots', rootsFile]);
    assert.equal(ambiguous.status, 1, ambiguous.stderr);
    assert.equal(json(ambiguous).status, 'discovery-ambiguous');
    assert.equal(json(ambiguous).target, null);

    writeRoots(rootsFile, [
      first.domain.domainRoot,
      join(workspace, 'missing-root'),
    ]);
    const incomplete = resolveAlias(workspace, 'sample', [
      '--roots',
      rootsFile,
    ]);
    assert.equal(incomplete.status, 1, incomplete.stderr);
    assert.equal(json(incomplete).status, 'discovery-incomplete');
    assert.equal(json(incomplete).target, null);

    writeRoots(rootsFile, [first.domain.domainRoot, first.domain.domainRoot]);
    const deduped = resolveAlias(workspace, 'sample', ['--roots', rootsFile]);
    assert.equal(deduped.status, 0, deduped.stderr);
    assert.equal(json(deduped).status, 'discovery-unique');

    assert.equal(bind(workspace, 'sample', targetRecord(first)).status, 0);
    writeRoots(rootsFile, [first.domain.domainRoot, second.domain.domainRoot]);
    const explicit = resolveAlias(workspace, 'sample', ['--roots', rootsFile]);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(json(explicit).status, 'binding');

    const invalidRoots = join(workspace, 'bad-roots.json');
    writeFileSync(invalidRoots, '{"bad":true}\n');
    const invalidBound = resolveAlias(workspace, 'sample', [
      '--roots',
      invalidRoots,
    ]);
    assert.equal(invalidBound.status, 2, invalidBound.stderr);
    assert.equal(json(invalidBound).code, 'roots_invalid');
    const invalidUnbound = resolveAlias(workspace, 'unbound-sample', [
      '--roots',
      invalidRoots,
    ]);
    assert.equal(invalidUnbound.status, 2, invalidUnbound.stderr);
  } finally {
    first.domain.cleanup();
    second.domain.cleanup();
    cleanup(workspace);
  }
});

test('binding rejects unsafe workspace/private/index paths and invalid options', () => {
  const workspace = makeWorkspace('c7-strict');
  const target = makeHandoffFixture('c7-strict-target');
  try {
    const alias = 'alias-strict';
    const relative = run(
      [
        'collab',
        'binding',
        'bind',
        '--task-id',
        alias,
        '--record',
        'task.json',
      ],
      workspace,
    );
    assert.equal(relative.status, 2);
    const unsafe = run(
      bindingArgs('bind', workspace, [
        '--task-id',
        '../escape',
        '--record',
        targetRecord(target),
      ]),
      workspace,
    );
    assert.equal(unsafe.status, 2);
    const relativeRoot = run(
      ['collab', 'binding', 'list', '--root', 'relative', '--json'],
      workspace,
    );
    assert.equal(relativeRoot.status, 2);

    const elsewhere = realpathSync(makeTempDir('c7-elsewhere'));
    try {
      const explicitRoot = run(bindingArgs('list', workspace), elsewhere);
      assert.equal(explicitRoot.status, 0, explicitRoot.stderr);
      assert.equal(
        (json(explicitRoot).counts as Record<string, unknown>).bindings,
        0,
      );
      const implicitRoot = run(
        ['collab', 'binding', 'list', '--json'],
        elsewhere,
      );
      assert.equal(implicitRoot.status, 2);
      assert.equal(json(implicitRoot).code, 'workspace_unavailable');
    } finally {
      cleanup(elsewhere);
    }
    const local = join(workspace, '.pappra', 'local');
    mkdirSync(local, { recursive: true });
    const outside = join(workspace, 'outside-index.json');
    writeFileSync(outside, '{"x":1}\n');
    symlinkSync(outside, indexFile(workspace));
    const symlinkIndex = bind(workspace, alias, targetRecord(target));
    assert.equal(symlinkIndex.status, 2);
    assert.equal(readFileSync(outside, 'utf8'), '{"x":1}\n');

    const large = join(local, 'large-index.json');
    writeFileSync(large, '');
    truncateSync(large, 1024 * 1024 + 1);
    const largeLink = join(local, 'large-link.json');
    symlinkSync(large, largeLink);
    // The real index remains a symlink; list must not follow either.
    const list = run(bindingArgs('list', workspace), workspace);
    assert.equal(list.status, 2);

    const incomplete = realpathSync(makeTempDir('c7-incomplete'));
    try {
      mkdirSync(join(incomplete, '.pappra'), { recursive: true });
      const incompleteList = run(bindingArgs('list', incomplete), incomplete);
      assert.equal(incompleteList.status, 2);
    } finally {
      cleanup(incomplete);
    }
  } finally {
    target.domain.cleanup();
    cleanup(workspace);
  }
});

test('binding handles own-property aliases and concurrent independent mutations', async () => {
  const workspace = makeWorkspace('c7-own');
  const first = makeHandoffFixture('c7-own-a');
  const second = makeHandoffFixture('c7-own-b');
  try {
    assert.equal(bind(workspace, 'constructor', targetRecord(first)).status, 0);
    const resolved = resolveAlias(workspace, 'constructor');
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(json(resolved).status, 'binding');

    const results = await Promise.all(
      [
        ['alias-a', targetRecord(first)],
        ['alias-b', targetRecord(second)],
      ].map(
        ([alias, record]) =>
          new Promise<{ code: number | null; stdout: string }>(
            (resolve, reject) => {
              const child = spawn(
                process.execPath,
                [
                  CLI,
                  ...bindingArgs('bind', workspace, [
                    '--task-id',
                    alias!,
                    '--record',
                    record!,
                    '--apply',
                  ]),
                ],
                {
                  cwd: workspace,
                  stdio: ['ignore', 'pipe', 'pipe'],
                  shell: false,
                  timeout: 20_000,
                },
              );
              let stdout = '';
              child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
                stdout += chunk;
              });
              child.stderr.setEncoding('utf8').on('data', () => undefined);
              child.on('error', reject);
              child.on('close', (code) => resolve({ code, stdout }));
            },
          ),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.code),
      [0, 0],
    );
    const bindings = readIndex(workspace).bindings as Record<string, unknown>;
    assert.ok(Object.hasOwn(bindings, 'alias-a'));
    assert.ok(Object.hasOwn(bindings, 'alias-b'));
    assert.ok(Object.hasOwn(bindings, 'constructor'));
  } finally {
    first.domain.cleanup();
    second.domain.cleanup();
    cleanup(workspace);
  }
});

test('binding mutations refuse exact serialized index overflow and preserve readability', () => {
  const workspace = makeWorkspace('c7-capacity');
  const target = makeHandoffFixture('c7-capacity-target');
  try {
    const boundary = writeNearLimitIndex(workspace);
    assert.ok(boundary.bytes <= MAX_INDEX_BYTES);
    const exactIndex = Buffer.concat([
      boundary.contents,
      Buffer.alloc(MAX_INDEX_BYTES - boundary.bytes, 0x20),
    ]);
    assert.equal(exactIndex.byteLength, MAX_INDEX_BYTES);
    writeFileSync(boundary.file, exactIndex);
    const before = readFileSync(boundary.file);
    const exactRead = resolveAlias(workspace, boundary.existingAlias);
    assert.equal(exactRead.status, 0, exactRead.stderr);
    assert.equal(json(exactRead).status, 'unbound');
    const alias = 'a'.repeat(128);
    const assertCapacity = (result: ReturnType<typeof run>) => {
      assert.equal(result.status, 1, result.stderr);
      const body = json(result);
      assert.equal(body.code, 'bindings_capacity');
      const details = body.details as string[];
      const serialized = Number(
        details
          .find((detail) => detail.startsWith('serialized_bytes='))
          ?.slice('serialized_bytes='.length),
      );
      assert.ok(serialized > MAX_INDEX_BYTES);
      assert.ok(details.includes(`max_bytes=${MAX_INDEX_BYTES}`));
    };

    const bindResult = bind(workspace, alias, targetRecord(target));
    assertCapacity(bindResult);
    assert.deepEqual(readFileSync(boundary.file), before);
    const afterBind = resolveAlias(workspace, alias);
    assert.equal(afterBind.status, 0, afterBind.stderr);
    assert.equal(json(afterBind).status, 'none');

    const unbindResult = run(
      bindingArgs('unbind', workspace, ['--task-id', alias, '--apply']),
      workspace,
    );
    assertCapacity(unbindResult);
    assert.deepEqual(readFileSync(boundary.file), before);
    const afterUnbind = resolveAlias(workspace, alias);
    assert.equal(afterUnbind.status, 0, afterUnbind.stderr);
    assert.equal(json(afterUnbind).status, 'none');
    const preservedTombstone = resolveAlias(workspace, boundary.existingAlias);
    assert.equal(preservedTombstone.status, 0, preservedTombstone.stderr);
    assert.equal(json(preservedTombstone).status, 'unbound');
  } finally {
    target.domain.cleanup();
    cleanup(workspace);
  }
});

test('overlapping bindings and tombstones are invalid without discovery fallback', () => {
  const workspace = makeWorkspace('c7-overlap');
  const target = makeHandoffFixture('c7-overlap-target');
  try {
    const alias = 'constructor';
    assert.equal(bind(workspace, alias, targetRecord(target)).status, 0);
    const file = indexFile(workspace);
    const table = readIndex(workspace) as {
      bindings: Record<string, unknown>;
      unbound: Record<string, unknown>;
    };
    assert.ok(Object.hasOwn(table.bindings, alias));
    table.unbound[alias] = {
      alias,
      at: '2026-10-21T00:00:00.000Z',
      previous: table.bindings[alias],
    };
    writeFileSync(file, `${JSON.stringify(table, null, 2)}\n`);
    const before = readFileSync(file);
    const rootsFile = join(workspace, 'roots.json');
    writeRoots(rootsFile, [target.domain.domainRoot]);
    const operations = [
      run(bindingArgs('list', workspace), workspace),
      resolveAlias(workspace, alias, ['--roots', rootsFile]),
      bind(workspace, alias, targetRecord(target)),
      run(
        bindingArgs('unbind', workspace, ['--task-id', alias, '--apply']),
        workspace,
      ),
    ];
    for (const result of operations) {
      assert.equal(result.status, 2, result.stderr);
      assert.equal(json(result).code, 'bindings_invalid');
      assert.ok(
        (json(result).details as string[]).includes('binding_unbound_overlap'),
      );
      assert.deepEqual(readFileSync(file), before);
    }
  } finally {
    target.domain.cleanup();
    cleanup(workspace);
  }
});

async function bindWithLockHook(
  root: string,
  taskId: string,
  record: string,
  beforeLockOpen: () => void,
) {
  const lockPath = join(root, '.pappra', 'local', 'collab-bindings.lock');
  const originalOpen = fsPromises.open;
  let intercepted = false;
  const interceptingOpen = async (
    ...args: Parameters<typeof fsPromises.open>
  ) => {
    // Atomic lock publication opens a private staging file first. Intercept
    // acquisition, before the guarded action, rather than the release read.
    if (!intercepted && String(args[0]).startsWith(`${lockPath}.pending-`)) {
      intercepted = true;
      beforeLockOpen();
    }
    return originalOpen(...args);
  };
  fsPromises.open = interceptingOpen as typeof fsPromises.open;
  syncBuiltinESMExports();
  try {
    const { bindAlias } = await import('../../src/app/collab-bindings.js');
    const result = await bindAlias({
      root,
      taskId,
      record,
      roots: null,
      apply: true,
    });
    return { intercepted, result };
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
}

test('bind refuses immutable identity drift across the initial-to-apply seam', async () => {
  const workspace = makeWorkspace('c7-identity-seam');
  const target = makeHandoffFixture('c7-identity-seam-target');
  try {
    const recordFile = targetRecord(target);
    let previousCreatedAt: unknown;
    const { intercepted, result } = await bindWithLockHook(
      workspace,
      'alias-race',
      recordFile,
      () => {
        const record = JSON.parse(readFileSync(recordFile, 'utf8')) as Record<
          string,
          unknown
        >;
        previousCreatedAt = record.created_at;
        record.created_at = '2020-01-01T00:00:00.000Z';
        writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
      },
    );
    assert.equal(intercepted, true);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('A changed task incarnation must be refused.');
    assert.equal(result.code, 'binding_identity_changed');
    assert.ok(previousCreatedAt !== '2020-01-01T00:00:00.000Z');
    assert.equal(existsSync(indexFile(workspace)), false);
    const list = run(bindingArgs('list', workspace), workspace);
    assert.equal(list.status, 0, list.stderr);
    assert.equal((json(list).counts as Record<string, unknown>).bindings, 0);
  } finally {
    target.domain.cleanup();
    cleanup(workspace);
  }
});

test('bind accepts ordinary transaction replacement across the initial-to-apply seam', async () => {
  const workspace = makeWorkspace('c7-revision-seam');
  const target = makeHandoffFixture('c7-revision-seam-target');
  try {
    const recordFile = targetRecord(target);
    const beforeRecord = JSON.parse(readFileSync(recordFile, 'utf8')) as Record<
      string,
      unknown
    >;
    const { intercepted, result } = await bindWithLockHook(
      workspace,
      'alias-revision-race',
      recordFile,
      () => {
        const committed = transact(target.task, {
          actor: 'fixture',
          purpose: 'initial-to-apply-revision',
          apply: (record) => {
            record.uncertainty = record.uncertainty ?? [];
            record.uncertainty.push({
              uncertainty_id: `unc-${Date.now()}`,
              kind: 'late_result',
              subtask_id: null,
              attempt: null,
              detail: null,
              evidence_ref: null,
              resolution_hint: null,
              opened_at: new Date().toISOString(),
              resolved_at: null,
              resolution: null,
              resolution_evidence: null,
              auto_restart: false,
            });
            return { record, op: 'initial-to-apply-revision', summary: {} };
          },
        });
        assert.equal(committed.ok, true);
      },
    );
    assert.equal(intercepted, true);
    if (!result.ok) assert.fail(result.message);
    assert.equal(result.value.status, 'bound');
    const resolved = resolveAlias(workspace, 'alias-revision-race');
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(json(resolved).status, 'binding');
    const snapshot = json(resolved).target as Record<string, unknown>;
    assert.ok(
      Number(snapshot.state_revision) > Number(beforeRecord.state_revision),
    );
    assert.equal(snapshot.record_created_at, beforeRecord.created_at);
  } finally {
    target.domain.cleanup();
    cleanup(workspace);
  }
});
