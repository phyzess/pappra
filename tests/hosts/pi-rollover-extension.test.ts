import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_READ_TOOL_ALLOWLIST,
  PI_ROLLOVER_FREEZE_STATUS_SCHEMA,
  RolloverFreezeController,
  VETTED_NATIVE_READ_TOOLS,
  registerPiRolloverFreeze,
  type FreezeToken,
  type NativeObservation,
  type PiCommandOptions,
  type PiFreezeHost,
  type PiToolBlockDecision,
  type PiToolCallEvent,
} from '../../src/hosts/integration/pi-rollover-extension.js';

const SESSION = 'sess-A';

function token(overrides: Partial<FreezeToken> = {}): FreezeToken {
  return {
    sessionId: SESSION,
    taskId: 'workspace-experience',
    handoffId: 'ho-1',
    generation: 1,
    ...overrides,
  };
}

function obs(overrides: Partial<NativeObservation> = {}): NativeObservation {
  return {
    token: token(),
    sequence: 1,
    settled: true,
    queuedMessages: 0,
    inFlightTools: 0,
    pendingApprovals: 0,
    ...overrides,
  };
}

function bash(): PiToolCallEvent {
  return { toolName: 'bash', input: { command: 'echo hi' } };
}

interface MockPi {
  readonly pi: PiFreezeHost;
  readonly commands: Map<string, PiCommandOptions>;
  readonly notes: string[];
  invokeToolCall(
    event: PiToolCallEvent,
    contextSession?: string | null,
  ): Promise<PiToolBlockDecision | undefined>;
  runCommand(name: string, args: string, contextSession?: string | null): void;
}

function makeCtx(contextSession: string | null, notes: string[]): unknown {
  const base = { ui: { notify: (text: string) => notes.push(text) } };
  return contextSession === null
    ? base
    : { ...base, sessionManager: { getSessionId: () => contextSession } };
}

function mockPi(): MockPi {
  const commands = new Map<string, PiCommandOptions>();
  const notes: string[] = [];
  let handler:
    | ((
        event: PiToolCallEvent,
        context: unknown,
      ) => Promise<PiToolBlockDecision | undefined>)
    | null = null;
  const pi: PiFreezeHost = {
    on(event, h) {
      if (event === 'tool_call') handler = h;
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
  };
  return {
    pi,
    commands,
    notes,
    async invokeToolCall(event, contextSession = SESSION) {
      assert.ok(handler, 'tool_call handler must be registered');
      return handler(event, makeCtx(contextSession, notes));
    },
    runCommand(name, args, contextSession = SESSION) {
      const cmd = commands.get(name);
      assert.ok(cmd, `command ${name} must be registered`);
      void cmd.handler(args, makeCtx(contextSession, notes));
    },
  };
}

test('registers the barrier and only freeze/status commands (no thaw)', () => {
  const m = mockPi();
  const controller = registerPiRolloverFreeze(m.pi, { sessionId: SESSION });
  assert.ok(controller instanceof RolloverFreezeController);
  assert.deepEqual([...m.commands.keys()].sort(), [
    'rollover-freeze',
    'rollover-status',
  ]);
});

test('allows tools while unfrozen and blocks after freeze (interception)', async () => {
  const m = mockPi();
  const controller = registerPiRolloverFreeze(m.pi, { sessionId: SESSION });
  assert.equal(await m.invokeToolCall(bash()), undefined);
  assert.ok(controller.freeze(token()).ok);
  const decision = await m.invokeToolCall(bash());
  assert.equal(decision?.block, true);
});

test('freeze is latched before status reports frozen', () => {
  const controller = new RolloverFreezeController({ sessionId: SESSION });
  assert.equal(controller.status().frozen, false);
  assert.equal(controller.status().ready, false);
  assert.ok(controller.freeze(token()).ok);
  const status = controller.status();
  assert.equal(status.frozen, true);
  assert.equal(status.schema, PI_ROLLOVER_FREEZE_STATUS_SCHEMA);
  assert.equal(status.thawSupported, false);
  assert.equal(status.observationSource, 'caller-supplied-unauthenticated');
  assert.deepEqual(status.token, token());
});

// Defect 1: the read allowlist cannot select write-class or custom tools.
test('a configured allowlist can only select vetted native reads', () => {
  assert.deepEqual([...VETTED_NATIVE_READ_TOOLS], ['read']);
  assert.deepEqual([...DEFAULT_READ_TOOL_ALLOWLIST], ['read']);
  const controller = new RolloverFreezeController({
    sessionId: SESSION,
    readAllowlist: ['read', 'bash', 'write', 'edit', 'arbitrary-custom'],
  });
  controller.freeze(token());
  assert.equal(controller.decideToolCall('read', SESSION).block, false);
  for (const name of [
    'bash',
    'write',
    'edit',
    'arbitrary-custom',
    '',
    undefined,
  ]) {
    assert.equal(
      controller.decideToolCall(name, SESSION).block,
      true,
      `${String(name)} must block`,
    );
  }
});

// Defect 2: outward snapshots and tokens are defensive and cannot alter internal state.
test('mutating a status snapshot or a returned token cannot change the controller', () => {
  const controller = new RolloverFreezeController({ sessionId: SESSION });
  controller.freeze(token());
  const native = controller.status().native as unknown as Record<
    string,
    unknown
  >;
  try {
    native.settled = 'yes';
    native.queuedMessages = 0;
    native.inFlightTools = 0;
    native.pendingApprovals = 0;
  } catch {
    /* frozen snapshot: assignment throws in strict mode */
  }
  assert.equal(
    controller.status().ready,
    false,
    'snapshot mutation must not make it ready',
  );

  const outcome = controller.freeze(token());
  assert.ok(outcome.ok);
  try {
    (outcome.token as unknown as Record<string, unknown>).generation = 999;
  } catch {
    /* frozen token */
  }
  assert.equal(
    controller.status().token?.generation,
    1,
    'token mutation must not change the latch',
  );
});

// Defect 3: malformed observations are rejected and never change readiness.
test('malformed or wrong-token observations never become ready', () => {
  const controller = new RolloverFreezeController({ sessionId: SESSION });
  controller.freeze(token());
  assert.equal(
    controller.observe(obs({ settled: 'x' as unknown as boolean })).ok,
    false,
  );
  assert.equal(controller.observe(obs({ queuedMessages: -5 })).ok, false);
  assert.equal(controller.observe(obs({ inFlightTools: 1.5 })).ok, false);
  assert.equal(controller.observe(obs({ sequence: -1 })).ok, false);
  assert.equal(
    controller.observe(obs({ token: token({ taskId: 'other' }) })).ok,
    false,
  );
  assert.equal(
    controller.observe(obs({ token: token({ handoffId: 'ho-2' }) })).ok,
    false,
  );
  assert.equal(controller.status().ready, false);
  // A valid complete all-clear snapshot does make it ready.
  assert.ok(controller.observe(obs({ sequence: 1 })).ok);
  assert.equal(controller.status().ready, true);
});

// Defect 4: partial observations do not inherit a prior all-clear; activity invalidates readiness.
test('partial snapshots drop old facts and tool activity invalidates readiness', () => {
  const controller = new RolloverFreezeController({ sessionId: SESSION });
  controller.freeze(token());
  assert.ok(controller.observe(obs({ sequence: 1 })).ok);
  assert.equal(controller.status().ready, true);
  // seq2 with only settled -> missing counts become unknown, not inherited zero.
  assert.ok(
    controller.observe({ token: token(), sequence: 2, settled: true }).ok,
  );
  const partial = controller.status();
  assert.equal(partial.ready, false);
  assert.equal(partial.native.queuedMessages, 'unknown');
  // Re-assert a full all-clear.
  assert.ok(controller.observe(obs({ sequence: 3 })).ok);
  assert.equal(controller.status().ready, true);
  // Any tool activity (even an allowed read) invalidates the prior readiness.
  controller.decideToolCall('read', SESSION);
  assert.equal(controller.status().ready, false);
  assert.equal(controller.status().native.settled, 'unknown');
});

// Defect 5: the live context session is revalidated at callbacks and fails closed.
test('a wrong or missing context session fails closed and invalidates readiness', async () => {
  const m = mockPi();
  const controller = registerPiRolloverFreeze(m.pi, { sessionId: SESSION });
  controller.freeze(token());
  assert.ok(controller.observe(obs({ sequence: 1 })).ok);
  assert.equal(controller.status().ready, true);
  // A read from a different session is blocked (fail closed), not allowed.
  const foreign = await m.invokeToolCall(
    { toolName: 'read', input: {} },
    'sess-B',
  );
  assert.equal(foreign?.block, true);
  assert.equal(
    controller.status().ready,
    false,
    'session change invalidates readiness',
  );
  // A missing session (no sessionManager) also fails closed.
  assert.equal((await m.invokeToolCall(bash(), null))?.block, true);
  // The freeze command rejects a mismatched context session.
  m.runCommand('rollover-freeze', JSON.stringify(token()), 'sess-B');
  assert.ok(m.notes.some((n) => n.includes('session mismatch')));
});

test('an injected controller whose session differs is rejected', () => {
  const other = new RolloverFreezeController({ sessionId: 'sess-B' });
  assert.throws(
    () =>
      registerPiRolloverFreeze(mockPi().pi, {
        sessionId: SESSION,
        controller: other,
      }),
    /injected controller session/,
  );
});

// Defect 6: no thaw command or API; replaying the token cannot regain write flow.
test('there is no thaw and replaying the token cannot regain write flow', async () => {
  const m = mockPi();
  const controller = registerPiRolloverFreeze(m.pi, { sessionId: SESSION });
  controller.freeze(token());
  assert.equal(m.commands.has('rollover-thaw'), false);
  assert.equal(
    (controller as unknown as { thaw?: unknown }).thaw,
    undefined,
    'no public thaw API',
  );
  // Replaying the exact freeze token is idempotent and keeps the barrier closed.
  m.runCommand('rollover-freeze', JSON.stringify(token()), SESSION);
  assert.equal((await m.invokeToolCall(bash(), SESSION))?.block, true);
  assert.equal(controller.frozen, true);
});

test('rejects wrong-session, conflicting and stale freezes; exact duplicate is idempotent', () => {
  const controller = new RolloverFreezeController({ sessionId: SESSION });
  const wrong = controller.freeze(token({ sessionId: 'sess-B' }));
  assert.equal(wrong.ok === false && wrong.reason, 'wrong_session');
  assert.ok(controller.freeze(token({ generation: 2 })).ok);
  const dup = controller.freeze(token({ generation: 2 }));
  assert.equal(dup.ok && dup.state, 'already_frozen');
  const stale = controller.freeze(token({ generation: 1 }));
  assert.equal(stale.ok === false && stale.reason, 'stale_generation');
  const conflict = controller.freeze(
    token({ handoffId: 'ho-2', generation: 5 }),
  );
  assert.equal(conflict.ok === false && conflict.reason, 'conflicting_freeze');
});

test('invalid freeze tokens are rejected', () => {
  const controller = new RolloverFreezeController({ sessionId: SESSION });
  assert.equal(controller.freeze(token({ generation: -1 })).ok, false);
  assert.equal(controller.freeze({ ...token(), handoffId: '' }).ok, false);
});

test('a fresh controller (restart) starts unproven and surfaces the memory-only limit', () => {
  const first = new RolloverFreezeController({ sessionId: SESSION });
  first.freeze(token());
  assert.equal(first.frozen, true);
  const afterRestart = new RolloverFreezeController({ sessionId: SESSION });
  assert.equal(afterRestart.frozen, false);
  assert.equal(afterRestart.status().ready, false);
  const limits = afterRestart.status().limitations;
  assert.ok(limits.includes('memory_only_latch_lost_on_restart_or_reload'));
  assert.ok(
    limits.includes(
      'no_thaw_recovery_pending_separate_authority_checked_integration',
    ),
  );
  assert.ok(
    limits.includes(
      'observations_caller_supplied_unauthenticated_not_a_native_stop_proof',
    ),
  );
});

test('the registered block return matches the installed Pi tool_call shape', async () => {
  const m = mockPi();
  const controller = registerPiRolloverFreeze(m.pi, { sessionId: SESSION });
  controller.freeze(token());
  const blocked = await m.invokeToolCall(bash());
  assert.equal(blocked?.block, true);
  assert.equal(typeof blocked?.reason, 'string');
  const allowed = await m.invokeToolCall({
    toolName: 'read',
    input: { path: 'x.ts' },
  });
  assert.equal(allowed, undefined);
});

test('the freeze command validates its JSON token and reports via ui.notify', () => {
  const m = mockPi();
  registerPiRolloverFreeze(m.pi, { sessionId: SESSION });
  m.runCommand('rollover-freeze', 'not json', SESSION);
  m.runCommand('rollover-freeze', JSON.stringify(token()), SESSION);
  assert.ok(m.notes.some((n) => n.includes('rejected')));
  assert.ok(m.notes.some((n) => n.includes('rollover-freeze frozen')));
});

// R2: the replay fence survives readiness invalidation (the one remaining defect).
test('the replay fence refuses a stale sequence after allowed tool activity', () => {
  const controller = new RolloverFreezeController({ sessionId: SESSION });
  controller.freeze(token());
  assert.ok(controller.observe(obs({ sequence: 10 })).ok);
  assert.equal(controller.status().ready, true);
  assert.equal(controller.status().lastAcceptedSequence, 10);
  // An allowed read invalidates readiness but NOT the fence.
  controller.decideToolCall('read', SESSION);
  assert.equal(controller.status().ready, false);
  assert.equal(controller.status().lastAcceptedSequence, 10);
  // Replaying the SAME sequence 10 is refused and stays not-ready.
  assert.equal(controller.observe(obs({ sequence: 10 })).ok, false);
  assert.equal(controller.status().ready, false);
  // Only a strictly newer complete snapshot restores advisory readiness.
  assert.ok(controller.observe(obs({ sequence: 11 })).ok);
  assert.equal(controller.status().ready, true);
});

test('the replay fence survives blocked activity, session mismatch and explicit invalidation', () => {
  const blocked = new RolloverFreezeController({ sessionId: SESSION });
  blocked.freeze(token());
  assert.ok(blocked.observe(obs({ sequence: 5 })).ok);
  assert.equal(blocked.decideToolCall('bash', SESSION).block, true);
  assert.equal(blocked.observe(obs({ sequence: 5 })).ok, false);
  assert.equal(blocked.observe(obs({ sequence: 4 })).ok, false);

  const session = new RolloverFreezeController({ sessionId: SESSION });
  session.freeze(token());
  assert.ok(session.observe(obs({ sequence: 5 })).ok);
  assert.equal(session.decideToolCall('read', 'sess-B').block, true);
  assert.equal(session.observe(obs({ sequence: 5 })).ok, false);

  const explicit = new RolloverFreezeController({ sessionId: SESSION });
  explicit.freeze(token());
  assert.ok(explicit.observe(obs({ sequence: 5 })).ok);
  explicit.invalidateReadiness();
  assert.equal(explicit.status().ready, false);
  assert.equal(explicit.observe(obs({ sequence: 5 })).ok, false);
  assert.ok(explicit.observe(obs({ sequence: 6 })).ok);
});

test('an idempotent freeze reuse does not reset the replay fence', () => {
  const controller = new RolloverFreezeController({ sessionId: SESSION });
  controller.freeze(token());
  assert.ok(controller.observe(obs({ sequence: 7 })).ok);
  controller.invalidateReadiness();
  const dup = controller.freeze(token());
  assert.equal(dup.ok && dup.state, 'already_frozen');
  assert.equal(controller.status().lastAcceptedSequence, 7);
  assert.equal(controller.observe(obs({ sequence: 7 })).ok, false);
  assert.ok(controller.observe(obs({ sequence: 8 })).ok);
});
