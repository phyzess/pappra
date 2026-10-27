import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  readUsageObservation,
  usageObservationPath,
} from '../../src/usage/observation.js';
import {
  decodeChain,
  encodeChain,
  runChainedCommand,
  runStatuslineBeacon,
} from '../../src/usage/statusline-beacon.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

const NOW = new Date('2026-10-27T06:00:00.000Z');
const SESSION = 'bf4725b6-48d0-4410-8a62-7716b13c1345';
const payload = (percent: number | null = 7) =>
  JSON.stringify({
    session_id: SESSION,
    version: '2.1.308',
    context_window: {
      total_input_tokens: 70000,
      context_window_size: 1000000,
      used_percentage: percent,
    },
  });

test('beacon records usage and prints its own short line when nothing is chained', async () => {
  const dir = makeTempDir('beacon');
  try {
    const result = await runStatuslineBeacon(payload(), null, {
      dataDir: dir,
      now: () => NOW,
    });
    assert.equal(result.stdout, 'ctx 7%');
    assert.equal(result.exitCode, 0);
    assert.equal(result.note, null);
    const read = readUsageObservation(dir, 'claude', SESSION, { now: NOW });
    assert.equal(read.state, 'available');
  } finally {
    cleanup(dir);
  }
});

test('beacon passes the chained command output and exit code through unchanged', async () => {
  const dir = makeTempDir('beacon-chain');
  try {
    const seen: { command: string; stdin: string }[] = [];
    const result = await runStatuslineBeacon(payload(), 'user-statusline', {
      dataDir: dir,
      now: () => NOW,
      runChain: async (command, stdin) => {
        seen.push({ command, stdin });
        return { stdout: 'my own status\n', exitCode: 3 };
      },
    });
    assert.equal(result.stdout, 'my own status\n');
    assert.equal(result.exitCode, 3);
    assert.deepEqual(seen, [{ command: 'user-statusline', stdin: payload() }]);
    assert.equal(
      existsSync(usageObservationPath(dir, 'claude', SESSION)),
      true,
    );
  } finally {
    cleanup(dir);
  }
});

test('beacon never disturbs the host: bad payloads and write failures are swallowed', async () => {
  const dir = makeTempDir('beacon-fail');
  try {
    const chained = async () => ({ stdout: 'kept', exitCode: 0 });
    const notJson = await runStatuslineBeacon('{ nope', 'c', {
      dataDir: dir,
      runChain: chained,
    });
    assert.equal(notJson.stdout, 'kept');
    assert.equal(notJson.note, 'payload_not_json');

    const early = await runStatuslineBeacon(payload(null), null, {
      dataDir: dir,
      now: () => NOW,
    });
    assert.equal(early.stdout, '', 'null percentage is not observable yet');
    assert.equal(early.note, 'no_usage_in_payload');
    assert.equal(
      existsSync(usageObservationPath(dir, 'claude', SESSION)),
      false,
    );

    const unwritable = await runStatuslineBeacon(payload(), 'c', {
      dataDir: '/dev/null/not-a-dir',
      now: () => NOW,
      runChain: chained,
    });
    assert.equal(unwritable.stdout, 'kept');
    assert.equal(unwritable.note, 'write_failed');

    const throwing = await runStatuslineBeacon(payload(), 'c', {
      dataDir: dir,
      now: () => NOW,
      runChain: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(throwing.exitCode, 1);
    assert.equal(throwing.note, 'chain_failed');

    const huge = await runStatuslineBeacon('x'.repeat(1024 * 1024 + 1), null, {
      dataDir: dir,
    });
    assert.equal(huge.note, 'payload_too_large');
  } finally {
    cleanup(dir);
  }
});

test('chained command runs with the payload on stdin, is bounded in time, and cannot be altered by quoting', async () => {
  const echoed = await runChainedCommand('cat', 'hello payload');
  assert.deepEqual(echoed, { stdout: 'hello payload', exitCode: 0 });
  const failing = await runChainedCommand('exit 5', '');
  assert.equal(failing.exitCode, 5);
  const slow = await runChainedCommand('sleep 5', '', 150);
  assert.equal(slow.exitCode, 1, 'a hung command is killed at the deadline');

  const tricky = `printf '%s' "it's \\"quoted\\" $HOME; echo injected"`;
  assert.equal(decodeChain(encodeChain(tricky)), tricky);
  assert.equal(decodeChain(undefined), null);
  assert.equal(decodeChain(''), null);
  assert.equal(decodeChain('not base64 !!'), null);
  assert.equal(decodeChain(encodeChain('a\u0000b')), null);
});

test('the compiled entry records usage and relays the chained command through a real process', () => {
  const dir = makeTempDir('beacon-entry');
  try {
    const entry = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../src/hosts/claude/statusline-entry.js',
    );
    const run = spawnSync(
      process.execPath,
      [
        entry,
        '--chain-base64',
        encodeChain('cat >/dev/null; printf chained-line'),
      ],
      {
        input: payload(),
        encoding: 'utf8',
        env: { ...process.env, PAPPRA_DATA_HOME: dir },
        timeout: 20_000,
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'chained-line');
    const stored = JSON.parse(
      readFileSync(usageObservationPath(dir, 'claude', SESSION), 'utf8'),
    ) as { used_percent: number };
    assert.equal(stored.used_percent, 7);

    const bare = spawnSync(process.execPath, [entry], {
      input: payload(12),
      encoding: 'utf8',
      env: { ...process.env, PAPPRA_DATA_HOME: dir },
      timeout: 20_000,
    });
    assert.equal(bare.stdout, 'ctx 12%');
  } finally {
    cleanup(dir);
  }
});

test('a hung pipeline is killed as a group, so the host is not left waiting on an orphan', async () => {
  const script = `
    import { runChainedCommand } from ${JSON.stringify(
      new URL('../../src/usage/statusline-beacon.js', import.meta.url).href,
    )};
    const started = Date.now();
    const result = await runChainedCommand('sleep 6 | cat; printf done', '', 200);
    console.log(JSON.stringify({ ...result, resolvedMs: Date.now() - started }));
  `;
  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
  const wall = Date.now() - started;
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout) as { exitCode: number; stdout: string };
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, '');
  assert.ok(
    wall < 3000,
    `the whole process exited in ${String(wall)} ms, not after the orphan`,
  );
});

test('a command that finishes keeps its own exit code', async () => {
  assert.equal((await runChainedCommand('exit 3', '')).exitCode, 3);
  assert.equal((await runChainedCommand('exit 0', '')).exitCode, 0);
});

function runEntry(
  input: Buffer | string,
  args: string[],
  dir: string,
  delayedTail?: { after: number; tail: string },
) {
  const entry = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../src/hosts/claude/statusline-entry.js',
  );
  return new Promise<{ stdout: string; status: number | null; ms: number }>(
    (resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [entry, ...args], {
        env: { ...process.env, PAPPRA_DATA_HOME: dir },
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('close', (status) =>
        resolve({ stdout, status, ms: Date.now() - started }),
      );
      child.stdin.on('error', () => undefined);
      if (delayedTail === undefined) child.stdin.end(input);
      else {
        child.stdin.write(input);
        setTimeout(() => child.stdin.end(delayedTail.tail), delayedTail.after);
      }
    },
  );
}

test('the chained command receives the payload as sent, including a payload over 1 MiB', async () => {
  const dir = makeTempDir('beacon-big');
  try {
    const big = JSON.stringify({
      session_id: SESSION,
      pad: 'x'.repeat(1024 * 1024 + 10),
    });
    const counted = await runEntry(
      big,
      ['--chain-base64', encodeChain('wc -c | tr -d " "')],
      dir,
    );
    assert.equal(counted.status, 0);
    assert.equal(Number(counted.stdout.trim()), Buffer.byteLength(big));
    assert.equal(
      existsSync(usageObservationPath(dir, 'claude', SESSION)),
      false,
      'no usage is recorded from an out-of-bounds payload',
    );
  } finally {
    cleanup(dir);
  }
});

test('a stdin that stays open past the wait is cut once and later bytes never reach the chain', async () => {
  const dir = makeTempDir('beacon-late');
  try {
    const head = '{"session_id":"s1","version":"1","co';
    const result = await runEntry(
      head,
      ['--chain-base64', encodeChain('cat')],
      dir,
      {
        after: 2600,
        tail: 'ntext_window":{}}',
      },
    );
    assert.equal(
      result.stdout,
      head,
      'the chain got exactly what had arrived at the deadline',
    );
  } finally {
    cleanup(dir);
  }
});

test('an undecodable chain is reported instead of silently replaced by the beacon line', async () => {
  const dir = makeTempDir('beacon-badchain');
  try {
    const result = await runEntry(
      payload(),
      ['--chain-base64', 'not base64 !!'],
      dir,
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /status-line chain is invalid/);
  } finally {
    cleanup(dir);
  }
});
