import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { PiOptions } from '../../src/hosts/pi/rpc.js';
import { implementation } from './implementations.js';
const { startOwnedPiRpc } = await implementation('pi');
import { readRecord, transact } from '../../src/collab/store.js';
import { launchFixture } from '../collab/launch-fixture.js';
import { readMessageFromTaskRoot } from '../../src/app/collab-messages.js';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import type {
  CancellationIntentReference,
  Identity,
} from '../../src/collab/types.js';

function createCancelMessage(
  box: ReturnType<typeof launchFixture>,
  options: {
    readonly from?: Identity;
    readonly to?: Identity;
    readonly ownerEpoch?: number;
  } = {},
) {
  const coordinator: Identity = {
    agent_id: box.assignment.coordinator.agent_id,
    session_id: box.assignment.coordinator.session_id,
    harness: box.assignment.coordinator.harness ?? null,
  };
  const assignee: Identity = {
    agent_id: box.assignment.assignee.agent_id,
    session_id: box.assignment.assignee.session_id,
    harness: box.assignment.assignee.harness ?? null,
  };
  const message = buildMessage({
    type: 'CANCEL',
    task_id: box.assignment.task_id,
    from: options.from ?? coordinator,
    to: options.to ?? assignee,
    subtask_id: box.assignment.assignment_id,
    attempt: box.assignment.attempt,
    owner_epoch: options.ownerEpoch ?? box.assignment.coordinator.owner_epoch,
    body: { reason: 'fixture cancellation intent' },
  });
  const submitted = submitMessage(box.taskRoot, message);
  if (!submitted.ok) {
    throw new Error(`Could not register fixture CANCEL: ${submitted.reason}`);
  }
  return message;
}

async function cancellationIntentReference(
  box: ReturnType<typeof launchFixture>,
  message: ReturnType<typeof createCancelMessage>,
) {
  const result = await readMessageFromTaskRoot(
    box.taskRoot,
    message.message_id,
  );
  if (!result.ok) {
    throw new Error(`Could not read fixture CANCEL: ${result.code}`);
  }
  if (result.value.entry?.state !== 'applied')
    throw new Error('Fixture CANCEL was not applied to the task record.');
  const contentDigest = result.value.message.content_digest;
  if (contentDigest === null)
    throw new Error('Registered fixture CANCEL has no content digest.');
  return {
    reference: {
      messageId: message.message_id,
      contentDigest,
      fileDigest: result.value.digest,
    } satisfies CancellationIntentReference,
    messagePath: result.value.messagePath,
  };
}

async function startTracedPiHandle(
  box: ReturnType<typeof launchFixture>,
  label: string,
) {
  const previousTrace = process.env['FAKE_PI_TRACE'];
  const trace = join(box.root, `${label}.rpc.jsonl`);
  process.env['FAKE_PI_TRACE'] = trace;
  const executable = fileURLToPath(new URL('./fake-pi.js', import.meta.url));
  chmodSync(executable, 0o755);
  try {
    const started = await startOwnedPiRpc({
      ...box.options,
      sessionId: box.writer.session_id,
      profile: 'writer',
      promptFile: box.promptFile,
      evidenceDir: join(box.root, `${label}-evidence`),
      piBin: executable,
      requestTimeoutMs: 3000,
      operationTimeoutMs: 10_000,
      shutdownTimeoutMs: 1000,
      settleTimeoutMs: 3000,
    });
    if (!started.ok) {
      throw new Error(`Fake Pi refused: ${JSON.stringify(started)}`);
    }
    return {
      session: started.session,
      trace,
      restoreTrace: () => {
        if (previousTrace === undefined) delete process.env['FAKE_PI_TRACE'];
        else process.env['FAKE_PI_TRACE'] = previousTrace;
      },
    };
  } catch (error) {
    if (previousTrace === undefined) delete process.env['FAKE_PI_TRACE'];
    else process.env['FAKE_PI_TRACE'] = previousTrace;
    throw error;
  }
}

function cancellationMessages(taskRoot: string) {
  return (readRecord(taskRoot)?.messages ?? []).filter(
    (message) => message.type === 'CANCEL',
  );
}

function tracedRequestCount(trace: string, type: string): number {
  return readFileSync(trace, 'utf8')
    .split('\n')
    .filter((line) => {
      if (!line) return false;
      try {
        const request = JSON.parse(line) as { type?: unknown };
        return request.type === type;
      } catch {
        return false;
      }
    }).length;
}

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
      const cancelMessages = (record?.messages ?? []).filter(
        (message) => message.type === 'CANCEL',
      );
      assert.equal(cancelMessages.length, 1);
      assert.equal(
        cancelled['cancel_message_id'],
        cancelMessages[0]?.message_id,
      );
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

test('Pi cancel rejects bad intents before native side effects', async () => {
  const assertRejected = async (
    label: string,
    expectedCode: string,
    createReference: (
      box: ReturnType<typeof launchFixture>,
    ) => Promise<CancellationIntentReference>,
  ) => {
    const box = launchFixture();
    const handle = await startTracedPiHandle(box, `intent-${label}`);
    try {
      const intent = await createReference(box);
      const before = cancellationMessages(box.taskRoot).length;
      await assert.rejects(
        handle.session.cancel({ intent }),
        (error: unknown) =>
          error instanceof Error && error.message === expectedCode,
      );
      assert.equal(cancellationMessages(box.taskRoot).length, before);
      assert.equal(tracedRequestCount(handle.trace, 'clear_queue'), 0);
      assert.equal(tracedRequestCount(handle.trace, 'abort'), 0);
    } finally {
      await handle.session.finish();
      handle.restoreTrace();
      box.cleanup();
    }
  };

  await assertRejected('missing', 'cancel_intent_not_registered', async () => ({
    messageId: 'msg-c9-missing-intent',
    contentDigest: `sha256:${'0'.repeat(64)}`,
    fileDigest: `sha256:${'0'.repeat(64)}`,
  }));
  await assertRejected(
    'invalid',
    'cancel_intent_reference_invalid',
    async () => ({
      messageId: 'msg-c9-invalid-intent',
      contentDigest: 'not-a-digest',
      fileDigest: `sha256:${'0'.repeat(64)}`,
    }),
  );
  await assertRejected('foreign', 'cancel_intent_mismatch', async (box) => {
    const message = createCancelMessage(box, {
      from: {
        agent_id: 'foreign-agent',
        session_id: 'foreign-session',
        harness: 'codex',
      },
      to: {
        agent_id: 'other-agent',
        session_id: 'other-session',
        harness: 'claude',
      },
    });
    return (await cancellationIntentReference(box, message)).reference;
  });
  await assertRejected('tampered', 'cancel_intent_mismatch', async (box) => {
    const message = createCancelMessage(box);
    const reference = await cancellationIntentReference(box, message);
    const envelope = JSON.parse(
      readFileSync(reference.messagePath, 'utf8'),
    ) as Record<string, unknown>;
    (envelope.body as Record<string, unknown>).reason =
      'tampered after registration';
    writeFileSync(
      reference.messagePath,
      `${JSON.stringify(envelope, null, 2)}\n`,
    );
    return reference.reference;
  });
  await assertRejected('stale', 'stale_epoch', async (box) => {
    const message = createCancelMessage(box);
    const reference = await cancellationIntentReference(box, message);
    const changed = transact(box.taskRoot, {
      actor: 'fixture',
      purpose: 'change-owner-epoch-before-cancel',
      apply: (record) => {
        if (!record.coordinator)
          throw new Error('Fixture coordinator is missing.');
        record.coordinator.owner_epoch += 1;
        return { record, op: 'change-owner-epoch', summary: {} };
      },
    });
    assert.equal(changed.ok, true);
    return reference.reference;
  });
});

test(
  'owned Pi abort failure retains cancellation intent and uncertainty',
  { timeout: 15_000 },
  async () => {
    const box = launchFixture();
    const previousFailure = process.env['FAKE_PI_FAIL_COMMAND'];
    process.env['FAKE_PI_FAIL_COMMAND'] = 'abort';
    let handle: Awaited<ReturnType<typeof startTracedPiHandle>> | undefined;
    try {
      const pi = await startTracedPiHandle(box, 'intent-abort-failure');
      handle = pi;
      const message = createCancelMessage(box);
      const { reference } = await cancellationIntentReference(box, message);
      await assert.rejects(pi.session.cancel({ intent: reference }));
      const finished = await pi.session.finish();
      assert.equal(finished.ok, false);

      const record = readRecord(box.taskRoot);
      assert.equal(cancellationMessages(box.taskRoot).length, 1);
      assert.equal(record?.claims[0]?.cancel_pending, true);
      assert.equal(record?.claims[0]?.released_at, null);
      assert.equal(
        (record?.messages ?? []).some((entry) => entry.type === 'CANCELLED'),
        false,
      );
      assert.equal(
        (record?.uncertainty ?? []).filter(
          (entry) => entry.kind === 'cancel_unconfirmed',
        ).length,
        1,
      );
      assert.equal(tracedRequestCount(pi.trace, 'clear_queue'), 1);
      assert.equal(tracedRequestCount(pi.trace, 'abort'), 1);
    } finally {
      if (handle) {
        await handle.session.finish();
        handle.restoreTrace();
      }
      if (previousFailure === undefined)
        delete process.env['FAKE_PI_FAIL_COMMAND'];
      else process.env['FAKE_PI_FAIL_COMMAND'] = previousFailure;
      box.cleanup();
    }
  },
);
