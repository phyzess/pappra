import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { claimResources } from '../../src/collab/resources.js';
import { readRecord } from '../../src/collab/store.js';
import type {
  Identity,
  Message,
  MessageInput,
  TaskRecord,
} from '../../src/collab/types.js';
import {
  COLLAB_WORK_PLAN_REPORT_SCHEMA,
  inspectWorkPlan,
} from '../../src/app/collab-work-plan.js';
import { inspectWorkPlan as publicInspectWorkPlan } from '../../src/app/collaboration.js';
import { WORK_PLAN_SCHEMA } from '../../src/collab/work-plan.js';
import { makeTaskDomain, snapshotTree } from './task-resources-fixtures.js';

/**
 * The repository root is located from the process working directory rather than from
 * module resolution, so this file also runs when it is compiled into an isolated layout.
 */
function repoRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      existsSync(join(current, 'tsconfig.test.json')) &&
      existsSync(join(current, 'package.json'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    'Could not locate the repository root for the isolated CLI build.',
  );
}
const ROOT = repoRoot();
const TASK = 'sample';
const PLAN_ID = 'plan-cli';
const INPUT = `sha256:${'1'.repeat(64)}`;
const COORDINATOR: Identity = {
  agent_id: 'coordinator',
  session_id: 'coord-session',
  harness: 'pi',
};
const WRITER_A: Identity = {
  agent_id: 'writer-a',
  session_id: 'session-a',
  harness: 'codex',
};
const WRITER_B: Identity = {
  agent_id: 'writer-b',
  session_id: 'session-b',
  harness: 'claude',
};

/**
 * The CLI is exercised from an isolated compiled package layout so the shared dist/.build
 * output is never written. One compile per test file; the layout mirrors the published
 * package (package.json + node_modules) so `getPackageInfo` resolves normally.
 */
let isolated: { readonly dir: string; readonly cli: string } | null = null;
function isolatedCli(): { readonly dir: string; readonly cli: string } {
  if (isolated !== null) return isolated;
  const dir = mkdtempSync(join(tmpdir(), 'pappra-plan-cli-'));
  const pkg = join(dir, 'pkg');
  const build = spawnSync(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      join(ROOT, 'tsconfig.test.json'),
      '--outDir',
      pkg,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.equal(build.status, 0, build.stderr);
  copyFileSync(join(ROOT, 'package.json'), join(pkg, 'package.json'));
  symlinkSync(join(ROOT, 'node_modules'), join(pkg, 'node_modules'), 'dir');
  isolated = { dir, cli: join(pkg, 'src', 'cli', 'main.js') };
  return isolated;
}
after(() => {
  if (isolated !== null) rmSync(isolated.dir, { recursive: true, force: true });
});

function run(
  args: readonly string[],
  cwd: string,
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const cli = isolatedCli();
  const result = spawnSync(process.execPath, [cli.cli, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parse(result: { readonly stdout: string }): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

interface Flow {
  readonly root: string;
  readonly task: string;
  readonly messages: Message[];
  send(input: MessageInput): Message;
  nextId(prefix: string): string;
  record(): TaskRecord;
  planFile(name: string, value: unknown): string;
  cleanup(): void;
}

function makeFlow(label: string): Flow {
  const domain = makeTaskDomain(label, [TASK]);
  const task = domain.tasks[TASK]!;
  const messages: Message[] = [];
  let clock = Date.parse('2026-10-20T00:00:00Z');
  let counter = 0;
  const tick = (): number => (clock += 1000);
  return {
    root: domain.root,
    task,
    messages,
    nextId: (prefix) => `${prefix}-${(counter += 1)}`,
    send: (input) => {
      const message = buildMessage(input, { clock: tick() });
      const outcome = submitMessage(task, message, { clock: tick() });
      assert.equal(
        outcome.ok,
        true,
        `could not submit ${input.type}: ${JSON.stringify(outcome)}`,
      );
      messages.push(message);
      return message;
    },
    record: () => {
      const record = readRecord(task);
      assert.ok(record);
      return record;
    },
    planFile: (name, value) => {
      const file = join(domain.root, name);
      writeFileSync(
        file,
        typeof value === 'string' ? value : `${JSON.stringify(value)}\n`,
      );
      return file;
    },
    cleanup: domain.cleanup,
  };
}

function startAttempt(
  flow: Flow,
  subtask: string,
  writer: Identity = WRITER_A,
): Message {
  return flow.send({
    message_id: `msg-assign-${subtask}`,
    type: 'ASSIGN',
    task_id: TASK,
    from: COORDINATOR,
    to: writer,
    subtask_id: subtask,
    attempt: 1,
    owner_epoch: 1,
    body: {
      assignment_digest: `sha256:${'a'.repeat(64)}`,
      input_revision: INPUT,
    },
  });
}

function finishAttempt(
  flow: Flow,
  subtask: string,
  writer: Identity = WRITER_A,
): Message {
  return flow.send({
    message_id: `msg-report-${subtask}`,
    type: 'REPORT',
    task_id: TASK,
    from: writer,
    to: COORDINATOR,
    subtask_id: subtask,
    attempt: 1,
    body: { status: 'completed', input_revision: INPUT },
  });
}

function decide(
  flow: Flow,
  subtask: string,
  reported: Message,
  writer: Identity = WRITER_A,
  decision = 'accepted',
): Message {
  return flow.send({
    message_id: flow.nextId(`msg-answer-${subtask}`),
    type: 'ANSWER',
    task_id: TASK,
    from: COORDINATOR,
    to: writer,
    reply_to: reported.message_id,
    subtask_id: subtask,
    attempt: 1,
    owner_epoch: 1,
    body: {
      acceptance: {
        plan_id: PLAN_ID,
        node_id: subtask,
        assignment_id: subtask,
        attempt: 1,
        input_revision: INPUT,
        report_message_id: reported.message_id,
        report_digest: reported.content_digest,
        decision,
      },
    },
  });
}

function node(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    node_id: id,
    role: 'writer',
    assignment_id: id,
    attempt: 1,
    input_revision: INPUT,
    assignee: WRITER_A,
    depends_on: [],
    resources: [],
    ...overrides,
  };
}

function plan(
  nodes: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: WORK_PLAN_SCHEMA,
    plan_id: PLAN_ID,
    task_id: TASK,
    owner_epoch: 1,
    nodes,
    ...overrides,
  };
}

interface Report {
  readonly status: string;
  readonly ok: boolean;
  readonly stale: boolean;
  readonly summary: Record<string, number> | null;
  readonly nodes: readonly {
    node_id: string;
    role: string;
    status: string;
    blockers: readonly { code: string }[];
    next_action: string | null;
  }[];
  readonly core: { accepted_nodes: string[]; ready_nodes: string[] } | null;
  readonly evidence: {
    relevant_reports: number;
    registered_decisions: number;
    supplied: number;
    raw_bytes: number;
    per_file_limit: number;
    aggregate_limit: number;
    over_budget: boolean;
    unreadable: readonly { message_id: string; code: string }[];
  };
  readonly diagnostics: readonly { code: string }[];
  readonly identity_mapping: string;
  readonly limits: readonly string[];
}

function reportOf(result: { readonly stdout: string }): Report {
  return parse(result) as unknown as Report;
}

function statusOf(report: Report, nodeId: string): string {
  const found = report.nodes.find((entry) => entry.node_id === nodeId);
  assert.ok(found, `no node ${nodeId}`);
  return found.status;
}

function codesOf(report: Report, nodeId: string): readonly string[] {
  const found = report.nodes.find((entry) => entry.node_id === nodeId);
  assert.ok(found, `no node ${nodeId}`);
  return found.blockers.map((entry) => entry.code);
}

test('the CLI evaluates a fork/join of disjoint workers', () => {
  const flow = makeFlow('plan-cli-fork-join');
  try {
    const file = flow.planFile(
      'plan.json',
      plan([
        node('left', { assignee: WRITER_A }),
        node('right', { assignee: WRITER_B }),
        node('join', { assignee: WRITER_A, depends_on: ['left', 'right'] }),
      ]),
    );
    const result = run(
      ['collab', 'plan', '--task-root', flow.task, '--config', file, '--json'],
      flow.root,
    );
    assert.equal(result.status, 0, result.stderr);
    const report = reportOf(result);
    assert.equal(parse(result).schema, COLLAB_WORK_PLAN_REPORT_SCHEMA);
    assert.equal(report.status, 'evaluated');
    assert.equal(report.ok, true);
    assert.equal(statusOf(report, 'left'), 'ready');
    assert.equal(statusOf(report, 'right'), 'ready');
    assert.equal(statusOf(report, 'join'), 'blocked');
    assert.deepEqual(codesOf(report, 'join'), ['predecessor_incomplete']);
    assert.equal(report.summary?.ready, 2);
    assert.equal(report.summary?.blocked, 1);
    assert.match(report.identity_mapping, /subtask_id/);
    assert.ok(report.limits.includes('persisted_snapshot_only'));
    assert.ok(report.limits.includes('not_an_authorization'));
  } finally {
    flow.cleanup();
  }
});

test('a finished report waits for the coordinator decision instead of unlocking the join', () => {
  const flow = makeFlow('plan-cli-awaiting-decision');
  try {
    startAttempt(flow, 'work');
    finishAttempt(flow, 'work');
    const file = flow.planFile(
      'plan.json',
      plan([node('work'), node('join', { depends_on: ['work'] })]),
    );
    const pending = run(
      ['collab', 'plan', '--task-root', flow.task, '--config', file, '--json'],
      flow.root,
    );
    assert.equal(pending.status, 0, pending.stderr);
    const report = reportOf(pending);
    assert.equal(statusOf(report, 'work'), 'awaiting_acceptance');
    assert.deepEqual(codesOf(report, 'join'), ['acceptance_missing']);
    assert.deepEqual(report.core?.accepted_nodes, []);

    const accepted = decide(flow, 'work', flow.messages[1]!);
    assert.ok(accepted.message_id.length > 0);
    const unlocked = run(
      ['collab', 'plan', '--task-root', flow.task, '--config', file, '--json'],
      flow.root,
    );
    assert.equal(unlocked.status, 0, unlocked.stderr);
    const after = reportOf(unlocked);
    assert.equal(statusOf(after, 'work'), 'accepted');
    assert.equal(statusOf(after, 'join'), 'ready');
    assert.deepEqual(after.core?.accepted_nodes, ['work']);
    assert.equal(after.evidence.registered_decisions, 1);
    assert.equal(after.evidence.supplied, 1);
  } finally {
    flow.cleanup();
  }
});

test('tampered or missing decision evidence is incomplete, never acceptance', () => {
  const tampered = makeFlow('plan-cli-tampered');
  try {
    startAttempt(tampered, 'work');
    const reported = finishAttempt(tampered, 'work');
    decide(tampered, 'work', reported, WRITER_A, 'accepted');
    const file = tampered.planFile(
      'plan.json',
      plan([node('work'), node('join', { depends_on: ['work'] })]),
    );
    // Rewrite the registered decision so it claims a different input revision: the bytes
    // parse as an envelope, but the content no longer matches the registered digest.
    const decisionId = 'msg-answer-work-1';
    const decisionPath = join(tampered.task, 'messages', `${decisionId}.json`);
    const stored = JSON.parse(
      String(readFileSync(decisionPath, 'utf8')),
    ) as Message;
    stored.body['acceptance'] = {
      ...(stored.body['acceptance'] as Record<string, unknown>),
      input_revision: `sha256:${'9'.repeat(64)}`,
    };
    writeFileSync(decisionPath, `${JSON.stringify(stored, null, 2)}\n`);

    const result = run(
      [
        'collab',
        'plan',
        '--task-root',
        tampered.task,
        '--config',
        file,
        '--json',
      ],
      tampered.root,
    );
    assert.equal(result.status, 1, result.stderr);
    const report = reportOf(result);
    assert.equal(report.status, 'incomplete');
    assert.equal(report.evidence.unreadable[0]?.code, 'content_mismatch');
    assert.equal(statusOf(report, 'work'), 'awaiting_acceptance');
    assert.deepEqual(report.core?.accepted_nodes, []);
    assert.deepEqual(codesOf(report, 'join'), ['acceptance_untrusted']);
  } finally {
    tampered.cleanup();
  }

  const missing = makeFlow('plan-cli-missing-decision');
  try {
    startAttempt(missing, 'work');
    const reported = finishAttempt(missing, 'work');
    decide(missing, 'work', reported);
    const file = missing.planFile(
      'plan.json',
      plan([node('work'), node('join', { depends_on: ['work'] })]),
    );
    rmSync(join(missing.task, 'messages', 'msg-answer-work-1.json'));
    const result = run(
      [
        'collab',
        'plan',
        '--task-root',
        missing.task,
        '--config',
        file,
        '--json',
      ],
      missing.root,
    );
    assert.equal(result.status, 1, result.stderr);
    const report = reportOf(result);
    assert.equal(report.status, 'incomplete');
    assert.equal(report.evidence.unreadable[0]?.code, 'message_not_registered');
    assert.deepEqual(report.core?.accepted_nodes, []);
    assert.ok(
      report.diagnostics.some(
        (entry) => entry.code === 'decision_evidence_unavailable',
      ),
    );
  } finally {
    missing.cleanup();
  }
});

test('read shares run together and a serialized claim stays usable', () => {
  const flow = makeFlow('plan-cli-resources');
  try {
    const shared = join(flow.root, 'shared-scope');
    const readers = flow.planFile(
      'readers.json',
      plan([
        node('read-a', { resources: [{ path: shared, access: 'read' }] }),
        node('read-b', { resources: [{ path: shared, access: 'read' }] }),
      ]),
    );
    const readResult = run(
      [
        'collab',
        'plan',
        '--task-root',
        flow.task,
        '--config',
        readers,
        '--json',
      ],
      flow.root,
    );
    assert.equal(readResult.status, 0, readResult.stderr);
    const readReport = reportOf(readResult);
    assert.equal(statusOf(readReport, 'read-a'), 'ready');
    assert.equal(statusOf(readReport, 'read-b'), 'ready');

    startAttempt(flow, 'write-a');
    const reported = finishAttempt(flow, 'write-a');
    decide(flow, 'write-a', reported);
    const claimed = claimResources(flow.task, {
      resources: [{ kind: 'path', path: shared }],
      holder: WRITER_B,
      subtaskId: 'write-b',
      attempt: 1,
    });
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    const serialized = flow.planFile(
      'serialized.json',
      plan([
        node('write-a', { resources: [{ path: shared, access: 'write' }] }),
        node('write-b', {
          assignee: WRITER_B,
          depends_on: ['write-a'],
          resources: [{ path: shared, access: 'write' }],
        }),
      ]),
    );
    const serializedResult = run(
      [
        'collab',
        'plan',
        '--task-root',
        flow.task,
        '--config',
        serialized,
        '--json',
      ],
      flow.root,
    );
    assert.equal(serializedResult.status, 0, serializedResult.stderr);
    const serializedReport = reportOf(serializedResult);
    assert.equal(statusOf(serializedReport, 'write-a'), 'accepted');
    assert.equal(statusOf(serializedReport, 'write-b'), 'ready');

    const conflict = flow.planFile(
      'conflict.json',
      plan([
        node('intruder', { resources: [{ path: shared, access: 'write' }] }),
      ]),
    );
    const conflictResult = run(
      [
        'collab',
        'plan',
        '--task-root',
        flow.task,
        '--config',
        conflict,
        '--json',
      ],
      flow.root,
    );
    assert.equal(conflictResult.status, 0, conflictResult.stderr);
    assert.deepEqual(codesOf(reportOf(conflictResult), 'intruder'), [
      'resource_claim_conflict',
    ]);
  } finally {
    flow.cleanup();
  }
});

test('wrong task, stale epoch, cyclic, oversized and malformed plans fail explicitly', () => {
  const flow = makeFlow('plan-cli-invalid-plans');
  try {
    const wrongTask = flow.planFile(
      'wrong-task.json',
      plan([node('work')], { task_id: 'another-task' }),
    );
    const wrong = run(
      [
        'collab',
        'plan',
        '--task-root',
        flow.task,
        '--config',
        wrongTask,
        '--json',
      ],
      flow.root,
    );
    assert.equal(wrong.status, 2, wrong.stderr);
    assert.equal(reportOf(wrong).status, 'invalid');
    assert.ok(
      reportOf(wrong).diagnostics.some(
        (entry) => entry.code === 'task_identity_mismatch',
      ),
    );

    const stalePlan = flow.planFile(
      'stale.json',
      plan([node('work')], { owner_epoch: 2 }),
    );
    const stale = run(
      [
        'collab',
        'plan',
        '--task-root',
        flow.task,
        '--config',
        stalePlan,
        '--json',
      ],
      flow.root,
    );
    assert.equal(stale.status, 0, stale.stderr);
    assert.equal(reportOf(stale).stale, true);
    assert.deepEqual(codesOf(reportOf(stale), 'work'), [
      'owner_epoch_mismatch',
    ]);

    const cyclic = flow.planFile(
      'cyclic.json',
      plan([
        node('a', { depends_on: ['b'] }),
        node('b', { depends_on: ['a'] }),
      ]),
    );
    assert.equal(
      run(
        [
          'collab',
          'plan',
          '--task-root',
          flow.task,
          '--config',
          cyclic,
          '--json',
        ],
        flow.root,
      ).status,
      2,
    );

    const broken = flow.planFile('broken.json', '{ not json');
    const brokenResult = run(
      [
        'collab',
        'plan',
        '--task-root',
        flow.task,
        '--config',
        broken,
        '--json',
      ],
      flow.root,
    );
    assert.equal(brokenResult.status, 2, brokenResult.stderr);
    assert.ok(
      reportOf(brokenResult).diagnostics.some(
        (entry) => entry.code === 'plan_json_invalid',
      ),
    );

    const many = flow.planFile(
      'many.json',
      plan(Array.from({ length: 65 }, (_value, index) => node(`n${index}`))),
    );
    const manyResult = run(
      ['collab', 'plan', '--task-root', flow.task, '--config', many, '--json'],
      flow.root,
    );
    assert.equal(manyResult.status, 2, manyResult.stderr);
    assert.ok(
      reportOf(manyResult).diagnostics.some(
        (entry) => entry.code === 'plan_too_large',
      ),
    );

    const huge = flow.planFile(
      'huge.json',
      `{"padding":"${'x'.repeat(600 * 1024)}"}`,
    );
    const hugeResult = run(
      ['collab', 'plan', '--task-root', flow.task, '--config', huge, '--json'],
      flow.root,
    );
    assert.equal(hugeResult.status, 2, hugeResult.stderr);
    assert.ok(
      reportOf(hugeResult).diagnostics.some(
        (entry) => entry.code === 'plan_file_too_large',
      ),
    );
  } finally {
    flow.cleanup();
  }
});

test('missing task state and unsafe paths are refused without reading bodies', () => {
  const flow = makeFlow('plan-cli-unsafe');
  try {
    const file = flow.planFile('plan.json', plan([node('work')]));
    const missingRoot = join(dirname(flow.task), 'absent-task');
    const missing = run(
      [
        'collab',
        'plan',
        '--task-root',
        missingRoot,
        '--config',
        file,
        '--json',
      ],
      flow.root,
    );
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(reportOf(missing).status, 'incomplete');

    const linkedPlan = join(flow.root, 'plan-link.json');
    symlinkSync(file, linkedPlan);
    const linked = run(
      [
        'collab',
        'plan',
        '--task-root',
        flow.task,
        '--config',
        linkedPlan,
        '--json',
      ],
      flow.root,
    );
    assert.equal(linked.status, 2, linked.stderr);
    assert.ok(
      reportOf(linked).diagnostics.some(
        (entry) => entry.code === 'plan_file_symlink',
      ),
    );

    const directoryPlan = join(flow.root, 'plan-directory');
    assert.equal(
      run(
        [
          'collab',
          'plan',
          '--task-root',
          flow.task,
          '--config',
          directoryPlan,
          '--json',
        ],
        flow.root,
      ).status,
      2,
    );

    const linkedTask = join(flow.root, 'task-link');
    symlinkSync(flow.task, linkedTask);
    const redirected = run(
      ['collab', 'plan', '--task-root', linkedTask, '--config', file, '--json'],
      flow.root,
    );
    assert.equal(redirected.status, 1, redirected.stderr);
    assert.equal(reportOf(redirected).status, 'incomplete');
  } finally {
    flow.cleanup();
  }
});

test('flags, help and the JSON contract stay strict', () => {
  const flow = makeFlow('plan-cli-flags');
  try {
    const file = flow.planFile('plan.json', plan([node('work')]));
    const missingTaskRoot = run(
      ['collab', 'plan', '--config', file, '--json'],
      flow.root,
    );
    assert.equal(missingTaskRoot.status, 2);
    const invalidReport = parse(missingTaskRoot);
    assert.equal(invalidReport.schema, COLLAB_WORK_PLAN_REPORT_SCHEMA);
    assert.equal(invalidReport.status, 'invalid');
    assert.equal(
      (invalidReport.diagnostics as { code: string }[])[0]?.code,
      'invalid_arguments',
    );

    assert.equal(
      run(
        ['collab', 'plan', '--task-root', 'relative/path', '--config', file],
        flow.root,
      ).status,
      2,
    );
    assert.equal(
      run(
        [
          'collab',
          'plan',
          '--task-root',
          flow.task,
          '--task-root',
          flow.task,
          '--config',
          file,
        ],
        flow.root,
      ).status,
      2,
    );
    for (const extra of [
      ['--apply'],
      ['--yes'],
      ['--retry'],
      ['--message-id', 'x'],
    ]) {
      assert.equal(
        run(
          [
            'collab',
            'plan',
            '--task-root',
            flow.task,
            '--config',
            file,
            ...extra,
          ],
          flow.root,
        ).status,
        2,
        `expected ${extra.join(' ')} to be refused`,
      );
    }
    const unknown = run(
      ['collab', 'plan', '--task-root', flow.task, '--config', file, '--nope'],
      flow.root,
    );
    assert.equal(unknown.status, 2);

    const usage = run(['collab', 'plan', '--help'], flow.root);
    assert.equal(usage.status, 0);
    assert.match(usage.stdout, /Read-only role and dependency evaluation/);
    assert.match(usage.stdout, /Exit 0 evaluated snapshot/);

    const family = run(['collab', '--help'], flow.root);
    assert.equal(family.status, 0);
    assert.match(family.stdout, /plan --task-root/);
  } finally {
    flow.cleanup();
  }
});

test('a full plan inspection leaves the task bytes untouched', () => {
  const flow = makeFlow('plan-cli-read-only');
  try {
    startAttempt(flow, 'work');
    const reported = finishAttempt(flow, 'work');
    decide(flow, 'work', reported);
    const file = flow.planFile(
      'plan.json',
      plan([node('work'), node('join', { depends_on: ['work'] })]),
    );
    const before = snapshotTree(flow.root);
    const result = run(
      ['collab', 'plan', '--task-root', flow.task, '--config', file, '--json'],
      flow.root,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshotTree(flow.root), before);
  } finally {
    flow.cleanup();
  }
});

test('the human output names roles, blockers and the next action without message bodies', () => {
  const flow = makeFlow('plan-cli-human');
  try {
    startAttempt(flow, 'work');
    finishAttempt(flow, 'work');
    const file = flow.planFile(
      'plan.json',
      plan([
        node('work'),
        node('join', { role: 'reviewer', depends_on: ['work'] }),
      ]),
    );
    const result = run(
      ['collab', 'plan', '--task-root', flow.task, '--config', file],
      flow.root,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Plan plan-cli on task sample: evaluated\./);
    assert.match(
      result.stdout,
      /writer work \(assignment work#1\): awaiting_acceptance/,
    );
    assert.match(result.stdout, /reviewer join/);
    assert.match(result.stdout, /blocked by acceptance_missing/);
    assert.match(
      result.stdout,
      /next: Obtain an explicit coordinator acceptance/,
    );
    assert.match(result.stdout, /read-only/);
    assert.equal(result.stdout.includes('sha256:'), false);
  } finally {
    flow.cleanup();
  }
});

test('the public app entry exposes the same report and keeps the core evaluation nested', async () => {
  const flow = makeFlow('plan-cli-app');
  try {
    startAttempt(flow, 'work');
    const reported = finishAttempt(flow, 'work');
    decide(flow, 'work', reported);
    const file = flow.planFile(
      'plan.json',
      plan([node('work'), node('join', { depends_on: ['work'] })]),
    );
    const report = await inspectWorkPlan({
      taskRoot: flow.task,
      planFile: file,
    });
    assert.equal(report.schema, COLLAB_WORK_PLAN_REPORT_SCHEMA);
    assert.equal(report.status, 'evaluated');
    assert.equal(report.summary?.accepted, 1);
    assert.equal(report.summary?.ready, 1);
    assert.equal(report.core?.schema, 'pappra/collab-work-plan-evaluation/1');
    assert.deepEqual(report.core?.accepted_nodes, ['work']);
    assert.ok(report.limits.includes('no_native_query'));
    assert.equal(typeof publicInspectWorkPlan, 'function');
  } finally {
    flow.cleanup();
  }
});

/** Rewrites a registered message with legal trailing whitespace up to `targetBytes`. */
function padMessageFile(
  flow: Flow,
  messageId: string,
  targetBytes: number,
): number {
  const file = join(flow.task, 'messages', `${messageId}.json`);
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Message;
  const base = JSON.stringify(stored, null, 2);
  const padding = targetBytes - Buffer.byteLength(base) - 1;
  assert.ok(padding > 0, 'padding target must exceed the serialized envelope');
  const text = `${base}\n${' '.repeat(padding)}`;
  writeFileSync(file, text);
  return Buffer.byteLength(text);
}

function fileBytes(flow: Flow, messageId: string): number {
  return Buffer.byteLength(
    readFileSync(join(flow.task, 'messages', `${messageId}.json`)),
  );
}

test('unrelated task decisions are never loaded and cannot block a narrow plan', () => {
  for (const kind of ['missing', 'corrupt', 'oversized'] as const) {
    const flow = makeFlow(`plan-cli-unrelated-${kind}`);
    try {
      startAttempt(flow, 'noise');
      const noiseReport = finishAttempt(flow, 'noise');
      const noiseDecision = decide(flow, 'noise', noiseReport);
      startAttempt(flow, 'work');
      const workReport = finishAttempt(flow, 'work');
      decide(flow, 'work', workReport);

      const noiseFile = join(
        flow.task,
        'messages',
        `${noiseDecision.message_id}.json`,
      );
      if (kind === 'missing') rmSync(noiseFile);
      if (kind === 'corrupt') writeFileSync(noiseFile, '{ not json');
      if (kind === 'oversized')
        padMessageFile(flow, noiseDecision.message_id, 1_500_000);

      const file = flow.planFile('plan.json', plan([node('work')]));
      const result = run(
        [
          'collab',
          'plan',
          '--task-root',
          flow.task,
          '--config',
          file,
          '--json',
        ],
        flow.root,
      );
      assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
      const report = reportOf(result);
      assert.equal(report.status, 'evaluated', kind);
      assert.equal(statusOf(report, 'work'), 'accepted', kind);
      assert.deepEqual(report.core?.accepted_nodes, ['work'], kind);
      assert.equal(report.evidence.registered_decisions, 1, kind);
      assert.equal(report.evidence.supplied, 1, kind);
      assert.deepEqual(report.evidence.unreadable, [], kind);
    } finally {
      flow.cleanup();
    }
  }
});

test('a small plan stays evaluated in a task with many unrelated decisions', () => {
  const flow = makeFlow('plan-cli-many-unrelated');
  try {
    startAttempt(flow, 'noise');
    const noiseReport = finishAttempt(flow, 'noise');
    for (let index = 0; index < 140; index += 1) {
      decide(flow, 'noise', noiseReport);
    }
    startAttempt(flow, 'work');
    const workReport = finishAttempt(flow, 'work');
    decide(flow, 'work', workReport);
    const file = flow.planFile('plan.json', plan([node('work')]));
    const result = run(
      ['collab', 'plan', '--task-root', flow.task, '--config', file, '--json'],
      flow.root,
    );
    assert.equal(result.status, 0, result.stderr);
    const report = reportOf(result);
    assert.equal(report.status, 'evaluated');
    assert.equal(report.evidence.registered_decisions, 1);
    assert.equal(report.evidence.supplied, 1);
    assert.equal(report.evidence.over_budget, false);
    assert.equal(statusOf(report, 'work'), 'accepted');
  } finally {
    flow.cleanup();
  }
});

test('raw padded decision bytes exhaust the read budget before any readiness is claimed', () => {
  const flow = makeFlow('plan-cli-padded-budget');
  try {
    startAttempt(flow, 'work');
    const reported = finishAttempt(flow, 'work');
    const decisions: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const decision = decide(flow, 'work', reported);
      decisions.push(decision.message_id);
      padMessageFile(flow, decision.message_id, 900 * 1024);
    }
    const totalRaw = decisions.reduce(
      (sum, id) => sum + fileBytes(flow, id),
      0,
    );
    assert.ok(totalRaw > 4 * 1024 * 1024);

    const file = flow.planFile('plan.json', plan([node('work')]));
    const result = run(
      ['collab', 'plan', '--task-root', flow.task, '--config', file, '--json'],
      flow.root,
    );
    assert.equal(result.status, 1, result.stderr);
    const report = reportOf(result);
    assert.equal(report.status, 'incomplete');
    assert.equal(report.evidence.registered_decisions, 8);
    assert.equal(report.evidence.over_budget, true);
    assert.ok(report.evidence.raw_bytes <= 4 * 1024 * 1024);
    assert.equal(report.evidence.aggregate_limit, 4 * 1024 * 1024);
    assert.ok(
      report.diagnostics.some(
        (entry) => entry.code === 'decision_evidence_over_budget',
      ),
    );
    assert.deepEqual(report.core?.accepted_nodes, []);
  } finally {
    flow.cleanup();
  }
});

test('an actual oversized decision payload is refused before a full read', () => {
  const flow = makeFlow('plan-cli-payload-budget');
  try {
    startAttempt(flow, 'work');
    const reported = finishAttempt(flow, 'work');
    const decision = flow.send({
      message_id: 'msg-heavy-answer',
      type: 'ANSWER',
      task_id: TASK,
      from: COORDINATOR,
      to: WRITER_A,
      reply_to: reported.message_id,
      subtask_id: 'work',
      attempt: 1,
      owner_epoch: 1,
      body: {
        acceptance: {
          plan_id: PLAN_ID,
          node_id: 'work',
          assignment_id: 'work',
          attempt: 1,
          input_revision: INPUT,
          report_message_id: reported.message_id,
          report_digest: reported.content_digest,
          decision: 'accepted',
        },
        note: 'x'.repeat(1_200_000),
      },
    });
    assert.ok(fileBytes(flow, decision.message_id) > 1024 * 1024);
    const file = flow.planFile('plan.json', plan([node('work')]));
    const result = run(
      ['collab', 'plan', '--task-root', flow.task, '--config', file, '--json'],
      flow.root,
    );
    assert.equal(result.status, 1, result.stderr);
    const report = reportOf(result);
    assert.equal(report.status, 'incomplete');
    assert.equal(report.evidence.over_budget, true);
    assert.equal(report.evidence.raw_bytes, 0);
    assert.equal(report.evidence.per_file_limit, 1024 * 1024);
    assert.deepEqual(report.core?.accepted_nodes, []);
  } finally {
    flow.cleanup();
  }
});

test('rejected envelopes still consume the aggregate read budget', () => {
  // Corrupt JSON: each file is read and charged before the parse fails.
  const corrupt = makeFlow('plan-cli-corrupt-budget');
  try {
    startAttempt(corrupt, 'work');
    const reported = finishAttempt(corrupt, 'work');
    const decisions: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const decision = decide(corrupt, 'work', reported);
      decisions.push(decision.message_id);
      const file = join(
        corrupt.task,
        'messages',
        `${decision.message_id}.json`,
      );
      // Unbalanced JSON: the bytes are read first, so the parse failure is charged.
      const prefix = '{"broken": "';
      writeFileSync(file, `${prefix}${'x'.repeat(900 * 1024 - prefix.length)}`);
      assert.equal(fileBytes(corrupt, decision.message_id), 900 * 1024);
    }
    const totalRaw = decisions.reduce(
      (sum, id) => sum + fileBytes(corrupt, id),
      0,
    );
    assert.ok(totalRaw > 4 * 1024 * 1024);

    const file = corrupt.planFile('plan.json', plan([node('work')]));
    const result = run(
      [
        'collab',
        'plan',
        '--task-root',
        corrupt.task,
        '--config',
        file,
        '--json',
      ],
      corrupt.root,
    );
    assert.equal(result.status, 1, result.stderr);
    const report = reportOf(result);
    assert.equal(report.status, 'incomplete');
    assert.equal(report.evidence.supplied, 0);
    assert.equal(report.evidence.over_budget, true);
    assert.ok(report.evidence.raw_bytes > 0);
    assert.ok(report.evidence.raw_bytes <= 4 * 1024 * 1024);
    // The read stops inside the aggregate budget instead of consuming all eight files.
    assert.ok(report.evidence.unreadable.length < 8);
    assert.ok(
      report.evidence.unreadable.every(
        (entry) => entry.code === 'message_corrupt',
      ),
    );
    assert.ok(
      report.diagnostics.some(
        (entry) => entry.code === 'decision_evidence_over_budget',
      ),
    );
    assert.deepEqual(report.core?.accepted_nodes, []);
  } finally {
    corrupt.cleanup();
  }

  // A syntactically valid envelope that no longer matches its registered digest, or that
  // carries another identity, is equally charged before the refusal.
  for (const kind of ['digest', 'identity'] as const) {
    const flow = makeFlow(`plan-cli-${kind}-budget`);
    try {
      startAttempt(flow, 'work');
      const reported = finishAttempt(flow, 'work');
      const decisions: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        const decision = decide(flow, 'work', reported);
        decisions.push(decision.message_id);
        const stored = JSON.parse(
          readFileSync(
            join(flow.task, 'messages', `${decision.message_id}.json`),
            'utf8',
          ),
        ) as Message;
        if (kind === 'digest') {
          stored.body['acceptance'] = {
            ...(stored.body['acceptance'] as Record<string, unknown>),
            input_revision: `sha256:${'9'.repeat(64)}`,
          };
        } else {
          stored.message_id = 'msg-renamed-identity';
        }
        const base = JSON.stringify(stored, null, 2);
        const padding = 900 * 1024 - Buffer.byteLength(base) - 1;
        writeFileSync(
          join(flow.task, 'messages', `${decision.message_id}.json`),
          `${base}\n${' '.repeat(padding)}`,
        );
      }
      const file = flow.planFile('plan.json', plan([node('work')]));
      const result = run(
        [
          'collab',
          'plan',
          '--task-root',
          flow.task,
          '--config',
          file,
          '--json',
        ],
        flow.root,
      );
      assert.equal(result.status, 1, `${kind}: ${result.stderr}`);
      const report = reportOf(result);
      assert.equal(report.evidence.supplied, 0, kind);
      assert.equal(report.evidence.over_budget, true, kind);
      assert.ok(report.evidence.raw_bytes > 0, kind);
      assert.ok(report.evidence.raw_bytes <= 4 * 1024 * 1024, kind);
      assert.ok(report.evidence.unreadable.length < 8, kind);
      assert.deepEqual(report.core?.accepted_nodes, [], kind);
    } finally {
      flow.cleanup();
    }
  }
});
