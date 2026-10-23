import assert from 'node:assert/strict';
import test from 'node:test';
import piSessionTransitionExtension, {
  createPiSessionTransitionHost,
  PI_SESSION_TRANSITION_EXTENSION_ID,
  PI_SESSION_TRANSITION_LIMITATIONS,
} from '../../src/hosts/integration/pi-session-transition-extension.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CWD = '/workspace/session-transition-test';

interface FakeCommand {
  readonly description: string;
  readonly handler: (args: string, context: unknown) => void | Promise<void>;
}

class FakePi {
  readonly handlers = new Map<
    string,
    Array<(event: unknown, context: unknown) => unknown>
  >();
  readonly commands = new Map<string, FakeCommand>();

  on(
    event: string,
    handler: (event: unknown, context: unknown) => unknown,
  ): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(name: string, options: FakeCommand): void {
    this.commands.set(name, options);
  }
}

function context(sessionId = SESSION_ID): Record<string, unknown> {
  return {
    cwd: CWD,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: () => undefined },
  };
}

test('Pi event and managed-freeze observations never become native quiescence proof', async () => {
  const pi = new FakePi();
  const runtime = createPiSessionTransitionHost(pi, context(), {
    HERDR_PANE_ID: 'w3:p3',
  });
  assert.ok(runtime);
  assert.equal(runtime.host.id, PI_SESSION_TRANSITION_EXTENSION_ID);

  const before = await runtime.host.observe();
  assert.equal(before.session_id, SESSION_ID);
  assert.equal(before.cwd, CWD);
  assert.equal(before.pane_id, 'w3:p3');
  assert.equal(before.proof_support, 'unavailable');
  assert.equal(before.proof, null);
  assert.equal(
    before.unavailable_code,
    'pi_native_quiescence_proof_unavailable',
  );
  assert.equal(before.native_facts?.nativeStop, false);
  assert.equal(before.native_facts?.inFlightCompleteness, 'unknown');
  assert.equal(before.native_facts?.queue, 'unknown');
  assert.equal(before.native_facts?.approvals, 'unknown');

  const token = {
    sessionId: SESSION_ID,
    taskId: 'sample',
    handoffId: 'handoff-1',
    generation: 1,
  };
  const freeze = await runtime.host.freeze(token);
  assert.equal(freeze.ok, true);
  const after = await runtime.host.observe();
  assert.equal(after.freeze_status?.frozen, true);
  assert.equal(after.proof_support, 'unavailable');
  assert.equal(
    after.proof,
    null,
    'a managed freeze latch must not be promoted to quiescence proof',
  );

  const toolCall = pi.handlers.get('tool_call')?.[0];
  assert.ok(
    toolCall,
    'the explicit host adapter installs the managed-tool barrier',
  );
  const decision = await toolCall({ toolName: 'bash', input: {} }, context());
  assert.equal((decision as { block?: boolean } | undefined)?.block, true);
  assert.equal((await runtime.host.observe()).proof_support, 'unavailable');
  assert.ok(
    PI_SESSION_TRANSITION_LIMITATIONS.includes(
      'managed_tool_freeze_is_not_native_process_or_external_writer_stop_proof',
    ),
  );
});

test('loading the explicit extension registers only its command until a task-bound invocation', () => {
  const pi = new FakePi();
  piSessionTransitionExtension(pi);
  assert.ok(pi.commands.has('collab-transition'));
  assert.equal(
    pi.handlers.size,
    0,
    'loading alone does not attach freeze or event handlers',
  );
});

test('Pi host refuses incomplete or changed session context', async () => {
  const pi = new FakePi();
  assert.equal(createPiSessionTransitionHost(pi, { cwd: CWD }), null);
  let currentSession = SESSION_ID;
  const boundContext = {
    cwd: CWD,
    sessionManager: { getSessionId: () => currentSession },
  };
  const runtime = createPiSessionTransitionHost(pi, boundContext, {});
  assert.ok(runtime);
  currentSession = '22222222-2222-4222-8222-222222222222';
  const observation = await runtime.host.observe();
  assert.equal(observation.session_id, currentSession);
  assert.equal(observation.proof_support, 'unavailable');
  const rejected = await runtime.host.freeze({
    sessionId: SESSION_ID,
    taskId: 'sample',
    handoffId: 'handoff-1',
    generation: 1,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.reason, 'wrong_session');
});
