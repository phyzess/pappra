import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { captureProcessIdentity } from '../../src/infra/process-identity.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

const cli = new URL('../../../../dist/cli/main.js', import.meta.url);
const version = '9.8.7';
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pappra-archive-cli-')));
  const dataDir = join(root, 'data');
  const runtime = join(dataDir, 'runtimes', version);
  mkdirSync(runtime, { recursive: true });
  writeFileSync(
    join(runtime, 'install-manifest.json'),
    '{"schema":"pappra/runtime-manifest/1","raw":"legacy"}',
  );
  return { root, dataDir, runtime };
}
function invoke(root: string, dataDir: string, args: string[]) {
  const run = spawnSync(
    process.execPath,
    [cli.pathname, 'runtime', 'archive', ...args, '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PAPPRA_DATA_HOME: dataDir },
      shell: false,
    },
  );
  assert.ifError(run.error);
  const value = JSON.parse(run.stdout) as {
    ok: boolean;
    status: string;
    mode: string;
    archive: string;
    resumed: boolean;
    blockers: string[];
    errors: string[];
    message: string;
  };
  return { ...run, value };
}
const target = ['--runtime-version', version];
const apply = [
  ...target,
  '--apply',
  '--force',
  '--reason',
  'Operator reviewed old beta state',
];

test('actual CLI cannot archive the runtime package it is executing from, even with both force policies', () => {
  const { root, dataDir, runtime } = fixture();
  try {
    cpSync(
      new URL('../../../../dist/', import.meta.url),
      join(runtime, 'dist'),
      { recursive: true },
    );
    cpSync(
      new URL('../../../../package.json', import.meta.url),
      join(runtime, 'package.json'),
    );
    symlinkSync(
      fileURLToPath(new URL('../../../../node_modules/', import.meta.url)),
      join(runtime, 'node_modules'),
      'dir',
    );
    const run = spawnSync(
      process.execPath,
      [
        join(runtime, 'dist/cli/main.js'),
        'runtime',
        'archive',
        ...apply,
        '--all-writers-stopped',
        '--json',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, PAPPRA_DATA_HOME: dataDir },
        shell: false,
      },
    );
    assert.ifError(run.error);
    assert.equal(run.status, 1, `${run.stdout} ${run.stderr}`);
    const value = JSON.parse(run.stdout) as { blockers: string[] };
    assert(
      value.blockers.some((message) => message.includes('executing package')),
    );
    assert.equal(existsSync(runtime), true);
    assert.equal(existsSync(join(dataDir, 'runtime-archives')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual CLI previews, refuses implicit selection/coverage, archives legacy bytes and repeats idempotently', () => {
  const { root, dataDir, runtime } = fixture();
  try {
    const plan = invoke(root, dataDir, target);
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(plan.value.mode, 'plan');
    assert(plan.value.blockers.some((message) => message.includes('--force')));
    assert.equal(existsSync(join(dataDir, 'runtime-archives')), false);
    const invalid = invoke(root, dataDir, ['--apply', '--force']);
    assert.equal(invalid.status, 2);
    const noAcceptance = invoke(root, dataDir, [
      ...target,
      '--apply',
      '--reason',
      'review',
    ]);
    assert.equal(noAcceptance.status, 1);
    assert.equal(noAcceptance.value.status, 'blocked');
    const archived = invoke(root, dataDir, apply);
    assert.equal(archived.status, 0, JSON.stringify(archived.value));
    assert.equal(archived.value.status, 'archived');
    assert.equal(existsSync(runtime), false);
    assert.equal(
      readFileSync(
        join(archived.value.archive, 'runtime/install-manifest.json'),
        'utf8',
      ),
      '{"schema":"pappra/runtime-manifest/1","raw":"legacy"}',
    );
    const repeat = invoke(root, dataDir, apply);
    assert.equal(repeat.status, 0, JSON.stringify(repeat.value));
    assert.equal(repeat.value.archive, archived.value.archive);
    assert.equal(repeat.value.resumed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual CLI protects a local unregistered binding and refuses invalid paths and install flags', () => {
  const { root, dataDir, runtime } = fixture();
  try {
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    writeMachineConfig(
      root,
      baseMachineConfig(root, {
        runtime: {
          version,
          executable: join(runtime, 'cli.js'),
          verifiedAt: '2026-10-25T00:00:00.000Z',
        },
      }),
    );
    const blocked = invoke(root, dataDir, [...apply, '--all-writers-stopped']);
    assert.equal(blocked.status, 1, blocked.stderr);
    assert(
      blocked.value.blockers.some((message) =>
        message.includes('Verified workspace'),
      ),
    );
    assert.equal(existsSync(runtime), true);
    assert.equal(existsSync(join(dataDir, 'runtime-archives')), false);
    for (const args of [
      ['--runtime-version', '../escape', '--apply', '--force'],
      [...target, '--bind'],
      [...target, '--runtime-version', 'other'],
      [...target, '--install-id', '../escape'],
    ]) {
      const invalid = invoke(root, dataDir, args);
      assert.notEqual(invalid.status, 0, JSON.stringify(invalid.value));
      assert.equal(existsSync(runtime), true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual CLI never bypasses a verified live lock; unknown raw locks require explicit stopped writers', (t) => {
  const { root, dataDir, runtime } = fixture();
  try {
    const locks = join(dataDir, 'runtimes/.locks');
    mkdirSync(locks);
    const lock = join(locks, `${version}.lock`);
    const identity = captureProcessIdentity();
    if (identity) {
      writeFileSync(
        lock,
        JSON.stringify({
          token: randomUUID(),
          pid: process.pid,
          process_identity: identity,
        }),
      );
      const live = invoke(root, dataDir, [...apply, '--all-writers-stopped']);
      assert.equal(live.status, 1, live.stderr);
      assert(
        live.value.blockers.some((message) => message.includes('live lock')),
      );
    } else {
      t.diagnostic('OS process identity unavailable in this environment.');
    }
    writeFileSync(lock, 'legacy unknown lock');
    const unknown = invoke(root, dataDir, apply);
    assert.equal(unknown.status, 1);
    assert.equal(existsSync(runtime), true);
    const archived = invoke(root, dataDir, [...apply, '--all-writers-stopped']);
    assert.equal(archived.status, 0, JSON.stringify(archived.value));
    assert.equal(
      readFileSync(join(archived.value.archive, 'original.lock'), 'utf8'),
      'legacy unknown lock',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
