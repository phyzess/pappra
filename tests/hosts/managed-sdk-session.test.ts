import assert from 'node:assert/strict';
import { mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ManagedPiJournal } from '../../src/hosts/pi/managed-session.js';
import {
  ManagedPiSdkIngressFence,
  ManagedPiSdkSessionController,
  type ManagedPiSdkInteractiveModePort,
  type ManagedPiSdkRuntimePort,
  type ManagedPiSdkSessionPort,
} from '../../src/hosts/pi/managed-sdk-session.js';

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), 'pappra-managed-sdk-'));
}

function readJournal(file: string) {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('managed SDK adapter inventories native queues, gates ingress, publishes events and captures native summary', async (t) => {
  const directory = temporaryDirectory();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journalPath = path.join(directory, 'sdk.jsonl');
  const journal = new ManagedPiJournal(
    journalPath,
    openSync(journalPath, 'wx', 0o600),
    'managed-sdk-adapter-test',
  );
  t.after(() => journal.close());

  let idle = true;
  let stopped = 0;
  let disposed = false;
  let resourceRefreshes = 0;
  const nativeInputs: string[] = [];
  let inputCallback: ((event: unknown) => void) | undefined;
  let dialogUi: Record<string, unknown> | undefined;
  let resolveConfirm: ((value: boolean) => void) | undefined;
  let summaryEntered!: () => void;
  let releaseSummary!: () => void;
  const summaryStarted = new Promise<void>((resolve) => {
    summaryEntered = resolve;
  });
  const summaryReleased = new Promise<void>((resolve) => {
    releaseSummary = resolve;
  });
  const session = {
    agent: {
      state: { pendingToolCalls: new Set<string>() },
      streamFunction: () => 'native-stream',
    },
    sessionId: '11111111-2222-4333-8444-555555555555',
    sessionFile: '/sessions/source.jsonl',
    model: { id: 'openai/gpt-6-luna', provider: 'openrouter' },
    thinkingLevel: 'high',
    get isStreaming() {
      return !idle;
    },
    isCompacting: false,
    get isIdle() {
      return idle;
    },
    isBashRunning: false,
    hasPendingBashMessages: false,
    pendingMessageCount: 0,
    state: { pendingToolCalls: new Set<string>() },
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getContextUsage: () => ({ tokens: 320, contextWindow: 1000, percent: 32 }),
    compact: async () => {
      summaryEntered();
      await summaryReleased;
      assert.equal(session.agent.streamFunction(), 'native-stream');
      return { summary: 'Native Pi compaction summary', tokensBefore: 320 };
    },
    subscribe: (listener: (event: unknown) => void) => {
      inputCallback = listener;
      return () => {
        inputCallback = undefined;
      };
    },
    _refreshToolRegistry: () => {
      resourceRefreshes++;
      return 'native-resource-result';
    },
    abort: async () => {
      idle = true;
    },
    waitForIdle: async () => undefined,
    prompt: async (text: string) => {
      nativeInputs.push(text);
    },
    steer: async () => undefined,
    followUp: async () => undefined,
    sendUserMessage: async () => undefined,
    sendCustomMessage: async () => undefined,
    executeBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    abortBash: () => undefined,
    bindExtensions: async (bindings: unknown) => {
      dialogUi = (bindings as { uiContext: Record<string, unknown> }).uiContext;
    },
    _pendingNextTurnMessages: [] as unknown[],
    _pendingCustomMessages: [] as unknown[],
    _pendingBashMessages: [] as unknown[],
    _deferredSettledActions: [] as (() => void)[],
  } as unknown as ManagedPiSdkSessionPort & Record<string, unknown>;
  const mode = {
    init: async () => undefined,
    run: async () => undefined,
    stop: () => {
      stopped += 1;
    },
    pendingUserInputs: [] as string[],
    compactionQueuedMessages: [] as unknown[],
    extensionDialogs: [] as unknown[],
    activeSelectorToken: undefined as string | undefined,
  } as unknown as ManagedPiSdkInteractiveModePort;
  const runtime = {
    session,
    cwd: '/repo',
    setRebindSession: () => undefined,
    dispose: async () => {
      disposed = true;
    },
  } as ManagedPiSdkRuntimePort;
  const fence = new ManagedPiSdkIngressFence(journal);
  let executionAllowed = false;
  const controller = new ManagedPiSdkSessionController({
    runtime,
    interactiveMode: mode,
    fence,
    journal,
    model: 'openai/gpt-6-luna',
    nativeIdentity: {
      agentId: 'agent-1',
      paneId: null,
      surface: 'pi-sdk-tui',
      configurationId: null,
    },
    quiesceTimeoutMs: 100,
    canCompact: () => true,
    canExecute: () => executionAllowed,
  });

  await assert.rejects(
    (session.prompt as (text: string) => Promise<void>)(
      'No assignment authority',
    ),
    /sdk_runtime_ingress_fenced/,
  );
  assert.throws(() => session.agent.streamFunction(), /ingress is fenced/);
  assert.deepEqual(nativeInputs, []);
  executionAllowed = true;

  const initial = controller.snapshot();
  const resourceEvents: unknown[] = [];
  const unsubscribeResources = controller.subscribe((event) =>
    resourceEvents.push(event),
  );
  assert.equal(
    (session._refreshToolRegistry as () => string)(),
    'native-resource-result',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resourceRefreshes, 1);
  assert.deepEqual(resourceEvents, [
    { type: 'native_resources_changed', published: false },
  ]);
  unsubscribeResources();
  assert.equal(initial.ownedRuntime.queues.completeness, 'complete');
  assert.equal(initial.ownedRuntime.work.pendingToolCalls, 0);
  assert.equal(initial.contextUsage?.percent, 32);
  assert.equal(
    controller.observe().native.modelObservation.provider,
    'openrouter',
  );
  assert.equal((await controller.inventory()).completeness, 'complete');
  assert.equal(
    controller.submitInput('registered-input-1', 'A registered pointer.')
      .duplicate,
    false,
  );
  assert.equal(
    controller.submitInput('registered-input-1', 'A registered pointer.')
      .duplicate,
    true,
  );
  assert.throws(
    () => controller.submitInput('registered-input-1', 'Different input.'),
    /sdk_input_id_conflict/,
  );
  assert.deepEqual(nativeInputs, ['A registered pointer.']);

  const pinnedSession = session as unknown as Record<string, unknown>;
  const pinnedMode = mode as unknown as Record<string, unknown>;
  pinnedSession['_pendingNextTurnMessages'] = [
    { role: 'user', content: [{ type: 'text', text: 'queued aside' }] },
  ];
  let queued = controller.snapshot();
  assert.equal(queued.ownedRuntime.queues.completeness, 'complete');
  assert.equal(queued.ownedRuntime.queues.pendingMessageCount, 1);
  assert.equal(queued.scopedQuiescent, false);
  pinnedSession['_pendingNextTurnMessages'] = undefined;
  queued = controller.snapshot();
  assert.equal(queued.ownedRuntime.queues.completeness, 'unknown');
  assert.equal(queued.scopedQuiescent, false);
  pinnedSession['_pendingNextTurnMessages'] = [];
  pinnedMode['activeSelectorToken'] = 'selector-pending';
  assert.equal(controller.snapshot().scopedQuiescent, false);
  pinnedMode['activeSelectorToken'] = undefined;

  const lifecycleEvents: unknown[] = [];
  const unsubscribe = controller.subscribe((event) =>
    lifecycleEvents.push(event),
  );
  inputCallback?.({ type: 'agent_settled' });
  unsubscribe();
  assert.equal(lifecycleEvents.length, 1);

  const bindExtensions = (
    session as unknown as {
      bindExtensions(bindings: unknown): Promise<void>;
    }
  ).bindExtensions.bind(session);
  await bindExtensions({
    uiContext: {
      confirm: () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve;
        }),
      select: async () => 'choice',
      input: async () => 'value',
    },
  });
  assert.ok(dialogUi);
  const confirm = dialogUi['confirm'] as () => Promise<boolean>;
  const pendingConfirmation = confirm();
  assert.equal(
    controller.canCaptureSummary(),
    false,
    'pending native approval must not fence the source for compaction',
  );
  assert.equal(
    controller.snapshot().ownedRuntime.extensionDialogs.pending.length,
    1,
  );
  resolveConfirm?.(true);
  assert.equal(await pendingConfirmation, true);
  assert.equal(
    controller.snapshot().ownedRuntime.extensionDialogs.pending.length,
    0,
  );
  assert.equal(controller.canCaptureSummary(), true);

  const prompt = (session as unknown as { prompt(text: string): Promise<void> })
    .prompt;
  await prompt.call(session, 'semantic task input');
  assert.ok(
    readJournal(journalPath).some(
      (record) =>
        record['kind'] === 'sdk_semantic_input_admitted' &&
        JSON.stringify(record).includes('semantic task input'),
    ),
  );

  const capturing = controller.captureSummary('cause-1');
  await summaryStarted;
  assert.throws(
    () => session.agent.streamFunction(),
    /provider ingress is fenced/,
    'unrelated provider ingress stays blocked while native summary is running',
  );
  releaseSummary();
  const capture = await capturing;
  assert.equal(capture.summary, 'Native Pi compaction summary');
  assert.equal(capture.complete, false);
  assert.equal(capture.sessionFile, '/sessions/source.jsonl');
  const quiesced = controller.snapshot();
  assert.equal(stopped, 1);
  assert.equal(quiesced.ingress.state, 'fenced');
  assert.equal(quiesced.scopedQuiescent, true);
  assert.throws(
    () => session.agent.streamFunction(),
    /provider ingress is fenced/,
  );
  const receipt = await controller.stopOwnedRuntime();
  assert.equal(receipt.status, 'runtime_disposed');
  assert.equal(receipt.process.exit, 'not_owned');
  assert.equal(disposed, true);
  assert.equal(journal.healthy, false);
  assert.equal(inputCallback, undefined);
  assert.throws(
    () => session.agent.streamFunction(),
    /provider ingress is fenced/,
  );
  await assert.rejects(
    () => prompt.call(session, 'work after disposal'),
    /fenced/,
  );
});
