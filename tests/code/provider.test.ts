import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodeGraphProvider } from '../../src/code/index.js';
import { codeIndexHealthForTests } from '../../src/code/providers/codegraph.js';
import {
  codeIdentitySchema,
  codeQueryResultSchema,
} from '../../src/schemas/code.js';

function fixture(): {
  readonly root: string;
  readonly bin: string;
  readonly scenario: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'pappra-code-provider-'));
  const bin = join(root, 'fake-codegraph');
  const scenario = join(root, 'scenario.json');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const scenario = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
const argv = process.argv.slice(2);
const command = argv[0];
if (scenario.exitCode !== undefined) process.exit(scenario.exitCode);
if (scenario.exploreExit !== undefined && command === 'explore') {
  process.stderr.write('explore failure');
  process.exit(scenario.exploreExit);
}
if (command === 'query' && scenario.malformedQuery === true) {
  process.stdout.write(JSON.stringify([{
    filePath: 'a.ts',
    name: 'n'.repeat(600),
    kind: 'k'.repeat(80),
    startLine: -5,
    startColumn: -1,
    signature: 'export const alpha=1',
  }]));
  process.exit(0);
}
if (command === 'explore' && scenario.exploreBytes !== undefined) {
  process.stdout.write('x'.repeat(scenario.exploreBytes));
  process.exit(0);
}
if (scenario.raw !== undefined) { process.stdout.write(scenario.raw); process.exit(0); }
if (scenario.capture === true && command !== 'status') {
  fs.writeFileSync(path.join(__dirname, 'invocation.json'), JSON.stringify(argv));
}
const root = process.argv[process.argv.length - 1];
const base = {
  initialized: true,
  version: '1.4.1',
  projectPath: root,
  indexPath: path.join(root, '.codegraph'),
  lastIndexed: '2026-10-19T00:00:00.000Z',
  fileCount: 1,
  nodeCount: 2,
  edgeCount: 1,
  dbSizeBytes: 1024,
  languages: ['typescript'],
  pendingChanges: { added: 0, modified: 0, removed: 0 },
  worktreeMismatch: null,
  index: {
    builtWithVersion: '1.4.1',
    builtWithExtractionVersion: 24,
    currentExtractionVersion: 24,
    reindexRecommended: false,
    state: 'complete',
    pendingRefs: 0,
  },
};
const output = { ...base, ...scenario.patch };
process.stdout.write(JSON.stringify(output));
`,
  );
  chmodSync(bin, 0o755);
  return { root, bin, scenario };
}

function identity(
  root: string,
  configStatus?: 'default' | 'observed' | 'unknown',
) {
  return codeIdentitySchema.parse({
    schema: 'pappra/code-identity/1',
    repositoryId: 'app',
    checkoutId: 'fixture-checkout',
    root,
    gitDir: `${root}/.git`,
    gitCommonDir: `${root}/.git`,
    head: 'abc',
    branch: 'main',
    workingTree: {
      digest: `sha256:${'a'.repeat(64)}`,
      completeness: 'complete',
      fileCount: 0,
      byteCount: 0,
      reasons: [],
    },
    engine: {
      id: 'codegraph',
      version: '1.4.1',
      configDigest: `sha256:${'b'.repeat(64)}`,
      ...(configStatus === undefined ? {} : { configStatus }),
    },
  });
}

test('provider health matrix is truthful across engine states', async () => {
  const { root, bin, scenario } = fixture();
  try {
    const provider = new CodeGraphProvider(bin);
    const cases: readonly [string, Record<string, unknown>, string][] = [
      ['missing', { patch: { initialized: false } }, 'missing'],
      ['building', { patch: { index: { state: 'building' } } }, 'building'],
      ['partial', { patch: { index: { state: 'partial' } } }, 'partial'],
      ['failed', { patch: { index: { state: 'failed' } } }, 'failed'],
      [
        'pending source',
        { patch: { pendingChanges: { added: 0, modified: 1, removed: 0 } } },
        'stale',
      ],
      [
        'engine version',
        { patch: { index: { builtWithVersion: '1.0.0', state: 'complete' } } },
        'stale',
      ],
      [
        'worktree mismatch',
        { patch: { worktreeMismatch: { expected: '/a', actual: '/b' } } },
        'stale',
      ],
      ['ready', {}, 'ready'],
      ['invalid json', { raw: 'not-json' }, 'partial'],
      ['nonzero exit', { exitCode: 2 }, 'failed'],
    ];
    for (const [name, value, expected] of cases) {
      writeFileSync(scenario, JSON.stringify(value));
      const result = await provider.status(identity(root));
      assert.equal(result.ok, true, name);
      assert.equal(result.value.state, expected, name);
    }
    writeFileSync(scenario, JSON.stringify({ patch: {} }));
    const unknownConfig = await provider.status(identity(root, 'unknown'));
    assert.equal(unknownConfig.ok, true);
    assert.equal(unknownConfig.value.state, 'stale');
    assert(unknownConfig.value.reasons.includes('engine_config_unknown'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider status does not write the fixture', async () => {
  const { root, bin, scenario } = fixture();
  try {
    writeFileSync(scenario, JSON.stringify({ patch: {} }));
    const provider = new CodeGraphProvider(bin);
    await provider.status(identity(root));
    assert.equal(readFileSync(scenario, 'utf8').length > 0, true);
    assert.equal(
      readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node'),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nonzero explore exits are failures, not source results', async () => {
  const { root, bin, scenario } = fixture();
  try {
    writeFileSync(scenario, JSON.stringify({ exploreExit: 2 }));
    const provider = new CodeGraphProvider(bin);
    const result = await provider.query({
      schema: 'pappra/code-query/1',
      kind: 'explore',
      query: 'alpha',
      identity: identity(root),
      limits: { maxResults: 5, maxBytes: 4096, maxFiles: 5 },
    });
    assert.equal(result.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plan argv matches the actual prepare argv for init, sync and rebuild', async () => {
  const { root, bin, scenario } = fixture();
  try {
    const provider = new CodeGraphProvider(bin);
    writeFileSync(scenario, JSON.stringify({ capture: true }));
    const id = identity(root);
    const cases = [
      [codeIndexHealthForTests('missing', []), false, 'init'],
      [
        codeIndexHealthForTests('stale', ['source_changes_pending']),
        false,
        'sync',
      ],
      [codeIndexHealthForTests('ready', []), true, 'rebuild'],
    ] as const;
    for (const [health, rebuild, expected] of cases) {
      const plan = provider.plan(id, health, rebuild);
      assert.equal(plan.action, expected);
      const prepared = await provider.prepare(id, plan);
      assert.equal(prepared.ok, true);
      const invocation: unknown = JSON.parse(
        readFileSync(join(root, 'invocation.json'), 'utf8'),
      );
      assert.deepEqual(invocation, plan.command.slice(1));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native malformed rows and clipped explore satisfy the result contract', async () => {
  const { root, bin, scenario } = fixture();
  try {
    const provider = new CodeGraphProvider(bin);
    const id = identity(root);
    writeFileSync(scenario, JSON.stringify({ malformedQuery: true }));
    const native = await provider.query({
      schema: 'pappra/code-query/1',
      kind: 'symbol',
      query: 'alpha',
      identity: id,
      limits: { maxResults: 5, maxBytes: 4096, maxFiles: 5 },
    });
    assert.equal(native.ok, true);
    if (!native.ok) return;
    const parsed = codeQueryResultSchema.safeParse(native.value);
    assert.equal(parsed.success, true);
    assert.equal(native.value.truncated, true);
    assert(native.value.reasons.includes('native_rows_adjusted'));
    assert((native.value.items[0]?.name?.length ?? 0) <= 512);
    assert((native.value.items[0]?.kind.length ?? 0) <= 64);
    assert.equal(native.value.items[0]?.line, null);
    assert.equal(native.value.items[0]?.column, null);

    writeFileSync(scenario, JSON.stringify({ exploreBytes: 5000 }));
    const explore = await provider.query({
      schema: 'pappra/code-query/1',
      kind: 'explore',
      query: 'alpha',
      identity: id,
      limits: { maxResults: 5, maxBytes: 16384, maxFiles: 5 },
    });
    assert.equal(explore.ok, true);
    if (!explore.ok) return;
    assert.equal(
      Buffer.byteLength(explore.value.items[0]?.snippet ?? '', 'utf8') <= 4096,
      true,
    );
    assert.equal(explore.value.truncated, true);
    assert(explore.value.reasons.includes('explore_output_clipped'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
