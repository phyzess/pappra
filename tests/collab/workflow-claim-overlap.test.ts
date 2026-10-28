import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyPrepare,
  planPrepare,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import { readRecord } from '../../src/collab/store.js';
import { makeTaskDomain } from './task-resources-fixtures.js';
import { owner } from './scenarios.js';

const COORDINATOR = {
  agent_id: owner.agent_id,
  session_id: owner.session_id,
  harness: owner.harness,
  owner_epoch: owner.owner_epoch,
  since: owner.since,
};

const WRITER_A = {
  agent_id: 'writer-a',
  session_id: 'writer-a-session',
  harness: 'pi',
  surface: 'cli',
  configuration_id: 'daily-visible',
};

const WRITER_B = {
  agent_id: 'writer-b',
  session_id: 'writer-b-session',
  harness: 'pi',
  surface: 'cli',
  configuration_id: 'daily-visible',
};

const REVIEWER = {
  agent_id: 'reviewer',
  session_id: 'reviewer-session',
  harness: 'pi',
  surface: 'cli',
  configuration_id: 'daily-visible',
};

function assignment(
  subtask: string,
  role: 'writer' | 'reviewer',
  assignee: string,
  resources: { path: string; access: 'read' | 'write' }[],
) {
  return {
    subtask_id: subtask,
    role,
    assignee,
    objective: `Objective for ${subtask}.`,
    acceptance: [`Acceptance for ${subtask}.`],
    resources,
    required_skills: [],
    required_tools: [],
    native_evidence: [],
  };
}

function prepareRequest(
  domainRoot: string,
  cwd: string,
  assignments: WorkflowPrepareRequest['assignments'],
): WorkflowPrepareRequest {
  return {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: domainRoot,
    task_id: 'cohort',
    goal: {
      objective: 'Keep read and write scopes disjoint at plan time.',
      input_ref: null,
      input_digest: null,
    },
    coordinator: {
      agent_id: COORDINATOR.agent_id,
      session_id: COORDINATOR.session_id,
      harness: COORDINATOR.harness,
      owner_epoch: COORDINATOR.owner_epoch,
      since: COORDINATOR.since,
      cwd,
      surface: 'cli',
      configuration_id: 'daily-visible',
    },
    participants: [
      {
        agent_id: COORDINATOR.agent_id,
        session_id: COORDINATOR.session_id,
        harness: COORDINATOR.harness,
        cwd,
        surface: 'cli',
        configuration_id: 'daily-visible',
      },
      { ...WRITER_A, cwd },
      { ...WRITER_B, cwd },
      { ...REVIEWER, cwd },
    ],
    bindings: [],
    assignments,
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  };
}

test('a read overlapping another assignment write is refused at plan time', () => {
  const fixture = makeTaskDomain('overlap-read-plan', ['cohort'], {
    initialize: [],
  });
  try {
    const shared = join(fixture.root, 'shared');
    const request = prepareRequest(fixture.domainRoot, fixture.root, [
      assignment('writer-one', 'writer', WRITER_A.agent_id, [
        { path: shared, access: 'write' },
      ]),
      assignment('reader-two', 'writer', WRITER_B.agent_id, [
        { path: shared, access: 'read' },
      ]),
    ]);
    const planned = planPrepare(request);
    assert.equal(planned.ok, false);
    if (planned.ok) return;
    assert.equal(planned.code, 'assignment_scope_overlap');
    assert.match(planned.message, /writer-one/);
    assert.match(planned.message, /reader-two/);
    assert.ok(
      planned.message.includes(shared),
      `the message names both paths: ${planned.message}`,
    );
    assert.match(
      planned.message,
      /writes .* while assignment .* reads|reads .* while assignment .* writes/,
      'the message says which side reads and which side writes',
    );
    assert.match(
      planned.nextAction ?? '',
      /deferred reviewer/,
      'the next action suggests dropping the read or deferring it',
    );
    assert.equal(
      existsSync(fixture.tasks.cohort!),
      false,
      'a refused plan writes nothing',
    );

    // The reversed declaration order is refused with the roles swapped.
    const reversed = prepareRequest(fixture.domainRoot, fixture.root, [
      assignment('reader-two', 'writer', WRITER_B.agent_id, [
        { path: shared, access: 'read' },
      ]),
      assignment('writer-one', 'writer', WRITER_A.agent_id, [
        { path: shared, access: 'write' },
      ]),
    ]);
    const reversedPlanned = planPrepare(reversed);
    assert.equal(reversedPlanned.ok, false);
    if (reversedPlanned.ok) return;
    assert.equal(reversedPlanned.code, 'assignment_scope_overlap');
    assert.match(
      reversedPlanned.message,
      /reads .* while assignment .* writes/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('apply refuses a read/write overlap without taking any claim', async () => {
  const fixture = makeTaskDomain('overlap-read-apply', ['cohort'], {
    initialize: ['cohort'],
  });
  try {
    const taskRoot = fixture.tasks.cohort!;
    const shared = join(fixture.root, 'shared');
    const request = prepareRequest(fixture.domainRoot, fixture.root, [
      assignment('writer-one', 'writer', WRITER_A.agent_id, [
        { path: shared, access: 'write' },
      ]),
      assignment('reader-two', 'writer', WRITER_B.agent_id, [
        { path: shared, access: 'read' },
      ]),
    ]);
    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'invalid');
    assert.equal(
      applied.blockers[0]?.code,
      'assignment_scope_overlap',
      JSON.stringify(applied.blockers),
    );
    assert.match(String(applied.blockers[0]?.detail ?? ''), /writer-one/);
    assert.match(String(applied.blockers[0]?.detail ?? ''), /reader-two/);

    const record = readRecord(taskRoot);
    assert(record !== null, 'the pre-existing record is untouched');
    assert.equal(
      record.claims.length,
      0,
      "a refused plan never takes any claim, not even the first assignment's",
    );
    assert.equal(record.attempts.length, 0);
    assert.equal(
      existsSync(join(taskRoot, 'workflow')),
      false,
      'no manifest, plan or assignment was sealed',
    );
    assert.equal(
      existsSync(join(taskRoot, 'binding.json')),
      false,
      'no binding was sealed',
    );
  } finally {
    fixture.cleanup();
  }
});

test('a read/read overlap between non-deferred assignments stays allowed', async () => {
  const fixture = makeTaskDomain('overlap-read-read', ['cohort']);
  try {
    const taskRoot = fixture.tasks.cohort!;
    const shared = join(fixture.root, 'shared');
    const request = prepareRequest(fixture.domainRoot, fixture.root, [
      assignment('writer-one', 'writer', WRITER_A.agent_id, [
        { path: join(fixture.root, 'a'), access: 'write' },
        { path: shared, access: 'read' },
      ]),
      assignment('reader-two', 'writer', WRITER_B.agent_id, [
        { path: shared, access: 'read' },
      ]),
    ]);
    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'applied', JSON.stringify(applied.blockers));
    const record = readRecord(taskRoot);
    assert(record !== null);
    assert.ok(
      record.claims.some(
        (claim) => claim.subtask_id === 'writer-one' && claim.access === 'read',
      ),
      'the first assignment keeps its read claim',
    );
    assert.ok(
      record.claims.some(
        (claim) => claim.subtask_id === 'reader-two' && claim.access === 'read',
      ),
      'the second assignment keeps its read claim',
    );
    assert.ok(
      record.claims.some(
        (claim) =>
          claim.subtask_id === 'writer-one' && claim.access === 'write',
      ),
      'the disjoint write claim is untouched',
    );
  } finally {
    fixture.cleanup();
  }
});

test('a deferred reviewer reading a writer file stays allowed', async () => {
  const fixture = makeTaskDomain('overlap-deferred-review', ['cohort']);
  try {
    const taskRoot = fixture.tasks.cohort!;
    const shared = join(fixture.root, 'shared');
    const request = prepareRequest(fixture.domainRoot, fixture.root, [
      assignment('writer-one', 'writer', WRITER_A.agent_id, [
        { path: shared, access: 'write' },
      ]),
      assignment('review', 'reviewer', REVIEWER.agent_id, [
        { path: shared, access: 'read' },
      ]),
    ]);
    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'applied', JSON.stringify(applied.blockers));
    assert.deepEqual(applied.detail?.deferred, ['review']);
    const record = readRecord(taskRoot);
    assert(record !== null);
    assert.equal(
      record.claims.filter((claim) => claim.subtask_id === 'review').length,
      0,
      'a deferred reviewer claims nothing at prepare',
    );
    assert.equal(record.attempts.length, 1);
    assert.equal(record.attempts[0]?.subtask_id, 'writer-one');
  } finally {
    fixture.cleanup();
  }
});
