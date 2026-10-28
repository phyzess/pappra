import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../../src/cli/run.js';
import { makeTaskDomain } from './task-resources-fixtures.js';
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
