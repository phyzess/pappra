import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs, { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runCli } from '../../src/cli/run.js';
import { retireManagedPiSource } from '../../src/app/managed-pi-retirement.js';
import { prepareManagedPiHandoffReceiver } from '../../src/app/managed-pi-handoff-receiver.js';
import { watchManagedPiBootstrapAdmission } from '../../src/app/managed-pi-bootstrap-admission.js';
import {
  admitManagedSourceAssignment,
  readManagedSourceAssignment,
} from '../../src/app/managed-pi-source-admission.js';
import { validateSuccession } from '../../src/app/collab-route.js';
import { readPiBootstrapConfig } from '../../src/hosts/integration/bootstrap-config.js';
import { ManagedPiSdkSessionController } from '../../src/hosts/pi/managed-sdk-session.js';
import { bindNative } from '../../src/collab/lifecycle.js';
import {
  buildMessage,
  messageFile,
  sha256File,
} from '../../src/collab/envelope.js';
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
import {
  applySessionTransition,
  loadSessionTransitionRequest,
  planSessionTransition,
  type SessionTransitionBootstrapExecutor,
  type SessionTransitionDependencies,
  type SessionTransitionHost,
  type SessionTransitionHostObservation,
  type SessionTransitionJournal,
  type SessionTransitionQuiescenceReceipt,
  type SessionTransitionRequest,
} from '../../src/app/collab-session-transition.js';
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
import { makeTaskDomain } from './task-resources-fixtures.js';
import { collabBindingSchema } from '../../src/schemas/collaboration.js';
import {
  baseWorkspaceConfig,
  workspaceId,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';
import { saveHandoffBundle } from '../../src/continuity/index.js';
import {
  continuityTaskPaths,
  writeContinuityBytes,
} from '../../src/continuity/paths.js';
import {
  RolloverFreezeController,
  type FreezeStatus,
  type FreezeToken,
} from '../../src/hosts/integration/pi-rollover-extension.js';
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
    selected_model: { preserve_daily: true },
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

interface FakeHostFixture {
  readonly host: SessionTransitionHost;
  freezeCalls(): number;
  setOnObserve(callback: (() => void) | null): void;
}

function fakeHost(options: {
  readonly cwd: string;
  readonly supported: boolean;
  readonly throwFreeze?: boolean;
}): FakeHostFixture {
  const controller = new RolloverFreezeController({
    sessionId: SOURCE.session_id,
  });
  let sequence = 0;
  let freezes = 0;
  let onObserve: (() => void) | null = null;
  let fired = false;
  const host: SessionTransitionHost = {
    id: options.supported
      ? 'test-only-supported-proof-adapter'
      : 'pi-native-events-only',
    async observe(): Promise<SessionTransitionHostObservation> {
      if (!fired && onObserve !== null) {
        fired = true;
        onObserve();
      }
      const freezeStatus: FreezeStatus = controller.status();
      const proof =
        options.supported && freezeStatus.frozen && freezeStatus.token !== null
          ? {
              adapter_id: 'pappra/pi-session-transition-host/1' as const,
              session_id: SOURCE.session_id,
              cwd: options.cwd,
              observed_at: new Date().toISOString(),
              sequence: ++sequence,
              evidence_ref: 'test-only://complete-native-quiescence-receipt',
              freeze_token: freezeStatus.token,
              inventory: {
                completeness: 'complete' as const,
                inflight: [],
                pending_approvals: [],
                pending_messages: [],
                partial_outputs: [],
              },
            }
          : null;
      return {
        session_id: SOURCE.session_id,
        cwd: options.cwd,
        pane_id: 'w1:p1',
        proof_support: options.supported ? 'available' : 'unavailable',
        proof,
        freeze_status: freezeStatus,
        native_facts: null,
        unavailable_code: options.supported
          ? null
          : 'pi_native_quiescence_proof_unavailable',
        detail: options.supported
          ? 'Test-only deterministic adapter fixture; not evidence of Pi host capability.'
          : 'Installed Pi producer reports incomplete native inventory and no authenticated stop receipt.',
      };
    },
    async freeze(token: FreezeToken) {
      freezes += 1;
      if (options.throwFreeze)
        throw new Error('test-only ambiguous freeze outcome');
      return controller.freeze(token);
    },
  };
  return {
    host,
    freezeCalls: () => freezes,
    setOnObserve(callback) {
      onObserve = callback;
      fired = false;
    },
  };
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

test('transition journal and rollover intent retain distinct identifiers across replay', async () => {
  const value = await fixture('distinct-transition-intent');
  try {
    const host = fakeHost({ cwd: value.cwd, supported: false });
    const bootstrap = new FixtureBootstrap(value);
    const request = {
      ...value.request,
      transition_id: 'separate-transition-journal',
    };
    const deps = transitionDeps(host.host, bootstrap);
    for (let replay = 0; replay < 2; replay++) {
      const result = await applySessionTransition(request, deps);
      assert.equal(
        result.code,
        'pi_native_quiescence_proof_unavailable',
        JSON.stringify(result),
      );
      assert.equal(result.stage, 'awaiting_quiescence');
    }
    assert.equal(value.load().rollover?.length, 1);
    assert.equal(value.load().rollover?.[0]?.intent_id, INTENT_ID);
    assert.equal(
      (value.load().session_transition_journal as SessionTransitionJournal)
        .entries[0]?.transition_id,
      request.transition_id,
    );
  } finally {
    value.cleanup();
  }
});

test('managed receiver verifies context before ACK and cannot start work before transfer', async () => {
  const value = await fixture('managed-context-receiver');
  try {
    const host = fakeHost({ cwd: value.cwd, supported: true });
    const bootstrap = new FixtureBootstrap(value);
    await applySessionTransition(
      value.request,
      transitionDeps(host.host, bootstrap),
    );
    await applySessionTransition(
      value.request,
      transitionDeps(host.host, bootstrap),
    );
    const config = readPiBootstrapConfig(
      value.bootstrapRequest.bootstrap.config_ref,
    );
    assert(config.ok);
    const referenceFile = join(value.root, 'receiver-context.json');
    writeJson(referenceFile, {
      schema: 'pappra/managed-handoff-context/1',
      task_root: value.taskRoot,
      transition_id: value.request.transition_id,
      intent_id: value.request.intent.intent_id,
      handoff_id: value.request.intent.handoff_id,
      generation: value.request.intent.generation,
      bundle: value.request.bundle,
    });
    const imports: string[] = [];
    let prompts = 0;
    let lifecycleListener: ((event: unknown) => void) | undefined;
    const runtime = {
      observe: () => ({
        native: { sessionId: SUCCESSOR.session_id },
        cwd: value.cwd,
      }),
      importHandoffContext: async (text: string) => {
        imports.push(text);
      },
      subscribe: (listener: (event: unknown) => void) => {
        lifecycleListener = listener;
        return () => {
          lifecycleListener = undefined;
        };
      },
      submitInput: () => {
        prompts++;
      },
    } as unknown as ManagedPiSdkSessionController;
    const journalPath = join(value.root, 'receiver.jsonl');
    const setApproval = (blocked: boolean) =>
      transact(value.taskRoot, {
        actor: 'fixture',
        purpose: 'receiver-approval-gate',
        apply(record) {
          if (blocked) record.attempts[0]!.awaiting = 'approval';
          else delete record.attempts[0]!.awaiting;
          return { record, op: 'fixture', summary: {}, result: null };
        },
      });
    assert(setApproval(true).ok);
    await assert.rejects(
      prepareManagedPiHandoffReceiver(
        runtime,
        config.config,
        referenceFile,
        journalPath,
      ),
      /receiver_authority_changed_before_import/,
    );
    assert.equal(imports.length, 0);
    assert.equal(
      fs.existsSync(`${journalPath}.receiver-reservation.json`),
      false,
    );
    assert(setApproval(false).ok);
    const receiver = await prepareManagedPiHandoffReceiver(
      runtime,
      config.config,
      referenceFile,
      journalPath,
    );
    try {
      assert.equal(imports.length, 1);
      assert.match(imports[0]!, /Next action: Inspect only/);
      assert.equal(receiver.status().ack_registered, true);
      assert.equal(receiver.priorSourceRetired(), false);
      assert.throws(
        () => receiver.startWork(),
        /receiver_work_before_transfer/,
      );
      assert.equal(prompts, 0);
      assert.equal(
        value.load().attempts[0]?.assignee.session_id,
        SOURCE.session_id,
      );
      assert.equal(value.load().claims[0]?.resource_epoch, 1);
      await assert.rejects(
        prepareManagedPiHandoffReceiver(
          runtime,
          config.config,
          referenceFile,
          journalPath,
        ),
        /EEXIST/,
      );
      assert.equal(
        imports.length,
        1,
        'a reserved native context import is never repeated implicitly',
      );
      const ack = value
        .load()
        .messages.find((message) => message.type === 'ACK');
      assert(ack);
      const transferred = await applySessionTransition(
        {
          ...value.request,
          evidence: {
            ack_message_id: ack.message_id,
            first_work_report_id: null,
          },
        },
        transitionDeps(host.host, bootstrap),
      );
      assert.equal(
        transferred.stage,
        'awaiting_first_work',
        JSON.stringify(transferred),
      );
      receiver.startWork();
      assert.equal(prompts, 1);
      lifecycleListener?.({
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'First owned work finished.' }],
          },
        ],
      });
      lifecycleListener?.({ type: 'agent_settled', aborted: false });
      assert.equal(
        receiver.status().first_work_observed,
        true,
        JSON.stringify(receiver.status()),
      );
      const firstWork = value
        .load()
        .messages.find((message) => message.type === 'REPORT');
      assert(firstWork);
      const reported = JSON.parse(
        readFileSync(
          join(value.taskRoot, 'messages', `${firstWork.message_id}.json`),
          'utf8',
        ),
      );
      assert.equal(reported.body.rollover_intent_id, INTENT_ID);
      assert.equal(reported.body.phase, 'handoff-first-work');
      assert.equal(value.load().attempts[0]?.state, 'running');
    } finally {
      receiver.close();
    }
  } finally {
    value.cleanup();
  }
});

test('plan is read-only and installed Pi evidence blocks before freeze or successor launch', async () => {
  const value = await fixture('pi-unavailable');
  try {
    const host = fakeHost({ cwd: value.cwd, supported: false });
    const bootstrap = new FixtureBootstrap(value);
    const deps = transitionDeps(host.host, bootstrap);

    const initial = value.load();
    const plan = await planSessionTransition(value.request, deps);
    assert.equal(plan.status, 'planned', JSON.stringify(plan));
    assert.equal(
      plan.steps.find((item) => item.step === 'source-quiescence')?.status,
      'unavailable',
    );
    assert.equal(
      value.load().state_revision,
      initial.state_revision,
      'plan must not mutate the task record',
    );

    const loaded = value.writeRequest({
      ack_message_id: null,
      first_work_report_id: null,
    });
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const report = await applySessionTransition(loaded.value, deps);
    assert.equal(report.status, 'waiting');
    assert.equal(report.code, 'pi_native_quiescence_proof_unavailable');
    assert.equal(report.stage, 'awaiting_quiescence');
    assert.equal(report.capabilities.supported_quiescence, 'unavailable');
    assert.equal(host.freezeCalls(), 0);
    assert.equal(bootstrap.applyCalls, 0);
    const current = value.load();
    assert.equal(
      current.rollover?.length,
      1,
      'the durable intent is retained for resumption',
    );
    assert.equal(current.handoffs?.[0]?.state, 'requested');
    assert.equal(current.claims?.[0]?.holder.agent_id, SOURCE.agent_id);
    assert.equal(current.claims?.[0]?.resource_epoch, 1);
  } finally {
    value.cleanup();
  }
});

test('an incompatible successor SDK is rejected before source freeze or bootstrap', async () => {
  const value = await fixture('unsupported-successor-sdk');
  try {
    const sdkRoot = join(value.root, 'sdk');
    mkdirSync(join(sdkRoot, 'dist'), { recursive: true });
    const sdkModule = join(sdkRoot, 'dist', 'index.js');
    writeJson(join(sdkRoot, 'package.json'), {
      name: '@earendil-works/pi-coding-agent',
      version: '999.0.0',
    });
    writeFileSync(sdkModule, 'export const VERSION = "999.0.0";\n');
    const bootstrapRequest = JSON.parse(
      readFileSync(value.bootstrapRequestFile, 'utf8'),
    ) as Record<string, unknown>;
    bootstrapRequest['selected_model'] = {
      preserve_daily: true,
      openrouter_model: 'openai/gpt-6-luna',
    };
    bootstrapRequest['managed_runtime'] = {
      sdk_module_path: sdkModule,
      journal_path: join(value.root, 'successor.jsonl'),
    };
    writeJson(value.bootstrapRequestFile, bootstrapRequest);
    const request = {
      ...value.request,
      bootstrap_request: {
        ref: value.bootstrapRequestFile,
        digest: sha256File(value.bootstrapRequestFile),
      },
    };
    const host = fakeHost({ cwd: value.cwd, supported: true });
    const bootstrap = new FixtureBootstrap(value);
    const before = value.load().state_revision;
    const result = await applySessionTransition(
      request,
      transitionDeps(host.host, bootstrap),
    );
    assert.equal(result.code, 'successor_sdk_incompatible');
    assert.equal(host.freezeCalls(), 0);
    assert.equal(bootstrap.applyCalls, 0);
    assert.equal(value.load().state_revision, before);
  } finally {
    value.cleanup();
  }
});

test('collab transition apply is routed through the CLI and refuses to run without the Pi host', async () => {
  const value = await fixture('cli-host-required');
  try {
    let stdout = '';
    let stderr = '';
    const code = await runCli(
      [
        'collab',
        'transition',
        'apply',
        '--task-root',
        value.taskRoot,
        '--request',
        value.transitionRequestFile,
        '--json',
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );
    assert.equal(code, 1, `code=${code} stdout=${stdout} stderr=${stderr}`);
    const report = JSON.parse(stdout) as {
      readonly code?: string;
      readonly status?: string;
    };
    assert.equal(report.code, 'pi_transition_host_required');
    assert.equal(report.status, 'needs_input');
    assert.equal(
      value.load().rollover?.length ?? 0,
      0,
      'CLI-only apply must not create a rollover intent without its host adapter',
    );
  } finally {
    value.cleanup();
  }
});

test('unknown freeze outcomes are reconciled and never blindly replayed', async () => {
  const value = await fixture('unknown-freeze');
  try {
    const host = fakeHost({
      cwd: value.cwd,
      supported: true,
      throwFreeze: true,
    });
    const bootstrap = new FixtureBootstrap(value);
    const deps = transitionDeps(host.host, bootstrap);
    const first = await applySessionTransition(value.request, deps);
    assert.equal(first.status, 'reconcile_required', JSON.stringify(first));
    assert.equal(first.code, 'source_freeze_outcome_unknown');
    assert.equal(host.freezeCalls(), 1);
    assert.equal(value.load().session_transition_journal !== undefined, true);

    const second = await applySessionTransition(value.request, deps);
    assert.equal(second.status, 'reconcile_required');
    assert.equal(second.code, 'source_freeze_outcome_unknown');
    assert.equal(
      host.freezeCalls(),
      1,
      'an ambiguous freeze call must not be replayed',
    );
    assert.equal(bootstrap.applyCalls, 0);
    assert.equal(value.load().handoffs?.[0]?.state, 'requested');
  } finally {
    value.cleanup();
  }
});

test('source authority drift during an awaited host observation blocks before intent or effects', async () => {
  const value = await fixture('authority-drift');
  try {
    const host = fakeHost({ cwd: value.cwd, supported: false });
    host.setOnObserve(() => {
      const changed = transact(value.taskRoot, {
        actor: 'fixture-coordinator-change',
        purpose: 'fixture-epoch-drift',
        apply: (record) => {
          if (record.coordinator === null)
            return { ok: false as const, reason: 'coordinator_missing' };
          record.coordinator.owner_epoch += 1;
          return {
            record,
            op: 'fixture-epoch-drift',
            summary: {},
            result: null,
          };
        },
      });
      assert.equal(changed.ok, true, JSON.stringify(changed));
    });
    const bootstrap = new FixtureBootstrap(value);
    const report = await applySessionTransition(
      value.request,
      transitionDeps(host.host, bootstrap),
    );
    assert.equal(report.status, 'needs_input');
    assert.equal(host.freezeCalls(), 0);
    assert.equal(bootstrap.applyCalls, 0);
    assert.equal(value.load().rollover?.length ?? 0, 0);
    assert.equal(value.load().claims?.[0]?.holder.agent_id, SOURCE.agent_id);
  } finally {
    value.cleanup();
  }
});

test('authority drift during awaited live successor observation prevents claim transfer', async () => {
  const value = await fixture('herdr-authority-drift');
  try {
    const host = fakeHost({ cwd: value.cwd, supported: true });
    const bootstrap = new FixtureBootstrap(value);
    const baseDependencies = transitionDeps(host.host, bootstrap);
    await applySessionTransition(value.request, baseDependencies);
    await applySessionTransition(value.request, baseDependencies);
    const ack = value.send({
      message_id: 'msg-authority-drift-ack',
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
    assert.ok(ackRequest.ok);
    if (!ackRequest.ok) return;
    const herdr = fakeHerdr(() => {
      const changed = transact(value.taskRoot, {
        actor: 'fixture-coordinator-change',
        purpose: 'fixture-epoch-drift-after-herdr-list',
        apply: (record) => {
          if (record.coordinator === null)
            return { ok: false as const, reason: 'coordinator_missing' };
          record.coordinator.owner_epoch += 1;
          return {
            record,
            op: 'fixture-epoch-drift-after-herdr-list',
            summary: {},
            result: null,
          };
        },
      });
      assert.ok(changed.ok, JSON.stringify(changed));
    });
    const report = await applySessionTransition(
      ackRequest.value,
      transitionDeps(host.host, bootstrap, herdr),
    );
    assert.equal(report.status, 'needs_input');
    assert.equal(value.load().handoffs?.[0]?.state, 'receiver_confirmed');
    assert.equal(value.load().claims?.[0]?.holder.agent_id, SOURCE.agent_id);
    assert.equal(value.load().claims?.[0]?.resource_epoch, 1);
    assert.equal(value.load().rollover?.[0]?.transfer_boundary, null);
  } finally {
    value.cleanup();
  }
});

test('managed source admission rechecks state, runtime and succession while allowing unrelated commits', async (t) => {
  const value = await fixture('source-admission-drift');
  try {
    const host = fakeHost({ cwd: value.cwd, supported: true });
    const deps = transitionDeps(host.host, new FixtureBootstrap(value));
    await applySessionTransition(value.request, deps);
    await applySessionTransition(value.request, deps);
    const ack = value.send({
      message_id: 'source-admission-ack',
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
    assert(ackRequest.ok);
    await applySessionTransition(ackRequest.value, deps);
    const work = value.send({
      message_id: 'source-admission-work',
      type: 'REPORT',
      task_id: TASK_ID,
      from: SUCCESSOR,
      to: COORDINATOR,
      subtask_id: SUBTASK_ID,
      attempt: 1,
      owner_epoch: 1,
      body: {
        status: 'completed',
        input_revision: value.inputRevision,
        handoff_id: HANDOFF_ID,
        rollover_generation: 1,
      },
    });
    const complete = value.writeRequest({
      ack_message_id: ack.message_id,
      first_work_report_id: work.message_id,
    });
    assert(complete.ok);
    const retired = await applySessionTransition(complete.value, deps);
    assert.equal(retired.stage, 'task_retired', JSON.stringify(retired));
    const baseline = value.load();
    const scope = {
      schema: 'pappra/managed-pi-execution-scope/1' as const,
      task_id: TASK_ID,
      task_root: value.taskRoot,
      session_id: SUCCESSOR.session_id,
      cwd: value.cwd,
      subtask_id: SUBTASK_ID,
      attempt: 1,
      owner_epoch: 1,
      claim_epochs: [{ claim_id: value.claimId, resource_epoch: 2 }],
    };
    const runtime = Object.assign(
      Object.create(
        ManagedPiSdkSessionController.prototype,
      ) as ManagedPiSdkSessionController,
      {
        observe: () => ({
          native: {
            sessionId: SUCCESSOR.session_id,
            agentId: SUCCESSOR.agent_id,
            surface: 'pi-sdk-tui',
            configurationId: 'source-admission-fixture',
          },
          cwd: value.cwd,
        }),
        snapshot: () => ({ process: { pid: process.pid } }),
      },
    );
    const mutations = [
      [
        'state',
        (record: TaskRecord) => {
          record.attempts[0]!.state = 'completed';
        },
      ],
      [
        'runtime',
        (record: TaskRecord) => {
          record.managed_pi_runtime_registry = [];
        },
      ],
      [
        'succession',
        (record: TaskRecord) => {
          record.successions = [];
        },
      ],
      [
        'unrelated',
        (record: TaskRecord) => {
          record.audit_note = 'Unrelated task progress.';
        },
      ],
    ] as const;
    for (const [label, mutate] of mutations) {
      const setup = transact(value.taskRoot, {
        actor: 'fixture',
        purpose: 'ready-current-source',
        apply(record) {
          record.attempts = structuredClone(baseline.attempts);
          record.attempts[0]!.state = 'running';
          delete record.attempts[0]!.closed_at;
          record.claims = structuredClone(baseline.claims);
          for (const claim of record.claims) claim.released_at = null;
          record.successions = structuredClone(baseline.successions!);
          record.managed_pi_runtime_registry = [
            {
              session_id: SUCCESSOR.session_id,
              controller_run_id: 'admission-runtime',
              scope,
            },
          ];
          delete record.managed_pi_source_admissions;
          return { record, result: null };
        },
      });
      assert.ok(setup.ok);
      let changed = false;
      const exists = fs.existsSync;
      const hook = t.mock.method(fs, 'existsSync', (file: fs.PathLike) => {
        if (file === value.cardFile && !changed) {
          changed = true;
          const result = transact(value.taskRoot, {
            actor: 'another-actor',
            purpose: 'change-during-admission',
            apply(record) {
              mutate(record);
              return { record, result: null };
            },
          });
          assert.ok(result.ok);
        }
        return exists(file);
      });
      try {
        const admission = admitManagedSourceAssignment(runtime, scope, {
          assignmentFile: join(value.root, `admission-${label}.json`),
          templateFile: value.cardFile,
          cardFile: join(value.root, `card-${label}.json`),
        });
        if (label === 'unrelated') {
          await admission;
          assert.equal(
            (value.load().managed_pi_source_admissions as unknown[]).length,
            1,
          );
        } else {
          await assert.rejects(admission);
          assert.equal(value.load().managed_pi_source_admissions, undefined);
        }
        assert.equal(changed, true);
      } finally {
        hook.mock.restore();
      }
    }
  } finally {
    value.cleanup();
  }
});

test('supported test-only adapter orders ACK, claim/route transfer, first work and reversible retirement', async (t) => {
  const value = await fixture('complete-supported-flow');
  try {
    const host = fakeHost({ cwd: value.cwd, supported: true });
    const bootstrap = new FixtureBootstrap(value);
    const deps = transitionDeps(host.host, bootstrap);

    const nativeFile = join(value.root, 'retirement-source.jsonl');
    const nativeBytes = `${JSON.stringify({ type: 'session', id: SOURCE.session_id, cwd: value.cwd })}\n${JSON.stringify({ type: 'message', content: 'x'.repeat(9 * 1024 * 1024) })}\n`;
    writeFileSync(nativeFile, nativeBytes, { mode: 0o600 });
    type RetirementRuntime = Parameters<typeof retireManagedPiSource>[1];
    let disposed = false;
    let stops = 0;
    const nativeSnapshot = () =>
      ({
        session: { sessionId: SOURCE.session_id, sessionFile: nativeFile },
        scopedQuiescent: true,
      }) as ReturnType<RetirementRuntime['snapshot']>;
    const runtime: RetirementRuntime = {
      observe: () => ({
        native: {
          harness: 'pi',
          sessionId: SOURCE.session_id,
          agentId: SOURCE.agent_id,
          paneId: null,
          surface: 'fixture',
          configurationId: null,
          modelObservation: {
            model: 'fixture',
            provider: 'fixture',
            reasoning: null,
          },
        },
        cwd: value.cwd,
        contextPercent: 80,
      }),
      snapshot: nativeSnapshot,
      get isDisposed() {
        return disposed;
      },
      stopOwnedRuntime: async () => {
        stops++;
        disposed = true;
        return {
          status: 'runtime_disposed',
          sessionId: SOURCE.session_id,
          process: { pid: process.pid, exit: 'not_owned' },
          finalSnapshot: nativeSnapshot(),
        };
      },
    };
    await assert.rejects(
      () => retireManagedPiSource(value.request, runtime, deps),
      /retirement_first_work_gate_unsatisfied/,
    );
    assert.equal(stops, 0);
    assert.equal(host.freezeCalls(), 0);
    assert.equal(bootstrap.applyCalls, 0);

    const prepared = await applySessionTransition(value.request, deps);
    assert.equal(prepared.status, 'progressed', JSON.stringify(prepared));
    assert.equal(prepared.stage, 'prepared');
    assert.equal(value.load().handoffs?.[0]?.state, 'transferring');
    assert.equal(host.freezeCalls(), 1);
    assert.equal(bootstrap.applyCalls, 0);
    const preparedJournal = value.load()
      .session_transition_journal as SessionTransitionJournal;
    const sourceReceipt = preparedJournal.entries[0]?.source_quiescence_receipt;
    assert.ok(sourceReceipt);
    assert.equal(sourceReceipt.session_id, SOURCE.session_id);
    assert.equal(sourceReceipt.freeze_token.handoffId, HANDOFF_ID);
    assert.match(sourceReceipt.inventory_digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(
      preparedJournal.entries[0]?.transfer_quiescence_receipt,
      undefined,
    );

    const waitingAck = await applySessionTransition(value.request, deps);
    assert.equal(waitingAck.status, 'waiting');
    assert.equal(waitingAck.code, null);
    assert.equal(bootstrap.applyCalls, 1);
    assert.equal(value.load().claims?.[0]?.holder.agent_id, SOURCE.agent_id);

    const bootstrapConfig = readPiBootstrapConfig(
      value.bootstrapRequest.bootstrap.config_ref,
    );
    assert(bootstrapConfig.ok);
    let receiverBinds = 0;
    const admissionRuntime = {
      observe: () => ({
        native: { sessionId: SUCCESSOR.session_id },
        cwd: value.cwd,
      }),
      snapshot: () => ({
        session: { sessionId: SUCCESSOR.session_id },
        ingress: { state: 'open', healthy: true },
        ownedRuntime: {
          queues: {
            completeness: 'complete',
            pendingMessageCount: 0,
            steering: [],
            followUp: [],
            internal: {
              pendingNextTurn: [],
              pendingCustom: [],
              pendingBash: [],
              deferredSettledActionCount: 0,
              pendingUserInputs: [],
              compactionMessages: [],
              extensionDialogCount: 0,
              activeSelector: false,
            },
          },
          work: {
            observation: 'complete',
            isIdle: true,
            isStreaming: false,
            isCompacting: false,
            isBashRunning: false,
            hasPendingBashMessages: false,
            pendingToolCalls: 0,
          },
          extensionDialogs: { completeness: 'complete', pending: [] },
          builtInUiApprovals: { observation: 'complete', uncoveredPaths: [] },
        },
      }),
      inventory: async () => ({
        completeness: 'complete',
        inflight: [],
        pending_approvals: [],
        pending_messages: [],
      }),
      subscribe: () => () => {},
    } as unknown as ManagedPiSdkSessionController;
    const receiverAdmission = await watchManagedPiBootstrapAdmission(
      admissionRuntime,
      bootstrapConfig.config,
      async () => {
        receiverBinds++;
      },
    );
    t.after(() => receiverAdmission.close());
    assert.equal(receiverAdmission.status().state, 'awaiting_transfer');

    const badAck = value.send({
      message_id: 'msg-bad-successor-ack',
      type: 'ACK',
      task_id: TASK_ID,
      from: SUCCESSOR,
      to: COORDINATOR,
      reply_to: 'msg-not-the-assignment',
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
    const badAckRequest = value.writeRequest({
      ack_message_id: badAck.message_id,
      first_work_report_id: null,
    });
    assert.equal(badAckRequest.ok, true);
    if (!badAckRequest.ok) return;
    const rejectedAck = await applySessionTransition(badAckRequest.value, deps);
    assert.equal(rejectedAck.status, 'needs_input');
    assert.equal(rejectedAck.code, 'ack_bootstrap_mismatch');
    assert.equal(value.load().handoffs?.[0]?.state, 'transferring');
    assert.equal(value.load().claims?.[0]?.holder.agent_id, SOURCE.agent_id);

    const ack = value.send({
      message_id: 'msg-successor-ack',
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
    assert.equal(ackRequest.ok, true);
    if (!ackRequest.ok) return;
    const transferred = await applySessionTransition(ackRequest.value, deps);
    assert.equal(
      transferred.status,
      'progressed',
      JSON.stringify({
        report: transferred,
        attempt: value
          .load()
          .attempts?.find((item) => item.subtask_id === SUBTASK_ID),
      }),
    );
    assert.equal(transferred.stage, 'awaiting_first_work');
    await receiverAdmission.refresh();
    assert.equal(
      receiverAdmission.status().state,
      'bound',
      JSON.stringify(receiverAdmission.status()),
    );
    await receiverAdmission.refresh();
    assert.equal(receiverBinds, 1);
    const transferredJournal = value.load()
      .session_transition_journal as SessionTransitionJournal;
    const transferReceipt =
      transferredJournal.entries[0]?.transfer_quiescence_receipt;
    assert.ok(transferReceipt);
    assert.equal(transferReceipt.session_id, SOURCE.session_id);
    assert.ok(transferReceipt.sequence > sourceReceipt.sequence);
    assert.equal(
      (
        transferred.transfer?.[
          'transfer_quiescence_receipt'
        ] as SessionTransitionQuiescenceReceipt
      ).evidence_ref,
      transferReceipt.evidence_ref,
    );
    assert.equal(
      transferred.route_transfer?.['status'],
      'successor-binding-written',
    );
    assert.equal(transferred.host?.['process_affiliation'], 'not-established');
    assert.equal(value.load().handoffs?.[0]?.state, 'completed');
    assert.equal(value.load().claims?.[0]?.holder.agent_id, SUCCESSOR.agent_id);
    assert.equal(value.load().claims?.[0]?.resource_epoch, 2);
    assert.equal(value.load().successions?.length ?? 0, 0);

    const pendingArchive = await applySessionTransition(ackRequest.value, deps);
    assert.equal(pendingArchive.status, 'waiting');
    assert.equal(pendingArchive.code, 'first_work_report_required');
    assert.equal(value.load().successions?.length ?? 0, 0);

    const incompleteReport = value.send({
      message_id: 'msg-incomplete-first-work',
      type: 'REPORT',
      task_id: TASK_ID,
      from: SUCCESSOR,
      to: COORDINATOR,
      subtask_id: SUBTASK_ID,
      attempt: 1,
      owner_epoch: 1,
      body: {
        status: 'running',
        input_revision: value.inputRevision,
        handoff_id: HANDOFF_ID,
        rollover_generation: 1,
      },
    });
    const incompleteRequest = value.writeRequest({
      ack_message_id: ack.message_id,
      first_work_report_id: incompleteReport.message_id,
    });
    assert.equal(incompleteRequest.ok, true);
    if (!incompleteRequest.ok) return;
    const rejectedReport = await applySessionTransition(
      incompleteRequest.value,
      deps,
    );
    assert.equal(rejectedReport.status, 'needs_input');
    assert.equal(rejectedReport.code, 'report_not_admitted');
    assert.equal(value.load().successions?.length ?? 0, 0);
    assert.equal(
      value.load().session_transition_journal &&
        (
          value.load().session_transition_journal as {
            entries: Array<{ archive_ref?: string }>;
          }
        ).entries[0]?.archive_ref,
      undefined,
    );

    const firstWork = value.send({
      message_id: 'msg-admitted-first-work',
      type: 'REPORT',
      task_id: TASK_ID,
      from: SUCCESSOR,
      to: COORDINATOR,
      subtask_id: SUBTASK_ID,
      attempt: 1,
      owner_epoch: 1,
      body: {
        status: 'completed',
        input_revision: value.inputRevision,
        handoff_id: HANDOFF_ID,
        rollover_generation: 1,
      },
    });
    const firstWorkRequest = value.writeRequest({
      ack_message_id: ack.message_id,
      first_work_report_id: firstWork.message_id,
    });
    assert.equal(firstWorkRequest.ok, true);
    if (!firstWorkRequest.ok) return;
    const retired = await applySessionTransition(firstWorkRequest.value, deps);
    assert.equal(
      retired.status,
      'progressed',
      `retired=${JSON.stringify(retired)}`,
    );
    assert.equal(retired.stage, 'task_retired');
    assert.equal(retired.first_work?.['status'], 'core-first-work-recorded');
    assert.equal(
      retired.archive?.['status'],
      'task-retirement-marker-recorded',
    );
    assert.equal(retired.archive?.['native_archive'], 'unavailable');
    assert.equal(retired.archive?.['original_transcript'], 'retained-in-place');
    assert.equal(retired.archive?.['reversible'], true);
    assert.equal(retired.capabilities.notification_route_exclusion, 'excluded');
    const admissionRecord = structuredClone(value.load());
    const activeAttempt = admissionRecord.attempts[0]!;
    const succession = validateSuccession(
      admissionRecord,
      admissionRecord.successions?.[0],
    );
    assert(succession.ok);
    const original = JSON.parse(readFileSync(value.assignmentFile, 'utf8'));
    const actor = { ...original.assignee, ...SUCCESSOR };
    const derivedAssignment = {
      ...original,
      assignee: actor,
      resources: original.resources.map(
        (resource: { resource_epoch: number }) => ({
          ...resource,
          resource_epoch: 2,
        }),
      ),
    };
    const derivedFile = join(value.root, 'successor-source.assignment.json');
    writeJson(derivedFile, derivedAssignment);
    const scope = {
      schema: 'pappra/managed-pi-execution-scope/1',
      task_id: TASK_ID,
      task_root: value.taskRoot,
      session_id: SUCCESSOR.session_id,
      cwd: value.cwd,
      subtask_id: SUBTASK_ID,
      attempt: 1,
      owner_epoch: 1,
      claim_epochs: [{ claim_id: value.claimId, resource_epoch: 2 }],
    };
    admissionRecord.managed_pi_runtime_registry = [
      {
        session_id: SUCCESSOR.session_id,
        controller_run_id: 'fixture-owned-runtime',
        scope,
      },
    ];
    admissionRecord.managed_pi_source_admissions = [
      {
        schema: 'pappra/managed-source-admission/1',
        task_id: TASK_ID,
        subtask_id: SUBTASK_ID,
        attempt: 1,
        input_revision: value.inputRevision,
        owner_epoch: 1,
        origin_ref: activeAttempt.assignment_ref,
        origin_digest: activeAttempt.assignment_digest,
        assignment_ref: derivedFile,
        assignment_digest: sha256File(derivedFile),
        actor,
        scope,
        controller_run_id: 'fixture-owned-runtime',
        predecessor_handoff_id: HANDOFF_ID,
        predecessor_proof_digest: succession.exclusion.proof_digest,
        claims: admissionRecord.claims.map((claim) => ({
          claim_id: claim.claim_id,
          resource_epoch: claim.resource_epoch,
          path: claim.path,
          access: claim.access,
          key: claim.key,
        })),
      },
    ];
    assert.equal(
      readManagedSourceAssignment(admissionRecord, activeAttempt).file,
      derivedFile,
    );
    assert.equal(
      readManagedSourceAssignment(admissionRecord, activeAttempt, SOURCE).file,
      value.assignmentFile,
    );
    assert.equal(
      activeAttempt.assignment_ref,
      value.assignmentFile,
      'the original ASSIGN remains immutable',
    );
    writeJson(derivedFile, {
      ...derivedAssignment,
      objective: 'Amplified objective',
    });
    assert.throws(
      () => readManagedSourceAssignment(admissionRecord, activeAttempt),
      /managed_source_assignment_changed/,
    );
    writeJson(derivedFile, derivedAssignment);
    const archiveRef = retired.archive?.['ref'];
    assert.equal(typeof archiveRef, 'string');
    assert.equal(
      readFileSync(archiveRef as string, 'utf8').includes('retained-in-place'),
      true,
    );

    const archiveStatBefore = readFileSync(archiveRef as string);
    const retained = await retireManagedPiSource(
      firstWorkRequest.value.request,
      runtime,
      deps,
    );
    assert.equal(
      retained.receipt.status,
      'runtime_disposed_and_transcript_retained',
    );
    assert.equal(retained.receipt.stop.process_exit, 'not_owned');
    assert.equal(stops, 1);
    assert.equal(readFileSync(nativeFile, 'utf8'), nativeBytes);
    assert.equal(
      readFileSync(
        join(value.request.bundle.root, retained.receipt.transcript.ref),
        'utf8',
      ),
      nativeBytes,
    );
    assert.equal(
      (
        await retireManagedPiSource(
          firstWorkRequest.value.request,
          runtime,
          deps,
        )
      ).duplicate,
      true,
    );
    assert.equal(stops, 1);
    let stdout = '';
    let stderr = '';
    const cliCode = await runCli(
      [
        'collab',
        'transition',
        'apply',
        '--task-root',
        value.taskRoot,
        '--request',
        value.transitionRequestFile,
        '--json',
      ],
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );
    assert.equal(cliCode, 0, `stdout=${stdout} stderr=${stderr}`);
    const replay = JSON.parse(stdout) as {
      readonly status?: string;
      readonly stage?: string;
    };
    assert.equal(replay.status, 'progressed');
    assert.equal(replay.stage, 'task_retired');
    assert.deepEqual(
      readFileSync(archiveRef as string),
      archiveStatBefore,
      'resumption must not rewrite a completed retirement marker',
    );
  } finally {
    value.cleanup();
  }
});
