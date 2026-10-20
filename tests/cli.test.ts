import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getPackageInfo } from '../src/index.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  createRepository,
  writeMachineConfig,
  writeWorkspaceConfig,
} from './workspace/fixtures.js';

const root = dirname(fileURLToPath(import.meta.resolve('pappra/package.json')));
const cli = join(root, 'dist/cli/main.js');

function invoke(args: string[], cwd = root) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return result;
}

test('the compiled CLI reads package version from an unrelated working directory', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-cli-'));
  try {
    const result = invoke(['--version', '--json'], temporary);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), getPackageInfo());
    assert.equal(result.stderr, '');
    assert.deepEqual(readdirSync(temporary), []);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('help advertises the implemented init command', () => {
  const result = invoke(['--help', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const value: unknown = JSON.parse(result.stdout);
  assert(typeof value === 'object' && value !== null);
  assert('commands' in value);
  assert.deepEqual(value.commands, [
    'init',
    'doctor',
    'docs',
    'checkpoint',
    'resume',
    'code',
    'host',
    'collab',
  ]);
  assert('usage' in value && typeof value.usage === 'string');
  assert.match(value.usage, /pappra init/);
});

test('host describe and plan expose typed output without writing', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-cli-host-'));
  const hostRoot = join(temporary, 'host with spaces Ω');
  try {
    writeWorkspaceConfig(
      temporary,
      baseWorkspaceConfig({
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    const described = invoke(
      [
        'host',
        'describe',
        '--host',
        'claude',
        '--host-version',
        '2.1.292',
        '--json',
      ],
      temporary,
    );
    assert.equal(described.status, 0, described.stderr);
    const capability: unknown = JSON.parse(described.stdout);
    assert(typeof capability === 'object' && capability !== null);
    assert(
      'schema' in capability &&
        capability.schema === 'pappra/host-capabilities/1',
    );
    assert(
      'capabilities' in capability && Array.isArray(capability.capabilities),
    );

    const planned = invoke(
      [
        'host',
        'plan',
        '--host',
        'pi',
        '--host-version',
        '1.3.0',
        '--host-root',
        hostRoot,
        '--json',
      ],
      temporary,
    );
    assert.equal(planned.status, 0, planned.stderr);
    const plan: unknown = JSON.parse(planned.stdout);
    assert(typeof plan === 'object' && plan !== null);
    assert('schema' in plan && plan.schema === 'pappra/host-integration/1');
    assert('bundleDigest' in plan && typeof plan.bundleDigest === 'string');
    assert.equal(existsSync(hostRoot), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('init without selections fails closed in a non-interactive session', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-cli-init-'));
  try {
    const result = invoke(['init', '--json'], temporary);
    assert.equal(result.status, 1);
    const value: unknown = JSON.parse(result.stdout);
    assert(typeof value === 'object' && value !== null);
    assert('code' in value && value.code === 'init_no_tty');
    assert.equal(result.stderr, '');
    assert.deepEqual(readdirSync(temporary), []);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('conflicting modes and unknown flags cannot silently select an operation', () => {
  for (const args of [['--help', '--version'], ['--unknown']]) {
    const result = invoke(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^pappra:/);
  }
});

test('code status is passive and prepare planning does not create an index', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-cli-code-'));
  try {
    writeWorkspaceConfig(
      temporary,
      baseWorkspaceConfig({
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    writeMachineConfig(temporary, baseMachineConfig(temporary));
    createRepository(temporary);
    const status = invoke(
      ['code', 'status', '--repo', 'app', '--json'],
      temporary,
    );
    assert.equal(status.status, 1);
    const value: unknown = JSON.parse(status.stdout);
    assert(typeof value === 'object' && value !== null);
    assert('health' in value);
    assert.equal(existsSync(join(temporary, '.codegraph')), false);

    const plan = invoke(
      ['code', 'prepare', '--repo', 'app', '--json'],
      temporary,
    );
    assert.equal(plan.status, 0, plan.stderr);
    const planned: unknown = JSON.parse(plan.stdout);
    assert(typeof planned === 'object' && planned !== null);
    assert('plan' in planned);
    assert.equal(existsSync(join(temporary, '.codegraph')), false);

    const query = invoke(
      [
        'code',
        'query',
        '--repo',
        'app',
        '--kind',
        'text',
        '--query',
        'tracked',
        '--json',
      ],
      temporary,
    );
    assert.equal(query.status, 0, query.stderr);
    assert.equal(existsSync(join(temporary, '.codegraph')), false);

    const missing = invoke(
      ['code', 'status', '--repo', 'missing', '--json'],
      temporary,
    );
    assert.equal(missing.status, 1);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
