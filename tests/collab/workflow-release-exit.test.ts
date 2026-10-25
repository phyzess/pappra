import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyPrepare } from '../../src/app/collab-workflow/prepare.js';
import { applyParticipant } from '../../src/app/collab-workflow/participant.js';
import { applyAccept } from '../../src/app/collab-workflow/acceptance.js';
import {
  buildMessage,
  readRegisteredMessage,
  validateEnvelope,
} from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { releaseClaim } from '../../src/collab/resources.js';
import { digestText, readRecord, transact } from '../../src/collab/store.js';
import {
  workflowAssignmentPath,
  workflowIntentsDir,
  type WorkflowParticipantRequest,
  type WorkflowPrepareRequest,
} from '../../src/schemas/collab-workflow.js';
import type { notifyRegisteredMessage } from '../../src/app/collab-notify.js';

const clock = Date.parse('2026-10-25T12:00:00Z');
const cli = fileURLToPath(new URL('../../src/cli/main.js', import.meta.url));
const coordinator = {
  agent_id: 'fixture-coordinator',
  session_id: 'fixture-coordinator-session',
  harness: 'codex',
};
const worker = {
  agent_id: 'fixture-worker',
  session_id: 'fixture-worker-session',
  harness: 'codex',
};

async function fixture() {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'workflow-release-exit-')),
  );
  const taskRoot = path.join(root, 'tasks', 'release-fixture');
  const request: WorkflowPrepareRequest = {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: root,
    task_id: 'release-fixture',
    goal: {
      objective: 'Isolated release regression',
      input_ref: null,
      input_digest: null,
    },
    coordinator: {
      ...coordinator,
      cwd: root,
      surface: 'cli',
      configuration_id: 'fixture',
      owner_epoch: 1,
    },
    participants: [
      { ...worker, cwd: root, surface: 'cli', configuration_id: 'fixture' },
    ],
    bindings: [],
    assignments: [
      {
        subtask_id: 'write',
        role: 'writer',
        assignee: worker.agent_id,
        objective: 'Fixture writes',
        acceptance: ['Release safely'],
        resources: [
          {
            path: path.join(root, 'output.txt'),
            access: 'write',
            scope: 'file',
          },
          { path: path.join(root, 'input.txt'), access: 'read', scope: 'file' },
        ],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ],
    runner: { name: 'fixture', mode: 'fixture' },
  };
  const prepared = await applyPrepare(request, { clock });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const release: WorkflowParticipantRequest = {
    schema: 'pappra/collab-workflow-participant-request/1',
    action: 'release',
    task_root: taskRoot,
    caller: { ...worker, cwd: root },
    subtask_id: 'write',
    attempt: 1,
    caller_pane: null,
    report: null,
    release: {
      reason: 'Fixture finished',
      cancel_attempt: false,
      correlates_to: null,
    },
  };
  let notifications = 0;
  // Explicit no-native test adapter: a failed delivery is recorded as a warning,
  // never presented as a submitted native notification.
  const notify: typeof notifyRegisteredMessage = async () => {
    notifications++;
    return {
      ok: false,
      code: 'fixture_no_native_delivery',
      message: 'No native transport in fixture',
      retryable: false,
      nextAction: null,
    };
  };
  return {
    root,
    taskRoot,
    release,
    notify,
    get notifications() {
      return notifications;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function intentFile(f: Fixture) {
  return path.join(workflowIntentsDir(f.taskRoot), 'release-write-1.json');
}
function active(f: Fixture) {
  return readRecord(f.taskRoot)!.claims.filter((c) => c.released_at === null);
}
function releaseInput(
  f: Fixture,
  correlation: string | null,
  cancel = false,
): WorkflowParticipantRequest {
  return {
    ...f.release,
    release: {
      ...f.release.release!,
      correlates_to: correlation,
      cancel_attempt: cancel,
    },
  };
}

function persistPartialRelease(f: Fixture) {
  const intent = {
    schema: 'pappra/collab-workflow-release-intent/1',
    subtask_id: 'write',
    attempt: 1,
    reason: f.release.release!.reason,
    cancel_attempt: false,
    correlates_to: null,
    sealed_assignment_digest: digestText(
      readFileSync(workflowAssignmentPath(f.taskRoot, 'write'), 'utf8'),
    ),
  };
  mkdirSync(workflowIntentsDir(f.taskRoot), { recursive: true });
  writeFileSync(intentFile(f), JSON.stringify(intent, null, 2) + '\n');
  for (const claim of active(f))
    assert.equal(
      releaseClaim(f.taskRoot, {
        claimId: claim.claim_id,
        holder: worker,
        reason: f.release.release!.reason,
        clock,
      }).ok,
      true,
    );
}
async function decision(f: Fixture, overrides: Record<string, unknown> = {}) {
  const message = buildMessage({
    type: 'ASK',
    task_id: 'release-fixture',
    from: coordinator,
    to: worker,
    message_id: 'decision',
    owner_epoch: 1,
    subtask_id: 'write',
    attempt: 1,
    body: { kind: 'informational', question: 'Release fixture claims' },
    ...overrides,
  });
  const submitted = submitMessage(f.taskRoot, message, { clock });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  return message.message_id;
}
function invoke(f: Fixture, request: WorkflowParticipantRequest) {
  const file = path.join(f.root, 'release-request.json');
  writeFileSync(file, JSON.stringify(request));
  const result = spawnSync(
    process.execPath,
    [
      cli,
      'collab',
      'workflow',
      'release',
      '--request',
      file,
      '--apply',
      '--json',
    ],
    {
      cwd: f.root,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: f.root },
    },
  );
  assert.equal(result.error, undefined);
  return {
    ...result,
    value: JSON.parse(result.stdout) as Awaited<
      ReturnType<typeof applyParticipant>
    >,
  };
}

test('uncorrelated release has a real stable ASSIGN reply, plans read-only and replays without effects', async () => {
  const f = await fixture();
  try {
    const before = readFileSync(path.join(f.taskRoot, 'task.json'));
    const plan = await applyParticipant(f.release, {
      apply: false,
      clock,
      notify: f.notify,
    });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.deepEqual(readFileSync(path.join(f.taskRoot, 'task.json')), before);
    assert.equal(existsSync(intentFile(f)), false);
    assert.equal(f.notifications, 0);
    const first = await applyParticipant(f.release, {
      clock,
      notify: f.notify,
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.claims.length, 2);
    assert.equal(active(f).length, 0);
    const status = readRegisteredMessage(f.taskRoot, 'released-write-1')!;
    validateEnvelope(status);
    assert.equal(status.reply_to, 'assign-write');
    assert.equal(status.body.correlates_to, null);
    assert.equal(status.body.acceptance, null);
    assert.equal(first.messages[0]?.delivery, 'not-notified');
    const state = readFileSync(path.join(f.taskRoot, 'task.json'));
    const intent = readFileSync(intentFile(f));
    const replay = await applyParticipant(f.release, {
      clock: clock + 5_000,
      notify: f.notify,
    });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.deepEqual(replay.claims, []);
    assert.equal(replay.messages[0]?.duplicate, true);
    assert.equal(replay.messages[0]?.delivery, 'already-recorded');
    assert.equal(f.notifications, 1);
    assert.deepEqual(readFileSync(path.join(f.taskRoot, 'task.json')), state);
    assert.deepEqual(readFileSync(intentFile(f)), intent);
  } finally {
    f.cleanup();
  }
});

test('a correlated release answers a real coordinator decision', async () => {
  const f = await fixture();
  try {
    const id = await decision(f);
    const released = await applyParticipant(releaseInput(f, id), {
      clock,
      notify: f.notify,
    });
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.equal(
      readRegisteredMessage(f.taskRoot, 'released-write-1')?.reply_to,
      id,
    );
    assert.equal(
      readRegisteredMessage(f.taskRoot, 'released-write-1')?.body.correlates_to,
      id,
    );
  } finally {
    f.cleanup();
  }
});

for (const invalid of [
  'missing',
  'type',
  'sender',
  'recipient',
  'epoch',
  'attempt',
] as const) {
  test(`invalid ${invalid} correlation cannot poison intent or release claims; valid retry works`, async () => {
    const f = await fixture();
    try {
      let id = 'missing';
      if (invalid === 'type') id = 'assign-write';
      if (invalid === 'sender') id = await decision(f, { from: worker });
      if (invalid === 'recipient') id = await decision(f, { to: coordinator });
      if (invalid === 'epoch') id = await decision(f, { owner_epoch: 2 });
      if (invalid === 'attempt') id = await decision(f, { attempt: 2 });
      const before = readFileSync(path.join(f.taskRoot, 'task.json'));
      const rejected = await applyParticipant(releaseInput(f, id), {
        clock,
        notify: f.notify,
      });
      assert.equal(rejected.ok, false);
      assert.equal(existsSync(intentFile(f)), false);
      assert.equal(active(f).length, 2);
      assert.deepEqual(
        readFileSync(path.join(f.taskRoot, 'task.json')),
        before,
      );
      assert.equal(f.notifications, 0);
      const retry = await applyParticipant(f.release, {
        clock,
        notify: f.notify,
      });
      assert.equal(retry.ok, true, JSON.stringify(retry));
      assert.equal(active(f).length, 0);
    } finally {
      f.cleanup();
    }
  });
}

test('invalid primitive declarations and sealed assignment faults have no durable effects', async () => {
  for (const invalid of ['reason', 'cancellation', 'sealed'] as const) {
    const f = await fixture();
    try {
      const sealed = readFileSync(workflowAssignmentPath(f.taskRoot, 'write'));
      let request = f.release;
      if (invalid === 'reason')
        request = { ...request, release: { ...request.release!, reason: '' } };
      if (invalid === 'cancellation') {
        const outcome = transact(f.taskRoot, {
          actor: 'fixture',
          purpose: 'fixture-terminal',
          apply: (record) => {
            record.attempts[0]!.state = 'completed';
            return { record };
          },
        });
        assert.equal(outcome.ok, true);
        request = releaseInput(f, null, true);
      }
      if (invalid === 'sealed')
        writeFileSync(workflowAssignmentPath(f.taskRoot, 'write'), '{}');
      const before = readFileSync(path.join(f.taskRoot, 'task.json'));
      const failed = await applyParticipant(request, {
        clock,
        notify: f.notify,
      });
      assert.equal(failed.ok, false);
      assert.equal(existsSync(intentFile(f)), false);
      assert.equal(active(f).length, 2);
      assert.deepEqual(
        readFileSync(path.join(f.taskRoot, 'task.json')),
        before,
      );
      if (invalid === 'sealed')
        writeFileSync(workflowAssignmentPath(f.taskRoot, 'write'), sealed);
      const retry = await applyParticipant(f.release, {
        clock,
        notify: f.notify,
      });
      assert.equal(retry.ok, true, JSON.stringify(retry));
      assert.equal(active(f).length, 0);
    } finally {
      f.cleanup();
    }
  }
});

test('cancelled release is replayable without another cancellation or notification', async () => {
  const f = await fixture();
  try {
    const request = releaseInput(f, null, true);
    const first = await applyParticipant(request, { clock, notify: f.notify });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(readRecord(f.taskRoot)!.attempts[0]!.state, 'cancelled');
    const before = readFileSync(path.join(f.taskRoot, 'task.json'));
    const replay = await applyParticipant(request, {
      clock: clock + 1_000,
      notify: f.notify,
    });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.deepEqual(readFileSync(path.join(f.taskRoot, 'task.json')), before);
    assert.equal(f.notifications, 1);
  } finally {
    f.cleanup();
  }
});

test('an accepted completed attempt with old intent and released claims finishes its missing STATUS without rewriting evidence', async () => {
  const f = await fixture();
  try {
    const ack = await applyParticipant(
      { ...f.release, action: 'ack', release: null },
      { clock, notify: f.notify },
    );
    assert.equal(ack.ok, true);
    const report = await applyParticipant(
      {
        ...f.release,
        action: 'report',
        release: null,
        report: {
          status: 'completed',
          summary: 'Fixture completed',
          blockers: [],
          outputs: [],
        },
      },
      { clock, notify: f.notify },
    );
    assert.equal(report.ok, true, JSON.stringify(report));
    const accepted = await applyAccept(
      {
        schema: 'pappra/collab-workflow-accept-request/1',
        task_root: f.taskRoot,
        caller: { ...coordinator, cwd: f.root },
        subtask_id: 'write',
        attempt: 1,
        report_message_id: report.detail!.message_id!,
        caller_pane: null,
        reason: 'Accept fixture result',
      },
      { clock, notify: f.notify },
    );
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    persistPartialRelease(f);
    const oldIntent = readFileSync(intentFile(f));
    const oldRecord = readRecord(f.taskRoot)!;
    assert.equal(readRegisteredMessage(f.taskRoot, 'released-write-1'), null);
    const beforeNotifications = f.notifications;
    const recovered = await applyParticipant(f.release, {
      clock,
      notify: f.notify,
    });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.deepEqual(recovered.claims, []);
    assert.deepEqual(readFileSync(intentFile(f)), oldIntent);
    assert.equal(readRecord(f.taskRoot)!.attempts[0]!.state, 'completed');
    assert.deepEqual(readRecord(f.taskRoot)!.results, oldRecord.results);
    assert.equal(
      readRegisteredMessage(f.taskRoot, 'released-write-1')?.reply_to,
      'assign-write',
    );
    assert.equal(f.notifications, beforeNotifications + 1);
    const replay = await applyParticipant(f.release, {
      clock: clock + 2_000,
      notify: f.notify,
    });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(f.notifications, beforeNotifications + 1);
  } finally {
    f.cleanup();
  }
});

test('an omitted decision correlation is equivalent to explicit null', async () => {
  const f = await fixture();
  try {
    const request = structuredClone(f.release);
    delete (request.release as Partial<NonNullable<typeof request.release>>)
      .correlates_to;
    const first = await applyParticipant(request, { clock, notify: f.notify });
    assert.equal(first.ok, true, JSON.stringify(first));
    const replay = await applyParticipant(f.release, {
      clock: clock + 1_000,
      notify: f.notify,
    });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(replay.messages[0]?.duplicate, true);
    assert.equal(f.notifications, 1);
  } finally {
    f.cleanup();
  }
});

test('invalid or conflicting existing STATUS preserves claims and creates no intent', async () => {
  for (const corrupt of [true, false]) {
    const f = await fixture();
    try {
      const file = path.join(f.taskRoot, 'messages', 'released-write-1.json');
      const bytes = corrupt
        ? '{bad json'
        : JSON.stringify(
            buildMessage({
              type: 'STATUS',
              task_id: 'release-fixture',
              from: worker,
              to: coordinator,
              reply_to: 'assign-write',
              message_id: 'released-write-1',
              subtask_id: 'write',
              attempt: 1,
              owner_epoch: 1,
              body: { status: 'running' },
            }),
          );
      writeFileSync(file, bytes);
      const failed = await applyParticipant(f.release, {
        clock,
        notify: f.notify,
      });
      assert.equal(failed.ok, false);
      assert.equal(active(f).length, 2);
      assert.equal(existsSync(intentFile(f)), false);
      assert.equal(readFileSync(file, 'utf8'), bytes);
      assert.equal(f.notifications, 0);
    } finally {
      f.cleanup();
    }
  }
});

test('actual CLI supports correlated release and completion of an existing partial release', async () => {
  for (const partial of [false, true]) {
    const f = await fixture();
    try {
      const request = partial ? f.release : releaseInput(f, await decision(f));
      if (partial) persistPartialRelease(f);
      const intent = partial ? readFileSync(intentFile(f)) : null;
      const first = invoke(f, request);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(first.value.ok, true, JSON.stringify(first.value));
      assert.equal(first.value.messages[0]?.delivery, 'not-notified');
      assert.equal(
        readRegisteredMessage(f.taskRoot, 'released-write-1')?.reply_to,
        partial ? 'assign-write' : 'decision',
      );
      assert.equal(active(f).length, 0);
      if (intent !== null)
        assert.deepEqual(readFileSync(intentFile(f)), intent);
      const before = readFileSync(path.join(f.taskRoot, 'task.json'));
      const replay = invoke(f, request);
      assert.equal(replay.status, 0, replay.stderr);
      assert.equal(replay.value.messages[0]?.delivery, 'already-recorded');
      assert.deepEqual(
        readFileSync(path.join(f.taskRoot, 'task.json')),
        before,
      );
    } finally {
      f.cleanup();
    }
  }
});

test('actual CLI rejects invalid correlation without intent, then releases and replays legally', async () => {
  const f = await fixture();
  try {
    const invalid = invoke(f, releaseInput(f, 'missing'));
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.equal(invalid.value.ok, false);
    assert.equal(existsSync(intentFile(f)), false);
    assert.equal(active(f).length, 2);
    const first = invoke(f, f.release);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.value.ok, true, JSON.stringify(first.value));
    assert.equal(active(f).length, 0);
    assert.equal(first.value.messages[0]?.delivery, 'not-notified');
    const status = readRegisteredMessage(f.taskRoot, 'released-write-1')!;
    validateEnvelope(status);
    assert.equal(status.reply_to, 'assign-write');
    const before = readFileSync(path.join(f.taskRoot, 'task.json'));
    const replay = invoke(f, f.release);
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(replay.value.messages[0]?.duplicate, true);
    assert.equal(replay.value.messages[0]?.delivery, 'already-recorded');
    assert.deepEqual(readFileSync(path.join(f.taskRoot, 'task.json')), before);
  } finally {
    f.cleanup();
  }
});
