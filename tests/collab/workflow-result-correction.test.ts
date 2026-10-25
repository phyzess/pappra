import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../../src/cli/run.js';
import {
  applyAccept,
  applyDispatch,
  applyParticipant,
  applyPrepare,
  planDispatch,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import { workflowIntentsDir } from '../../src/schemas/collab-workflow.js';
import { readRecord } from '../../src/collab/store.js';
import { readRegisteredMessage } from '../../src/collab/envelope.js';
import { workflowAssignmentPath } from '../../src/schemas/collab-workflow.js';

function readRegisteredAssignment(taskRoot: string, subtask: string): string {
  return readFileSync(workflowAssignmentPath(taskRoot, subtask), 'utf8');
}
import { makeCapabilitiesFixture } from './capabilities-fixtures.js';
import { deriveCapabilityCard } from '../../src/app/capability-evidence/index.js';
import type { WorkExecutionAdapter } from '../../src/app/collab-work-execution.js';
import { notifyRegisteredMessage } from '../../src/app/collab-notify.js';
import { evaluateWorkPlan } from '../../src/collab/work-plan.js';
import { workflowWorkPlanPath } from '../../src/schemas/collab-workflow.js';
import { cleanup } from '../workspace/fixtures.js';
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

async function cli(args: string[]): Promise<{
  status: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}> {
  let stdout = '';
  let stderr = '';
  const status = await runCli(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  let json: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(stdout);
    json =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : null;
  } catch {
    json = null;
  }
  return { status, stdout, stderr, json };
}

interface Identity {
  readonly agent_id: string;
  readonly session_id: string;
  readonly harness: string;
  readonly surface: string;
  readonly configuration_id: string;
  readonly cwd: string;
}

function prepareRequest(
  domainRoot: string,
  cwd: string,
  reviewerAccess: 'read' | 'write' = 'read',
  writer: Identity = { ...WRITER, cwd },
): WorkflowPrepareRequest {
  const declaration = (
    subtask_id: string,
    role: 'writer' | 'reviewer',
    assignee: string,
    resources: { path: string; access: 'read' | 'write' }[],
  ) => ({
    subtask_id,
    role,
    assignee,
    objective: `Objective for ${subtask_id}.`,
    acceptance: [`Acceptance for ${subtask_id}.`],
    resources,
    required_skills: [],
    required_tools: [],
    native_evidence: [],
  });
  return {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: domainRoot,
    task_id: 'results',
    goal: {
      objective: 'Close result defects.',
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
      { ...writer, cwd: writer.cwd },
      { ...REVIEWER, cwd },
    ],
    bindings: [],
    assignments: [
      declaration('writer', 'writer', writer.agent_id, [
        { path: join(writer.cwd, 'a'), access: 'write' },
      ]),
      declaration('review', 'reviewer', REVIEWER.agent_id, [
        { path: join(cwd, 'a'), access: reviewerAccess },
      ]),
    ],
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  };
}

const silentNotify = (async (options: { messageId: string }) => ({
  ok: true as const,
  value: {
    status: 'submitted' as const,
    messageId: options.messageId,
    detail: null,
    consumed: false as const,
    taskAccepted: false as const,
  },
})) as unknown as (
  options: Parameters<typeof notifyRegisteredMessage>[0],
) => ReturnType<typeof notifyRegisteredMessage>;

function countingAdapter(): {
  adapter: WorkExecutionAdapter;
  notify: typeof silentNotify;
  calls: string[];
  blockedByAuthority: string[];
} {
  const calls: string[] = [];
  const blockedByAuthority: string[] = [];
  const adapter: WorkExecutionAdapter = {
    preflight: async () => ({ ok: true, status: 'planned', detail: null }),
    dispatch: async (request) => {
      const authority = await request.finalAuthorityCheck?.();
      if (authority !== undefined && !authority.ok) {
        blockedByAuthority.push(authority.reason);
        return { ok: false, status: 'blocked', detail: authority.reason };
      }
      calls.push(request.messageId);
      return { ok: true, status: 'submitted', detail: null };
    },
  };
  return {
    adapter,
    notify: silentNotify,
    calls,
    blockedByAuthority,
  };
}

/** Adapter used where the call is expected not to deliver at all. */
const silentAdapter: WorkExecutionAdapter = {
  preflight: async () => ({ ok: true, status: 'planned', detail: null }),
  dispatch: async (request) => {
    const authority = await request.finalAuthorityCheck?.();
    return authority !== undefined && !authority.ok
      ? { ok: false, status: 'blocked', detail: authority.reason }
      : { ok: true, status: 'submitted', detail: null };
  },
};

test('prepare apply, inspect and a refusal agree on status, ok and exit code', async () => {
  const fixture = makeTaskDomain('results-cli', ['results'], {
    initialize: [],
  });
  try {
    const requestFile = join(fixture.root, 'prepare.json');
    writeFileSync(
      requestFile,
      `${JSON.stringify(prepareRequest(fixture.domainRoot, fixture.root), null, 2)}\n`,
    );

    const plan = await cli([
      'collab',
      'workflow',
      'prepare',
      '--request',
      requestFile,
      '--json',
    ]);
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(plan.json?.['status'], 'planned');

    const applied = await cli([
      'collab',
      'workflow',
      'prepare',
      '--request',
      requestFile,
      '--apply',
      '--json',
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.json?.['status'], 'applied');
    assert.equal(
      applied.json?.['ok'],
      true,
      'an applied prepare reports success',
    );

    const taskRoot = fixture.tasks['results']!;
    const inspected = await cli([
      'collab',
      'workflow',
      'inspect',
      '--task-root',
      taskRoot,
      '--json',
    ]);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(inspected.json?.['ok'], true);
    assert.equal(inspected.json?.['status'], 'applied');

    // A task root with no sealed cohort is refused, not reported as applied.
    const bare = makeTaskDomain('results-bare', ['bare']);
    try {
      const empty = await cli([
        'collab',
        'workflow',
        'inspect',
        '--task-root',
        bare.tasks['bare']!,
        '--json',
      ]);
      assert.equal(empty.status, 1, empty.stderr);
      assert.equal(empty.json?.['ok'], false);
      assert.equal(empty.json?.['status'], 'blocked');
      assert.match(
        JSON.stringify(empty.json?.['warnings'] ?? []),
        /No sealed workflow manifest/,
      );
    } finally {
      bare.cleanup();
    }
  } finally {
    fixture.cleanup();
  }
});

test('writer-only dispatch plan never registers or claims an out-of-scope reviewer', async () => {
  const fixture = makeTaskDomain('results-scope', ['results']);
  try {
    const taskRoot = fixture.tasks['results']!;
    const applied = await applyPrepare(
      prepareRequest(fixture.domainRoot, fixture.root),
    );
    assert.equal(applied.ok, true, JSON.stringify(applied.blockers));

    const dispatchRequest = {
      schema: 'pappra/collab-workflow-dispatch-request/1' as const,
      task_root: taskRoot,
      caller: { ...COORDINATOR, cwd: fixture.root },
      caller_pane: 'w3:p3B',
      capability_targets: [],
      subtasks: ['writer'],
      activate_deferred: false,
      max_age_minutes: 30,
    };
    const planned = planDispatch(dispatchRequest);
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    const codes = planned.value.blockers.map((item) => item.code);
    // No capability target: the writer's card blocker is expected, the reviewer's
    // deferred state is not a failure of this request.
    assert.equal(
      codes.includes('reviewer_deferred'),
      false,
      JSON.stringify(codes),
    );

    const record = readRecord(taskRoot);
    assert(record !== null);
    assert.equal(
      record.attempts.some((item) => item.subtask_id === 'review'),
      false,
      'an out-of-scope reviewer is never registered by a writer dispatch',
    );
    assert.equal(
      record.claims.some((claim) => claim.subtask_id === 'review'),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('a Pi assignee derives a live card and a Codex assignee uses its own deriver', async () => {
  const pi = makeCapabilitiesFixture('results-pi', { harness: 'pi' });
  const piDomain = makeTaskDomain('results-pi-cohort', ['results']);
  try {
    const template = pi.template as Record<string, unknown>;
    const writer = {
      agent_id: String(template['agent_id']),
      session_id: String(template['session_id']),
      harness: 'pi',
      surface: String(template['surface']),
      configuration_id: String(template['configuration_id']),
      cwd: String(template['cwd']),
    };
    const taskRoot = piDomain.tasks['results']!;
    const applied = await applyPrepare(
      prepareRequest(piDomain.domainRoot, piDomain.root, 'read', writer),
    );
    assert.equal(applied.ok, true, JSON.stringify(applied.blockers));
    const planned = planDispatch({
      schema: 'pappra/collab-workflow-dispatch-request/1',
      task_root: taskRoot,
      caller: { ...COORDINATOR, cwd: piDomain.root },
      caller_pane: 'w3:p3B',
      capability_targets: [
        {
          subtask_id: 'writer',
          attempt: 1,
          capabilities_file: null,
          template_file: pi.templateFile,
          session_file: pi.sessionFile,
          events_file: null,
          execution_file: null,
        },
      ],
      subtasks: ['writer'],
      activate_deferred: false,
      max_age_minutes: 30,
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    const codes = planned.value.blockers.map((item) => item.code);
    assert.equal(
      codes.includes('capability_derivation_unavailable'),
      false,
      `a documented Pi live source must derive, got ${JSON.stringify(planned.value.blockers)}`,
    );
    assert.equal(codes.includes('capability_card_harness_mismatch'), false);
    assert.equal(
      planned.value.nodes.find((node) => node.subtask_id === 'writer')
        ?.card_state,
      'derived',
    );
  } finally {
    cleanup(pi.root);
    piDomain.cleanup();
  }

  const codex = makeCapabilitiesFixture('results-codex', { harness: 'codex' });
  const codexDomain = makeTaskDomain('results-codex-cohort', ['results']);
  try {
    const template = codex.template as Record<string, unknown>;
    const writer = {
      agent_id: String(template['agent_id']),
      session_id: String(template['session_id']),
      harness: 'codex',
      surface: String(template['surface']),
      configuration_id: String(template['configuration_id']),
      cwd: String(template['cwd']),
    };
    const taskRoot = codexDomain.tasks['results']!;
    const applied = await applyPrepare(
      prepareRequest(codexDomain.domainRoot, codexDomain.root, 'read', writer),
    );
    assert.equal(applied.ok, true, JSON.stringify(applied.blockers));
    const planned = planDispatch({
      schema: 'pappra/collab-workflow-dispatch-request/1',
      task_root: taskRoot,
      caller: { ...COORDINATOR, cwd: codexDomain.root },
      caller_pane: 'w3:p3B',
      capability_targets: [
        {
          subtask_id: 'writer',
          attempt: 1,
          capabilities_file: null,
          template_file: codex.templateFile,
          session_file: null,
          events_file: codex.eventsFile,
          execution_file: codex.executionFile,
        },
      ],
      subtasks: ['writer'],
      activate_deferred: false,
      max_age_minutes: 30,
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    const codes = planned.value.blockers.map((item) => item.code);
    assert.equal(
      codes.includes('capability_derivation_unavailable'),
      false,
      `a Codex events+execution source must derive, got ${JSON.stringify(planned.value.blockers)}`,
    );
    assert.equal(codes.includes('capability_card_harness_mismatch'), false);
    assert.equal(
      planned.value.nodes.find((node) => node.subtask_id === 'writer')
        ?.card_state,
      'derived',
    );
  } finally {
    cleanup(codex.root);
    codexDomain.cleanup();
  }
});

test('target-less reviewer activation registers only, states it, and never replays', async () => {
  const fixture = makeTaskDomain('results-activate', ['results']);
  try {
    const taskRoot = fixture.tasks['results']!;
    const prepared = await applyPrepare(
      prepareRequest(fixture.domainRoot, fixture.root),
    );
    assert.equal(prepared.ok, true, JSON.stringify(prepared.blockers));

    const activateBefore = await applyDispatch(
      {
        schema: 'pappra/collab-workflow-dispatch-request/1',
        task_root: taskRoot,
        caller: { ...COORDINATOR, cwd: fixture.root },
        caller_pane: 'w3:p3B',
        capability_targets: [],
        subtasks: ['review'],
        activate_deferred: true,
        max_age_minutes: 30,
      },
      { adapter: silentAdapter },
    );
    assert.equal(
      activateBefore.blockers.some(
        (item) => item.code === 'writers_not_accepted',
      ),
      true,
      'a reviewer never activates before its writers are accepted',
    );

    // Accept the writer through the public participant/accept path.
    const output = join(fixture.root, 'a');
    mkdirSync(join(fixture.root), { recursive: true });
    writeFileSync(output, 'writer output\n');
    const ack = await applyParticipant(
      {
        schema: 'pappra/collab-workflow-participant-request/1',
        action: 'ack',
        task_root: taskRoot,
        caller: { ...WRITER, cwd: fixture.root },
        subtask_id: 'writer',
        attempt: 1,
        caller_pane: null,
        report: null,
        release: null,
      },
      { notify: silentNotify },
    );
    assert.equal(ack.status, 'applied', JSON.stringify(ack.blockers));
    const report = await applyParticipant(
      {
        schema: 'pappra/collab-workflow-participant-request/1',
        action: 'report',
        task_root: taskRoot,
        caller: { ...WRITER, cwd: fixture.root },
        subtask_id: 'writer',
        attempt: 1,
        caller_pane: null,
        report: {
          status: 'completed',
          summary: 'Wrote the output.',
          blockers: [],
          outputs: [output],
        },
        release: null,
      },
      { notify: silentNotify },
    );
    assert.equal(report.status, 'applied', JSON.stringify(report.blockers));
    const accepted = await applyAccept(
      {
        schema: 'pappra/collab-workflow-accept-request/1',
        task_root: taskRoot,
        caller: { ...COORDINATOR, cwd: fixture.root },
        subtask_id: 'writer',
        attempt: 1,
        report_message_id: report.messages[0]?.message_id ?? '',
        caller_pane: 'w3:p3B',
        reason: 'Writer accepted.',
      },
      { notify: silentNotify },
    );
    assert.equal(accepted.status, 'applied', JSON.stringify(accepted.blockers));
    const released = await applyParticipant(
      {
        schema: 'pappra/collab-workflow-participant-request/1',
        action: 'release',
        task_root: taskRoot,
        caller: { ...WRITER, cwd: fixture.root },
        subtask_id: 'writer',
        attempt: 1,
        caller_pane: null,
        report: null,
        release: {
          reason: 'Handing the scope back.',
          cancel_attempt: false,
          correlates_to: accepted.messages[0]?.message_id ?? '',
        },
      },
      { notify: silentNotify },
    );
    assert.equal(released.status, 'applied', JSON.stringify(released.blockers));

    // Activation without a capability target registers only, and says so.
    const activationOnly = await applyDispatch(
      {
        schema: 'pappra/collab-workflow-dispatch-request/1',
        task_root: taskRoot,
        caller: { ...COORDINATOR, cwd: fixture.root },
        caller_pane: 'w3:p3B',
        capability_targets: [],
        subtasks: ['review'],
        activate_deferred: true,
        max_age_minutes: 30,
      },
      { adapter: silentAdapter },
    );
    assert.equal(
      activationOnly.status,
      'applied',
      JSON.stringify(activationOnly.blockers),
    );
    assert.deepEqual(activationOnly.detail?.['notified'], []);
    assert.match(
      activationOnly.next_action ?? '',
      /attempt and claims were registered/,
    );
    assert.doesNotMatch(
      activationOnly.next_action ?? '',
      /Delivery is recorded/,
    );
    assert.deepEqual(activationOnly.detail?.['activation_only'], ['review']);

    // Activation-only writes no dispatch intent and sends nothing, but the ASSIGN and the
    // reviewer claims are real; a repeat never doubles the attempt.
    const intentsDir = workflowIntentsDir(taskRoot);
    assert.equal(
      existsSync(join(intentsDir, 'dispatch-review-1.json')),
      false,
      'activation-only writes no dispatch intent',
    );
    assert.notEqual(readRegisteredMessage(taskRoot, 'assign-review'), null);
    const after = readRecord(taskRoot);
    assert(after !== null);
    assert.equal(
      after.attempts.filter((item) => item.subtask_id === 'review').length,
      1,
      'a repeat activation never doubles the attempt',
    );
    assert.ok(
      after.claims.some((claim) => claim.subtask_id === 'review'),
      'the reviewer footprint is claimed',
    );
  } finally {
    fixture.cleanup();
  }
});

test('two disjoint file-scoped writers prepare in one Git checkout without Git reservations', async () => {
  const repo = makeTaskDomain('results-file-scope', ['results']);
  try {
    const taskRoot = repo.tasks['results']!;
    // A real Git checkout: workspace writes would otherwise derive index/HEAD claims.
    const git = join(repo.root, 'checkout');
    mkdirSync(git, { recursive: true });
    const run = (args: string[]) =>
      spawnSync('git', args, { cwd: git, encoding: 'utf8' });
    run(['init', '-q']);
    writeFileSync(join(git, 'a.txt'), 'a\n');
    writeFileSync(join(git, 'b.txt'), 'b\n');
    run(['add', '.']);
    run([
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'user.name=Fixture',
      'commit',
      '-qm',
      'init',
    ]);

    const writerB = {
      agent_id: 'writer-b',
      session_id: 'writer-b-session',
      harness: 'pi',
      surface: 'cli',
      configuration_id: 'daily-visible',
      cwd: repo.root,
    };
    const request = prepareRequest(repo.domainRoot, repo.root, 'read');
    request.participants.push({ ...writerB });
    request.assignments = [
      {
        ...request.assignments[0]!,
        resources: [
          { path: join(git, 'a.txt'), access: 'write', scope: 'file' },
        ],
      },
      {
        subtask_id: 'writer-two',
        role: 'writer',
        assignee: writerB.agent_id,
        objective: 'Second disjoint file.',
        acceptance: ['Second file written.'],
        resources: [
          { path: join(git, 'b.txt'), access: 'write', scope: 'file' },
        ],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ];

    const applied = await applyPrepare(request as WorkflowPrepareRequest);
    assert.equal(applied.ok, true, JSON.stringify(applied.blockers));

    for (const subtask of ['writer', 'writer-two'] as const) {
      const sealed = JSON.parse(
        readRegisteredAssignment(taskRoot, subtask),
      ) as { resources: { path: string; scope?: string }[] };
      const write = sealed.resources.find((item) => item.path.endsWith('.txt'));
      assert.equal(write?.scope, 'file', 'the explicit file scope is sealed');
    }
    const record = readRecord(taskRoot);
    assert(record !== null);
    const keys = record.claims.map((claim) => claim.key).join('\n');
    assert.doesNotMatch(
      keys,
      /git-(common-dir|index|head)/,
      'an explicit file scope never derives a Git reservation',
    );
    const scopes = record.claims
      .filter((claim) => claim.subtask_id === 'writer')
      .map((claim) => claim.scope);
    assert.deepEqual([...new Set(scopes)], ['file']);
    for (const subtask of ['writer', 'writer-two'] as const)
      assert.ok(
        record.claims.some(
          (claim) => claim.subtask_id === subtask && claim.scope === 'file',
        ),
        `${subtask} holds a real file-scoped claim`,
      );
  } finally {
    repo.cleanup();
  }
});

/** Writes a real, preflight-ready runtime card derived from the fixture's own source. */
function readyCard(
  fixture: ReturnType<typeof makeCapabilitiesFixture>,
): string {
  // Same contract the dispatcher uses: a Pi live session needs no execution record, while
  // Codex/Claude derive from their events plus the real execution file.
  const derived = deriveCapabilityCard(
    fixture.harness === 'pi'
      ? {
          harness: 'pi',
          assignmentFile: fixture.assignmentFile,
          templateFile: fixture.templateFile,
          sessionFile: fixture.sessionFile,
          live: true,
        }
      : {
          harness: fixture.harness,
          assignmentFile: fixture.assignmentFile,
          templateFile: fixture.templateFile,
          eventsFile: fixture.eventsFile,
          executionFile: fixture.executionFile,
        },
  );
  assert.equal(
    derived.ok,
    true,
    JSON.stringify(derived.errors ?? derived.blockers),
  );
  assert(derived.card !== undefined);
  const file = join(fixture.root, 'card.runtime.json');
  writeFileSync(file, `${JSON.stringify(derived.card, null, 2)}\n`);
  return file;
}

test('a real two-phase cohort dispatches, delivers, accepts and converges to one wake per phase', async () => {
  const writerFixture = makeCapabilitiesFixture('lifecycle-writer', {
    harness: 'pi',
  });
  const reviewerFixture = makeCapabilitiesFixture('lifecycle-reviewer', {
    harness: 'pi',
  });
  const domain = makeTaskDomain('lifecycle', ['results']);
  try {
    const writerTemplate = writerFixture.template as Record<string, unknown>;
    // Both capability fixtures ship the same `worker` identity, so a cohort would resolve
    // both assignments to one participant. Re-alias the reviewer fixture's template and
    // assignment (files this test owns) to a distinct agent before deriving its card.
    for (const file of [
      reviewerFixture.templateFile,
      reviewerFixture.assignmentFile,
    ]) {
      const document = JSON.parse(readFileSync(file, 'utf8')) as {
        agent_id?: string;
        assignee?: { agent_id?: string };
      };
      document.agent_id = 'review-agent';
      if (document.assignee !== undefined)
        document.assignee.agent_id = 'review-agent';
      writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
    }
    const reviewerTemplate = reviewerFixture.template as Record<
      string,
      unknown
    >;
    const writerIdentity = {
      agent_id: String(writerTemplate['agent_id']),
      session_id: String(writerTemplate['session_id']),
      harness: 'pi',
      surface: String(writerTemplate['surface']),
      configuration_id: String(writerTemplate['configuration_id']),
      cwd: String(writerTemplate['cwd']),
    };
    const reviewerIdentity = {
      agent_id: 'review-agent',
      session_id: String(reviewerTemplate['session_id']),
      harness: 'pi',
      surface: String(reviewerTemplate['surface']),
      configuration_id: String(reviewerTemplate['configuration_id']),
      cwd: String(reviewerTemplate['cwd']),
    };
    const writerCard = readyCard(writerFixture);
    const reviewerCard = readyCard(reviewerFixture);

    const taskRoot = domain.tasks['results']!;
    const request = prepareRequest(
      domain.domainRoot,
      domain.root,
      'read',
      writerIdentity,
    );
    request.participants = [
      request.participants[0]!,
      { ...writerIdentity },
      { ...reviewerIdentity },
    ];
    request.assignments = [
      {
        ...request.assignments[0]!,
        resources: [
          {
            path: join(writerIdentity.cwd, 'a.txt'),
            access: 'write',
            scope: 'file',
          },
        ],
      },
      {
        subtask_id: 'review',
        role: 'reviewer',
        assignee: reviewerIdentity.agent_id,
        objective: 'Review the writer output.',
        acceptance: ['Reviewed.'],
        resources: [
          {
            path: join(writerIdentity.cwd, 'a.txt'),
            access: 'read',
            scope: 'file',
          },
        ],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ];
    const prepared = await applyPrepare(request as WorkflowPrepareRequest);
    assert.equal(prepared.ok, true, JSON.stringify(prepared.blockers));

    const writerTarget = {
      subtask_id: 'writer',
      attempt: 1,
      capabilities_file: writerCard,
      template_file: null,
      session_file: null,
      events_file: null,
      execution_file: null,
    };
    const dispatchBase = {
      schema: 'pappra/collab-workflow-dispatch-request/1' as const,
      task_root: taskRoot,
      caller: { ...COORDINATOR, cwd: domain.root },
      caller_pane: 'w3:p3B',
      max_age_minutes: 30,
    };
    const spy = countingAdapter();
    const intentFile = (subtask: string) =>
      join(workflowIntentsDir(taskRoot), `dispatch-${subtask}-1.json`);

    // 1. A scoped writer plan is ready and has zero effects.
    const writerPlan = planDispatch({
      ...dispatchBase,
      capability_targets: [writerTarget],
      subtasks: ['writer'],
      activate_deferred: false,
    });
    assert.equal(writerPlan.ok, true);
    if (!writerPlan.ok) return;
    assert.deepEqual(
      writerPlan.value.blockers,
      [],
      JSON.stringify(writerPlan.value),
    );
    assert.equal(existsSync(intentFile('writer')), false);
    assert.equal(spy.calls.length, 0);
    assert.equal(
      (readRecord(taskRoot)?.attempts ?? []).some(
        (item) => item.subtask_id === 'review',
      ),
      false,
    );

    // 2. The real scoped writer dispatch delivers exactly once.
    const writerDispatch = await applyDispatch(
      {
        ...dispatchBase,
        capability_targets: [writerTarget],
        subtasks: ['writer'],
        activate_deferred: false,
      },
      { adapter: spy.adapter },
    );
    assert.equal(
      writerDispatch.status,
      'applied',
      JSON.stringify(writerDispatch.blockers),
    );
    assert.equal(writerDispatch.ok, true);
    assert.deepEqual(writerDispatch.detail?.['notified'], ['writer']);
    assert.deepEqual(
      spy.calls.filter((id) => id.startsWith('assign-')),
      ['assign-writer'],
    );
    assert.equal(
      writerDispatch.native.find((item) => item.subtask_id === 'writer')
        ?.observation,
      'unknown',
      'a submitted ASSIGN never claims native execution',
    );
    assert.equal(existsSync(intentFile('writer')), true);
    const afterWriter = readRecord(taskRoot);
    assert(afterWriter !== null);
    assert.equal(
      afterWriter.attempts.filter((item) => item.subtask_id === 'review')
        .length,
      0,
      'the unselected reviewer was never registered',
    );
    assert.equal(
      afterWriter.claims.filter((claim) => claim.subtask_id === 'review')
        .length,
      0,
    );

    // 3. The writer runs the public participant path to acceptance and release.
    const outputPath = join(writerIdentity.cwd, 'a.txt');
    mkdirSync(writerIdentity.cwd, { recursive: true });
    writeFileSync(outputPath, 'writer output\n');
    const writerAck = await applyParticipant(
      {
        schema: 'pappra/collab-workflow-participant-request/1',
        action: 'ack',
        task_root: taskRoot,
        caller: { ...writerIdentity },
        subtask_id: 'writer',
        attempt: 1,
        caller_pane: null,
        report: null,
        release: null,
      },
      { notify: spy.notify },
    );
    assert.equal(
      writerAck.status,
      'applied',
      JSON.stringify(writerAck.blockers),
    );
    const writerReport = await applyParticipant(
      {
        schema: 'pappra/collab-workflow-participant-request/1',
        action: 'report',
        task_root: taskRoot,
        caller: { ...writerIdentity },
        subtask_id: 'writer',
        attempt: 1,
        caller_pane: null,
        report: {
          status: 'completed',
          summary: 'Wrote the output.',
          blockers: [],
          outputs: [outputPath],
        },
        release: null,
      },
      { notify: spy.notify },
    );
    assert.equal(
      writerReport.status,
      'applied',
      JSON.stringify(writerReport.blockers),
    );
    const writerAccept = await applyAccept(
      {
        schema: 'pappra/collab-workflow-accept-request/1',
        task_root: taskRoot,
        caller: { ...COORDINATOR, cwd: domain.root },
        subtask_id: 'writer',
        attempt: 1,
        report_message_id: writerReport.messages[0]?.message_id ?? '',
        caller_pane: 'w3:p3B',
        reason: 'Writer accepted.',
      },
      { notify: spy.notify },
    );
    assert.equal(
      writerAccept.status,
      'applied',
      JSON.stringify(writerAccept.blockers),
    );
    const writerRelease = await applyParticipant(
      {
        schema: 'pappra/collab-workflow-participant-request/1',
        action: 'release',
        task_root: taskRoot,
        caller: { ...writerIdentity },
        subtask_id: 'writer',
        attempt: 1,
        caller_pane: null,
        report: null,
        release: {
          reason: 'Scope handed back.',
          cancel_attempt: false,
          correlates_to: writerAccept.messages[0]?.message_id ?? '',
        },
      },
      { notify: spy.notify },
    );
    assert.equal(
      writerRelease.status,
      'applied',
      JSON.stringify(writerRelease.blockers),
    );

    // 4. Activation with a valid target delivers exactly once in the same call.
    const reviewerDispatch = await applyDispatch(
      {
        ...dispatchBase,
        capability_targets: [
          {
            subtask_id: 'review',
            attempt: 1,
            capabilities_file: reviewerCard,
            template_file: null,
            session_file: null,
            events_file: null,
            execution_file: null,
          },
        ],
        subtasks: ['review'],
        activate_deferred: true,
      },
      { adapter: spy.adapter },
    );
    assert.equal(
      reviewerDispatch.status,
      'applied',
      JSON.stringify(reviewerDispatch.blockers),
    );
    assert.equal(reviewerDispatch.ok, true);
    assert.deepEqual(reviewerDispatch.detail?.['notified'], ['review']);
    assert.deepEqual(
      spy.calls.filter((id) => id.startsWith('assign-')),
      ['assign-writer', 'assign-review'],
    );

    // 5. The reviewer completes the same public path with no outputs.
    const reviewerAck = await applyParticipant(
      {
        schema: 'pappra/collab-workflow-participant-request/1',
        action: 'ack',
        task_root: taskRoot,
        caller: { ...reviewerIdentity },
        subtask_id: 'review',
        attempt: 1,
        caller_pane: null,
        report: null,
        release: null,
      },
      { notify: spy.notify },
    );
    assert.equal(
      reviewerAck.status,
      'applied',
      JSON.stringify(reviewerAck.blockers),
    );
    const reviewerReport = await applyParticipant(
      {
        schema: 'pappra/collab-workflow-participant-request/1',
        action: 'report',
        task_root: taskRoot,
        caller: { ...reviewerIdentity },
        subtask_id: 'review',
        attempt: 1,
        caller_pane: null,
        report: {
          status: 'completed',
          summary: 'Reviewed the output.',
          blockers: [],
          outputs: [],
        },
        release: null,
      },
      { notify: spy.notify },
    );
    assert.equal(
      reviewerReport.status,
      'applied',
      JSON.stringify(reviewerReport.blockers),
    );
    const reviewerAccept = await applyAccept(
      {
        schema: 'pappra/collab-workflow-accept-request/1',
        task_root: taskRoot,
        caller: { ...COORDINATOR, cwd: domain.root },
        subtask_id: 'review',
        attempt: 1,
        report_message_id: reviewerReport.messages[0]?.message_id ?? '',
        caller_pane: 'w3:p3B',
        reason: 'Review accepted.',
      },
      { notify: spy.notify },
    );
    assert.equal(
      reviewerAccept.status,
      'applied',
      JSON.stringify(reviewerAccept.blockers),
    );
    const reviewerRelease = await applyParticipant(
      {
        schema: 'pappra/collab-workflow-participant-request/1',
        action: 'release',
        task_root: taskRoot,
        caller: { ...reviewerIdentity },
        subtask_id: 'review',
        attempt: 1,
        caller_pane: null,
        report: null,
        release: {
          reason: 'Review handed back.',
          cancel_attempt: false,
          correlates_to: reviewerAccept.messages[0]?.message_id ?? '',
        },
      },
      { notify: spy.notify },
    );
    assert.equal(
      reviewerRelease.status,
      'applied',
      JSON.stringify(reviewerRelease.blockers),
    );

    // 6. The established evaluator accepts both nodes from the registered decisions.
    const record = readRecord(taskRoot);
    assert(record !== null);
    const decisions = [writerAccept, reviewerAccept].flatMap((result) =>
      result.messages
        .map((item) => readRegisteredMessage(taskRoot, item.message_id ?? ''))
        .filter((item) => item !== null),
    );
    const evaluation = evaluateWorkPlan({
      plan: JSON.parse(readFileSync(workflowWorkPlanPath(taskRoot), 'utf8')),
      record,
      messages: decisions,
    });
    assert.equal(evaluation.ok, true, JSON.stringify(evaluation));
    if (!evaluation.ok) return;
    assert.deepEqual(
      evaluation.nodes.map((node) => `${node.node_id}:${node.status}`).sort(),
      ['review:accepted', 'writer:accepted'],
    );

    // 7. A repeat dispatch never adds a second wake.
    const repeat = await applyDispatch(
      {
        ...dispatchBase,
        capability_targets: [
          {
            subtask_id: 'review',
            attempt: 1,
            capabilities_file: reviewerCard,
            template_file: null,
            session_file: null,
            events_file: null,
            execution_file: null,
          },
        ],
        subtasks: ['review'],
        activate_deferred: false,
      },
      { adapter: spy.adapter },
    );
    assert.deepEqual(
      spy.calls.filter((id) => id.startsWith('assign-')),
      ['assign-writer', 'assign-review'],
    );
    assert.deepEqual(repeat.detail?.['notified'], []);
    const repeatCodes = repeat.blockers.map((item) => item.code);
    // A completed, released reviewer is refused for a real reason and never re-notified.
    assert.ok(
      repeatCodes.length === 0 ||
        repeatCodes.some((code) =>
          [
            'dispatch_already_attempted',
            'attempt_not_dispatchable',
            'claim_coverage_missing',
            'reviewer_deferred',
          ].includes(code),
        ),
      JSON.stringify(repeatCodes),
    );
  } finally {
    cleanup(writerFixture.root);
    cleanup(reviewerFixture.root);
    domain.cleanup();
  }
});

test('the adapter authority callback refuses a claim revoked just before transport', async () => {
  const fixture = makeCapabilitiesFixture('race-authority', { harness: 'pi' });
  const domain = makeTaskDomain('race-authority', ['results']);
  try {
    const template = fixture.template as Record<string, unknown>;
    const writer = {
      agent_id: String(template['agent_id']),
      session_id: String(template['session_id']),
      harness: 'pi',
      surface: String(template['surface']),
      configuration_id: String(template['configuration_id']),
      cwd: String(template['cwd']),
    };
    const card = readyCard(fixture);
    const taskRoot = domain.tasks['results']!;
    const prepared = await applyPrepare(
      prepareRequest(domain.domainRoot, domain.root, 'read', writer),
    );
    assert.equal(prepared.ok, true, JSON.stringify(prepared.blockers));

    const submitted: string[] = [];
    const reasons: string[] = [];
    const racingAdapter: WorkExecutionAdapter = {
      preflight: async () => ({ ok: true, status: 'planned', detail: null }),
      dispatch: async (request) => {
        // The reviewer releases the writer's claims after planning and just before the
        // guarded transport would prompt. The callback must see that on a fresh record.
        const record = JSON.parse(
          readFileSync(join(taskRoot, 'task.json'), 'utf8'),
        ) as { claims: { subtask_id: string }[] };
        record.claims = record.claims.filter(
          (claim) => claim.subtask_id !== 'writer',
        );
        writeFileSync(
          join(taskRoot, 'task.json'),
          `${JSON.stringify(record, null, 2)}\n`,
        );
        const authority = await request.finalAuthorityCheck?.();
        if (authority !== undefined && !authority.ok) {
          reasons.push(authority.reason);
          return { ok: false, status: 'blocked', detail: authority.reason };
        }
        submitted.push(request.messageId);
        return { ok: true, status: 'submitted', detail: null };
      },
    };

    const result = await applyDispatch(
      {
        schema: 'pappra/collab-workflow-dispatch-request/1',
        task_root: taskRoot,
        caller: { ...COORDINATOR, cwd: domain.root },
        caller_pane: 'w3:p3B',
        capability_targets: [
          {
            subtask_id: 'writer',
            attempt: 1,
            capabilities_file: card,
            template_file: null,
            session_file: null,
            events_file: null,
            execution_file: null,
          },
        ],
        subtasks: ['writer'],
        activate_deferred: false,
        max_age_minutes: 30,
      },
      { adapter: racingAdapter },
    );
    assert.deepEqual(submitted, [], 'revoked coverage never reaches transport');
    assert.ok(
      reasons.includes('claim_coverage_missing'),
      JSON.stringify(reasons),
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.blockers.some((item) => item.code.startsWith('delivery_blocked')),
      JSON.stringify(result.blockers.map((item) => item.code)),
    );
    assert.deepEqual(result.detail?.['notified'], []);
  } finally {
    cleanup(fixture.root);
    domain.cleanup();
  }
});

test('a terminalized attempt with claims still held never reaches transport', async () => {
  const fixture = makeCapabilitiesFixture('race-terminal', { harness: 'pi' });
  const domain = makeTaskDomain('race-terminal', ['results']);
  try {
    const template = fixture.template as Record<string, unknown>;
    const writer = {
      agent_id: String(template['agent_id']),
      session_id: String(template['session_id']),
      harness: 'pi',
      surface: String(template['surface']),
      configuration_id: String(template['configuration_id']),
      cwd: String(template['cwd']),
    };
    const card = readyCard(fixture);
    const taskRoot = domain.tasks['results']!;
    const prepared = await applyPrepare(
      prepareRequest(domain.domainRoot, domain.root, 'read', writer),
    );
    assert.equal(prepared.ok, true, JSON.stringify(prepared.blockers));

    const submitted: string[] = [];
    const reasons: string[] = [];
    const racingAdapter: WorkExecutionAdapter = {
      preflight: async () => ({ ok: true, status: 'planned', detail: null }),
      dispatch: async (request) => {
        // The attempt is terminalized after planning while its claim still looks live:
        // coverage alone would pass, so the callback must reuse the scoped admission.
        const record = JSON.parse(
          readFileSync(join(taskRoot, 'task.json'), 'utf8'),
        ) as { attempts: { subtask_id: string; state: string }[] };
        for (const attempt of record.attempts)
          if (attempt.subtask_id === 'writer') attempt.state = 'completed';
        writeFileSync(
          join(taskRoot, 'task.json'),
          `${JSON.stringify(record, null, 2)}\n`,
        );
        const authority = await request.finalAuthorityCheck?.();
        if (authority !== undefined && !authority.ok) {
          reasons.push(authority.reason);
          return { ok: false, status: 'blocked', detail: authority.reason };
        }
        submitted.push(request.messageId);
        return { ok: true, status: 'submitted', detail: null };
      },
    };

    const result = await applyDispatch(
      {
        schema: 'pappra/collab-workflow-dispatch-request/1',
        task_root: taskRoot,
        caller: { ...COORDINATOR, cwd: domain.root },
        caller_pane: 'w3:p3B',
        capability_targets: [
          {
            subtask_id: 'writer',
            attempt: 1,
            capabilities_file: card,
            template_file: null,
            session_file: null,
            events_file: null,
            execution_file: null,
          },
        ],
        subtasks: ['writer'],
        activate_deferred: false,
        max_age_minutes: 30,
      },
      { adapter: racingAdapter },
    );
    assert.deepEqual(submitted, [], 'a terminal attempt is never re-notified');
    assert.ok(
      reasons.includes('attempt_not_dispatchable'),
      JSON.stringify(reasons),
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.detail?.['notified'], []);
  } finally {
    cleanup(fixture.root);
    domain.cleanup();
  }
});
