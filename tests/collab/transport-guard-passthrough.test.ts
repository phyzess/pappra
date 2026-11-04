import assert from 'node:assert/strict';
import test from 'node:test';
import { guardedBootstrapTransport } from '../../src/app/collab-bootstrap.js';
import { guardedWorkExecutionTransport } from '../../src/app/collab-work-execution.js';
import type {
  HerdrCallerResult,
  HerdrListResult,
  HerdrPromptResult,
  HerdrTransport,
} from '../../src/app/collab-notify.js';

/**
 * The two delivery guards wrap prompt authority only. A caller's own bound on a
 * roster read (the observation budget) must reach the underlying transport
 * unchanged; a guard that swallows it silently turns a bounded probe into a
 * default-timeout one. These tests exercise the real guard functions.
 */

class RecordingTransport implements HerdrTransport {
  readonly id = 'recording-herdr';
  readonly callerCalls: ({ readonly paneId?: string } | undefined)[] = [];
  readonly listCalls: ({ readonly timeoutMs?: number } | undefined)[] = [];
  readonly promptCalls: string[] = [];

  async verifyCaller(options?: {
    readonly paneId?: string;
  }): Promise<HerdrCallerResult> {
    this.callerCalls.push(options);
    return {
      ok: true,
      caller: {
        paneId: 'w3:p1',
        workspaceId: 'w3',
        tabId: 'w3:t1',
        harness: 'codex',
        cwd: '/tmp/task-root',
        sessionKind: null,
        sessionValue: null,
        source: 'current',
      },
    };
  }

  async list(options?: {
    readonly timeoutMs?: number;
  }): Promise<HerdrListResult> {
    this.listCalls.push(options);
    return { ok: true, agents: [] };
  }

  async prompt(agent: string): Promise<HerdrPromptResult> {
    this.promptCalls.push(agent);
    return { status: 'submitted', detail: null };
  }
}

test('the work-execution guard forwards the roster read bound unchanged', async () => {
  const underlying = new RecordingTransport();
  const guard = guardedWorkExecutionTransport(underlying, async () => ({
    ok: true,
    reason: 'authorized',
  }));

  assert.notEqual(guard.id, underlying.id);
  assert.deepEqual(await guard.list({ timeoutMs: 777 }), {
    ok: true,
    agents: [],
  });
  await guard.list();
  // The remaining observation budget reaches the transport exactly as given.
  assert.deepEqual(underlying.listCalls, [{ timeoutMs: 777 }, undefined]);

  await guard.verifyCaller({ paneId: 'w3:p1' });
  assert.deepEqual(underlying.callerCalls, [{ paneId: 'w3:p1' }]);
});

test('the work-execution guard still owns the final authority check', async () => {
  const underlying = new RecordingTransport();
  const missing = guardedWorkExecutionTransport(underlying, undefined);
  const missingResult = await missing.prompt('pappra-implement', 'pointer');
  assert.equal(missingResult.status, 'blocked');
  assert.equal(missingResult.effect, 'none');
  assert.equal(underlying.promptCalls.length, 0);

  const refusing = guardedWorkExecutionTransport(underlying, async () => ({
    ok: false,
    reason: 'authority moved',
  }));
  const refused = await refusing.prompt('pappra-implement', 'pointer');
  assert.equal(refused.status, 'blocked');
  assert.equal(underlying.promptCalls.length, 0);

  const throwing = guardedWorkExecutionTransport(underlying, async () => {
    throw new Error('authority unavailable');
  });
  const threw = await throwing.prompt('pappra-implement', 'pointer');
  assert.equal(threw.status, 'blocked');
  assert.equal(underlying.promptCalls.length, 0);

  const allowing = guardedWorkExecutionTransport(underlying, async () => ({
    ok: true,
    reason: 'authorized',
  }));
  const forwarded = await allowing.prompt('pappra-implement', 'pointer');
  assert.equal(forwarded.status, 'submitted');
  assert.deepEqual(underlying.promptCalls, ['pappra-implement']);
});

test('the visible-bootstrap guard forwards the roster read bound unchanged', async () => {
  const underlying = new RecordingTransport();
  // The guard reads only the transport for a roster read and the recipient name
  // for its prompt identity check; the prompt path that needs the full
  // bootstrap context is covered by the visible-bootstrap suite.
  const context = {
    transport: underlying,
    herdrAgent: 'pappra-implement',
    task: { taskRoot: '/tmp/task-root' },
  } as unknown as Parameters<typeof guardedBootstrapTransport>[0];
  const guard = guardedBootstrapTransport(context, 'reservation-1', () => 0);

  assert.match(guard.id, /visible-bootstrap-guard$/);
  assert.deepEqual(await guard.list({ timeoutMs: 1_234 }), {
    ok: true,
    agents: [],
  });
  await guard.list();
  assert.deepEqual(underlying.listCalls, [{ timeoutMs: 1_234 }, undefined]);

  await guard.verifyCaller({ paneId: 'w3:p1' });
  assert.deepEqual(underlying.callerCalls, [{ paneId: 'w3:p1' }]);

  // Recipient identity is still refused before anything is prompted.
  const foreign = await guard.prompt('someone-else', 'pointer');
  assert.equal(foreign.status, 'refused');
  assert.equal(underlying.promptCalls.length, 0);
});
