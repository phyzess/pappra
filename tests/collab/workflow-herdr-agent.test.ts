import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyPrepare,
  planPrepare,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import { readBindingGeneration } from '../../src/app/collab-workflow/binding-generation.js';
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

type BindingEntry = WorkflowPrepareRequest['bindings'][number];

interface RequestOptions {
  readonly coordinatorIsParticipant?: boolean;
}

function prepareRequest(
  domainRoot: string,
  cwd: string,
  bindings: readonly BindingEntry[],
  options: RequestOptions = {},
): WorkflowPrepareRequest {
  const coordinatorAsParticipant =
    options.coordinatorIsParticipant === false
      ? []
      : [
          {
            agent_id: COORDINATOR.agent_id,
            session_id: COORDINATOR.session_id,
            harness: COORDINATOR.harness,
            cwd,
            surface: 'cli',
            configuration_id: 'daily-visible',
          },
        ];
  return {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: domainRoot,
    task_id: 'cohort',
    goal: {
      objective: 'Bind distinct Herdr agent names.',
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
      ...coordinatorAsParticipant,
      { ...WRITER, cwd },
      { ...REVIEWER, cwd },
    ],
    bindings: [...bindings],
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
        resources: [{ path: join(cwd, 'a'), access: 'read' }],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ],
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  };
}

test('a declared Herdr agent name is sealed into binding.json and carried through', async () => {
  const fixture = makeTaskDomain('herdr-custom', ['cohort']);
  try {
    const taskRoot = fixture.tasks.cohort!;
    const request = prepareRequest(fixture.domainRoot, fixture.root, [
      {
        agent_id: COORDINATOR.agent_id,
        pane_id: 'w3:p3C',
        native_session_id: COORDINATOR.session_id,
        herdr_agent: 'live-coordinator',
      },
      {
        agent_id: WRITER.agent_id,
        pane_id: 'w3:p3J',
        native_session_id: WRITER.session_id,
        herdr_agent: 'live-writer-a',
      },
      {
        agent_id: REVIEWER.agent_id,
        pane_id: 'w3:p3K',
        native_session_id: REVIEWER.session_id,
      },
    ]);
    // The request schema accepts the optional name on the wire.
    const parsed = parseWorkflowPrepareRequest(
      JSON.parse(JSON.stringify(request)),
    );
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) return;
    assert.equal(parsed.value.bindings[0]?.herdr_agent, 'live-coordinator');
    assert.equal(parsed.value.bindings[1]?.herdr_agent, 'live-writer-a');
    assert.equal(parsed.value.bindings[2]?.herdr_agent, undefined);

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
        herdr_agent: 'live-coordinator',
        pane_id: 'w3:p3C',
        native_session_id: COORDINATOR.session_id,
      },
      {
        agent_id: WRITER.agent_id,
        harness: WRITER.harness,
        cwd: fixture.root,
        herdr_agent: 'live-writer-a',
        pane_id: 'w3:p3J',
        native_session_id: WRITER.session_id,
      },
      {
        agent_id: REVIEWER.agent_id,
        harness: REVIEWER.harness,
        cwd: fixture.root,
        herdr_agent: REVIEWER.agent_id,
        pane_id: 'w3:p3K',
        native_session_id: REVIEWER.session_id,
      },
    ]);

    // The binding generation reader accepts the sealed bytes, so adoption and
    // notification routing carry the declared names unchanged.
    const generation = readBindingGeneration(workflowBindingPath(taskRoot));
    assert.notEqual(generation, null);
    assert.equal(
      generation?.participants.find((item) => item.agent_id === WRITER.agent_id)
        ?.herdr_agent,
      'live-writer-a',
    );
    assert.equal(
      generation?.participants.find(
        (item) => item.agent_id === REVIEWER.agent_id,
      )?.herdr_agent,
      REVIEWER.agent_id,
    );

    const manifest = JSON.parse(
      readFileSync(join(taskRoot, 'workflow', 'manifest.json'), 'utf8'),
    ) as { bindings: Record<string, unknown>[] };
    assert.equal(manifest.bindings[0]?.herdr_agent, 'live-coordinator');
    assert.equal(manifest.bindings[1]?.herdr_agent, 'live-writer-a');
    assert.equal(
      Object.hasOwn(manifest.bindings[2] ?? {}, 'herdr_agent'),
      false,
      'a binding that declares no name gains no manifest key',
    );
  } finally {
    fixture.cleanup();
  }
});

test('an absent Herdr agent name keeps the sealed default byte-identical', async () => {
  const fixture = makeTaskDomain('herdr-default', ['cohort']);
  try {
    const taskRoot = fixture.tasks.cohort!;
    const request = prepareRequest(fixture.domainRoot, fixture.root, [
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
    ]);
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
        pane_id: 'w3:p3C',
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
    const manifest = JSON.parse(
      readFileSync(join(taskRoot, 'workflow', 'manifest.json'), 'utf8'),
    ) as { bindings: Record<string, unknown>[] };
    for (const entry of manifest.bindings)
      assert.equal(
        Object.hasOwn(entry, 'herdr_agent'),
        false,
        'an absent name adds no manifest key, so existing bytes stay identical',
      );
  } finally {
    fixture.cleanup();
  }
});

test('a duplicate Herdr agent name among bindings is refused before any effect', async () => {
  const fixture = makeTaskDomain('herdr-duplicate', ['cohort'], {
    initialize: [],
  });
  try {
    const request = prepareRequest(fixture.domainRoot, fixture.root, [
      {
        agent_id: WRITER.agent_id,
        pane_id: 'w3:p3J',
        native_session_id: WRITER.session_id,
        herdr_agent: 'shared-live-name',
      },
      {
        agent_id: REVIEWER.agent_id,
        pane_id: 'w3:p3K',
        native_session_id: REVIEWER.session_id,
        herdr_agent: 'shared-live-name',
      },
    ]);
    const planned = planPrepare(request);
    assert.equal(planned.ok, false);
    if (planned.ok) return;
    assert.equal(planned.code, 'binding_herdr_agent_duplicate');
    assert.match(planned.message, /shared-live-name/);
    assert.match(planned.message, /writer-a/);
    assert.match(planned.message, /reviewer/);

    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'invalid');
    assert.equal(
      applied.blockers[0]?.code,
      'binding_herdr_agent_duplicate',
      JSON.stringify(applied.blockers),
    );
    assert.equal(
      existsSync(fixture.tasks.cohort!),
      false,
      'a refused duplicate takes no claim and writes nothing',
    );
  } finally {
    fixture.cleanup();
  }
});

test('a declared name colliding with another default is refused, coordinator included', async () => {
  const fixture = makeTaskDomain('herdr-default-collision', ['cohort'], {
    initialize: [],
  });
  try {
    // The reviewer claims the writer's default name.
    const request = prepareRequest(fixture.domainRoot, fixture.root, [
      {
        agent_id: REVIEWER.agent_id,
        pane_id: 'w3:p3K',
        native_session_id: REVIEWER.session_id,
        herdr_agent: WRITER.agent_id,
      },
    ]);
    const planned = planPrepare(request);
    assert.equal(planned.ok, false);
    if (planned.ok) return;
    assert.equal(planned.code, 'binding_herdr_agent_duplicate');
    assert.match(planned.message, new RegExp(WRITER.agent_id));

    // A coordinator-only binding that claims a participant's default name is
    // refused through the same plan-time check.
    const coordinatorRequest = prepareRequest(
      fixture.domainRoot,
      fixture.root,
      [
        {
          agent_id: COORDINATOR.agent_id,
          pane_id: 'w3:p3C',
          native_session_id: COORDINATOR.session_id,
          herdr_agent: WRITER.agent_id,
        },
      ],
      { coordinatorIsParticipant: false },
    );
    const coordinatorPlanned = planPrepare(coordinatorRequest);
    assert.equal(coordinatorPlanned.ok, false);
    if (coordinatorPlanned.ok) return;
    assert.equal(coordinatorPlanned.code, 'binding_herdr_agent_duplicate');
    assert.match(coordinatorPlanned.message, /coordinator/);
  } finally {
    fixture.cleanup();
  }
});
