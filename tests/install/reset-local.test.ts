import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { applyInitPlan, planWorkspaceInit } from '../../src/app/init.js';
import { repairInstall } from '../../src/install/repair.js';
import { runDoctor } from '../../src/app/doctor.js';
import { runCli } from '../../src/cli/run.js';
import { captureProcessIdentity } from '../../src/infra/process-identity.js';
import { cleanup, makeTempDir } from './fixtures.js';
import { createRepository } from '../workspace/fixtures.js';
import { baseInitChoices } from '../init/fixtures.js';

async function initialize(root: string): Promise<void> {
  createRepository(root);
  const plan = await planWorkspaceInit({
    root,
    choices: baseInitChoices(),
    runtimeVersion: '0.1.0-dev.0',
  });
  assert(plan.ok, JSON.stringify(plan));
  assert.equal((await applyInitPlan(plan.bundle)).ok, true);
}

test('explicit fresh reset preserves copied local bytes privately and allows fresh init without migration', async () => {
  const original = realpathSync(makeTempDir('reset-source'));
  const copied = realpathSync(makeTempDir('reset-copied'));
  try {
    await initialize(original);
    writeFileSync(
      join(original, '.pappra/local/keep-secret.txt'),
      'private bytes retained exactly\n',
    );
    cpSync(original, copied, { recursive: true });
    const oldMachine = readFileSync(join(copied, '.pappra/local/machine.json'));
    const preview = await repairInstall({ root: copied, resetLocal: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.reset?.status, 'planned');
    assert.equal(existsSync(join(copied, '.pappra/local-archive')), false);
    assert.equal(
      (await repairInstall({ root: copied, resetLocal: true, apply: true })).ok,
      false,
    );
    assert.deepEqual(
      readFileSync(join(copied, '.pappra/local/machine.json')),
      oldMachine,
    );
    const result = await repairInstall({
      root: copied,
      resetLocal: true,
      allWritersStopped: true,
      apply: true,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert(result.reset?.archive);
    assert.equal(
      readFileSync(join(result.reset.archive, 'keep-secret.txt'), 'utf8'),
      'private bytes retained exactly\n',
    );
    assert.deepEqual(
      readFileSync(join(result.reset.archive, 'machine.json')),
      oldMachine,
    );
    assert.equal(
      readFileSync(join(copied, '.pappra/local/.gitignore'), 'utf8'),
      '*\n',
    );
    const plan = await planWorkspaceInit({
      root: copied,
      choices: baseInitChoices(),
      runtimeVersion: '0.1.0-dev.0',
    });
    assert(plan.ok, JSON.stringify(plan));
    assert.equal((await applyInitPlan(plan.bundle)).ok, true);
    assert.notDeepEqual(
      readFileSync(join(copied, '.pappra/local/machine.json')),
      oldMachine,
    );
    const git = spawnSync(
      'git',
      [
        'ls-files',
        '--others',
        '--exclude-standard',
        '--',
        '.pappra/local-archive',
      ],
      { cwd: copied, encoding: 'utf8' },
    );
    assert.equal(git.status, 0, git.stderr);
    assert.equal(git.stdout, '');
  } finally {
    cleanup(original);
    cleanup(copied);
  }
});

test('local reset converges after SIGKILL between archive rename and fresh state publication', async () => {
  const root = realpathSync(makeTempDir('reset-crash'));
  try {
    await initialize(root);
    writeFileSync(
      join(root, '.pappra/local/retained.txt'),
      'retain after crash',
    );
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { repairInstall } from ${JSON.stringify(import.meta.resolve('../../src/install/repair.js'))};
      await repairInstall({root:${JSON.stringify(root)},resetLocal:true,allWritersStopped:true,apply:true,afterLocalArchive:()=>process.kill(process.pid,'SIGKILL')});
      process.exit(92);
    `,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal(existsSync(join(root, '.pappra/local')), false);
    const doctor = await runDoctor({
      root,
      pathEnv: '',
      homeDir: root,
      dataDir: join(root, 'runtime-data'),
    });
    assert.equal(
      doctor.checks.find((check) => check.id === 'state.local-reset')?.status,
      'warning',
    );
    const recovered = await repairInstall({
      root,
      resetLocal: true,
      allWritersStopped: true,
      apply: true,
    });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.reset?.resumed, true);
    assert(recovered.reset?.archive);
    assert.equal(
      readFileSync(join(recovered.reset.archive, 'retained.txt'), 'utf8'),
      'retain after crash',
    );
    const again = await repairInstall({
      root,
      resetLocal: true,
      allWritersStopped: true,
      apply: true,
    });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.reset?.archive, recovered.reset.archive);
  } finally {
    cleanup(root);
  }
});

test('fresh reset refuses redirected source/archive namespaces and verified live managed owners', async (t) => {
  const root = realpathSync(makeTempDir('reset-boundary'));
  const outside = realpathSync(makeTempDir('reset-outside'));
  try {
    await initialize(root);
    const marker = join(root, '.pappra/local-archive');
    symlinkSync(outside, marker, 'dir');
    const before = readFileSync(join(root, '.pappra/local/machine.json'));
    assert.equal(
      (
        await repairInstall({
          root,
          resetLocal: true,
          allWritersStopped: true,
          apply: true,
        })
      ).ok,
      false,
    );
    assert.deepEqual(
      readFileSync(join(root, '.pappra/local/machine.json')),
      before,
    );
  } finally {
    cleanup(root);
    cleanup(outside);
  }
  const live = realpathSync(makeTempDir('reset-live-managed'));
  try {
    await initialize(live);
    const identity = captureProcessIdentity();
    if (identity === null) {
      t.diagnostic(
        'OS identity unavailable; live managed owner assertion omitted.',
      );
      return;
    }
    const directory = join(live, '.pappra/local/domain/tasks/t');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'task.json'),
      JSON.stringify({
        managed_pi_runtime_registry: [
          { pid: process.pid, process_identity: identity },
        ],
      }),
    );
    const result = await repairInstall({
      root: live,
      resetLocal: true,
      allWritersStopped: true,
      apply: true,
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(existsSync(join(live, '.pappra/local/machine.json')), true);
  } finally {
    cleanup(live);
  }
});

test('explicit reset treats PID-only imported locks as unknown and preserves them instead of adopting processes', async () => {
  const root = realpathSync(makeTempDir('reset-unknown-imported'));
  try {
    await initialize(root);
    const file = join(root, '.pappra/local/apply.lock');
    const bytes = JSON.stringify({ token: 'copied-lock', pid: process.pid });
    writeFileSync(file, bytes);
    const result = await repairInstall({
      root,
      resetLocal: true,
      allWritersStopped: true,
      apply: true,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert(result.reset?.archive);
    assert.equal(
      readFileSync(join(result.reset.archive, 'apply.lock'), 'utf8'),
      bytes,
    );
    assert.equal(result.lockStates[0]?.state, 'unknown');
  } finally {
    cleanup(root);
  }
});

test('repair CLI keeps reset preview read-only and requires the explicit stopped-writers flag for apply', async () => {
  const root = realpathSync(makeTempDir('reset-cli'));
  try {
    await initialize(root);
    let stdout = '';
    const output = {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (_text: string) => undefined,
    };
    assert.equal(
      await runCli(
        ['repair', '--root', root, '--reset-local', '--json'],
        output,
      ),
      0,
    );
    assert.equal(existsSync(join(root, '.pappra/local-archive')), false);
    stdout = '';
    assert.equal(
      await runCli(
        ['repair', '--root', root, '--reset-local', '--apply', '--json'],
        output,
      ),
      1,
    );
    assert.match(stdout, /all-writers-stopped/);
    stdout = '';
    assert.equal(
      await runCli(
        [
          'repair',
          '--root',
          root,
          '--reset-local',
          '--all-writers-stopped',
          '--apply',
          '--json',
        ],
        output,
      ),
      0,
    );
    const result = JSON.parse(stdout) as { reset: { archive: string } };
    assert.equal(existsSync(join(result.reset.archive, 'machine.json')), true);
  } finally {
    cleanup(root);
  }
});
