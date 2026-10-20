import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  createRepository,
  snapshotTree,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

const root = dirname(fileURLToPath(import.meta.resolve('pappra/package.json')));
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
    timeout: 30_000,
    env: { ...process.env, ...environment },
  });
  if (result.error) throw result.error;
  return result;
}

function parse(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  assert(typeof value === 'object' && value !== null);
  return value as Record<string, unknown>;
}

function isolated(): {
  readonly root: string;
  readonly home: string;
  readonly data: string;
  readonly bin: string;
} {
  return {
    root: mkdtempSync(join(tmpdir(), 'pappra-doctor-cli-')),
    home: mkdtempSync(join(tmpdir(), 'pappra-doctor-home-')),
    data: mkdtempSync(join(tmpdir(), 'pappra-doctor-data-')),
    bin: mkdtempSync(join(tmpdir(), 'pappra-doctor-bin-')),
  };
}

test('doctor --json emits only the report and does not write', () => {
  const fixture = isolated();
  try {
    const before = readdirSync(fixture.root);
    const result = invoke(
      ['doctor', '--root', fixture.root, '--json'],
      fixture.home,
      {
        HOME: fixture.home,
        PAPPRA_DATA_HOME: fixture.data,
        PATH: fixture.bin,
      },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const report = parse(result.stdout);
    assert.equal(report.schema, 'pappra/doctor-report/1');
    const workspace = report.workspace;
    assert(typeof workspace === 'object' && workspace !== null);
    assert.equal((workspace as Record<string, unknown>).state, 'missing');
    const summary = report.summary;
    assert(typeof summary === 'object' && summary !== null);
    assert.equal((summary as Record<string, unknown>).exitCode, 1);
    assert.deepEqual(readdirSync(fixture.root), before);
    assert.deepEqual(readdirSync(fixture.home), []);
    assert.deepEqual(readdirSync(fixture.data), []);
    assert.deepEqual(readdirSync(fixture.bin), []);
  } finally {
    for (const path of Object.values(fixture)) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

test('doctor --root checks another workspace from an unrelated cwd', () => {
  const fixture = isolated();
  try {
    createRepository(fixture.root);
    writeText(join(fixture.root, 'README.md'), '# readme\n');
    writeWorkspaceConfig(
      fixture.root,
      baseWorkspaceConfig({
        runtimeVersion: '9.8.7',
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    writeMachineConfig(
      fixture.root,
      baseMachineConfig(fixture.root, { selectedHosts: [] }),
    );
    const result = invoke(
      ['doctor', '--root', fixture.root, '--json'],
      fixture.home,
      {
        HOME: fixture.home,
        PAPPRA_DATA_HOME: fixture.data,
        PATH: fixture.bin,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '');
    const report = parse(result.stdout);
    const workspace = report.workspace;
    assert(typeof workspace === 'object' && workspace !== null);
    assert.equal((workspace as Record<string, unknown>).state, 'registered');
    const checks = report.checks;
    assert(Array.isArray(checks));
    assert(
      checks.some(
        (entry: unknown) =>
          typeof entry === 'object' &&
          entry !== null &&
          'id' in entry &&
          entry.id === 'runtime.state',
      ),
    );
  } finally {
    for (const path of Object.values(fixture)) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

test('doctor help is JSON-clean and invalid flags fail', () => {
  const fixture = isolated();
  try {
    const help = invoke(['doctor', '--help', '--json'], fixture.root, {
      HOME: fixture.home,
      PAPPRA_DATA_HOME: fixture.data,
      PATH: fixture.bin,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stderr, '');
    const helpValue = parse(help.stdout);
    assert(
      'usage' in helpValue &&
        typeof helpValue.usage === 'string' &&
        helpValue.usage.includes('pappra doctor'),
    );
    const invalid = invoke(
      ['doctor', '--config', 'x.json', '--json'],
      fixture.root,
      {
        HOME: fixture.home,
        PAPPRA_DATA_HOME: fixture.data,
        PATH: fixture.bin,
      },
    );
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stderr, '');
    const value = parse(invalid.stdout);
    assert.equal(value.ok, false);
    assert.equal(existsSync(join(fixture.root, '.pappra')), false);
  } finally {
    for (const path of Object.values(fixture)) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

test('doctor --json reports abnormal workspace journals without blocking or writing', () => {
  const fixture = isolated();
  try {
    createRepository(fixture.root);
    writeText(join(fixture.root, 'README.md'), '# readme\n');
    writeWorkspaceConfig(
      fixture.root,
      baseWorkspaceConfig({
        runtimeVersion: '9.8.7',
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    writeMachineConfig(
      fixture.root,
      baseMachineConfig(fixture.root, { selectedHosts: [] }),
    );
    const journals = join(fixture.root, '.pappra', 'local', 'journals');
    mkdirSync(journals, { recursive: true });
    symlinkSync(
      join(journals, 'missing-target'),
      join(journals, 'broken.json'),
    );
    mkdirSync(join(journals, 'directory.json'));
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [join(journals, 'fifo.json')]);
    }
    const before = snapshotTree(fixture.root);

    const result = invoke(
      ['doctor', '--root', fixture.root, '--json'],
      fixture.home,
      {
        HOME: fixture.home,
        PAPPRA_DATA_HOME: fixture.data,
        PATH: fixture.bin,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stderr, '');
    const report = parse(result.stdout);
    const checks = report.checks;
    assert(Array.isArray(checks));
    const install = checks.find(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        'id' in entry &&
        entry.id === 'install.workspace',
    ) as Record<string, unknown> | undefined;
    assert(install !== undefined);
    assert.equal(install.status, 'error');
    const summary = report.summary;
    assert(typeof summary === 'object' && summary !== null);
    assert.equal((summary as Record<string, unknown>).exitCode, 1);
    assert.deepEqual(snapshotTree(fixture.root), before);
  } finally {
    for (const path of Object.values(fixture)) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});
