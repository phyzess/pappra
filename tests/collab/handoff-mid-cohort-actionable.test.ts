import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readCoordinatorHandoffCheck } from '../../src/app/collab-handoff.js';
import { notifyRegisteredMessage } from '../../src/app/collab-notify.js';
import { applyRecovery } from '../../src/app/collab-recovery.js';
import {
  reconcileGuidance,
  withReconcileGuidance,
  type ReconcileGuidance,
} from '../../src/app/collab-successor/reconcile-guidance.js';
import { openTaskStore } from '../../src/app/collab-task-store.js';
import {
  applyParticipant,
  applyPrepare,
  type WorkflowParticipantRequest,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import { runCli } from '../../src/cli/run.js';
import { transitionAttempt } from '../../src/collab/lifecycle.js';
import type { TaskRecord } from '../../src/collab/types.js';
import { transact } from '../../src/collab/store.js';
import { collaborationRecoveryRequestSchema } from '../../src/schemas/collaboration.js';
import { owner } from './scenarios.js';
import { makeTaskDomain, snapshotTree } from './task-resources-fixtures.js';

const WRITER_A = {
  agent_id: 'writer-a',
  session_id: 'writer-a-session',
  harness: 'pi',
};
const WRITER_B = {
  agent_id: 'writer-b',
  session_id: 'writer-b-session',
  harness: 'pi',
};
const REVIEWER = {
  agent_id: 'reviewer',
  session_id: 'reviewer-session',
  harness: 'pi',
};

/** Delivery stub: these tests assert protocol state, not the Herdr transport. */
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

const participant = (
  base: typeof WRITER_A,
  cwd: string,
): WorkflowPrepareRequest['participants'][number] => ({
  ...base,
  cwd,
  surface: 'cli',
  configuration_id: 'daily-visible',
});

const assignment = (
  subtask: string,
  assignee: string,
  path: string,
  access: 'read' | 'write',
  role: 'writer' | 'reviewer' = 'writer',
) => ({
  subtask_id: subtask,
  role,
  assignee,
  objective: `Objective for ${subtask}.`,
  acceptance: [`Acceptance for ${subtask}.`],
  resources: [{ path, access }],
  required_skills: [],
  required_tools: [],
  native_evidence: [],
});

/** A prepared cohort: two writers with attempts, one deferred reviewer. */
async function cohort(label: string) {
  const fixture = makeTaskDomain(label, ['cohort'], { initialize: [] });
  const cwd = fixture.root;
  const prepared = await applyPrepare({
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: fixture.domainRoot,
    task_id: 'cohort',
    goal: {
      objective: 'Build the sample cohort.',
      input_ref: null,
      input_digest: null,
    },
    coordinator: {
      agent_id: owner.agent_id,
      session_id: owner.session_id,
      harness: owner.harness,
      owner_epoch: owner.owner_epoch,
      since: owner.since,
      cwd,
      surface: 'cli',
      configuration_id: 'daily-visible',
    },
    participants: [
      participant(
        {
          agent_id: owner.agent_id,
          session_id: owner.session_id,
          harness: owner.harness,
        },
        cwd,
      ),
      participant(WRITER_A, cwd),
      participant(WRITER_B, cwd),
      participant(REVIEWER, cwd),
    ],
    bindings: [],
    assignments: [
      assignment('writer-one', WRITER_A.agent_id, join(cwd, 'a'), 'write'),
      assignment('writer-two', WRITER_B.agent_id, join(cwd, 'b'), 'write'),
      assignment(
        'review',
        REVIEWER.agent_id,
        join(cwd, 'a'),
        'read',
        'reviewer',
      ),
    ],
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  } satisfies WorkflowPrepareRequest);
  assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
  const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
  const ack = async (who: typeof WRITER_A, subtask: string) => {
    const request: WorkflowParticipantRequest = {
      schema: 'pappra/collab-workflow-participant-request/1',
      action: 'ack',
      task_root: taskRoot,
      caller: { ...who, cwd: taskRoot },
      subtask_id: subtask,
      attempt: 1,
      caller_pane: null,
      report: null,
      release: null,
    };
    const acked = await applyParticipant(request, { notify: silentNotify });
    assert.equal(acked.status, 'applied', JSON.stringify(acked.blockers));
  };
  return { fixture, taskRoot, ack };
}

async function midCohort(taskRoot: string) {
  const raw = await readCoordinatorHandoffCheck(taskRoot, {
    mode: 'mid_cohort',
  });
  assert.ok(raw.ok);
  return {
    raw: raw.value,
    guided: await withReconcileGuidance(raw.value, taskRoot),
  };
}

const codes = (value: Record<string, unknown>) =>
  (value['blockers'] as { code: string }[]).map((item) => item.code);
const reconcileOf = (value: Record<string, unknown>) =>
  value['reconcile'] as ReconcileGuidance[];

async function openUncertainty(taskRoot: string, subtask: string) {
  const opened = await openTaskStore(taskRoot);
  assert.ok(opened.ok);
  const found = opened.value.record.uncertainty.filter(
    (item) =>
      item.subtask_id === subtask &&
      item.kind === 'registered_not_started' &&
      !item.resolved_at,
  );
  assert.equal(found.length, 1);
  return found[0]!.uncertainty_id;
}

async function cli(args: string[]) {
  let stdout = '';
  const code = await runCli(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
  });
  return { code, stdout };
}

test('the mid-cohort check names the reconcile request and the ACK to cite per acknowledged-only attempt', async () => {
  const { fixture, taskRoot, ack } = await cohort('mid-actionable');
  try {
    await ack(WRITER_A, 'writer-one');
    await ack(WRITER_B, 'writer-two');
    const { raw, guided } = await midCohort(taskRoot);

    // The rule is untouched: an ACK is not a native observation, so the check keeps blocking.
    assert.equal(guided['ok'], false);
    assert.equal(guided['status'], 'blocked');
    assert.deepEqual(codes(guided), codes(raw));
    assert.deepEqual(guided['attempts'], raw['attempts']);
    assert.equal(
      codes(guided).filter((code) => code === 'attempt_not_transferable')
        .length,
      2,
    );
    // The app-level check stays a pure verdict; only the wrapper adds guidance.
    assert.equal('reconcile' in raw, false);

    const guidance = reconcileOf(guided);
    assert.deepEqual(
      guidance.map((item) => `${item.subtask_id}#${item.attempt}`),
      ['writer-one#1', 'writer-two#1'],
    );
    for (const [item, subtask, ackId] of [
      [guidance[0]!, 'writer-one', 'ack-writer-one-1'],
      [guidance[1]!, 'writer-two', 'ack-writer-two-1'],
    ] as const) {
      const uncertainty = await openUncertainty(taskRoot, subtask);
      assert.equal(item.state, 'accepted');
      assert.equal(item.uncertainty_id, uncertainty);
      assert.equal(item.ack_message_id, ackId);
      // What the record gives is filled; what only the operator can state is null, so the
      // document is refused until the operator replaces it.
      assert.deepEqual(item.request, {
        schema: 'pappra/collaboration-recovery-request/1',
        action: 'reconcile',
        actor: null,
        owner_epoch: 1,
        uncertainty_id: uncertainty,
        resolution: null,
        resolution_evidence: null,
      });
      assert.deepEqual(item.operator_fields, [
        'actor',
        'resolution',
        'resolution_evidence',
      ]);
      assert.match(item.command, /^collab recovery reconcile --task-root '/);
      assert.ok(item.command.includes(taskRoot));
      assert.match(item.command, /--request <abs request\.json> \[--apply\]/);
      const text = item.prerequisites.join('\n');
      assert.match(text, /not native|only shows it received/);
      assert.match(
        text,
        /owner_epoch must equal the current coordinator epoch \(1\)/,
      );
      assert.ok(text.includes(`ACK ${ackId}`));
      assert.match(text, /Do not pass set_state/);
      assert.match(text, /null in the request on purpose/);
      assert.match(
        text,
        new RegExp(`Begin resolution_evidence with "ACK ${ackId};"`),
      );
      // The blocker itself points at the request, keeping the check's own sentence first.
      const blocker = (
        guided['blockers'] as {
          code: string;
          detail: string;
          next_action: string;
        }[]
      ).find(
        (entry) =>
          entry.code === 'attempt_not_transferable' &&
          entry.detail.startsWith(`${subtask}#1 is `),
      )!;
      assert.ok(
        blocker.next_action.startsWith(
          'Bind native evidence for the attempt, or resolve its registered_not_started uncertainty, before handing off.',
        ),
      );
      assert.ok(blocker.next_action.includes(uncertainty));
      assert.ok(blocker.next_action.includes(`ACK ${ackId}`));
    }
  } finally {
    fixture.cleanup();
  }
});

test('the guided request is accepted by reconcile and clears its blocker, one attempt at a time', async () => {
  const { fixture, taskRoot, ack } = await cohort('mid-actionable-apply');
  try {
    await ack(WRITER_A, 'writer-one');
    await ack(WRITER_B, 'writer-two');
    const reconcileFirst = async (subtask: string) => {
      const { guided } = await midCohort(taskRoot);
      const entry = reconcileOf(guided).find(
        (item) => item.subtask_id === subtask,
      )!;
      const parsed = collaborationRecoveryRequestSchema.safeParse({
        ...entry.request,
        actor: 'coordinator',
        resolution: 'Worker pane is alive and answering.',
        resolution_evidence: `ACK ${entry.ack_message_id}; pane observed alive`,
      });
      assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
      const applied = await applyRecovery(taskRoot, parsed.data);
      assert.ok(applied.ok, JSON.stringify(applied));
      assert.equal(applied.value['status'], 'applied');
      return entry;
    };
    const first = await reconcileFirst('writer-one');
    assert.equal(first.ack_message_id, 'ack-writer-one-1');
    const half = await midCohort(taskRoot);
    assert.equal(half.guided['status'], 'blocked');
    assert.deepEqual(
      reconcileOf(half.guided).map((item) => item.subtask_id),
      ['writer-two'],
    );
    await reconcileFirst('writer-two');
    const done = await midCohort(taskRoot);
    assert.equal(
      done.guided['status'],
      'ready',
      JSON.stringify(done.guided['blockers']),
    );
    assert.deepEqual(reconcileOf(done.guided), []);
    // The ACK stays cited in the recorded resolution.
    const opened = await openTaskStore(taskRoot);
    assert.ok(opened.ok);
    const resolved = opened.value.record.uncertainty.filter(
      (item) => item.kind === 'registered_not_started' && item.resolved_at,
    );
    assert.equal(resolved.length, 2);
    assert.ok(
      resolved.some((item) =>
        String(item.resolution_evidence).includes('ack-writer-one-1'),
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test('an attempt that was only assigned gets no reconcile guidance: its remedy is delivery or cancellation', async () => {
  const { fixture, taskRoot, ack } = await cohort('mid-actionable-assigned');
  try {
    const none = await midCohort(taskRoot);
    assert.equal(
      codes(none.guided).filter((code) => code === 'attempt_not_transferable')
        .length,
      2,
    );
    assert.deepEqual(reconcileOf(none.guided), []);
    for (const item of none.guided['blockers'] as { next_action: string }[])
      assert.doesNotMatch(item.next_action, /reconcile/);

    await ack(WRITER_A, 'writer-one');
    const mixed = await midCohort(taskRoot);
    assert.deepEqual(
      reconcileOf(mixed.guided).map((item) => item.subtask_id),
      ['writer-one'],
    );
    const stillAssigned = (
      mixed.guided['blockers'] as {
        code: string;
        detail: string;
        next_action: string;
      }[]
    ).find((item) => item.detail.startsWith('writer-two#1 is '))!;
    assert.doesNotMatch(stillAssigned.next_action, /reconcile/);
  } finally {
    fixture.cleanup();
  }
});

test("with no applied ACK in the record nothing is invented: the ACK id is null and the evidence is the operator's", async () => {
  const { fixture, taskRoot } = await cohort('mid-actionable-no-ack');
  try {
    // Advance the attempt without any ACK message, as a manual transition would.
    const moved = transact(taskRoot, {
      actor: 'fixture',
      purpose: 'advance',
      apply: (record) => {
        for (const to of ['accepted', 'running']) {
          const result = transitionAttempt(record, {
            subtaskId: 'writer-one',
            attempt: 1,
            to,
            actor: 'fixture',
            reason: 'fixture',
          });
          if (!result.ok) return result;
        }
        return { record, op: 'advance', summary: {}, result: { ok: true } };
      },
    });
    assert.ok(moved.ok, JSON.stringify(moved));
    const { guided } = await midCohort(taskRoot);
    const [entry, ...rest] = reconcileOf(guided);
    assert.equal(rest.length, 0);
    assert.equal(entry!.state, 'running');
    assert.equal(entry!.ack_message_id, null);
    // The evidence is the operator's to name: nothing is pre-filled and nothing is invented.
    assert.equal(entry!.request.resolution_evidence, null);
    assert.ok(entry!.operator_fields.includes('resolution_evidence'));
    assert.match(
      entry!.prerequisites.join('\n'),
      /no applied ACK for this attempt/,
    );
    const blocker = (
      guided['blockers'] as {
        code: string;
        detail: string;
        next_action: string;
      }[]
    ).find((item) => item.detail.startsWith('writer-one#1 is '))!;
    assert.match(blocker.next_action, /cite the evidence you hold/);
  } finally {
    fixture.cleanup();
  }
});

test("only the assignee's applied ACK is cited, preferring the one that moved the attempt", async () => {
  const { fixture, taskRoot, ack } = await cohort('mid-actionable-sender');
  try {
    await ack(WRITER_A, 'writer-one');
    const opened = await openTaskStore(taskRoot);
    assert.ok(opened.ok);
    const record = JSON.parse(
      JSON.stringify(opened.value.record),
    ) as TaskRecord;
    const real = record.messages.find(
      (item) => item.message_id === 'ack-writer-one-1',
    )!;
    const impostor = {
      ...real,
      message_id: 'ack-impostor',
      from: { ...real.from, agent_id: 'impostor' },
    };
    const otherSession = {
      ...real,
      message_id: 'ack-other-session',
      from: { ...real.from, session_id: 'another-session' },
    };
    const recordedOnly = {
      ...real,
      message_id: 'ack-recorded-only',
      state: 'recorded',
    };
    const duplicate = { ...real, message_id: 'ack-duplicate' };
    const blocking = new Map([['writer-one#1', 'accepted']]);
    const cited = () =>
      reconcileGuidance(record, taskRoot, blocking)[0]!.ack_message_id;

    // The ACK that moved the attempt names itself in the transition reason and wins over a
    // duplicate from the assignee that was registered earlier.
    record.messages.unshift(duplicate);
    assert.equal(cited(), 'ack-writer-one-1');

    // Without that reference the sender and the applied state decide: another agent's or another
    // session's ACK and an unapplied one registered earlier are skipped, and the first genuine
    // ACK is cited.
    const attempt = record.attempts.find(
      (item) => item.subtask_id === 'writer-one',
    )!;
    for (const transition of attempt.transitions) transition.reason = 'fixture';
    record.messages.splice(
      0,
      1,
      impostor,
      otherSession,
      recordedOnly,
      duplicate,
    );
    assert.equal(cited(), 'ack-duplicate');
    record.messages = record.messages.filter(
      (item) => item.message_id !== 'ack-duplicate',
    );
    assert.equal(cited(), 'ack-writer-one-1');
    record.messages = record.messages.filter(
      (item) => item.message_id !== 'ack-writer-one-1',
    );
    assert.equal(cited(), null);

    // Guidance is limited to the attempts the check itself blocked, to an open uncertainty and
    // to a coordinator whose epoch the request can name.
    assert.deepEqual(reconcileGuidance(record, taskRoot, new Map()), []);
    // ... and to the state the check saw: an attempt that moved on since the verdict gets none.
    assert.deepEqual(
      reconcileGuidance(
        record,
        taskRoot,
        new Map([['writer-one#1', 'assigned']]),
      ),
      [],
    );
    const entry = record.uncertainty.find(
      (item) =>
        item.subtask_id === 'writer-one' &&
        item.kind === 'registered_not_started',
    )!;
    entry.resolved_at = '2026-10-28T00:00:00Z';
    assert.deepEqual(reconcileGuidance(record, taskRoot, blocking), []);
    entry.resolved_at = null;
    assert.equal(reconcileGuidance(record, taskRoot, blocking).length, 1);
    record.coordinator = null as never;
    assert.deepEqual(reconcileGuidance(record, taskRoot, blocking), []);
  } finally {
    fixture.cleanup();
  }
});

test('a record that cannot be read again leaves the blockers and warns that guidance is missing', async () => {
  const fixture = makeTaskDomain('mid-actionable-unreadable', []);
  try {
    const check = {
      ok: false,
      status: 'blocked',
      attempts: [
        {
          subtask_id: 'work',
          attempt: 1,
          state: 'accepted',
          transferable: false,
          next_action: null,
        },
      ],
      blockers: [
        {
          code: 'attempt_not_transferable',
          detail:
            'work#1 is accepted and cannot be carried over by a successor.',
          next_action: 'Resolve it.',
        },
      ],
      warnings: [
        { code: 'dispatch_frozen', detail: 'frozen', next_action: 'release' },
      ],
    };
    const result = await withReconcileGuidance(
      check,
      join(fixture.root, 'no-such-task'),
    );
    assert.deepEqual(result['reconcile'], []);
    assert.deepEqual(result['blockers'], check.blockers);
    assert.equal(result['status'], 'blocked');
    assert.deepEqual(
      (result['warnings'] as { code: string }[]).map((item) => item.code),
      ['dispatch_frozen', 'reconcile_guidance_unavailable'],
    );
    // Nothing blocking means nothing to read and nothing to add.
    const quiet = await withReconcileGuidance(
      { ...check, attempts: [], blockers: [] },
      join(fixture.root, 'no-such-task'),
    );
    assert.deepEqual(quiet['reconcile'], []);
    assert.deepEqual(quiet['warnings'], check.warnings);
  } finally {
    fixture.cleanup();
  }
});

test('collab handoff check-mid-cohort prints and returns the guidance, read-only, and the boundary check is unchanged', async () => {
  const { fixture, taskRoot, ack } = await cohort('mid-actionable-cli');
  try {
    await ack(WRITER_A, 'writer-one');
    const before = snapshotTree(fixture.domainRoot);
    const json = await cli([
      'collab',
      'handoff',
      'check-mid-cohort',
      '--task-root',
      taskRoot,
      '--json',
    ]);
    assert.equal(json.code, 1, json.stdout);
    const value = JSON.parse(json.stdout) as Record<string, unknown>;
    assert.equal(value['status'], 'blocked');
    const [entry] = reconcileOf(value);
    assert.equal(entry!.subtask_id, 'writer-one');
    assert.equal(entry!.ack_message_id, 'ack-writer-one-1');
    assert.deepEqual(entry!.operator_fields, [
      'actor',
      'resolution',
      'resolution_evidence',
    ]);
    assert.deepEqual(
      [entry!.request.actor, entry!.request.resolution],
      [null, null],
    );

    const human = await cli([
      'collab',
      'handoff',
      'check-mid-cohort',
      '--task-root',
      taskRoot,
    ]);
    assert.equal(human.code, 1);
    assert.match(
      human.stdout,
      /blocker attempt_not_transferable: writer-one#1 is accepted/,
    );
    assert.match(
      human.stdout,
      new RegExp(
        `reconcile writer-one#1 \\(accepted, uncertainty ${entry!.uncertainty_id}, cite ACK ack-writer-one-1\\):`,
      ),
    );
    assert.match(
      human.stdout,
      /request: \{"schema":"pappra\/collaboration-recovery-request\/1","action":"reconcile"/,
    );
    assert.match(
      human.stdout,
      /fill in: actor, resolution, resolution_evidence \(null in the request, which is refused until they are set\)/,
    );
    assert.match(
      human.stdout,
      /"actor":null,"owner_epoch":1,"uncertainty_id":"[^"]+","resolution":null,"resolution_evidence":null\}/,
    );
    assert.match(
      human.stdout,
      /command: collab recovery reconcile --task-root '/,
    );
    assert.deepEqual(snapshotTree(fixture.domainRoot), before);

    // The boundary check never carries reconcile guidance.
    const boundary = await cli([
      'collab',
      'handoff',
      'check',
      '--task-root',
      taskRoot,
      '--json',
    ]);
    assert.equal(boundary.code, 1);
    assert.equal('reconcile' in (JSON.parse(boundary.stdout) as object), false);
  } finally {
    fixture.cleanup();
  }
});

test('the unedited reconcile request fails the strict recovery schema on exactly the operator fields, and the filled one has the schema key set', async () => {
  const { fixture, taskRoot, ack } = await cohort('mid-actionable-schema');
  try {
    await ack(WRITER_A, 'writer-one');
    const { guided } = await midCohort(taskRoot);
    const [entry] = reconcileOf(guided);
    // As emitted the document is refused, and only because of the fields the guidance names as
    // the operator's own: nothing else about it is wrong.
    const unedited = collaborationRecoveryRequestSchema.safeParse(
      entry!.request,
    );
    if (unedited.success)
      assert.fail('the unedited request must not pass validation');
    assert.deepEqual(
      [...new Set(unedited.error.issues.map((issue) => issue.path[0]))].sort(),
      [...entry!.operator_fields].sort(),
    );
    // Filled in, it passes, and its key set is the schema's: nothing unknown, nothing dropped.
    const parsed = collaborationRecoveryRequestSchema.safeParse({
      ...entry!.request,
      actor: 'coordinator',
      resolution: 'Worker pane is alive and answering.',
      resolution_evidence: `ACK ${entry!.ack_message_id}; pane observed alive`,
    });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.deepEqual(
      Object.keys(entry!.request).sort(),
      Object.keys(parsed.data).sort(),
    );
  } finally {
    fixture.cleanup();
  }
});

test('applying the unedited reconcile request is refused and records nothing; the filled one is applied', async () => {
  const { fixture, taskRoot, ack } = await cohort('mid-actionable-unedited');
  try {
    await ack(WRITER_A, 'writer-one');
    await ack(WRITER_B, 'writer-two');
    const { guided } = await midCohort(taskRoot);
    const entry = reconcileOf(guided).find(
      (item) => item.subtask_id === 'writer-one',
    )!;
    const file = join(fixture.root, 'reconcile-request.json');
    writeFileSync(file, JSON.stringify(entry.request));
    const reconcile = (...flags: string[]) =>
      cli([
        'collab',
        'recovery',
        'reconcile',
        '--task-root',
        taskRoot,
        '--request',
        file,
        ...flags,
        '--json',
      ]);
    const before = snapshotTree(fixture.domainRoot);

    // Plan and apply both refuse the copied document as an invalid request, naming every field.
    for (const flags of [[], ['--apply']]) {
      const refused = await reconcile(...flags);
      assert.equal(refused.code, 2, refused.stdout);
      const result = JSON.parse(refused.stdout) as {
        ok: boolean;
        status: string;
        code: string;
        message: string;
      };
      assert.equal(result.ok, false);
      assert.equal(result.status, 'invalid');
      assert.equal(result.code, 'invalid_request');
      for (const field of entry.operator_fields)
        assert.ok(
          result.message.includes(`${field}:invalid_type`),
          result.message,
        );
    }
    // Nothing was recorded: the uncertainty is open and the check still blocks, with the same guidance.
    assert.deepEqual(snapshotTree(fixture.domainRoot), before);
    assert.equal(
      await openUncertainty(taskRoot, 'writer-one'),
      entry.uncertainty_id,
    );
    const unchanged = await midCohort(taskRoot);
    assert.equal(unchanged.guided['status'], 'blocked');
    assert.deepEqual(
      reconcileOf(unchanged.guided).map((item) => item.subtask_id),
      ['writer-one', 'writer-two'],
    );

    // Once the operator states the fields, the same document is applied and attributed to them.
    writeFileSync(
      file,
      JSON.stringify({
        ...entry.request,
        actor: 'coordinator',
        resolution: 'Worker pane is alive and answering.',
        resolution_evidence: `ACK ${entry.ack_message_id}; pane observed alive`,
      }),
    );
    const applied = await reconcile('--apply');
    assert.equal(applied.code, 0, applied.stdout);
    assert.equal(JSON.parse(applied.stdout).status, 'applied');
    const opened = await openTaskStore(taskRoot);
    assert.ok(opened.ok);
    const resolved = opened.value.record.uncertainty.find(
      (item) => item.uncertainty_id === entry.uncertainty_id,
    )!;
    assert.equal(resolved.resolved_by, 'coordinator');
    assert.equal(resolved.resolution, 'Worker pane is alive and answering.');
    const done = await midCohort(taskRoot);
    assert.deepEqual(
      reconcileOf(done.guided).map((item) => item.subtask_id),
      ['writer-two'],
    );
  } finally {
    fixture.cleanup();
  }
});

test('guidance describes the state the check saw: an attempt that moved on since the verdict gets none', async () => {
  const { fixture, taskRoot, ack } = await cohort('mid-actionable-moved');
  try {
    // The verdict sees writer-one as assigned; the worker acknowledges afterwards.
    const stale = await readCoordinatorHandoffCheck(taskRoot, {
      mode: 'mid_cohort',
    });
    assert.ok(stale.ok);
    await ack(WRITER_A, 'writer-one');
    const result = await withReconcileGuidance(stale.value, taskRoot);
    assert.deepEqual(result['reconcile'], []);
    assert.deepEqual(result['blockers'], stale.value['blockers']);
    // A verdict taken now sees the acknowledgement and is guided.
    const fresh = await midCohort(taskRoot);
    assert.deepEqual(
      reconcileOf(fresh.guided).map((item) => item.subtask_id),
      ['writer-one'],
    );
  } finally {
    fixture.cleanup();
  }
});
