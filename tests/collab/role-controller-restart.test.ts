import assert from 'node:assert/strict';
import {
  assertControllerRestart,
  assertNativePaneStopReceipt,
  assertRoleAssignmentClaimAccess,
  assertNativeRoleAcceptance,
} from '../helpers/role-controller-restart-acceptance.js';
import test from 'node:test';

const contract = {
  assertControllerRestart,
  assertNativePaneStopReceipt,
  assertRoleAssignmentClaimAccess,
  assertNativeRoleAcceptance,
};

const limits = { max_rounds: 16, max_actions: 4, max_attempts: 1 };
const journalBeforeExit = {
  rounds: 2,
  reserved_actions: 3,
  events: 2,
  digest: 'sha256:before',
};
const journalAfterExit = {
  rounds: 3,
  reserved_actions: 3,
  events: 3,
  digest: 'sha256:after',
};

function controller(overrides: Record<string, unknown> = {}) {
  return {
    pid: 4201,
    process_started_at: 'Sat Oct 24 12:00:00 2026',
    started_at: '2026-10-24T12:00:00.000Z',
    task_root: '/private/tmp/task-a',
    request_file: '/private/tmp/task-a/request.json',
    journal_file: '/private/tmp/task-a/role-orchestration.json',
    limits,
    journal_before_exit: journalBeforeExit,
    journal_after_exit: journalAfterExit,
    journal_on_start: journalAfterExit,
    exit: {
      observed: true,
      code: null,
      signal: 'SIGKILL',
      requested_signal: 'SIGKILL',
      at: '2026-10-24T12:00:02.000Z',
    },
    ...overrides,
  };
}

test('accepts only a distinct, exited dispatcher restarted on the same durable scope', () => {
  const first = controller();
  const second = controller({
    pid: 4202,
    process_started_at: 'Sat Oct 24 12:00:03 2026',
    started_at: '2026-10-24T12:00:03.000Z',
    exit: { observed: false, at: null, signal: null },
  });
  assert.doesNotThrow(() => contract.assertControllerRestart(first, second));
});
test('rejects a graceful dispatcher signal exit when hard-kill proof is required', () => {
  const first = controller({
    exit: {
      observed: true,
      code: 143,
      signal: null,
      requested_signal: 'SIGTERM',
      at: '2026-10-24T12:00:02.000Z',
    },
  });
  const second = controller({
    pid: 4202,
    process_started_at: 'Sat Oct 24 12:00:03 2026',
    started_at: '2026-10-24T12:00:03.000Z',
    exit: { observed: false, code: null, at: null, signal: null },
  });
  assert.throws(
    () => contract.assertControllerRestart(first, second),
    /force-killed/,
  );
});

test('rejects coexistence, unobserved OS exit, and changed journal or action budget', () => {
  const first = controller();
  assert.throws(
    () =>
      contract.assertControllerRestart(first, controller({ pid: first.pid })),
    /distinct/,
  );
  assert.throws(
    () =>
      contract.assertControllerRestart(
        controller({
          exit: {
            observed: false,
            code: null,
            at: null,
            signal: 'SIGKILL',
            requested_signal: 'SIGKILL',
          },
        }),
        controller({ pid: 4202, started_at: '2026-10-24T12:00:03.000Z' }),
      ),
    /OS exit was not observed/,
  );
  assert.throws(() =>
    contract.assertControllerRestart(
      first,
      controller({
        pid: 4202,
        process_started_at: 'Sat Oct 24 12:00:03 2026',
        started_at: '2026-10-24T12:00:03.000Z',
        journal_file: '/private/tmp/other/journal.json',
      }),
    ),
  );
  assert.throws(() =>
    contract.assertControllerRestart(
      first,
      controller({
        pid: 4202,
        process_started_at: 'Sat Oct 24 12:00:03 2026',
        started_at: '2026-10-24T12:00:03.000Z',
        journal_on_start: { ...journalAfterExit, digest: 'sha256:reset' },
      }),
    ),
  );
  assert.throws(() =>
    contract.assertControllerRestart(
      first,
      controller({
        pid: 4202,
        process_started_at: 'Sat Oct 24 12:00:03 2026',
        started_at: '2026-10-24T12:00:03.000Z',
        limits: { ...limits, max_actions: 5 },
      }),
    ),
  );
});

test('rejects a prelaunch Assignment/claim access mismatch without mutating fixture state', () => {
  const assignment = {
    assignment_id: 'reviewer',
    attempt: 1,
    resources: [
      { path: '/workspace/review.txt', access: 'read', resource_epoch: 1 },
    ],
  };
  const claim = {
    subtask_id: 'reviewer',
    attempt: 1,
    path: '/workspace/review.txt',
    access: 'write',
    resource_epoch: 1,
    released_at: null,
  };
  assert.throws(
    () => contract.assertRoleAssignmentClaimAccess(assignment, [claim]),
    /access differ/,
  );
  assert.equal(
    contract.assertRoleAssignmentClaimAccess(assignment, [
      { ...claim, access: 'read' },
    ]),
    true,
  );
});

test('pane cleanup decisions are per-owner and accept only an owned idle disposal receipt fallback', () => {
  const unavailable = {
    safe_to_close_pane: true,
    pending_work_clear: true,
    runtime_disposed_after_stop: true,
    cleanup_basis: 'owned_disposal_journal_and_idle_shell_required',
  };
  const stopped = {
    safe_to_close_pane: true,
    pending_work_clear: true,
    runtime_disposed_after_stop: true,
    cleanup_basis: 'managed_stop_and_idle_snapshot',
  };
  assert.equal(contract.assertNativePaneStopReceipt(unavailable), true);
  assert.equal(contract.assertNativePaneStopReceipt(stopped), true);
  assert.throws(
    () =>
      contract.assertNativePaneStopReceipt({
        ...unavailable,
        pending_work_clear: false,
      }),
    /pending native work/,
  );
  assert.throws(
    () =>
      contract.assertNativePaneStopReceipt({
        ...unavailable,
        runtime_disposed_after_stop: false,
      }),
    /SDK disposal journal proof/,
  );
});

function nativeEvidence() {
  const actor = (
    name: string,
    started_at: string,
    ended_at: string,
    accepted_at: string,
  ) => ({
    name,
    provider: 'openrouter',
    model: 'openai/gpt-6-luna',
    registered_inputs: 1,
    native_agent_starts: 1,
    registered_report: true,
    coordinator_acceptance: true,
    started_at,
    ended_at,
    accepted_at,
  });
  return {
    aggregate: {
      outcome: 'accepted',
      accepted_nodes: ['planner', 'writer-a', 'writer-b', 'reviewer'],
    },
    actors: [
      actor(
        'planner',
        '2026-10-24T12:00:00.000Z',
        '2026-10-24T12:00:05.000Z',
        '2026-10-24T12:00:06.000Z',
      ),
      actor(
        'writer-a',
        '2026-10-24T12:00:07.000Z',
        '2026-10-24T12:00:20.000Z',
        '2026-10-24T12:00:21.000Z',
      ),
      actor(
        'writer-b',
        '2026-10-24T12:00:08.000Z',
        '2026-10-24T12:00:22.000Z',
        '2026-10-24T12:00:23.000Z',
      ),
      actor(
        'reviewer',
        '2026-10-24T12:00:24.000Z',
        '2026-10-24T12:00:29.000Z',
        '2026-10-24T12:00:30.000Z',
      ),
    ],
  };
}

test('requires registered single-input native roles, writer overlap, and accepted predecessors', () => {
  assert.doesNotThrow(() =>
    contract.assertNativeRoleAcceptance(nativeEvidence(), [
      'planner',
      'writer-a',
      'writer-b',
      'reviewer',
    ]),
  );
  const duplicateInput = nativeEvidence();
  duplicateInput.actors[1]!.registered_inputs = 2;
  assert.throws(
    () =>
      contract.assertNativeRoleAcceptance(duplicateInput, [
        'planner',
        'writer-a',
        'writer-b',
        'reviewer',
      ]),
    /one native input/,
  );
  const repeatedAgentRun = nativeEvidence();
  repeatedAgentRun.actors[2]!.native_agent_starts = 2;
  assert.throws(
    () =>
      contract.assertNativeRoleAcceptance(repeatedAgentRun, [
        'planner',
        'writer-a',
        'writer-b',
        'reviewer',
      ]),
    /one native agent run/,
  );
  const earlyReviewer = nativeEvidence();
  earlyReviewer.actors[3]!.started_at = '2026-10-24T12:00:22.000Z';
  assert.throws(
    () =>
      contract.assertNativeRoleAcceptance(earlyReviewer, [
        'planner',
        'writer-a',
        'writer-b',
        'reviewer',
      ]),
    /reviewer must start after both coordinator acceptances/,
  );
});
