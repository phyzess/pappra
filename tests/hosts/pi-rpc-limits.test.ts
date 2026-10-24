import assert from 'node:assert/strict';
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startOwnedPiRpc, type PiOptions } from '../../src/hosts/pi/rpc.js';
import { runCli } from '../../src/cli/run.js';
import { launchFixture } from '../collab/launch-fixture.js';

const executable = fileURLToPath(new URL('./fake-pi.js', import.meta.url));

function options(box: ReturnType<typeof launchFixture>): PiOptions {
  chmodSync(executable, 0o755);
  return {
    ...box.options,
    profile: 'writer',
    sessionId: box.writer.session_id,
    promptFile: box.promptFile,
    evidenceDir: join(box.root, 'rpc-limits'),
    piBin: executable,
    shutdownTimeoutMs: 1000,
  };
}

function environment(t: test.TestContext, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

test('default RPC task lifetime survives the former two-minute deadline', async (t) => {
  const box = launchFixture();
  t.after(box.cleanup);
  const started = await startOwnedPiRpc(options(box));
  assert(started.ok, JSON.stringify(started));
  t.after(() => started.session.finish());
  const now = Date.now;
  const clock = t.mock.method(Date, 'now', () => now() + 180_000);
  assert.equal(
    (await started.session.query()).session_id,
    box.writer.session_id,
  );
  clock.mock.restore();
  const finished = await started.session.finish();
  const execution = JSON.parse(
    readFileSync(join(box.root, 'rpc-limits/pi-rpc.execution.json'), 'utf8'),
  );
  assert.equal(execution.limits.operation_timeout_ms, 30 * 60 * 1000);
  assert.equal(finished.transport_fatal, null);
});

test('normal settling uses the task budget independently of short cancellation settling', async (t) => {
  const box = launchFixture();
  t.after(box.cleanup);
  environment(t, { FAKE_PI_SETTLE_DELAY_MS: '150' });
  const started = await startOwnedPiRpc({
    ...options(box),
    operationTimeoutMs: 10_000,
    settleTimeoutMs: 25,
  });
  assert(started.ok, JSON.stringify(started));
  t.after(() => started.session.finish());
  await started.session.prompt();
  assert.ok(await started.session.awaitSettled());
  assert.equal((await started.session.finish()).transport_fatal, null);
});

test('large cumulative stdout keeps bounded history and explicit partial log evidence', async (t) => {
  const box = launchFixture();
  t.after(box.cleanup);
  environment(t, {
    FAKE_PI_NOISE_BYTES: String(20 * 1024 * 1024),
    FAKE_PI_ASSISTANT: '1',
  });
  const started = await startOwnedPiRpc({
    ...options(box),
    maxBytes: 8192,
    maxLogBytes: 8192,
  });
  assert(started.ok, JSON.stringify(started));
  t.after(() => started.session.finish());
  await started.session.prompt();
  // The settled event precedes the noise and must survive history eviction.
  assert.ok(await started.session.awaitSettled());
  const finished = await started.session.finish();
  assert.equal(finished.ok, true, JSON.stringify(finished));
  const execution = JSON.parse(
    readFileSync(join(box.root, 'rpc-limits/pi-rpc.execution.json'), 'utf8'),
  );
  assert.ok(execution.rpc_capture.stdout_bytes > 16 * 1024 * 1024);
  assert.ok(execution.rpc_capture.retained_bytes <= 1024 * 1024);
  assert.ok(execution.rpc_capture.retained_records <= 256);
  assert.equal(execution.rpc_capture.history_truncated, true);
  assert.equal(execution.rpc_capture.log.complete, false);
  assert.ok(execution.rpc_capture.log.omitted_records > 0);
  assert.ok(
    statSync(join(box.root, 'rpc-limits/pi-rpc.rpc.jsonl')).size <= 8192,
  );
  assert.equal(
    (finished.evidence as Record<string, unknown>).events_complete,
    false,
  );
});

test('one oversized stdout frame remains fatal and shuts down the owned child', async (t) => {
  const box = launchFixture();
  t.after(box.cleanup);
  environment(t, {
    FAKE_PI_NOISE_BYTES: '32768',
    FAKE_PI_NOISE_RECORD_BYTES: '32768',
  });
  const started = await startOwnedPiRpc({ ...options(box), maxBytes: 8192 });
  assert(started.ok, JSON.stringify(started));
  t.after(() => started.session.finish());
  await assert.rejects(started.session.prompt(), /rpc_response_too_large/);
  const finished = await started.session.finish();
  assert.equal(
    (finished.transport_fatal as Record<string, unknown>).code,
    'rpc_response_too_large',
  );
  assert.equal((finished.exit as Record<string, unknown>).parent_exited, true);
});

test('a late response to a timed-out request does not poison later query or cancellation', async (t) => {
  const box = launchFixture();
  t.after(box.cleanup);
  environment(t, {
    FAKE_PI_DELAY_STATE_NUMBER: '2',
    FAKE_PI_RESPONSE_DELAY_MS: '750',
  });
  const started = await startOwnedPiRpc({
    ...options(box),
    requestTimeoutMs: 500,
  });
  assert(started.ok, JSON.stringify(started));
  t.after(() => started.session.finish());
  await assert.rejects(started.session.query(), /rpc_response_deadline/);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(
    (await started.session.query()).session_id,
    box.writer.session_id,
  );
  assert.equal((await started.session.cancel()).native_idle, true);
  const finished = await started.session.finish();
  assert.equal(finished.transport_fatal, null);
  const execution = JSON.parse(
    readFileSync(join(box.root, 'rpc-limits/pi-rpc.execution.json'), 'utf8'),
  );
  assert.equal(execution.rpc_capture.late_responses, 1);
  assert.equal(
    finished.ok,
    false,
    'the original timeout remains recorded as an operation failure',
  );
});

test('an unknown response ID remains fatal instead of being mistaken for a late reply', async (t) => {
  const box = launchFixture();
  t.after(box.cleanup);
  environment(t, { FAKE_PI_UNEXPECTED_RESPONSE: '1' });
  const started = await startOwnedPiRpc(options(box));
  assert(started.ok, JSON.stringify(started));
  t.after(() => started.session.finish());
  await assert.rejects(started.session.prompt(), /unexpected_response_id/);
  const finished = await started.session.finish();
  assert.equal(
    (finished.transport_fatal as Record<string, unknown>).code,
    'unexpected_response_id',
  );
  assert.equal(
    (finished.evidence as Record<string, unknown>).events_complete,
    false,
  );
});

test(
  'task expiry autonomously closes an otherwise idle owned RPC child',
  { timeout: 10_000 },
  async (t) => {
    const box = launchFixture();
    t.after(box.cleanup);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const started = await startOwnedPiRpc({
      ...options(box),
      operationTimeoutMs: 750,
    });
    assert(started.ok, JSON.stringify(started));
    t.mock.timers.tick(751);
    const finished = await started.session.finish();
    assert.equal(finished.ok, false);
    assert.equal(
      (finished.exit as Record<string, unknown>).parent_exited,
      true,
    );
    assert.equal(finished.reason, 'operation_deadline');
  },
);

test('CLI RPC deadlines reject invalid ranges and unrelated commands before launch', async () => {
  for (const args of [
    [
      'collab',
      'run',
      '--controller',
      'pi-rpc',
      '--rpc-operation-timeout-ms',
      '86400001',
    ],
    [
      'collab',
      'run',
      '--controller',
      'pi-rpc',
      '--rpc-request-timeout-ms',
      '0',
    ],
    [
      'collab',
      'run',
      '--controller',
      'fixture',
      '--rpc-operation-timeout-ms',
      '600000',
    ],
    ['doctor', '--rpc-operation-timeout-ms', '600000'],
  ]) {
    const output: string[] = [];
    assert.equal(
      await runCli(args, {
        stdout: (text) => output.push(text),
        stderr: (text) => output.push(text),
      }),
      2,
    );
    assert.match(output.join(''), /rpc-.*timeout-ms/);
  }
});
