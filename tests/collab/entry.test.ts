import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  FixtureController,
  PiRpcController,
  admitPrepared,
  driveRun,
  inspectPreparedHistory,
  prepareCollaboration,
  startPrepared,
  validateLaunchToken,
} from '../../src/app/collaboration.js';
import { fingerprintSkill } from '../../src/collab/fingerprint.js';
import { admitLaunch } from '../../src/collab/admission.js';
import { readRecord } from '../../src/collab/store.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

const SKILL_PATH = join(process.cwd(), 'src/assets/integrations/skills/pappra');
const SKILL_BUNDLE = fingerprintSkill(SKILL_PATH).bundle_digest;

function setup() {
  const root = makeTempDir('p10-entry');
  const cwd = join(root, 'workspace');
  const domainRoot = join(root, 'domain');
  mkdirSync(cwd, { recursive: true });
  const goal = {
    schema: 'pappra/collaboration-goal/1',
    task_id: 'p10-task',
    subtask_id: 'slice',
    attempt: 1,
    phase: 'implementation',
    objective: 'Implement the bounded collaboration entry.',
    acceptance: ['one dispatch', 'validated result'],
    prompt: 'Use the frozen goal only.',
    coordinator: {
      agent_id: 'coordinator',
      session_id: 'coordinator-session',
      harness: 'codex',
      owner_epoch: 1,
    },
    assignee: {
      agent_id: 'worker',
      session_id: 'worker-session',
      harness: 'pi',
      surface: 'fixture',
      cwd,
      configuration_id: 'fixture-config',
    },
    resources: [{ path: cwd, access: 'write' }],
    required: {
      skills: [{ id: 'workspace/harness-collab', bundle_digest: SKILL_BUNDLE }],
      tools: ['read'],
    },
    preferred: { skills: [], tools: [] },
  };
  const card = {
    schema: 'harness-collab/capabilities/1',
    agent_id: 'worker',
    session_id: 'worker-session',
    harness: 'pi',
    surface: 'fixture',
    configuration_id: 'fixture-config',
    cwd,
    observed_at: new Date().toISOString(),
    evidence_level: 'runtime',
    skills: [
      {
        id: 'workspace/harness-collab',
        path: SKILL_PATH,
        bundle_digest: SKILL_BUNDLE,
        state: 'verified',
        evidence_ref: 'session:worker-session',
      },
    ],
    tools: [
      {
        id: 'read',
        state: 'verified',
        evidence_ref: 'session:worker-session',
      },
    ],
  };
  return { root, cwd, domainRoot, goal, card };
}

function writeCard(file: string, card: unknown): void {
  writeFileSync(file, `${JSON.stringify(card, null, 2)}\n`);
}

async function* streaming(items: readonly unknown[]): AsyncIterable<unknown> {
  for (const item of items) yield item;
}

test('prepares, admits, dispatches once, and deduplicates a REPORT', async () => {
  const fixture = setup();
  try {
    const prepared = await prepareCollaboration(fixture.goal, {
      domainRoot: fixture.domainRoot,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const cardPath = join(fixture.root, 'card.json');
    writeCard(cardPath, fixture.card);
    const outputPath = join(fixture.root, 'result.txt');
    writeFileSync(outputPath, 'bounded result\n');
    const outputDigest = `sha256:${createHash('sha256')
      .update(readFileSync(outputPath))
      .digest('hex')}`;
    const admitted = await admitPrepared(
      join(prepared.value.prepared.prepared_dir, 'prepared.json'),
      cardPath,
    );
    assert.equal(admitted.ok, true);
    if (!admitted.ok) return;
    const started = await startPrepared(
      join(prepared.value.prepared.prepared_dir, 'prepared.json'),
      {
        capabilitiesFile: cardPath,
        controller: new FixtureController({
          outputs: [{ ref: outputPath, digest: outputDigest }],
        }),
        controllerId: 'fixture',
      },
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(
      validateLaunchToken(started.value.token, {
        taskRoot: started.value.prepared.task_root,
        assignmentDigest: started.value.prepared.assignment_digest,
        subtaskId: 'slice',
        attempt: 1,
      }),
      false,
    );

    const events: unknown[] = [];
    const result = await driveRun(
      started.value,
      streaming([
        {
          schema: 'pappra/collaboration-command/1',
          action: 'query',
          request_id: 'q1',
        },
        {
          schema: 'pappra/collaboration-command/1',
          action: 'cancel',
          request_id: 'c1',
        },
        {
          schema: 'pappra/collaboration-command/1',
          action: 'finish',
          request_id: 'f1',
          status: 'completed',
        },
      ]),
      (event) => events.push(event),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.duplicate, false);
    assert.equal(
      (events as { kind?: string }[]).some((event) => event.kind === 'query'),
      true,
    );
    assert.equal(
      (events as { kind?: string }[]).some((event) => event.kind === 'cancel'),
      true,
    );

    const duplicate = await driveRun(
      started.value,
      streaming([
        {
          schema: 'pappra/collaboration-command/1',
          action: 'finish',
          request_id: 'f2',
          status: 'completed',
        },
      ]),
      () => undefined,
    );
    assert.equal(duplicate.ok, true);
    if (duplicate.ok) assert.equal(duplicate.value.duplicate, true);

    const history = inspectPreparedHistory(
      join(prepared.value.prepared.prepared_dir, 'prepared.json'),
    );
    assert.equal(history.ok, true);
    if (history.ok) assert.equal(history.value.live_owner, 'unknown');
  } finally {
    cleanup(fixture.root);
  }
});

test('parallel fixture dispatch reserves exactly one attempt and forged tokens fail', async () => {
  const fixture = setup();
  try {
    const prepared = await prepareCollaboration(fixture.goal, {
      domainRoot: fixture.domainRoot,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const preparedFile = join(
      prepared.value.prepared.prepared_dir,
      'prepared.json',
    );
    const cardPath = join(fixture.root, 'card.json');
    writeCard(cardPath, fixture.card);
    const starts = await Promise.all([
      startPrepared(preparedFile, {
        capabilitiesFile: cardPath,
        controller: new FixtureController(),
        controllerId: 'fixture',
      }),
      startPrepared(preparedFile, {
        capabilitiesFile: cardPath,
        controller: new FixtureController(),
        controllerId: 'fixture',
      }),
    ]);
    assert.equal(starts.filter((entry) => entry.ok).length, 1);
    const forged = await new FixtureController().start(Object.freeze({}), {
      prepared: prepared.value.prepared,
      goal: prepared.value.goal,
      assignment: prepared.value.assignment,
      capabilitiesFile: cardPath,
      prompt: prepared.value.goal.prompt,
      promptFile: prepared.value.prepared.prompt_path,
      taskRoot: prepared.value.prepared.task_root,
      evidenceDir: join(fixture.root, 'evidence'),
    });
    assert.equal(forged.ok, false);
  } finally {
    cleanup(fixture.root);
  }
});

test('prepared artifacts are independent of a source checkout and bounded', async () => {
  const fixture = setup();
  try {
    const prepared = await prepareCollaboration(fixture.goal, {
      domainRoot: fixture.domainRoot,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const preparedFile = join(
      prepared.value.prepared.prepared_dir,
      'prepared.json',
    );
    const manifest = JSON.parse(readFileSync(preparedFile, 'utf8')) as {
      assignment_path: string;
    };
    assert.equal(manifest.assignment_path.endsWith('assignment.json'), true);
    assert.equal(
      readFileSync(prepared.value.prepared.prompt_path, 'utf8').length > 0,
      true,
    );
  } finally {
    cleanup(fixture.root);
  }
});

test('refuses a changed goal, mismatched session, and stale capability card', async () => {
  const fixture = setup();
  try {
    const first = await prepareCollaboration(fixture.goal, {
      domainRoot: fixture.domainRoot,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const preparedFile = join(
      first.value.prepared.prepared_dir,
      'prepared.json',
    );
    const changed = await prepareCollaboration(
      { ...fixture.goal, objective: 'A different objective.' },
      { domainRoot: fixture.domainRoot },
    );
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.equal(changed.code, 'goal_changed');

    const cardPath = join(fixture.root, 'card.json');
    writeCard(cardPath, {
      ...fixture.card,
      session_id: 'another-session',
    });
    const mismatch = await admitPrepared(preparedFile, cardPath);
    assert.equal(mismatch.ok, false);

    writeCard(cardPath, {
      ...fixture.card,
      observed_at: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const stale = await admitPrepared(preparedFile, cardPath);
    assert.equal(stale.ok, false);
  } finally {
    cleanup(fixture.root);
  }
});

function roleGoal(
  root: string,
  overrides: {
    readonly harness?: string;
    readonly roles?: string[];
    readonly cwd?: string;
    readonly taskId?: string;
  } = {},
) {
  const taskId = overrides.taskId ?? 'role-task';
  const resourcePath = join(root, `${taskId}.txt`);
  writeFileSync(resourcePath, 'first resource is a regular file\n');
  return {
    schema: 'pappra/collaboration-goal/1' as const,
    task_id: taskId,
    subtask_id: 'slice',
    attempt: 1,
    phase: 'fix' as const,
    objective: 'Explicit role and runner metadata regression.',
    acceptance: ['one prepared bundle'],
    prompt: 'Use only the frozen prompt.',
    coordinator: {
      agent_id: 'coordinator-custom',
      session_id: 'coordinator-session-custom',
      harness: 'codex',
      owner_epoch: 2,
    },
    assignee: {
      agent_id: 'worker-custom',
      session_id: 'worker-session-custom',
      harness: overrides.harness ?? 'pi',
      surface: 'cli',
      cwd: overrides.cwd ?? join(root, 'assignee-cwd'),
      configuration_id: 'daily-herdr-custom',
    },
    resources: [{ path: resourcePath, access: 'write' as const }],
    required: { skills: [], tools: ['read'] },
    preferred: { skills: [], tools: ['bash'] },
    ...(overrides.roles === undefined ? {} : { roles: overrides.roles }),
  };
}

test('prepare preserves explicit roles and maps supported runners', async () => {
  const root = makeTempDir('p10-roles');
  try {
    mkdirSync(join(root, 'assignee-cwd'), { recursive: true });
    const domainRoot = join(root, 'domain');
    const defaulted = await prepareCollaboration(roleGoal(root), {
      domainRoot,
      clock: 1_000,
    });
    assert.equal(defaulted.ok, true);
    if (!defaulted.ok) return;
    assert.deepEqual(defaulted.value.goal.roles, ['implementer']);
    assert.deepEqual(defaulted.value.assignment.roles, ['implementer']);
    assert.deepEqual(defaulted.value.assignment.required, {
      skills: [],
      tools: ['read'],
    });
    assert.deepEqual(defaulted.value.assignment.preferred, {
      skills: [],
      tools: ['bash'],
    });
    assert.equal(
      defaulted.value.assignment.coordinator.agent_id,
      'coordinator-custom',
    );
    assert.equal(
      defaulted.value.assignment.assignee.configuration_id,
      'daily-herdr-custom',
    );

    const explicit = await prepareCollaboration(
      roleGoal(root, {
        roles: ['reviewer', 'implementer'],
        taskId: 'explicit-role-task',
      }),
      { domainRoot, clock: 2_000 },
    );
    assert.equal(explicit.ok, true);
    if (!explicit.ok) return;
    assert.deepEqual(explicit.value.goal.roles, ['reviewer', 'implementer']);
    assert.deepEqual(explicit.value.assignment.roles, [
      'reviewer',
      'implementer',
    ]);
    assert.equal(explicit.value.goal.phase, 'fix');

    const expected = new Map([
      ['pi', 'pi-cli'],
      ['codex', 'codex-exec'],
      ['claude', 'claude-cli'],
    ]);
    for (const [harness, runner] of expected) {
      const cwd = join(root, `${harness}-cwd`);
      mkdirSync(cwd, { recursive: true });
      const result = await prepareCollaboration(
        roleGoal(root, { harness, cwd, taskId: `runner-${harness}-task` }),
        { domainRoot, clock: 3_000 },
      );
      assert.equal(result.ok, true, harness);
      if (!result.ok) return;
      assert.equal(result.value.assignment.runner.name, runner, harness);
      assert.equal(result.value.assignment.runner.mode, 'native');
    }
  } finally {
    cleanup(root);
  }
});

test('prepare refuses unsupported harness, invalid cwd and roles before task writes', async () => {
  const root = makeTempDir('p10-roles-refusals');
  try {
    mkdirSync(join(root, 'assignee-cwd'), { recursive: true });
    const domainRoot = join(root, 'domain');
    for (const harness of ['gemini', 'constructor', 'toString', '__proto__']) {
      const unsupported = await prepareCollaboration(
        roleGoal(root, {
          harness,
          taskId: `unsupported-${harness}`,
        }),
        { domainRoot },
      );
      assert.equal(unsupported.ok, false, harness);
      if (!unsupported.ok)
        assert.equal(unsupported.code, 'assignee_harness_unsupported', harness);
      assert.equal(
        existsSync(join(domainRoot, 'tasks')),
        false,
        `${harness} must be refused before task artifacts`,
      );
    }

    const missingCwd = await prepareCollaboration(
      roleGoal(root, {
        cwd: join(root, 'missing-directory'),
        taskId: 'missing-cwd-task',
      }),
      { domainRoot },
    );
    assert.equal(missingCwd.ok, false);
    if (!missingCwd.ok) assert.equal(missingCwd.code, 'cwd_unavailable');

    const fileCwd = await prepareCollaboration(
      roleGoal(root, {
        cwd: join(root, 'file-cwd-task.txt'),
        taskId: 'file-cwd-task',
      }),
      { domainRoot },
    );
    assert.equal(fileCwd.ok, false);
    if (!fileCwd.ok) assert.equal(fileCwd.code, 'cwd_unavailable');

    const symlinkCwd = join(root, 'symlink-cwd');
    symlinkSync(join(root, 'assignee-cwd'), symlinkCwd);
    const linkedCwd = await prepareCollaboration(
      roleGoal(root, { cwd: symlinkCwd, taskId: 'symlink-cwd-task' }),
      { domainRoot },
    );
    assert.equal(linkedCwd.ok, false);
    if (!linkedCwd.ok) assert.equal(linkedCwd.code, 'cwd_unavailable');

    const duplicateRoles = await prepareCollaboration(
      roleGoal(root, {
        roles: ['implementer', 'implementer'],
        taskId: 'duplicate-roles-task',
      }),
      { domainRoot },
    );
    assert.equal(duplicateRoles.ok, false);
    if (!duplicateRoles.ok) assert.equal(duplicateRoles.code, 'goal_invalid');
    assert.equal(existsSync(join(domainRoot, 'tasks')), false);
  } finally {
    cleanup(root);
  }
});

test('startPrepared refuses a real controller on a foreign harness without launching', async () => {
  const root = makeTempDir('p10-controller-harness');
  try {
    mkdirSync(join(root, 'assignee-cwd'), { recursive: true });
    const prepared = await prepareCollaboration(
      roleGoal(root, { harness: 'codex' }),
      { domainRoot: join(root, 'domain') },
    );
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const refused = await startPrepared(
      join(prepared.value.prepared.prepared_dir, 'prepared.json'),
      {
        capabilitiesFile: join(root, 'missing-card.json'),
        controller: new PiRpcController(),
        controllerId: 'pi-rpc',
      },
    );
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, 'controller_harness_mismatch');
    const record = JSON.parse(
      readFileSync(
        join(prepared.value.prepared.task_root, 'task.json'),
        'utf8',
      ),
    ) as { launch_reservations?: unknown };
    assert.equal(record.launch_reservations, undefined);
  } finally {
    cleanup(root);
  }
});

test('admission rejects inherited runner keys using the shared supported mapping', async () => {
  const fixture = setup();
  try {
    const prepared = await prepareCollaboration(fixture.goal, {
      domainRoot: fixture.domainRoot,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const capabilitiesFile = join(fixture.root, 'card.json');
    writeCard(capabilitiesFile, fixture.card);
    const before = readRecord(prepared.value.prepared.task_root);
    assert(before);

    for (const harness of ['constructor', 'toString', '__proto__']) {
      const assignmentFile = join(fixture.root, `${harness}-assignment.json`);
      const assignment = {
        ...prepared.value.assignment,
        assignee: { ...prepared.value.assignment.assignee, harness },
        runner: { ...prepared.value.assignment.runner, name: 'pi-cli' },
      };
      writeFileSync(assignmentFile, `${JSON.stringify(assignment, null, 2)}\n`);
      const admission = admitLaunch({
        assignmentFile,
        capabilitiesFile,
        taskRoot: prepared.value.prepared.task_root,
        cwd: fixture.goal.assignee.cwd,
        sessionId: fixture.goal.assignee.session_id,
      });
      assert.equal(admission.ok, false, harness);
      if (!admission.ok) assert.equal(admission.reason, 'unsupported_harness');
      assert.equal(
        readRecord(prepared.value.prepared.task_root)?.state_revision,
        before.state_revision,
      );
    }
  } finally {
    cleanup(fixture.root);
  }
});
