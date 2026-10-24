import assert from 'node:assert/strict';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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

const TASK = 'provider-outage';
const INPUT = `sha256:${'1'.repeat(64)}`;
const OWNER: Coordinator = {
  agent_id: 'coordinator',
  session_id: 'provider-outage-coordinator',
  harness: 'pi',
  owner_epoch: 1,
  since: '2026-10-20T00:00:00Z',
};
const COORDINATOR: Identity = OWNER;
const WRITER: Identity = {
  agent_id: 'writer-a',
  session_id: 'provider-outage-writer',
  harness: 'pi',
};
const WORKER = fileURLToPath(
  new URL('./provider-outage-worker.js', import.meta.url),
);
const SDK_MODULE = process.env.PAPPRA_PROVIDER_OUTAGE_SDK_MODULE;
const PANE_ID = process.env.PAPPRA_PROVIDER_OUTAGE_PANE_ID;
const EVIDENCE_OUTPUT = process.env.PAPPRA_PROVIDER_OUTAGE_EVIDENCE_FILE;
const VALID_PANE_ID =
  PANE_ID !== undefined && /^w3:p(?!R$|B$)[A-Za-z0-9]+$/.test(PANE_ID);
const VALID_EVIDENCE_OUTPUT =
  EVIDENCE_OUTPUT !== undefined &&
  EVIDENCE_OUTPUT.startsWith('/private/tmp/') &&
  isAbsolute(EVIDENCE_OUTPUT) &&
  !existsSync(EVIDENCE_OUTPUT);
const OPTED_IN =
  process.env.PAPPRA_PROVIDER_OUTAGE === '1' &&
  SDK_MODULE !== undefined &&
  isAbsolute(SDK_MODULE) &&
  existsSync(SDK_MODULE) &&
  VALID_PANE_ID &&
  VALID_EVIDENCE_OUTPUT;

type WorkerEvent = { readonly type: string; readonly [key: string]: unknown };

interface WorkerHandle {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly exit: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  waitFor(type: string, timeoutMs?: number): Promise<WorkerEvent>;
}

function makeFlow(): {
  root: string;
  task: string;
  request: RecoveryExecutionRequest;
  cleanup(): void;
} {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'pappra-provider-outage-')),
  );
  const domainRoot = join(root, 'domain');
  mkdirSync(domainRoot, { recursive: true });
  const task = join(domainRoot, 'tasks', TASK);
  let clock = Date.parse('2026-10-20T00:00:00Z');
  initTask(task, { taskId: TASK, domainRoot, coordinator: OWNER, clock });
  const send = (input: MessageInput): void => {
    const message = buildMessage(input, { clock: (clock += 1_000) });
    const outcome = submitMessage(task, message, { clock: (clock += 1_000) });
    assert.equal(
      outcome.ok,
      true,
      `submit ${input.type}: ${JSON.stringify(outcome)}`,
    );
  };
  send({
    message_id: 'provider-outage-assign',
    type: 'ASSIGN',
    task_id: TASK,
    from: COORDINATOR,
    to: WRITER,
    subtask_id: 'work',
    attempt: 1,
    owner_epoch: 1,
    body: {
      assignment_digest: `sha256:${'a'.repeat(64)}`,
      input_revision: INPUT,
    },
  });

  const planFile = join(root, 'plan.json');
  writeFileSync(
    planFile,
    `${JSON.stringify(
      {
        schema: WORK_PLAN_SCHEMA,
        plan_id: 'plan-provider-outage',
        task_id: TASK,
        owner_epoch: 1,
        nodes: [
          {
            node_id: 'work',
            role: 'writer',
            assignment_id: 'work',
            attempt: 1,
            input_revision: INPUT,
            assignee: {
              agent_id: WRITER.agent_id,
              session_id: WRITER.session_id,
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
      task_id: TASK,
      task_root: task,
      channel: 'herdr',
      participants: [
        {
          agent_id: WRITER.agent_id,
          harness: 'pi',
          cwd: '/provider-outage-test',
          herdr_agent: WRITER.agent_id,
          pane_id: 'w3:pM',
          native_session_id: WRITER.session_id,
        },
        {
          agent_id: COORDINATOR.agent_id,
          harness: 'pi',
          cwd: '/provider-outage-test',
          herdr_agent: COORDINATOR.agent_id,
          pane_id: 'w3:pB',
          native_session_id: COORDINATOR.session_id,
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
      self: WRITER,
      policy: { role: 'writer' },
      requestId: 'openrouter-provider-outage',
      expectedSession: {
        session_id: WRITER.session_id,
        cwd: '/provider-outage-test',
        binding_digest: bindingDigest,
        binding_ref: bindingFile,
        target_agent: WRITER.agent_id,
        pane_id: 'w3:pM',
        harness: 'pi',
      },
      mode: 'apply',
      maxRetries: 1,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function startWorker(
  mode: 'provider-call' | 'restart',
  request: RecoveryExecutionRequest,
  evidenceFile: string,
): WorkerHandle {
  const child = fork(
    WORKER,
    [JSON.stringify({ mode, request, evidenceFile })],
    {
      stdio:
        mode === 'provider-call'
          ? ['inherit', 'inherit', 'inherit', 'ipc']
          : ['ignore', 'ignore', 'ignore', 'ipc'],
      env: process.env,
    },
  );
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
    if (
      event.type === 'fatal' ||
      (mode === 'provider-call' && event.type === 'result')
    ) {
      const failure = {
        type: 'fatal',
        message: 'native provider call ended without an interruption witness',
      };
      for (const listeners of waiters.values())
        for (const listener of listeners) listener(failure);
      waiters.clear();
      events.push(failure);
      return;
    }
    const waiter = waiters.get(event.type)?.shift();
    if (waiter) waiter(event);
    else events.push(event);
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
    waitFor(type, timeoutMs = 25_000) {
      const index = events.findIndex((event) => event.type === type);
      if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]!);
      const fatal = events.find((event) => event.type === 'fatal');
      if (fatal)
        return Promise.reject(
          new Error(`provider worker failed: ${String(fatal.message)}`),
        );
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const listeners = waiters.get(type) ?? [];
          waiters.set(
            type,
            listeners.filter((listener) => listener !== onEvent),
          );
          reject(
            new Error(`timed out waiting for provider worker event ${type}`),
          );
        }, timeoutMs);
        const onEvent = (event: WorkerEvent): void => {
          clearTimeout(timer);
          if (event.type === 'fatal')
            reject(
              new Error(`provider worker failed: ${String(event.message)}`),
            );
          else resolve(event);
        };
        const listeners = waiters.get(type) ?? [];
        listeners.push(onEvent);
        waiters.set(type, listeners);
      });
    },
  };
}

function readEvidence(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const SAFE_HERDR_FIELDS = new Set([
  'pane',
  'paneid',
  'process',
  'processinfo',
  'metadata',
  'result',
  'data',
  'agent',
  'agentname',
  'agenttype',
  'agentstatus',
  'agentsession',
  'kind',
  'value',
  'source',
  'foregroundprocesses',
  'foregroundprocessgroupid',
  'shellpid',
  'name',
  'harness',
  'session',
  'sessionid',
  'agentsessionid',
  'pid',
  'processid',
  'processname',
  'processlabel',
  'state',
  'status',
  'lifecyclestate',
]);

function sanitizeHerdrValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeHerdrValue);
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!SAFE_HERDR_FIELDS.has(normalized)) continue;
      const safe = sanitizeHerdrValue(nested);
      if (safe !== undefined) result[key] = safe;
    }
    return result;
  }
  if (typeof value === 'string')
    return /^[A-Za-z0-9._: -]{1,128}$/.test(value) ? value : undefined;
  return typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined;
}

function safeHerdrOutput(raw: string): unknown {
  try {
    return sanitizeHerdrValue(JSON.parse(raw) as unknown);
  } catch {
    const fields: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z _-]+):\s*([A-Za-z0-9._: -]{1,128})\s*$/.exec(
        line,
      );
      if (!match) continue;
      const normalized = match[1]!.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (SAFE_HERDR_FIELDS.has(normalized)) fields[normalized] = match[2]!;
    }
    return fields;
  }
}

function captureOwnedHerdrPane(paneId: string, sessionId: string) {
  if (paneId === 'w3:pR' || paneId === 'w3:pB')
    throw new Error('refusing Herdr metadata capture for a caller/root pane');
  try {
    const pane = execFileSync('herdr', ['pane', 'get', paneId], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const processInfo = execFileSync(
      'herdr',
      ['pane', 'process-info', '--pane', paneId],
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    return {
      kind: 'herdr_owned_pane_observation',
      pane_id: paneId,
      expected_native_session_id: sessionId,
      pane_get_sha256: createHash('sha256').update(pane).digest('hex'),
      process_info_sha256: createHash('sha256')
        .update(processInfo)
        .digest('hex'),
      pane_get: safeHerdrOutput(pane),
      process_info: safeHerdrOutput(processInfo),
    };
  } catch {
    throw new Error('Herdr metadata capture failed for the owned test pane');
  }
}

test(
  'native OpenRouter stream disconnect leaves one unresolved recovery intent and restart does not redeliver',
  {
    timeout: 120_000,
    skip: OPTED_IN
      ? false
      : 'requires opt-in, the pinned SDK module, a fresh owned visible Herdr test pane, and a new /private/tmp sanitized-evidence path',
  },
  async (t) => {
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
        `refusing provider probe with ${name} configured`,
      );

    if (!SDK_MODULE) throw new Error('explicit Pi SDK module path is required');
    const sdkRoot = join(SDK_MODULE, '..', '..');
    const sdkPackage = JSON.parse(
      readFileSync(join(sdkRoot, 'package.json'), 'utf8'),
    ) as { version?: string };
    assert.equal(
      sdkPackage.version,
      '1.4.0',
      'probe is pinned to Pi SDK 1.4.0',
    );

    const flow = makeFlow();
    const evidenceFile = join(flow.root, 'provider-outage-evidence.jsonl');
    writeFileSync(evidenceFile, '', { mode: 0o600 });
    let first: WorkerHandle | undefined;
    let restarted: WorkerHandle | undefined;
    t.after(() => {
      first?.child.kill('SIGKILL');
      restarted?.child.kill('SIGKILL');
      if (EVIDENCE_OUTPUT && !existsSync(EVIDENCE_OUTPUT)) {
        const observations = readEvidence(evidenceFile);
        writeFileSync(
          EVIDENCE_OUTPUT,
          `${[
            ...observations,
            {
              kind: 'probe_incomplete',
              acceptance_passed: false,
              response_witness_observed: observations.some(
                (row) => row.kind === 'native_provider_stream_witness',
              ),
            },
          ]
            .map((row) => JSON.stringify(row))
            .join('\n')}\n`,
          { flag: 'wx', mode: 0o600 },
        );
      }
      flow.cleanup();
    });

    first = startWorker('provider-call', flow.request, evidenceFile);
    const nativeSession = await first.waitFor('native-session-started');
    assert.match(String(nativeSession.sessionId), /^[0-9a-f-]{36}$/i);
    assert.equal(nativeSession.provider, 'openrouter');
    assert.equal(nativeSession.model, 'openai/gpt-6-luna');
    assert.equal(nativeSession.paneId, PANE_ID);
    assert.equal(nativeSession.tools, 0, 'native test task cannot call tools');
    assert.ok(PANE_ID);
    const herdrPaneObservation = captureOwnedHerdrPane(
      PANE_ID,
      String(nativeSession.sessionId),
    );
    writeFileSync(evidenceFile, `${JSON.stringify(herdrPaneObservation)}\n`, {
      flag: 'a',
      mode: 0o600,
    });
    const admittedStream = await first.waitFor('native-stream-admitted');
    assert.equal(admittedStream.provider, 'openrouter');
    assert.equal(admittedStream.model, 'openai/gpt-6-luna');
    assert.equal(admittedStream.admitted_stream_count, 1);

    const witness = await first.waitFor('provider-witness', 90_000);
    assert.equal(witness.provider, 'openrouter');
    assert.equal(witness.model, 'openai/gpt-6-luna');
    assert.equal(witness.admitted_stream_count, 1);
    assert.ok(Number(witness.byte_count) > 0);
    assert.ok(
      witness.witnessType === 'http_response_chunk' ||
        witness.witnessType === 'native_text_delta',
    );
    assert.ok(
      typeof witness.streaming_state === 'object' &&
        witness.streaming_state !== null,
      'the native stream witness includes observed streaming state',
    );
    if (witness.witnessType === 'http_response_chunk')
      assert.equal(
        witness.status,
        200,
        'HTTP 200 was observed at the fetch hook',
      );
    else assert.equal(witness.event_type, 'text_delta');

    const firstExit = await first.exit;
    assert.equal(
      firstExit.code,
      86,
      'the owned worker exits after aborting its one native provider stream',
    );

    const evidence = readEvidence(evidenceFile);
    assert.equal(
      evidence.filter((row) => row.kind === 'native_provider_stream_admitted')
        .length,
      1,
    );
    assert.equal(
      evidence.filter((row) => row.kind === 'native_provider_stream_witness')
        .length,
      1,
    );
    const upstreamRequests = evidence.filter(
      (row) => row.kind === 'openrouter_fetch_started',
    ).length;
    assert.ok(
      upstreamRequests <= 1,
      'at most one hooked upstream fetch was observed',
    );
    if (witness.witnessType === 'http_response_chunk') {
      assert.equal(upstreamRequests, 1);
      assert.equal(
        evidence.filter(
          (row) => row.kind === 'openrouter_response_chunk_observed',
        ).length,
        1,
      );
    }
    assert.equal(
      evidence.some((row) => 'apiKey' in row || 'authorization' in row),
      false,
    );

    const reservationDir = join(flow.task, '.recovery', 'reservations');
    const reservationFiles = readdirSync(reservationDir).filter((name) =>
      name.endsWith('.json'),
    );
    assert.equal(reservationFiles.length, 1);
    const unresolved = JSON.parse(
      readFileSync(join(reservationDir, reservationFiles[0]!), 'utf8'),
    ) as {
      journal: Array<{
        disposition: string | null;
        observation: string | null;
      }>;
      final?: unknown;
    };
    assert.equal(unresolved.journal.length, 1);
    assert.equal(unresolved.journal[0]!.disposition, null);
    assert.equal(unresolved.journal[0]!.observation, null);
    assert.equal(unresolved.final, undefined);

    restarted = startWorker('restart', flow.request, evidenceFile);
    assert.notEqual(
      restarted.pid,
      first.pid,
      'recovery is inspected by a distinct process',
    );
    const result = await restarted.waitFor('result');
    assert.equal((await restarted.exit).code, 0);
    assert.equal(result.status, 'unknown');
    assert.equal(
      result.controllerCalls,
      0,
      'unresolved provider effect blocks controller dispatch',
    );
    const postRestartEvidence = readEvidence(evidenceFile);
    assert.equal(
      postRestartEvidence.filter(
        (row) => row.kind === 'openrouter_fetch_started',
      ).length,
      upstreamRequests,
      'restart did not trigger another hooked OpenRouter request',
    );
    assert.ok(EVIDENCE_OUTPUT);
    const durableEvidence = [
      ...postRestartEvidence,
      {
        kind: 'recovery_restart_result',
        status: 'unknown',
        controller_calls: 0,
        upstream_requests: upstreamRequests,
        witness_type: witness.witnessType,
        redeliveries: 0,
      },
    ];
    writeFileSync(
      EVIDENCE_OUTPUT,
      `${durableEvidence.map((record) => JSON.stringify(record)).join('\n')}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    console.log(`NATIVE_PROVIDER_OUTAGE_EVIDENCE ${EVIDENCE_OUTPUT}`);
  },
);
