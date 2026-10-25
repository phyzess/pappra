import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as facade from '../../scripts/self-host.js';
import { PACKAGE_NAME } from '../../scripts/self-host.js';
import type { CliDeps } from '../../scripts/self-host.js';

/**
 * The recorded public surface of the entry. `scripts/self-host.ts` must keep
 * exactly these runtime exports while its implementation moves into modules.
 */
const BASELINE_EXPORTS = [
  'CANONICAL_SKILL_FILE',
  'HOST_SKILL_DIRS',
  'HOST_SKILL_ORDER',
  'PACKAGE_NAME',
  'SKILL_ALIAS_TARGET',
  'SKILL_SOURCE',
  'admit',
  'applyFixes',
  'applySkillAlias',
  'applySkillAliases',
  'collectChecks',
  'defaultDeps',
  'formatChecks',
  'inspectSkillAlias',
  'parseEntryOptions',
  'parseJsonObject',
  'runDistCli',
  'runSelfHost',
  'skillAliasPaths',
] as const;

/** Check order is a published contract; ids and their sequence must not move. */
const CHECK_ORDER = [
  'node-version',
  'repository-admission',
  'workspace-selection',
  'dist-cli',
  'codegraph-engine',
  'skill-alias:.agents',
  'skill-alias:.pi',
  'skill-alias:.claude',
  'code-index',
  'docs-registration',
] as const;

/** Closed set of admitted self-host modules. Adding one requires review. */
const ADMITTED_MODULES = [
  'admission',
  'aliases',
  'apply',
  'checks',
  'cli',
  'documents',
  'paths',
  'types',
] as const;

const repoRoot = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);
const entryPath = join(repoRoot, 'scripts', 'self-host.ts');
const moduleDir = join(repoRoot, 'scripts', 'self-host');

function specifiers(file: string): readonly string[] {
  const contents = readFileSync(file, 'utf8');
  return [
    ...contents.matchAll(
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/g,
    ),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

function relativeSiblings(file: string): readonly string[] {
  const names = specifiers(file)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) =>
      specifier
        .replace(/^\.\//, '')
        .replace(/^self-host\//, '')
        .replace(/\.ts$/, ''),
    );
  return [...new Set(names)];
}

function fileDigests(root: string): ReadonlyMap<string, string> {
  const snapshot = new Map<string, string>();
  for (const name of readdirSync(root, {
    recursive: true,
    encoding: 'utf8',
  }).sort()) {
    const file = join(root, name);
    if (lstatSync(file).isFile()) {
      snapshot.set(
        name,
        createHash('sha256').update(readFileSync(file)).digest('hex'),
      );
    }
  }
  return snapshot;
}

test('the entry graph stays inside the admitted modules and is acyclic', () => {
  const facadeSiblings = relativeSiblings(entryPath);
  for (const name of facadeSiblings) {
    assert.ok(
      (ADMITTED_MODULES as readonly string[]).includes(name),
      `the entry imports ${name}, which is not an admitted module`,
    );
  }
  assert.deepEqual([...facadeSiblings].sort(), [
    'admission',
    'aliases',
    'apply',
    'checks',
    'cli',
    'types',
  ]);

  const graph = new Map<string, readonly string[]>();
  for (const name of ADMITTED_MODULES) {
    const file = join(moduleDir, `${name}.ts`);
    for (const specifier of specifiers(file)) {
      if (!specifier.startsWith('.')) {
        assert.match(
          specifier,
          /^node:/,
          `${name}.ts imports the non-builtin module ${specifier}`,
        );
        continue;
      }
      assert.match(
        specifier,
        /^\.\/[a-z]+\.ts$/,
        `${name}.ts must import a sibling with an explicit .ts specifier: ${specifier}`,
      );
      const target = specifier.replace(/^\.\//, '').replace(/\.ts$/, '');
      assert.ok(
        (ADMITTED_MODULES as readonly string[]).includes(target),
        `${name}.ts imports ${target}, which is not an admitted module`,
      );
    }
    graph.set(name, relativeSiblings(file));
  }

  // Native Node loading requires explicit extensions everywhere.
  for (const file of [
    entryPath,
    ...ADMITTED_MODULES.map((name) => join(moduleDir, `${name}.ts`)),
  ]) {
    for (const specifier of specifiers(file)) {
      if (specifier.startsWith('.')) {
        assert.ok(
          specifier.endsWith('.ts'),
          `${file} must use a .ts specifier for ${specifier}`,
        );
      }
    }
  }

  // The base module is the only one allowed to import nothing.
  assert.deepEqual(graph.get('types'), []);
  // The CLI dependency seam sits below its consumers, so it may only need types.
  assert.deepEqual([...(graph.get('cli') ?? [])].sort(), ['types']);

  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (name: string, trail: readonly string[]): void => {
    if (done.has(name)) return;
    assert.ok(
      !visiting.has(name),
      `import cycle: ${[...trail, name].join(' -> ')}`,
    );
    visiting.add(name);
    for (const next of graph.get(name) ?? []) visit(next, [...trail, name]);
    visiting.delete(name);
    done.add(name);
  };
  for (const name of ADMITTED_MODULES) visit(name, []);
  assert.equal(done.size, ADMITTED_MODULES.length);
});

test('a cold clone runs the native entry without dist, .build or node_modules', () => {
  // `/tmp` is a symlink on some hosts; the entry compares real paths.
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), 'pappra-self-host-native-'),
  );
  try {
    cpSync(entryPath, join(root, 'scripts', 'self-host.ts'));
    cpSync(moduleDir, join(root, 'scripts', 'self-host'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: PACKAGE_NAME, type: 'module' }, null, 2)}\n`,
    );
    mkdirSync(join(root, 'skills', 'pappra'), { recursive: true });
    writeFileSync(join(root, 'skills', 'pappra', 'SKILL.md'), '# fixture\n');
    mkdirSync(join(root, '.pappra'), { recursive: true });
    writeFileSync(
      join(root, '.pappra', 'workspace.json'),
      `${JSON.stringify(
        {
          workspaceId: 'workspace-fixture',
          repositories: [{ id: 'app', path: '.', access: 'write' }],
          knowledge: { sources: [], newDocuments: '.pappra/knowledge' },
          code: { graph: 'codegraph', symbols: 'auto', prepare: 'on-demand' },
        },
        null,
        2,
      )}\n`,
    );
    assert.equal(readdirSync(root).includes('dist'), false);
    assert.equal(readdirSync(root).includes('.build'), false);
    assert.equal(readdirSync(root).includes('node_modules'), false);
    const before = readdirSync(root, { recursive: true }).sort();
    const beforeDigests = fileDigests(root);

    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'self-host.ts'), '--check', '--json'],
      { cwd: root, encoding: 'utf8', shell: false, timeout: 120_000 },
    );
    if (result.error) throw result.error;
    assert.equal(result.stderr, '');
    const payload: unknown = JSON.parse(result.stdout);
    assert(typeof payload === 'object' && payload !== null);
    const report = payload as {
      checks: readonly { id: string; state: string }[];
      actions: readonly string[];
      converged: boolean;
    };
    assert.deepEqual(
      report.checks.map((check) => check.id),
      [...CHECK_ORDER],
    );
    assert.equal(report.converged, false);
    assert.equal(result.status, 1);
    assert.deepEqual(report.actions, []);
    const states = new Map(
      report.checks.map((check) => [check.id, check.state]),
    );
    assert.equal(states.get('node-version'), 'ok');
    assert.equal(states.get('repository-admission'), 'ok');
    assert.equal(states.get('workspace-selection'), 'ok');
    assert.equal(states.get('dist-cli'), 'blocked');
    assert.equal(states.get('code-index'), 'blocked');
    assert.equal(states.get('docs-registration'), 'blocked');
    assert.equal(states.get('skill-alias:.pi'), 'action');
    assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before);
    assert.deepEqual(fileDigests(root), beforeDigests);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the emitted graph keeps the public surface and rewritten specifiers', () => {
  assert.deepEqual(Object.keys(facade).sort(), [...BASELINE_EXPORTS].sort());

  const emittedEntry = fileURLToPath(
    new URL('../../scripts/self-host.js', import.meta.url),
  );
  const emitted = readFileSync(emittedEntry, 'utf8');
  assert.doesNotMatch(emitted, /\bfrom\s*'[^']*\.ts'/);
  assert.match(emitted, /self-host\/types\.js/);

  const fake: CliDeps = {
    runCli: (args) => ({
      status: 0,
      stdout:
        args[0] === 'docs' && args[1] === 'scan'
          ? `${JSON.stringify({ ok: true, candidates: [] })}\n`
          : `${JSON.stringify({ ok: true })}\n`,
      stderr: '',
    }),
  };
  const root = mkdtempSync(join(tmpdir(), 'pappra-self-host-emitted-'));
  try {
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: PACKAGE_NAME }, null, 2)}\n`,
    );
    const checks = facade.collectChecks(root, fake);
    assert.deepEqual(
      checks.map((check) => check.id),
      [...CHECK_ORDER],
    );
    const states = new Map(checks.map((check) => [check.id, check.state]));
    assert.equal(states.get('node-version'), 'ok');
    assert.equal(states.get('repository-admission'), 'blocked');
    assert.equal(states.get('workspace-selection'), 'blocked');
    assert.equal(states.get('dist-cli'), 'blocked');
    assert.equal(states.get('code-index'), 'blocked');
    assert.equal(states.get('docs-registration'), 'blocked');
    const text = facade.formatChecks(checks, []);
    assert.match(
      text,
      /this entry never installs, trusts or edits global host configuration/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
