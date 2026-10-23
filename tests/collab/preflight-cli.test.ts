import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

const ROOT = realpathSync(
  dirname(fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json'))),
);
const CLI = join(ROOT, 'dist/cli/main.js');

function digest(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

interface Fixture {
  readonly root: string;
  readonly cwd: string;
  readonly inputFile: string;
  readonly assignmentFile: string;
  readonly cardFile: string;
}

function setup(label: string): Fixture {
  const root = realpathSync(makeTempDir(label));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const inputFile = join(root, 'input.json');
  writeFileSync(inputFile, '{"pin":1}\n');
  const assignment = {
    schema: 'harness-collab/assignment/1',
    task_id: 'c2-cli-task',
    assignment_id: 'c2-cli-preflight',
    attempt: 1,
    objective: 'Installed preflight route.',
    acceptance: ['readiness is reported'],
    roles: ['implementer'],
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
      surface: 'cli',
      cwd,
      configuration_id: 'fixture-config',
    },
    inputs: [{ ref: inputFile, digest: digest('{"pin":1}\n') }],
    resources: [{ path: cwd, access: 'write', resource_epoch: 1 }],
    runner: {
      name: 'existing-session',
      mode: 'native-session',
      omitted_capabilities: [],
    },
    required: { skills: [], tools: ['read'] },
    preferred: { skills: [], tools: [] },
  };
  const card = {
    schema: 'harness-collab/capabilities/1',
    agent_id: 'worker',
    session_id: 'worker-session',
    harness: 'pi',
    surface: 'cli',
    configuration_id: 'fixture-config',
    cwd,
    observed_at: new Date().toISOString(),
    evidence_level: 'runtime',
    skills: [],
    tools: [
      {
        id: 'read',
        state: 'callable',
        evidence_ref: 'session:worker-session',
      },
    ],
  };
  const assignmentFile = join(root, 'assignment.json');
  const cardFile = join(root, 'card.json');
  writeFileSync(assignmentFile, `${JSON.stringify(assignment, null, 2)}\n`);
  writeFileSync(cardFile, `${JSON.stringify(card, null, 2)}\n`);
  return { root, cwd, inputFile, assignmentFile, cardFile };
}

function run(args: readonly string[], cwd: string, timeout = 30_000) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout,
  });
}

function snapshot(paths: readonly string[]): string[] {
  return paths.map((path) => {
    const stat = lstatSync(path);
    return `${path}:${stat.mtimeMs}:${digest(readFileSync(path, 'utf8'))}`;
  });
}

test('installed preflight reports readiness from an unrelated cwd without writes', () => {
  const value = setup('c2-cli');
  try {
    const unrelated = join(value.root, 'elsewhere');
    mkdirSync(unrelated, { recursive: true });
    const before = snapshot([
      value.assignmentFile,
      value.cardFile,
      value.inputFile,
    ]);
    const ready = run(
      [
        'collab',
        'preflight',
        '--assignment',
        value.assignmentFile,
        '--capabilities',
        value.cardFile,
        '--json',
      ],
      unrelated,
    );
    assert.equal(ready.status, 0, ready.stderr);
    const readyValue = JSON.parse(ready.stdout) as {
      schema: string;
      ok: boolean;
      status: string;
      task_id: string;
      assignment_id: string;
      attempt: number;
      checked_at: string;
      blockers: unknown[];
      warnings: { code: string }[];
      limits: string[];
    };
    assert.equal(readyValue.schema, 'pappra/collaboration-preflight/1');
    assert.equal(readyValue.ok, true);
    assert.equal(readyValue.status, 'ready');
    assert.equal(readyValue.task_id, 'c2-cli-task');
    assert.equal(readyValue.assignment_id, 'c2-cli-preflight');
    assert.equal(readyValue.attempt, 1);
    assert.equal(typeof readyValue.checked_at, 'string');
    assert.deepEqual(readyValue.blockers, []);
    assert.deepEqual(
      readyValue.warnings.map((entry) => entry.code),
      ['resource_ownership_not_enforced'],
    );
    assert.deepEqual(readyValue.limits, [
      'reported_runtime_evidence_only',
      'authorization_not_checked',
      'no_resource_lock',
      'no_dispatch',
    ]);
    assert.deepEqual(
      snapshot([value.assignmentFile, value.cardFile, value.inputFile]),
      before,
    );

    const declared = JSON.parse(readFileSync(value.cardFile, 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      value.cardFile,
      `${JSON.stringify({ ...declared, evidence_level: 'declared' }, null, 2)}\n`,
    );
    const needsInput = run(
      [
        'collab',
        'preflight',
        '--assignment',
        value.assignmentFile,
        '--capabilities',
        value.cardFile,
        '--json',
      ],
      unrelated,
    );
    assert.equal(needsInput.status, 1, needsInput.stderr);
    const needsValue = JSON.parse(needsInput.stdout) as {
      ok: boolean;
      status: string;
      blockers: { code: string }[];
    };
    assert.equal(needsValue.ok, false);
    assert.equal(needsValue.status, 'needs_input');
    assert.deepEqual(
      needsValue.blockers.map((entry) => entry.code),
      ['runtime_capabilities_unconfirmed'],
    );

    const human = run(
      [
        'collab',
        'preflight',
        '--assignment',
        value.assignmentFile,
        '--capabilities',
        value.cardFile,
      ],
      unrelated,
    );
    assert.equal(human.status, 1);
    assert.match(human.stdout, /needs input/);
    assert.match(human.stdout, /runtime_capabilities_unconfirmed/);
  } finally {
    cleanup(value.root);
  }
});

test('installed preflight rejects invalid inputs and options with exit 2', () => {
  const value = setup('c2-cli-invalid');
  try {
    writeFileSync(value.assignmentFile, '{"secret":"do-not-print", bad\n');
    const malformed = run(
      [
        'collab',
        'preflight',
        '--assignment',
        value.assignmentFile,
        '--capabilities',
        value.cardFile,
        '--json',
      ],
      value.root,
    );
    assert.equal(malformed.status, 2);
    const malformedValue = JSON.parse(malformed.stdout) as {
      status: string;
      errors: string[];
    };
    assert.equal(malformedValue.status, 'invalid');
    assert.equal(malformedValue.errors[0]?.includes('do-not-print'), false);

    const missing = run(['collab', 'preflight', '--json'], value.root);
    assert.equal(missing.status, 2);
    const missingValue = JSON.parse(missing.stdout) as { code: string };
    assert.equal(missingValue.code, 'assignment_required');

    const badAge = run(
      [
        'collab',
        'preflight',
        '--assignment',
        value.assignmentFile,
        '--capabilities',
        value.cardFile,
        '--max-age-minutes',
        '0',
        '--json',
      ],
      value.root,
    );
    assert.equal(badAge.status, 2);
    const badAgeValue = JSON.parse(badAge.stdout) as { code: string };
    assert.equal(badAgeValue.code, 'max_age_invalid');

    const duplicate = run(
      [
        'collab',
        'preflight',
        '--assignment',
        value.assignmentFile,
        '--assignment',
        value.assignmentFile,
        '--capabilities',
        value.cardFile,
        '--json',
      ],
      value.root,
    );
    assert.equal(duplicate.status, 2);

    const apply = run(
      [
        'collab',
        'preflight',
        '--assignment',
        value.assignmentFile,
        '--capabilities',
        value.cardFile,
        '--apply',
        '--json',
      ],
      value.root,
    );
    assert.equal(apply.status, 2);

    const wrongAction = run(
      [
        'collab',
        'prepare',
        '--assignment',
        value.assignmentFile,
        '--goal',
        join(value.root, 'goal.json'),
        '--json',
      ],
      value.root,
    );
    assert.equal(wrongAction.status, 2);

    const linked = join(value.root, 'linked-assignment.json');
    symlinkSync(value.assignmentFile, linked);
    const symlink = run(
      [
        'collab',
        'preflight',
        '--assignment',
        linked,
        '--capabilities',
        value.cardFile,
        '--json',
      ],
      value.root,
    );
    assert.equal(symlink.status, 2);

    const help = run(['collab', '--help'], value.root);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /preflight --assignment/);
  } finally {
    cleanup(value.root);
  }
});

test('FIFO assignment and capabilities are refused promptly without blocking', () => {
  const value = setup('c2-cli-fifo');
  try {
    const assignmentFifo = join(value.root, 'assignment.fifo');
    const madeAssignment = spawnSync('mkfifo', [assignmentFifo], {
      encoding: 'utf8',
    });
    if (madeAssignment.status !== 0) return;
    const startedAt = Date.now();
    const assignmentResult = run(
      [
        'collab',
        'preflight',
        '--assignment',
        assignmentFifo,
        '--capabilities',
        value.cardFile,
        '--json',
      ],
      value.root,
      2000,
    );
    assert.equal(assignmentResult.error, undefined);
    assert.equal(assignmentResult.signal, null);
    assert.equal(assignmentResult.status, 2);
    assert(Date.now() - startedAt < 1900);
    const assignmentValue = JSON.parse(assignmentResult.stdout) as {
      status: string;
      errors: string[];
    };
    assert.equal(assignmentValue.status, 'invalid');
    assert.match(String(assignmentValue.errors[0]), /regular file/);

    const capabilitiesFifo = join(value.root, 'capabilities.fifo');
    const madeCapabilities = spawnSync('mkfifo', [capabilitiesFifo], {
      encoding: 'utf8',
    });
    assert.equal(madeCapabilities.status, 0);
    const capabilitiesResult = run(
      [
        'collab',
        'preflight',
        '--assignment',
        value.assignmentFile,
        '--capabilities',
        capabilitiesFifo,
        '--json',
      ],
      value.root,
      2000,
    );
    assert.equal(capabilitiesResult.error, undefined);
    assert.equal(capabilitiesResult.signal, null);
    assert.equal(capabilitiesResult.status, 2);
    const capabilitiesValue = JSON.parse(capabilitiesResult.stdout) as {
      status: string;
      errors: string[];
    };
    assert.equal(capabilitiesValue.status, 'invalid');
    assert.match(String(capabilitiesValue.errors[0]), /regular file/);
  } finally {
    cleanup(value.root);
  }
});

test('needs-input human output groups actionable recovery and leaves JSON semantics unchanged', () => {
  const value = setup('e1-preflight-recovery');
  try {
    const preflight = (file: string, json: boolean) =>
      run(
        [
          'collab',
          'preflight',
          '--assignment',
          value.assignmentFile,
          '--capabilities',
          file,
          ...(json ? ['--json'] : []),
        ],
        value.root,
      );
    const variant = (
      name: string,
      mutate: (card: Record<string, unknown>) => void,
    ): string => {
      const card = JSON.parse(readFileSync(value.cardFile, 'utf8')) as Record<
        string,
        unknown
      >;
      mutate(card);
      const file = join(value.root, `card.${name}.json`);
      writeFileSync(file, `${JSON.stringify(card, null, 2)}\n`);
      return file;
    };
    const hoursAgo = (hours: number): string =>
      new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const stale = variant('stale', (card) => {
      card.observed_at = hoursAgo(2);
    });
    const staleHuman = preflight(stale, false);
    assert.equal(staleHuman.status, 1);
    assert.match(staleHuman.stdout, /capabilities_stale/);
    assert.match(staleHuman.stdout, /Recovery:\n/);
    assert.match(staleHuman.stdout, /freshness:/);
    assert.match(staleHuman.stdout, /current receiving session/);
    assert.match(staleHuman.stdout, /never revert a user-selected model/);
    assert.match(staleHuman.stdout, /capabilities_stale\)/);

    const staleJson = preflight(stale, true);
    assert.equal(staleJson.status, 1);
    const staleValue = JSON.parse(staleJson.stdout) as Record<string, unknown>;
    assert.equal(staleValue.status, 'needs_input');
    assert.deepEqual(
      (staleValue.blockers as { code: string }[]).map((entry) => entry.code),
      ['capabilities_stale'],
    );
    assert.equal(Object.hasOwn(staleValue, 'recovery'), false);

    const identity = variant('identity', (card) => {
      card.session_id = 'other-session';
      card.configuration_id = 'other-configuration';
    });
    const identityHuman = preflight(identity, false);
    assert.equal(identityHuman.status, 1);
    const identityLines = identityHuman.stdout
      .split('\n')
      .filter((line) => line.includes('identity:'));
    assert.equal(identityLines.length, 1);
    assert.match(identityLines[0] ?? '', /assignee_session_id_mismatch/);
    assert.match(identityLines[0] ?? '', /assignee_configuration_id_mismatch/);
    assert.match(identityLines[0] ?? '', /model or provider difference alone/);

    const future = variant('future', (card) => {
      card.observed_at = new Date(
        Date.now() + 2 * 60 * 60 * 1000,
      ).toISOString();
    });
    const futureHuman = preflight(future, false);
    assert.equal(futureHuman.status, 1);
    assert.match(futureHuman.stdout, /clock:/);
    assert.match(futureHuman.stdout, /Do not edit timestamps/);

    // Unknown/declared state is not proof of absence: guidance must ask for current
    // exposure evidence instead of asserting the runtime cannot supply the tool.
    const unknownState = variant('unknown-state', (card) => {
      card.tools = (card.tools as { id: string; state: string }[]).map(
        (tool) =>
          tool.id === 'read' ? { id: tool.id, state: 'unknown' } : tool,
      );
    });
    const unknownHuman = preflight(unknownState, false);
    assert.equal(unknownHuman.status, 1);
    assert.match(unknownHuman.stdout, /tools_unavailable \(read\)/);
    assert.match(unknownHuman.stdout, /capabilities:/);
    assert.match(unknownHuman.stdout, /not confirmed by this card/);
    assert.match(unknownHuman.stdout, /current runtime exposure/);
    assert.match(unknownHuman.stdout, /earlier successful tool use/i);
    assert.equal(/genuinely unavailable/.test(unknownHuman.stdout), false);
    assert.equal(/cannot supply/.test(unknownHuman.stdout), false);
    assert.equal(
      /narrow the requirement deliberately/.test(unknownHuman.stdout),
      false,
    );

    const unknownJson = preflight(unknownState, true);
    assert.equal(unknownJson.status, 1);
    const unknownValue = JSON.parse(unknownJson.stdout) as {
      status: string;
      blockers: { code: string; capability?: string }[];
    };
    assert.equal(unknownValue.status, 'needs_input');
    assert.deepEqual(unknownValue.blockers, [
      { code: 'tools_unavailable', capability: 'read' },
    ]);
    assert.equal(Object.hasOwn(unknownValue, 'recovery'), false);

    // A runner that omits a required capability is also unconfirmed, not proven absent.
    const assignment = JSON.parse(
      readFileSync(value.assignmentFile, 'utf8'),
    ) as Record<string, unknown>;
    const omittedAssignment = join(value.root, 'assignment.omitted.json');
    writeFileSync(
      omittedAssignment,
      `${JSON.stringify(
        {
          ...assignment,
          runner: {
            ...(assignment.runner as Record<string, unknown>),
            omitted_capabilities: [],
          },
          required: { skills: [], tools: ['read', 'grep'] },
        },
        null,
        2,
      )}\n`,
    );
    const omitted = run(
      [
        'collab',
        'preflight',
        '--assignment',
        omittedAssignment,
        '--capabilities',
        value.cardFile,
      ],
      value.root,
    );
    assert.equal(omitted.status, 1);
    assert.match(omitted.stdout, /tools_unavailable \(grep\)/);
    assert.match(omitted.stdout, /capabilities:/);
    assert.match(omitted.stdout, /not confirmed by this card/);
    assert.equal(/genuinely unavailable/.test(omitted.stdout), false);
    const readyHuman = preflight(value.cardFile, false);
    assert.equal(readyHuman.status, 0);
    assert.equal(readyHuman.stdout.includes('Recovery:'), false);
  } finally {
    cleanup(value.root);
  }
});
