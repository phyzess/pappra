import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getPackageInfo } from '../../src/index.js';
import { baseInitChoices } from './fixtures.js';
import { createRuntimeTarball } from '../install/fixtures.js';

const root = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);
const cli = join(root, 'dist/cli/main.js');

function invoke(
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 90_000,
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

function writeChoices(path: string): void {
  writeFileSync(path, `${JSON.stringify(baseInitChoices(), null, 2)}\n`);
}

test('init --config plans without writes and --apply applies only config files', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-cli-'));
  try {
    const choices = join(temporary, 'choices.json');
    writeChoices(choices);

    const planned = invoke(['init', '--config', choices, '--json'], temporary);
    assert.equal(planned.status, 0, planned.stderr);
    const plan = parseJson(planned.stdout);
    assert('ok' in plan && plan.ok === true);
    assert('plan' in plan);
    assert('scope' in plan);
    assert.equal(planned.stderr, '');
    assert.deepEqual(readdirSync(temporary), ['choices.json']);

    const applied = invoke(
      ['init', '--config', choices, '--apply', '--json'],
      temporary,
    );
    assert.equal(applied.status, 1, applied.stderr);
    const apply = parseJson(applied.stdout);
    assert('ok' in apply && apply.ok === true);
    assert('apply' in apply);
    const applyValue = apply.apply;
    assert(typeof applyValue === 'object' && applyValue !== null);
    assert(
      'status' in applyValue &&
        applyValue.status === 'external-actions-pending',
    );
    assert.equal(
      existsSync(join(temporary, '.pappra', 'workspace.json')),
      true,
    );
    assert.equal(
      existsSync(join(temporary, '.pappra', 'local', 'machine.json')),
      true,
    );

    const repeated = invoke(
      ['init', '--config', choices, '--apply', '--json'],
      temporary,
    );
    assert.equal(repeated.status, 1, repeated.stderr);
    const repeat = parseJson(repeated.stdout);
    assert('apply' in repeat);
    const repeatApply = repeat.apply;
    assert(typeof repeatApply === 'object' && repeatApply !== null);
    assert.equal(
      (repeatApply as Record<string, unknown>).status,
      'external-actions-pending',
    );

    const machinePath = join(temporary, '.pappra', 'local', 'machine.json');
    const machine = JSON.parse(readFileSync(machinePath, 'utf8'));
    machine.runtime = {
      version: getPackageInfo().version,
      executable: process.execPath,
      verifiedAt: '2026-10-17T00:00:00.000Z',
    };
    writeFileSync(machinePath, `${JSON.stringify(machine, null, 2)}\n`);
    const settled = invoke(
      ['init', '--config', choices, '--apply', '--json'],
      temporary,
    );
    assert.equal(settled.status, 0, settled.stderr);
    const settledJson = parseJson(settled.stdout);
    assert('apply' in settledJson);
    const settledApply = settledJson.apply;
    assert(typeof settledApply === 'object' && settledApply !== null);
    assert.equal(
      (settledApply as Record<string, unknown>).status,
      'no-changes',
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('invalid init config returns JSON on stdout and writes nothing', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-cli-invalid-'));
  try {
    const choices = join(temporary, 'choices.json');
    writeFileSync(choices, '{"schema":');
    const result = invoke(['init', '--config', choices, '--json'], temporary);
    assert.equal(result.status, 2);
    const value = parseJson(result.stdout);
    assert('ok' in value && value.ok === false);
    assert('code' in value && value.code === 'init_invalid_input');
    assert.equal(result.stderr, '');
    assert.deepEqual(readdirSync(temporary), ['choices.json']);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('init help is available without opening the wizard', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-cli-help-'));
  try {
    const result = invoke(['init', '--help', '--json'], temporary);
    assert.equal(result.status, 0, result.stderr);
    const value = parseJson(result.stdout);
    assert('usage' in value && typeof value.usage === 'string');
    assert.match(value.usage, /pappra init/);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('installs a verified local runtime and records it in machine.json', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-cli-runtime-'));
  const dataDir = join(temporary, 'data');
  try {
    const version = getPackageInfo().version;
    const businessPackage = join(temporary, 'package.json');
    writeFileSync(
      businessPackage,
      `${JSON.stringify({ name: 'business-project', private: true }, null, 2)}\n`,
    );
    const businessBefore = readFileSync(businessPackage, 'utf8');
    const tarball = createRuntimeTarball(temporary, {
      version,
      packageName: getPackageInfo().name,
    });
    const choices = join(temporary, 'choices.json');
    writeChoices(choices);
    const result = invoke(
      [
        'init',
        '--config',
        choices,
        '--apply',
        '--install-runtime',
        '--runtime-tarball',
        tarball,
        '--json',
      ],
      temporary,
      { PAPPRA_DATA_HOME: dataDir },
    );
    assert.equal(
      result.status,
      0,
      `${result.stdout}
${result.stderr}`,
    );
    const value = parseJson(result.stdout);
    assert.equal(value.ok, true);
    assert.equal(value.initComplete, true);
    const runtime = value.runtime;
    assert(typeof runtime === 'object' && runtime !== null);
    assert.equal((runtime as Record<string, unknown>).status, 'installed');
    const machine = JSON.parse(
      readFileSync(join(temporary, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime.version, version);
    assert.equal(
      existsSync(join(dataDir, 'runtimes', version, 'install-manifest.json')),
      true,
    );
    assert.equal(readFileSync(businessPackage, 'utf8'), businessBefore);

    const repeated = invoke(
      ['init', '--config', choices, '--apply', '--json'],
      temporary,
      { PAPPRA_DATA_HOME: dataDir },
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    const repeatedValue = parseJson(repeated.stdout);
    assert('apply' in repeatedValue);
    const repeatedApply = repeatedValue.apply;
    assert(typeof repeatedApply === 'object' && repeatedApply !== null);
    assert.equal(
      (repeatedApply as Record<string, unknown>).status,
      'no-changes',
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('runtime flags require an explicit install request and source', () => {
  const temporary = mkdtempSync(
    join(tmpdir(), 'pappra-init-cli-runtime-invalid-'),
  );
  try {
    const choices = join(temporary, 'choices.json');
    writeChoices(choices);
    const missingInstall = invoke(
      [
        'init',
        '--config',
        choices,
        '--apply',
        '--runtime-tarball',
        'x.tgz',
        '--json',
      ],
      temporary,
    );
    assert.equal(missingInstall.status, 2);
    const missingSource = invoke(
      ['init', '--config', choices, '--apply', '--install-runtime', '--json'],
      temporary,
    );
    assert.equal(missingSource.status, 2);
    const missingApply = invoke(
      [
        'init',
        '--config',
        choices,
        '--install-runtime',
        '--runtime-version',
        '0.1.0',
        '--json',
      ],
      temporary,
    );
    assert.equal(missingApply.status, 2);
    assert.equal(
      existsSync(join(temporary, '.pappra', 'workspace.json')),
      false,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
