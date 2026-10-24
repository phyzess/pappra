import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getPackageInfo } from '../../src/index.js';
import { createRepository } from '../workspace/fixtures.js';

const root = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);
const cli = join(root, 'dist/cli/main.js');
const version = getPackageInfo().version;

function invoke(
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 180_000,
    env: { ...process.env, ...environment },
  });
  if (result.error) throw result.error;
  return result;
}

function parseJson(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  assert(typeof value === 'object' && value !== null);
  return value as Record<string, unknown>;
}

test('runtime install plans without writing, then installs from the running package', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-runtime-cli-'));
  const dataDir = join(temporary, 'data');
  const environment = { PAPPRA_DATA_HOME: dataDir };
  try {
    const planned = invoke(
      ['runtime', 'install', '--json'],
      temporary,
      environment,
    );
    assert.equal(planned.status, 0, planned.stderr);
    const plan = parseJson(planned.stdout);
    assert.equal(plan.mode, 'plan');
    assert.equal(plan.source, 'self');
    assert.equal(plan.version, version);
    assert.equal(existsSync(dataDir), false);

    const installed = invoke(
      ['runtime', 'install', '--apply', '--json'],
      temporary,
      environment,
    );
    assert.equal(installed.status, 0, installed.stderr);
    const installedValue = parseJson(installed.stdout);
    assert.equal(installedValue.ok, true);
    const runtime = installedValue.runtime as Record<string, unknown>;
    assert.equal(runtime.status, 'installed');
    assert.equal(
      existsSync(join(dataDir, 'runtimes', version, 'install-manifest.json')),
      true,
    );

    const status = invoke(
      ['runtime', 'status', '--json'],
      temporary,
      environment,
    );
    assert.equal(status.status, 0, status.stderr);
    const statusValue = parseJson(status.stdout);
    const state = statusValue.runtime as Record<string, unknown>;
    assert.equal(state.status, 'content-match');
    assert.equal(state.source, 'self');
    assert.equal(state.packageDigestMatch, true);
    assert.equal(state.executableExists, true);

    const verified = invoke(
      ['runtime', 'verify', '--json'],
      temporary,
      environment,
    );
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(parseJson(verified.stdout).status, 'complete');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('runtime install --bind records the durable copy in machine.json', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-runtime-bind-'));
  const dataDir = join(temporary, 'data');
  const environment = { PAPPRA_DATA_HOME: dataDir };
  try {
    createRepository(temporary);
    const init = invoke(
      ['init', '--yes', '--apply', '--no-runtime', '--json'],
      temporary,
      environment,
    );
    assert.equal(init.status, 0, init.stderr);
    const initValue = parseJson(init.stdout);
    assert.equal(initValue.ok, true);
    assert.equal(initValue.initComplete, false);

    const unbound = invoke(
      ['runtime', 'install', '--apply', '--json'],
      temporary,
      environment,
    );
    assert.equal(unbound.status, 0, unbound.stderr);
    assert.equal(parseJson(unbound.stdout).bind, null);

    const bound = invoke(
      ['runtime', 'install', '--apply', '--bind', '--json'],
      temporary,
      environment,
    );
    assert.equal(bound.status, 0, bound.stderr);
    const boundValue = parseJson(bound.stdout);
    assert.deepEqual((boundValue.bind as Record<string, unknown>).ok, true);
    const machine = JSON.parse(
      readFileSync(join(temporary, '.pappra', 'local', 'machine.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal((machine.runtime as Record<string, unknown>).version, version);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('runtime remove previews without writing and preserves a bound runtime even with force', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-runtime-remove-'));
  const dataDir = join(temporary, 'data');
  const environment = { PAPPRA_DATA_HOME: dataDir };
  try {
    createRepository(temporary);
    const init = invoke(
      ['init', '--yes', '--apply', '--json'],
      temporary,
      environment,
    );
    assert.equal(init.status, 0, init.stderr);

    const missingApply = invoke(
      ['runtime', 'remove', '--json'],
      temporary,
      environment,
    );
    assert.equal(missingApply.status, 0, missingApply.stderr);
    assert.equal(parseJson(missingApply.stdout).mode, 'plan');
    assert.equal(existsSync(join(dataDir, 'runtimes', version)), true);

    const bound = invoke(
      ['runtime', 'remove', '--apply', '--json'],
      temporary,
      environment,
    );
    assert.equal(bound.status, 1, bound.stderr);
    assert.equal(parseJson(bound.stdout).ok, false);

    // A caller outside the owning workspace cannot claim the shared runtime
    // is unused merely because its own cwd has no machine.json binding.
    const otherWorkspace = invoke(
      ['runtime', 'remove', '--runtime-version', version, '--apply', '--json'],
      dirname(temporary),
      environment,
    );
    assert.equal(otherWorkspace.status, 1, otherWorkspace.stderr);
    assert.equal(
      (parseJson(otherWorkspace.stdout).removed as Record<string, unknown>)
        .status,
      'in-use',
    );
    assert.equal(existsSync(join(dataDir, 'runtimes', version)), true);

    const forced = invoke(
      ['runtime', 'remove', '--apply', '--force', '--json'],
      temporary,
      environment,
    );
    assert.equal(forced.status, 1, forced.stderr);
    assert.equal(
      (parseJson(forced.stdout).removed as Record<string, unknown>).status,
      'in-use',
    );
    assert.equal(existsSync(join(dataDir, 'runtimes', version)), true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
