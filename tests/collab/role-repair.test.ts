import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJsonDigest } from '../../src/infra/json.js';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  repairRejectedRoleNode,
  recoverRoleRepairPlan,
  type NativeStopReceipt,
  type RoleRepairRequest,
} from '../../src/app/collab-role-repair.js';
import {
  expandRolePlan,
  COLLAB_ROLE_PLAN_SCHEMA,
  type RolePlanRequest,
} from '../../src/app/collab-role-plan.js';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { claimResources } from '../../src/collab/resources.js';
import { readRecord, transact } from '../../src/collab/store.js';
import { makeTaskDomain } from './task-resources-fixtures.js';
import { owner } from './scenarios.js';
import { tickRoleOrchestration } from '../../src/app/collab-role-orchestration.js';

function fixture() {
  const domain = makeTaskDomain('role-repair-live', ['sample']);
  const task = domain.tasks.sample!;
  const source = {
    agent_id: 'source',
    session_id: randomUUID(),
    harness: 'pi',
  };
  const next = { agent_id: 'next', session_id: randomUUID(), harness: 'pi' };
  const revision = `sha256:${'1'.repeat(64)}`;
  const resources = [
    { path: path.join(domain.root, 'work.ts'), access: 'write' as const },
  ];
  fs.writeFileSync(resources[0]!.path, '');
  const rolePlan: RolePlanRequest = {
    schema: COLLAB_ROLE_PLAN_SCHEMA,
    plan_id: 'repair-plan',
    task_id: 'sample',
    owner_epoch: 1,
    participants: [
      { participant_id: 'source', role: 'writer', assignee: source },
      {
        participant_id: 'reviewer',
        role: 'reviewer',
        assignee: { agent_id: 'reviewer', session_id: 'reviewer-session' },
      },
    ],
    assignments: [
      {
        node_id: 'write',
        role: 'writer',
        assignment_id: 'write',
        attempt: 1,
        input_revision: revision,
        participant_id: 'source',
        resources,
      },
      {
        node_id: 'review',
        role: 'reviewer',
        assignment_id: 'review',
        attempt: 1,
        input_revision: revision,
        participant_id: 'reviewer',
        resources: [{ path: resources[0]!.path, access: 'read' }],
      },
    ],
  };
  const expanded = expandRolePlan(rolePlan);
  assert.ok(expanded.ok, JSON.stringify(expanded));
  const planFile = path.join(task, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(expanded.plan));
  assert.ok(
    submitMessage(
      task,
      buildMessage({
        message_id: 'assign-source',
        type: 'ASSIGN',
        task_id: 'sample',
        from: owner,
        to: source,
        subtask_id: 'write',
        attempt: 1,
        owner_epoch: 1,
        body: {
          input_revision: revision,
          assignment_digest: `sha256:${'2'.repeat(64)}`,
        },
      }),
    ).ok,
  );
  assert.ok(
    claimResources(task, {
      resources: [{ path: resources[0]!.path }],
      access: 'write',
      holder: source,
      subtaskId: 'write',
      attempt: 1,
    }).ok,
  );
  const execution = {
    task_root: task,
    plan_file: planFile,
    binding_file: path.join(task, 'binding.json'),
    caller: { ...owner, cwd: domain.root },
    caller_pane: 'w3:p1',
    capability_cards: [
      {
        assignment_id: 'write',
        capabilities_file: path.join(task, 'source-card.json'),
      },
    ],
  };
  const nextExecution = {
    ...execution,
    capability_cards: [
      {
        assignment_id: 'write',
        capabilities_file: path.join(task, 'next-card.json'),
      },
    ],
  };
  const assignmentFile = path.join(task, 'next-assignment.json');
  const assignmentBytes = JSON.stringify({
    schema: 'pappra/collaboration-assignment/1',
    task_id: 'sample',
    assignment_id: 'write',
    objective: 'Repair the rejected writer.',
    attempt: 2,
    roles: ['writer'],
    acceptance: ['Review accepted.'],
    coordinator: owner,
    assignee: {
      ...next,
      cwd: domain.root,
      surface: 'pi-sdk-tui',
      configuration_id: 'next',
    },
    inputs: [],
    resources: resources.map((resource) => ({
      ...resource,
      resource_epoch: 2,
    })),
    runner: { name: 'pi', mode: 'visible', omitted_capabilities: [] },
    required: { skills: [], tools: [] },
    preferred: { skills: [], tools: [] },
  });
  fs.writeFileSync(assignmentFile, assignmentBytes);
  const request: RoleRepairRequest = {
    task_root: task,
    plan_file: planFile,
    journal_file: path.join(task, 'orchestration.json'),
    event_id: 'rejected-source',
    role_plan: rolePlan,
    execution,
    policy: {
      authorizations: [
        {
          coordinator: owner,
          source: {
            node_id: 'write',
            assignment_id: 'write',
            attempt: 1,
            input_revision: revision,
            resources,
          },
          next: {
            assignment_ref: assignmentFile,
            assignment_digest: `sha256:${createHash('sha256').update(assignmentBytes).digest('hex')}`,
            assignment_id: 'write',
            attempt: 2,
            input_revision: revision,
            participant_id: 'next',
            assignee: next,
            // Independent serializers may emit equivalent fields in another order.
            resources: resources.map(({ path, access }) => ({ access, path })),
          },
          next_execution: nextExecution,
          approval: {
            approved_by: owner.agent_id,
            reason: 'Retry the rejected writer in a fresh session.',
            authorization_id: 'approved-repair',
            owner_epoch: 1,
            source_attempt: 1,
            source_input_revision: revision,
            next_assignment_id: 'write',
            next_attempt: 2,
            next_input_revision: revision,
            resources_digest: canonicalJsonDigest(resources),
          },
        },
      ],
    },
    rejected_node_ids: ['write'],
    max_attempts: 3,
    max_actions: 2,
    reserved_actions: 1,
  };
  return { ...domain, task, source, next, request };
}

test('authorized repair tolerates an unrelated atomic message commit during the live stop and recovers execution pins', async () => {
  const value = fixture();
  try {
    assert(
      submitMessage(
        value.task,
        buildMessage({
          message_id: 'coordinator-requested-stop',
          type: 'CANCEL',
          task_id: 'sample',
          from: owner,
          to: value.source,
          subtask_id: 'write',
          attempt: 1,
          owner_epoch: 1,
          body: { reason: 'repair the rejected node' },
        }),
      ).ok,
    );
    const before = JSON.stringify(readRecord(value.task));
    const missing = await repairRejectedRoleNode(value.request);
    assert.equal(missing.status, 'repair-required', JSON.stringify(missing));
    assert.equal(
      missing.diagnostic,
      'live_supported_stop_receipt_missing_or_stale',
    );
    assert.equal(JSON.stringify(readRecord(value.task)), before);
    let calls = 0;
    const result = await repairRejectedRoleNode(value.request, {
      confirm_stopped: async () => {
        calls++;
        assert(
          submitMessage(
            value.task,
            buildMessage({
              message_id: 'unrelated-question-during-stop',
              type: 'ASK',
              task_id: 'sample',
              from: value.source,
              to: owner,
              subtask_id: 'write',
              attempt: 1,
              body: { question: 'Which file?' },
            }),
          ).ok,
        );
        return {
          schema: 'pappra/collab-native-stop-receipt/1',
          observation: 'confirmed',
          task_id: 'sample',
          subtask_id: 'write',
          attempt: 1,
          owner_epoch: 1,
          assignee: value.source,
          evidence_ref: 'trusted-fixture-owned-runtime',
          observed_at: new Date().toISOString(),
        };
      },
    });
    assert.equal(result.status, 'repaired', JSON.stringify(result));
    assert.equal(calls, 1);
    const record = readRecord(value.task)!;
    assert.equal(
      record.messages.some((entry) => entry.type === 'CANCELLED'),
      false,
    );
    const sourceStop = record.attempts[0]!.transitions.at(-1)!;
    assert.equal(sourceStop.actor, owner.agent_id);
    assert.equal(
      (sourceStop.evidence as NativeStopReceipt).schema,
      'pappra/collab-native-stop-receipt/1',
    );
    assert.equal(
      record.uncertainty.some(
        (entry) => entry.kind === 'cancel_unconfirmed' && !entry.resolved_at,
      ),
      false,
    );
    assert.equal(
      record.attempts?.find((entry) => entry.attempt === 1)?.state,
      'cancelled',
    );
    assert.equal(
      record.attempts?.find((entry) => entry.attempt === 2)?.assignee
        .session_id,
      value.next.session_id,
    );
    assert.ok(
      record.claims
        .filter((entry) => !entry.released_at)
        .every(
          (entry) =>
            entry.holder.session_id === value.next.session_id &&
            entry.attempt === 2,
        ),
    );
    const recovered = await recoverRoleRepairPlan(
      value.request.role_plan,
      value.request.execution,
      value.request.policy,
      value.request.journal_file,
      value.task,
      value.request.plan_file,
      3,
    );
    assert.equal(recovered.role_plan.assignments[0]?.attempt, 2);
    assert.deepEqual(recovered.execution, result.execution);
    const duplicate = await repairRejectedRoleNode(value.request, {
      confirm_stopped: async () => {
        assert.fail('duplicate must not repeat the native stop');
      },
    });
    assert.equal(duplicate.status, 'repaired', JSON.stringify(duplicate));
    transact(value.task, {
      actor: 'fixture',
      purpose: 'change-owner',
      apply(current) {
        assert.ok(current.coordinator);
        current.coordinator.owner_epoch++;
        return {
          record: current,
          op: 'change-owner',
          summary: {},
          result: null,
        };
      },
    });
    const stale = await recoverRoleRepairPlan(
      value.request.role_plan,
      value.request.execution,
      value.request.policy,
      value.request.journal_file,
      value.task,
      value.request.plan_file,
      3,
    );
    assert.equal(
      stale.role_plan.assignments[0]?.attempt,
      1,
      'journal cannot override changed authority',
    );
  } finally {
    value.cleanup();
  }
});

test('coordinator repair cannot close or release a source with unbound or stale host stop evidence', async () => {
  for (const invalid of ['task', 'attempt', 'epoch', 'assignee', 'stale']) {
    const value = fixture();
    try {
      const before = structuredClone(readRecord(value.task));
      const receipt: NativeStopReceipt = {
        schema: 'pappra/collab-native-stop-receipt/1',
        observation: 'confirmed',
        task_id: invalid === 'task' ? 'another-task' : 'sample',
        subtask_id: 'write',
        attempt: invalid === 'attempt' ? 2 : 1,
        owner_epoch: invalid === 'epoch' ? 2 : 1,
        assignee: invalid === 'assignee' ? value.next : value.source,
        evidence_ref: 'trusted-fixture-owned-runtime',
        observed_at: new Date(
          Date.now() - (invalid === 'stale' ? 60_000 : 0),
        ).toISOString(),
      };
      const result = await repairRejectedRoleNode(value.request, {
        confirm_stopped: async () => receipt,
      });
      assert.equal(result.status, 'repair-required', invalid);
      assert.equal(
        result.diagnostic,
        'live_supported_stop_receipt_missing_or_stale',
      );
      assert.deepEqual(readRecord(value.task), before, invalid);
    } finally {
      value.cleanup();
    }
  }
});

test('coordinator drift during the native stop cannot release already-closed source claims', async () => {
  const value = fixture();
  try {
    const sourcePin = value.request.policy.authorizations[0]!.source;
    assert(
      submitMessage(
        value.task,
        buildMessage({
          message_id: 'source-closed-before-stop',
          type: 'REPORT',
          task_id: 'sample',
          from: value.source,
          to: owner,
          subtask_id: 'write',
          attempt: 1,
          owner_epoch: 1,
          body: {
            status: 'completed',
            input_revision: sourcePin.input_revision,
          },
        }),
      ).ok,
    );
    const result = await repairRejectedRoleNode(value.request, {
      confirm_stopped: async () => {
        const changed = transact(value.task, {
          actor: 'fixture',
          purpose: 'owner-drift-during-stop',
          apply(record) {
            record.coordinator!.owner_epoch++;
            return { record, result: null };
          },
        });
        assert(changed.ok);
        return {
          schema: 'pappra/collab-native-stop-receipt/1',
          observation: 'confirmed',
          task_id: 'sample',
          subtask_id: 'write',
          attempt: 1,
          owner_epoch: 1,
          assignee: value.source,
          evidence_ref: 'controlled-stop-fixture',
          observed_at: new Date().toISOString(),
        };
      },
    });
    assert.notEqual(result.status, 'repaired');
    assert(readRecord(value.task)!.claims.every((claim) => !claim.released_at));
    assert.equal(readRecord(value.task)!.attempts.length, 1);
  } finally {
    value.cleanup();
  }
});

test('two real orchestration ticks recover approved repair pins and refuse dispatch without fresh readiness', async () => {
  const value = fixture();
  try {
    const sourcePin = value.request.policy.authorizations[0]!.source;
    const report = buildMessage({
      message_id: 'rejected-report',
      type: 'REPORT',
      task_id: 'sample',
      from: value.source,
      to: owner,
      subtask_id: 'write',
      attempt: 1,
      body: { status: 'completed', input_revision: sourcePin.input_revision },
    });
    assert.ok(submitMessage(value.task, report).ok);
    const answer = buildMessage({
      message_id: 'reject-work',
      type: 'ANSWER',
      task_id: 'sample',
      from: owner,
      to: value.source,
      reply_to: report.message_id,
      subtask_id: 'write',
      attempt: 1,
      owner_epoch: 1,
      body: {
        acceptance: {
          plan_id: 'repair-plan',
          node_id: 'write',
          assignment_id: 'write',
          attempt: 1,
          input_revision: sourcePin.input_revision,
          report_message_id: report.message_id,
          report_digest: report.content_digest,
          decision: 'rejected',
        },
      },
    });
    assert.ok(submitMessage(value.task, answer).ok);
    const request = {
      role_plan: value.request.role_plan,
      execution: value.request.execution,
      repair_policy: value.request.policy,
      event_id: 'reject-event',
      journal_file: value.request.journal_file,
      limits: { max_rounds: 3, max_actions: 2, max_attempts: 3 },
    };
    let stops = 0;
    const repaired = await tickRoleOrchestration(request, {
      repair: {
        confirm_stopped: async () => {
          stops++;
          return {
            schema: 'pappra/collab-native-stop-receipt/1',
            observation: 'confirmed',
            task_id: 'sample',
            subtask_id: 'write',
            attempt: 1,
            owner_epoch: 1,
            assignee: value.source,
            evidence_ref: 'trusted-fixture-native-disposal',
            observed_at: new Date().toISOString(),
          };
        },
      },
    });
    assert.equal(repaired.status, 'repaired', JSON.stringify(repaired));
    assert.equal(
      stops,
      1,
      'even a completed task must fence the old native runtime',
    );
    assert.equal(
      repaired.updatedRequest?.execution.capability_cards[0]?.capabilities_file,
      value.request.policy.authorizations[0]!.next_execution!
        .capability_cards[0]!.capabilities_file,
    );
    // The watcher still has the original request. Recovery must derive the promoted
    // plan internally, retain the same budget lineage and recheck actual readiness.
    const next = await tickRoleOrchestration({
      ...request,
      event_id: 'next-event',
    });
    assert.equal(next.round, 2, JSON.stringify(next));
    assert.notEqual(
      next.status,
      'dispatched',
      'missing next capability/binding files cannot launch a writer',
    );
    assert.equal(readRecord(value.task)?.launch_reservations?.length ?? 0, 0);
    assert.equal(
      value.request.role_plan.assignments[0]?.attempt,
      1,
      'caller request is unchanged',
    );
  } finally {
    value.cleanup();
  }
});
