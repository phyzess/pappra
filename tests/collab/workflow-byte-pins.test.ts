import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyAccept,
  applyParticipant,
  applyPrepare,
  planDispatch,
  planPrepare,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import {
  workflowAssignmentPath,
  workflowWorkPlanPath,
} from '../../src/schemas/collab-workflow.js';
import { runWorkExecution } from '../../src/app/collab-work-execution.js';
import { readRecord } from '../../src/collab/store.js';
import { readRegisteredMessage } from '../../src/collab/envelope.js';
import { evaluateWorkPlan } from '../../src/collab/work-plan.js';
import { notifyRegisteredMessage } from '../../src/app/collab-notify.js';
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

function rawDigest(file: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function prepareRequest(
  domainRoot: string,
  cwd: string,
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
    task_id: 'pins',
    goal: {
      objective: 'Pin exact bytes.',
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
        ...COORDINATOR,
        cwd,
        surface: 'cli',
        configuration_id: 'daily-visible',
      },
      { ...WRITER, cwd },
      { ...REVIEWER, cwd },
    ],
    bindings: [],
    assignments: [
      declaration('writer', 'writer', WRITER.agent_id, [
        { path: join(cwd, 'a'), access: 'write' },
      ]),
      declaration('review', 'reviewer', REVIEWER.agent_id, [
        { path: join(cwd, 'a'), access: 'read' },
      ]),
    ],
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  };
}

test('the wire pin is the exact sealed assignment bytes in ASSIGN, attempt and manifest', async () => {
  const fixture = makeTaskDomain('pins-raw', ['pins']);
  try {
    const taskRoot = fixture.tasks['pins']!;
    const request = prepareRequest(fixture.domainRoot, fixture.root);
    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'applied', JSON.stringify(applied.blockers));

    const sealedFile = workflowAssignmentPath(taskRoot, 'writer');
    const bytes = rawDigest(sealedFile);
    const sealed = JSON.parse(readFileSync(sealedFile, 'utf8')) as {
      resources: { path: string; access: string; resource_epoch?: number }[];
    };
    const writes = sealed.resources.filter((item) => item.access === 'write');
    assert.ok(writes.length > 0, 'the writer footprint must be sealed');
    for (const resource of writes)
      assert.ok(
        Number.isSafeInteger(resource.resource_epoch) &&
          (resource.resource_epoch ?? 0) > 0,
        'a sealed write resource carries the real epoch',
      );

    const record = readRecord(taskRoot);
    assert(record !== null);
    const attempt = record.attempts.find(
      (item) => item.subtask_id === 'writer',
    );
    assert(attempt !== undefined);
    assert.equal(
      attempt.assignment_digest,
      bytes,
      'the stored attempt pins the exact sealed bytes',
    );

    const assign = record.messages.find(
      (item) => item.message_id === 'assign-writer',
    );
    assert(assign !== undefined);
    const envelope = JSON.parse(
      readFileSync(join(taskRoot, 'messages', 'assign-writer.json'), 'utf8'),
    ) as { body: { assignment_digest: string } };
    assert.equal(
      envelope.body.assignment_digest,
      bytes,
      'the ASSIGN advertises the exact sealed bytes',
    );

    const manifest = JSON.parse(
      readFileSync(join(taskRoot, 'workflow', 'manifest.json'), 'utf8'),
    ) as {
      assignments: {
        subtask_id: string;
        assignment_digest: string | null;
        declaration_digest: string;
        message_digest: string | null;
      }[];
      sealed: { subtask_id: string; digest: string }[];
    };
    const entry = manifest.assignments.find(
      (item) => item.subtask_id === 'writer',
    );
    assert(entry !== undefined);
    assert.equal(
      entry.assignment_digest,
      bytes,
      'the applied manifest carries the wire pin',
    );
    const sealedEntry = manifest.sealed.find(
      (item) => item.subtask_id === 'writer',
    );
    assert.equal(sealedEntry?.digest, bytes);
    assert.match(entry.declaration_digest, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(
      entry.declaration_digest,
      bytes,
      'the declaration identity is not the wire pin once epochs are stamped',
    );
    assert.equal(
      entry.message_digest,
      assign.content_digest,
      'the manifest records the registered ASSIGN digest',
    );
  } finally {
    fixture.cleanup();
  }
});

test('plan mode states the declaration identity and refuses to promise the wire pin', () => {
  const fixture = makeTaskDomain('pins-plan', ['pins'], { initialize: [] });
  try {
    const taskRoot = fixture.tasks['pins']!;
    const report = planPrepare(
      prepareRequest(fixture.domainRoot, fixture.root),
    );
    assert.equal(report.ok, true);
    if (!report.ok) return;
    assert.equal(
      existsSync(taskRoot),
      false,
      'a plan creates no task root, seal, claim or notification',
    );
    for (const entry of report.value.plan.assignments) {
      assert.match(entry.declaration_digest, /^sha256:[0-9a-f]{64}$/);
      assert.equal(entry.assignment_digest, null);
      assert.equal(entry.sealed_digest, null);
      assert.equal(entry.message_digest, null);
      assert.match(entry.message_id, /^assign-/);
    }
  } finally {
    fixture.cleanup();
  }
});

test('an epoch-only tamper stops covering the live claim and breaks the pin', async () => {
  const fixture = makeTaskDomain('pins-tamper', ['pins']);
  try {
    const taskRoot = fixture.tasks['pins']!;
    const request = prepareRequest(fixture.domainRoot, fixture.root);
    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'applied', JSON.stringify(applied.blockers));
    const sealedFile = workflowAssignmentPath(taskRoot, 'writer');
    const pinned = rawDigest(sealedFile);
    const before = planDispatch({
      schema: 'pappra/collab-workflow-dispatch-request/1',
      task_root: taskRoot,
      caller: { ...COORDINATOR, cwd: fixture.root },
      caller_pane: 'w3:p3B',
      capability_targets: [],
      subtasks: ['writer'],
      activate_deferred: false,
      max_age_minutes: 30,
    });
    assert.equal(before.ok, true);
    if (!before.ok) return;
    assert.deepEqual(
      before.value.blockers.filter((item) =>
        item.code.startsWith('claim_coverage'),
      ),
      [],
      'exact live coverage holds before the tamper',
    );

    // Change only the stamped epoch: the declaration identity is unchanged.
    const document = JSON.parse(readFileSync(sealedFile, 'utf8')) as {
      resources: { access: string; resource_epoch?: number }[];
    };
    const write = document.resources.find((item) => item.access === 'write');
    assert(write !== undefined);
    write.resource_epoch = (write.resource_epoch ?? 0) + 1;
    writeFileSync(sealedFile, `${JSON.stringify(document, null, 2)}\n`);

    assert.notEqual(
      rawDigest(sealedFile),
      pinned,
      'the wire pin covers the exact bytes, so an epoch-only edit changes it',
    );
    const after = planDispatch({
      schema: 'pappra/collab-workflow-dispatch-request/1',
      task_root: taskRoot,
      caller: { ...COORDINATOR, cwd: fixture.root },
      caller_pane: 'w3:p3B',
      capability_targets: [],
      subtasks: ['writer'],
      activate_deferred: false,
      max_age_minutes: 30,
    });
    assert.equal(after.ok, true);
    if (!after.ok) return;
    assert.ok(
      after.value.blockers.some(
        (item) => item.code === 'claim_coverage_epoch_mismatch',
      ),
      `an epoch-only tamper must be refused, got ${JSON.stringify(after.value.blockers.map((item) => item.code))}`,
    );
  } finally {
    fixture.cleanup();
  }
});

test('an unrelated live claim cannot authorize a declared resource', async () => {
  const fixture = makeTaskDomain('pins-unrelated', ['pins']);
  try {
    const taskRoot = fixture.tasks['pins']!;
    const request = prepareRequest(fixture.domainRoot, fixture.root);
    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'applied', JSON.stringify(applied.blockers));

    // Drop the writer's real coverage and keep only a live claim on another path.
    const record = readRecord(taskRoot);
    assert(record !== null);
    const writerClaims = record.claims.filter(
      (claim) => claim.subtask_id === 'writer',
    );
    assert.ok(writerClaims.length > 0);
    const replaced = {
      ...record,
      claims: [
        ...record.claims.filter((claim) => claim.subtask_id !== 'writer'),
        {
          ...writerClaims[0]!,
          claim_id: 'unrelated-claim',
          key: join(fixture.root, 'elsewhere'),
          path: join(fixture.root, 'elsewhere'),
        },
      ],
    };
    writeFileSync(
      join(taskRoot, 'task.json'),
      `${JSON.stringify(replaced, null, 2)}\n`,
    );

    const planned = planDispatch({
      schema: 'pappra/collab-workflow-dispatch-request/1',
      task_root: taskRoot,
      caller: { ...COORDINATOR, cwd: fixture.root },
      caller_pane: 'w3:p3B',
      capability_targets: [],
      subtasks: ['writer'],
      activate_deferred: false,
      max_age_minutes: 30,
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    assert.ok(
      planned.value.blockers.some(
        (item) => item.code === 'claim_coverage_missing',
      ),
      'a live claim on a different resource is not coverage',
    );
  } finally {
    fixture.cleanup();
  }
});

test('a deferred reviewer keeps the same exact-byte pin and an idempotent rerun', async () => {
  const fixture = makeTaskDomain('pins-deferred', ['pins']);
  try {
    const taskRoot = fixture.tasks['pins']!;
    const request = prepareRequest(fixture.domainRoot, fixture.root);
    const first = await applyPrepare(request);
    assert.equal(first.status, 'applied', JSON.stringify(first.blockers));
    const reviewFile = workflowAssignmentPath(taskRoot, 'review');
    assert.equal(
      existsSync(reviewFile),
      true,
      'the deferred reviewer document is sealed at prepare',
    );
    const reviewBytes = rawDigest(reviewFile);
    const manifest = JSON.parse(
      readFileSync(join(taskRoot, 'workflow', 'manifest.json'), 'utf8'),
    ) as { assignments: { subtask_id: string; assignment_digest: string }[] };
    assert.equal(
      manifest.assignments.find((item) => item.subtask_id === 'review')
        ?.assignment_digest,
      reviewBytes,
      'the deferred pin is the exact sealed bytes',
    );

    const second = await applyPrepare(request);
    assert.equal(second.status, 'applied', JSON.stringify(second.blockers));
    assert.equal(
      rawDigest(reviewFile),
      reviewBytes,
      'a rerun never rewrites sealed bytes',
    );
    assert.equal(
      rawDigest(workflowAssignmentPath(taskRoot, 'writer')),
      manifest.assignments.find((item) => item.subtask_id === 'writer')
        ?.assignment_digest,
      'the writer pin survives the rerun unchanged',
    );
  } finally {
    fixture.cleanup();
  }
});

test('the existing work-execution plan accepts the sealed byte pin with a real epoch', async () => {
  const fixture = makeTaskDomain('pins-interop', ['pins']);
  try {
    const taskRoot = fixture.tasks['pins']!;
    const request = prepareRequest(fixture.domainRoot, fixture.root);
    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'applied', JSON.stringify(applied.blockers));

    // The lower engine re-reads the sealed assignment through its own bounded reader and
    // compares that byte digest with the registered attempt. It is not modified here.
    writeFileSync(
      join(taskRoot, 'binding.json'),
      `${JSON.stringify(
        {
          schema: 'pappra/collab-binding/1',
          task_id: 'pins',
          task_root: taskRoot,
          channel: 'herdr',
          participants: [
            {
              agent_id: COORDINATOR.agent_id,
              harness: COORDINATOR.harness,
              cwd: fixture.root,
              herdr_agent: 'coordinator',
              pane_id: 'w3:p3B',
              native_session_id: COORDINATOR.session_id,
            },
            {
              agent_id: WRITER.agent_id,
              harness: WRITER.harness,
              cwd: fixture.root,
              herdr_agent: 'writer',
              pane_id: 'w3:p3J',
              native_session_id: WRITER.session_id,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    let adapterCalls = 0;
    const adapter = {
      preflight: async () => {
        adapterCalls += 1;
        return { ok: true, status: 'planned', detail: null };
      },
      dispatch: async () => {
        adapterCalls += 1;
        return { ok: true, status: 'submitted', detail: null };
      },
    };
    const execution = await runWorkExecution(
      {
        request: {
          task_root: taskRoot,
          plan_file: workflowWorkPlanPath(taskRoot),
          binding_file: join(taskRoot, 'binding.json'),
          caller: { ...COORDINATOR, cwd: taskRoot },
          caller_pane: 'w3:p3B',
          capability_cards: [],
        },
        apply: false,
      },
      { adapter },
    );
    assert.equal(adapterCalls, 0, 'plan mode starts no transport');
    const writer = execution.nodes.find(
      (node) => node.assignment_id === 'writer',
    );
    assert(writer !== undefined, JSON.stringify(execution.nodes));
    const codes = writer.blockers.map((item) => String(item));
    assert.equal(
      codes.some((code) => code.startsWith('assignment_digest_mismatch')),
      false,
      `the sealed byte pin must satisfy the existing admission checks: ${JSON.stringify(codes)}`,
    );
    assert.equal(
      codes.some((code) =>
        code.startsWith('assignment_message_digest_mismatch'),
      ),
      false,
      `the registered ASSIGN digest must match the attempt: ${JSON.stringify(codes)}`,
    );
    assert.equal(
      codes.some((code) => code.startsWith('resource_claim_epoch_mismatch')),
      false,
      `the sealed epoch must match the live claim: ${JSON.stringify(codes)}`,
    );
  } finally {
    fixture.cleanup();
  }
});

test('a byte-only sealed edit that leaves resources and epochs intact is refused', async () => {
  const fixture = makeTaskDomain('pins-byte-only', ['pins']);
  try {
    const taskRoot = fixture.tasks['pins']!;
    const request = prepareRequest(fixture.domainRoot, fixture.root);
    const applied = await applyPrepare(request);
    assert.equal(applied.status, 'applied', JSON.stringify(applied.blockers));
    const sealedFile = workflowAssignmentPath(taskRoot, 'writer');
    const document = JSON.parse(readFileSync(sealedFile, 'utf8')) as {
      objective: string;
    };
    // Only prose changes: no resource, access or epoch moves.
    document.objective = `${document.objective} (edited)`;
    writeFileSync(sealedFile, `${JSON.stringify(document, null, 2)}\n`);

    const planned = planDispatch({
      schema: 'pappra/collab-workflow-dispatch-request/1',
      task_root: taskRoot,
      caller: { ...COORDINATOR, cwd: fixture.root },
      caller_pane: 'w3:p3B',
      capability_targets: [],
      subtasks: ['writer'],
      activate_deferred: false,
      max_age_minutes: 30,
    });
    assert.equal(planned.ok, true);
    if (!planned.ok) return;
    const codes = planned.value.blockers.map((item) => item.code);
    assert.ok(
      codes.includes('assignment_digest_mismatch'),
      `a byte-only edit must break the raw pin, got ${JSON.stringify(codes)}`,
    );
    assert.equal(
      codes.includes('claim_coverage_missing') ||
        codes.includes('claim_coverage_epoch_mismatch'),
      false,
      'coverage is untouched by this tamper, so the raw pin is what refuses it',
    );
  } finally {
    fixture.cleanup();
  }
});

test('a null external goal keeps one revision through prepare, ACK, REPORT and accept', async () => {
  const fixture = makeTaskDomain('pins-revision', ['pins']);
  try {
    const taskRoot = fixture.tasks['pins']!;
    const request = prepareRequest(fixture.domainRoot, fixture.root);
    const prepared = await applyPrepare(request);
    assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
    const planFiles = JSON.parse(
      readFileSync(workflowWorkPlanPath(taskRoot), 'utf8'),
    ) as { nodes: { node_id: string; input_revision: string }[] };
    const revision = planFiles.nodes.find(
      (node) => node.node_id === 'writer',
    )?.input_revision;
    assert.match(revision ?? '', /^sha256:[0-9a-f]{64}$/);
    const recordAfterPrepare = readRecord(taskRoot);
    assert.equal(
      recordAfterPrepare?.input_revision,
      revision,
      'the record uses the pinned input revision, not a plan-byte hash',
    );
    const assign = readRegisteredMessage(taskRoot, 'assign-writer');
    assert.equal(
      assign?.body?.input_revision,
      revision,
      'the ASSIGN carries the same revision',
    );

    const output = join(fixture.root, 'a');
    writeFileSync(output, 'written by the writer\n');
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

    const acked = await applyParticipant(
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
    assert.equal(acked.status, 'applied', JSON.stringify(acked.blockers));

    const reported = await applyParticipant(
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
          summary: 'Wrote the declared output.',
          blockers: [],
          outputs: [output],
        },
        release: null,
      },
      { notify: silentNotify },
    );
    assert.equal(reported.status, 'applied', JSON.stringify(reported.blockers));
    const reportMessageId = reported.messages[0]?.message_id ?? '';
    assert.notEqual(reportMessageId, '');

    const accepted = await applyAccept(
      {
        schema: 'pappra/collab-workflow-accept-request/1',
        task_root: taskRoot,
        caller: { ...COORDINATOR, cwd: fixture.root },
        subtask_id: 'writer',
        attempt: 1,
        report_message_id: reportMessageId,
        caller_pane: 'w3:p3B',
        reason: 'Bounded work completed.',
      },
      { notify: silentNotify },
    );
    assert.equal(accepted.status, 'applied', JSON.stringify(accepted.blockers));

    const record = readRecord(taskRoot);
    assert(record !== null);
    // The evaluator reads registered decision envelopes, not a prose claim.
    const decision = readRegisteredMessage(
      taskRoot,
      accepted.messages[0]?.message_id ?? '',
    );
    assert(decision !== null, 'the acceptance envelope is registered');
    const evaluation = evaluateWorkPlan({
      plan: JSON.parse(readFileSync(workflowWorkPlanPath(taskRoot), 'utf8')),
      record,
      messages: [decision],
    });
    assert.equal(evaluation.ok, true, JSON.stringify(evaluation));
    if (!evaluation.ok) return;
    const node = evaluation.nodes.find((item) => item.node_id === 'writer');
    assert.equal(
      node?.status,
      'accepted',
      `the evaluator accepts the attempt on the same revision: ${JSON.stringify(node)}`,
    );
  } finally {
    fixture.cleanup();
  }
});
