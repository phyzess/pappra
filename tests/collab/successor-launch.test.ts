import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  runSuccessorLaunch,
  type CodexDiscovery,
  type SuccessorLaunchDependencies,
} from '../../src/app/collab-successor/launch.js';
import type {
  HerdrResult,
  SuccessorHerdrOps,
} from '../../src/app/collab-successor/herdr.js';
import {
  claudeSessionIdFor,
  successorRequestSchema,
} from '../../src/app/collab-successor/types.js';
import { beginHandoff, findHandoff } from '../../src/collab/handoff.js';
import { claimResources } from '../../src/collab/resources.js';
import { readRecord, transact } from '../../src/collab/store.js';
import { makeTaskDomain } from './task-resources-fixtures.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const COORD = {
  agent_id: 'coord',
  session_id: 'coord-session-1',
  harness: 'claude',
};
const CHECKPOINT = 'Briefing: finished cohort A; next cohort B.\n';
const digestOf = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;

interface Fixture {
  root: string;
  taskRoot: string;
  cleanup: () => void;
  checkpointFile: string;
  write: (name: string, value: unknown) => string;
}

function fixture(harness: 'claude' | 'codex' = 'claude'): Fixture {
  const domain = makeTaskDomain('succ-launch', ['cohort'], {
    coordinators: { cohort: { ...COORD, harness } },
  });
  const taskRoot = domain.tasks['cohort']!;
  const begun = transact(taskRoot, {
    actor: 'fixture',
    purpose: 'begin',
    apply: (record) => {
      const result = beginHandoff(record, {
        handoffId: 'h1',
        kind: 'coordinator',
        from: { ...COORD, harness },
        to: { agent_id: 'succ', session_id: 'pending-req1', harness },
        ownerEpoch: 1,
      });
      if (!result.ok) return result;
      return { record, op: 'begin', summary: {}, result };
    },
  });
  assert.ok(begun.ok, JSON.stringify(begun));
  const checkpointFile = join(domain.root, 'checkpoint.txt');
  writeFileSync(checkpointFile, CHECKPOINT);
  return {
    root: domain.root,
    taskRoot,
    cleanup: domain.cleanup,
    checkpointFile,
    write: (name, value) => {
      const file = join(domain.root, name);
      writeFileSync(file, JSON.stringify(value));
      return file;
    },
  };
}

const requestFor = (
  f: Fixture,
  overrides: Record<string, unknown> = {},
  harness: 'claude' | 'codex' = 'claude',
) => ({
  schema: 'pappra/collab-successor-request/1',
  request_id: 'req1',
  task_root: f.taskRoot,
  handoff_id: 'h1',
  harness,
  agent_name: 'succ',
  cwd: f.root,
  caller_pane: 'w1:p1',
  direction: 'right',
  checkpoint: { file: f.checkpointFile, digest: digestOf(CHECKPOINT) },
  ...overrides,
});

type Behaviour = {
  paneCwd?: string | null;
  paneSession?: string | null;
  nameTaken?: boolean;
  split?: HerdrResult<{ paneId: string }>;
  start?: HerdrResult<never> | 'ok';
  /** First N getAgent calls report the TUI as not yet interactive. */
  notReadyCalls?: number;
  /** First N getAgent calls report no session id yet (Herdr learns it from a hook). */
  sessionNullCalls?: number;
  /** `blocked` simulates an approval or trust dialog. */
  status?: string;
  prompt?: HerdrResult<never> | 'ok';
  agentSession?: (requested: string | null) => string | null;
  /** The prompt is typed but never starts a turn. */
  promptIgnored?: boolean;
  /** The agent found in the split pane carries another name. */
  agentName?: string;
  /** `agent start` is refused as agent_pane_busy this many times first (shell not ready). */
  busyStarts?: number;
  /** Every start attempt fails with this definite error code instead. */
  startErrorCode?: string;
};

function fakeHerdr(f: Fixture, behaviour: Behaviour = {}) {
  const calls: string[] = [];
  let startedSession: string | null = null;
  let prompted: string | null = null;
  let promptTarget: string | null = null;
  let agentCalls = 0;
  let startAttempts = 0;
  let seq = 10;
  let working = false;
  const ops: SuccessorHerdrOps = {
    async paneGet(paneId) {
      calls.push(`paneGet:${paneId}`);
      return {
        ok: true,
        value: {
          paneId,
          cwd: behaviour.paneCwd === undefined ? f.root : behaviour.paneCwd,
          agentName: null,
          sessionValue:
            behaviour.paneSession === undefined
              ? COORD.session_id
              : behaviour.paneSession,
        },
      };
    },
    async agentExists(name) {
      calls.push(`agentExists:${name}`);
      return { ok: true, value: behaviour.nameTaken === true };
    },
    async splitPane(input) {
      calls.push(`split:${input.paneId}:${input.direction}`);
      return behaviour.split ?? { ok: true, value: { paneId: 'w1:p9' } };
    },
    async startAgent(input) {
      calls.push(`start:${input.kind}:${input.args.join(' ')}`);
      startedSession =
        input.args[0] === '--session-id' ? (input.args[1] ?? null) : null;
      if (behaviour.startErrorCode !== undefined)
        return {
          ok: false,
          code: behaviour.startErrorCode,
          detail: 'refused',
          unknown: false,
        };
      if (startAttempts < (behaviour.busyStarts ?? 0)) {
        startAttempts += 1;
        return {
          ok: false,
          code: 'agent_pane_busy',
          detail: 'pane is not an available shell',
          unknown: false,
        };
      }
      if (behaviour.start !== undefined && behaviour.start !== 'ok')
        return behaviour.start;
      return {
        ok: true,
        value: {
          name: input.name,
          paneId: input.paneId,
          status: 'idle',
          cwd: f.root,
          sessionValue: null,
          interactiveReady: false,
          stateChangeSeq: seq,
        },
      };
    },
    async getAgent(name) {
      agentCalls += 1;
      calls.push(`getAgent:${name}`);
      const session =
        behaviour.agentSession !== undefined
          ? behaviour.agentSession(startedSession)
          : agentCalls <= (behaviour.sessionNullCalls ?? 0)
            ? null
            : startedSession;
      return {
        ok: true,
        value: {
          name: behaviour.agentName ?? 'succ',
          paneId: 'w1:p9',
          status: working ? 'working' : (behaviour.status ?? 'idle'),
          cwd: f.root,
          sessionValue: session,
          interactiveReady: agentCalls > (behaviour.notReadyCalls ?? 0),
          stateChangeSeq: seq,
        },
      };
    },
    async promptAgent(target, text) {
      calls.push('prompt');
      promptTarget = target;
      prompted = text;
      if (behaviour.prompt !== undefined && behaviour.prompt !== 'ok')
        return behaviour.prompt;
      if (behaviour.promptIgnored !== true) {
        working = true;
        seq += 1;
      }
      return { ok: true, value: { status: 'working' } };
    },
  };
  return {
    ops,
    calls,
    prompted: () => prompted,
    promptTarget: () => promptTarget,
  };
}

const deps = (
  herdr: SuccessorHerdrOps,
  extra: Partial<SuccessorLaunchDependencies> = {},
): SuccessorLaunchDependencies => ({
  herdr,
  cliPath: THIS_FILE,
  sleep: async () => undefined,
  readyTimeoutMs: 200,
  deliveryTimeoutMs: 20,
  identityPollMs: 1,
  ...extra,
});

const effects = (calls: string[]) =>
  calls.filter((c) => /^(split|start|prompt)/.test(c));

test('plan is read-only and shows the exact fixed seed', async () => {
  const f = fixture();
  try {
    const { ops, calls } = fakeHerdr(f);
    const plan = await runSuccessorLaunch(
      f.write('r.json', requestFor(f)),
      { apply: false },
      deps(ops),
    );
    assert.equal(plan.status, 'planned', JSON.stringify(plan.blockers));
    assert.deepEqual(effects(calls), []);
    assert.match(
      plan.seed ?? '',
      /collab handoff ack --task-root .* --request req1 --apply/,
    );
    assert.match(plan.seed ?? '', /HANDOFF-ACKED h1/);
    assert.equal(plan.seed_digest, digestOf(plan.seed ?? ''));
    assert.equal(
      existsSync(join(f.taskRoot, 'successor')),
      false,
      'a plan writes nothing',
    );
  } finally {
    f.cleanup();
  }
});

test('plan blocks for every unmet precondition and names each one', async () => {
  const cases: [
    string,
    (f: Fixture) => Promise<unknown> | unknown,
    Behaviour,
    Record<string, unknown>,
    string,
  ][] = [
    [
      'harness mismatch',
      () => undefined,
      {},
      { harness: 'codex' },
      'harness_mismatch',
    ],
    [
      'unknown handoff',
      () => undefined,
      {},
      { handoff_id: 'nope' },
      'handoff_not_found',
    ],
    [
      'receiver name',
      () => undefined,
      {},
      { agent_name: 'other' },
      'receiver_name_mismatch',
    ],
    ['cwd', () => undefined, { paneCwd: '/elsewhere' }, {}, 'cwd_mismatch'],
    [
      'pane session',
      () => undefined,
      { paneSession: 'someone-else' },
      {},
      'caller_pane_not_coordinator',
    ],
    [
      'name taken',
      () => undefined,
      { nameTaken: true },
      {},
      'agent_name_in_use',
    ],
    [
      'checkpoint digest',
      () => undefined,
      {},
      { checkpoint: { file: '__F__', digest: digestOf('different') } },
      'checkpoint_digest_mismatch',
    ],
  ];
  for (const [label, , behaviour, overrides, code] of cases) {
    const f = fixture();
    try {
      const patched = JSON.parse(
        JSON.stringify(overrides).replaceAll('__F__', f.checkpointFile),
      );
      const { ops, calls } = fakeHerdr(f, behaviour);
      const run = await runSuccessorLaunch(
        f.write('r.json', requestFor(f, patched)),
        { apply: true },
        deps(ops),
      );
      assert.equal(run.status, 'blocked', label);
      assert.ok(
        run.blockers.some((b) => b.code === code),
        `${label}: ${JSON.stringify(run.blockers)}`,
      );
      assert.deepEqual(
        effects(calls),
        [],
        `${label}: a blocked launch has no effect`,
      );
      assert.equal(
        existsSync(join(f.taskRoot, 'successor')),
        false,
        `${label}: no journal`,
      );
    } finally {
      f.cleanup();
    }
  }
});

test('a handoff check blocker (work in flight) blocks the launch', async () => {
  const f = fixture();
  try {
    const claimed = claimResources(f.taskRoot, {
      resources: [{ kind: 'path', path: join(f.root, 'work') }],
      holder: { agent_id: 'w', session_id: 'ws', harness: 'pi' },
    });
    assert.ok(claimed.ok);
    const { ops } = fakeHerdr(f);
    const run = await runSuccessorLaunch(
      f.write('r.json', requestFor(f)),
      { apply: false },
      deps(ops),
    );
    assert.equal(run.status, 'blocked');
    assert.ok(run.blockers.some((b) => b.code === 'check_claims_unreleased'));
  } finally {
    f.cleanup();
  }
});

test('claude launch journals first, pre-assigns the session id, delivers the exact seed and binds the handoff', async () => {
  const f = fixture();
  try {
    const { ops, calls, prompted } = fakeHerdr(f);
    const run = await runSuccessorLaunch(
      f.write('r.json', requestFor(f)),
      { apply: true },
      deps(ops),
    );
    assert.equal(run.status, 'launched', JSON.stringify(run));
    assert.equal(run.ok, true);
    const session = claudeSessionIdFor({
      taskId: 'cohort',
      handoffId: 'h1',
      requestId: 'req1',
    });
    assert.deepEqual(effects(calls), [
      'split:w1:p1:right',
      `start:claude:--session-id ${session}`,
      'prompt',
    ]);
    assert.equal(
      prompted(),
      run.seed,
      'the delivered text is exactly the planned seed',
    );
    assert.equal(run.identity?.session_id, session);
    assert.equal(run.evidence?.kind, 'herdr-agent-session');
    const files = readdirSync(join(f.taskRoot, 'successor')).sort();
    assert.deepEqual(files, [
      'req1.intent.json',
      'req1.outcome.json',
      'req1.request.json',
      'req1.step-prompt.json',
      'req1.step-split.json',
      'req1.step-start.json',
    ]);
    const entry = findHandoff(readRecord(f.taskRoot)!, 'h1')!;
    assert.equal(entry.state, 'transferring');
    assert.equal(
      entry.to.session_id,
      session,
      'the observed identity was rebound',
    );
    assert.deepEqual(run.handoff, { rebound: true, transferred: true });
    assert.ok(run.next_steps.some((s) => /handoff-ack-req1/.test(s)));
    assert.ok(run.limits.includes('old_session_not_stopped_or_observed'));
  } finally {
    f.cleanup();
  }
});

test('a repeated request returns the recorded outcome and repeats nothing', async () => {
  const f = fixture();
  try {
    const file = f.write('r.json', requestFor(f));
    const first = fakeHerdr(f);
    await runSuccessorLaunch(file, { apply: true }, deps(first.ops));
    const second = fakeHerdr(f);
    const again = await runSuccessorLaunch(
      file,
      { apply: true },
      deps(second.ops),
    );
    assert.equal(again.status, 'already_recorded');
    assert.deepEqual(effects(second.calls), []);
    const conflict = await runSuccessorLaunch(
      f.write('r2.json', requestFor(f, { direction: 'down' })),
      { apply: true },
      deps(second.ops),
    );
    assert.equal(conflict.status, 'blocked');
    assert.equal(conflict.blockers[0]?.code, 'request_conflict');
  } finally {
    f.cleanup();
  }
});

test('an unknown effect is never replayed: the next run needs reconciliation', async () => {
  const f = fixture();
  try {
    const file = f.write('r.json', requestFor(f));
    const timeout: HerdrResult<never> = {
      ok: false,
      code: 'herdr_timeout',
      detail: 'timed out',
      unknown: true,
    };
    const first = fakeHerdr(f, { prompt: timeout });
    const run = await runSuccessorLaunch(
      file,
      { apply: true },
      deps(first.ops),
    );
    assert.equal(run.status, 'reconcile_required');
    assert.equal(
      existsSync(join(f.taskRoot, 'successor', 'req1.outcome.json')),
      false,
    );
    const second = fakeHerdr(f);
    const again = await runSuccessorLaunch(
      file,
      { apply: true },
      deps(second.ops),
    );
    assert.equal(again.status, 'reconcile_required');
    assert.deepEqual(effects(second.calls), [], 'nothing was repeated');
    assert.ok(again.steps.some((s) => s.step === 'prompt'));
  } finally {
    f.cleanup();
  }
});

test('a definite failure stops the launch and still blocks a silent retry', async () => {
  const f = fixture();
  try {
    const file = f.write('r.json', requestFor(f));
    const refused: HerdrResult<{ paneId: string }> = {
      ok: false,
      code: 'pane_not_found',
      detail: 'no such pane',
      unknown: false,
    };
    const first = fakeHerdr(f, { split: refused });
    const run = await runSuccessorLaunch(
      file,
      { apply: true },
      deps(first.ops),
    );
    assert.equal(run.status, 'failed');
    assert.deepEqual(effects(first.calls), ['split:w1:p1:right']);
    const again = await runSuccessorLaunch(
      file,
      { apply: true },
      deps(fakeHerdr(f).ops),
    );
    assert.equal(again.status, 'reconcile_required');
  } finally {
    f.cleanup();
  }
});

test('an approval or trust dialog is reported and never answered or prompted over', async () => {
  const f = fixture();
  try {
    const { ops, calls } = fakeHerdr(f, { status: 'blocked' });
    const run = await runSuccessorLaunch(
      f.write('r.json', requestFor(f)),
      { apply: true },
      deps(ops),
    );
    assert.equal(run.status, 'identity_unavailable');
    assert.ok(
      !calls.includes('prompt'),
      'no seed is typed into a blocked session',
    );
    assert.match(run.warnings.join(' '), /does not answer it/);
    assert.equal(
      findHandoff(readRecord(f.taskRoot)!, 'h1')!.state,
      'requested',
      'the handoff is untouched',
    );
  } finally {
    f.cleanup();
  }
});

test('claude identity must match the pre-assigned session or nothing is bound', async () => {
  const f = fixture();
  try {
    const { ops } = fakeHerdr(f, {
      agentSession: () => 'not-what-we-assigned',
    });
    const run = await runSuccessorLaunch(
      f.write('r.json', requestFor(f)),
      { apply: true },
      deps(ops),
    );
    assert.equal(run.status, 'identity_unavailable');
    assert.equal(run.identity, null);
    assert.equal(
      findHandoff(readRecord(f.taskRoot)!, 'h1')!.to.session_id,
      'pending-req1',
    );
  } finally {
    f.cleanup();
  }
});

test('codex identity comes from exactly one daemon thread that has the seed as its preview', async () => {
  const f = fixture('codex');
  try {
    const seen: { cwd: string; preview: string; createdAfter: number }[] = [];
    const found: CodexDiscovery = {
      state: 'found',
      threadId: '01a17c31-7484-7000-8000-000000000001',
      createdAt: 1793084978,
    };
    const { ops, calls, prompted } = fakeHerdr(f);
    const run = await runSuccessorLaunch(
      f.write('r.json', requestFor(f, {}, 'codex')),
      { apply: true },
      deps(ops, {
        discoverCodex: async (criteria) => (seen.push(criteria), found),
      }),
    );
    assert.equal(run.status, 'launched', JSON.stringify(run));
    assert.equal(run.identity?.session_id, found.threadId);
    assert.equal(run.evidence?.kind, 'codex-daemon-thread');
    assert.ok(calls.includes('start:codex:'), 'codex gets no argv seed');
    assert.equal(
      seen[0]?.preview,
      prompted(),
      'discovery matches the exact delivered seed',
    );
    assert.equal(seen[0]?.cwd, f.root);
    assert.equal(
      findHandoff(readRecord(f.taskRoot)!, 'h1')!.to.session_id,
      found.threadId,
    );
  } finally {
    f.cleanup();
  }
});

test('codex discovery that is ambiguous, absent or unavailable never guesses', async () => {
  for (const [label, discovery] of [
    [
      'ambiguous',
      { state: 'ambiguous', threadIds: ['a', 'b'] } as CodexDiscovery,
    ],
    ['not_found', { state: 'not_found' } as CodexDiscovery],
    [
      'unavailable',
      {
        state: 'unavailable',
        reason: 'timeout',
        detail: null,
      } as CodexDiscovery,
    ],
  ] as const) {
    const f = fixture('codex');
    try {
      const { ops } = fakeHerdr(f);
      const run = await runSuccessorLaunch(
        f.write('r.json', requestFor(f, {}, 'codex')),
        { apply: true },
        deps(ops, {
          discoverCodex: async () => discovery,
          identityTimeoutMs: 5,
          identityPollMs: 1,
        }),
      );
      assert.equal(run.status, 'identity_unavailable', label);
      assert.equal(run.identity, null, label);
      assert.equal(
        findHandoff(readRecord(f.taskRoot)!, 'h1')!.state,
        'requested',
        label,
      );
    } finally {
      f.cleanup();
    }
  }
});

test('a codex launch without a discovery implementation reports it instead of guessing', async () => {
  const f = fixture('codex');
  try {
    const { ops } = fakeHerdr(f);
    const run = await runSuccessorLaunch(
      f.write('r.json', requestFor(f, {}, 'codex')),
      { apply: true },
      deps(ops),
    );
    assert.equal(run.status, 'identity_unavailable');
    assert.match(run.warnings.join(' '), /No Codex thread discovery/);
  } finally {
    f.cleanup();
  }
});

test('an invalid request is refused before anything is read or done', async () => {
  const f = fixture();
  try {
    const { ops, calls } = fakeHerdr(f);
    for (const bad of [
      { ...requestFor(f), extra: 1 },
      requestFor(f, { harness: 'pi' }),
      requestFor(f, { agent_name: 'Bad Name' }),
      requestFor(f, { caller_pane: 'nope' }),
      requestFor(f, { checkpoint: { file: 'relative', digest: 'x' } }),
    ]) {
      const run = await runSuccessorLaunch(
        f.write('r.json', bad),
        { apply: true },
        deps(ops),
      );
      assert.equal(run.status, 'invalid');
    }
    assert.equal(
      (await runSuccessorLaunch('relative.json', { apply: true }, deps(ops)))
        .status,
      'invalid',
    );
    assert.deepEqual(calls, []);
  } finally {
    f.cleanup();
  }
});

test('the seed is typed only once the session accepts input and its id has appeared', async () => {
  const f = fixture();
  try {
    const { ops, calls } = fakeHerdr(f, {
      notReadyCalls: 3,
      sessionNullCalls: 5,
    });
    const run = await runSuccessorLaunch(
      f.write('r.json', requestFor(f)),
      { apply: true },
      deps(ops),
    );
    assert.equal(run.status, 'launched', JSON.stringify(run));
    const promptAt = calls.indexOf('prompt');
    const agentCallsBefore = calls
      .slice(0, promptAt)
      .filter((c) => c.startsWith('getAgent')).length;
    assert.ok(
      agentCallsBefore >= 6,
      `waited for readiness and the session id (${String(agentCallsBefore)} polls)`,
    );
    assert.deepEqual(run.warnings, []);
  } finally {
    f.cleanup();
  }
});

test('a session that never becomes ready gets no seed and no handoff change', async () => {
  const f = fixture();
  try {
    const { ops, calls } = fakeHerdr(f, { notReadyCalls: 1_000_000 });
    const run = await runSuccessorLaunch(
      f.write('r.json', requestFor(f)),
      { apply: true },
      deps(ops),
    );
    assert.equal(run.status, 'identity_unavailable');
    assert.ok(!calls.includes('prompt'));
    assert.match(run.warnings.join(' '), /did not become ready/);
    assert.equal(
      findHandoff(readRecord(f.taskRoot)!, 'h1')!.state,
      'requested',
    );
  } finally {
    f.cleanup();
  }
});

test('a seed that did not start a turn is reported and never typed again', async () => {
  const f = fixture();
  try {
    const { ops, calls } = fakeHerdr(f, { promptIgnored: true });
    const run = await runSuccessorLaunch(
      f.write('r.json', requestFor(f)),
      { apply: true },
      deps(ops),
    );
    assert.equal(run.status, 'launched');
    assert.equal(
      calls.filter((c) => c === 'prompt').length,
      1,
      'exactly one delivery attempt',
    );
    assert.match(run.warnings.join(' '), /did not start a turn/);
    assert.match(run.warnings.join(' '), /not sent again/);
  } finally {
    f.cleanup();
  }
});

test('the pre-assigned Claude session is unique per task and handoff, not just per request id', () => {
  const a = claudeSessionIdFor({
    taskId: 'taskA',
    handoffId: 'h1',
    requestId: 'req1',
  });
  const b = claudeSessionIdFor({
    taskId: 'taskB',
    handoffId: 'h1',
    requestId: 'req1',
  });
  const c = claudeSessionIdFor({
    taskId: 'taskA',
    handoffId: 'h2',
    requestId: 'req1',
  });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(
    a,
    claudeSessionIdFor({ taskId: 'taskA', handoffId: 'h1', requestId: 'req1' }),
    'still deterministic',
  );
  assert.match(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('the seed and the readiness polls address the agent by the pane Pappra split, never by a reusable name', async () => {
  const f = fixture();
  try {
    const { ops, calls, promptTarget } = fakeHerdr(f);
    const run = await runSuccessorLaunch(
      f.write('r.json', requestFor(f)),
      { apply: true },
      deps(ops),
    );
    assert.equal(run.status, 'launched');
    assert.equal(promptTarget(), 'w1:p9');
    assert.ok(
      calls
        .filter((c) => c.startsWith('getAgent:'))
        .every((c) => c === 'getAgent:w1:p9'),
    );
  } finally {
    f.cleanup();
  }
});

test('an agent in the split pane with another name never receives the seed', async () => {
  const f = fixture();
  try {
    const { ops, calls } = fakeHerdr(f, { agentName: 'someone-else' });
    const run = await runSuccessorLaunch(
      f.write('r.json', requestFor(f)),
      { apply: true },
      deps(ops),
    );
    assert.equal(run.status, 'identity_unavailable');
    assert.ok(!calls.includes('prompt'));
    assert.match(run.warnings.join(' '), /is named someone-else/);
  } finally {
    f.cleanup();
  }
});

test('a pane cwd that is the same directory through a symlink is accepted', async () => {
  const f = fixture();
  try {
    const link = join(f.root, '..', `${f.root.split('/').pop()}-link`);
    symlinkSync(f.root, link);
    try {
      const { ops } = fakeHerdr(f);
      const plan = await runSuccessorLaunch(
        f.write('r.json', requestFor(f, { cwd: link })),
        { apply: false },
        deps(ops),
      );
      assert.equal(plan.status, 'planned', JSON.stringify(plan.blockers));
    } finally {
      rmSync(link);
    }
  } finally {
    f.cleanup();
  }
});

test('codex discovery asks for threads from the launch second itself, with no tolerance', async () => {
  const f = fixture('codex');
  try {
    const seen: { createdAfter: number }[] = [];
    const fixed = new Date('2026-10-27T08:00:00.900Z');
    const { ops } = fakeHerdr(f);
    await runSuccessorLaunch(
      f.write('r.json', requestFor(f, {}, 'codex')),
      { apply: true },
      deps(ops, {
        now: () => fixed,
        discoverCodex: async (criteria) => (
          seen.push(criteria),
          {
            state: 'found',
            threadId: 't-1',
            createdAt: Math.floor(fixed.getTime() / 1000),
          } as CodexDiscovery
        ),
      }),
    );
    assert.equal(seen[0]?.createdAfter, Math.floor(fixed.getTime() / 1000));
  } finally {
    f.cleanup();
  }
});

test('a recorded identity_unavailable outcome is reported as a failure, with how to recover', async () => {
  const f = fixture();
  try {
    const file = f.write('r.json', requestFor(f));
    await runSuccessorLaunch(
      file,
      { apply: true },
      deps(fakeHerdr(f, { status: 'blocked' }).ops),
    );
    const second = fakeHerdr(f);
    const again = await runSuccessorLaunch(
      file,
      { apply: true },
      deps(second.ops),
    );
    assert.equal(again.status, 'identity_unavailable');
    assert.equal(
      again.ok,
      false,
      'a script that checks the result must see a failure',
    );
    assert.deepEqual(effects(second.calls), []);
    assert.match(
      again.warnings.join(' '),
      /close that pane, then use a new request_id/,
    );
  } finally {
    f.cleanup();
  }
});

test('a crash after the outcome but before the bind is finished on the next run, without repeating the launch', async () => {
  const f = fixture();
  try {
    const file = f.write('r.json', requestFor(f));
    await runSuccessorLaunch(file, { apply: true }, deps(fakeHerdr(f).ops));
    // Put the handoff back to what a crash between the outcome and the rebind would leave.
    const reverted = transact(f.taskRoot, {
      actor: 'fixture',
      purpose: 'simulate-crash-before-bind',
      apply: (record) => {
        const entry = findHandoff(record, 'h1')!;
        entry.state = 'requested';
        entry.to = {
          agent_id: 'succ',
          session_id: 'pending-req1',
          harness: 'claude',
        };
        return { record, op: 'revert', summary: {}, result: { ok: true } };
      },
    });
    assert.ok(reverted.ok);
    const second = fakeHerdr(f);
    const again = await runSuccessorLaunch(
      file,
      { apply: true },
      deps(second.ops),
    );
    assert.equal(again.status, 'already_recorded');
    assert.equal(again.ok, true, JSON.stringify(again.blockers));
    assert.deepEqual(again.handoff, { rebound: true, transferred: true });
    assert.deepEqual(effects(second.calls), [], 'no native effect is repeated');
    assert.equal(
      findHandoff(readRecord(f.taskRoot)!, 'h1')!.state,
      'transferring',
    );
    assert.ok(again.next_steps.length > 0);
    // And a third run changes nothing.
    const third = await runSuccessorLaunch(
      file,
      { apply: true },
      deps(fakeHerdr(f).ops),
    );
    assert.deepEqual(third.handoff, { rebound: true, transferred: true });
  } finally {
    f.cleanup();
  }
});

function intentFor(f: Fixture, requestId = 'req1') {
  const parsed = successorRequestSchema.parse(
    requestFor(f, { request_id: requestId }),
  );
  return { parsed };
}

test('an intent left by an interrupted run, with no native step, does not need a new request id', async () => {
  const f = fixture();
  try {
    const file = f.write('r.json', requestFor(f));
    const { ops } = fakeHerdr(f);
    const plan = await runSuccessorLaunch(file, { apply: false }, deps(ops));
    const { parsed } = intentFor(f);
    const dir = join(f.taskRoot, 'successor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'req1.request.json'),
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
    const doc = {
      schema: 'pappra/collab-successor-intent/1',
      request_id: 'req1',
      request_digest: digestOf(JSON.stringify(parsed)),
      recorded_at: '2026-10-27T00:00:00.000Z',
      harness: 'claude',
      agent_name: 'succ',
      cwd: f.root,
      handoff_id: 'h1',
      claude_session_id: claudeSessionIdFor({
        taskId: 'cohort',
        handoffId: 'h1',
        requestId: 'req1',
      }),
      seed: plan.seed,
      seed_digest: plan.seed_digest,
      checkpoint: parsed.checkpoint,
    };
    writeFileSync(
      join(dir, 'req1.intent.json'),
      `${JSON.stringify(doc, null, 2)}\n`,
    );
    const run = await runSuccessorLaunch(
      file,
      { apply: true },
      deps(fakeHerdr(f).ops),
    );
    assert.equal(run.status, 'launched', JSON.stringify(run.blockers));
    assert.match(run.warnings.join(' '), /interrupted earlier run/);

    // An intent that differs in substance is a conflict, not something to continue from.
    const g = fixture();
    try {
      const gdir = join(g.taskRoot, 'successor');
      mkdirSync(gdir, { recursive: true });
      const gp = intentFor(g).parsed;
      writeFileSync(
        join(gdir, 'req1.request.json'),
        `${JSON.stringify(gp, null, 2)}\n`,
      );
      writeFileSync(
        join(gdir, 'req1.intent.json'),
        `${JSON.stringify({ ...doc, request_digest: digestOf('other'), cwd: g.root, seed: 'other', seed_digest: digestOf('other'), checkpoint: gp.checkpoint }, null, 2)}\n`,
      );
      const refused = await runSuccessorLaunch(
        g.write('r.json', requestFor(g)),
        { apply: true },
        deps(fakeHerdr(g).ops),
      );
      assert.equal(refused.status, 'blocked');
      assert.equal(refused.blockers[0]?.code, 'request_conflict');
    } finally {
      g.cleanup();
    }
  } finally {
    f.cleanup();
  }
});

test('two concurrent applies of one request cannot both launch', async () => {
  const f = fixture();
  try {
    const file = f.write('r.json', requestFor(f));
    const one = fakeHerdr(f);
    const two = fakeHerdr(f);
    const clock = () => new Date('2026-10-27T08:00:00.000Z');
    const [a, b] = await Promise.all([
      runSuccessorLaunch(file, { apply: true }, deps(one.ops, { now: clock })),
      runSuccessorLaunch(file, { apply: true }, deps(two.ops, { now: clock })),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, ['launched', 'reconcile_required']);
    const splits = [...effects(one.calls), ...effects(two.calls)].filter((c) =>
      c.startsWith('split'),
    );
    assert.equal(splits.length, 1, 'exactly one pane was split');
    assert.equal(
      [...one.calls, ...two.calls].filter((c) => c === 'prompt').length,
      1,
      'exactly one seed was typed',
    );
  } finally {
    f.cleanup();
  }
});

test('a pane whose shell is not ready yet is retried, because that refusal started nothing', async () => {
  const f = fixture();
  try {
    const { ops, calls } = fakeHerdr(f, { busyStarts: 3 });
    const run = await runSuccessorLaunch(
      f.write('r.json', requestFor(f)),
      { apply: true },
      deps(ops),
    );
    assert.equal(run.status, 'launched', JSON.stringify(run.blockers));
    assert.equal(
      calls.filter((c) => c.startsWith('start:')).length,
      4,
      'three refusals then one start',
    );
    assert.equal(
      calls.filter((c) => c.startsWith('split')).length,
      1,
      'the pane is split once',
    );
  } finally {
    f.cleanup();
  }
});

test('a shell that never becomes available gives up after the bound, and other refusals are never retried', async () => {
  const f = fixture();
  try {
    const { ops, calls } = fakeHerdr(f, { busyStarts: 1_000_000 });
    const run = await runSuccessorLaunch(
      f.write('r.json', requestFor(f)),
      { apply: true },
      deps(ops, { startRetries: 3 }),
    );
    assert.equal(run.status, 'failed');
    assert.equal(run.blockers[0]?.code, 'start_failed');
    assert.equal(
      calls.filter((c) => c.startsWith('start:')).length,
      4,
      'one try plus the three retries',
    );
    assert.ok(!calls.includes('prompt'));
  } finally {
    f.cleanup();
  }
  const g = fixture();
  try {
    const { ops, calls } = fakeHerdr(g, {
      startErrorCode: 'invalid_agent_argument',
    });
    const run = await runSuccessorLaunch(
      g.write('r.json', requestFor(g)),
      { apply: true },
      deps(ops),
    );
    assert.equal(run.status, 'failed');
    assert.equal(
      calls.filter((c) => c.startsWith('start:')).length,
      1,
      'a different refusal is not retried',
    );
  } finally {
    g.cleanup();
  }
});
