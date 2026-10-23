import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  COLLAB_PREFLIGHT_SCHEMA,
  runCollaborationPreflight,
} from '../../src/app/collab-preflight.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

const CLOCK = Date.parse('2026-10-21T10:30:00Z');

function digest(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

interface Fixture {
  readonly root: string;
  readonly inputFile: string;
  readonly assignmentFile: string;
  readonly cardFile: string;
  readonly assignment: Record<string, unknown>;
  readonly card: Record<string, unknown>;
}

function setup(label: string): Fixture {
  const root = makeTempDir(label);
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const inputFile = join(root, 'input.json');
  writeFileSync(inputFile, '{"pin":1}\n');
  const assignment = {
    schema: 'harness-collab/assignment/1',
    task_id: 'c2-task',
    assignment_id: 'c2-readiness',
    attempt: 1,
    objective: 'Expose standalone preflight.',
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
    observed_at: new Date(CLOCK).toISOString(),
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
  return {
    root,
    inputFile,
    assignmentFile,
    cardFile,
    assignment,
    card,
  };
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function snapshot(paths: readonly string[]): string[] {
  return paths.map((path) => {
    const stat = lstatSync(path);
    return `${path}:${stat.mtimeMs}:${digest(readFileSync(path, 'utf8'))}`;
  });
}

test('standalone preflight reports ready with limits and advisory warnings', () => {
  const value = setup('c2-ready');
  try {
    const before = snapshot([
      value.assignmentFile,
      value.cardFile,
      value.inputFile,
    ]);
    const report = runCollaborationPreflight({
      assignmentFile: value.assignmentFile,
      capabilitiesFile: value.cardFile,
      now: CLOCK,
    });
    assert.equal(report.schema, COLLAB_PREFLIGHT_SCHEMA);
    assert.equal(report.status, 'ready');
    assert.equal(report.ok, true);
    assert.equal(report.task_id, 'c2-task');
    assert.equal(report.assignment_id, 'c2-readiness');
    assert.equal(report.attempt, 1);
    assert.equal(report.checked_at, new Date(CLOCK).toISOString());
    assert.deepEqual(report.blockers, []);
    assert.deepEqual(
      report.warnings.map((entry) => entry.code),
      ['resource_ownership_not_enforced'],
    );
    assert.deepEqual(report.limits, [
      'reported_runtime_evidence_only',
      'authorization_not_checked',
      'no_resource_lock',
      'no_dispatch',
    ]);
    assert.deepEqual(
      snapshot([value.assignmentFile, value.cardFile, value.inputFile]),
      before,
    );
  } finally {
    cleanup(value.root);
  }
});

test('declared cards and missing required capabilities need input', () => {
  const value = setup('c2-blockers');
  try {
    const declared = { ...value.card, evidence_level: 'declared' };
    writeJson(value.cardFile, declared);
    const declaredReport = runCollaborationPreflight({
      assignmentFile: value.assignmentFile,
      capabilitiesFile: value.cardFile,
      now: CLOCK,
    });
    assert.equal(declaredReport.status, 'needs_input');
    assert.equal(declaredReport.ok, false);
    assert.deepEqual(
      declaredReport.blockers.map((entry) => entry.code),
      ['runtime_capabilities_unconfirmed'],
    );

    const missingTool = {
      ...value.card,
      tools: [{ id: 'read', state: 'declared' }],
    };
    writeJson(value.cardFile, missingTool);
    const missingReport = runCollaborationPreflight({
      assignmentFile: value.assignmentFile,
      capabilitiesFile: value.cardFile,
      now: CLOCK,
    });
    assert.equal(missingReport.status, 'needs_input');
    assert.deepEqual(
      missingReport.blockers.map((entry) => entry.code),
      ['tools_unavailable'],
    );
    assert.equal(missingReport.blockers[0]?.capability, 'read');
  } finally {
    cleanup(value.root);
  }
});

test('freshness, changed inputs and evidence blockers are preserved', () => {
  const value = setup('c2-evidence');
  try {
    const stale = {
      ...value.card,
      observed_at: new Date(CLOCK - 2 * 60 * 60 * 1000).toISOString(),
    };
    writeJson(value.cardFile, stale);
    const staleReport = runCollaborationPreflight({
      assignmentFile: value.assignmentFile,
      capabilitiesFile: value.cardFile,
      now: CLOCK,
    });
    assert.equal(staleReport.status, 'needs_input');
    assert.deepEqual(
      staleReport.blockers.map((entry) => entry.code),
      ['capabilities_stale'],
    );
    const widened = runCollaborationPreflight({
      assignmentFile: value.assignmentFile,
      capabilitiesFile: value.cardFile,
      now: CLOCK,
      maxAgeMinutes: 180,
    });
    assert.equal(widened.status, 'ready');
    writeJson(value.cardFile, value.card);

    writeFileSync(value.inputFile, '{"pin":2}\n');
    const changedInput = runCollaborationPreflight({
      assignmentFile: value.assignmentFile,
      capabilitiesFile: value.cardFile,
      now: CLOCK,
    });
    assert.deepEqual(
      changedInput.blockers.map((entry) => entry.code),
      ['input_changed'],
    );

    const evidenceFile = join(value.root, 'evidence.json');
    writeFileSync(evidenceFile, '{"observed":true}\n');
    const withEvidence = {
      ...value.card,
      evidence_records: [
        { ref: evidenceFile, digest: digest('{"observed":true}\n') },
      ],
    };
    writeJson(value.cardFile, withEvidence);
    writeFileSync(evidenceFile, '{"observed":false}\n');
    const changedEvidence = runCollaborationPreflight({
      assignmentFile: value.assignmentFile,
      capabilitiesFile: value.cardFile,
      now: CLOCK,
    });
    assert.deepEqual(
      changedEvidence.blockers.map((entry) => entry.code),
      ['native_evidence_changed', 'input_changed'],
    );
  } finally {
    cleanup(value.root);
  }
});

test('identity and schema errors are invalid without exposing file contents', () => {
  const value = setup('c2-invalid');
  try {
    const wrongIdentity = { ...value.card, agent_id: 'someone-else' };
    writeJson(value.cardFile, wrongIdentity);
    const identity = runCollaborationPreflight({
      assignmentFile: value.assignmentFile,
      capabilitiesFile: value.cardFile,
      now: CLOCK,
    });
    assert.equal(identity.status, 'needs_input');
    assert.deepEqual(
      identity.blockers.map((entry) => entry.code),
      ['assignee_agent_id_mismatch'],
    );

    writeJson(value.assignmentFile, {
      ...value.assignment,
      schema: 'pappra/unknown-assignment/1',
    });
    const schema = runCollaborationPreflight({
      assignmentFile: value.assignmentFile,
      capabilitiesFile: value.cardFile,
      now: CLOCK,
    });
    assert.equal(schema.status, 'invalid');
    assert.deepEqual(schema.errors, ['Invalid field: contract.schema']);

    writeFileSync(value.assignmentFile, '{"secret":"do-not-print", bad json\n');
    const malformed = runCollaborationPreflight({
      assignmentFile: value.assignmentFile,
      capabilitiesFile: value.cardFile,
      now: CLOCK,
    });
    assert.equal(malformed.status, 'invalid');
    assert.equal(malformed.errors[0]?.includes('do-not-print'), false);
    assert.match(String(malformed.errors[0]), /not valid JSON/);
  } finally {
    cleanup(value.root);
  }
});

test('unsafe file kinds and invalid options fail closed', () => {
  const value = setup('c2-unsafe');
  try {
    const linked = join(value.root, 'linked-assignment.json');
    symlinkSync(value.assignmentFile, linked);
    const symlinkReport = runCollaborationPreflight({
      assignmentFile: linked,
      capabilitiesFile: value.cardFile,
      now: CLOCK,
    });
    assert.equal(symlinkReport.status, 'invalid');
    assert.match(String(symlinkReport.errors[0]), /not a symlink/);

    const directoryReport = runCollaborationPreflight({
      assignmentFile: value.root,
      capabilitiesFile: value.cardFile,
      now: CLOCK,
    });
    assert.equal(directoryReport.status, 'invalid');
    assert.match(String(directoryReport.errors[0]), /regular file/);

    const oversized = join(value.root, 'oversized.json');
    writeFileSync(oversized, `${'x'.repeat(1024 * 1024 + 1)}`);
    const oversizedReport = runCollaborationPreflight({
      assignmentFile: oversized,
      capabilitiesFile: value.cardFile,
      now: CLOCK,
    });
    assert.equal(oversizedReport.status, 'invalid');
    assert.match(String(oversizedReport.errors[0]), /limit/);

    const relativeReport = runCollaborationPreflight({
      assignmentFile: 'assignment.json',
      capabilitiesFile: value.cardFile,
      now: CLOCK,
    });
    assert.equal(relativeReport.status, 'invalid');
    assert.match(String(relativeReport.errors[0]), /absolute/);

    for (const maxAgeMinutes of [0, Number.NaN, -1]) {
      const report = runCollaborationPreflight({
        assignmentFile: value.assignmentFile,
        capabilitiesFile: value.cardFile,
        maxAgeMinutes,
        now: CLOCK,
      });
      assert.equal(report.status, 'invalid');
      assert.match(String(report.errors[0]), /positive finite/);
    }
  } finally {
    cleanup(value.root);
  }
});
