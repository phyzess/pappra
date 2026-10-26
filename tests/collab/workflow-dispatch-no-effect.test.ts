import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyDispatch,
  applyPrepare,
  type WorkflowDispatchRequest,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import {
  createHerdrWorkExecutionAdapter,
  type WorkExecutionAdapter,
  type WorkExecutionObservation,
} from '../../src/app/collab-work-execution.js';
import type {
  HerdrAgentObservation,
  HerdrCallerObservation,
  HerdrPromptResult,
  HerdrTransport,
} from '../../src/app/collab-notify.js';
import { workflowIntentsDir } from '../../src/schemas/collab-workflow.js';
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

function prepareRequest(
  domainRoot: string,
  cwd: string,
): WorkflowPrepareRequest {
  return {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: domainRoot,
    task_id: 'cohort',
    goal: {
      objective: 'Exercise no-effect dispatch recovery.',
      input_ref: null,
      input_digest: null,
    },
    coordinator: {
      ...COORDINATOR,
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
      { ...WRITER, cwd },
    ],
    bindings: [
      {
        agent_id: COORDINATOR.agent_id,
        pane_id: 'w3:p3B',
        native_session_id: COORDINATOR.session_id,
      },
      {
        agent_id: WRITER.agent_id,
        pane_id: 'w3:p3W',
        native_session_id: WRITER.session_id,
      },
    ],
    assignments: [
      {
        subtask_id: 'writer-one',
        role: 'writer',
        assignee: WRITER.agent_id,
        objective: 'Dispatch one bounded writer assignment.',
        acceptance: [
          'The assignment is dispatched only when the outcome permits it.',
        ],
        resources: [
          { path: join(cwd, 'output.txt'), access: 'write', scope: 'file' },
        ],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ],
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  };
}

async function fixture(name: string) {
  const domain = makeTaskDomain(name, ['cohort'], { initialize: [] });
  const prepared = await applyPrepare(
    prepareRequest(domain.domainRoot, domain.root),
  );
  assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
  const taskRoot = join(domain.domainRoot, 'tasks', 'cohort');
  const cardFile = join(domain.root, 'card.json');
  writeFileSync(
    cardFile,
    `${JSON.stringify(
      {
        schema: 'harness-collab/capabilities/1',
        ...WRITER,
        cwd: domain.root,
        observed_at: new Date().toISOString(),
        evidence_level: 'runtime',
        skills: [],
        tools: [],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(domain.root, 'output.txt'), 'fixture\n');
  const request: WorkflowDispatchRequest = {
    schema: 'pappra/collab-workflow-dispatch-request/1',
    task_root: taskRoot,
    caller: { ...COORDINATOR, cwd: domain.root },
    caller_pane: 'w3:p3B',
    capability_targets: [
      {
        subtask_id: 'writer-one',
        attempt: 1,
        capabilities_file: cardFile,
        template_file: null,
        session_file: null,
        events_file: null,
        execution_file: null,
      },
    ],
    subtasks: ['writer-one'],
    activate_deferred: false,
    max_age_minutes: 30,
  };
  return {
    domain,
    taskRoot,
    request,
    cardFile,
    originalCard: readFileSync(cardFile, 'utf8'),
    bindingFile: join(taskRoot, 'binding.json'),
    originalBinding: readFileSync(join(taskRoot, 'binding.json'), 'utf8'),
    intentFile: join(
      workflowIntentsDir(taskRoot),
      'dispatch-writer-one-1.json',
    ),
    outcomeFile: join(
      workflowIntentsDir(taskRoot),
      'dispatch-writer-one-1.outcome.json',
    ),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function liveAdapter(
  f: Fixture,
  outcomes: HerdrPromptResult[],
  beforeList?: () => void,
) {
  const queue = [...outcomes];
  const observations: WorkExecutionObservation[] = [];
  let prompts = 0;
  const caller: HerdrCallerObservation = {
    paneId: 'w3:p3B',
    workspaceId: 'w3',
    tabId: 'w3:t1',
    harness: 'pi',
    cwd: f.domain.root,
    sessionKind: 'id',
    sessionValue: COORDINATOR.session_id,
    source: 'explicit',
  };
  const agents: HerdrAgentObservation[] = [
    {
      name: COORDINATOR.agent_id,
      harness: 'pi',
      paneId: 'w3:p3B',
      cwd: f.domain.root,
      sessionValue: COORDINATOR.session_id,
      sessionKind: 'id',
      status: 'idle',
      focused: false,
    },
    {
      name: WRITER.agent_id,
      harness: 'pi',
      paneId: 'w3:p3W',
      cwd: f.domain.root,
      sessionValue: WRITER.session_id,
      sessionKind: 'id',
      status: 'idle',
      focused: false,
    },
  ];
  const transport: HerdrTransport = {
    id: 'no-effect-fixture',
    verifyCaller: async () => ({ ok: true, caller }),
    list: async () => {
      beforeList?.();
      return { ok: true, agents };
    },
    prompt: async () => {
      prompts += 1;
      return queue.shift() ?? { status: 'submitted', detail: null };
    },
  };
  const production = createHerdrWorkExecutionAdapter({ transport });
  const adapter: WorkExecutionAdapter = {
    preflight: (request) => production.preflight(request),
    dispatch: async (request) => {
      const observation = await production.dispatch(request);
      observations.push(observation);
      return observation;
    },
  };
  return { adapter, observations, transport, promptCalls: () => prompts };
}

function removeCoordinatorBinding(f: Fixture) {
  const binding = JSON.parse(f.originalBinding) as {
    participants: { agent_id: string }[];
  };
  binding.participants = binding.participants.filter(
    (participant) => participant.agent_id !== COORDINATOR.agent_id,
  );
  writeFileSync(f.bindingFile, `${JSON.stringify(binding, null, 2)}\n`);
}

test('binding_sender_missing records no-effect and a corrected binding dispatches the same intent', async () => {
  const f = await fixture('dispatch-no-effect-binding');
  const live = liveAdapter(f, [{ status: 'submitted', detail: null }]);
  try {
    removeCoordinatorBinding(f);
    const first = await applyDispatch(f.request, { adapter: live.adapter });
    const intentBefore = readFileSync(f.intentFile);
    assert.equal(first.ok, false);
    assert(
      first.blockers.some(
        (item) => item.code === 'delivery_binding_sender_missing',
      ),
    );
    assert.equal(live.observations[0]?.effect, 'none');
    assert.equal(live.promptCalls(), 0);
    assert.equal(
      JSON.parse(readFileSync(f.outcomeFile, 'utf8')).effect,
      'none',
    );

    writeFileSync(f.bindingFile, f.originalBinding);
    const second = await applyDispatch(f.request, { adapter: live.adapter });
    assert.equal(second.ok, true, JSON.stringify(second.blockers));
    assert.equal(second.status, 'applied');
    assert.equal(live.observations[1]?.effect, 'possible');
    assert.equal(live.promptCalls(), 1);
    assert(
      second.warnings.some((warning) =>
        warning.includes('binding_sender_missing'),
      ),
    );
    assert.deepEqual(readFileSync(f.intentFile), intentBefore);
    assert.equal(
      JSON.parse(readFileSync(f.outcomeFile, 'utf8')).effect,
      'possible',
    );
    assert.equal(existsSync(`${f.outcomeFile}.lock`), false);
  } finally {
    f.domain.cleanup();
  }
});

test('a final-authority refusal is no-effect and can be corrected without replacing the intent', async () => {
  const f = await fixture('dispatch-no-effect-authority');
  let invalidate = true;
  const live = liveAdapter(f, [{ status: 'submitted', detail: null }], () => {
    if (invalidate) {
      invalidate = false;
      writeFileSync(f.cardFile, '{not valid json');
    }
  });
  try {
    const first = await applyDispatch(f.request, { adapter: live.adapter });
    const intentBefore = readFileSync(f.intentFile);
    assert.equal(first.ok, false);
    assert(first.blockers.some((item) => item.code === 'delivery_blocked'));
    assert.match(
      String(first.blockers[0]?.detail),
      /capability_card_unreadable/,
    );
    assert.equal(live.observations[0]?.effect, 'none');
    assert.equal(live.promptCalls(), 0);
    assert.equal(
      JSON.parse(readFileSync(f.outcomeFile, 'utf8')).effect,
      'none',
    );

    writeFileSync(f.cardFile, f.originalCard);
    const second = await applyDispatch(f.request, { adapter: live.adapter });
    assert.equal(second.ok, true, JSON.stringify(second.blockers));
    assert.equal(live.promptCalls(), 1);
    assert.deepEqual(readFileSync(f.intentFile), intentBefore);
  } finally {
    f.domain.cleanup();
  }
});

test('a recognized post-reservation refusal retries only through the validated no-effect outcome', async () => {
  const f = await fixture('dispatch-no-effect-post-reservation');
  const live = liveAdapter(f, [
    { status: 'refused', effect: 'none', detail: 'agent_not_found' },
    { status: 'submitted', detail: null },
  ]);
  try {
    const first = await applyDispatch(f.request, { adapter: live.adapter });
    assert.equal(first.ok, false);
    assert.equal(live.observations[0]?.effect, 'none');
    assert.equal(live.promptCalls(), 1);
    const firstDelivery = JSON.parse(
      readFileSync(
        join(f.taskRoot, 'notifications', 'assign-writer-one.json'),
        'utf8',
      ),
    ) as { attempts: unknown[] };
    assert.equal(firstDelivery.attempts.length, 1);

    const second = await applyDispatch(f.request, { adapter: live.adapter });
    assert.equal(second.ok, true, JSON.stringify(second.blockers));
    assert.equal(live.observations[1]?.effect, 'possible');
    assert.equal(live.promptCalls(), 2);
    assert(
      second.warnings.some((warning) => warning.includes('agent_not_found')),
    );
    const secondDelivery = JSON.parse(
      readFileSync(
        join(f.taskRoot, 'notifications', 'assign-writer-one.json'),
        'utf8',
      ),
    ) as { attempts: unknown[] };
    assert.equal(secondDelivery.attempts.length, 2);
    assert.equal(
      JSON.parse(readFileSync(f.outcomeFile, 'utf8')).effect,
      'possible',
    );
  } finally {
    f.domain.cleanup();
  }
});

test('unknown, failed-after-reservation and submitted outcomes stay fenced without replay', async () => {
  for (const status of ['unknown', 'failed', 'submitted'] as const) {
    const f = await fixture(`dispatch-effect-fence-${status}`);
    const live = liveAdapter(f, [
      { status, detail: `${status} fixture` },
      { status: 'submitted', detail: null },
    ]);
    try {
      const first = await applyDispatch(f.request, { adapter: live.adapter });
      const intentBefore = readFileSync(f.intentFile);
      assert.equal(live.observations[0]?.effect, 'possible');
      assert.equal(live.promptCalls(), 1);
      assert.equal(
        JSON.parse(readFileSync(f.outcomeFile, 'utf8')).effect,
        'possible',
      );
      if (status === 'submitted') assert.equal(first.ok, true);
      else assert.equal(first.ok, false);

      const second = await applyDispatch(f.request, { adapter: live.adapter });
      assert.equal(second.ok, false);
      assert(
        second.blockers.some(
          (item) => item.code === 'dispatch_already_attempted',
        ),
      );
      assert.equal(live.promptCalls(), 1);
      assert.deepEqual(readFileSync(f.intentFile), intentBefore);
    } finally {
      f.domain.cleanup();
    }
  }
});

test('a corrupt no-effect outcome fails closed and preserves the intent', async () => {
  const f = await fixture('dispatch-no-effect-corrupt-outcome');
  const live = liveAdapter(f, [{ status: 'submitted', detail: null }]);
  try {
    removeCoordinatorBinding(f);
    const first = await applyDispatch(f.request, { adapter: live.adapter });
    assert.equal(first.ok, false);
    assert.equal(live.observations[0]?.effect, 'none');
    const intentBefore = readFileSync(f.intentFile);

    writeFileSync(f.bindingFile, f.originalBinding);
    writeFileSync(f.outcomeFile, '{corrupt outcome');
    const second = await applyDispatch(f.request, { adapter: live.adapter });
    assert.equal(second.ok, false);
    assert(
      second.blockers.some(
        (item) => item.code === 'dispatch_already_attempted',
      ),
    );
    assert.equal(live.promptCalls(), 0);
    assert.deepEqual(readFileSync(f.intentFile), intentBefore);
    assert.equal(readFileSync(f.outcomeFile, 'utf8'), '{corrupt outcome');
  } finally {
    f.domain.cleanup();
  }
});

test('a re-observed card does not block the retry, while a changed attempt identity still conflicts', async () => {
  const f = await fixture('dispatch-no-effect-reobserved-card');
  const live = liveAdapter(f, [{ status: 'submitted', detail: null }]);
  try {
    removeCoordinatorBinding(f);
    const first = await applyDispatch(f.request, { adapter: live.adapter });
    assert.equal(first.ok, false);
    assert.equal(live.observations[0]?.effect, 'none');
    const intentBefore = readFileSync(f.intentFile);

    // A fresh observation changes the card bytes and therefore the recorded card digest.
    const reobserved = JSON.parse(f.originalCard) as { observed_at: string };
    reobserved.observed_at = new Date(Date.now() + 1000).toISOString();
    writeFileSync(f.cardFile, `${JSON.stringify(reobserved, null, 2)}\n`);
    writeFileSync(f.bindingFile, f.originalBinding);

    // The attempt identity changed (another coordinator pane): still a conflict, no prompt.
    const moved = await applyDispatch(
      { ...f.request, caller_pane: 'w3:p3Z' },
      { adapter: live.adapter },
    );
    assert(
      moved.blockers.some((item) => item.code === 'dispatch_intent_conflict'),
    );
    assert.equal(live.promptCalls(), 0);

    const second = await applyDispatch(f.request, { adapter: live.adapter });
    assert.equal(second.ok, true, JSON.stringify(second.blockers));
    assert.equal(live.promptCalls(), 1);
    assert.deepEqual(readFileSync(f.intentFile), intentBefore);
  } finally {
    f.domain.cleanup();
  }
});

test('a shape-valid outcome pairing no-effect with a submitted status fails closed', async () => {
  const f = await fixture('dispatch-no-effect-forged-outcome');
  const live = liveAdapter(f, [{ status: 'submitted', detail: null }]);
  try {
    removeCoordinatorBinding(f);
    const first = await applyDispatch(f.request, { adapter: live.adapter });
    assert.equal(first.ok, false);
    assert.equal(live.observations[0]?.effect, 'none');
    const intentBefore = readFileSync(f.intentFile);

    // Forge an outcome that is valid JSON with the right digest but contradicts itself.
    const outcome = JSON.parse(readFileSync(f.outcomeFile, 'utf8')) as {
      status: string;
    };
    for (const status of [
      'submitted',
      'unknown',
      'already_recorded',
      'in_flight_unknown',
      'retry_limit',
    ]) {
      outcome.status = status;
      writeFileSync(f.outcomeFile, `${JSON.stringify(outcome, null, 2)}\n`);
      writeFileSync(f.bindingFile, f.originalBinding);
      const retry = await applyDispatch(f.request, { adapter: live.adapter });
      assert.equal(retry.ok, false, status);
      assert(
        retry.blockers.some(
          (item) => item.code === 'dispatch_already_attempted',
        ),
        status,
      );
      assert.equal(live.promptCalls(), 0, status);
      assert.deepEqual(readFileSync(f.intentFile), intentBefore);
    }
  } finally {
    f.domain.cleanup();
  }
});
