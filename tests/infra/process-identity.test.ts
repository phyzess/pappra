import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import {
  captureProcessIdentity,
  isLocalProcessIdentity,
  observeProcessIdentity,
} from '../../src/infra/process-identity.js';

test('local process identity distinguishes a live owner, reboot, reuse and remote machine', () => {
  const self = captureProcessIdentity();
  assert(self, 'the supported OS must report machine, boot and birth identity');
  assert(isLocalProcessIdentity(self));
  assert.equal(observeProcessIdentity(self), 'alive');
  assert.equal(
    observeProcessIdentity({ ...self, boot: `sha256:${'0'.repeat(64)}` }),
    'dead',
  );
  assert.equal(
    observeProcessIdentity({ ...self, start: `${self.start}-different` }),
    'dead',
  );
  assert.equal(
    observeProcessIdentity({ ...self, machine: `sha256:${'0'.repeat(64)}` }),
    'unknown',
  );
  assert.equal(
    observeProcessIdentity({ ...self, namespace: 'pid:[999999999]' }),
    'unknown',
  );
  assert.equal(observeProcessIdentity({ pid: self.pid }), 'unknown');
  assert.equal(
    observeProcessIdentity({ ...self, boot: 'malformed' }),
    'unknown',
  );
});

test('a killed real child process is reported dead without an age lease', async () => {
  const child = spawn(
    process.execPath,
    ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  try {
    await once(child.stdout!, 'data');
    const identity = captureProcessIdentity(child.pid);
    assert(identity);
    assert.equal(observeProcessIdentity(identity), 'alive');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    assert.equal(observeProcessIdentity(identity), 'dead');
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  }
});
