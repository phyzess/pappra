import assert from 'node:assert/strict';
import fs, {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Interruption } from '../../src/app/collab-workflow/interruption.js';
import { runCli } from '../../src/cli/run.js';
import { buildMessage, messageFile } from '../../src/collab/envelope.js';
import { transitionAttempt } from '../../src/collab/lifecycle.js';
import { submitMessage } from '../../src/collab/messages.js';
import { readRecord, transact } from '../../src/collab/store.js';
import type { MessageInput } from '../../src/collab/types.js';
import { makeTaskDomain, snapshotTree } from './task-resources-fixtures.js';
import { owner } from './scenarios.js';

async function cli(args: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

function prepareDocument(
  domainRoot: string,
  cwd: string,
): Record<string, unknown> {
  const participant = (
    agent: string,
    session: string,
    configuration = 'daily-visible',
  ) => ({
    agent_id: agent,
    session_id: session,
    harness: 'pi',
    cwd,
    surface: 'cli',
    configuration_id: configuration,
  });
  return {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: domainRoot,
    task_id: 'cohort',
    goal: { objective: 'CLI cohort.', input_ref: null, input_digest: null },
    coordinator: {
      agent_id: owner.agent_id,
      session_id: owner.session_id,
      harness: owner.harness,
      cwd,
      surface: 'cli',
      configuration_id: 'daily-visible',
      owner_epoch: owner.owner_epoch,
    },
    participants: [
      participant(owner.agent_id, owner.session_id),
      participant('writer-a', 'writer-a-session'),
    ],
    bindings: [],
    assignments: [
      {
        subtask_id: 'writer-one',
        role: 'writer',
        assignee: 'writer-a',
        objective: 'Placeholder CLI objective.',
        acceptance: ['Placeholder CLI acceptance.'],
        resources: [{ path: join(cwd, 'a'), access: 'write' }],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ],
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  };
}

test('collab workflow bypasses the global option parser and prints its own usage', async () => {
  const help = await cli(['collab', 'workflow', '--help']);
  assert.equal(help.code, 0);
  assert.match(
    help.stdout,
    /pappra collab workflow <prepare\|dispatch\|ack\|report\|accept\|await\|release\|reclaim\|adopt\|inspect>/,
  );
  // `await` is read-only, so its usage line carries no `--apply`.
  assert.match(
    help.stdout,
    /\n {2}await {4}--request <abs await\.json> \[--json\]\n/,
  );
  assert.match(help.stdout, /Await is the worker-side bounded wait/);
  // Only a decision exits 0; a timeout exits 1, so `await && release` cannot release without one.
  assert.match(help.stdout, /accepts and ignores --apply/);
  assert.match(help.stdout, /a timeout exits 1 with status "timeout"/);
  assert.match(help.stdout, /--interruption <subtask-id> requires --json/);

  // `--watch` is a global flag; the workflow family must reject it as its own unknown
  // option instead of silently accepting a flag it does not implement.
  const foreign = await cli([
    'collab',
    'workflow',
    'prepare',
    '--request',
    '/nonexistent/prepare.json',
    '--watch',
  ]);
  assert.equal(foreign.code, 2);
  assert.match(foreign.stdout, /unknown option: --watch/);

  const unknownAction = await cli(['collab', 'workflow', 'explode']);
  assert.equal(unknownAction.code, 2);
  assert.match(unknownAction.stdout, /unknown workflow action: explode/);
});

test('collab workflow --interruption is a single safe JSON inspect selector', async () => {
  const inspect = ['inspect', '--task-root', '/unused'];
  for (const args of [
    [...inspect, '--interruption', 'work'],
    [...inspect, '--interruption', 'work', '--json', '--apply'],
    [...inspect, '--interruption', 'work', '--interruption', 'other', '--json'],
    [...inspect, '--interruption', '../work', '--json'],
    [...inspect, '--interruption', 'x'.repeat(129), '--json'],
    [...inspect, '--interruption', '--json'],
    ['prepare', '--request', '/unused', '--interruption', 'work', '--json'],
  ]) {
    const result = await cli(['collab', 'workflow', ...args]);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.match(result.stdout, /--interruption/);
  }
});

const interruptionWriter = {
  agent_id: 'writer-a',
  session_id: 'writer-a-session',
  harness: 'pi',
};

async function withInterruptionFixture(
  name: string,
  run: (context: {
    taskRoot: string;
    send: (
      fields: Pick<MessageInput, 'type' | 'message_id'> & Partial<MessageInput>,
    ) => ReturnType<typeof buildMessage>;
    inspect: (subtask?: string) => Promise<Interruption>;
  }) => Promise<void>,
) {
  const fixture = makeTaskDomain(name, ['cohort'], { initialize: [] });
  try {
    const requestFile = join(fixture.root, 'prepare.json');
    writeFileSync(
      requestFile,
      JSON.stringify(prepareDocument(fixture.domainRoot, fixture.root)),
    );
    const prepared = await cli([
      'collab',
      'workflow',
      'prepare',
      '--request',
      requestFile,
      '--apply',
      '--json',
    ]);
    assert.equal(prepared.code, 0, prepared.stdout);
    const taskRoot = fixture.tasks['cohort']!;
    let clock = Date.now();
    const send = (
      fields: Pick<MessageInput, 'type' | 'message_id'> & Partial<MessageInput>,
    ) => {
      const message = buildMessage(
        {
          task_id: 'cohort',
          from: owner,
          to: interruptionWriter,
          subtask_id: 'writer-one',
          attempt: 1,
          owner_epoch: owner.owner_epoch,
          ...fields,
        },
        { clock: ++clock },
      );
      const applied = submitMessage(taskRoot, message, { clock });
      assert.equal(applied.ok, true, JSON.stringify(applied));
      return message;
    };
    const baseArgs = [
      'collab',
      'workflow',
      'inspect',
      '--task-root',
      taskRoot,
      '--json',
    ];
    const ordinary = await cli(baseArgs);
    assert.equal(ordinary.code, 0, ordinary.stdout);
    assert.equal('interruption' in JSON.parse(ordinary.stdout).detail, false);
    const inspect = async (subtask = 'writer-one') => {
      const before = snapshotTree(fixture.root);
      const result = await cli([
        ...baseArgs,
        '--limit',
        '1',
        '--interruption',
        subtask,
      ]);
      assert.equal(result.code, 0, result.stdout);
      const body = JSON.parse(result.stdout) as {
        state_revision: number;
        detail: { interruption: Interruption };
      };
      assert.equal(
        body.detail.interruption.state_revision,
        body.state_revision,
      );
      assert.equal(body.detail.interruption.scope, 'persisted_history');
      assert.equal(body.detail.interruption.native_status, 'unknown');
      assert.equal(body.detail.interruption.native_cause, 'unknown');
      assert.deepEqual(snapshotTree(fixture.root), before);
      return body.detail.interruption;
    };
    await run({ taskRoot, send, inspect });
  } finally {
    fixture.cleanup();
  }
}

test('interruption reports the current approval BLOCK and never falls back to an older gate', async () => {
  await withInterruptionFixture(
    'workflow-interruption-approval',
    async ({ taskRoot, send, inspect }) => {
      assert.equal((await inspect('missing')).reason, 'attempt_not_found');
      const original = readRecord(taskRoot)!.attempts[0]!;
      const approval = send({
        type: 'BLOCK',
        message_id: 'approval',
        from: interruptionWriter,
        to: owner,
        owner_epoch: null,
        body: { kind: 'approval' },
      });
      send({
        type: 'ASSIGN',
        message_id: 'unrelated-assign',
        subtask_id: 'another',
        body: {
          assignment_digest: original.assignment_digest,
          input_revision: 'another-input',
        },
      });
      const blocked = await inspect();
      assert.equal(blocked.kind, 'approval_wait');
      assert.equal(blocked.attempt, 1);
      assert.equal(blocked.owner_epoch, owner.owner_epoch);
      assert.equal(blocked.input_revision, original.input_revision);
      assert.equal(
        blocked.assignment_evidence?.message_id,
        original.assignment_message_id,
      );
      assert.deepEqual(blocked.evidence, {
        message_id: approval.message_id,
        content_digest: approval.content_digest,
      });

      send({
        type: 'BLOCK',
        message_id: 'clarification',
        body: { kind: 'clarification' },
      });
      assert.equal((await inspect()).kind, 'unknown');
      send({
        type: 'BLOCK',
        message_id: 'approval-without-new-transition',
        body: { kind: 'approval' },
      });
      assert.equal((await inspect()).reason, 'approval_evidence_unverified');

      transact(taskRoot, {
        actor: 'fixture',
        purpose: 'clear-approval',
        apply: (record) => {
          const attempt = record.attempts[0]!;
          assert.equal(
            transitionAttempt(record, {
              subtaskId: attempt.subtask_id,
              attempt: 1,
              to: 'running',
              evidence: { authorization: true },
            }).ok,
            true,
          );
          delete attempt.awaiting;
          return { record, op: 'clear-approval' };
        },
      });
      assert.equal((await inspect()).reason, 'no_supported_gate');
      send({
        type: 'BLOCK',
        message_id: 'wrong-epoch-approval',
        owner_epoch: owner.owner_epoch + 1,
        body: { kind: 'approval' },
      });
      assert.equal((await inspect()).reason, 'approval_evidence_unverified');
      send({ type: 'CANCEL', message_id: 'cancel-while-blocked' });
      assert.equal((await inspect()).reason, 'conflicting_gates');
    },
  );
});

test('an approval BLOCK does not borrow a same-clock REPORT transition', async () => {
  await withInterruptionFixture(
    'workflow-interruption-same-clock',
    async ({ taskRoot, send, inspect }) => {
      const assignee = { ...interruptionWriter, agent_id: 'result-admission' };
      const original = readRecord(taskRoot)!.attempts[0]!;
      send({
        type: 'ASSIGN',
        message_id: 'same-clock-assignment',
        subtask_id: 'same-clock',
        to: assignee,
        body: {
          assignment_digest: original.assignment_digest,
          input_revision: original.input_revision,
        },
      });
      const clock = Date.now() + 1000;
      for (const fields of [
        { type: 'REPORT', body: { status: 'needs_input' } },
        { type: 'BLOCK', body: { kind: 'approval' } },
      ]) {
        const message = buildMessage(
          {
            task_id: 'cohort',
            subtask_id: 'same-clock',
            attempt: 1,
            from: assignee,
            to: owner,
            ...fields,
          },
          { clock },
        );
        const applied = submitMessage(taskRoot, message, { clock });
        assert.equal(applied.ok, true, JSON.stringify(applied));
      }
      const result = await inspect('same-clock');
      assert.equal(result.reason, 'approval_evidence_unverified');
      assert.equal(result.evidence, null);
    },
  );
});

test('cancellation after a clarification answer uses the current running state', async () => {
  await withInterruptionFixture(
    'workflow-interruption-answered',
    async ({ taskRoot, send, inspect }) => {
      const clarification = send({
        type: 'BLOCK',
        message_id: 'clarification-block',
        from: interruptionWriter,
        to: owner,
        body: { kind: 'clarification' },
      });
      send({
        type: 'ANSWER',
        message_id: 'clarification-answer',
        reply_to: clarification.message_id,
      });
      const attempt = readRecord(taskRoot)!.attempts[0]!;
      assert.equal(attempt.state, 'running');
      assert.equal(attempt.awaiting, 'clarification');
      const cancel = send({
        type: 'CANCEL',
        message_id: 'cancel-after-answer',
      });
      const result = await inspect();
      assert.equal(result.kind, 'cancel_requested');
      assert.equal(result.evidence.message_id, cancel.message_id);
    },
  );
});

test('interruption rejects a messages namespace redirected only during the envelope read', async (t) => {
  await withInterruptionFixture(
    'workflow-interruption-namespace',
    async ({ taskRoot, send, inspect }) => {
      const cancel = send({ type: 'CANCEL', message_id: 'redirected-cancel' });
      const file = messageFile(taskRoot, cancel.message_id);
      const messages = dirname(file);
      const parked = join(taskRoot, 'parked-messages');
      const outside = join(taskRoot, '../../..', 'outside');
      renameSync(file, join(outside, `${cancel.message_id}.json`));
      assert.equal((await inspect()).reason, 'cancel_evidence_unverified');

      const lstat = fs.lstatSync;
      const open = fs.openSync;
      const close = fs.closeSync;
      let redirected = false;
      let restored = false;
      let descriptor: number | undefined;
      const restore = () => {
        if (!redirected || restored) return;
        unlinkSync(messages);
        renameSync(parked, messages);
        restored = true;
      };
      const lstatMock = t.mock.method(
        fs,
        'lstatSync',
        (path: fs.PathLike, options?: fs.StatSyncOptions) => {
          if (path === file && !redirected) {
            renameSync(messages, parked);
            symlinkSync(outside, messages);
            redirected = true;
          }
          return lstat(path, options);
        },
      );
      const openMock = t.mock.method(
        fs,
        'openSync',
        (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
          const fd = open(path, flags, mode);
          if (path === file) descriptor = fd;
          return fd;
        },
      );
      const closeMock = t.mock.method(fs, 'closeSync', (fd: number) => {
        close(fd);
        if (fd === descriptor) restore();
      });
      try {
        const result = await inspect();
        assert.equal(restored, true);
        assert.equal(result.reason, 'snapshot_unavailable');
        assert.equal(result.evidence, null);
      } finally {
        restore();
        lstatMock.mock.restore();
        openMock.mock.restore();
        closeMock.mock.restore();
      }
    },
  );
});

test('interruption joins the latest CANCEL to open uncertainty and verifies the registered file', async () => {
  await withInterruptionFixture(
    'workflow-interruption-cancel',
    async ({ taskRoot, send, inspect }) => {
      send({ type: 'CANCEL', message_id: 'first-cancel' });
      const first = await inspect();
      assert.equal(first.kind, 'cancel_requested');
      const second = send({ type: 'CANCEL', message_id: 'second-cancel' });
      const repeated = await inspect();
      assert.equal(repeated.kind, 'cancel_requested');
      assert.deepEqual(repeated.evidence, {
        message_id: second.message_id,
        content_digest: second.content_digest,
        uncertainty_id: first.evidence.uncertainty_id,
      });

      const assignment = messageFile(
        taskRoot,
        repeated.assignment_evidence!.message_id,
      );
      renameSync(assignment, `${assignment}.saved`);
      assert.equal((await inspect()).reason, 'assignment_unverified');
      renameSync(`${assignment}.saved`, assignment);

      const file = messageFile(taskRoot, second.message_id);
      renameSync(file, `${file}.saved`);
      symlinkSync(`${file}.saved`, file);
      assert.equal((await inspect()).reason, 'cancel_evidence_unverified');
      unlinkSync(file);
      const original = readFileSync(`${file}.saved`, 'utf8');
      writeFileSync(
        file,
        JSON.stringify({
          ...JSON.parse(original),
          body: { reason: 'different content' },
        }),
      );
      assert.equal((await inspect()).reason, 'cancel_evidence_unverified');
      writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
      assert.equal((await inspect()).reason, 'cancel_evidence_unverified');
      writeFileSync(file, original);

      const mismatched = send({
        type: 'CANCEL',
        message_id: 'wrong-recipient-harness',
        to: { ...interruptionWriter, harness: 'codex' },
      });
      assert.equal((await inspect()).reason, 'cancel_evidence_unverified');

      send({
        type: 'CANCELLED',
        message_id: 'confirmed-stop',
        from: interruptionWriter,
        to: owner,
        reply_to: mismatched.message_id,
        body: { stop_evidence: { ref: 'fixture-stop' } },
      });
      assert.equal((await inspect()).reason, 'attempt_inactive');

      const prior = readRecord(taskRoot)!.attempts[0]!;
      send({
        type: 'ASSIGN',
        message_id: 'second-attempt',
        attempt: 2,
        body: {
          assignment_digest: prior.assignment_digest,
          input_revision: 'replacement-input',
          approval: { approved_by: owner.agent_id, reason: 'Fixture retry' },
        },
      });
      const next = await inspect();
      assert.equal(next.kind, 'unknown');
      assert.equal(next.attempt, 2);
      assert.equal(next.input_revision, 'replacement-input');
      assert.equal(next.evidence, null);
    },
  );
});

test('collab workflow prepare plans without writing and applies deterministically', async () => {
  const fixture = makeTaskDomain('workflow-cli', ['cohort'], {
    initialize: [],
  });
  try {
    const requestFile = join(fixture.root, 'prepare.json');
    writeFileSync(
      requestFile,
      `${JSON.stringify(prepareDocument(fixture.domainRoot, fixture.root), null, 2)}\n`,
    );

    const plan = await cli([
      'collab',
      'workflow',
      'prepare',
      '--request',
      requestFile,
      '--json',
    ]);
    assert.equal(plan.code, 0, plan.stdout);
    const planned = JSON.parse(plan.stdout) as {
      status: string;
      action: string;
    };
    assert.equal(planned.action, 'prepare');
    assert.equal(planned.status, 'planned');
    assert.equal(
      existsSync(join(fixture.domainRoot, 'tasks', 'cohort')),
      false,
    );

    const applied = await cli([
      'collab',
      'workflow',
      'prepare',
      '--request',
      requestFile,
      '--apply',
      '--json',
    ]);
    assert.equal(applied.code, 0, applied.stdout);
    const result = JSON.parse(applied.stdout) as {
      status: string;
      messages: { message_id: string; duplicate: boolean }[];
      claims: unknown[];
    };
    assert.equal(result.status, 'applied');
    assert.deepEqual(
      result.messages.map((item) => item.message_id),
      ['assign-writer-one'],
    );
    assert.equal(result.messages[0]?.duplicate, false);

    const inspect = await cli([
      'collab',
      'workflow',
      'inspect',
      '--task-root',
      join(fixture.domainRoot, 'tasks', 'cohort'),
      '--json',
    ]);
    assert.equal(inspect.code, 0, inspect.stdout);
    const inspected = JSON.parse(inspect.stdout) as {
      ok: boolean;
      detail: { attempts: { subtask_id: string }[] };
    };
    assert.equal(inspected.ok, true);
    assert.equal(inspected.detail.attempts[0]?.subtask_id, 'writer-one');
  } finally {
    fixture.cleanup();
  }
});

test('collab workflow rejects a request whose action does not match the invoked action', async () => {
  const fixture = makeTaskDomain('workflow-cli-mismatch', ['cohort'], {
    initialize: [],
  });
  try {
    const requestFile = join(fixture.root, 'participant.json');
    writeFileSync(
      requestFile,
      `${JSON.stringify(
        {
          schema: 'pappra/collab-workflow-participant-request/1',
          action: 'ack',
          task_root: join(fixture.domainRoot, 'tasks', 'cohort'),
          caller: {
            agent_id: 'writer-a',
            session_id: 'writer-a-session',
            harness: 'pi',
            cwd: fixture.root,
          },
          subtask_id: 'writer-one',
          attempt: 1,
          report: null,
          release: null,
        },
        null,
        2,
      )}\n`,
    );
    const mismatch = await cli([
      'collab',
      'workflow',
      'report',
      '--request',
      requestFile,
      '--json',
    ]);
    assert.equal(mismatch.code, 2);
    assert.match(mismatch.stdout, /does not match the invoked action/);
  } finally {
    fixture.cleanup();
  }
});

test('collab workflow accept is a plan until --apply is given', async () => {
  const fixture = makeTaskDomain('workflow-cli-accept', ['cohort'], {
    initialize: [],
  });
  try {
    const prepareFile = join(fixture.root, 'prepare.json');
    writeFileSync(
      prepareFile,
      `${JSON.stringify(prepareDocument(fixture.domainRoot, fixture.root), null, 2)}\n`,
    );
    const applied = await cli([
      'collab',
      'workflow',
      'prepare',
      '--request',
      prepareFile,
      '--apply',
      '--json',
    ]);
    assert.equal(applied.code, 0, applied.stdout);
    const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
    mkdirSync(join(fixture.root, 'a'), { recursive: true });
    const output = join(fixture.root, 'a', 'out.txt');
    writeFileSync(output, 'built\n');

    const reportFile = join(fixture.root, 'report.json');
    writeFileSync(
      reportFile,
      `${JSON.stringify(
        {
          schema: 'pappra/collab-workflow-participant-request/1',
          action: 'report',
          task_root: taskRoot,
          caller: {
            agent_id: 'writer-a',
            session_id: 'writer-a-session',
            harness: 'pi',
            cwd: fixture.root,
          },
          subtask_id: 'writer-one',
          attempt: 1,
          report: {
            status: 'completed',
            summary: 'Done.',
            blockers: [],
            outputs: [output],
          },
          release: null,
        },
        null,
        2,
      )}\n`,
    );
    const report = await cli([
      'collab',
      'workflow',
      'report',
      '--request',
      reportFile,
      '--apply',
      '--json',
    ]);
    assert.equal(report.code, 0, report.stdout);
    const reportMessageId = (
      JSON.parse(report.stdout) as { messages: { message_id: string }[] }
    ).messages[0]?.message_id;

    const acceptFile = join(fixture.root, 'accept.json');
    writeFileSync(
      acceptFile,
      `${JSON.stringify(
        {
          schema: 'pappra/collab-workflow-accept-request/1',
          task_root: taskRoot,
          caller: {
            agent_id: owner.agent_id,
            session_id: owner.session_id,
            harness: owner.harness,
            cwd: fixture.root,
          },
          subtask_id: 'writer-one',
          attempt: 1,
          report_message_id: reportMessageId,
          caller_pane: null,
          reason: 'Reviewed.',
        },
        null,
        2,
      )}\n`,
    );
    const planned = await cli([
      'collab',
      'workflow',
      'accept',
      '--request',
      acceptFile,
      '--json',
    ]);
    assert.equal(planned.code, 0, planned.stdout);
    assert.equal(
      (JSON.parse(planned.stdout) as { status: string }).status,
      'planned',
    );
    assert.equal(
      existsSync(join(taskRoot, 'messages', 'accept-writer-one-1.json')),
      false,
      'a plan writes no decision envelope',
    );

    const accepted = await cli([
      'collab',
      'workflow',
      'accept',
      '--request',
      acceptFile,
      '--apply',
      '--json',
    ]);
    // Delivery needs a live Herdr transport, so the decision is recorded and its delivery is
    // reported honestly rather than faked.
    const acceptedBody = JSON.parse(accepted.stdout) as {
      status: string;
      messages: { delivery: string }[];
    };
    assert.ok(
      acceptedBody.status === 'applied' || acceptedBody.status === 'blocked',
      accepted.stdout,
    );
    assert.equal(
      acceptedBody.messages[0]?.delivery !== undefined,
      true,
      'acceptance reports a delivery status',
    );
  } finally {
    fixture.cleanup();
  }
});

test('collab workflow inspect --limit bounds lists and reports totals', async () => {
  const fixture = makeTaskDomain('workflow-cli-limit', ['cohort'], {
    initialize: [],
  });
  try {
    const requestFile = join(fixture.root, 'prepare.json');
    writeFileSync(
      requestFile,
      `${JSON.stringify(prepareDocument(fixture.domainRoot, fixture.root), null, 2)}\n`,
    );
    const applied = await cli([
      'collab',
      'workflow',
      'prepare',
      '--request',
      requestFile,
      '--apply',
      '--json',
    ]);
    assert.equal(applied.code, 0, applied.stdout);
    const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
    const bounded = await cli([
      'collab',
      'workflow',
      'inspect',
      '--task-root',
      taskRoot,
      '--limit',
      '1',
      '--json',
    ]);
    assert.equal(bounded.code, 0, bounded.stdout);
    const detail = (
      JSON.parse(bounded.stdout) as {
        detail: {
          limit: number;
          attempts: unknown[];
          messages: unknown[];
          totals: { attempts: number; messages: number };
          truncated: { attempts: boolean; messages: boolean };
        };
      }
    ).detail;
    assert.equal(detail.limit, 1);
    assert.ok(detail.attempts.length <= 1);
    assert.ok(detail.messages.length <= 1);
    assert.equal(detail.truncated.attempts, detail.totals.attempts > 1);
    assert.equal(detail.truncated.messages, detail.totals.messages > 1);

    for (const bad of ['0', '501', 'x']) {
      const rejected = await cli([
        'collab',
        'workflow',
        'inspect',
        '--task-root',
        taskRoot,
        '--limit',
        bad,
        '--json',
      ]);
      assert.equal(rejected.code, 2, `limit ${bad}`);
    }
    const misplaced = await cli([
      'collab',
      'workflow',
      'prepare',
      '--request',
      requestFile,
      '--limit',
      '1',
      '--json',
    ]);
    assert.equal(misplaced.code, 2, misplaced.stdout);
  } finally {
    fixture.cleanup();
  }
});

test('collab workflow accept routes a batch document and honours plan mode', async () => {
  const fixture = makeTaskDomain('workflow-cli-batch', ['cohort'], {
    initialize: [],
  });
  try {
    const requestFile = join(fixture.root, 'prepare.json');
    writeFileSync(
      requestFile,
      `${JSON.stringify(prepareDocument(fixture.domainRoot, fixture.root), null, 2)}\n`,
    );
    const applied = await cli([
      'collab',
      'workflow',
      'prepare',
      '--request',
      requestFile,
      '--apply',
      '--json',
    ]);
    assert.equal(applied.code, 0, applied.stdout);
    const batchFile = join(fixture.root, 'accept-batch.json');
    writeFileSync(
      batchFile,
      `${JSON.stringify({
        schema: 'pappra/collab-workflow-accept-batch-request/1',
        task_root: join(fixture.domainRoot, 'tasks', 'cohort'),
        caller: {
          agent_id: owner.agent_id,
          session_id: owner.session_id,
          harness: owner.harness,
          cwd: fixture.root,
        },
        accepts: [
          {
            subtask_id: 'writer-one',
            attempt: 1,
            report_message_id: 'no-such-report',
            reason: 'ok',
          },
          {
            subtask_id: 'writer-one',
            attempt: 2,
            report_message_id: 'no-such-report',
            reason: 'ok',
          },
        ],
      })}\n`,
    );
    const planned = await cli([
      'collab',
      'workflow',
      'accept',
      '--request',
      batchFile,
      '--json',
    ]);
    assert.equal(planned.code, 1, planned.stdout);
    const body = JSON.parse(planned.stdout) as {
      action: string;
      apply: boolean;
      detail: { items: { subtask_id: string; ok: boolean }[] };
    };
    assert.equal(body.action, 'accept');
    assert.equal(body.apply, false, 'no --apply means a plan');
    assert.equal(body.detail.items.length, 2, 'the batch route ran');
    assert.ok(body.detail.items.every((item) => !item.ok));

    const human = await cli([
      'collab',
      'workflow',
      'accept',
      '--request',
      batchFile,
      '--apply',
    ]);
    assert.equal(human.code, 1);
    assert.match(human.stdout, /blocker .*writer-one#1:/);
  } finally {
    fixture.cleanup();
  }
});
