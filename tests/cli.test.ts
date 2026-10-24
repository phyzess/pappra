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

const root = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);
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
    'onboard',
    'doctor',
    'repair',
    'docs',
    'checkpoint',
    'resume',
    'code',
    'host',
    'runtime',
    'task',
    'mcp',
    'collab',
    'session',
  ]);
  assert('usage' in value && typeof value.usage === 'string');
  assert.match(value.usage, /pappra init/);
});

test('help exposes the full collaboration family and truthful MCP tool gates', () => {
  const global = invoke(['--help', '--json']);
  assert.equal(global.status, 0, global.stderr);
  const usage = (JSON.parse(global.stdout) as { usage: string }).usage;
  for (const action of [
    'prepare',
    'run',
    'query',
    'preflight',
    'message',
    'capabilities',
    'state',
    'resource',
    'handoff',
    'recovery',
    'binding',
  ])
    assert.match(usage, new RegExp(`collab[^\\n]*${action}`), action);
  assert.match(usage, /pappra task <pin\|unpin\|show>/);

  const mcp = invoke(['mcp', '--help']);
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.match(mcp.stdout, /Read-only tools:/);
  assert.match(mcp.stdout, /--allow-workspace-writes/);
  assert.match(mcp.stdout, /trusted host/i);
  for (const tool of [
    'checkpoint',
    'docs_scan',
    'code_prepare',
    'runtime_install',
    'collab_prepare',
    'collab_start',
  ])
    assert.match(mcp.stdout, new RegExp(tool), tool);
  assert.match(mcp.stdout, /apply only selects preview versus execution/);
  assert.match(
    mcp.stdout,
    /runtime_install and code_prepare execution always require the authorized CLI/,
  );
  assert.match(mcp.stdout, /confirm: true/);
  assert.doesNotMatch(mcp.stdout, /exposes\nread-only tools \(/);
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
