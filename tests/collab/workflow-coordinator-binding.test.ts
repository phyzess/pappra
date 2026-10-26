import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyPrepare,
  planPrepare,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import {
  parseWorkflowPrepareRequest,
  workflowBindingPath,
} from '../../src/schemas/collab-workflow.js';
import { makeTaskDomain } from './task-resources-fixtures.js';
import { owner } from './scenarios.js';

const COORDINATOR = {
  agent_id: owner.agent_id,
  session_id: owner.session_id,
  harness: owner.harness,
  owner_epoch: owner.owner_epoch,
  since: owner.since,
};

const WRITER = {
  agent_id: 'writer-a',
  session_id: 'writer-a-session',
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

interface PrepareOptions {
  readonly coordinatorIsParticipant?: boolean;
  readonly bindings?: WorkflowPrepareRequest['bindings'];
  readonly reviewerAccess?: 'read' | 'write';
}

function prepareRequest(
  domainRoot: string,
  cwd: string,
  options: PrepareOptions = {},
): WorkflowPrepareRequest {
  const coordinatorEntry = {
    ...COORDINATOR,
    cwd,
    surface: 'cli',
    configuration_id: 'daily-visible',
  };
  const participants =
    options.coordinatorIsParticipant === false
      ? [
          { ...WRITER, cwd },
          { ...REVIEWER, cwd },
        ]
      : [coordinatorEntry, { ...WRITER, cwd }, { ...REVIEWER, cwd }];
  return {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: domainRoot,
    task_id: 'cohort',
    goal: {
      objective: 'Bind the coordinator without the participant workaround.',
      input_ref: null,
      input_digest: null,
    },
    coordinator: coordinatorEntry,
    participants,
    bindings: options.bindings ?? [],
    assignments: [
      {
        subtask_id: 'writer',
        role: 'writer',
        assignee: WRITER.agent_id,
        objective: 'Write the declared output.',
        acceptance: ['The declared output exists.'],
        resources: [{ path: join(cwd, 'a'), access: 'write' }],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
      {
        subtask_id: 'review',
        role: 'reviewer',
        assignee: REVIEWER.agent_id,
        objective: 'Review the writer output.',
        acceptance: ['Reviewed.'],
        resources: [
          {
            path: join(cwd, 'a'),
            access: options.reviewerAccess ?? 'read',
          },
        ],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ],
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  };
}

test('a coordinator-only binding seals exactly one coordinator entry', async () => {
  const fixture = makeTaskDomain('coord-bind-only', ['cohort']);
  try {
    const taskRoot = fixture.tasks.cohort!;
    const request = prepareRequest(fixture.domainRoot, fixture.root, {
      coordinatorIsParticipant: false,
      bindings: [
        {
          agent_id: COORDINATOR.agent_id,
          pane_id: 'w3:p3C',
          native_session_id: COORDINATOR.session_id,
        },
      ],
    });
    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'applied', JSON.stringify(applied.blockers));
    const binding = JSON.parse(
      readFileSync(workflowBindingPath(taskRoot), 'utf8'),
    ) as {
      participants: {
        agent_id: string;
        harness: string;
        cwd: string;
        herdr_agent: string;
        pane_id: string | null;
        native_session_id: string | null;
      }[];
    };
    const entries = binding.participants.filter(
      (item) => item.agent_id === COORDINATOR.agent_id,
    );
    assert.equal(entries.length, 1, 'the coordinator is sealed exactly once');
    assert.deepEqual(entries[0], {
      agent_id: COORDINATOR.agent_id,
      harness: COORDINATOR.harness,
      cwd: fixture.root,
      herdr_agent: COORDINATOR.agent_id,
      pane_id: 'w3:p3C',
      native_session_id: COORDINATOR.session_id,
    });
    assert.equal(
      binding.participants.length,
      3,
      'the two declared participants plus the coordinator entry',
    );
  } finally {
    fixture.cleanup();
  }
});

test('a coordinator declared as participant and bound keeps exactly one entry', async () => {
  const fixture = makeTaskDomain('coord-bind-duplicate', ['cohort']);
  try {
    const taskRoot = fixture.tasks.cohort!;
    const request = prepareRequest(fixture.domainRoot, fixture.root, {
      bindings: [
        {
          agent_id: COORDINATOR.agent_id,
          pane_id: 'w3:p3C',
          native_session_id: COORDINATOR.session_id,
        },
        {
          agent_id: WRITER.agent_id,
          pane_id: 'w3:p3J',
          native_session_id: WRITER.session_id,
        },
      ],
    });
    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'applied', JSON.stringify(applied.blockers));
    const binding = JSON.parse(
      readFileSync(workflowBindingPath(taskRoot), 'utf8'),
    ) as {
      participants: { agent_id: string; native_session_id: string | null }[];
    };
    const entries = binding.participants.filter(
      (item) => item.agent_id === COORDINATOR.agent_id,
    );
    assert.equal(
      entries.length,
      1,
      `the participant mapping is the only coordinator entry, got ${JSON.stringify(binding.participants)}`,
    );
    assert.equal(entries[0]?.native_session_id, COORDINATOR.session_id);
  } finally {
    fixture.cleanup();
  }
});

test('an unbound coordinator keeps the previous sealed binding', async () => {
  const fixture = makeTaskDomain('coord-bind-unbound', ['cohort']);
  try {
    const taskRoot = fixture.tasks.cohort!;
    const request = prepareRequest(fixture.domainRoot, fixture.root, {
      bindings: [
        {
          agent_id: WRITER.agent_id,
          pane_id: 'w3:p3J',
          native_session_id: WRITER.session_id,
        },
      ],
    });
    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'applied', JSON.stringify(applied.blockers));
    const binding = JSON.parse(
      readFileSync(workflowBindingPath(taskRoot), 'utf8'),
    ) as {
      participants: {
        agent_id: string;
        harness: string;
        cwd: string;
        herdr_agent: string;
        pane_id: string | null;
        native_session_id: string | null;
      }[];
    };
    assert.deepEqual(binding.participants, [
      {
        agent_id: COORDINATOR.agent_id,
        harness: COORDINATOR.harness,
        cwd: fixture.root,
        herdr_agent: COORDINATOR.agent_id,
        pane_id: null,
        native_session_id: COORDINATOR.session_id,
      },
      {
        agent_id: WRITER.agent_id,
        harness: WRITER.harness,
        cwd: fixture.root,
        herdr_agent: WRITER.agent_id,
        pane_id: 'w3:p3J',
        native_session_id: WRITER.session_id,
      },
      {
        agent_id: REVIEWER.agent_id,
        harness: REVIEWER.harness,
        cwd: fixture.root,
        herdr_agent: REVIEWER.agent_id,
        pane_id: null,
        native_session_id: REVIEWER.session_id,
      },
    ]);

    // No bindings at all seals no binding document, exactly as before.
    const bare = makeTaskDomain('coord-bind-bare', ['cohort']);
    try {
      const bareApplied = await applyPrepare(
        prepareRequest(bare.domainRoot, bare.root),
      );
      assert.equal(
        bareApplied.status,
        'applied',
        JSON.stringify(bareApplied.blockers),
      );
      assert.equal(
        existsSync(workflowBindingPath(bare.tasks.cohort!)),
        false,
        'no declared bindings still seals no binding document',
      );
    } finally {
      bare.cleanup();
    }
  } finally {
    fixture.cleanup();
  }
});

test('a binding naming neither a participant nor the coordinator is refused', () => {
  const fixture = makeTaskDomain('coord-bind-stranger', ['cohort']);
  try {
    const request = prepareRequest(fixture.domainRoot, fixture.root, {
      bindings: [
        {
          agent_id: 'stranger',
          pane_id: 'w3:p3S',
          native_session_id: 'stranger-session',
        },
      ],
    });
    const parsed = parseWorkflowPrepareRequest(request);
    assert.equal(parsed.ok, false);
    assert.match(
      parsed.ok ? '' : parsed.message,
      /neither a declared participant nor the coordinator/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('a reviewer declaring a write resource is refused at plan time', async () => {
  const fixture = makeTaskDomain('coord-bind-review-write', ['cohort']);
  try {
    const request = prepareRequest(fixture.domainRoot, fixture.root, {
      reviewerAccess: 'write',
    });
    const planned = planPrepare(request);
    assert.equal(planned.ok, false);
    if (!planned.ok) {
      assert.equal(planned.code, 'reviewer_write_footprint');
      assert.match(planned.message, /Reviewer review declares write resources/);
    }
    const parsed = parseWorkflowPrepareRequest(request);
    assert.equal(parsed.ok, false);
    assert.match(
      parsed.ok ? '' : parsed.message,
      /declare the reviewer read-only, or use a writer role/,
    );
    const applied = await applyPrepare(request);
    assert.equal(applied.ok, false);
    assert.equal(
      applied.blockers[0]?.code,
      'reviewer_write_footprint',
      'apply refuses the same footprint before any effect',
    );
  } finally {
    fixture.cleanup();
  }
});

test('a read-only reviewer still plans', () => {
  const fixture = makeTaskDomain('coord-bind-review-read', ['cohort']);
  try {
    const report = planPrepare(
      prepareRequest(fixture.domainRoot, fixture.root),
    );
    assert.equal(report.ok, true);
    if (!report.ok) return;
    assert.equal(report.value.plan.status, 'planned');
    const review = report.value.plan.assignments.find(
      (item) => item.subtask_id === 'review',
    );
    assert.equal(review?.deferred, true, 'the reviewer stays deferred');
    const writer = report.value.plan.assignments.find(
      (item) => item.subtask_id === 'writer',
    );
    assert.equal(writer?.deferred, false);
  } finally {
    fixture.cleanup();
  }
});
