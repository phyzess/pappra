import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { PiOptions } from '../../src/hosts/pi/rpc.js';
import { implementation } from './implementations.js';
const { startOwnedPiRpc } = await implementation('pi');
import { readRecord } from '../../src/collab/store.js';
import { launchFixture } from '../collab/launch-fixture.js';

test(
  'Pi retains one owned RPC identity across queries, frozen prompt and cancellation',
  { timeout: 15_000 },
  async () => {
    const box = launchFixture();
    const executable = fileURLToPath(new URL('./fake-pi.js', import.meta.url));
    chmodSync(executable, 0o755);
    const options: PiOptions = {
      ...box.options,
      profile: 'writer',
      promptFile: box.promptFile,
      evidenceDir: join(box.root, 'evidence'),
      sessionId: box.writer.session_id,
      piBin: executable,
      requestTimeoutMs: 3000,
      operationTimeoutMs: 10_000,
      shutdownTimeoutMs: 1000,
      settleTimeoutMs: 3000,
    };
    const started = await startOwnedPiRpc(options);
    try {
      assert(started.ok, JSON.stringify(started));
      const session = started.session;
      assert.equal(
        (await session.query())['session_id'],
        box.writer.session_id,
      );
      assert.equal((await session.query())['header_bound'], true);
      await session.prompt();
      await session.awaitSettled();
      const cancelled = await session.cancel();
      assert.equal(cancelled['native_idle'], true);
      assert(cancelled['agent_settled']);
      const finished = await session.finish();
      assert.equal(finished.outcome, 'exited');
      assert.equal(finished.ok, true);
      assert.equal(await session.finalize(), finished);
      const record = readRecord(box.taskRoot);
      assert.equal(
        record?.attempts[0]?.native.session_id,
        box.writer.session_id,
      );
      assert.equal(
        record?.launch_reservations?.[0]?.released_at !== null,
        true,
      );
      assert.equal(record?.claims[0]?.released_at, null);
      assert.equal(record?.claims[0]?.cancel_pending, true);
    } finally {
      if (started.ok) await started.session.finish();
      box.cleanup();
    }
  },
);
