import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  FixtureController,
  admitPrepared,
  driveRun,
  inspectPreparedHistory,
  prepareCollaboration,
  startPrepared,
  validateLaunchToken,
} from '../../src/app/collaboration.js';
import { fingerprintSkill } from '../../src/collab/fingerprint.js';
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
