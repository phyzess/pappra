import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  existsSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { repairInstall } from '../../src/install/repair.js';
import { applyInitPlan, planWorkspaceInit } from '../../src/app/init.js';
import {
  publishPrivateLock,
  inspectPrivateLock,
} from '../../src/infra/private-lock.js';
import { captureProcessIdentity } from '../../src/infra/process-identity.js';
import { runDoctor } from '../../src/app/doctor.js';
import { cleanup, makeTempDir } from './fixtures.js';
import { createRepository } from '../workspace/fixtures.js';
import { baseInitChoices } from '../init/fixtures.js';

test('repair preserves a file created before journal identity and fresh init reuses it', async () => {
  const root = realpathSync(makeTempDir('repair-unproven-crash'));
  try {
    createRepository(root);
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { planWorkspaceInit, applyInitPlan } from ${JSON.stringify(import.meta.resolve('../../src/app/init.js'))};
      const plan = await planWorkspaceInit({root:${JSON.stringify(root)}, choices:${JSON.stringify(baseInitChoices())},runtimeVersion:'0.1.0-dev.0'});
      if (!plan.ok) process.exit(90);
      await applyInitPlan(plan.bundle,{afterWrite:(file)=>{if(file==='.pappra/workspace.json')process.kill(process.pid,'SIGKILL')}});
      process.exit(91);
    `,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const file = join(root, '.pappra/workspace.json');
    const retained = readFileSync(file);
    const nested = join(root, 'src/nested');
    mkdirSync(nested, { recursive: true });
    const preview = await repairInstall({ root: nested });
    assert.equal(preview.entries.length, 1);
    assert.deepEqual(readFileSync(file), retained);
    const repaired = await repairInstall({ root: nested, apply: true });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.deepEqual(repaired.preserved, ['.pappra/workspace.json']);
    assert.deepEqual(readFileSync(file), retained);
    const retry = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
      runtimeVersion: '0.1.0-dev.0',
    });
    assert(retry.ok, JSON.stringify(retry));
    assert.equal((await applyInitPlan(retry.bundle)).ok, true);
    assert.deepEqual(readFileSync(file), retained);
    assert.equal((await repairInstall({ root })).entries.length, 0);
  } finally {
    cleanup(root);
  }
});

test('doctor and repair detect and recover crashed knowledge and checkpoint lock owners', async () => {
  const root = realpathSync(makeTempDir('repair-dead-writers'));
  try {
    createRepository(root);
    const plan = await planWorkspaceInit({
      root,
      choices: baseInitChoices(),
      runtimeVersion: '0.1.0-dev.0',
    });
    assert(plan.ok);
    assert.equal((await applyInitPlan(plan.bundle)).ok, true);
    const files = ['knowledge/apply.lock', 'tasks/work/checkpoint.lock'].map(
      (name) => join(root, '.pappra/local', name),
    );
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { mkdir } from 'node:fs/promises'; import { dirname } from 'node:path'; import { randomUUID } from 'node:crypto';
      import { publishPrivateLock } from ${JSON.stringify(import.meta.resolve('../../src/infra/private-lock.js'))};
      import { captureProcessIdentity } from ${JSON.stringify(import.meta.resolve('../../src/infra/process-identity.js'))};
      for(const file of ${JSON.stringify(files)}){await mkdir(dirname(file),{recursive:true}); await publishPrivateLock(file,Buffer.from(JSON.stringify({token:randomUUID(),pid:process.pid,process_identity:captureProcessIdentity()})));}
      process.kill(process.pid,'SIGKILL');
    `,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const doctor = await runDoctor({
      root,
      pathEnv: '',
      dataDir: join(root, 'runtime-data'),
      homeDir: root,
    });
    assert.equal(
      doctor.checks.find((check) => check.id === 'state.writer-locks')?.status,
      'warning',
    );
    const preview = await repairInstall({ root });
    assert.equal(
      preview.lockStates.filter((state) => state.state === 'dead').length,
      2,
    );
    assert(files.every(existsSync));
    const results = await Promise.all([
      repairInstall({ root, apply: true }),
      repairInstall({ root, apply: true }),
    ]);
    assert(
      results.some((result) => result.ok),
      JSON.stringify(results),
    );
    assert(files.every((file) => !existsSync(file)));
    assert.equal((await repairInstall({ root, apply: true })).ok, true);
  } finally {
    cleanup(root);
  }
});

test('an interrupted atomic lock publication never leaves an empty named lock', async () => {
  const root = realpathSync(makeTempDir('repair-atomic-lock'));
  const file = join(root, 'apply.lock');
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { publishPrivateLock } from ${JSON.stringify(import.meta.resolve('../../src/infra/private-lock.js'))};
      await publishPrivateLock(${JSON.stringify(file)},Buffer.from('complete owner record'),async()=>{process.kill(process.pid,'SIGKILL')});
    `,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal(existsSync(file), false);
    await publishPrivateLock(
      file,
      Buffer.from(
        JSON.stringify({
          token: 'new-owner',
          pid: process.pid,
          process_identity: captureProcessIdentity(),
        }),
      ),
    );
    assert.equal((await inspectPrivateLock(file)).state, 'alive');
  } finally {
    cleanup(root);
  }
});

test('unknown empty locks require explicit stopped-writers quarantine and preserve exact evidence', async () => {
  const root = realpathSync(makeTempDir('repair-empty-lock'));
  try {
    const file = join(root, '.pappra/local/apply.lock');
    mkdirSync(join(root, '.pappra/local'), { recursive: true });
    writeFileSync(file, '');
    const refused = await repairInstall({ root, apply: true });
    assert.equal(refused.ok, false);
    assert.equal(existsSync(file), true);
    const repaired = await repairInstall({
      root,
      apply: true,
      quarantineUnownedLocks: true,
    });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(repaired.quarantined.length, 1);
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(repaired.quarantined[0]!, 'utf8'), '');
    const receipt = JSON.parse(
      readFileSync(`${repaired.quarantined[0]}.json`, 'utf8'),
    ) as { owner_death_proven: boolean };
    assert.equal(receipt.owner_death_proven, false);
    assert.equal((await repairInstall({ root, apply: true })).ok, true);
  } finally {
    cleanup(root);
  }
});

test('quarantine refuses live owners and redirected quarantine paths', async () => {
  const root = realpathSync(makeTempDir('repair-quarantine-boundary'));
  const outside = realpathSync(makeTempDir('repair-quarantine-outside'));
  try {
    const local = join(root, '.pappra/local');
    mkdirSync(local, { recursive: true });
    const file = join(local, 'apply.lock');
    const bytes = Buffer.from(
      JSON.stringify({
        token: 'live',
        pid: process.pid,
        process_identity: captureProcessIdentity(),
      }),
    );
    writeFileSync(file, bytes);
    assert.equal(
      (await repairInstall({ root, apply: true, quarantineUnownedLocks: true }))
        .ok,
      false,
    );
    assert.deepEqual(readFileSync(file), bytes);
    writeFileSync(file, 'malformed evidence');
    symlinkSync(outside, join(local, 'lock-quarantine'), 'dir');
    assert.equal(
      (await repairInstall({ root, apply: true, quarantineUnownedLocks: true }))
        .ok,
      false,
    );
    assert.equal(readFileSync(file, 'utf8'), 'malformed evidence');
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('inconsistent PID and process birth metadata is unknown, never dead-owner evidence', async (t) => {
  const identity = captureProcessIdentity();
  if (identity === null) {
    t.skip('OS process birth identity unavailable');
    return;
  }
  const root = realpathSync(makeTempDir('repair-inconsistent-owner'));
  try {
    const file = join(root, 'lock');
    await publishPrivateLock(
      file,
      Buffer.from(
        JSON.stringify({
          token: 'inconsistent',
          pid: process.pid + 1,
          process_identity: identity,
        }),
      ),
    );
    assert.equal((await inspectPrivateLock(file)).state, 'unknown');
  } finally {
    cleanup(root);
  }
});
