import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reclaimOwnedPanes } from '../../src/app/collab-pane-reclaim.js';
import { readRecord, transact } from '../../src/collab/store.js';
import type { LaunchReservation } from '../../src/collab/types.js';
import { applyPrepare } from '../../src/app/collab-workflow/prepare.js';
import { applyParticipant } from '../../src/app/collab-workflow/participant.js';
import { applyAccept } from '../../src/app/collab-workflow/acceptance.js';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import type { notifyRegisteredMessage } from '../../src/app/collab-notify.js';
import type { WorkflowParticipantRequest } from '../../src/schemas/collab-workflow.js';
import type { WorkflowPrepareRequest } from '../../src/schemas/collab-workflow.js';

const clock = Date.parse('2026-10-25T12:00:00Z');
const coordinator = {
  agent_id: 'fixture-coordinator',
  session_id: 'fixture-coordinator-session',
  harness: 'codex',
};
const worker = {
  agent_id: 'fixture-worker',
  session_id: 'fixture-worker-session',
  harness: 'pi',
};
const PANE = 'w1:p2';

type Ops = NonNullable<Parameters<typeof reclaimOwnedPanes>[0]['ops']>;

function reservation(
  id: string,
  cwd: string | null,
  reclaim?: Record<string, unknown>,
): LaunchReservation {
  return {
    reservation_id: id,
    subtask_id: 'write',
    attempt: 1,
    kind: 'bootstrap',
    mode: 'visible',
    holder: worker,
    requested_session_id: null,
    reserved_at: 'now',
    released_at: 'now',
    outcome: 'submitted',
    bootstrap: {
      phase: 'completed',
      created_pane_id: PANE,
      created_workspace_id: 'w1',
      created_terminal_id: 't2',
      ...(cwd === null ? {} : { created_cwd: cwd }),
      ...(reclaim === undefined ? {} : { reclaim }),
    },
  } as LaunchReservation;
}

async function fixture(
  opts: {
    accepted?: boolean;
    released?: boolean;
    rejected?: boolean;
    cwd?: boolean;
    sibling?: Record<string, unknown>;
  } = {},
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pane-reclaim-')));
  const taskRoot = path.join(root, 'tasks', 'reclaim-fixture');
  const request: WorkflowPrepareRequest = {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: root,
    task_id: 'reclaim-fixture',
    goal: { objective: 'Reclaim fixture', input_ref: null, input_digest: null },
    coordinator: {
      ...coordinator,
      cwd: root,
      surface: 'cli',
      configuration_id: 'fixture',
      owner_epoch: 1,
    },
    participants: [
      { ...worker, cwd: root, surface: 'cli', configuration_id: 'fixture' },
    ],
    bindings: [],
    assignments: [
      {
        subtask_id: 'write',
        role: 'writer',
        assignee: worker.agent_id,
        objective: 'Fixture writes',
        acceptance: ['Done'],
        resources: [
          { path: path.join(root, 'out.txt'), access: 'write', scope: 'file' },
        ],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ],
    runner: { name: 'fixture', mode: 'fixture' },
  };
  assert.equal((await applyPrepare(request, { clock })).ok, true);
  const notify: typeof notifyRegisteredMessage = async () => ({
    ok: false,
    code: 'fixture_no_native_delivery',
    message: 'No native transport in fixture',
    retryable: false,
    nextAction: null,
  });
  const participant = (
    action: 'ack' | 'report' | 'release',
  ): WorkflowParticipantRequest => ({
    schema: 'pappra/collab-workflow-participant-request/1',
    action,
    task_root: taskRoot,
    caller: { ...worker, cwd: root },
    subtask_id: 'write',
    attempt: 1,
    caller_pane: null,
    report:
      action === 'report'
        ? { status: 'completed', summary: 'done', blockers: [], outputs: [] }
        : null,
    release:
      action === 'release'
        ? { reason: 'finished', cancel_attempt: false, correlates_to: null }
        : null,
  });
  for (const action of ['ack', 'report'] as const)
    assert.equal(
      (await applyParticipant(participant(action), { clock, notify })).ok,
      true,
      action,
    );
  const report = readRecord(taskRoot)!.messages.find(
    (m) => m.type === 'REPORT',
  )!;
  const acceptRequest = {
    schema: 'pappra/collab-workflow-accept-request/1' as const,
    task_root: taskRoot,
    caller: { ...coordinator, cwd: root },
    subtask_id: 'write',
    attempt: 1,
    report_message_id: report.message_id,
    caller_pane: null,
    reason: 'fixture accepts',
  };
  if (opts.rejected === true) {
    const message = buildMessage({
      type: 'ANSWER',
      task_id: 'reclaim-fixture',
      from: coordinator,
      to: worker,
      reply_to: report.message_id,
      message_id: 'accept-write-1',
      subtask_id: 'write',
      attempt: 1,
      owner_epoch: 1,
      body: {
        status: 'completed',
        reason: 'no',
        acceptance: {
          assignment_id: 'write',
          attempt: 1,
          decision: 'rejected',
        },
      },
    });
    assert.equal(submitMessage(taskRoot, message, { clock }).ok, true);
  } else if (opts.accepted !== false)
    assert.equal(
      (await applyAccept(acceptRequest, { clock, notify })).ok,
      true,
    );
  if (opts.released !== false)
    assert.equal(
      (await applyParticipant(participant('release'), { clock, notify })).ok,
      true,
    );
  const done = transact<null>(taskRoot, {
    actor: coordinator.agent_id,
    purpose: 'fixture',
    clock,
    apply: (record) => {
      record.launch_reservations = [
        reservation('res-1', opts.cwd === false ? null : root),
        ...(opts.sibling === undefined
          ? []
          : [reservation('res-2', root, opts.sibling)]),
      ];
      return { record, op: 'fixture', summary: {}, result: null };
    },
  });
  assert.equal(done.ok, true, JSON.stringify(done));
  const closed: string[] = [];
  const ops = (
    over: Partial<Record<string, unknown>> = {},
    caller: { ok: boolean; paneId?: string } = { ok: true, paneId: 'w1:p9' },
  ): Ops =>
    ({
      paneGet: async () => ({
        ok: true,
        value: {
          paneId: PANE,
          workspaceId: 'w1',
          terminalId: 't2',
          tabId: 'tab',
          cwd: root,
          foregroundCwd: root,
          agent: 'worker',
          agentStatus: 'idle',
          focused: false,
          revision: 1,
          ...over,
        },
      }),
      listAgents: async () => ({
        ok: true,
        agents: [
          {
            name: 'worker',
            harness: 'pi',
            paneId: PANE,
            cwd: root,
            sessionKind: 'id',
            sessionValue: worker.session_id,
            status: 'idle',
            focused: false,
          },
        ],
      }),
      paneProcessInfo: async () => ({ ok: false, code: 'unused' }),
      verifyCaller: async () =>
        caller.ok
          ? { ok: true, caller: { paneId: caller.paneId } }
          : { ok: false, status: 'unverified', code: 'caller_unverified' },
      closePane: async ({ paneId }: { paneId: string }) => {
        closed.push(paneId);
        return { ok: true, value: { paneId, closed: true } };
      },
    }) as unknown as Ops;
  return {
    root,
    taskRoot,
    closed,
    ops,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('closes the owned pane of an accepted, released worker once', async () => {
  const f = await fixture();
  try {
    const first = await reclaimOwnedPanes({
      taskRoot: f.taskRoot,
      clock,
      ops: f.ops(),
    });
    assert.deepEqual(
      first.map((e) => [e.state, e.code]),
      [['closed', null]],
    );
    assert.deepEqual(f.closed, [PANE]);
    const again = await reclaimOwnedPanes({
      taskRoot: f.taskRoot,
      clock,
      ops: f.ops(),
    });
    assert.equal(again[0]?.state, 'already_recorded');
    assert.deepEqual(f.closed, [PANE]);
    assert.ok(readRecord(f.taskRoot));
  } finally {
    f.cleanup();
  }
});

test('plan mode closes nothing', async () => {
  const f = await fixture();
  try {
    const plan = await reclaimOwnedPanes({
      taskRoot: f.taskRoot,
      apply: false,
      ops: f.ops(),
    });
    assert.equal(plan[0]?.state, 'planned');
    assert.deepEqual(f.closed, []);
  } finally {
    f.cleanup();
  }
});

test('keeps the pane until acceptance and claim release', async () => {
  const notAccepted = await fixture({ accepted: false });
  const notReleased = await fixture({ released: false });
  try {
    const a = await reclaimOwnedPanes({
      taskRoot: notAccepted.taskRoot,
      ops: notAccepted.ops(),
    });
    assert.equal(a[0]?.code, 'attempt_not_accepted');
    const r = await reclaimOwnedPanes({
      taskRoot: notReleased.taskRoot,
      ops: notReleased.ops(),
    });
    assert.equal(r[0]?.code, 'claims_not_released');
    assert.deepEqual([...notAccepted.closed, ...notReleased.closed], []);
  } finally {
    notAccepted.cleanup();
    notReleased.cleanup();
  }
});

test('live drift, busy agent and the caller pane are never closed', async () => {
  const f = await fixture();
  try {
    const cases: [Partial<Record<string, unknown>>, string, string | null][] = [
      [{ terminalId: 'other' }, 'owned_pane_identity_drift', null],
      [{ cwd: '/elsewhere' }, 'owned_pane_identity_drift', null],
      [{ agentStatus: 'working' }, 'agent_busy', null],
      [{}, 'pane_is_caller', PANE],
    ];
    for (const [over, code, caller] of cases) {
      const result = await reclaimOwnedPanes({
        taskRoot: f.taskRoot,
        ops: f.ops(over, { ok: true, paneId: caller ?? 'w1:p9' }),
      });
      assert.equal(result[0]?.code, code);
      assert.equal(result[0]?.state, 'skipped');
    }
    assert.deepEqual(f.closed, []);
  } finally {
    f.cleanup();
  }
});

test('workflow reclaim is refused for a non-coordinator and closes nothing', async () => {
  const { applyReclaim } =
    await import('../../src/app/collab-workflow/reclaim.js');
  const f = await fixture();
  try {
    const refused = await applyReclaim(
      {
        schema: 'pappra/collab-workflow-reclaim-request/1',
        task_root: f.taskRoot,
        caller: { ...worker, cwd: f.root },
        caller_pane: null,
      },
      { clock, ops: f.ops() },
    );
    assert.equal(refused.status, 'refused');
    assert.equal(refused.blockers[0]?.code, 'reclaim_not_coordinator');
    const ok = await applyReclaim(
      {
        schema: 'pappra/collab-workflow-reclaim-request/1',
        task_root: f.taskRoot,
        caller: { ...coordinator, cwd: f.root },
        caller_pane: null,
      },
      { clock, ops: f.ops() },
    );
    assert.equal(ok.status, 'applied');
    assert.deepEqual(f.closed, [PANE]);
  } finally {
    f.cleanup();
  }
});

test('a non-accepted or mismatched acceptance never closes the pane', async () => {
  const f = await fixture({ rejected: true });
  try {
    const result = await reclaimOwnedPanes({
      taskRoot: f.taskRoot,
      ops: f.ops(),
    });
    assert.equal(result[0]?.code, 'attempt_not_accepted');
    assert.deepEqual(f.closed, []);
  } finally {
    f.cleanup();
  }
});

test('an unverifiable caller keeps every pane; a self-declared pane cannot disable the guard', async () => {
  const f = await fixture();
  try {
    const unverified = await reclaimOwnedPanes({
      taskRoot: f.taskRoot,
      ops: f.ops({}, { ok: false }),
      callerPane: 'w1:p9',
    });
    assert.equal(unverified[0]?.code, 'caller_unverified');
    // The declared pane differs from the live caller (which owns the worker pane).
    const mismatch = await reclaimOwnedPanes({
      taskRoot: f.taskRoot,
      ops: f.ops({}, { ok: true, paneId: PANE }),
      callerPane: 'w1:p9',
    });
    assert.equal(mismatch[0]?.code, 'pane_is_caller');
    assert.deepEqual(f.closed, []);
  } finally {
    f.cleanup();
  }
});

test('concurrent sweeps close the pane once', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([
      reclaimOwnedPanes({ taskRoot: f.taskRoot, ops: f.ops() }),
      reclaimOwnedPanes({ taskRoot: f.taskRoot, ops: f.ops() }),
    ]);
    assert.equal(f.closed.length, 1, JSON.stringify([a, b]));
  } finally {
    f.cleanup();
  }
});

test('a definite close failure is retried, an ambiguous one is not', async () => {
  const f = await fixture();
  try {
    let fail = true;
    const base = f.ops();
    const ops = {
      ...base,
      closePane: async (input: { paneId: string }) =>
        fail
          ? { ok: false, status: 'failed', code: 'boom' }
          : base.closePane(input as never),
    } as unknown as Ops;
    const first = await reclaimOwnedPanes({ taskRoot: f.taskRoot, ops });
    assert.equal(first[0]?.state, 'close_failed');
    fail = false;
    const retry = await reclaimOwnedPanes({ taskRoot: f.taskRoot, ops });
    assert.equal(retry[0]?.state, 'closed');
    const unknown = await fixture();
    try {
      const ambiguous = {
        ...unknown.ops(),
        closePane: async () => ({ ok: false, status: 'unknown', code: 'late' }),
      } as unknown as Ops;
      const one = await reclaimOwnedPanes({
        taskRoot: unknown.taskRoot,
        ops: ambiguous,
      });
      assert.equal(one[0]?.state, 'unknown_not_closed');
      const two = await reclaimOwnedPanes({
        taskRoot: unknown.taskRoot,
        ops: unknown.ops(),
      });
      assert.equal(two[0]?.state, 'already_recorded');
      assert.deepEqual(unknown.closed, []);
    } finally {
      unknown.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test('a shared pane with an unresolved sibling close, or a pane without a recorded cwd, is kept', async () => {
  const shared = await fixture({ sibling: { state: 'close_pending' } });
  const noCwd = await fixture({ cwd: false });
  try {
    const a = await reclaimOwnedPanes({
      taskRoot: shared.taskRoot,
      ops: shared.ops(),
    });
    assert.equal(
      a.find((e) => e.reservation_id === 'res-1')?.code,
      'pane_close_pending_for_sibling',
    );
    const b = await reclaimOwnedPanes({
      taskRoot: noCwd.taskRoot,
      ops: noCwd.ops(),
    });
    assert.equal(b[0]?.code, 'owned_pane_cwd_not_recorded');
    assert.deepEqual([...shared.closed, ...noCwd.closed], []);
  } finally {
    shared.cleanup();
    noCwd.cleanup();
  }
});

/** Installs one completed coordinator handoff on disk, ending epoch 1 at `endedAt`. */
function succeed(taskRoot: string, endedAt: string): void {
  const done = transact<null>(taskRoot, {
    actor: 'fixture',
    purpose: 'succeed',
    clock,
    apply: (record) => {
      const before = {
        agent_id: coordinator.agent_id,
        session_id: coordinator.session_id,
        owner_epoch: 1,
      };
      const next = {
        agent_id: 'next-coordinator',
        session_id: 'next-session',
        harness: 'claude',
      };
      record.coordinator = {
        ...next,
        owner_epoch: 2,
        since: endedAt,
        previous: before,
      };
      record.handoffs = [
        ...record.handoffs,
        {
          schema: 'harness-collab/handoff/1',
          handoff_id: 'h1',
          kind: 'coordinator',
          subtask_id: null,
          attempt: null,
          from: coordinator,
          to: next,
          resources: [],
          ownership_snapshot: [],
          state: 'completed',
          owner_epoch: 2,
          created_at: endedAt,
          updated_at: endedAt,
          reason: null,
          steps: [{ state: 'completed', at: endedAt, actor: 'fixture' }],
          partial_outputs: [],
          inflight: [],
          pending_approvals: [],
          confirmation_message_id: null,
          previous_coordinator: {
            ...coordinator,
            ...before,
            since: '2026-10-25T00:00:00Z',
          },
        },
      ];
      return { record, op: 'succeed', summary: {}, result: null };
    },
  });
  assert.equal(done.ok, true, JSON.stringify(done));
}

test('a decision of the earlier coordinator still counts for reclaim after a succession', async () => {
  const f = await fixture();
  try {
    succeed(f.taskRoot, '2099-01-01T00:00:00Z');
    const result = await reclaimOwnedPanes({
      taskRoot: f.taskRoot,
      clock,
      ops: f.ops(),
    });
    assert.deepEqual(
      result.map((e) => [e.state, e.code]),
      [['closed', null]],
    );
  } finally {
    f.cleanup();
  }
});

test('a decision applied after its epoch ended never lets reclaim close a pane', async () => {
  const f = await fixture();
  try {
    succeed(f.taskRoot, '2000-01-01T00:00:00Z');
    const result = await reclaimOwnedPanes({
      taskRoot: f.taskRoot,
      clock,
      ops: f.ops(),
    });
    assert.notEqual(result[0]?.state, 'closed');
    assert.deepEqual(f.closed, []);
  } finally {
    f.cleanup();
  }
});
