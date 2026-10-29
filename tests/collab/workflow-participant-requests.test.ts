import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyDispatch,
  applyParticipant,
  applyPrepare,
  planDispatch,
  type WorkflowDispatchRequest,
  type WorkflowParticipantRequest,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import { type NotifyResult } from '../../src/app/collab-notify.js';
import {
  createHerdrWorkExecutionAdapter,
  type WorkExecutionAdapter,
} from '../../src/app/collab-work-execution.js';
import type {
  HerdrAgentObservation,
  HerdrCallerObservation,
  HerdrPromptResult,
  HerdrTransport,
} from '../../src/app/collab-notify.js';
import {
  workflowParticipantRequestPath,
  workflowParticipantRequestsDir,
} from '../../src/app/collab-notify.js';
import { inspectWorkflow } from '../../src/app/collab-workflow/inspect.js';
import { parseWorkflowParticipantRequest } from '../../src/schemas/collab-workflow.js';
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

type ResourceInput = {
  readonly path: string;
  readonly access: 'read' | 'write';
  readonly scope?: 'file' | 'tree';
};

function prepareRequest(
  domainRoot: string,
  cwd: string,
  resources: readonly ResourceInput[] = [
    { path: join(cwd, 'output.txt'), access: 'write', scope: 'file' },
  ],
): WorkflowPrepareRequest {
  return {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: domainRoot,
    task_id: 'cohort',
    goal: {
      objective: 'Exercise participant request files and ACK warnings.',
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
        objective: 'Produce one declared output.',
        acceptance: ['The output file is updated.'],
        resources: [...resources],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ],
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  };
}

function capabilityCard(cwd: string) {
  return {
    schema: 'harness-collab/capabilities/1' as const,
    agent_id: WRITER.agent_id,
    session_id: WRITER.session_id,
    harness: WRITER.harness,
    surface: WRITER.surface,
    configuration_id: WRITER.configuration_id,
    cwd,
    observed_at: new Date().toISOString(),
    evidence_level: 'runtime' as const,
    skills: [],
    tools: [],
  };
}

function dispatchRequest(
  taskRoot: string,
  cardFile: string,
): WorkflowDispatchRequest {
  return {
    schema: 'pappra/collab-workflow-dispatch-request/1',
    task_root: taskRoot,
    caller: { ...COORDINATOR, cwd: taskRoot },
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
}

const submittedAdapter: WorkExecutionAdapter = {
  preflight: async () => ({
    ok: true,
    status: 'submitted',
    detail: null,
    effect: 'possible' as const,
  }),
  dispatch: async () => ({
    ok: true,
    status: 'submitted',
    detail: null,
    effect: 'possible' as const,
    message_digest:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    delivery_path: null,
    target_pane: 'w3:p3W',
  }),
};

const silentNotify = (async () => ({
  ok: true as const,
  value: {
    status: 'submitted',
    messageId: '',
    messagePath: '',
    messageDigest: '',
    taskId: '',
    recipient: { agent_id: '', harness: '' },
    target: null,
    caller: null,
    transport: 'none' as const,
    deliveryPath: null,
    attempts: 1,
    priorStatus: null,
    detail: null,
    consumed: false,
    taskAccepted: false,
  } as unknown as NotifyResult,
})) as unknown as typeof import('../../src/app/collab-notify.js').notifyRegisteredMessage;

async function fixture(
  name: string,
  resources?: (root: string) => ResourceInput[],
) {
  const domain = makeTaskDomain(name, ['cohort'], { initialize: [] });
  const prepared = await applyPrepare(
    prepareRequest(domain.domainRoot, domain.root, resources?.(domain.root)),
  );
  assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
  const taskRoot = join(domain.domainRoot, 'tasks', 'cohort');
  const cardFile = join(domain.root, 'card.json');
  writeFileSync(
    cardFile,
    `${JSON.stringify(capabilityCard(domain.root), null, 2)}\n`,
  );
  writeFileSync(join(domain.root, 'output.txt'), 'fixture\n');
  return { domain, taskRoot, cardFile };
}

function makeTransport(root: string) {
  const prompts: { agent: string; text: string }[] = [];
  const caller: HerdrCallerObservation = {
    paneId: 'w3:p3B',
    workspaceId: 'w3',
    tabId: 'w3:t1',
    harness: 'pi',
    cwd: root,
    sessionKind: 'id',
    sessionValue: COORDINATOR.session_id,
    source: 'explicit',
  };
  const agents: HerdrAgentObservation[] = [
    {
      name: COORDINATOR.agent_id,
      harness: 'pi',
      paneId: 'w3:p3B',
      cwd: root,
      sessionValue: COORDINATOR.session_id,
      sessionKind: 'id',
      status: 'idle',
      focused: false,
    },
    {
      name: WRITER.agent_id,
      harness: 'pi',
      paneId: 'w3:p3W',
      cwd: root,
      sessionValue: WRITER.session_id,
      sessionKind: 'id',
      status: 'idle',
      focused: false,
    },
  ];
  const transport: HerdrTransport = {
    id: 'participant-request-fake',
    verifyCaller: async () => ({ ok: true, caller }),
    list: async () => ({ ok: true, agents }),
    prompt: async (agent, text) => {
      prompts.push({ agent, text });
      return { status: 'submitted', detail: null } as HerdrPromptResult;
    },
  };
  const adapter = createHerdrWorkExecutionAdapter({ transport });
  return { adapter, prompts };
}

test('dispatch writes exclusive, digest-stable participant request files', async () => {
  const f = await fixture('dispatch-participant-files');
  try {
    const first = await applyDispatch(dispatchRequest(f.taskRoot, f.cardFile), {
      adapter: submittedAdapter,
    });
    assert.equal(first.status, 'applied', JSON.stringify(first.blockers));

    const reqDir = workflowParticipantRequestsDir(f.taskRoot, 'writer-one', 1);
    assert.equal(existsSync(reqDir), true);

    const ackFile = workflowParticipantRequestPath(
      f.taskRoot,
      'writer-one',
      1,
      'ack',
    );
    const reportFile = workflowParticipantRequestPath(
      f.taskRoot,
      'writer-one',
      1,
      'report',
    );
    const releaseFile = workflowParticipantRequestPath(
      f.taskRoot,
      'writer-one',
      1,
      'release',
    );
    assert.equal(existsSync(ackFile), true);
    assert.equal(existsSync(reportFile), true);
    assert.equal(existsSync(releaseFile), true);

    const ack = JSON.parse(readFileSync(ackFile, 'utf8')) as {
      action: string;
      caller: {
        agent_id: string;
        session_id: string;
        harness: string;
        cwd: string;
      };
      caller_pane: string | null;
    };
    assert.equal(ack.action, 'ack');
    assert.equal(ack.caller.agent_id, WRITER.agent_id);
    assert.equal(ack.caller.session_id, WRITER.session_id);
    assert.equal(ack.caller.harness, WRITER.harness);
    assert.equal(ack.caller_pane, 'w3:p3W');

    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as {
      action: string;
      report: {
        status: string;
        summary: string;
        blockers: string[];
        outputs: string[];
      };
    };
    assert.equal(report.action, 'report');
    assert.equal(report.report.status, 'running');
    assert.equal(report.report.blockers.length, 0);
    assert.deepEqual(report.report.outputs, [
      join(f.domain.root, 'output.txt'),
    ]);

    const release = JSON.parse(readFileSync(releaseFile, 'utf8')) as {
      action: string;
      release: {
        reason: string;
        cancel_attempt: boolean;
        correlates_to: string;
      };
    };
    assert.equal(release.action, 'release');
    assert.equal(release.release.cancel_attempt, false);
    assert.equal(release.release.correlates_to, 'accept-writer-one-1');

    const bytesBefore = readFileSync(reportFile);

    const second = await applyDispatch(
      dispatchRequest(f.taskRoot, f.cardFile),
      {
        adapter: submittedAdapter,
      },
    );
    assert.equal(second.status, 'needs-reconciliation');
    assert(
      second.blockers.some(
        (item) => item.code === 'dispatch_already_attempted',
      ),
    );
    assert.deepEqual(readFileSync(reportFile), bytesBefore);
  } finally {
    f.domain.cleanup();
  }
});

test('ASSIGN notification text gains a bounded second line', async () => {
  const f = await fixture('dispatch-assign-second-line');
  try {
    const { adapter, prompts } = makeTransport(f.domain.root);
    const result = await applyDispatch(
      dispatchRequest(f.taskRoot, f.cardFile),
      { adapter },
    );
    assert.equal(result.status, 'applied', JSON.stringify(result.blockers));
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.agent, WRITER.agent_id);

    const text = prompts[0]?.text ?? '';
    const lines = text.split('\n');
    assert.equal(lines.length, 2, 'ASSIGN notification has exactly two lines');
    assert.match(
      lines[0]!,
      /^COLLAB_MESSAGE task=cohort type=ASSIGN message=.* digest=/,
    );
    assert.match(lines[1]!, /Participant request files are under/);
    assert.match(
      lines[1]!,
      /node dist\/cli\/main\.js collab workflow ack\|report\|release/,
    );
    assert.match(
      lines[1]!,
      /A typed COLLAB_MESSAGE line in chat is not registered and is never accepted/,
    );
    assert.ok(lines[1]!.length <= 600);
  } finally {
    f.domain.cleanup();
  }
});

test('plan dispatch and inspect warn ack_not_registered until ACK is applied', async () => {
  const f = await fixture('dispatch-ack-warning');
  try {
    const dispatched = await applyDispatch(
      dispatchRequest(f.taskRoot, f.cardFile),
      { adapter: submittedAdapter },
    );
    assert.equal(
      dispatched.status,
      'applied',
      JSON.stringify(dispatched.blockers),
    );

    const plannedBefore = planDispatch(dispatchRequest(f.taskRoot, f.cardFile));
    assert.equal(plannedBefore.ok, true);
    if (!plannedBefore.ok) return;
    assert.ok(
      plannedBefore.value.warnings.some((item) =>
        item.includes('ack_not_registered'),
      ),
      JSON.stringify(plannedBefore.value.warnings),
    );

    const inspectedBefore = await inspectWorkflow(f.taskRoot);
    assert.equal(inspectedBefore.status, 'applied');
    assert.ok(
      inspectedBefore.warnings.some((item) =>
        item.includes('ack_not_registered'),
      ),
      JSON.stringify(inspectedBefore.warnings),
    );

    const ackRequest = JSON.parse(
      readFileSync(
        workflowParticipantRequestPath(f.taskRoot, 'writer-one', 1, 'ack'),
        'utf8',
      ),
    ) as WorkflowParticipantRequest;
    const acked = await applyParticipant(ackRequest, {
      apply: true,
      notify: silentNotify,
    });
    assert.equal(acked.status, 'applied', JSON.stringify(acked.blockers));

    const plannedAfter = planDispatch(dispatchRequest(f.taskRoot, f.cardFile));
    assert.equal(plannedAfter.ok, true);
    if (!plannedAfter.ok) return;
    assert.ok(
      !plannedAfter.value.warnings.some((item) =>
        item.includes('ack_not_registered'),
      ),
      JSON.stringify(plannedAfter.value.warnings),
    );

    const inspectedAfter = await inspectWorkflow(f.taskRoot);
    assert.equal(inspectedAfter.status, 'applied');
    assert.ok(
      !inspectedAfter.warnings.some((item) =>
        item.includes('ack_not_registered'),
      ),
      JSON.stringify(inspectedAfter.warnings),
    );
  } finally {
    f.domain.cleanup();
  }
});

test('generated participant request files all validate against the participant schema', async () => {
  const f = await fixture('dispatch-participant-schema');
  try {
    const dispatched = await applyDispatch(
      dispatchRequest(f.taskRoot, f.cardFile),
      { adapter: submittedAdapter },
    );
    assert.equal(
      dispatched.status,
      'applied',
      JSON.stringify(dispatched.blockers),
    );
    const files = {
      ack: workflowParticipantRequestPath(f.taskRoot, 'writer-one', 1, 'ack'),
      report: workflowParticipantRequestPath(
        f.taskRoot,
        'writer-one',
        1,
        'report',
      ),
      release: workflowParticipantRequestPath(
        f.taskRoot,
        'writer-one',
        1,
        'release',
      ),
    };
    const parsed = {
      ack: parseWorkflowParticipantRequest(
        JSON.parse(readFileSync(files.ack, 'utf8')),
      ),
      report: parseWorkflowParticipantRequest(
        JSON.parse(readFileSync(files.report, 'utf8')),
      ),
      release: parseWorkflowParticipantRequest(
        JSON.parse(readFileSync(files.release, 'utf8')),
      ),
    };
    for (const [action, result] of Object.entries(parsed))
      assert.equal(result.ok, true, `${action}: ${JSON.stringify(result)}`);
    const ack = JSON.parse(readFileSync(files.ack, 'utf8')) as {
      action: string;
      report: unknown;
      release: unknown;
    };
    assert.equal(ack.action, 'ack');
    assert.equal(ack.report, null);
    assert.equal(ack.release, null);
    const report = JSON.parse(readFileSync(files.report, 'utf8')) as {
      report: { status: string } | null;
      release: unknown;
    };
    assert.equal(report.report?.status, 'running');
    assert.equal(report.release, null);
    const release = JSON.parse(readFileSync(files.release, 'utf8')) as {
      report: unknown;
      release: { reason: string } | null;
    };
    assert.equal(release.report, null);
    assert.notEqual(release.release, null);

    // The generated shape is what makes the file usable; a missing key is still refused.
    const ackWithout: Record<string, unknown> = { ...ack };
    delete ackWithout['report'];
    delete ackWithout['release'];
    const reportWithout: Record<string, unknown> = { ...report };
    delete reportWithout['release'];
    const releaseWithout: Record<string, unknown> = { ...release };
    delete releaseWithout['report'];
    for (const withoutKey of [ackWithout, reportWithout, releaseWithout]) {
      const rejected = parseWorkflowParticipantRequest(withoutKey);
      assert.equal(rejected.ok, false, JSON.stringify(withoutKey));
    }
  } finally {
    f.domain.cleanup();
  }
});

test('generated report outputs list only file-scoped write resources', async () => {
  const treePath = 'src-tree';
  const f = await fixture('dispatch-outputs-file-scope', (root) => [
    { path: join(root, treePath), access: 'write' },
    { path: join(root, 'output.txt'), access: 'write', scope: 'file' },
  ]);
  try {
    mkdirSync(join(f.domain.root, treePath), { recursive: true });
    const dispatched = await applyDispatch(
      dispatchRequest(f.taskRoot, f.cardFile),
      { adapter: submittedAdapter },
    );
    assert.equal(
      dispatched.status,
      'applied',
      JSON.stringify(dispatched.blockers),
    );
    const reportFile = workflowParticipantRequestPath(
      f.taskRoot,
      'writer-one',
      1,
      'report',
    );
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as {
      report: { outputs: string[] };
    };
    assert.deepEqual(report.report.outputs, [
      join(f.domain.root, 'output.txt'),
    ]);
    assert.equal(
      report.report.outputs.includes(join(f.domain.root, treePath)),
      false,
    );

    const bytesBefore = readFileSync(reportFile);
    const rerun = await applyDispatch(dispatchRequest(f.taskRoot, f.cardFile), {
      adapter: submittedAdapter,
    });
    assert.equal(rerun.status, 'needs-reconciliation');
    assert.deepEqual(readFileSync(reportFile), bytesBefore);
  } finally {
    f.domain.cleanup();
  }
});

test('a tree-only assignment generates an empty outputs list that reports without edits', async () => {
  const treePath = 'src-tree';
  const f = await fixture('dispatch-outputs-tree-only', (root) => [
    { path: join(root, treePath), access: 'write' },
  ]);
  try {
    mkdirSync(join(f.domain.root, treePath), { recursive: true });
    const dispatched = await applyDispatch(
      dispatchRequest(f.taskRoot, f.cardFile),
      { adapter: submittedAdapter },
    );
    assert.equal(
      dispatched.status,
      'applied',
      JSON.stringify(dispatched.blockers),
    );
    const reportFile = workflowParticipantRequestPath(
      f.taskRoot,
      'writer-one',
      1,
      'report',
    );
    const generated = JSON.parse(readFileSync(reportFile, 'utf8')) as {
      report: { outputs: string[] };
    };
    assert.deepEqual(generated.report.outputs, []);

    // The file is usable exactly as generated: the real report action accepts it, so the
    // report path never has to digest a tree.
    const reported = await applyParticipant(
      generated as unknown as WorkflowParticipantRequest,
      { apply: true, notify: silentNotify },
    );
    assert.equal(reported.status, 'applied', JSON.stringify(reported.blockers));
    assert.deepEqual(
      reported.blockers.filter((item) => item.code === 'output_missing'),
      [],
    );

    const bytesBefore = readFileSync(reportFile);
    const rerun = await applyDispatch(dispatchRequest(f.taskRoot, f.cardFile), {
      adapter: submittedAdapter,
    });
    assert.equal(rerun.status, 'needs-reconciliation');
    assert.deepEqual(readFileSync(reportFile), bytesBefore);
  } finally {
    f.domain.cleanup();
  }
});
