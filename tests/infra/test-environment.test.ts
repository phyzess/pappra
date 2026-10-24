import assert from 'node:assert/strict';
import { devNull } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { testSubprocessEnvironment } from '../../scripts/test-environment.js';

test('test subprocesses discard inherited Pappra fault/opt-in flags and isolate Git configuration', () => {
  const keys = ['PAPPRA_FAULT', 'PAPPRA_PROVIDER_OUTAGE', 'PAPPRA_DATA_HOME'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.PAPPRA_FAULT = 'exit_before_rename';
    process.env.PAPPRA_PROVIDER_OUTAGE = '1';
    process.env.PAPPRA_DATA_HOME = '/not-a-test-home';
    const clean = testSubprocessEnvironment();
    for (const key of keys) assert.equal(clean[key], undefined);
    assert.equal(clean.GIT_CONFIG_GLOBAL, devNull);
    assert.equal(clean.GIT_CONFIG_NOSYSTEM, '1');
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify({fault:!!process.env.PAPPRA_FAULT,optIn:!!process.env.PAPPRA_PROVIDER_OUTAGE,home:!!process.env.PAPPRA_DATA_HOME}))',
      ],
      { env: clean, encoding: 'utf8', shell: false },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      fault: false,
      optIn: false,
      home: false,
    });
    assert.equal(process.env.PAPPRA_FAULT, 'exit_before_rename');
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a test case must name allowed Pappra variables before explicitly injecting them', () => {
  const overrides = {
    PAPPRA_FAULT: 'never inherit or inject implicitly',
    PAPPRA_DATA_HOME: '/test-data',
    FIXTURE_MARKER: 'explicit',
  };
  const clean = testSubprocessEnvironment(overrides, {
    allowPappra: ['PAPPRA_DATA_HOME'],
  });
  assert.equal(clean.PAPPRA_FAULT, undefined);
  assert.equal(clean.PAPPRA_DATA_HOME, '/test-data');
  assert.equal(clean.FIXTURE_MARKER, 'explicit');
});
