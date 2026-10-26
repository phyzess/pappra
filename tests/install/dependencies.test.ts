import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  materializeInstalledDependencies,
  resolveInstalledDependency,
} from '../../src/install/dependencies.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

function writePackage(
  directory: string,
  manifest: Record<string, unknown>,
): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function writePayload(directory: string, file: string, body: string): void {
  const path = join(directory, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function packageVersion(directory: string): string {
  const decoded: unknown = JSON.parse(
    readFileSync(join(directory, 'package.json'), 'utf8'),
  );
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('version' in decoded) ||
    typeof decoded.version !== 'string'
  ) {
    throw new Error(`No version in ${directory}`);
  }
  return decoded.version;
}

interface InstalledTree {
  readonly app: string;
  readonly target: string;
}

/**
 * app
 * ├── left@1.0.0        -> shared@1.0.0, right@1.0.0 (cycle)
 * │   ├── node_modules/stale   (nested tree that must never be copied)
 * │   └── data/link -> ../payload.txt
 * ├── right@1.0.0       -> shared@2.0.0 (nested), left@1.0.0
 * │   └── node_modules/shared@2.0.0
 * └── shared@1.0.0
 */
function createInstalledTree(
  root: string,
  payloadLink?: string,
): InstalledTree {
  const app = join(root, 'app');
  const target = join(root, 'target');
  writePackage(app, {
    name: 'app',
    version: '0.0.0',
    dependencies: { left: '1.0.0', right: '1.0.0' },
    optionalDependencies: { ghost: '1.0.0' },
  });
  writePackage(join(app, 'node_modules', 'left'), {
    name: 'left',
    version: '1.0.0',
    dependencies: { shared: '1.0.0', right: '1.0.0' },
  });
  writePayload(join(app, 'node_modules', 'left'), 'payload.txt', 'payload\n');
  if (payloadLink !== undefined) {
    mkdirSync(join(app, 'node_modules', 'left', 'data'), { recursive: true });
    symlinkSync(payloadLink, join(app, 'node_modules', 'left', 'data', 'link'));
  }
  writePackage(join(app, 'node_modules', 'left', 'node_modules', 'stale'), {
    name: 'stale',
    version: '0.0.1',
  });
  writePayload(
    join(app, 'node_modules', 'left', 'node_modules', 'stale'),
    'nested.txt',
    'nested\n',
  );
  writePackage(join(app, 'node_modules', 'right'), {
    name: 'right',
    version: '1.0.0',
    dependencies: { shared: '2.0.0', left: '1.0.0' },
  });
  writePackage(join(app, 'node_modules', 'right', 'node_modules', 'shared'), {
    name: 'shared',
    version: '2.0.0',
  });
  writePackage(join(app, 'node_modules', 'shared'), {
    name: 'shared',
    version: '1.0.0',
  });
  mkdirSync(target, { recursive: true });
  return { app, target };
}

test('materialization hoists shared exact versions and preserves nesting', async () => {
  const root = makeTempDir('install-dependencies');
  try {
    const tree = createInstalledTree(root);
    const result = await materializeInstalledDependencies({
      sourceRoot: tree.app,
      targetRoot: tree.target,
    });
    assert.deepEqual(result.problems, []);
    assert.equal(result.ok, true);
    assert.deepEqual(result.skippedOptional, ['ghost']);

    const hoisted = join(tree.target, 'node_modules', 'shared');
    const nested = join(
      tree.target,
      'node_modules',
      'right',
      'node_modules',
      'shared',
    );
    assert.equal(packageVersion(hoisted), '1.0.0');
    assert.equal(packageVersion(nested), '2.0.0');
    // The shared dependency is copied once, not once per dependent.
    assert.equal(
      result.copied.filter((entry) =>
        entry.endsWith(join('node_modules', 'shared')),
      ).length,
      2,
    );
    // Cycle: the second reference to an already placed exact source is reused.
    assert.equal(
      result.reused.filter((entry) =>
        entry.endsWith(join('node_modules', 'left')),
      ).length,
      1,
    );
  } finally {
    cleanup(root);
  }
});

test('materialization never copies a nested node_modules subtree', async () => {
  const root = makeTempDir('install-dependencies');
  try {
    const tree = createInstalledTree(root);
    const result = await materializeInstalledDependencies({
      sourceRoot: tree.app,
      targetRoot: tree.target,
    });
    assert.equal(result.ok, true);
    const stale = join(
      tree.target,
      'node_modules',
      'left',
      'node_modules',
      'stale',
    );
    assert.throws(() => lstatSync(stale));
    assert.equal(
      result.copied.some((entry) =>
        entry.includes(join('left', 'node_modules')),
      ),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('materialized payloads have independent inodes and mutations in both directions', async () => {
  const root = makeTempDir('install-dependency-isolation');
  try {
    const tree = createInstalledTree(root);
    const result = await materializeInstalledDependencies({
      sourceRoot: tree.app,
      targetRoot: tree.target,
    });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    const source = join(tree.app, 'node_modules/left/payload.txt');
    const installed = join(tree.target, 'node_modules/left/payload.txt');
    const sourceStat = lstatSync(source);
    const installedStat = lstatSync(installed);
    assert(sourceStat.isFile() && installedStat.isFile());
    assert.notDeepEqual(
      [installedStat.dev, installedStat.ino],
      [sourceStat.dev, sourceStat.ino],
      'Payload copies must never be hardlinks to the installed source',
    );
    assert.equal(readFileSync(installed, 'utf8'), 'payload\n');
    writeFileSync(source, 'source changed\n');
    assert.equal(readFileSync(installed, 'utf8'), 'payload\n');
    writeFileSync(installed, 'installed changed\n');
    assert.equal(readFileSync(source, 'utf8'), 'source changed\n');
  } finally {
    cleanup(root);
  }
});

test('materialization refuses an existing destination and preserves its payload', async () => {
  const root = makeTempDir('install-dependency-existing');
  try {
    const tree = createInstalledTree(root);
    const destination = join(tree.target, 'node_modules/left');
    writePackage(destination, { name: 'left', version: 'foreign' });
    writePayload(destination, 'payload.txt', 'existing user payload\n');
    const manifest = readFileSync(join(destination, 'package.json'));
    const result = await materializeInstalledDependencies({
      sourceRoot: tree.app,
      targetRoot: tree.target,
    });
    assert.equal(result.ok, false);
    assert(result.problems.includes('dependency_copy_failed:left'));
    assert.equal(result.copied.includes(destination), false);
    assert.deepEqual(readFileSync(join(destination, 'package.json')), manifest);
    assert.equal(
      readFileSync(join(destination, 'payload.txt'), 'utf8'),
      'existing user payload\n',
    );
  } finally {
    cleanup(root);
  }
});

test('a later nested dependency cannot shadow an ancestor consumer that reused the root version', async () => {
  const root = makeTempDir('install-dependencies-shadow');
  try {
    const app = join(root, 'app');
    const target = join(root, 'target');
    const a = join(app, 'node_modules/a');
    const b1 = join(app, 'node_modules/b');
    const x1 = join(app, 'node_modules/x');
    const b2 = join(a, 'node_modules/b');
    const x2 = join(b2, 'node_modules/x');
    writePackage(app, {
      name: 'app',
      version: '1.0.0',
      dependencies: { a: '1.0.0', b: '1.0.0', x: '1.0.0' },
    });
    writePackage(a, {
      name: 'a',
      version: '1.0.0',
      dependencies: { b: '2.0.0', x: '1.0.0' },
    });
    writePackage(b1, { name: 'b', version: '1.0.0' });
    writePackage(x1, { name: 'x', version: '1.0.0' });
    writePackage(b2, {
      name: 'b',
      version: '2.0.0',
      dependencies: { x: '2.0.0' },
    });
    writePackage(x2, { name: 'x', version: '2.0.0' });
    writePayload(
      a,
      'index.js',
      "module.exports = { x: require('x'), b: require('b') };\n",
    );
    writePayload(b1, 'index.js', "module.exports = 'b1';\n");
    writePayload(x1, 'index.js', "module.exports = 'x1';\n");
    writePayload(b2, 'index.js', "module.exports = require('x');\n");
    writePayload(x2, 'index.js', "module.exports = 'x2';\n");
    mkdirSync(target);
    const materialized = await materializeInstalledDependencies({
      sourceRoot: app,
      targetRoot: target,
    });
    assert.equal(materialized.ok, true, JSON.stringify(materialized.problems));
    const requireSource = createRequire(join(a, 'index.js'));
    const requireTarget = createRequire(
      join(target, 'node_modules/a/index.js'),
    );
    assert.deepEqual(requireSource('./index.js'), { x: 'x1', b: 'x2' });
    assert.deepEqual(requireTarget('./index.js'), requireSource('./index.js'));
    assert.equal(packageVersion(join(target, 'node_modules/x')), '1.0.0');
    assert.equal(
      packageVersion(
        join(target, 'node_modules/a/node_modules/b/node_modules/x'),
      ),
      '2.0.0',
    );
  } finally {
    cleanup(root);
  }
});

test('payload links are rejected without copying their targets or publishing links', async () => {
  const root = makeTempDir('install-dependencies');
  try {
    const secret = join(root, 'private-secret');
    writeFileSync(secret, 'must remain outside runtime');
    const tree = createInstalledTree(root, secret);
    const result = await materializeInstalledDependencies({
      sourceRoot: tree.app,
      targetRoot: tree.target,
    });
    const link = join(tree.target, 'node_modules', 'left', 'data', 'link');
    assert.equal(result.ok, false);
    assert(result.problems.length > 0);
    assert.throws(() => lstatSync(link), { code: 'ENOENT' });
    assert.equal(readFileSync(secret, 'utf8'), 'must remain outside runtime');
  } finally {
    cleanup(root);
  }
});

test('a missing required dependency is reported, not silently skipped', async () => {
  const root = makeTempDir('install-dependencies');
  try {
    const app = join(root, 'app');
    const target = join(root, 'target');
    writePackage(app, { name: 'app', dependencies: { absent: '1.0.0' } });
    mkdirSync(target, { recursive: true });
    const result = await materializeInstalledDependencies({
      sourceRoot: app,
      targetRoot: target,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.problems, ['dependency_missing:absent']);
    assert.deepEqual(result.copied, []);
  } finally {
    cleanup(root);
  }
});

test('resolution matches the nearest installed ancestor version', async () => {
  const root = makeTempDir('install-dependencies');
  try {
    const tree = createInstalledTree(root);
    const fromLeft = await resolveInstalledDependency(
      join(tree.app, 'node_modules', 'left'),
      'shared',
    );
    const fromRight = await resolveInstalledDependency(
      join(tree.app, 'node_modules', 'right'),
      'shared',
    );
    // Resolution returns realpaths, so expectations resolve the symlinked temp
    // location first.
    assert.equal(
      fromLeft,
      realpathSync(join(tree.app, 'node_modules', 'shared')),
    );
    assert.equal(
      fromRight,
      realpathSync(
        join(tree.app, 'node_modules', 'right', 'node_modules', 'shared'),
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('a symlinked source root materializes the real dependency closure', async () => {
  const root = makeTempDir('install-dependencies');
  try {
    const tree = createInstalledTree(root);
    const linked = join(root, 'linked-app');
    symlinkSync(tree.app, linked);
    const result = await materializeInstalledDependencies({
      sourceRoot: linked,
      targetRoot: tree.target,
    });
    assert.equal(result.ok, true);
    assert.equal(
      packageVersion(join(tree.target, 'node_modules', 'shared')),
      '1.0.0',
    );
  } finally {
    cleanup(root);
  }
});
