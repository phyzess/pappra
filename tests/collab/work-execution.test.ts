import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runCollaborationPreflight } from '../../src/app/collab-preflight.js';
import { inspectWorkPlan } from '../../src/app/collab-work-plan.js';
import {
  parseCollaborationWorkRunArgs,
  runCollaborationWorkRunCommand,
} from '../../src/cli/commands/collaboration-work-run.js';
import {
  runWorkExecution,
  createHerdrWorkExecutionAdapter,
  type WorkExecutionAdapter,
  type WorkExecutionObservation,
} from '../../src/app/collab-work-execution.js';
import type {
  HerdrAgentObservation,
  HerdrTransport,
} from '../../src/app/collab-notify.js';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { claimResources, releaseClaim } from '../../src/collab/resources.js';
import { notificationsDir, readRecord } from '../../src/collab/store.js';
import type {
  Identity,
  Message,
  MessageInput,
} from '../../src/collab/types.js';
import { WORK_PLAN_SCHEMA } from '../../src/collab/work-plan.js';
import { makeTaskDomain, snapshotTree } from './task-resources-fixtures.js';
import { owner } from './scenarios.js';

const TASK = 'sample';
const INPUT_REVISION =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COORDINATOR: Identity = {
  agent_id: owner.agent_id,
  session_id: owner.session_id,
  harness: owner.harness,
};
const WORKSPACE = 'workspace';

function digest(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function writeJson(file: string, value: unknown): string {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(file, bytes);
  return digest(bytes);
}

interface WorkFixture {
  readonly root: string;
  readonly taskRoot: string;
  readonly planFile: string;
  readonly bindingFile: string;
  readonly request: {
    readonly task_root: string;
    readonly plan_file: string;
    readonly binding_file: string;
    readonly caller: Identity & { readonly cwd: string };
    readonly caller_pane: string;
    readonly capability_cards: readonly {
      readonly assignment_id: string;
      readonly capabilities_file: string;
    }[];
    readonly max_concurrency: number;
  };
  readonly assignmentMessages: Readonly<Record<string, Message>>;
  cleanup(): void;
}

function makeFixture(
  label: string,
  options: {
    readonly count?: number;
    readonly overlap?: boolean;
    readonly dependency?: boolean;
  } = {},
): WorkFixture {
  const count = options.count ?? 2;
  const domain = makeTaskDomain(`work-execution-${label}`, [TASK]);
  const taskRoot = domain.tasks[TASK]!;
  const workspace = join(domain.root, WORKSPACE);
  mkdirSync(workspace, { recursive: true });
  const inputFile = join(domain.root, 'input.json');
  writeFileSync(inputFile, '{"input":1}\n');
  const inputDigest = digest(readFileSync(inputFile));
  const inputRevision = INPUT_REVISION;
  const planNodes: Record<string, unknown>[] = [];
  const participants: Record<string, unknown>[] = [];
  const capabilities: { assignment_id: string; capabilities_file: string }[] =
    [];
  const assignmentMessages: Record<string, Message> = {};
  const resourcePaths: string[] = [];

  const coordinatorBinding = {
    agent_id: COORDINATOR.agent_id,
    harness: COORDINATOR.harness,
    cwd: workspace,
    herdr_agent: 'coordinator',
    pane_id: 'w1:p1',
    native_session_id: COORDINATOR.session_id,
  };
  participants.push(coordinatorBinding);

  for (let index = 0; index < count; index += 1) {
    const assignmentId = `writer-${index + 1}`;
    const worker: Identity = {
      agent_id: `worker-${index + 1}`,
      session_id: `worker-session-${index + 1}`,
      harness: 'pi',
    };
    const resourcePath = join(
      workspace,
      options.overlap && index > 0
        ? 'shared-output.ts'
        : `output-${index + 1}.ts`,
    );
    resourcePaths.push(resourcePath);
    const claimed = claimResources(taskRoot, {
      resources: [{ kind: 'path', path: resourcePath, scope: 'file' }],
      holder: worker,
      access: 'write',
      subtaskId: assignmentId,
      attempt: 1,
    });
    assert.equal(claimed.ok, true, `claim failed: ${JSON.stringify(claimed)}`);
    if (!claimed.ok) throw new Error('claim fixture failed');
    const assignmentFile = join(domain.root, `${assignmentId}.assignment.json`);
    const cardFile = join(domain.root, `${assignmentId}.capabilities.json`);
    const assignment = {
      schema: 'harness-collab/assignment/1',
      task_id: TASK,
      assignment_id: assignmentId,
      attempt: 1,
      objective: `Implement ${assignmentId}`,
      roles: ['writer'],
      acceptance: ['Coordinator reviews the pinned result.'],
      coordinator: { ...COORDINATOR, owner_epoch: 1 },
      assignee: {
        ...worker,
        cwd: workspace,
        surface: 'cli',
        configuration_id: 'fixture-visible',
      },
      inputs: [{ ref: inputFile, digest: inputDigest }],
      resources: [
        {
          path: resourcePath,
          access: 'write',
          resource_epoch: claimed.resource_epoch,
        },
      ],
      runner: {
        name: 'existing-session',
        mode: 'native-session',
        omitted_capabilities: [],
      },
      required: { skills: [], tools: ['read', 'bash'] },
      preferred: { skills: [], tools: [] },
    };
    const assignmentDigest = writeJson(assignmentFile, assignment);
    const assignmentMessage = buildMessage({
      message_id: `msg-assign-${assignmentId}`,
      type: 'ASSIGN',
      task_id: TASK,
      from: COORDINATOR,
      to: worker,
      subtask_id: assignmentId,
      attempt: 1,
      owner_epoch: 1,
      body: {
        assignment_ref: assignmentFile,
        assignment_digest: assignmentDigest,
        input_revision: inputRevision,
      },
    });
    const assigned = submitMessage(taskRoot, assignmentMessage);
    assert.equal(
      assigned.ok,
      true,
      `ASSIGN failed: ${JSON.stringify(assigned)}`,
    );
    assignmentMessages[assignmentId] = assignmentMessage;
    const card = {
      schema: 'harness-collab/capabilities/1',
      ...worker,
      surface: 'cli',
      configuration_id: 'fixture-visible',
      cwd: workspace,
      observed_at: new Date().toISOString(),
      evidence_level: 'runtime',
      skills: [],
      tools: [
        {
          id: 'read',
          state: 'verified',
          evidence_ref: `session:${worker.session_id}`,
        },
        {
          id: 'bash',
          state: 'verified',
          evidence_ref: `session:${worker.session_id}`,
        },
      ],
    };
    writeJson(cardFile, card);
    capabilities.push({
      assignment_id: assignmentId,
      capabilities_file: cardFile,
    });
    const dependsOn =
      options.dependency && index === count - 1 ? ['writer-1'] : [];
    planNodes.push({
      node_id: assignmentId,
      role: 'writer',
      assignment_id: assignmentId,
      attempt: 1,
      input_revision: inputRevision,
      assignee: { agent_id: worker.agent_id, session_id: worker.session_id },
      depends_on: dependsOn,
      resources: [
        {
          path: options.overlap && index > 0 ? resourcePaths[0]! : resourcePath,
          access: 'write',
        },
      ],
    });
    participants.push({
      agent_id: worker.agent_id,
      harness: worker.harness,
      cwd: workspace,
      herdr_agent: worker.agent_id,
      pane_id: `w1:p${index + 2}`,
      native_session_id: worker.session_id,
    });
  }

  const planFile = join(domain.root, 'work-plan.json');
  writeJson(planFile, {
    schema: WORK_PLAN_SCHEMA,
    plan_id: 'visible-fork-join',
    task_id: TASK,
    owner_epoch: 1,
    nodes: planNodes,
  });
  const bindingFile = join(domain.root, 'binding.json');
  writeJson(bindingFile, {
    schema: 'pappra/collab-binding/1',
    task_id: TASK,
    task_root: taskRoot,
    channel: 'herdr',
    participants,
  });
  const record = readRecord(taskRoot);
  assert.ok(record);
  assert.equal(record.coordinator?.agent_id, COORDINATOR.agent_id);
  assert.equal(record.attempts.length, count);

  return {
    root: domain.root,
    taskRoot,
    planFile,
    bindingFile,
    request: {
      task_root: taskRoot,
      plan_file: planFile,
      binding_file: bindingFile,
      caller: { ...COORDINATOR, cwd: workspace },
      caller_pane: 'w1:p1',
      capability_cards: capabilities,
      max_concurrency: 2,
    },
    assignmentMessages,
    cleanup: domain.cleanup,
  };
}

function planAdapter(
  dispatch: (
    messageId: string,
  ) => Promise<WorkExecutionObservation> | WorkExecutionObservation = () => ({
    ok: true,
    status: 'submitted',
    detail: null,
    target_pane: 'w1:p2',
  }),
): WorkExecutionAdapter {
  return {
    preflight: async () => ({ ok: true, status: 'planned', detail: null }),
    dispatch: async (request) => dispatch(request.messageId),
  };
}

function send(fixture: WorkFixture, input: MessageInput): Message {
  const message = buildMessage(input);
  const outcome = submitMessage(fixture.taskRoot, message);
  assert.equal(
    outcome.ok,
    true,
    `message ${input.type} failed: ${JSON.stringify(outcome)}`,
  );
  return message;
}

function reportAndDecision(
  fixture: WorkFixture,
  assignmentId: string,
  writer: Identity,
  decisionFrom: Identity,
): Message {
  const assignment = fixture.assignmentMessages[assignmentId]!;
  const report = send(fixture, {
    message_id: `msg-report-${assignmentId}`,
    type: 'REPORT',
    task_id: TASK,
    from: writer,
    to: COORDINATOR,
    reply_to: assignment.message_id,
    subtask_id: assignmentId,
    attempt: 1,
    owner_epoch: 1,
    body: { status: 'completed', input_revision: INPUT_REVISION },
  });
  const decision: MessageInput = {
    message_id: `msg-answer-${assignmentId}-${decisionFrom.agent_id}`,
    type: 'ANSWER',
    task_id: TASK,
    from: decisionFrom,
    to: writer,
    reply_to: report.message_id,
    subtask_id: assignmentId,
    attempt: 1,
    owner_epoch: 1,
    body: {
      acceptance: {
        plan_id: 'visible-fork-join',
        node_id: assignmentId,
        assignment_id: assignmentId,
        attempt: 1,
        input_revision: INPUT_REVISION,
        report_message_id: report.message_id,
        report_digest: report.content_digest,
        decision: 'accepted',
      },
    },
  };
  if (
    decisionFrom.agent_id === COORDINATOR.agent_id &&
    decisionFrom.session_id === COORDINATOR.session_id
  ) {
    send(fixture, decision);
  } else {
    const message = buildMessage(decision);
    const outcome = submitMessage(fixture.taskRoot, message);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'unauthorized_sender');
    assert.equal(
      readRecord(fixture.taskRoot)?.messages.some(
        (entry) => entry.message_id === message.message_id,
      ),
      false,
      'the forged decision must not enter authoritative acceptance evidence',
    );
  }
  return report;
}

test('plan mode has zero effects and deterministic aggregation', async () => {
  const fixture = makeFixture('dry-run');
  try {
    const before = snapshotTree(fixture.root);
    let adapterCalls = 0;
    const adapter: WorkExecutionAdapter = {
      preflight: async () => {
        adapterCalls += 1;
        return { ok: true, status: 'planned', detail: null };
      },
      dispatch: async () => {
        adapterCalls += 1;
        return { ok: true, status: 'submitted', detail: null };
      },
    };
    const first = await runWorkExecution(
      { request: fixture.request, apply: false },
      { adapter },
    );
    const second = await runWorkExecution(
      { request: fixture.request, apply: false },
      { adapter },
    );
    assert.equal(first.status, 'planned');
    assert.deepEqual(
      first.nodes.map((node) => node.execution_status),
      ['planned', 'planned'],
      JSON.stringify(first.nodes),
    );
    assert.deepEqual(second, first);
    assert.equal(adapterCalls, 0);
    assert.deepEqual(snapshotTree(fixture.root), before);
  } finally {
    fixture.cleanup();
  }
});

test('assigned work is dispatch-pending until its durable intent exists even before native binding', async () => {
  const fixture = makeFixture('assigned-pending-dispatch', { count: 1 });
  try {
    const inspect = () =>
      inspectWorkPlan({
        taskRoot: fixture.taskRoot,
        planFile: fixture.planFile,
      });
    const before = await inspect();
    assert.equal(before.nodes[0]?.status, 'running');
    assert.equal(before.nodes[0]?.dispatch_pending, true);
    await runWorkExecution(
      { request: fixture.request, apply: true },
      { adapter: planAdapter() },
    );
    assert.equal(
      readRecord(fixture.taskRoot)?.attempts[0]?.native.observation,
      'unknown',
    );
    assert.equal((await inspect()).nodes[0]?.dispatch_pending, false);
  } finally {
    fixture.cleanup();
  }
});

test('typed CLI handler validates request and returns a read-only JSON plan', async () => {
  const fixture = makeFixture('cli-handler', { count: 1 });
  try {
    const requestFile = join(fixture.root, 'work-execution-request.json');
    writeJson(requestFile, {
      schema: 'pappra/collab-work-execution-request/1',
      ...fixture.request,
    });
    const parsed = parseCollaborationWorkRunArgs([
      '--request',
      requestFile,
      '--json',
    ]);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.options.apply, false);
    let stdout = '';
    let stderr = '';
    const exitCode = await runCollaborationWorkRunCommand(parsed.options, {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
    });
    assert.equal(exitCode, 0, stderr);
    assert.equal((JSON.parse(stdout) as { status: string }).status, 'planned');
    const invalid = parseCollaborationWorkRunArgs([
      '--request',
      requestFile,
      '--request',
      requestFile,
    ]);
    assert.ok(invalid.errors.some((error) => error.includes('only once')));
  } finally {
    fixture.cleanup();
  }
});

test('a late revoked writer claim is not masked by its existing intent', async () => {
  const fixture = makeFixture('late-revoke-after-intent');
  try {
    const initial = readRecord(fixture.taskRoot);
    assert.ok(initial);
    const claim = initial.claims.find(
      (item) => item.subtask_id === 'writer-1' && item.released_at === null,
    );
    assert.ok(claim);
    const preflightCalls = new Map<string, number>();
    const dispatched: string[] = [];
    const adapter: WorkExecutionAdapter = {
      preflight: async (request) => {
        const count = (preflightCalls.get(request.messageId) ?? 0) + 1;
        preflightCalls.set(request.messageId, count);
        if (
          request.messageId ===
            fixture.assignmentMessages['writer-2']!.message_id &&
          count === 2
        ) {
          const released = releaseClaim(fixture.taskRoot, {
            claimId: claim.claim_id,
            holder: claim.holder,
            reason: 'late competing release',
          });
          assert.equal(released.ok, true);
        }
        return { ok: true, status: 'planned', detail: null };
      },
      dispatch: async (request) => {
        dispatched.push(request.messageId);
        return { ok: true, status: 'submitted', detail: null };
      },
    };
    const result = await runWorkExecution(
      { request: fixture.request, apply: true },
      { adapter },
    );
    assert.deepEqual(dispatched, [
      fixture.assignmentMessages['writer-2']!.message_id,
    ]);
    const revoked = result.nodes.find((node) => node.node_id === 'writer-1');
    assert.equal(revoked?.execution_status, 'blocked');
    assert.ok(
      revoked?.blockers.some((blocker) =>
        blocker.startsWith('late_block:resource_claim_missing:'),
      ),
    );
    assert.equal(
      result.nodes.find((node) => node.node_id === 'writer-2')
        ?.execution_status,
      'dispatched',
    );
  } finally {
    fixture.cleanup();
  }
});

test('concurrent invocations of the same cause dispatch at most once', async () => {
  const fixture = makeFixture('concurrent-same-cause', { count: 1 });
  try {
    let sends = 0;
    const adapter = planAdapter(() => {
      sends += 1;
      return { ok: true, status: 'submitted', detail: null };
    });
    const results = await Promise.all([
      runWorkExecution({ request: fixture.request, apply: true }, { adapter }),
      runWorkExecution({ request: fixture.request, apply: true }, { adapter }),
    ]);
    assert.equal(sends, 1);
    assert.equal(
      results.filter(
        (result) => result.nodes[0]?.execution_status === 'dispatched',
      ).length,
      1,
    );
    const record = readRecord(fixture.taskRoot);
    assert.ok(record);
    assert.equal(
      record.messages.filter(
        (item) =>
          item.type === 'STATUS_QUERY' &&
          item.message_id.startsWith('msg-work-intent-'),
      ).length,
      1,
    );
  } finally {
    fixture.cleanup();
  }
});

test('production Herdr adapter rechecks authority after live routing and immediately before prompt', async () => {
  const fixture = makeFixture('production-final-guard', { count: 1 });
  try {
    mkdirSync(notificationsDir(fixture.taskRoot), { recursive: true });
    const cardFile = fixture.request.capability_cards[0]!.capabilities_file;
    const card = JSON.parse(readFileSync(cardFile, 'utf8')) as Record<
      string,
      unknown
    >;
    let changedAfterRouting = false;
    let verifiedCallers = 0;
    let listedAgents = 0;
    let prompts = 0;
    const recipient: HerdrAgentObservation = {
      get name() {
        if (!changedAfterRouting) {
          changedAfterRouting = true;
          writeJson(cardFile, { ...card, agent_id: 'foreign-after-routing' });
        }
        return 'worker-1';
      },
      harness: 'pi',
      paneId: 'w1:p2',
      cwd: fixture.request.caller.cwd,
      sessionKind: 'id',
      sessionValue: 'worker-session-1',
      status: 'running',
      focused: false,
    };
    const coordinator: HerdrAgentObservation = {
      name: 'coordinator',
      harness: 'pi',
      paneId: 'w1:p1',
      cwd: fixture.request.caller.cwd,
      sessionKind: 'id',
      sessionValue: fixture.request.caller.session_id,
      status: 'running',
      focused: false,
    };
    const transport: HerdrTransport = {
      id: 'fixture-herdr-transport',
      verifyCaller: async (options) => {
        verifiedCallers += 1;
        return {
          ok: true,
          caller: {
            paneId: options?.paneId ?? 'w1:p1',
            workspaceId: null,
            tabId: null,
            harness: 'pi',
            cwd: fixture.request.caller.cwd,
            sessionKind: 'id',
            sessionValue: fixture.request.caller.session_id,
            source: 'explicit',
          },
        };
      },
      list: async () => {
        listedAgents += 1;
        return { ok: true, agents: [coordinator, recipient] };
      },
      prompt: async () => {
        prompts += 1;
        return { status: 'submitted', detail: null };
      },
    };
    const result = await runWorkExecution(
      { request: fixture.request, apply: true },
      { adapter: createHerdrWorkExecutionAdapter({ transport }) },
    );
    assert.equal(verifiedCallers, 1);
    assert.equal(listedAgents, 1);
    assert.equal(changedAfterRouting, true);
    assert.equal(prompts, 0);
    assert.equal(result.nodes[0]!.execution_status, 'blocked');
    assert.equal(result.nodes[0]!.delivery?.status, 'blocked');
  } finally {
    fixture.cleanup();
  }
});

test('production work adapter preserves registered native delivery context after the final guard', async () => {
  const fixture = makeFixture('native-registered-context', { count: 1 });
  try {
    mkdirSync(notificationsDir(fixture.taskRoot), { recursive: true });
    const identity = {
      name: 'coordinator',
      harness: 'pi',
      paneId: 'w1:p1',
      cwd: fixture.request.caller.cwd,
      sessionKind: 'id' as const,
      sessionValue: fixture.request.caller.session_id,
      status: 'working',
      focused: false,
    };
    const transport: HerdrTransport = {
      id: 'registered-native-fixture',
      verifyCaller: async () => ({
        ok: true,
        caller: {
          ...identity,
          workspaceId: null,
          tabId: null,
          source: 'explicit',
        },
      }),
      list: async () => ({
        ok: true,
        agents: [
          identity,
          {
            ...identity,
            name: 'worker-1',
            paneId: 'w1:p2',
            sessionValue: 'worker-session-1',
          },
        ],
      }),
      prompt: async (_agent, _text, registered) => {
        assert(
          registered,
          'the authenticated SDK route requires registered-message context',
        );
        assert.equal(registered.taskRoot, fixture.taskRoot);
        assert.equal(registered.sessionId, 'worker-session-1');
        assert.equal(
          registered.messageId,
          fixture.assignmentMessages['writer-1']?.message_id,
        );
        return { status: 'submitted', detail: null };
      },
    };
    const result = await runWorkExecution(
      { request: fixture.request, apply: true },
      { adapter: createHerdrWorkExecutionAdapter({ transport }) },
    );
    assert.equal(
      result.nodes[0]?.execution_status,
      'dispatched',
      JSON.stringify(result),
    );
  } finally {
    fixture.cleanup();
  }
});

test('two disjoint assigned writers really overlap after durable intents', async () => {
  const fixture = makeFixture('concurrent');
  try {
    let active = 0;
    let peak = 0;
    let arrivals = 0;
    let release!: () => void;
    const rendezvous = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = planAdapter(async () => {
      active += 1;
      peak = Math.max(peak, active);
      arrivals += 1;
      if (arrivals === 2) release();
      await rendezvous;
      active -= 1;
      return {
        ok: true,
        status: 'submitted',
        detail: null,
        target_pane: 'w1:p2',
      };
    });
    const result = await runWorkExecution(
      { request: fixture.request, apply: true },
      { adapter },
    );
    assert.equal(result.status, 'applied');
    assert.equal(result.concurrency.actual_overlap, true);
    assert.equal(peak, 2);
    assert.deepEqual(
      result.nodes.map((node) => node.execution_status),
      ['dispatched', 'dispatched'],
    );
    const record = readRecord(fixture.taskRoot);
    assert.ok(record);
    assert.equal(
      record.messages.filter(
        (item) =>
          item.type === 'STATUS_QUERY' &&
          item.message_id.startsWith('msg-work-intent-'),
      ).length,
      2,
    );
  } finally {
    fixture.cleanup();
  }
});

test('duplicate invocation and unknown notification are reconciliation-only', async () => {
  const fixture = makeFixture('unknown-replay');
  try {
    let sends = 0;
    const adapter = planAdapter(async () => {
      sends += 1;
      return {
        ok: false,
        status: 'unknown',
        detail: 'transport outcome unknown',
      };
    });
    const first = await runWorkExecution(
      { request: fixture.request, apply: true },
      { adapter },
    );
    assert.equal(first.status, 'needs-reconciliation');
    assert.equal(sends, 2);
    const second = await runWorkExecution(
      { request: fixture.request, apply: true },
      { adapter },
    );
    assert.equal(second.status, 'needs-reconciliation');
    assert.equal(
      second.nodes.every((node) =>
        node.blockers.includes('dispatch_intent_exists_reconcile'),
      ),
      true,
    );
    assert.equal(sends, 2);
  } finally {
    fixture.cleanup();
  }
});

test('conflicting assignment resources and missing claims never dispatch', async () => {
  const fixture = makeFixture('overlap', { overlap: true });
  try {
    let sends = 0;
    const result = await runWorkExecution(
      { request: fixture.request, apply: true },
      {
        adapter: planAdapter(() => {
          sends += 1;
          return { ok: true, status: 'submitted', detail: null };
        }),
      },
    );
    assert.equal(sends, 0);
    assert.ok(
      result.nodes.some((node) =>
        node.blockers.some((blocker) => blocker.includes('resource')),
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test('a foreign capability card blocks only its own node', async () => {
  const fixture = makeFixture('identity');
  try {
    const cardFile = fixture.request.capability_cards[0]!.capabilities_file;
    const card = JSON.parse(readFileSync(cardFile, 'utf8')) as Record<
      string,
      unknown
    >;
    card.agent_id = 'foreign-worker';
    writeJson(cardFile, card);
    const current = readRecord(fixture.taskRoot);
    assert.ok(current);
    const assignmentRef = current.attempts.find(
      (attempt) => attempt.subtask_id === 'writer-1',
    )?.assignment_ref;
    assert.ok(assignmentRef);
    const preflight = runCollaborationPreflight({
      assignmentFile: assignmentRef,
      capabilitiesFile: cardFile,
    });
    assert.equal(preflight.status, 'needs_input', JSON.stringify(preflight));
    let sends = 0;
    const result = await runWorkExecution(
      { request: fixture.request, apply: true },
      {
        adapter: planAdapter(() => {
          sends += 1;
          return { ok: true, status: 'submitted', detail: null };
        }),
      },
    );
    assert.equal(sends, 1, JSON.stringify(result.nodes));
    assert.ok(
      result.nodes[0]!.blockers.some((blocker) =>
        blocker.includes('preflight'),
      ),
    );
    assert.equal(result.nodes[0]!.execution_status, 'blocked');
  } finally {
    fixture.cleanup();
  }
});

test('missing task-bound participant evidence blocks only the affected writer', async () => {
  const fixture = makeFixture('missing-participant');
  try {
    const binding = JSON.parse(readFileSync(fixture.bindingFile, 'utf8')) as {
      participants: { agent_id: string }[];
    };
    binding.participants = binding.participants.filter(
      (participant) => participant.agent_id !== 'worker-1',
    );
    writeJson(fixture.bindingFile, binding);
    let sends = 0;
    const result = await runWorkExecution(
      { request: fixture.request, apply: true },
      {
        adapter: planAdapter(() => {
          sends += 1;
          return { ok: true, status: 'submitted', detail: null };
        }),
      },
    );
    assert.equal(sends, 1);
    assert.equal(result.nodes[0]!.execution_status, 'blocked');
    assert.ok(
      result.nodes[0]!.blockers.includes('binding_participant_missing'),
    );
    assert.equal(result.nodes[1]!.execution_status, 'dispatched');
  } finally {
    fixture.cleanup();
  }
});

test('a plan from a stale coordinator epoch cannot dispatch', async () => {
  const fixture = makeFixture('stale-epoch', { count: 1 });
  try {
    const plan = JSON.parse(readFileSync(fixture.planFile, 'utf8')) as Record<
      string,
      unknown
    >;
    plan.owner_epoch = 2;
    writeJson(fixture.planFile, plan);
    let sends = 0;
    const result = await runWorkExecution(
      { request: fixture.request, apply: true },
      {
        adapter: planAdapter(() => {
          sends += 1;
          return { ok: true, status: 'submitted', detail: null };
        }),
      },
    );
    assert.equal(sends, 0);
    assert.equal(result.status, 'invalid');
    assert.ok(result.diagnostics.includes('work_plan_not_current'));
  } finally {
    fixture.cleanup();
  }
});

test('claim revocation during asynchronous participant observation blocks before intent', async () => {
  const fixture = makeFixture('late-revoke', { count: 1 });
  try {
    const current = readRecord(fixture.taskRoot);
    assert.ok(current);
    const claim = current.claims.find(
      (item) => item.subtask_id === 'writer-1' && item.released_at === null,
    );
    assert.ok(claim);
    let didRelease = false;
    let sends = 0;
    const adapter: WorkExecutionAdapter = {
      preflight: async () => {
        if (!didRelease) {
          didRelease = true;
          const outcome = releaseClaim(fixture.taskRoot, {
            claimId: claim.claim_id,
            holder: {
              agent_id: 'worker-1',
              session_id: 'worker-session-1',
              harness: 'pi',
            },
          });
          assert.equal(outcome.ok, true);
        }
        return { ok: true, status: 'planned', detail: null };
      },
      dispatch: async () => {
        sends += 1;
        return { ok: true, status: 'submitted', detail: null };
      },
    };
    const result = await runWorkExecution(
      { request: fixture.request, apply: true },
      { adapter },
    );
    assert.equal(sends, 0);
    assert.equal(result.nodes[0]!.execution_status, 'blocked');
    assert.ok(
      result.nodes[0]!.blockers.some((blocker) =>
        blocker.startsWith('resource_claim_missing:'),
      ),
    );
    const after = readRecord(fixture.taskRoot);
    assert.ok(after);
    assert.equal(
      after.messages.some(
        (item) => item.message_id === result.nodes[0]!.intent_message_id,
      ),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('cancellation observed during participant preflight blocks before durable intent', async () => {
  const fixture = makeFixture('late-cancel', { count: 1 });
  try {
    let cancelled = false;
    let sends = 0;
    const adapter: WorkExecutionAdapter = {
      preflight: async () => {
        if (!cancelled) {
          cancelled = true;
          send(fixture, {
            message_id: 'msg-cancel-writer-1',
            type: 'CANCEL',
            task_id: TASK,
            from: COORDINATOR,
            to: {
              agent_id: 'worker-1',
              session_id: 'worker-session-1',
              harness: 'pi',
            },
            subtask_id: 'writer-1',
            attempt: 1,
            owner_epoch: 1,
            body: { reason: 'operator cancelled during preflight' },
          });
        }
        return { ok: true, status: 'planned', detail: null };
      },
      dispatch: async () => {
        sends += 1;
        return { ok: true, status: 'submitted', detail: null };
      },
    };
    const result = await runWorkExecution(
      { request: fixture.request, apply: true },
      { adapter },
    );
    assert.equal(sends, 0);
    assert.equal(result.nodes[0]!.execution_status, 'blocked');
    assert.ok(result.nodes[0]!.blockers.includes('uncertainty_open'));
    assert.match(result.nodes[0]!.next_action ?? '', /Reconcile/);
    const record = readRecord(fixture.taskRoot);
    assert.ok(record);
    assert.equal(
      record.messages.some(
        (item) =>
          item.type === 'STATUS_QUERY' &&
          item.message_id.startsWith('msg-work-intent-'),
      ),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('dependent work remains blocked for self-acceptance and unlocks only on coordinator acceptance', async () => {
  const rejectedFixture = makeFixture('self-acceptance', {
    count: 2,
    dependency: true,
  });
  try {
    const writer = {
      agent_id: 'worker-1',
      session_id: 'worker-session-1',
      harness: 'pi',
    };
    reportAndDecision(rejectedFixture, 'writer-1', writer, writer);
    let sends = 0;
    const rejected = await runWorkExecution(
      { request: rejectedFixture.request, apply: true },
      {
        adapter: planAdapter(() => {
          sends += 1;
          return { ok: true, status: 'submitted', detail: null };
        }),
      },
    );
    assert.equal(sends, 0);
    assert.equal(
      rejected.nodes.find((node) => node.node_id === 'writer-2')
        ?.execution_status,
      'blocked',
    );
    assert.ok(
      rejected.nodes
        .find((node) => node.node_id === 'writer-2')
        ?.blockers.includes('acceptance_missing'),
    );
  } finally {
    rejectedFixture.cleanup();
  }

  const acceptedFixture = makeFixture('accepted-dependency', {
    count: 2,
    dependency: true,
  });
  try {
    const acceptedReport = reportAndDecision(
      acceptedFixture,
      'writer-1',
      { agent_id: 'worker-1', session_id: 'worker-session-1', harness: 'pi' },
      COORDINATOR,
    );
    let dispatched: string[] = [];
    const accepted = await runWorkExecution(
      { request: acceptedFixture.request, apply: true },
      {
        adapter: planAdapter((messageId) => {
          dispatched = [...dispatched, messageId];
          return { ok: true, status: 'submitted', detail: null };
        }),
      },
    );
    assert.deepEqual(accepted.acceptance.accepted_nodes, ['writer-1']);
    assert.equal(
      accepted.nodes.find((node) => node.node_id === 'writer-2')
        ?.execution_status,
      'dispatched',
    );
    assert.ok(
      accepted.nodes.find((node) => node.node_id === 'writer-2')
        ?.next_action === null,
    );
    assert.ok(
      accepted.reports.some(
        (pointer) =>
          pointer.message_id === acceptedReport.message_id &&
          pointer.digest === acceptedReport.content_digest,
      ),
    );
    assert.deepEqual(dispatched, [
      acceptedFixture.assignmentMessages['writer-2']!.message_id,
    ]);
  } finally {
    acceptedFixture.cleanup();
  }
});
