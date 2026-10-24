import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  buildMessage,
  messageFile,
  sha256File,
} from '../../src/collab/envelope.js';
import { bindNative } from '../../src/collab/lifecycle.js';
import { submitMessage } from '../../src/collab/messages.js';
import { claimResources } from '../../src/collab/resources.js';
import { readRecord, transact } from '../../src/collab/store.js';
import type {
  Identity,
  LaunchReservation,
  Message,
  MessageInput,
  TaskRecord,
} from '../../src/collab/types.js';
import { collabBindingSchema } from '../../src/schemas/collaboration.js';
import { saveHandoffBundle } from '../../src/continuity/index.js';
import {
  continuityTaskPaths,
  writeContinuityBytes,
} from '../../src/continuity/paths.js';
import {
  COLLAB_BOOTSTRAP_REPORT_SCHEMA,
  type LoadedVisibleBootstrapRequest,
  type VisibleBootstrapReport,
  type VisibleBootstrapRequest,
} from '../../src/app/collab-bootstrap.js';
import type {
  HerdrAgentObservation,
  HerdrListResult,
} from '../../src/app/collab-notify.js';
import type { HerdrBootstrapOps } from '../../src/app/collab-bootstrap-transport.js';
import {
  applySessionTransition,
  loadSessionTransitionRequest,
  MANAGED_PI_EXECUTION_SCOPE_SCHEMA,
  type SessionTransitionBootstrapExecutor,
  type SessionTransitionDependencies,
  type SessionTransitionHost,
  type SessionTransitionJournal,
  type SessionTransitionRequest,
} from '../../src/app/collab-session-transition.js';
import {
  bindManagedPiExecutionScope,
  createManagedPiTransitionHost,
  isTrustedManagedPiScopedProof,
} from '../../src/app/managed-pi-transition-host.js';
import { ManagedPiJournal } from '../../src/hosts/pi/managed-session.js';
import {
  ManagedPiSdkIngressFence,
  ManagedPiSdkSessionController,
  type ManagedPiSdkInteractiveModePort,
  type ManagedPiSdkRuntimePort,
  type ManagedPiSdkSessionPort,
} from '../../src/hosts/pi/managed-sdk-session.js';
import { RolloverFreezeController } from '../../src/hosts/integration/pi-rollover-extension.js';
import { makeTaskDomain } from './task-resources-fixtures.js';
import {
  baseWorkspaceConfig,
  workspaceId,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

const TASK_ID = 'sample';
const SUBTASK_ID = 'work';
const CONTINUITY_TASK_ID = 'continuity-sample';
const INTENT_ID = 'intent-transition-1';
const HANDOFF_ID = 'handoff-transition-1';
const COORDINATOR: Identity & {
  readonly owner_epoch: number;
  readonly since: string;
} = {
  agent_id: 'coordinator',
  session_id: 'coord-session',
  harness: 'pi',
  owner_epoch: 1,
  since: '2026-10-20T00:00:00.000Z',
};

// FIXTURE BLOCK
interface TransitionFixture {
  readonly domainRoot: string;
  readonly root: string;
  readonly taskRoot: string;
  readonly cwd: string;
  readonly assignmentFile: string;
  readonly cardFile: string;
  readonly baseBindingFile: string;
  readonly bootstrapRequestFile: string;
  readonly transitionRequestFile: string;
  readonly request: SessionTransitionRequest;
  readonly bootstrapRequest: VisibleBootstrapRequest;
  readonly claimId: string;
  readonly inputRevision: string;
  readonly cleanup: () => void;
  writeRequest(
    evidence: SessionTransitionRequest['evidence'],
  ): ReturnType<typeof loadSessionTransitionRequest>;
  send(input: MessageInput): Message;
  load(): TaskRecord;
}

function digest(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function checkpointBytes(checkpointId: string): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schema: 'pappra/checkpoint/1',
        checkpointId,
        taskId: CONTINUITY_TASK_ID,
        workspaceId,
        revision: 1,
        previousDigest: null,
        createdAt: '2026-10-20T00:00:00.000Z',
        authorSession: SOURCE.session_id,
        objective: 'Exercise the guarded session-transition stages.',
        acceptance: [],
        constraints: ['No test fixture represents a native Pi stop proof.'],
        decisions: [],
        attempted: [],
        nextActions: [],
        limitations: [],
        repositories: [],
        artifacts: [],
        validations: [],
        nativeRefs: [],
        collaborationRecordRef: null,
        contextCompleteness: 'complete',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

let sourceCwd = '';
const SOURCE: Identity = {
  agent_id: 'writer-a',
  session_id: '11111111-1111-4111-8111-111111111111',
  harness: 'pi',
  get cwd() {
    return sourceCwd;
  },
};
const SUCCESSOR: Identity = {
  agent_id: 'writer-b',
  session_id: '22222222-2222-4222-8222-222222222222',
  harness: 'pi',
  get cwd() {
    return sourceCwd;
  },
};

async function fixture(label: string): Promise<TransitionFixture> {
  const domain = makeTaskDomain(`session-transition-${label}`, [TASK_ID]);
  const domainRoot = domain.domainRoot;
  const taskRoot = domain.tasks[TASK_ID]!;
  const root = domain.root;
  const cwd = join(root, 'workspace');
  sourceCwd = cwd;
  mkdirSync(cwd, { recursive: true });
  const workPath = join(cwd, 'work');
  mkdirSync(workPath, { recursive: true });
  const inputFile = join(root, 'input.json');
  writeFileSync(inputFile, '{"input":"transition-fixture"}\n');
  const inputRevision = sha256File(inputFile);

  const claimed = claimResources(taskRoot, {
    resources: [{ kind: 'path', path: workPath }],
    holder: SOURCE,
    subtaskId: SUBTASK_ID,
    attempt: 1,
    clock: Date.parse('2026-10-20T00:00:00Z'),
  });
  assert.ok(claimed.ok, JSON.stringify(claimed));
  const claim = claimed.claims[0]!;

  const assignment = {
    schema: 'harness-collab/assignment/1',
    task_id: TASK_ID,
    assignment_id: SUBTASK_ID,
    objective: 'Exercise a resumable session transition.',
    attempt: 1,
    roles: ['writer'],
    acceptance: ['The transition is guarded and resumable.'],
    coordinator: { ...COORDINATOR },
    assignee: {
      ...SOURCE,
      surface: 'cli',
      configuration_id: 'fixture-config',
    },
    inputs: [{ ref: inputFile, digest: inputRevision }],
    resources: [
      { path: workPath, access: 'write', resource_epoch: claim.resource_epoch },
    ],
    runner: {
      name: 'pi-cli',
      mode: 'existing-session',
      omitted_capabilities: [],
    },
    required: { skills: [], tools: [] },
    preferred: { skills: [], tools: [] },
  };
  const assignmentFile = join(root, 'assignment.json');
  writeJson(assignmentFile, assignment);
  const assignmentDigest = sha256File(assignmentFile);
  const cardFile = join(root, 'source-card.json');
  writeJson(cardFile, {
    schema: 'harness-collab/capabilities/1',
    agent_id: SOURCE.agent_id,
    session_id: SOURCE.session_id,
    harness: 'pi',
    surface: 'cli',
    configuration_id: 'fixture-config',
    cwd,
    observed_at: new Date().toISOString(),
    evidence_level: 'runtime',
    skills: [],
    tools: [],
  });

  let messageClock = Date.parse('2026-10-20T00:01:00Z');
  const send = (input: MessageInput): Message => {
    const message = buildMessage(input, { clock: (messageClock += 1000) });
    const submitted = submitMessage(taskRoot, message, {
      clock: (messageClock += 1000),
    });
    assert.equal(
      submitted.ok,
      true,
      `${input.type}: ${JSON.stringify(submitted)}`,
    );
    return message;
  };
  send({
    message_id: 'msg-assignment-work',
    type: 'ASSIGN',
    task_id: TASK_ID,
    from: COORDINATOR,
    to: SOURCE,
    subtask_id: SUBTASK_ID,
    attempt: 1,
    owner_epoch: 1,
    body: {
      assignment_ref: assignmentFile,
      assignment_digest: assignmentDigest,
      input_revision: inputRevision,
    },
  });
  const sourceNative = transact(taskRoot, {
    actor: 'session-transition-fixture',
    purpose: 'fixture-bind-source-native',
    clock: Date.parse('2026-10-20T00:02:00Z'),
    apply: (record) => {
      const bound = bindNative(record, {
        subtaskId: SUBTASK_ID,
        attempt: 1,
        runner: 'pi',
        sessionId: SOURCE.session_id,
        runId: 'run-source',
        missionId: null,
        observation: 'confirmed',
        evidenceRef: 'fixture-only:source-session-reference',
        observedAt: '2026-10-20T00:02:00.000Z',
      });
      if (!bound.ok) return bound;
      return {
        record,
        op: 'fixture-bind-source-native',
        summary: {},
        result: bound,
      };
    },
  });
  assert.equal(sourceNative.ok, true, JSON.stringify(sourceNative));

  const baseBindingFile = join(
    taskRoot,
    'notifications',
    'source-binding.json',
  );
  const baseBinding = {
    schema: 'pappra/collab-binding/1',
    task_id: TASK_ID,
    task_root: taskRoot,
    channel: 'herdr',
    participants: [
      {
        agent_id: SOURCE.agent_id,
        harness: 'pi',
        cwd,
        herdr_agent: 'pappra-source',
        native_session_id: SOURCE.session_id,
        pane_id: 'w1:p1',
      },
    ],
  };
  const checkedBinding = collabBindingSchema.safeParse(baseBinding);
  assert.ok(checkedBinding.success, JSON.stringify(checkedBinding));
  writeJson(baseBindingFile, baseBinding);
  const status = send({
    message_id: 'msg-transition-pointer',
    type: 'STATUS',
    reply_to: 'msg-assignment-work',
    task_id: TASK_ID,
    from: SOURCE,
    to: SUCCESSOR,
    subtask_id: SUBTASK_ID,
    attempt: 1,
    owner_epoch: 1,
    body: {
      status: 'running',
      input_revision: inputRevision,
      handoff_id: HANDOFF_ID,
      rollover_intent_id: INTENT_ID,
      rollover_generation: 1,
    },
  });

  const workspaceRoot = join(root, 'workspace-root');
  mkdirSync(workspaceRoot, { recursive: true });
  writeWorkspaceConfig(workspaceRoot, baseWorkspaceConfig());
  const continuityTaskId = CONTINUITY_TASK_ID;
  const paths = continuityTaskPaths(workspaceRoot, continuityTaskId);
  const checkpointId = randomUUID();
  const checkpointName = `${checkpointId}.json`;
  const checkpointFile = join(paths.checkpointsDir, checkpointName);
  const checkpointWrite = await writeContinuityBytes(
    workspaceRoot,
    continuityTaskId,
    checkpointFile,
    checkpointBytes(checkpointId),
    true,
    {},
  );
  assert.ok(checkpointWrite.ok, JSON.stringify(checkpointWrite));
  const record = readRecord(taskRoot);
  assert.ok(record);
  const savedBundle = await saveHandoffBundle({
    root: workspaceRoot,
    continuityTaskId,
    checkpoint: {
      checkpointId,
      taskId: continuityTaskId,
      workspaceId,
      ref: `checkpoints/${checkpointName}`,
      digest: checkpointWrite.value.digest,
      authorSession: SOURCE.session_id,
      contextCompleteness: 'complete',
    },
    collaboration: {
      taskId: TASK_ID,
      attempt: 1,
      ownerEpoch: 1,
      subtaskId: SUBTASK_ID,
      inputRevision,
      association: `Continuity ${continuityTaskId} backs collaboration task ${TASK_ID}.`,
    },
    sourceNativeSession: {
      harness: 'pi',
      sessionId: SOURCE.session_id,
      agentId: SOURCE.agent_id,
      paneId: 'w1:p1',
      surface: 'cli',
      configurationId: 'fixture-config',
      modelObservation: { model: null, provider: null, reasoning: null },
    },
    handoff: {
      claims: (record.claims ?? []).map((item) => ({
        claimId: item.claim_id,
        resource: item.path ?? item.key,
        resourceEpoch: item.resource_epoch,
        holder: item.holder.agent_id,
      })),
      claimsCompleteness: 'complete',
      pendingTools: { items: [], completeness: 'complete' },
      pendingMessages: { items: [], completeness: 'complete' },
      pendingApprovals: { items: [], completeness: 'complete' },
      nextAction: 'Inspect only',
      recovery: [],
      executionAuthority: 'none',
      advisory: true,
    },
  });
  assert.ok(savedBundle.ok, JSON.stringify(savedBundle));

  const exportedBundle = join(root, 'exported-bootstrap');
  const extensionDirectory = join(
    exportedBundle,
    'extensions',
    'pappra-bootstrap',
  );
  const configFile = join(extensionDirectory, 'bootstrap.json');
  writeJson(configFile, {
    schema: 'pappra/pi-bootstrap-config/1',
    domainRoot,
    taskId: TASK_ID,
    guard: {
      taskId: TASK_ID,
      intentId: INTENT_ID,
      handoffId: HANDOFF_ID,
      generation: 1,
      subtaskId: SUBTASK_ID,
      attempt: 1,
      inputRevision,
      coordinatorEpoch: 1,
      successor: {
        agentId: SUCCESSOR.agent_id,
        sessionId: SUCCESSOR.session_id,
        harness: 'pi',
      },
      claims: [
        {
          claimId: claim.claim_id,
          originalResourceEpoch: claim.resource_epoch,
        },
      ],
    },
  });
  const extensionEntry = join(extensionDirectory, 'index.ts');
  writeFileSync(extensionEntry, 'export default function fixture(): void {}\n');
  const bootstrapRequest: VisibleBootstrapRequest = {
    schema: 'pappra/collab-bootstrap-request/1',
    request_id: 'bootstrap-transition-1',
    task_root: taskRoot,
    admission: {
      assignment_id: SUBTASK_ID,
      subtask_id: SUBTASK_ID,
      attempt: 1,
      input_revision: inputRevision,
      capability_card_ref: cardFile,
      capability_card_digest: sha256File(cardFile),
    },
    caller: { require_herdr_env: true, pane_id: 'w1:p1' },
    participant: {
      agent_id: SUCCESSOR.agent_id,
      harness: 'pi',
      native_session_selector: SUCCESSOR.session_id,
      herdr_agent: 'pappra-successor',
    },
    target: {
      choice: 'sibling',
      cwd,
      direction: 'right',
      preserve_focus: true,
    },
    selected_model: {
      preserve_daily: true,
      openrouter_model: 'openai/gpt-6-luna',
    },
    bootstrap: {
      config_ref: configFile,
      config_digest: sha256File(configFile),
      bundle_ref: exportedBundle,
      bundle_digest: digest('fixture bootstrap manifest; test-only'),
      extension_entry: extensionEntry,
    },
    message_pointer: {
      message_id: status.message_id,
      content_ref: messageFile(taskRoot, status.message_id),
      content_digest: sha256File(messageFile(taskRoot, status.message_id)),
    },
    binding_ref: baseBindingFile,
  };
  const bootstrapRequestFile = join(root, 'bootstrap-request.json');
  writeJson(bootstrapRequestFile, bootstrapRequest);
  const claimEpoch = claim.resource_epoch;
  const request: SessionTransitionRequest = {
    schema: 'pappra/collaboration-session-transition-request/1',
    task_root: taskRoot,
    transition_id: INTENT_ID,
    intent: {
      intent_id: INTENT_ID,
      generation: 1,
      handoff_id: HANDOFF_ID,
      subtask_id: SUBTASK_ID,
      attempt: 1,
      input_revision: inputRevision,
      from: SOURCE,
      to: SUCCESSOR,
      claims: [{ claim_id: claim.claim_id, resource_epoch: claimEpoch }],
      coordinator_epoch: 1,
    },
    bundle: {
      root: workspaceRoot,
      continuity_task_id: continuityTaskId,
      bundle_id: savedBundle.value.bundleId,
      digest: savedBundle.value.digest,
    },
    bootstrap_request: {
      ref: bootstrapRequestFile,
      digest: sha256File(bootstrapRequestFile),
    },
    evidence: { ack_message_id: null, first_work_report_id: null },
    archive_mode: 'task-retirement',
    managed_execution_scope: {
      schema: MANAGED_PI_EXECUTION_SCOPE_SCHEMA,
      task_id: TASK_ID,
      task_root: taskRoot,
      session_id: SOURCE.session_id,
      cwd,
      subtask_id: SUBTASK_ID,
      attempt: 1,
      owner_epoch: 1,
      claim_epochs: [{ claim_id: claim.claim_id, resource_epoch: claimEpoch }],
    },
  };
  const transitionRequestFile = join(root, 'transition-request.json');
  writeJson(transitionRequestFile, request);
  const loaded = loadSessionTransitionRequest(transitionRequestFile);
  assert.equal(loaded.ok, true, JSON.stringify(loaded));

  return {
    domainRoot,
    root,
    taskRoot,
    cwd,
    assignmentFile,
    cardFile,
    baseBindingFile,
    bootstrapRequestFile,
    transitionRequestFile,
    request,
    bootstrapRequest,
    claimId: claim.claim_id,
    inputRevision,
    cleanup: domain.cleanup,
    writeRequest(evidence) {
      const next = { ...request, evidence };
      writeJson(transitionRequestFile, next);
      return loadSessionTransitionRequest(transitionRequestFile);
    },
    send,
    load() {
      const current = readRecord(taskRoot);
      assert.ok(current);
      return current;
    },
  };
}
function bootstrapReport(
  request: LoadedVisibleBootstrapRequest,
  action: 'plan' | 'apply',
  status: 'planned' | 'applied' | 'already_recorded',
): VisibleBootstrapReport {
  return {
    schema: COLLAB_BOOTSTRAP_REPORT_SCHEMA,
    action,
    ok: true,
    status,
    code: null,
    message: null,
    next_action: null,
    request_id: request.request.request_id,
    request_digest: request.digest,
    task_id: TASK_ID,
    task_root: request.request.task_root,
    state_revision: null,
    caller: null,
    participant: null,
    target: null,
    bootstrap: null,
    reservation: null,
    readiness: null,
    effects: [],
    notification: null,
    downstream: {
      host_stop_proof: 'unavailable',
      first_work: 'unverified',
      routing_removal: 'pending',
      native_archive: 'unavailable',
    },
    limits: ['test-only bootstrap fixture; not native Pi capability evidence'],
  };
}

class FixtureBootstrap implements SessionTransitionBootstrapExecutor {
  applyCalls = 0;
  #reserved = false;

  constructor(private readonly value: TransitionFixture) {}

  async plan(
    request: LoadedVisibleBootstrapRequest,
  ): Promise<VisibleBootstrapReport> {
    return bootstrapReport(request, 'plan', 'planned');
  }

  async apply(
    request: LoadedVisibleBootstrapRequest,
  ): Promise<VisibleBootstrapReport> {
    this.applyCalls += 1;
    if (this.#reserved)
      return bootstrapReport(request, 'apply', 'already_recorded');
    const bindingFile = join(
      this.value.taskRoot,
      'notifications',
      'visible-bootstrap-bindings',
      `${request.request.request_id}.json`,
    );
    writeJson(bindingFile, {
      schema: 'pappra/collab-binding/1',
      task_id: TASK_ID,
      task_root: this.value.taskRoot,
      channel: 'herdr',
      participants: [
        {
          agent_id: SOURCE.agent_id,
          harness: 'pi',
          native_session_id: SOURCE.session_id,
          cwd: this.value.cwd,
          herdr_agent: 'pappra-source',
          pane_id: 'w1:p1',
        },
        {
          agent_id: SUCCESSOR.agent_id,
          harness: 'pi',
          cwd: this.value.cwd,
          herdr_agent: 'pappra-successor',
          native_session_id: SUCCESSOR.session_id,
          pane_id: 'w1:p2',
        },
      ],
    });
    const reservation: LaunchReservation = {
      reservation_id: `bootstrap-${request.request.request_id}`,
      subtask_id: SUBTASK_ID,
      attempt: 1,
      kind: 'pi',
      mode: 'visible-bootstrap',
      holder: SOURCE,
      requested_session_id: SUCCESSOR.session_id,
      transport: 'herdr',
      reserved_at: new Date().toISOString(),
      released_at: new Date().toISOString(),
      outcome: 'submitted',
      phase: 'completed',
      bootstrap: {
        request_id: request.request.request_id,
        request_digest: request.digest,
        request_file: request.file,
        target_choice: 'sibling',
        participant_agent_id: SUCCESSOR.agent_id,
        participant_session_id: SUCCESSOR.session_id,
        config_digest: request.request.bootstrap.config_digest,
        bundle_manifest_digest: request.request.bootstrap.bundle_digest,
        herdr_agent: 'pappra-successor',
        binding_file: bindingFile,
        message_id: request.request.message_pointer.message_id,
        message_digest: request.request.message_pointer.content_digest,
        phase: 'completed',
        receipts: [],
      },
    };
    const saved = transact(this.value.taskRoot, {
      actor: SOURCE.agent_id,
      purpose: 'fixture-visible-bootstrap-complete',
      clock: Date.now(),
      apply: (record) => {
        const prior = (record.launch_reservations ?? []).find((entry) => {
          const bootstrap = (
            entry as LaunchReservation & { readonly bootstrap?: unknown }
          ).bootstrap;
          return (
            typeof bootstrap === 'object' &&
            bootstrap !== null &&
            (bootstrap as Record<string, unknown>)['request_id'] ===
              request.request.request_id
          );
        });
        if (prior !== undefined)
          return {
            record,
            op: 'fixture-visible-bootstrap-replay',
            summary: {},
            result: { replayed: true },
          };
        record.launch_reservations = [
          ...(record.launch_reservations ?? []),
          reservation,
        ];
        return {
          record,
          op: 'fixture-visible-bootstrap',
          summary: {},
          result: { replayed: false },
        };
      },
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    this.#reserved = true;
    return bootstrapReport(request, 'apply', 'applied');
  }
}
function fakeHerdr(onList?: () => void): HerdrBootstrapOps {
  const agent: HerdrAgentObservation = {
    name: 'pappra-successor',
    harness: 'pi',
    paneId: 'w1:p2',
    cwd: sourceCwd,
    sessionValue: SUCCESSOR.session_id,
    sessionKind: 'id',
    status: 'working',
    focused: false,
  };
  const result: HerdrListResult = { ok: true, agents: [agent] };
  return {
    id: 'test-only-herdr',
    listAgents: async () => {
      onList?.();
      return result;
    },
  } as unknown as HerdrBootstrapOps;
}

function transitionDeps(
  host: SessionTransitionHost,
  bootstrap: SessionTransitionBootstrapExecutor,
  herdr: HerdrBootstrapOps = fakeHerdr(),
): SessionTransitionDependencies {
  return { host, bootstrap, herdr };
}

function liveSdkController(
  value: TransitionFixture,
  mutate?: (
    session: Record<string, unknown>,
    mode: Record<string, unknown>,
  ) => void,
) {
  const journalPath = join(value.root, 'managed-sdk.jsonl');
  const journal = new ManagedPiJournal(
    journalPath,
    openSync(journalPath, 'wx', 0o600),
    'managed-pi-transition-test',
  );
  const session = {
    agent: {
      state: { pendingToolCalls: new Set<string>() },
      streamFunction: () => undefined,
    },
    sessionId: SOURCE.session_id,
    sessionFile: join(value.root, 'session.jsonl'),
    model: { id: 'fixture-model', provider: 'openrouter' },
    thinkingLevel: 'high',
    isStreaming: false,
    isCompacting: false,
    isIdle: true,
    isBashRunning: false,
    hasPendingBashMessages: false,
    pendingMessageCount: 0,
    state: { pendingToolCalls: new Set<string>() },
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getContextUsage: () => undefined,
    compact: async () => ({ summary: 'fixture' }),
    subscribe: () => () => undefined,
    abort: async () => undefined,
    waitForIdle: async () => undefined,
    prompt: async () => undefined,
    steer: async () => undefined,
    followUp: async () => undefined,
    sendUserMessage: async () => undefined,
    sendCustomMessage: async () => undefined,
    executeBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    abortBash: () => undefined,
    bindExtensions: async () => undefined,
    _pendingNextTurnMessages: [] as unknown[],
    _pendingCustomMessages: [] as unknown[],
    _pendingBashMessages: [] as unknown[],
    _deferredSettledActions: [] as unknown[],
  } as unknown as ManagedPiSdkSessionPort & Record<string, unknown>;
  const mode = {
    init: async () => undefined,
    run: async () => undefined,
    stop: () => undefined,
    pendingUserInputs: [] as string[],
    compactionQueuedMessages: [] as unknown[],
    extensionDialogs: [] as unknown[],
    activeSelectorToken: undefined as string | undefined,
  } as unknown as ManagedPiSdkInteractiveModePort & Record<string, unknown>;
  mutate?.(session, mode);
  const runtime: ManagedPiSdkRuntimePort = {
    session,
    cwd: value.cwd,
    setRebindSession: () => undefined,
    dispose: async () => undefined,
  };
  const controller = new ManagedPiSdkSessionController({
    runtime,
    interactiveMode: mode,
    fence: new ManagedPiSdkIngressFence(journal),
    journal,
    model: 'fixture-model',
    nativeIdentity: {
      agentId: SOURCE.agent_id,
      paneId: 'w1:p1',
      surface: 'pi-sdk-tui',
      configurationId: 'fixture-config',
    },
    quiesceTimeoutMs: 100,
  });
  return { controller, journal, session, mode };
}

async function liveTransitionHost(value: TransitionFixture) {
  const { controller, journal, session, mode } = liveSdkController(value);
  const scope = value.request.managed_execution_scope!;
  const binding = await bindManagedPiExecutionScope({ controller, scope });
  const freezeController = new RolloverFreezeController({
    sessionId: SOURCE.session_id,
  });
  const host = createManagedPiTransitionHost({
    controller,
    freezeController,
    binding,
  });
  return { controller, journal, session, mode, freezeController, host };
}

test('live SDK-owned scoped proof reaches prepared then receiver ACK transfers claims using fresh v2 receipts', async () => {
  const value = await fixture('managed-pi-scoped-live');
  let journal: ManagedPiJournal | undefined;
  try {
    const live = await liveTransitionHost(value);
    journal = live.journal;
    const bootstrap = new FixtureBootstrap(value);
    const deps = transitionDeps(live.host, bootstrap);

    const prepared = await applySessionTransition(value.request, deps);
    assert.equal(prepared.status, 'progressed', JSON.stringify(prepared));
    assert.equal(prepared.stage, 'prepared');
    const proof = (await live.host.observe()).proof;
    assert.equal(isTrustedManagedPiScopedProof(proof), true);
    assert.equal(
      isTrustedManagedPiScopedProof(JSON.parse(JSON.stringify(proof))),
      false,
    );
    const sourceReceipt = (
      value.load().session_transition_journal as SessionTransitionJournal
    ).entries[0]?.source_quiescence_receipt;
    assert.equal(
      sourceReceipt?.schema,
      'pappra/session-transition-quiescence-receipt/2',
    );
    assert.match(
      sourceReceipt?.execution_scope_digest ?? '',
      /^sha256:[0-9a-f]{64}$/,
    );

    const waiting = await applySessionTransition(value.request, deps);
    assert.equal(waiting.status, 'waiting', JSON.stringify(waiting));
    assert.equal(bootstrap.applyCalls, 1);
    const ack = value.send({
      message_id: 'msg-managed-pi-successor-ack',
      type: 'ACK',
      task_id: TASK_ID,
      from: SUCCESSOR,
      to: COORDINATOR,
      reply_to: 'msg-assignment-work',
      subtask_id: SUBTASK_ID,
      attempt: 1,
      owner_epoch: 1,
      body: {
        handoff_id: HANDOFF_ID,
        rollover_intent_id: INTENT_ID,
        rollover_generation: 1,
        input_revision: value.inputRevision,
      },
    });
    const ackRequest = value.writeRequest({
      ack_message_id: ack.message_id,
      first_work_report_id: null,
    });
    assert.ok(ackRequest.ok, JSON.stringify(ackRequest));
    if (!ackRequest.ok) return;
    const transferred = await applySessionTransition(ackRequest.value, deps);
    assert.equal(transferred.status, 'progressed', JSON.stringify(transferred));
    assert.equal(transferred.stage, 'awaiting_first_work');
    assert.equal(value.load().handoffs?.[0]?.state, 'completed');
    assert.equal(value.load().claims?.[0]?.holder.agent_id, SUCCESSOR.agent_id);
    const transferReceipt = (
      value.load().session_transition_journal as SessionTransitionJournal
    ).entries[0]?.transfer_quiescence_receipt;
    assert.equal(
      transferReceipt?.schema,
      'pappra/session-transition-quiescence-receipt/2',
    );
    assert.ok(
      (transferReceipt?.sequence ?? 0) > (sourceReceipt?.sequence ?? 0),
    );
    assert.equal(
      transferReceipt?.execution_scope_digest,
      sourceReceipt?.execution_scope_digest,
    );
  } finally {
    journal?.close();
    value.cleanup();
  }
});

test('prelaunch execution binding refuses unknown, queued, approval, mismatched and stale scopes', async () => {
  for (const state of [
    'unknown-queue',
    'queued-message',
    'approval',
    'session-mismatch',
    'stale-owner',
    'wrong-claim-attempt',
  ] as const) {
    const value = await fixture(`managed-pi-bind-${state}`);
    let journal: ManagedPiJournal | undefined;
    try {
      const { controller, session, mode } = liveSdkController(value);
      journal = (
        controller as unknown as { input: { journal: ManagedPiJournal } }
      ).input.journal;
      if (state === 'unknown-queue')
        session['_pendingNextTurnMessages'] = undefined;
      if (state === 'queued-message')
        session['_pendingNextTurnMessages'] = [{ role: 'user' }];
      if (state === 'approval')
        mode['extensionDialogs'] = [
          {
            id: 'approval',
            kind: 'confirm',
            startedAt: new Date().toISOString(),
          },
        ];
      if (state === 'stale-owner') {
        const changed = transact(value.taskRoot, {
          actor: 'test',
          purpose: 'test-stale-owner',
          apply: (record) => {
            if (record.coordinator === null)
              return { ok: false as const, reason: 'coordinator_missing' };
            record.coordinator.owner_epoch = 2;
            return {
              record,
              op: 'test-stale-owner',
              summary: {},
              result: null,
            };
          },
        });
        assert.ok(changed.ok, JSON.stringify(changed));
      }
      if (state === 'wrong-claim-attempt') {
        const changed = transact(value.taskRoot, {
          actor: 'test',
          purpose: 'claim-attempt-drift',
          apply(record) {
            assert.ok(record.claims[0]);
            record.claims[0].attempt = 2;
            return {
              record,
              op: 'claim-attempt-drift',
              summary: {},
              result: null,
            };
          },
        });
        assert.ok(changed.ok);
      }
      const scope =
        state === 'session-mismatch'
          ? {
              ...value.request.managed_execution_scope!,
              session_id: SUCCESSOR.session_id,
            }
          : value.request.managed_execution_scope!;
      await assert.rejects(
        () => bindManagedPiExecutionScope({ controller, scope }),
        /managed_pi_execution_scope_/,
        state,
      );
    } finally {
      journal?.close();
      value.cleanup();
    }
  }
});

test('live scoped proof fails closed for post-bind unknown queues, queued messages and pending approval', async () => {
  for (const state of [
    'unknown-queue',
    'queued-message',
    'approval',
  ] as const) {
    const value = await fixture(`managed-pi-live-${state}`);
    let journal: ManagedPiJournal | undefined;
    try {
      const live = await liveTransitionHost(value);
      journal = live.journal;
      if (state === 'unknown-queue')
        live.session['_pendingNextTurnMessages'] = undefined;
      if (state === 'queued-message')
        live.session['_pendingNextTurnMessages'] = [{ role: 'user' }];
      if (state === 'approval')
        live.mode['extensionDialogs'] = [
          {
            id: 'approval',
            kind: 'confirm',
            startedAt: new Date().toISOString(),
          },
        ];
      const bootstrap = new FixtureBootstrap(value);
      const report = await applySessionTransition(
        value.request,
        transitionDeps(live.host, bootstrap),
      );
      assert.equal(report.status, 'waiting', JSON.stringify(report));
      assert.equal(report.code, 'host_quiescence_proof_invalid');
      assert.equal(bootstrap.applyCalls, 0);
      assert.notEqual(value.load().handoffs?.[0]?.state, 'completed');
    } finally {
      journal?.close();
      value.cleanup();
    }
  }
});

test('scoped v2 proof cannot be consumed by an unscoped legacy transition request', async () => {
  const value = await fixture('managed-pi-legacy-refusal');
  let journal: ManagedPiJournal | undefined;
  try {
    const live = await liveTransitionHost(value);
    journal = live.journal;
    const { managed_execution_scope: _scope, ...legacyRequest } = value.request;
    const bootstrap = new FixtureBootstrap(value);
    const report = await applySessionTransition(
      legacyRequest,
      transitionDeps(live.host, bootstrap),
    );
    assert.equal(report.status, 'waiting', JSON.stringify(report));
    assert.equal(report.code, 'host_quiescence_proof_invalid');
    assert.equal(bootstrap.applyCalls, 0);
    const jsonRoundTrip = JSON.parse(
      JSON.stringify(await live.host.observe()),
    ) as unknown;
    assert.equal(
      isTrustedManagedPiScopedProof(
        (jsonRoundTrip as { proof?: unknown }).proof,
      ),
      false,
    );
  } finally {
    journal?.close();
    value.cleanup();
  }
});

test('fresh scoped proof is rejected when the guarded transition clock sees it as stale', async () => {
  const value = await fixture('managed-pi-stale-proof');
  let journal: ManagedPiJournal | undefined;
  try {
    const live = await liveTransitionHost(value);
    journal = live.journal;
    const bootstrap = new FixtureBootstrap(value);
    const deps = {
      ...transitionDeps(live.host, bootstrap),
      clock: () => Date.now() + 31_000,
    };
    const report = await applySessionTransition(value.request, deps);
    assert.equal(report.status, 'waiting', JSON.stringify(report));
    assert.equal(report.code, 'host_quiescence_proof_invalid');
    assert.equal(bootstrap.applyCalls, 0);
  } finally {
    journal?.close();
    value.cleanup();
  }
});
