import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { devNull, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  isolatedTestSuiteEnvironment,
  testSubprocessEnvironment,
} from '../../scripts/test-environment.js';

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

test('the default suite refuses the real home and drops ambient Herdr routes', (t) => {
  const actualHome = realpathSync(homedir());
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'pappra-test-env-')));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const redirected = join(fixture, 'redirected-home');
  symlinkSync(actualHome, redirected, 'junction');
  assert.throws(
    () => isolatedTestSuiteEnvironment(actualHome),
    /outside the real home/,
  );
  assert.throws(
    () => isolatedTestSuiteEnvironment(redirected),
    /outside the real home/,
  );

  const oldSocket = process.env['HERDR_SOCKET_PATH'];
  const oldPane = process.env['HERDR_PANE_ID'];
  process.env['HERDR_SOCKET_PATH'] = join(actualHome, 'ambient-herdr.sock');
  process.env['HERDR_PANE_ID'] = 'w1:p2';
  try {
    const env = isolatedTestSuiteEnvironment(fixture);
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `const { spawnSync } = require('node:child_process');
        const { homedir } = require('node:os');
        const { env } = process;
        const herdr = spawnSync(env.HERDR_BIN_PATH, ['agent', 'list']);
        console.log(JSON.stringify({
          home: homedir(),
          config: env.XDG_CONFIG_HOME,
          socket: env.HERDR_SOCKET_PATH,
          pane: env.HERDR_PANE_ID ?? null,
          spawnError: herdr.error?.code,
        }));`,
      ],
      { env, encoding: 'utf8', shell: false },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      home: fixture,
      config: join(fixture, 'config'),
      socket: join(fixture, 'disabled-herdr.sock'),
      pane: null,
      spawnError: 'ENOENT',
    });
  } finally {
    if (oldSocket === undefined) delete process.env['HERDR_SOCKET_PATH'];
    else process.env['HERDR_SOCKET_PATH'] = oldSocket;
    if (oldPane === undefined) delete process.env['HERDR_PANE_ID'];
    else process.env['HERDR_PANE_ID'] = oldPane;
  }
});
