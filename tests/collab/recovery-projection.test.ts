import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { claimResources, releaseClaim } from '../../src/collab/resources.js';
import { messagesDir, readRecord } from '../../src/collab/store.js';
import { WORK_PLAN_SCHEMA } from '../../src/collab/work-plan.js';
import type {
  Identity,
  Message,
  MessageInput,
  TaskRecord,
} from '../../src/collab/types.js';
import {
  anchorTaskNamespace,
  inspectRecoveryProjection,
  verifyTaskNamespace,
  type RecoveryAction,
  type RecoveryProjection,
  type RecoveryProjectionResult,
} from '../../src/app/collab-recovery-projection.js';
import { makeTaskDomain } from './task-resources-fixtures.js';

const TASK = 'sample';
const PLAN_ID = 'plan-recovery';
const INPUT = `sha256:${'1'.repeat(64)}`;
const INPUT_OTHER = `sha256:${'2'.repeat(64)}`;
const COORDINATOR: Identity = {
  agent_id: 'coordinator',
  session_id: 'coord-session',
  harness: 'pi',
};
const WRITER_A: Identity = {
  agent_id: 'writer-a',
  session_id: 'writer-a-session',
  harness: 'pi',
};
const WRITER_B: Identity = {
  agent_id: 'writer-b',
  session_id: 'writer-b-session',
  harness: 'pi',
};

interface Flow {
  readonly root: string;
  readonly task: string;
  send(input: MessageInput): Message;
  nextId(prefix: string): string;
  record(): TaskRecord;
  planFile(value: unknown): string;
  cleanup(): void;
}

function makeFlow(label: string): Flow {
  const domain = makeTaskDomain(label, [TASK]);
  const task = domain.tasks[TASK]!;
  let clock = Date.parse('2026-10-20T00:00:00Z');
  let counter = 0;
  const tick = (): number => (clock += 1000);
  return {
    root: domain.root,
    task,
    nextId: (p) => `${p}-${(counter += 1)}`,
    send: (input) => {
      const message = buildMessage(input, { clock: tick() });
      const outcome = submitMessage(task, message, { clock: tick() });
      assert.equal(
        outcome.ok,
        true,
        `submit ${input.type}: ${JSON.stringify(outcome)}`,
      );
      return message;
    },
    record: () => {
      const r = readRecord(task);
      assert.ok(r, 'record missing');
      return r;
    },
    planFile: (value) => {
      const file = join(domain.root, 'plan.json');
      writeFileSync(file, `${JSON.stringify(value)}\n`);
      return file;
    },
    cleanup: domain.cleanup,
  };
}

function ok(result: RecoveryProjectionResult): RecoveryProjection {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}
function act(
  result: RecoveryProjectionResult,
  kind: string,
): RecoveryAction | undefined {
  return ok(result).actions.find((a) => a.kind === kind);
}

function node(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    node_id: id,
    role: 'writer',
    assignment_id: id,
    attempt: 1,
    input_revision: INPUT,
    assignee: { agent_id: WRITER_A.agent_id, session_id: WRITER_A.session_id },
    depends_on: [],
    resources: [],
    ...overrides,
  };
}
function planOf(nodes: Record<string, unknown>[]): unknown {
  return {
    schema: WORK_PLAN_SCHEMA,
    plan_id: PLAN_ID,
    task_id: TASK,
    owner_epoch: 1,
    nodes,
  };
}
function assign(
  flow: Flow,
  subtask: string,
  attempt = 1,
  writer: Identity = WRITER_A,
  approval?: { approved_by: string; reason: string },
): Message {
  return flow.send({
    message_id: `msg-assign-${subtask}-${attempt}`,
    type: 'ASSIGN',
    task_id: TASK,
    from: COORDINATOR,
    to: writer,
    subtask_id: subtask,
    attempt,
    owner_epoch: 1,
    body: {
      assignment_digest: `sha256:${'a'.repeat(64)}`,
      input_revision: INPUT,
      ...(approval === undefined ? {} : { approval }),
    },
  });
}
function report(
  flow: Flow,
  subtask: string,
  attempt = 1,
  writer: Identity = WRITER_A,
): Message {
  return flow.send({
    message_id: `msg-report-${subtask}-${attempt}`,
    type: 'REPORT',
    task_id: TASK,
    from: writer,
    to: COORDINATOR,
    subtask_id: subtask,
    attempt,
    body: { status: 'completed', input_revision: INPUT },
  });
}
function accept(
  flow: Flow,
  subtask: string,
  reported: Message,
  attempt = 1,
  writer: Identity = WRITER_A,
): Message {
  return flow.send({
    message_id: flow.nextId(`msg-accept-${subtask}`),
    type: 'ANSWER',
    task_id: TASK,
    from: COORDINATOR,
    to: writer,
    reply_to: reported.message_id,
    subtask_id: subtask,
    attempt,
    owner_epoch: 1,
    body: {
      acceptance: {
        plan_id: PLAN_ID,
        node_id: subtask,
        assignment_id: subtask,
        attempt,
        input_revision: INPUT,
        report_message_id: reported.message_id,
        report_digest: reported.content_digest,
        decision: 'accepted',
      },
    },
  });
}
function answer(
  flow: Flow,
  subtask: string,
  over: {
    from?: Identity;
    to?: Identity;
    attempt?: number;
    owner_epoch?: number;
    input_revision?: string;
  } = {},
): Message {
  return flow.send({
    message_id: flow.nextId(`msg-answer-${subtask}`),
    type: 'ANSWER',
    task_id: TASK,
    from: over.from ?? COORDINATOR,
    to: over.to ?? WRITER_A,
    reply_to: `msg-assign-${subtask}-1`,
    subtask_id: subtask,
    attempt: over.attempt ?? 1,
    owner_epoch: over.owner_epoch ?? 1,
    body: { input_revision: over.input_revision ?? INPUT, note: 'continue' },
  });
}
function treeHash(root: string): string {
  const h = createHash('sha256');
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else
        h.update(
          `${p}\u0000${createHash('sha256').update(readFileSync(p)).digest('hex')}\n`,
        );
    }
  };
  walk(root);
  return h.digest('hex');
}

test('running attempt with no answer -> resume_work (complete coverage)', async () => {
  const flow = makeFlow('recovery-resume');
  try {
    assign(flow, 'work');
    const planFile = flow.planFile(planOf([node('work')]));
    const r = await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: WRITER_A,
      policy: { role: 'writer' },
    });
    const a = act(r, 'resume_work');
    assert.ok(a && a.status === 'pending', JSON.stringify(r));
    assert.equal(ok(r).coverage, 'complete');
  } finally {
    flow.cleanup();
  }
});

test('a correlated coordinator ANSWER -> answer_supersedes_wait with a registered-digest key', async () => {
  const flow = makeFlow('recovery-answer');
  try {
    assign(flow, 'work');
    const ans = answer(flow, 'work');
    const planFile = flow.planFile(planOf([node('work')]));
    const r = await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: WRITER_A,
      policy: { role: 'writer' },
    });
    const a = act(r, 'answer_supersedes_wait');
    assert.ok(a, JSON.stringify(r));
    assert.ok(a.key.includes(ans.message_id), 'key carries the answer id');
    assert.ok(
      a.key.includes(ans.content_digest ?? 'X'),
      'key carries the registered digest',
    );
  } finally {
    flow.cleanup();
  }
});

// Finding 4: the latest valid corrective ANSWER wins, not the oldest.
test('finding4 two valid coordinator ANSWERs -> the newest is selected', async () => {
  const flow = makeFlow('recovery-newest-answer');
  try {
    assign(flow, 'work');
    const first = answer(flow, 'work');
    const newest = answer(flow, 'work');
    const planFile = flow.planFile(planOf([node('work')]));
    const r = await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: WRITER_A,
      policy: { role: 'writer' },
    });
    const a = act(r, 'answer_supersedes_wait');
    assert.ok(a, JSON.stringify(r));
    assert.ok(a.key.includes(newest.message_id), 'newest answer selected');
    assert.ok(!a.key.includes(first.message_id), 'oldest answer not selected');
  } finally {
    flow.cleanup();
  }
});

test('wrong sender / input / epoch / recipient ANSWER never continues -> resume_work', async () => {
  const variants: {
    label: string;
    over: {
      from?: Identity;
      to?: Identity;
      owner_epoch?: number;
      input_revision?: string;
    };
  }[] = [
    { label: 'sender', over: { from: WRITER_B } },
    { label: 'input', over: { input_revision: INPUT_OTHER } },
    { label: 'epoch', over: { owner_epoch: 2 } },
    { label: 'recipient', over: { to: WRITER_B } },
  ];
  for (const { label, over } of variants) {
    const flow = makeFlow(`recovery-wrong-${label}`);
    try {
      assign(flow, 'work');
      if (label === 'sender') {
        const forged = buildMessage({
          message_id: flow.nextId('forged-answer'),
          type: 'ANSWER',
          task_id: TASK,
          from: WRITER_B,
          to: WRITER_A,
          reply_to: 'msg-assign-work-1',
          subtask_id: 'work',
          attempt: 1,
          owner_epoch: 1,
          body: { input_revision: INPUT, note: 'continue' },
        });
        const refused = submitMessage(flow.task, forged);
        assert.equal(refused.ok, false);
        assert.equal(refused.reason, 'unauthorized_sender');
        assert.equal(
          flow
            .record()
            .messages.some((entry) => entry.message_id === forged.message_id),
          false,
        );
      } else {
        answer(flow, 'work', over);
      }
      const planFile = flow.planFile(planOf([node('work')]));
      const r = await inspectRecoveryProjection({
        taskRoot: flow.task,
        planFile,
        self: WRITER_A,
        policy: { role: 'writer' },
      });
      assert.equal(
        act(r, 'answer_supersedes_wait'),
        undefined,
        `${label} must not continue`,
      );
      assert.ok(act(r, 'resume_work'), `${label} -> resume_work`);
    } finally {
      flow.cleanup();
    }
  }
});

// Finding 1: neither a writer nor a reviewer self receives coordinator review-dispatch work.
test('finding1 writer and reviewer roles never receive progress_report_to_review', async () => {
  for (const role of ['writer', 'reviewer'] as const) {
    const flow = makeFlow(`recovery-role-${role}`);
    try {
      assign(flow, 'work');
      report(flow, 'work');
      const planFile = flow.planFile(planOf([node('work')]));
      const r = await inspectRecoveryProjection({
        taskRoot: flow.task,
        planFile,
        self: WRITER_A,
        policy: { role },
      });
      assert.equal(
        act(r, 'progress_report_to_review'),
        undefined,
        `${role} must not get review work`,
      );
      assert.equal(ok(r).coordinator_verified, false);
    } finally {
      flow.cleanup();
    }
  }
});

test('a non-coordinator self declaring coordinator receives no review action', async () => {
  const flow = makeFlow('recovery-foreign-coord');
  try {
    assign(flow, 'work');
    report(flow, 'work');
    const planFile = flow.planFile(planOf([node('work')]));
    const r = await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: WRITER_A,
      policy: { role: 'coordinator' },
    });
    assert.equal(act(r, 'progress_report_to_review'), undefined);
    assert.equal(ok(r).coordinator_verified, false);
  } finally {
    flow.cleanup();
  }
});

test('the current coordinator with a registered applied report -> progress_report_to_review', async () => {
  const flow = makeFlow('recovery-review');
  try {
    assign(flow, 'work');
    const rep = report(flow, 'work');
    const coord = flow.record().coordinator as Identity;
    const planFile = flow.planFile(planOf([node('work')]));
    const r = await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: coord,
      policy: { role: 'coordinator' },
    });
    const a = act(r, 'progress_report_to_review');
    assert.ok(a, JSON.stringify(r));
    assert.ok(a.key.includes(rep.message_id));
    assert.ok(a.key.includes(rep.content_digest ?? 'X'));
  } finally {
    flow.cleanup();
  }
});

// Finding 3: full report correlation; a tampered registry entry (wrong owner) is not admitted.
test('finding3 a report whose registry owner does not match the attempt owner -> report_unadmitted', async () => {
  const flow = makeFlow('recovery-report-mismatch');
  try {
    assign(flow, 'work');
    report(flow, 'work');
    const coord = flow.record().coordinator as Identity;
    // Tamper only the registry entry's sender (owner); a digest/id match must not confer authority.
    const file = join(flow.task, 'task.json');
    const rec = JSON.parse(readFileSync(file, 'utf8')) as TaskRecord & {
      messages: { type: string; from: Identity }[];
    };
    for (const m of rec.messages) if (m.type === 'REPORT') m.from = WRITER_B;
    writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
    const planFile = flow.planFile(planOf([node('work')]));
    const r = await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: coord,
      policy: { role: 'coordinator' },
    });
    assert.equal(
      act(r, 'progress_report_to_review'),
      undefined,
      'wrong owner must not be promoted',
    );
    assert.ok(act(r, 'report_unadmitted'), 'wrong owner -> report_unadmitted');
  } finally {
    flow.cleanup();
  }
});

test('a superseded report is never promoted to review', async () => {
  const flow = makeFlow('recovery-superseded');
  try {
    assign(flow, 'work', 1);
    report(flow, 'work', 1);
    assign(flow, 'work', 2, WRITER_A, {
      approved_by: 'coordinator',
      reason: 'retry',
    });
    const coord = flow.record().coordinator as Identity;
    const planFile = flow.planFile(planOf([node('work', { attempt: 1 })]));
    const r = await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: coord,
      policy: { role: 'coordinator' },
    });
    assert.equal(
      act(r, 'progress_report_to_review'),
      undefined,
      'superseded report not promoted',
    );
  } finally {
    flow.cleanup();
  }
});

test('a genuinely coordinator-accepted node -> verified_completion, never resumed', async () => {
  const flow = makeFlow('recovery-accepted');
  try {
    assign(flow, 'work');
    const rep = report(flow, 'work');
    accept(flow, 'work', rep);
    const planFile = flow.planFile(planOf([node('work')]));
    const r = await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: WRITER_A,
      policy: { role: 'writer' },
    });
    const a = act(r, 'verified_completion');
    assert.ok(a && a.status === 'complete', JSON.stringify(r));
    assert.equal(act(r, 'resume_work'), undefined);
  } finally {
    flow.cleanup();
  }
});

// Finding 6: a released-then-reacquired resource (a valid current held grant) does not block recovery.
test('finding6 a released-then-regranted claim does not veto a valid current grant -> resume_work', async () => {
  const flow = makeFlow('recovery-regrant');
  try {
    assign(flow, 'work');
    const first = claimResources(flow.task, {
      resources: [{ kind: 'path', path: join(flow.root, 'work-a') }],
      holder: WRITER_A,
      subtaskId: 'work',
      attempt: 1,
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    const released = releaseClaim(flow.task, {
      claimId: first.ok ? first.claims[0]!.claim_id : '',
      holder: WRITER_A,
      reason: 'handoff',
    });
    assert.equal(released.ok, true, JSON.stringify(released));
    const regrant = claimResources(flow.task, {
      resources: [{ kind: 'path', path: join(flow.root, 'work-a') }],
      holder: WRITER_A,
      subtaskId: 'work',
      attempt: 1,
    });
    assert.equal(regrant.ok, true, JSON.stringify(regrant));
    const planFile = flow.planFile(planOf([node('work')]));
    const r = await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: WRITER_A,
      policy: { role: 'writer' },
    });
    assert.equal(
      act(r, 'blocked_awaiting_gate'),
      undefined,
      'historical release must not gate a valid current grant',
    );
    assert.ok(act(r, 'resume_work'), 'current grant -> resume_work');
  } finally {
    flow.cleanup();
  }
});

// Finding 5: expected record failures are structured refusals, not thrown promises.
test('finding5 a corrupt task.json -> structured refusal (no thrown promise)', async () => {
  const flow = makeFlow('recovery-corrupt-record');
  try {
    assign(flow, 'work');
    const planFile = flow.planFile(planOf([node('work')]));
    writeFileSync(join(flow.task, 'task.json'), '{ this is not valid json');
    const r = await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: WRITER_A,
      policy: { role: 'writer' },
    });
    assert.equal(r.ok, false, JSON.stringify(r));
    if (!r.ok) assert.equal(r.reason, 'record_unreadable');
  } finally {
    flow.cleanup();
  }
});

// Finding 2: a record mutation during the inspection makes recommendations non-actionable.
test('finding2 a record change during inspection -> incomplete, non-actionable', async () => {
  const flow = makeFlow('recovery-mutation');
  try {
    assign(flow, 'work');
    answer(flow, 'work');
    const planFile = flow.planFile(planOf([node('work')]));
    const pending = inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: WRITER_A,
      policy: { role: 'writer' },
    });
    // The synchronous prefix captured the initial snapshot; mutate before the awaited continuation re-reads.
    answer(flow, 'work');
    const r = await pending;
    assert.equal(ok(r).coverage, 'incomplete', JSON.stringify(r));
    assert.ok(
      ok(r).actions.every((a) => a.status !== 'pending'),
      'no pending actionable after a detected change',
    );
  } finally {
    flow.cleanup();
  }
});

test('a missing plan file -> incomplete coverage, non-actionable', async () => {
  const flow = makeFlow('recovery-missing-plan');
  try {
    assign(flow, 'work');
    const r = await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile: join(flow.root, 'absent-plan.json'),
      self: WRITER_A,
      policy: { role: 'writer' },
    });
    assert.equal(ok(r).coverage, 'incomplete');
    assert.ok(
      ok(r).actions.every((a) => a.status !== 'pending'),
      'no pending actionable from incomplete evidence',
    );
  } finally {
    flow.cleanup();
  }
});

test('inspection leaves the task tree byte-for-byte unchanged (zero writes)', async () => {
  const flow = makeFlow('recovery-zero-writes');
  try {
    assign(flow, 'work');
    const rep = report(flow, 'work');
    accept(flow, 'work', rep);
    const planFile = flow.planFile(planOf([node('work')]));
    const before = treeHash(flow.root);
    await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: WRITER_A,
      policy: { role: 'writer' },
    });
    await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: flow.record().coordinator as Identity,
      policy: { role: 'coordinator' },
    });
    assert.equal(
      treeHash(flow.root),
      before,
      'inspection must not write anything',
    );
  } finally {
    flow.cleanup();
  }
});

test('the projection is deterministic for an unchanged snapshot', async () => {
  const flow = makeFlow('recovery-deterministic');
  try {
    assign(flow, 'work');
    answer(flow, 'work');
    const planFile = flow.planFile(planOf([node('work')]));
    const a = await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: WRITER_A,
      policy: { role: 'writer' },
    });
    const b = await inspectRecoveryProjection({
      taskRoot: flow.task,
      planFile,
      self: WRITER_A,
      policy: { role: 'writer' },
    });
    assert.deepEqual(a, b);
  } finally {
    flow.cleanup();
  }
});

// Direction item 2: final messages-directory / task-root redirect cases for the namespace anchor.
test('a symlinked task root makes the namespace anchor unavailable and coverage incomplete', async () => {
  const flow = makeFlow('recovery-ns-symlink');
  try {
    assign(flow, 'work');
    const planFile = flow.planFile(planOf([node('work')]));
    const link = join(flow.root, 'task-link');
    symlinkSync(flow.task, link, 'dir');
    assert.equal(
      anchorTaskNamespace(link),
      null,
      'symlinked root -> null anchor',
    );
    const r = await inspectRecoveryProjection({
      taskRoot: link,
      planFile,
      self: WRITER_A,
      policy: { role: 'writer' },
    });
    assert.equal(ok(r).coverage, 'incomplete', JSON.stringify(r));
    assert.ok(
      ok(r).notes.some((n) => n.includes('namespace')),
      'a namespace note is present',
    );
  } finally {
    flow.cleanup();
  }
});

test('a replaced messages directory or task-root inode is detected as a namespace redirect', () => {
  const flow = makeFlow('recovery-ns-redirect');
  try {
    assign(flow, 'work');
    const anchor = anchorTaskNamespace(flow.task);
    assert.ok(anchor, 'anchor captured');
    assert.equal(
      verifyTaskNamespace(anchor),
      true,
      'stable namespace verifies',
    );

    // Same-revision replacement: swap the messages directory for a fresh inode.
    const messages = messagesDir(flow.task);
    const moved = `${messages}.moved`;
    renameSync(messages, moved);
    mkdirSync(messages, { recursive: true });
    assert.equal(
      verifyTaskNamespace(anchor),
      false,
      'a replaced messages directory is a redirect',
    );
    rmSync(messages, { recursive: true, force: true });
    renameSync(moved, messages);
    assert.equal(
      verifyTaskNamespace(anchor),
      true,
      'restored namespace verifies',
    );

    // Task-root redirect: replace the task root directory inode at the same path.
    const parkedRoot = `${flow.task}.parked`;
    renameSync(flow.task, parkedRoot);
    mkdirSync(flow.task, { recursive: true });
    assert.equal(
      verifyTaskNamespace(anchor),
      false,
      'a replaced task root is a redirect',
    );
    rmSync(flow.task, { recursive: true, force: true });
    renameSync(parkedRoot, flow.task);
  } finally {
    flow.cleanup();
  }
});
