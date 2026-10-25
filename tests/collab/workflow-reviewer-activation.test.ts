import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyAccept,
  applyDispatch,
  applyParticipant,
  applyPrepare,
} from '../../src/app/collab-workflow.js';
import { deriveCapabilityCard } from '../../src/app/capability-evidence/index.js';
import type { WorkExecutionAdapter } from '../../src/app/collab-work-execution.js';
import type { notifyRegisteredMessage } from '../../src/app/collab-notify.js';
import { claimResources, releaseClaim } from '../../src/collab/resources.js';
import { readRecord, transact } from '../../src/collab/store.js';
import {
  workflowAssignmentPath,
  workflowIntentsDir,
  workflowManifestPath,
  type WorkflowDispatchRequest,
  type WorkflowParticipantRequest,
  type WorkflowPrepareRequest,
} from '../../src/schemas/collab-workflow.js';
import { makeCapabilitiesFixture } from './capabilities-fixtures.js';
import {
  makeTaskDomain,
  OTHER,
  snapshotTree,
} from './task-resources-fixtures.js';
import { owner } from './scenarios.js';
import { cleanup } from '../workspace/fixtures.js';

const writer = {
  agent_id: 'author',
  session_id: 'author-session',
  harness: 'pi',
  surface: 'cli',
  configuration_id: 'fixture',
};
const noNativeNotify = (async () => ({
  ok: false,
  code: 'fixture_no_native',
  message: 'Explicit fixture; no native notification',
  retryable: false,
  nextAction: null,
})) as typeof notifyRegisteredMessage;

async function fixture(acceptWriter = true) {
  const domain = makeTaskDomain(
    'review-activation-retry',
    ['cohort', 'holder'],
    { initialize: ['holder'] },
  );
  const capability = makeCapabilitiesFixture('review-activation-card', {
    harness: 'pi',
  });
  const template = capability.template as Record<string, unknown>;
  const reviewer = {
    agent_id: String(template.agent_id),
    session_id: String(template.session_id),
    harness: 'pi',
    surface: String(template.surface),
    configuration_id: String(template.configuration_id),
    cwd: String(template.cwd),
  };
  const taskRoot = domain.tasks.cohort!;
  const first = join(domain.root, 'a.txt');
  const second = join(domain.root, 'b.txt');
  writeFileSync(first, 'author output\n');
  writeFileSync(second, 'second review input\n');
  const declaration = (
    subtask_id: string,
    role: 'writer' | 'reviewer',
    assignee: string,
    resources: WorkflowPrepareRequest['assignments'][number]['resources'],
  ) => ({
    subtask_id,
    role,
    assignee,
    resources,
    objective: subtask_id,
    acceptance: ['Fixture completion'],
    required_skills: [],
    required_tools: [],
    native_evidence: [],
  });
  const prepare: WorkflowPrepareRequest = {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: domain.domainRoot,
    task_id: 'cohort',
    goal: {
      objective: 'Explicit no-model reviewer retry fixture',
      input_ref: null,
      input_digest: null,
    },
    coordinator: {
      ...owner,
      cwd: domain.root,
      surface: 'cli',
      configuration_id: 'fixture',
    },
    participants: [{ ...writer, cwd: domain.root }, reviewer],
    bindings: [],
    runner: { name: 'fixture', mode: 'fixture' },
    assignments: [
      declaration('author', 'writer', writer.agent_id, [
        { path: first, access: 'write', scope: 'file' },
      ]),
      declaration('review', 'reviewer', reviewer.agent_id, [
        { path: first, access: 'read', scope: 'file' },
        { path: second, access: 'read', scope: 'file' },
      ]),
    ],
  };
  const prepared = await applyPrepare(prepare);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const derived = deriveCapabilityCard({
    harness: 'pi',
    assignmentFile: capability.assignmentFile,
    templateFile: capability.templateFile,
    sessionFile: capability.sessionFile,
    live: true,
  });
  assert.equal(derived.ok, true, JSON.stringify(derived));
  assert(derived.card);
  const cardFile = join(capability.root, 'runtime-card.json');
  writeFileSync(cardFile, JSON.stringify(derived.card));
  const participant: WorkflowParticipantRequest = {
    schema: 'pappra/collab-workflow-participant-request/1',
    action: 'ack',
    task_root: taskRoot,
    caller: { ...writer, cwd: domain.root },
    subtask_id: 'author',
    attempt: 1,
    caller_pane: null,
    report: null,
    release: null,
  };
  let acceptanceId: string | null = null;
  async function finishWriter(release = true) {
    const ack = await applyParticipant(participant, { notify: noNativeNotify });
    assert.equal(ack.ok, true, JSON.stringify(ack));
    const report = await applyParticipant(
      {
        ...participant,
        action: 'report',
        report: {
          status: 'completed',
          summary: 'Fixture author finished',
          blockers: [],
          outputs: [first],
        },
      },
      { notify: noNativeNotify },
    );
    assert.equal(report.ok, true, JSON.stringify(report));
    const accepted = await applyAccept(
      {
        schema: 'pappra/collab-workflow-accept-request/1',
        task_root: taskRoot,
        caller: { ...owner, cwd: domain.root },
        subtask_id: 'author',
        attempt: 1,
        report_message_id: report.messages[0]!.message_id,
        caller_pane: null,
        reason: 'Accept fixture author',
      },
      { notify: noNativeNotify },
    );
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    acceptanceId = accepted.messages[0]!.message_id;
    if (release) await releaseWriter();
  }
  async function releaseWriter() {
    assert(acceptanceId);
    const released = await applyParticipant(
      {
        ...participant,
        action: 'release',
        release: {
          reason: 'Accepted author hands back scope',
          cancel_attempt: false,
          correlates_to: acceptanceId,
        },
      },
      { notify: noNativeNotify },
    );
    assert.equal(released.ok, true, JSON.stringify(released));
  }
  if (acceptWriter) await finishWriter();
  const held = claimResources(domain.tasks.holder!, {
    resources: [{ path: second, scope: 'file' }],
    holder: OTHER,
    access: 'write',
    includeSharedGit: false,
  });
  assert.equal(held.ok, true, JSON.stringify(held));
  const request: WorkflowDispatchRequest = {
    schema: 'pappra/collab-workflow-dispatch-request/1',
    task_root: taskRoot,
    caller: { ...owner, cwd: domain.root },
    caller_pane: 'w9:p1',
    capability_targets: [
      {
        subtask_id: 'review',
        attempt: 1,
        capabilities_file: cardFile,
        template_file: null,
        session_file: null,
        events_file: null,
        execution_file: null,
      },
    ],
    subtasks: ['review'],
    activate_deferred: true,
    max_age_minutes: 30,
  };
  const calls: string[] = [];
  let outcome: 'submitted' | 'unknown' = 'submitted';
  const adapter: WorkExecutionAdapter = {
    preflight: async () => ({
      ok: true,
      status: 'planned',
      detail: 'Explicit no-model adapter',
    }),
    dispatch: async (request) => {
      const authority = await request.finalAuthorityCheck?.();
      if (!authority?.ok)
        return {
          ok: false,
          status: 'blocked',
          detail: authority?.reason ?? 'authority missing',
        };
      calls.push(request.messageId);
      return outcome === 'submitted'
        ? {
            ok: true,
            status: 'submitted',
            detail: 'Fixture only; no native transport',
          }
        : {
            ok: false,
            status: 'unknown',
            detail: 'Fixture ambiguous delivery',
          };
    },
  };
  return {
    domain,
    capability,
    taskRoot,
    first,
    second,
    reviewer,
    request,
    adapter,
    calls,
    cardFile,
    prepare,
    finishWriter,
    releaseWriter,
    setOutcome(value: 'submitted' | 'unknown') {
      outcome = value;
    },
    releaseHolder() {
      for (const claim of readRecord(domain.tasks.holder!)!.claims.filter(
        (c) => c.released_at === null,
      ))
        assert.equal(
          releaseClaim(domain.tasks.holder!, {
            claimId: claim.claim_id,
            holder: OTHER,
            reason: 'Fixture foreign writer stopped',
          }).ok,
          true,
        );
    },
    cleanup() {
      domain.cleanup();
      cleanup(capability.root);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function reviewerClaims(f: Fixture) {
  return readRecord(f.taskRoot)!.claims.filter(
    (c) =>
      c.subtask_id === 'review' &&
      c.released_at === null &&
      c.holder?.agent_id === f.reviewer.agent_id &&
      c.holder.session_id === f.reviewer.session_id,
  );
}
function pins(f: Fixture) {
  return [
    workflowManifestPath(f.taskRoot),
    workflowAssignmentPath(f.taskRoot, 'review'),
    join(f.taskRoot, 'messages/assign-review.json'),
  ].map((file) => readFileSync(file));
}
function mutateReview(
  f: Fixture,
  mutate: (
    attempt: NonNullable<ReturnType<typeof readRecord>>['attempts'][number],
  ) => void,
) {
  const result = transact(f.taskRoot, {
    actor: 'fixture',
    purpose: 'fixture-negative-state',
    apply: (record) => {
      mutate(record.attempts.find((a) => a.subtask_id === 'review')!);
      return { record };
    },
  });
  assert.equal(result.ok, true);
}
async function firstConflict(f: Fixture) {
  const result = await applyDispatch(f.request, { adapter: f.adapter });
  assert.equal(result.ok, false);
  assert(result.blockers.some((b) => b.detail.includes('footprint')));
  assert(
    readRecord(f.taskRoot)!.attempts.some(
      (a) => a.subtask_id === 'review' && a.state === 'assigned',
    ),
  );
  assert.equal(
    existsSync(join(workflowIntentsDir(f.taskRoot), 'dispatch-review-1.json')),
    false,
  );
  assert.equal(f.calls.length, 0);
  return result;
}

test('known-no-delivery reviewer read conflict retries the original request once after the writer releases', async () => {
  const f = await fixture();
  try {
    await firstConflict(f);
    const sealed = pins(f);
    const stillConflicted = await applyDispatch(f.request, {
      adapter: f.adapter,
    });
    assert.equal(stillConflicted.ok, false);
    assert.equal(f.calls.length, 0);
    assert.equal(reviewerClaims(f).length, 0);
    f.releaseHolder();
    const beforePlan = snapshotTree(f.domain.root);
    const plan = await applyDispatch(f.request, {
      adapter: f.adapter,
      apply: false,
    });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.deepEqual(snapshotTree(f.domain.root), beforePlan);
    const retry = await applyDispatch(f.request, { adapter: f.adapter });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.deepEqual(f.calls, ['assign-review']);
    assert.deepEqual(
      reviewerClaims(f).map((c) => [c.path, c.scope, c.access, c.attempt]),
      [
        [f.first, 'file', 'read', 1],
        [f.second, 'file', 'read', 1],
      ],
    );
    assert.deepEqual(pins(f), sealed);
    const claims = readFileSync(join(f.taskRoot, 'task.json'));
    const again = await applyDispatch(f.request, { adapter: f.adapter });
    assert.equal(again.ok, false);
    assert(
      again.blockers.some(
        (b) =>
          b.code === 'dispatch_already_attempted' ||
          b.code === 'dispatch_intent_conflict',
      ),
    );
    assert.equal(f.calls.length, 1);
    assert.deepEqual(readFileSync(join(f.taskRoot, 'task.json')), claims);
  } finally {
    f.cleanup();
  }
});

test('retry keeps intact exact-scope coverage and does not adopt another holder\u0027s read claim', async () => {
  const f = await fixture();
  try {
    await firstConflict(f);
    const own = claimResources(f.taskRoot, {
      resources: [{ path: f.first, scope: 'file' }],
      holder: f.reviewer,
      access: 'read',
      subtaskId: 'review',
      attempt: 1,
      requireAssignedHolder: true,
    });
    assert.equal(own.ok, true, JSON.stringify(own));
    const firstId = reviewerClaims(f)[0]!.claim_id;
    f.releaseHolder();
    const foreign = claimResources(f.domain.tasks.holder!, {
      resources: [{ path: f.second, scope: 'file' }],
      holder: OTHER,
      access: 'read',
    });
    assert.equal(foreign.ok, true, JSON.stringify(foreign));
    const retry = await applyDispatch(f.request, { adapter: f.adapter });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(reviewerClaims(f).length, 2);
    assert.equal(
      reviewerClaims(f).find((c) => c.path === f.first)?.claim_id,
      firstId,
    );
    assert.equal(
      readRecord(f.domain.tasks.holder!)!.claims.filter(
        (c) => c.released_at === null,
      ).length,
      1,
    );
  } finally {
    f.cleanup();
  }
});

test('claim acquisition retry remains explicitly activated and scoped', async () => {
  const f = await fixture();
  try {
    await firstConflict(f);
    f.releaseHolder();
    const passive = await applyDispatch(
      { ...f.request, activate_deferred: false },
      { adapter: f.adapter },
    );
    assert.equal(passive.ok, false);
    assert(passive.blockers.some((b) => b.code === 'claim_coverage_missing'));
    const outOfScope = await applyDispatch(
      { ...f.request, subtasks: ['not-the-reviewer'] },
      { adapter: f.adapter },
    );
    assert.equal(outOfScope.ok, true, JSON.stringify(outOfScope));
    assert.equal(reviewerClaims(f).length, 0);
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

for (const state of [
  'accepted',
  'running',
  'completed',
  'cancelled',
  'unknown',
]) {
  test(`retry never reopens an already ${state} reviewer`, async () => {
    const f = await fixture();
    try {
      await firstConflict(f);
      f.releaseHolder();
      mutateReview(f, (attempt) => {
        attempt.state = state;
      });
      const before = readFileSync(join(f.taskRoot, 'task.json'));
      const result = await applyDispatch(f.request, { adapter: f.adapter });
      assert.equal(result.ok, false);
      assert.equal(reviewerClaims(f).length, 0);
      assert.equal(f.calls.length, 0);
      assert.deepEqual(readFileSync(join(f.taskRoot, 'task.json')), before);
    } finally {
      f.cleanup();
    }
  });
}

for (const evidence of ['intent', 'notification'] as const) {
  for (const status of ['unknown', 'submitted'] as const) {
    test(`${status} ${evidence} evidence prevents activation retry and is never replayed`, async () => {
      const f = await fixture();
      try {
        await firstConflict(f);
        f.releaseHolder();
        const file =
          evidence === 'intent'
            ? join(workflowIntentsDir(f.taskRoot), 'dispatch-review-1.json')
            : join(f.taskRoot, 'notifications/assign-review.json');
        let priorCalls = 0;
        if (evidence === 'intent' && status === 'unknown') {
          f.setOutcome('unknown');
          const attempted = await applyDispatch(f.request, {
            adapter: f.adapter,
          });
          assert(
            attempted.blockers.some(
              (blocker) => blocker.code === 'delivery_unknown',
            ),
          );
          // Explicit no-model fixture: simulate lost coverage after ambiguous delivery.
          for (const claim of reviewerClaims(f))
            assert.equal(
              releaseClaim(f.taskRoot, {
                claimId: claim.claim_id,
                holder: f.reviewer,
                reason: 'Fixture missing coverage',
              }).ok,
              true,
            );
          priorCalls = 1;
        } else {
          mkdirSync(join(file, '..'), { recursive: true });
          writeFileSync(file, JSON.stringify({ status, fixture: true }));
        }
        const before = readFileSync(file);
        const result = await applyDispatch(f.request, { adapter: f.adapter });
        assert.equal(result.ok, false);
        assert.equal(reviewerClaims(f).length, 0);
        assert.equal(f.calls.length, priorCalls);
        assert.deepEqual(readFileSync(file), before);
      } finally {
        f.cleanup();
      }
    });
  }
}

test('retry acquires coverage but still requires fresh capability evidence before its one dispatch', async () => {
  const f = await fixture();
  try {
    await firstConflict(f);
    f.releaseHolder();
    const original = readFileSync(f.cardFile);
    const card = JSON.parse(original.toString()) as { observed_at: string };
    card.observed_at = new Date(Date.now() - 45 * 60_000).toISOString();
    writeFileSync(f.cardFile, JSON.stringify(card));
    const stale = await applyDispatch(f.request, { adapter: f.adapter });
    assert.equal(stale.ok, false);
    assert(stale.blockers.some((b) => b.code === 'capabilities_stale'));
    assert.equal(f.calls.length, 0);
    assert.equal(
      existsSync(
        join(workflowIntentsDir(f.taskRoot), 'dispatch-review-1.json'),
      ),
      false,
    );
    assert.equal(reviewerClaims(f).length, 2);
    writeFileSync(f.cardFile, original);
    const fresh = await applyDispatch(f.request, { adapter: f.adapter });
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    assert.equal(f.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test('writer acceptance and release both remain activation gates', async () => {
  const f = await fixture(false);
  try {
    const unaccepted = await applyDispatch(f.request, { adapter: f.adapter });
    assert.equal(unaccepted.ok, false);
    assert(unaccepted.blockers.some((b) => b.code === 'writers_not_accepted'));
    await f.finishWriter(false);
    const held = await applyDispatch(f.request, { adapter: f.adapter });
    assert.equal(held.ok, false);
    assert(held.blockers.some((b) => b.code === 'writers_not_released'));
    assert.equal(
      readRecord(f.taskRoot)!.attempts.some((a) => a.subtask_id === 'review'),
      false,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test('sealed byte drift and native observation prevent an otherwise undelivered retry', async () => {
  for (const variant of ['bytes', 'native', 'epoch'] as const) {
    const f = await fixture();
    try {
      await firstConflict(f);
      f.releaseHolder();
      if (variant === 'bytes') {
        const file = workflowAssignmentPath(f.taskRoot, 'review');
        writeFileSync(file, readFileSync(file, 'utf8') + ' ');
      }
      if (variant === 'native')
        mutateReview(f, (attempt) => {
          attempt.native.evidence_ref = 'fixture-native-observation';
        });
      if (variant === 'epoch')
        mutateReview(f, (attempt) => {
          attempt.owner_epoch = 2;
        });
      const result = await applyDispatch(f.request, { adapter: f.adapter });
      assert.equal(result.ok, false);
      assert.equal(reviewerClaims(f).length, 0);
      assert.equal(f.calls.length, 0);
    } finally {
      f.cleanup();
    }
  }
});
