/*
# Provider network recovery: owned-route failure and bounded restart

## Scope and acceptance

This opt-in proof has two deliberately bounded pieces. The executor uses a real task-local
reservation/journal in an explicitly synthetic test task. It records a known-no-effect loopback
refusal, terminates the first owner while one retry in the total budget remains, restores the
fixture route, and starts a different process with the exact same request/cause. The resumed
controller asks the separately owned native SDK worker to make one provider request. The fixture
task uses the observed Pi SDK session UUID in `self`, the task binding, and `expectedSession`; it
does not invent a native UUID or claim the synthetic task namespace is a production Herdr task.

The native worker starts a controller-owned Pi SDK 1.4.0 interactive session in the newly owned
visible Herdr pane, pins OpenRouter `openai/gpt-6-luna`, disables tools, and awaits one harmless
prompt. Its per-request fetch adapter validates the exact chat-completions endpoint, checks that
its loopback route gate accepts a connection, and only then invokes the original fetch function
for that single request. The adapter does not replace global fetch, alter a dispatcher, set proxy
configuration, or inspect/log headers, credentials, request bodies, prompts, or response text.
Both the stream wrapper and fetch adapter reject repeat calls; SDK retries are set to zero and
`maxTokens` is capped at 1024.

A successful acceptance requires all of: the first process journaled `unavailable` + `none` with
an outcome timestamp; that process exited; the same cause resumed in a different process within
the original total retry budget; the restarted controller called the native worker exactly once;
the SDK request passed the restored loopback gate, returned HTTP 200 and produced the actual
final assistant response (`stopReason: stop` with the fixed reply); and the owned runtime
was disposed. If the provider is unavailable or returns another terminal result, the evidence
retains the exact sanitized status (for example `http_401`, `ECONNREFUSED`, or
`provider_request_rejected`), records `acceptance_passed: false`, and does not claim success. A
fetch that reaches the provider but fails without a response is not classified as known
no-effect.

This is evidence for one owned loopback route and one native OpenRouter request, not a
whole-machine Wi-Fi outage or provider-wide outage. It does not prove production task namespace
integration, unattended recovery generally, or that a provider response constitutes completion
of a user's task.

## Restart and replay boundary

The application executor owns the recovery decision. On a restart it may claim the existing cause
only after the previous owner is dead and only when the unfinished journal contains exclusively
failed/unavailable attempts with observation `none` and an outcome timestamp, and the total retry
budget has remaining capacity. The test uses the same durable request and cause; it does not
alter the journal, mint a new cause, or call the model around the executor.

Unknown, queued, partial, in-flight, and final outcomes remain no-replay boundaries. The native
request itself is guarded against stream and fetch retries. The separate executor regression
tests remain responsible for negative no-replay cases; this probe's eligible known-no-effect path
is the positive resume case.

## Safety and evidence

- Use only an explicitly chosen pinned `@earendil-works/pi-coding-agent` 1.4.0 entrypoint; the
  test checks the package version. Never rely on a globally installed or cached SDK.
- The SDK uses normal daily resource/authentication discovery. The probe does not read auth
  state, extract credentials, set API-key variables, or print environment contents.
- The fixed task text is `Reply exactly OK. Do not call tools or write files.` Active tools are
  disabled, `maxTokens` is 1024, `maxRetries` is 0, and only one stream and one fetch admission
  are allowed.
- The route gate is scoped to this request. It is opened on loopback after the first process
  exits. The native fetch adapter calls the captured original fetch only after the loopback gate
  accepts; no global fetch/proxy/network settings are changed. The test refuses to run when proxy
  environment variables are set rather than changing them.
- Evidence JSONL is created exclusively with mode `0600` in a fresh private scratch directory. It
  records only observed SDK identity/provider/model/pane/process ids, endpoint identity, socket
  status/byte count, stream/fetch/retry counts, HTTP status or sanitized terminal status, stop
  reason, executor disposition, runtime disposal, and proof boundaries. It contains no
  request/response bytes, response text, prompt, headers, or credentials. Temporary
  task/session files are removed by the test.

## Run only in an owned visible test pane

Verify `HERDR_ENV=1` and read `herdr --skill` first. Use only the newly owned visible test pane;
do not target the root, caller, workers, or unrelated panes. The test requires `HERDR_PANE_ID` to
match the supplied pane id and refuses any id listed as forbidden.

Run from the repository root in that owned pane. Use a fresh private output directory, direct
Node/TypeScript commands, and no package-manager build or shared `.build` output:

```nu
let T = (^mktemp -d -p $env.TMPDIR pappra-provider-network-recovery.XXXXXX | str trim)
try {
  ^node node_modules/typescript/bin/tsc --target ES2023 --lib ES2023,DOM --module NodeNext --moduleResolution NodeNext --types node --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noImplicitOverride --noFallthroughCasesInSwitch --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules --forceConsistentCasingInFileNames --skipLibCheck --noEmitOnError --sourceMap --declaration --rootDir . --outDir $"($T)/out" tests/collab/provider-network-recovery.test.ts tests/collab/provider-network-recovery-worker.ts tests/collab/provider-network-recovery-executor-worker.ts src/hosts/integration/pi-sdk.d.ts
  if $env.LAST_EXIT_CODE != 0 { error make { msg: "owned test compilation failed" } }
  { type: "module" } | to json | save --raw $"($T)/out/package.json"
  with-env {
    PAPPRA_PROVIDER_NETWORK_RECOVERY: "1"
    PAPPRA_PROVIDER_NETWORK_RECOVERY_PANE_ID: "<owned-pane-id>"
    PAPPRA_PROVIDER_NETWORK_RECOVERY_FORBIDDEN_PANES: "<root-and-unrelated-pane-ids>"
    PAPPRA_PROVIDER_NETWORK_RECOVERY_EVIDENCE_FILE: $"($T)/evidence.jsonl"
  } {
    ^node --test $"($T)/out/tests/collab/provider-network-recovery.test.js"
    if $env.LAST_EXIT_CODE != 0 { error make { msg: "owned experiment failed" } }
  }
} finally {
  rm --recursive --force $T
}
```

Do not run the shared build, full test suite, or package checks from this worker; root owns those
checks. Do not reuse an evidence path. A default-skipped test is not evidence of acceptance; run
the explicit opt-in experiment and inspect the sanitized `acceptance_passed` and
`provider_terminal_status` fields.

## Current execution note

The earlier retained proof stopped before the native provider attempt reached a terminal result.
The known-no-effect restart path exists, but the retained native-provider run did not supply
terminal acceptance. No provider success should be claimed
unless the new terminal evidence contains HTTP 200, the final assistant reply at
`stopReason: stop` and `runtime_disposed`. This page records the contract and the observed gap; it does not claim a passed acceptance.
*/

import assert from 'node:assert/strict';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { initTask } from '../../src/collab/store.js';
import type {
  Coordinator,
  Identity,
  MessageInput,
} from '../../src/collab/types.js';
import { WORK_PLAN_SCHEMA } from '../../src/collab/work-plan.js';
import type { RecoveryExecutionRequest } from '../../src/app/collab-recovery-executor.js';

const SDK_MODULE =
  '/private/tmp/pappra-sdk-1.4.7IQTDg/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
const PROVIDER_WORKER = fileURLToPath(
  new URL('./provider-network-recovery-worker.js', import.meta.url),
);
const EXECUTOR_WORKER = fileURLToPath(
  new URL('./provider-network-recovery-executor-worker.js', import.meta.url),
);
const TEST_TASK = 'provider-network-recovery-fixture';
const TEST_INPUT = `sha256:${'1'.repeat(64)}`;
const TEST_OWNER: Coordinator = {
  agent_id: 'network-fixture-coordinator',
  session_id: 'network-fixture-coordinator-session',
  harness: 'pi',
  owner_epoch: 1,
  since: '2026-10-20T00:00:00Z',
};
const TEST_WRITER: Identity = {
  agent_id: 'network-fixture-writer',
  session_id: 'replaced-with-observed-sdk-session',
  harness: 'pi',
};

interface Flow {
  readonly root: string;
  readonly task: string;
  readonly request: RecoveryExecutionRequest;
  cleanup(): void;
}

interface WorkerEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface WorkerHandle {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly exit: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  waitFor(type: string, timeoutMs?: number): Promise<WorkerEvent>;
  send(message: WorkerEvent): void;
}

interface RecoveryReservation {
  readonly key: string;
  readonly journal: readonly {
    readonly disposition: string | null;
    readonly observation: string | null;
    readonly outcome_at?: number;
  }[];
  readonly final?: unknown;
}

interface GateServer {
  readonly connections: number;
  close(): Promise<void>;
}

interface SafeEvidenceRecord {
  readonly [key: string]: string | number | boolean | null;
}

const OPTED_IN = process.env.PAPPRA_PROVIDER_NETWORK_RECOVERY === '1';

test(
  'owned-route owner death resumes once and issues one bounded native OpenRouter request',
  {
    timeout: 180_000,
    skip: OPTED_IN
      ? false
      : 'requires explicit opt-in, an owned visible Herdr test pane, and a new private /private/tmp evidence path',
  },
  async (t) => {
    let nativeWorker: WorkerHandle | undefined;
    let nativeRoot: string | undefined;
    let evidenceWritten = false;
    let evidenceInitialized = false;
    let observedUpstreamFetchCalls: number | null = null;
    const evidenceFile =
      process.env.PAPPRA_PROVIDER_NETWORK_RECOVERY_EVIDENCE_FILE;
    t.after(async () => {
      if (nativeWorker?.child.exitCode === null) {
        nativeWorker.child.kill('SIGTERM');
        await nativeWorker.exit;
      }
      if (nativeRoot) rmSync(nativeRoot, { recursive: true, force: true });
      if (!evidenceWritten && evidenceInitialized && evidenceFile !== undefined)
        appendEvidence(evidenceFile, [
          {
            kind: 'probe_incomplete',
            acceptance_passed: false,
            upstream_fetch_calls: observedUpstreamFetchCalls,
          },
        ]);
    });

    assert.equal(
      process.env.HERDR_ENV,
      '1',
      'owned Herdr environment is required',
    );
    const paneId = process.env.PAPPRA_PROVIDER_NETWORK_RECOVERY_PANE_ID;
    assert.ok(paneId && /^w\d+:p[A-Za-z0-9]+$/.test(paneId));
    assert.equal(
      process.env.HERDR_PANE_ID,
      paneId,
      'test must run in the newly created owned pane named in its configuration',
    );
    const forbiddenPaneIds = new Set(
      (process.env.PAPPRA_PROVIDER_NETWORK_RECOVERY_FORBIDDEN_PANES ?? '')
        .split(',')
        .filter(Boolean),
    );
    assert.equal(
      forbiddenPaneIds.has(paneId),
      false,
      'refusing to target a known root, caller, worker, or unrelated pane',
    );
    assert.ok(validEvidencePath(evidenceFile));
    assert.equal(existsSync(evidenceFile), false, 'evidence path must be new');
    writeFileSync(evidenceFile, '', { flag: 'wx', mode: 0o600 });
    evidenceInitialized = true;
    const retain = (record: SafeEvidenceRecord): void =>
      appendEvidence(evidenceFile, [record]);
    assert.ok(
      existsSync(SDK_MODULE),
      'the exact pinned Pi SDK module is required',
    );
    const sdkPackage = JSON.parse(
      readFileSync(join(dirname(dirname(SDK_MODULE)), 'package.json'), 'utf8'),
    ) as { version?: string };
    assert.equal(sdkPackage.version, '1.4.0');
    assertNoProxyEnvironment();

    retain({
      kind: 'probe_scope',
      route:
        'owned per-request loopback gate; provider fetch only after restoration',
      whole_machine_network_changed: false,
      global_fetch_or_dispatcher_overridden_by_probe: false,
      acceptance_passed: false,
    });

    nativeRoot = realpathSync(
      mkdtempSync(join(tmpdir(), 'pappra-provider-network-recovery-native-')),
    );
    const routePort = await unusedLoopbackPort();
    nativeWorker = startWorker(
      PROVIDER_WORKER,
      {
        sdkModulePath: SDK_MODULE,
        paneId,
        routePort,
        journalPath: join(nativeRoot, 'managed-sdk-session.jsonl'),
      },
      ['inherit', 'inherit', 'inherit', 'ipc'],
    );

    const started = await nativeWorker.waitFor(
      'native-session-started',
      60_000,
    );
    assert.match(String(started.sessionId), /^[0-9a-f-]{36}$/i);
    assert.equal(started.provider, 'openrouter');
    assert.equal(started.model, 'openai/gpt-6-luna');
    assert.equal(started.paneId, paneId);
    assert.equal(
      started.agentId,
      null,
      'no Herdr agent identity is synthesized',
    );
    assert.equal(started.activeTools, 0);
    assert.equal(started.processPid, nativeWorker.pid);
    const herdrObservation = captureOwnedPane(paneId, nativeWorker.pid);
    assert.equal(herdrObservation.paneIdMatched, true);
    assert.equal(herdrObservation.processInfoObserved, true);
    assert.equal(herdrObservation.nativePidObserved, true);
    retain({
      kind: 'native_session_started',
      native_session_id: String(started.sessionId),
      provider: 'openrouter',
      model: 'openai/gpt-6-luna',
      pane_id: paneId,
      process_pid: nativeWorker.pid,
      active_tools: 0,
      herdr_pane_observed: true,
      native_foreground_pid_observed: true,
      herdr_agent_identity_observed: false,
    });

    const negative = await runUnknownNoReplayCharacterization(
      String(started.sessionId),
      paneId,
    );
    retain(negative);

    const recovery = await runExecutorRestartCharacterization(
      nativeWorker,
      String(started.sessionId),
      paneId,
      routePort,
    );
    retain(recovery.executorObservation);
    const attempt = recovery.nativeAttempt;
    observedUpstreamFetchCalls =
      typeof attempt.upstreamFetchCalls === 'number'
        ? attempt.upstreamFetchCalls
        : null;
    const nativeExit = await nativeWorker.exit;
    retain({
      kind: 'native_request_terminal_result',
      native_session_id: String(attempt.sessionId),
      provider: 'openrouter',
      model: 'openai/gpt-6-luna',
      endpoint_host: String(attempt.endpointHost),
      endpoint_path: String(attempt.endpointPath),
      process_pid: nativeWorker.pid,
      native_stream_admissions: Number(attempt.streamCalls),
      native_stream_invocations: Number(attempt.streamInvocations),
      blocked_stream_retries: Number(attempt.rejectedStreamInvocations),
      blocked_fetch_retries: Number(attempt.rejectedFetchCalls),
      native_fetch_calls: Number(attempt.fetchCalls),
      loopback_socket_status: String(attempt.routeCode),
      loopback_bytes_sent: Number(attempt.routeBytesSent),
      upstream_fetch_calls: Number(attempt.upstreamFetchCalls),
      response_status:
        typeof attempt.responseStatus === 'number'
          ? attempt.responseStatus
          : null,
      terminal_status: String(attempt.terminalStatus),
      stop_reason: safeStopReason(attempt.stopReason),
      exact_reply: attempt.exactReply === true,
      owned_runtime_stop: String(attempt.runtimeStopStatus),
      global_fetch_unchanged: Boolean(attempt.globalFetchUnchanged),
      worker_exit_code: nativeExit.code,
    });
    assert.equal(attempt.sessionId, started.sessionId);
    assert.equal(attempt.processPid, nativeWorker.pid);
    assert.equal(attempt.provider, 'openrouter');
    assert.equal(attempt.model, 'openai/gpt-6-luna');
    assert.equal(attempt.endpointHost, 'openrouter.ai');
    assert.equal(attempt.endpointPath, '/api/v1/chat/completions');
    assert.equal(attempt.streamCalls, 1);
    assert.ok(Number(attempt.streamInvocations) >= Number(attempt.streamCalls));
    assert.equal(
      Number(attempt.rejectedStreamInvocations),
      Number(attempt.streamInvocations) - Number(attempt.streamCalls),
    );
    assert.equal(attempt.fetchCalls, 1);
    assert.equal(attempt.upstreamFetchCalls, 1);
    assert.equal(attempt.routeCode, 'CONNECTED');
    assert.equal(attempt.routeBytesSent, 0);
    assert.equal(attempt.runtimeStopStatus, 'runtime_disposed');
    assert.equal(
      nativeExit.code,
      attempt.terminalStatus === 'http_200' ? 0 : 86,
    );

    const accepted =
      attempt.terminalStatus === 'http_200' &&
      attempt.responseStatus === 200 &&
      attempt.runtimeStopStatus === 'runtime_disposed' &&
      attempt.stopReason === 'stop' &&
      attempt.exactReply === true &&
      recovery.executorObservation.restart_status === 'applied';
    retain({
      kind: 'probe_result',
      acceptance_passed: accepted,
      native_route_failure_proven: true,
      provider_success_after_restart_proven:
        attempt.terminalStatus === 'http_200',
      provider_terminal_status: String(attempt.terminalStatus),
      upstream_fetch_calls: Number(attempt.upstreamFetchCalls),
      duplicate_effect_free_successful_continuation_proven: accepted,
    });
    evidenceWritten = true;
    console.log(`PROVIDER_NETWORK_RECOVERY_EVIDENCE ${evidenceFile}`);
    assert.equal(
      accepted,
      true,
      'restored native provider call must complete successfully; evidence retains any terminal failure',
    );
  },
);

function makeFlow(sessionId: string, paneId: string): Flow {
  const writer: Identity = { ...TEST_WRITER, session_id: sessionId };
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'pappra-provider-network-recovery-executor-')),
  );
  const domainRoot = join(root, 'domain');
  mkdirSync(domainRoot, { recursive: true });
  const task = join(domainRoot, 'tasks', TEST_TASK);
  let clock = Date.parse('2026-10-20T00:00:00Z');
  initTask(task, {
    taskId: TEST_TASK,
    domainRoot,
    coordinator: TEST_OWNER,
    clock,
  });
  const send = (input: MessageInput): void => {
    const message = buildMessage(input, { clock: (clock += 1_000) });
    const outcome = submitMessage(task, message, { clock: (clock += 1_000) });
    assert.equal(outcome.ok, true, `fixture ${input.type} was not admitted`);
  };
  send({
    message_id: 'provider-network-recovery-assign',
    type: 'ASSIGN',
    task_id: TEST_TASK,
    from: TEST_OWNER,
    to: writer,
    subtask_id: 'work',
    attempt: 1,
    owner_epoch: 1,
    body: {
      assignment_digest: `sha256:${'a'.repeat(64)}`,
      input_revision: TEST_INPUT,
    },
  });

  const planFile = join(root, 'plan.json');
  writeFileSync(
    planFile,
    `${JSON.stringify(
      {
        schema: WORK_PLAN_SCHEMA,
        plan_id: 'plan-provider-network-recovery-fixture',
        task_id: TEST_TASK,
        owner_epoch: 1,
        nodes: [
          {
            node_id: 'work',
            role: 'writer',
            assignment_id: 'work',
            attempt: 1,
            input_revision: TEST_INPUT,
            assignee: {
              agent_id: writer.agent_id,
              session_id: writer.session_id,
            },
            depends_on: [],
            resources: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const bindingFile = join(task, 'recovery-binding.json');
  const bindingText = `${JSON.stringify(
    {
      schema: 'pappra/collab-binding/1',
      task_id: TEST_TASK,
      task_root: task,
      channel: 'herdr',
      participants: [
        {
          agent_id: writer.agent_id,
          harness: 'pi',
          cwd: '/provider-network-recovery-fixture',
          herdr_agent: writer.agent_id,
          pane_id: paneId,
          native_session_id: sessionId,
        },
        {
          agent_id: TEST_OWNER.agent_id,
          harness: 'pi',
          cwd: '/provider-network-recovery-fixture',
          herdr_agent: TEST_OWNER.agent_id,
          pane_id: 'w3:p1',
          native_session_id: TEST_OWNER.session_id,
        },
      ],
    },
    null,
    2,
  )}\n`;
  writeFileSync(bindingFile, bindingText);
  const bindingDigest = `sha256:${createHash('sha256').update(bindingText).digest('hex')}`;

  return {
    root,
    task,
    request: {
      taskRoot: task,
      planFile,
      self: writer,
      policy: { role: 'writer' },
      requestId: `provider-network-recovery-${randomUUID()}`,
      expectedSession: {
        session_id: sessionId,
        cwd: '/provider-network-recovery-fixture',
        binding_digest: bindingDigest,
        binding_ref: bindingFile,
        target_agent: writer.agent_id,
        pane_id: paneId,
        harness: 'pi',
      },
      mode: 'apply',
      maxRetries: 1,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function runUnknownNoReplayCharacterization(
  sessionId: string,
  paneId: string,
): Promise<SafeEvidenceRecord> {
  const flow = makeFlow(sessionId, paneId);
  let first: WorkerHandle | undefined;
  let restarted: WorkerHandle | undefined;
  try {
    first = startWorker(
      EXECUTOR_WORKER,
      { mode: 'unknown', port: 0, request: flow.request },
      ['ignore', 'ignore', 'inherit', 'ipc'],
    );
    const firstResult = await first.waitFor('result', 30_000);
    assert.equal(firstResult.status, 'unknown');
    assert.equal(firstResult.controllerCalls, 1);
    await first.exit;

    restarted = startWorker(
      EXECUTOR_WORKER,
      { mode: 'restart', port: 0, request: flow.request },
      ['ignore', 'ignore', 'inherit', 'ipc'],
    );
    const restartedResult = await restarted.waitFor('result', 30_000);
    assert.equal(restartedResult.status, 'unknown');
    assert.equal(restartedResult.reservationOutcome, 'unknown');
    assert.equal(restartedResult.controllerCalls, 0);
    assert.equal(restartedResult.reservationCreated, false);
    assert.equal(restartedResult.reservationKey, firstResult.reservationKey);
    const exit = await restarted.exit;
    assert.equal(exit.code, 0);
    return {
      kind: 'unknown_no_replay_negative',
      fixture_only: true,
      native_session_id_in_request: sessionId,
      first_status: String(firstResult.status),
      first_controller_calls: Number(firstResult.controllerCalls),
      restarted_status: String(restartedResult.status),
      restarted_controller_calls: Number(restartedResult.controllerCalls),
      redeliveries: 0,
      no_dedup_bypass: true,
    };
  } finally {
    if (first?.child.exitCode === null) {
      first.child.kill('SIGTERM');
      await first.exit;
    }
    if (restarted?.child.exitCode === null) {
      restarted.child.kill('SIGTERM');
      await restarted.exit;
    }
    flow.cleanup();
  }
}

async function runExecutorRestartCharacterization(
  nativeWorker: WorkerHandle,
  sessionId: string,
  paneId: string,
  port: number,
): Promise<{
  readonly executorObservation: SafeEvidenceRecord;
  readonly nativeAttempt: WorkerEvent;
}> {
  const flow = makeFlow(sessionId, paneId);
  let first: WorkerHandle | undefined;
  let restarted: WorkerHandle | undefined;
  let route: GateServer | undefined;
  try {
    first = startWorker(
      EXECUTOR_WORKER,
      { mode: 'crash-after-no-effect', port, request: flow.request },
      ['ignore', 'ignore', 'inherit', 'ipc'],
    );
    const socket = await first.waitFor('socket-observation', 10_000);
    assert.equal(socket.code, 'ECONNREFUSED');
    assert.equal(socket.bytesSent, 0);
    await first.waitFor('retry-waiting', 10_000);

    const reservationDir = join(flow.task, '.recovery', 'reservations');
    const reservationFiles = readdirSync(reservationDir).filter((name) =>
      name.endsWith('.json'),
    );
    assert.equal(reservationFiles.length, 1);
    const reservationPath = join(reservationDir, reservationFiles[0]!);
    const pending = JSON.parse(
      readFileSync(reservationPath, 'utf8'),
    ) as RecoveryReservation;
    assert.equal(pending.journal.length, 1);
    assert.equal(pending.journal[0]!.disposition, 'unavailable');
    assert.equal(pending.journal[0]!.observation, 'none');
    assert.equal(typeof pending.journal[0]!.outcome_at, 'number');
    assert.equal(pending.final, undefined);

    route = await restoredLoopbackGate(port);
    first.send({ type: 'stop-after-no-effect' });
    await first.waitFor('intentional-stop');
    const firstExit = await first.exit;
    assert.equal(firstExit.code, 86);

    restarted = startWorker(
      EXECUTOR_WORKER,
      { mode: 'restart', port, request: flow.request },
      ['ignore', 'ignore', 'inherit', 'ipc'],
    );
    assert.notEqual(restarted.pid, first.pid);
    const nativeRequest = await restarted.waitFor(
      'native-request-needed',
      30_000,
    );
    assert.equal(nativeRequest.sessionId, sessionId);
    nativeWorker.send({ type: 'run-one-native-request' });
    const nativeAttempt = await nativeWorker.waitFor(
      'native-attempt-result',
      120_000,
    );
    assert.equal(nativeAttempt.sessionId, sessionId);
    restarted.send(nativeAttempt);

    const result = await restarted.waitFor('result', 30_000);
    const providerSucceeded =
      nativeAttempt.terminalStatus === 'http_200' &&
      nativeAttempt.runtimeStopStatus === 'runtime_disposed' &&
      nativeAttempt.stopReason === 'stop' &&
      nativeAttempt.exactReply === true;
    assert.equal(result.status, providerSucceeded ? 'applied' : 'unknown');
    assert.equal(result.controllerCalls, 1);
    assert.equal(result.reservationCreated, false);
    assert.equal(result.reservationKey, pending.key);
    assert.equal(route.connections, 1);
    assert.equal((await restarted.exit).code, 0);

    const after = JSON.parse(
      readFileSync(reservationPath, 'utf8'),
    ) as RecoveryReservation;
    assert.equal(after.journal.length, 2);
    assert.ok(after.final !== undefined);
    return {
      nativeAttempt,
      executorObservation: {
        kind: 'executor_restart_characterization',
        fixture_only: true,
        task_namespace:
          'explicit synthetic task fixture; actual SDK session UUID is used in self, binding, and expectedSession',
        native_session_id: sessionId,
        first_process_pid: first.pid,
        restart_process_pid: restarted.pid,
        first_socket_status: 'ECONNREFUSED',
        first_socket_bytes_sent: 0,
        first_disposition: 'unavailable',
        first_observation: 'none',
        journal_entries_before_restart: 1,
        fixture_route_restored: true,
        restart_status: String(result.status),
        restart_controller_calls: Number(result.controllerCalls),
        restored_gate_connections: route.connections,
        redeliveries: 0,
        continuation: providerSucceeded
          ? 'same_cause_resumed_after_owner_death'
          : 'resumed_but_provider_terminal_status_not_success',
        provider_terminal_status: String(nativeAttempt.terminalStatus),
        provider_http_status:
          typeof nativeAttempt.responseStatus === 'number'
            ? nativeAttempt.responseStatus
            : null,
      },
    };
  } finally {
    if (first?.child.exitCode === null) {
      first.child.kill('SIGTERM');
      await first.exit;
    }
    if (restarted?.child.exitCode === null) {
      restarted.child.kill('SIGTERM');
      await restarted.exit;
    }
    if (route) await route.close();
    flow.cleanup();
  }
}

function startWorker(
  worker: string,
  config: unknown,
  stdio: [
    'ignore' | 'inherit',
    'ignore' | 'inherit',
    'ignore' | 'inherit',
    'ipc',
  ],
): WorkerHandle {
  const child = fork(worker, [JSON.stringify(config)], { stdio, execArgv: [] });
  const events: WorkerEvent[] = [];
  const waiters = new Map<string, Array<(event: WorkerEvent) => void>>();
  child.on('message', (value: unknown) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as Record<string, unknown>).type !== 'string'
    )
      return;
    const event = value as WorkerEvent;
    if (event.type === 'fatal') {
      const listeners = [...waiters.values()].flat();
      for (const listener of listeners) listener(event);
      waiters.clear();
      events.push(event);
      return;
    }
    const listeners = waiters.get(event.type);
    const waiter = listeners?.shift();
    if (listeners?.length === 0) waiters.delete(event.type);
    if (waiter) waiter(event);
    else events.push(event);
  });
  child.once('exit', (code, signal) => {
    const pending = [...waiters.values()].flat();
    if (pending.length === 0) return;
    const failure: WorkerEvent = {
      type: 'fatal',
      code: 'worker_exited_before_expected_event',
      exitCode: code ?? null,
      signal: signal ?? null,
      expectedEvents: [...waiters.keys()].join(','),
    };
    for (const listener of pending) listener(failure);
    waiters.clear();
    events.push(failure);
  });
  const exit = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  return {
    child,
    pid: child.pid!,
    exit,
    waitFor(type, timeoutMs = 30_000) {
      const index = events.findIndex((event) => event.type === type);
      if (index >= 0) {
        const event = events.splice(index, 1)[0]!;
        return event.type === 'fatal'
          ? Promise.reject(workerFailure(event))
          : Promise.resolve(event);
      }
      const fatal = events.find((event) => event.type === 'fatal');
      if (fatal) return Promise.reject(workerFailure(fatal));
      return new Promise((resolve, reject) => {
        const onEvent = (event: WorkerEvent): void => {
          clearTimeout(timer);
          if (event.type === 'fatal') reject(workerFailure(event));
          else resolve(event);
        };
        const timer = setTimeout(() => {
          const listeners = waiters.get(type) ?? [];
          waiters.set(
            type,
            listeners.filter((listener) => listener !== onEvent),
          );
          reject(new Error(`timed out waiting for worker event ${type}`));
        }, timeoutMs);
        const listeners = waiters.get(type) ?? [];
        listeners.push(onEvent);
        waiters.set(type, listeners);
      });
    },
    send(message) {
      assert.equal(
        child.connected,
        true,
        'owned worker IPC must remain connected',
      );
      child.send(message);
    },
  };
}

function workerFailure(event: WorkerEvent): Error {
  return new Error(
    `worker failed: ${String(event.code)} exit=${String(event.exitCode)} signal=${String(event.signal)} expected=${String(event.expectedEvents)}`,
  );
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function restoredLoopbackGate(port: number): Promise<GateServer> {
  let connections = 0;
  const server: Server = createServer((socket: Socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    get connections() {
      return connections;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function captureOwnedPane(
  paneId: string,
  expectedPid: number,
): {
  readonly paneIdMatched: boolean;
  readonly processInfoObserved: boolean;
  readonly nativePidObserved: boolean;
} {
  const runNu = (command: string): string => {
    try {
      return execFileSync('nu', ['-lc', command], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
    } catch {
      throw new Error(
        'read-only Herdr observation failed for the owned test pane',
      );
    }
  };
  const pane = parseJson(runNu(`herdr pane get ${paneId}`));
  const processInfo = parseJson(
    runNu(`herdr pane process-info --pane ${paneId}`),
  );
  const info = processInfo as {
    result?: { process_info?: { foreground_processes?: { pid?: number }[] } };
  } | null;
  return {
    paneIdMatched: hasPaneId(pane, paneId),
    processInfoObserved: processInfo !== null,
    nativePidObserved:
      info?.result?.process_info?.foreground_processes?.some(
        (entry) => entry.pid === expectedPid,
      ) === true,
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function hasPaneId(value: unknown, expected: string): boolean {
  if (Array.isArray(value))
    return value.some((item) => hasPaneId(item, expected));
  if (typeof value !== 'object' || value === null) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (
      key.toLowerCase().replace(/[^a-z0-9]/g, '') === 'paneid' &&
      nested === expected
    )
      return true;
    if (hasPaneId(nested, expected)) return true;
  }
  return false;
}

function safeStopReason(value: unknown): string | null {
  return typeof value === 'string' &&
    ['stop', 'length', 'error', 'aborted', 'toolUse'].includes(value)
    ? value
    : null;
}

function validEvidencePath(file: string | undefined): file is string {
  return (
    file !== undefined &&
    isAbsolute(file) &&
    file.startsWith('/private/tmp/') &&
    !existsSync(file)
  );
}

function appendEvidence(
  file: string,
  records: readonly SafeEvidenceRecord[],
): void {
  appendFileSync(
    file,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    { mode: 0o600 },
  );
}

function assertNoProxyEnvironment(): void {
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ])
    assert.equal(
      process.env[name],
      undefined,
      `refusing probe with ${name} set`,
    );
}
