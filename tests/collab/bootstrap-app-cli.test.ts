import assert from 'node:assert/strict';
import { captureProcessIdentity } from '../../src/infra/process-identity.js';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildMessage,
  messageFile,
  sha256File,
} from '../../src/collab/envelope.js';
import { bindNative } from '../../src/collab/lifecycle.js';
import { submitMessage } from '../../src/collab/messages.js';
import { claimResources, releaseClaim } from '../../src/collab/resources.js';
import { initTask, readRecord, transact } from '../../src/collab/store.js';
import * as rollover from '../../src/collab/rollover.js';
import type { Assignment, CapabilityCard } from '../../src/collab/contracts.js';
import type { Identity, Message } from '../../src/collab/types.js';
import {
  applyVisibleBootstrap,
  planVisibleBootstrap,
  validateVisibleBootstrapRequest,
  type VisibleBootstrapDependencies,
  type VisibleBootstrapRequest,
} from '../../src/app/collab-bootstrap.js';
import {
  managedSdkStartArgs,
  type BootstrapCommandReceipt,
  type BootstrapManagedSdkStartInput,
  type BootstrapOperationResult,
  type BootstrapPaneSnapshot,
  type BootstrapProcessSnapshot,
  type BootstrapStartedAgent,
  type BootstrapStartedManagedSdk,
  type HerdrBootstrapOps,
} from '../../src/app/collab-bootstrap-transport.js';
import {
  type HerdrAgentObservation,
  type HerdrCallerObservation,
  type HerdrListResult,
  type HerdrPromptResult,
  type HerdrTransport,
  type NotifyOptions,
  type NotifyResult,
} from '../../src/app/collab-notify.js';
import { runCli } from '../../src/cli/run.js';
import { cleanup, makeTempDir, snapshotTree } from '../workspace/fixtures.js';

const NOW = Date.now();
const COORDINATOR: Identity = {
  agent_id: 'coordinator',
  session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  harness: 'pi',
};
const SOURCE: Identity = {
  agent_id: 'writer-a',
  session_id: '11111111-1111-4111-8111-111111111111',
  harness: 'pi',
};
const SUCCESSOR: Identity = {
  agent_id: 'writer-b',
  session_id: '22222222-2222-4222-8222-222222222222',
  harness: 'pi',
};
const EXTENSION_ENTRY = `/**
 * Generated Pappra Pi bootstrap extension. It registers the accepted default-deny
 * successor gate from a private relative configuration; it installs, trusts, launches
 * and dispatches nothing by itself.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bootstrapExtension from "./runtime.mjs";

export default function (pi: ExtensionAPI): void {
  bootstrapExtension(pi);
}
`;

function hash(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function manifestDigest(root: string): string {
  const paths = [
    'extensions/pappra-bootstrap/bootstrap.json',
    'extensions/pappra-bootstrap/index.ts',
    'extensions/pappra-bootstrap/runtime.mjs',
    'package.json',
  ].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
  const entries = paths.map((relative) => ({
    path: relative,
    digest: sha256File(join(root, relative)),
  }));
  return hash(JSON.stringify(entries));
}
function assignmentFor(input: {
  readonly taskId: string;
  readonly assignmentId: string;
  readonly cwd: string;
  readonly inputFile: string;
  readonly inputDigest: string;
  readonly resourcePath: string;
  readonly resourceEpoch: number;
}): Assignment {
  return {
    schema: 'harness-collab/assignment/1',
    task_id: input.taskId,
    assignment_id: input.assignmentId,
    objective: 'Validate an explicitly admitted visible bootstrap request.',
    attempt: 1,
    roles: ['writer'],
    acceptance: ['The visible bootstrap remains bounded and idempotent.'],
    coordinator: { ...COORDINATOR, owner_epoch: 1 },
    assignee: {
      ...SOURCE,
      harness: 'pi',
      cwd: input.cwd,
      surface: 'cli',
      configuration_id: 'fixture',
    },
    inputs: [{ ref: input.inputFile, digest: input.inputDigest }],
    resources: [
      {
        path: input.resourcePath,
        access: 'write',
        resource_epoch: input.resourceEpoch,
      },
    ],
    runner: {
      name: 'pi-cli',
      mode: 'existing-session',
      omitted_capabilities: [],
    },
    required: { skills: [], tools: [] },
    preferred: { skills: [], tools: [] },
  };
}
function cardFor(identity: Identity, cwd: string): CapabilityCard {
  return {
    schema: 'harness-collab/capabilities/1',
    agent_id: identity.agent_id,
    session_id: identity.session_id,
    harness: 'pi',
    surface: 'cli',
    configuration_id: 'fixture',
    cwd,
    observed_at: new Date(NOW).toISOString(),
    evidence_level: 'runtime',
    skills: [],
    tools: [],
  };
}
function paneSnapshot(input: {
  readonly paneId: string;
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly cwd: string;
}): BootstrapPaneSnapshot {
  return {
    paneId: input.paneId,
    terminalId: input.terminalId,
    workspaceId: input.workspaceId,
    tabId: `${input.workspaceId}:t1`,
    cwd: input.cwd,
    foregroundCwd: input.cwd,
    agent: null,
    agentStatus: 'idle',
    focused: false,
    revision: 3,
  };
}
function commandReceipt(operation: string): BootstrapCommandReceipt {
  return {
    operation,
    argv: ['herdr', operation],
    code: 0,
    signal: null,
    spawned: true,
    timed_out: false,
    spawn_error: null,
    stdout: '{"result":"bounded"}',
    stderr: '',
  };
}
function operationOk<T>(
  operation: string,
  value: T,
): BootstrapOperationResult<T> {
  return {
    ok: true,
    value,
    correlationId: 'correlation-1',
    receipt: commandReceipt(operation),
  };
}
function agentObservation(input: {
  readonly name: string;
  readonly identity: Identity;
  readonly paneId: string;
  readonly cwd: string;
}): HerdrAgentObservation {
  return {
    name: input.name,
    harness: input.identity.harness ?? 'pi',
    paneId: input.paneId,
    cwd: input.cwd,
    sessionValue: input.identity.session_id,
    sessionKind: 'id',
    status: 'working',
    focused: false,
  };
}

interface Fixture {
  readonly root: string;
  readonly domainRoot: string;
  readonly taskRoot: string;
  readonly cwd: string;
  readonly inputRevision: string;
  readonly assignmentFile: string;
  readonly cardFile: string;
  readonly participantCardFile: string;
  readonly configFile: string;
  readonly bundleRoot: string;
  readonly extensionEntry: string;
  readonly acceptedArtifactFile: string;
  readonly baseBindingFile: string;
  readonly message: Message;
  readonly request: VisibleBootstrapRequest;
  readonly reuseRequest: VisibleBootstrapRequest;
  cleanup(): void;
}

function fixture(label: string): Fixture {
  const root = realpathSync(makeTempDir(label));
  const domainRoot = join(root, 'domain');
  const taskRoot = join(domainRoot, 'tasks', 'sample');
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const workPath = join(cwd, 'work');
  mkdirSync(workPath, { recursive: true });
  initTask(taskRoot, {
    taskId: 'sample',
    domainRoot,
    coordinator: {
      ...COORDINATOR,
      owner_epoch: 1,
      since: new Date(NOW).toISOString(),
    },
    clock: NOW,
  });
  const inputFile = join(root, 'input.json');
  writeFileSync(inputFile, '{"input":1}\n');
  const inputRevision = sha256File(inputFile);
  const claimResult = claimResources(taskRoot, {
    holder: SOURCE,
    resources: [{ kind: 'path', path: workPath }],
    access: 'write',
    subtaskId: 'work',
    attempt: 1,
    clock: NOW,
  });
  assert.ok(claimResult.ok, JSON.stringify(claimResult));
  const claim = claimResult.claims[0]!;
  const assignment = assignmentFor({
    taskId: 'sample',
    assignmentId: 'work',
    cwd,
    inputFile,
    inputDigest: inputRevision,
    resourcePath: workPath,
    resourceEpoch: claim.resource_epoch,
  });
  const assignmentFile = join(root, 'assignment.json');
  writeJson(assignmentFile, assignment);
  const assignmentDigest = sha256File(assignmentFile);
  const cardFile = join(root, 'source-card.json');
  writeJson(cardFile, cardFor(SOURCE, cwd));
  const participantCardFile = join(root, 'successor-card.json');
  writeJson(participantCardFile, cardFor(SUCCESSOR, cwd));

  const sourceAssignment = buildMessage(
    {
      message_id: 'msg-source-assignment',
      type: 'ASSIGN',
      task_id: 'sample',
      from: COORDINATOR,
      to: SOURCE,
      subtask_id: 'work',
      attempt: 1,
      owner_epoch: 1,
      body: {
        assignment_ref: assignmentFile,
        assignment_digest: assignmentDigest,
        input_revision: inputRevision,
      },
    },
    { clock: NOW },
  );
  const submittedAssignment = submitMessage(taskRoot, sourceAssignment, {
    clock: NOW,
  });
  assert.equal(
    submittedAssignment.ok,
    true,
    JSON.stringify(submittedAssignment),
  );
  const nativeBound = transact(taskRoot, {
    actor: 'fixture',
    purpose: 'fixture-source-native',
    clock: NOW,
    apply: (record) => {
      const result = bindNative(record, {
        subtaskId: 'work',
        attempt: 1,
        runner: 'pi',
        sessionId: SOURCE.session_id,
        runId: 'run-source',
        missionId: null,
        observation: 'confirmed',
        evidenceRef: 'fixture:source-session',
        observedAt: new Date(NOW).toISOString(),
      });
      if (!result.ok) return result;
      return { record, op: 'fixture-source-native', summary: {}, result };
    },
  });
  assert.equal(nativeBound.ok, true, JSON.stringify(nativeBound));
  const current = readRecord(taskRoot);
  assert.ok(current);
  const createdIntent = rollover.createRolloverIntent(current, {
    intent_id: 'intent-1',
    generation: 1,
    handoff_id: 'handoff-1',
    subtask_id: 'work',
    attempt: 1,
    input_revision: inputRevision,
    from: SOURCE,
    to: SUCCESSOR,
    claims: [
      { claim_id: claim.claim_id, resource_epoch: claim.resource_epoch },
    ],
    bundle: { ref: 'fixture-bundle.json', digest: hash('fixture bundle') },
    coordinator_epoch: 1,
    clock: NOW,
  });
  assert.equal(createdIntent.ok, true, JSON.stringify(createdIntent));
  const intentPersisted = transact(taskRoot, {
    actor: 'fixture',
    purpose: 'fixture-rollover-intent',
    clock: NOW,
    apply: (record) => {
      const replay = rollover.createRolloverIntent(record, {
        intent_id: 'intent-1',
        generation: 1,
        handoff_id: 'handoff-1',
        subtask_id: 'work',
        attempt: 1,
        input_revision: inputRevision,
        from: SOURCE,
        to: SUCCESSOR,
        claims: [
          { claim_id: claim.claim_id, resource_epoch: claim.resource_epoch },
        ],
        bundle: { ref: 'fixture-bundle.json', digest: hash('fixture bundle') },
        coordinator_epoch: 1,
        clock: NOW,
      });
      if (!replay.ok) return replay;
      return {
        record,
        op: 'fixture-rollover-intent',
        summary: { intent_id: replay.intent.intent_id },
        result: replay,
      };
    },
  });
  assert.equal(intentPersisted.ok, true, JSON.stringify(intentPersisted));

  const message = buildMessage(
    {
      message_id: 'msg-first-contact',
      type: 'STATUS',
      reply_to: 'msg-source-assignment',
      task_id: 'sample',
      from: SOURCE,
      to: SUCCESSOR,
      subtask_id: 'work',
      attempt: 1,
      owner_epoch: 1,
      body: { input_revision: inputRevision, status: 'running' },
    },
    { clock: NOW + 1 },
  );
  const sent = submitMessage(taskRoot, message, { clock: NOW + 1 });
  assert.equal(sent.ok, true, JSON.stringify(sent));

  const bundleRoot = join(root, 'exported-bootstrap');
  const extensionDir = join(bundleRoot, 'extensions', 'pappra-bootstrap');
  mkdirSync(extensionDir, { recursive: true });
  const configFile = join(extensionDir, 'bootstrap.json');
  const config = {
    schema: 'pappra/pi-bootstrap-config/1',
    domainRoot,
    taskId: 'sample',
    guard: {
      taskId: 'sample',
      intentId: 'intent-1',
      handoffId: 'handoff-1',
      generation: 1,
      subtaskId: 'work',
      attempt: 1,
      inputRevision,
      coordinatorEpoch: 1,
      successor: {
        agentId: SUCCESSOR.agent_id,
        sessionId: SUCCESSOR.session_id,
        harness: SUCCESSOR.harness,
      },
      claims: [
        {
          claimId: claim.claim_id,
          originalResourceEpoch: claim.resource_epoch,
        },
      ],
    },
  };
  writeJson(configFile, config);
  const extensionEntry = join(extensionDir, 'index.ts');
  writeFileSync(extensionEntry, EXTENSION_ENTRY);
  const runtimeFile = join(extensionDir, 'runtime.mjs');
  const runtime = '/* accepted gate runtime fixture */\n';
  writeFileSync(runtimeFile, runtime);
  writeJson(join(bundleRoot, 'package.json'), {
    name: '@phyzess/pappra-pi-bootstrap',
    type: 'module',
    pi: { extensions: ['./extensions/pappra-bootstrap/index.ts'] },
  });
  const acceptedArtifactFile = join(root, 'accepted-runtime.mjs');
  writeFileSync(acceptedArtifactFile, runtime);
  const configDigest = sha256File(configFile);
  const bundleDigest = manifestDigest(bundleRoot);
  const messagePath = messageFile(taskRoot, message.message_id);
  const baseBindingFile = join(taskRoot, 'task-binding.json');
  const baseBinding = {
    schema: 'pappra/collab-binding/1',
    task_id: 'sample',
    task_root: taskRoot,
    channel: 'herdr',
    participants: [
      {
        agent_id: SOURCE.agent_id,
        harness: 'pi',
        cwd,
        herdr_agent: 'pappra-source',
        pane_id: 'w1:p1',
        native_session_id: SOURCE.session_id,
      },
    ],
  };
  writeJson(baseBindingFile, baseBinding);
  const request: VisibleBootstrapRequest = {
    schema: 'pappra/collab-bootstrap-request/1',
    request_id: 'bootstrap-request-1',
    task_root: taskRoot,
    admission: {
      assignment_id: 'work',
      subtask_id: 'work',
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
      config_digest: configDigest,
      bundle_ref: bundleRoot,
      bundle_digest: bundleDigest,
      extension_entry: extensionEntry,
    },
    message_pointer: {
      message_id: message.message_id,
      content_ref: messagePath,
      content_digest: sha256File(messagePath),
    },
    binding_ref: baseBindingFile,
  };
  const reuseBindingFile = join(taskRoot, 'task-binding-reuse.json');
  writeJson(reuseBindingFile, {
    ...baseBinding,
    participants: [
      ...baseBinding.participants,
      {
        agent_id: SUCCESSOR.agent_id,
        harness: 'pi',
        cwd,
        herdr_agent: 'pappra-successor',
        pane_id: 'w1:p2',
        native_session_id: SUCCESSOR.session_id,
      },
    ],
  });
  const reuseRequest: VisibleBootstrapRequest = {
    ...request,
    request_id: 'bootstrap-reuse-1',
    participant: {
      agent_id: SUCCESSOR.agent_id,
      harness: 'pi',
      native_session_selector: SUCCESSOR.session_id,
      herdr_agent: 'pappra-successor',
      capability_card_ref: participantCardFile,
      capability_card_digest: sha256File(participantCardFile),
    },
    target: { choice: 'reuse', cwd, preserve_focus: true },
    binding_ref: reuseBindingFile,
  };
  return {
    root,
    domainRoot,
    taskRoot,
    cwd,
    inputRevision,
    assignmentFile,
    cardFile,
    participantCardFile,
    configFile,
    bundleRoot,
    extensionEntry,
    acceptedArtifactFile,
    baseBindingFile,
    message,
    request,
    reuseRequest,
    cleanup: () => cleanup(root),
  };
}

function fakeOps(
  value: Fixture,
  options: {
    readonly includeSuccessor?: boolean;
    readonly readiness?: 'ready' | 'timeout';
    readonly foreignProcess?: boolean;
    readonly splitUnknown?: boolean;
    readonly onVerifyCaller?: (call: number) => void | Promise<void>;
    readonly onPaneGet?: (call: number) => void | Promise<void>;
    readonly onTransportVerify?: () => void | Promise<void>;
    readonly onTransportPrompt?: () => void | Promise<void>;
  } = {},
) {
  const events: string[] = [];
  const counts = {
    verify: 0,
    list: 0,
    split: 0,
    paneGet: 0,
    processInfo: 0,
    start: 0,
    close: 0,
    prompt: 0,
  };
  const pane = paneSnapshot({
    paneId: 'w1:p2',
    terminalId: 'terminal-2',
    workspaceId: 'w1',
    cwd: value.cwd,
  });
  const caller: HerdrCallerObservation = {
    paneId: 'w1:p1',
    workspaceId: 'w1',
    tabId: 'w1:t1',
    harness: 'pi',
    cwd: value.cwd,
    sessionKind: 'id',
    sessionValue: SOURCE.session_id,
    source: 'explicit',
  };
  const sourceAgent = agentObservation({
    name: 'pappra-source',
    identity: SOURCE,
    paneId: 'w1:p1',
    cwd: value.cwd,
  });
  const successorAgent = agentObservation({
    name: 'pappra-successor',
    identity: SUCCESSOR,
    paneId: 'w1:p2',
    cwd: value.cwd,
  });
  let agents: HerdrAgentObservation[] = [
    sourceAgent,
    ...(options.includeSuccessor ? [successorAgent] : []),
  ];
  let processCall = 0;
  const transport: HerdrTransport = {
    id: 'fake-herdr',
    verifyCaller: async () => {
      await options.onTransportVerify?.();
      return { ok: true, caller };
    },
    list: async (): Promise<HerdrListResult> => ({ ok: true, agents }),
    prompt: async (): Promise<HerdrPromptResult> => {
      counts.prompt += 1;
      events.push('transport-prompt');
      await options.onTransportPrompt?.();
      return { status: 'submitted', detail: null };
    },
  };
  const ops: HerdrBootstrapOps = {
    id: 'fake-herdr-bootstrap',
    transport,
    verifyCaller: async (paneId) => {
      counts.verify += 1;
      events.push('verify-caller');
      if (paneId !== undefined && paneId !== null && paneId !== caller.paneId)
        return {
          ok: false,
          status: 'unverified',
          code: 'caller_pane_mismatch',
          detail: 'caller pane mismatch',
        };
      await options.onVerifyCaller?.(counts.verify);
      return { ok: true, caller };
    },
    listAgents: async () => {
      counts.list += 1;
      events.push('list-agents');
      return { ok: true, agents };
    },
    paneGet: async (paneId) => {
      counts.paneGet += 1;
      events.push(`pane-get:${paneId}`);
      await options.onPaneGet?.(counts.paneGet);
      return operationOk('pane.get', pane);
    },
    paneProcessInfo: async (paneId) => {
      counts.processInfo += 1;
      events.push(`process-info:${paneId}`);
      processCall += 1;
      const busy = options.readiness === 'timeout' && processCall === 1;
      const foreign = options.foreignProcess === true;
      const value: BootstrapProcessSnapshot = {
        paneId,
        shellPid: 51,
        foregroundProcessGroupId: foreign || busy ? 17 : 51,
        tty: 'pts/2',
        foregroundProcesses:
          foreign || busy
            ? [{ pid: 17, name: 'git' }]
            : [{ pid: 51, name: 'zsh' }],
      };
      return operationOk('pane.process-info', value);
    },
    splitPane: async (input) => {
      counts.split += 1;
      events.push('split');
      await input.onReceipt?.(commandReceipt('pane.split'));
      if (options.splitUnknown)
        return {
          ok: false,
          status: 'unknown',
          code: 'herdr_command_timeout',
          detail: 'split outcome unknown',
          correlationId: null,
          receipt: commandReceipt('pane.split'),
        };
      return operationOk('pane.split', pane);
    },
    startAgent: async (input) => {
      counts.start += 1;
      events.push('start-agent');
      await input.onReceipt?.(commandReceipt('agent.start'));
      const name = `pappra-${createHash('sha256').update(value.request.request_id).digest('hex').slice(0, 8)}`;
      agents = [
        ...agents,
        agentObservation({
          name,
          identity: SUCCESSOR,
          paneId: pane.paneId,
          cwd: value.cwd,
        }),
      ];
      const started: BootstrapStartedAgent = {
        name,
        harness: 'pi',
        paneId: pane.paneId,
        workspaceId: pane.workspaceId,
        terminalId: pane.terminalId,
        cwd: value.cwd,
        agentStatus: 'working',
        interactiveReady: true,
        launchPending: false,
        sessionKind: 'id',
        sessionValue: SUCCESSOR.session_id,
        argv: [
          'pi',
          '--session-id',
          SUCCESSOR.session_id,
          '--name',
          name,
          '--extension',
          value.extensionEntry,
          ...(input.openrouterModel
            ? ['--provider', 'openrouter', '--model', input.openrouterModel]
            : []),
        ],
      };
      return operationOk('agent.start', started);
    },
    closePane: async (input) => {
      counts.close += 1;
      events.push('close-pane');
      await input.onReceipt?.(commandReceipt('pane.close'));
      return operationOk('pane.close', { paneId: input.paneId, closed: true });
    },
  };
  return { ops, events, counts, transport, caller, pane };
}

function notifyResult(
  value: Fixture,
  request: VisibleBootstrapRequest,
  targetPane: string,
): NotifyResult {
  const name =
    request.participant.herdr_agent ??
    `pappra-${createHash('sha256').update(request.request_id).digest('hex').slice(0, 8)}`;
  return {
    status: 'submitted',
    messageId: request.message_pointer.message_id,
    messagePath: request.message_pointer.content_ref,
    messageDigest: request.message_pointer.content_digest,
    taskId: 'sample',
    recipient: {
      agent_id: request.participant.agent_id,
      harness: request.participant.harness,
    },
    target: {
      herdr_agent: name,
      pane_id: targetPane,
      harness: request.participant.harness,
      cwd: value.cwd,
      native_session: 'match',
      native_session_kind: 'id',
    },
    caller: {
      source: 'explicit',
      paneId: 'w1:p1',
      harness: 'pi',
      cwd: value.cwd,
      observedAt: new Date(NOW).toISOString(),
      nativeSession: 'match',
      nativeSessionKind: 'id',
      processAffiliation: 'not-established',
    },
    transport: 'herdr',
    deliveryPath: null,
    attempts: 1,
    priorStatus: null,
    detail: null,
    consumed: false,
    taskAccepted: false,
  };
}

function dependencies(
  value: Fixture,
  host: ReturnType<typeof fakeOps>,
  options: {
    readonly notifyStatus?: 'submitted' | 'unknown';
    readonly beforeNotify?: (request: NotifyOptions) => void;
    readonly useDefaultNotify?: boolean;
    readonly signal?: AbortSignal;
  } = {},
  request: VisibleBootstrapRequest = value.request,
): VisibleBootstrapDependencies {
  const common: VisibleBootstrapDependencies = {
    ops: host.ops,
    acceptedArtifactPath: value.acceptedArtifactFile,
    clock: () => NOW,
    sleeper: async () => undefined,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  if (options.useDefaultNotify) return common;
  const notificationStatus = options.notifyStatus ?? 'submitted';
  return {
    ...common,
    notify: async (notifyOptions) => {
      host.events.push('notify');
      options.beforeNotify?.(notifyOptions);
      const result = notifyResult(value, request, 'w1:p2');
      return { ok: true, value: { ...result, status: notificationStatus } };
    },
  };
}

function managedRequest(value: Fixture): {
  readonly request: VisibleBootstrapRequest;
  readonly sdkModulePath: string;
  readonly journalPath: string;
  readonly automaticHandoffFile: string;
  readonly handoffContextFile: string;
} {
  const parent = join(value.root, "managed space ' $ `tick`");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const sdkModulePath = join(parent, 'pinned sdk entry.mjs');
  const journalPath = join(parent, 'sdk journal.jsonl');
  const automaticHandoffFile = join(parent, 'future handoff.json');
  const handoffContextFile = join(parent, 'handoff context.json');
  writeFileSync(sdkModulePath, 'export const VERSION = "1.4.0";\n', {
    mode: 0o400,
  });
  return {
    request: {
      ...value.request,
      selected_model: {
        preserve_daily: true,
        openrouter_model: 'openai/gpt-6-luna',
      },
      managed_runtime: {
        sdk_module_path: sdkModulePath,
        journal_path: journalPath,
        automatic_handoff_file: automaticHandoffFile,
        handoff_context_file: handoffContextFile,
      },
    },
    sdkModulePath,
    journalPath,
    automaticHandoffFile,
    handoffContextFile,
  };
}

function managedStartReceipt(
  input: BootstrapManagedSdkStartInput,
): BootstrapCommandReceipt {
  return {
    operation: 'managed-sdk.start',
    argv: ['herdr', ...managedSdkStartArgs(input)],
    code: 0,
    signal: null,
    spawned: true,
    timed_out: false,
    spawn_error: null,
    stdout: '{"result":{"type":"pane_run"}}',
    stderr: '',
  };
}

function managedStartedSdk(
  input: BootstrapManagedSdkStartInput,
  pane: BootstrapPaneSnapshot,
): BootstrapStartedManagedSdk {
  return {
    agentName: input.name,
    harness: 'pi',
    paneId: input.paneId,
    cwd: input.cwd,
    status: 'working',
    sessionId: input.sessionId,
    identityProvenance: 'owned-pi-sdk-control',
    controlSchema: 'harness-collab/pi-managed-sdk-session/1',
    processPid: 52,
    socketPeerPid: 52,
    foregroundProcessPid: 52,
    pane,
    launch: {
      runtime: 'sdk',
      sdkModulePath: input.sdkModulePath,
      bootstrapExtensionPath: input.bootstrapExtensionPath,
      herdrAgentName: input.name,
      journalPath: input.journalPath,
      sessionId: input.sessionId,
      cwd: input.cwd,
      model: { provider: 'openrouter', id: input.openrouterModel },
      ready: true,
    },
  };
}

function attachManagedStart(
  host: ReturnType<typeof fakeOps>,
  outcome: 'success' | 'unknown' = 'success',
) {
  let calls = 0;
  let managedAgent: HerdrAgentObservation | null = null;
  const originalList = host.ops.listAgents;
  host.ops.listAgents = async () => {
    const listed = await originalList();
    return listed.ok && managedAgent !== null
      ? { ok: true, agents: [...listed.agents, managedAgent] }
      : listed;
  };
  host.ops.startManagedSdk = async (input) => {
    calls += 1;
    const config = JSON.parse(readFileSync(input.configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    assert.deepEqual(config, {
      schema: 'pappra/managed-pi-session-request/1',
      cwd: input.cwd,
      model: input.openrouterModel,
      journalPath: input.journalPath,
      controlSocketPath: input.controlSocketPath,
      runtime: 'sdk',
      sdkModulePath: input.sdkModulePath,
      sessionId: input.sessionId,
      bootstrapExtensionPath: input.bootstrapExtensionPath,
      herdrAgentName: input.name,
      herdrPaneId: input.paneId,
      automaticHandoffFile: input.automaticHandoffFile,
      handoffContextFile: input.handoffContextFile,
    });
    const file = lstatSync(input.configPath);
    assert.equal(file.isSymbolicLink(), false);
    assert.equal(file.mode & 0o777, 0o400);
    const receipt = managedStartReceipt(input);
    await input.onReceipt?.(receipt);
    if (outcome === 'unknown')
      return {
        ok: false as const,
        status: 'unknown' as const,
        code: 'managed_sdk_start_unknown',
        detail:
          'The pane command may have started but control evidence was late.',
        correlationId: null,
        receipt,
      };
    managedAgent = agentObservation({
      name: input.name,
      identity: SUCCESSOR,
      paneId: input.paneId,
      cwd: input.cwd,
    });
    return {
      ok: true as const,
      value: managedStartedSdk(input, host.pane),
      correlationId: 'managed-sdk-control',
      receipt,
    };
  };
  return { calls: () => calls };
}

function admitCancellation(value: Fixture, messageId: string, clock: number) {
  const message = buildMessage(
    {
      message_id: messageId,
      type: 'CANCEL',
      task_id: 'sample',
      from: COORDINATOR,
      to: SOURCE,
      subtask_id: 'work',
      attempt: 1,
      owner_epoch: 1,
      body: {},
    },
    { clock },
  );
  return submitMessage(value.taskRoot, message, { clock });
}

test('explicit startup budget is validated and forwarded to the owned agent', async () => {
  const value = fixture('bootstrap-start-budget');
  try {
    const request = {
      ...value.request,
      target: { ...value.request.target, start_timeout_ms: 300_000 },
    };
    const host = fakeOps(value);
    const start = host.ops.startAgent;
    let budget = 0;
    host.ops.startAgent = async (input) => {
      budget = input.timeoutMs ?? 0;
      return start(input);
    };
    const result = await applyVisibleBootstrap(
      request,
      dependencies(value, host, {}, request),
    );
    assert.equal(result.status, 'applied', JSON.stringify(result));
    assert.equal(budget, 300_000);
    for (const timeout of [0, -1, 600_001]) {
      assert.equal(
        validateVisibleBootstrapRequest({
          ...request,
          target: { ...request.target, start_timeout_ms: timeout },
        }).ok,
        false,
      );
    }
  } finally {
    value.cleanup();
  }
});

test('a dead owner can retry an exact bootstrap reservation only before any native intent', async () => {
  for (const phase of ['reserved', 'split_intent']) {
    const value = fixture(`bootstrap-dead-owner-${phase}`);
    try {
      const identity = captureProcessIdentity();
      assert(identity);
      const saved = transact(value.taskRoot, {
        actor: 'fixture',
        purpose: 'seed-interrupted-bootstrap',
        apply(record) {
          record.launch_reservations = [
            {
              reservation_id: 'dead-bootstrap',
              subtask_id: 'work',
              attempt: 1,
              kind: 'pi',
              mode: 'visible-bootstrap',
              holder: SUCCESSOR,
              requested_session_id: SUCCESSOR.session_id,
              transport: 'herdr',
              reserved_at: new Date(NOW).toISOString(),
              released_at: null,
              outcome: null,
              phase,
              bootstrap: {
                request_id: value.request.request_id,
                request_digest: `sha256:${createHash('sha256').update(JSON.stringify(value.request)).digest('hex')}`,
                process_identity: {
                  ...identity,
                  boot: `sha256:${'0'.repeat(64)}`,
                },
                phase,
                created_pane_id: null,
                receipts: [],
              },
            },
          ];
          return { record, op: 'fixture', summary: {}, result: null };
        },
      });
      assert(saved.ok);
      const host = fakeOps(value);
      const result = await applyVisibleBootstrap(
        value.request,
        dependencies(value, host),
      );
      if (phase === 'reserved') {
        assert.equal(result.status, 'applied', JSON.stringify(result));
        assert.equal(host.counts.split, 1);
      } else {
        assert.equal(result.code, 'request_in_progress_or_ambiguous');
        assert.equal(host.counts.split, 0);
      }
    } finally {
      value.cleanup();
    }
  }
});

test('known failed agent start releases its reservation only after proving and closing the empty owned pane', async () => {
  const value = fixture('bootstrap-start-no-effect');
  try {
    const host = fakeOps(value);
    host.ops.startAgent = async () => ({
      ok: false,
      status: 'failed',
      code: 'spawn_failed',
      detail: 'fixture no process spawned',
      correlationId: null,
      receipt: {
        ...commandReceipt('agent.start'),
        spawned: false,
        code: null,
        spawn_error: 'ENOENT',
      },
    });
    const result = await applyVisibleBootstrap(
      value.request,
      dependencies(value, host),
    );
    assert.equal(result.status, 'failed');
    assert.equal(host.counts.close, 1);
    assert.equal(host.counts.prompt, 0);
    const reservation = readRecord(value.taskRoot)!.launch_reservations![0]!;
    assert.notEqual(reservation.released_at, null);
    assert.equal(reservation.outcome, 'not_started');
  } finally {
    value.cleanup();
  }
});

test('plan is read-only and projects the exact visible Pi gate launch', async () => {
  const value = fixture('bootstrap-plan');
  try {
    const host = fakeOps(value);
    const taskBefore = snapshotTree(value.taskRoot);
    const bundleBefore = snapshotTree(value.bundleRoot);
    const report = await planVisibleBootstrap(
      value.request,
      dependencies(value, host),
    );
    assert.equal(report.status, 'planned', JSON.stringify(report));
    assert.equal(report.ok, true);
    assert.equal(
      (report.target as Record<string, unknown>)['pane_id'],
      '<created-pane-id>',
    );
    const argv = (report.target as Record<string, unknown>)[
      'launch_argv'
    ] as string[];
    assert.ok(argv.includes('--session-id'));
    assert.ok(argv.includes(SUCCESSOR.session_id));
    assert.ok(argv.includes('--extension'));
    assert.ok(argv.includes(value.extensionEntry));
    assert.equal(argv.includes('--model'), false);
    assert.equal(host.counts.split, 0);
    assert.equal(host.counts.start, 0);
    assert.equal(host.counts.close, 0);
    assert.equal(host.counts.processInfo, 0);
    assert.equal(host.events.includes('notify'), false);
    assert.deepEqual(snapshotTree(value.taskRoot), taskBefore);
    assert.deepEqual(snapshotTree(value.bundleRoot), bundleBefore);
  } finally {
    value.cleanup();
  }
});

test('apply composes reserve, visible sibling, readiness, exact gate start, binding and one notification', async () => {
  const value = fixture('bootstrap-apply');
  try {
    const host = fakeOps(value);
    let notificationCalls = 0;
    const deps = dependencies(value, host, {
      beforeNotify: ({ taskRoot, bindingFile }) => {
        notificationCalls += 1;
        const record = readRecord(taskRoot);
        assert.ok(record);
        const reservation = record.launch_reservations?.find(
          (entry) =>
            entry['bootstrap'] &&
            (entry['bootstrap'] as Record<string, unknown>)['request_id'] ===
              value.request.request_id,
        );
        assert.ok(reservation);
        assert.equal(
          (reservation['bootstrap'] as Record<string, unknown>)['phase'],
          'notify_pending',
        );
        assert.ok(existsSync(bindingFile));
      },
    });
    const report = await applyVisibleBootstrap(value.request, deps);
    assert.equal(report.status, 'applied');
    assert.equal(report.ok, true);
    assert.equal(host.counts.split, 1);
    assert.equal(host.counts.processInfo, 1);
    assert.equal(host.counts.start, 1);
    assert.equal(host.counts.close, 0);
    assert.equal(notificationCalls, 1);
    assert.ok(
      host.events.indexOf('split') < host.events.indexOf('start-agent'),
    );
    assert.ok(
      host.events.indexOf('start-agent') < host.events.indexOf('notify'),
    );
    assert.equal(
      (report.notification as Record<string, unknown>)['consumed'],
      false,
    );
    const record = readRecord(value.taskRoot);
    assert.ok(record);
    const reservation = record.launch_reservations?.find(
      (entry) =>
        entry['bootstrap'] &&
        (entry['bootstrap'] as Record<string, unknown>)['request_id'] ===
          value.request.request_id,
    );
    assert.ok(reservation);
    assert.equal(
      (reservation['bootstrap'] as Record<string, unknown>)['phase'],
      'completed',
    );
    const duplicate = await applyVisibleBootstrap(value.request, deps);
    assert.equal(duplicate.status, 'already_recorded');
    assert.equal(host.counts.split, 1);
    assert.equal(host.counts.start, 1);
    assert.equal(notificationCalls, 1);
  } finally {
    value.cleanup();
  }
});

test('ambiguous notification is durably reconciled and never retried on duplicate apply', async () => {
  const value = fixture('bootstrap-ambiguous-notify');
  try {
    const host = fakeOps(value);
    let notificationCalls = 0;
    const deps = dependencies(value, host, {
      notifyStatus: 'unknown',
      beforeNotify: () => {
        notificationCalls += 1;
      },
    });
    const first = await applyVisibleBootstrap(value.request, deps);
    assert.equal(first.status, 'unknown');
    assert.equal(notificationCalls, 1);
    const second = await applyVisibleBootstrap(value.request, deps);
    assert.equal(second.status, 'reconcile_required');
    assert.equal(notificationCalls, 1);
    assert.equal(host.counts.split, 1);
    assert.equal(host.counts.start, 1);
  } finally {
    value.cleanup();
  }
});

test('unknown split outcome is durable and duplicate apply does not split again', async () => {
  const value = fixture('bootstrap-unknown-split');
  try {
    const host = fakeOps(value, { splitUnknown: true });
    const first = await applyVisibleBootstrap(
      value.request,
      dependencies(value, host),
    );
    assert.equal(first.status, 'unknown');
    assert.equal(host.counts.split, 1);
    assert.equal(host.counts.start, 0);
    assert.equal(host.counts.close, 0);
    assert.equal(host.events.includes('notify'), false);
    const second = await applyVisibleBootstrap(
      value.request,
      dependencies(value, host),
    );
    assert.equal(second.status, 'reconcile_required');
    assert.equal(host.counts.split, 1);
    assert.equal(host.counts.start, 0);
  } finally {
    value.cleanup();
  }
});

test('readiness timeout closes only the still-empty owned pane and never starts Pi', async () => {
  const value = fixture('bootstrap-cleanup');
  try {
    const host = fakeOps(value, { readiness: 'timeout' });
    const request: VisibleBootstrapRequest = {
      ...value.request,
      request_id: 'bootstrap-timeout-1',
      readiness: { max_samples: 1 },
    };
    const report = await applyVisibleBootstrap(
      request,
      dependencies(value, host),
    );
    assert.equal(report.status, 'failed');
    assert.equal(host.counts.split, 1);
    assert.equal(host.counts.processInfo, 2);
    assert.equal(host.counts.start, 0);
    assert.equal(host.counts.close, 1);
    assert.equal(
      (report.target as Record<string, unknown>)['pane_id'],
      'w1:p2',
    );
  } finally {
    value.cleanup();
  }
});

test('existing-participant reuse prompts once without process-info, split, start or close', async () => {
  const value = fixture('bootstrap-reuse');
  try {
    const host = fakeOps(value, { includeSuccessor: true });
    const report = await applyVisibleBootstrap(
      value.reuseRequest,
      dependencies(value, host, {}, value.reuseRequest),
    );
    assert.equal(report.status, 'applied');
    assert.equal(host.counts.processInfo, 0);
    assert.equal(host.counts.split, 0);
    assert.equal(host.counts.start, 0);
    assert.equal(host.counts.close, 0);
    assert.equal(host.events.filter((event) => event === 'notify').length, 1);
  } finally {
    value.cleanup();
  }
});

test('CANCEL admitted during the final caller lookup prevents pane split', async () => {
  const value = fixture('bootstrap-late-cancel-caller');
  try {
    const host = fakeOps(value, {
      onVerifyCaller: (call) => {
        if (call !== 2) return;
        const admitted = admitCancellation(
          value,
          'msg-late-cancel-caller',
          NOW + 4,
        );
        assert.equal(admitted.ok, true, JSON.stringify(admitted));
      },
    });
    const report = await applyVisibleBootstrap(
      value.request,
      dependencies(value, host),
    );
    assert.equal(report.status, 'needs_input', JSON.stringify(report));
    assert.equal(host.counts.split, 0);
    assert.equal(host.counts.start, 0);
  } finally {
    value.cleanup();
  }
});

test('approval admitted during the final caller lookup prevents pane split', async () => {
  const value = fixture('bootstrap-late-approval-caller');
  try {
    const host = fakeOps(value, {
      onVerifyCaller: (call) => {
        if (call !== 2) return;
        const message = buildMessage(
          {
            message_id: 'msg-late-approval-caller',
            type: 'BLOCK',
            task_id: 'sample',
            from: COORDINATOR,
            to: SOURCE,
            subtask_id: 'work',
            attempt: 1,
            owner_epoch: 1,
            body: { kind: 'approval' },
          },
          { clock: NOW + 4 },
        );
        const admitted = submitMessage(value.taskRoot, message, {
          clock: NOW + 4,
        });
        assert.equal(admitted.ok, true, JSON.stringify(admitted));
      },
    });
    const report = await applyVisibleBootstrap(
      value.request,
      dependencies(value, host),
    );
    assert.equal(report.status, 'needs_input', JSON.stringify(report));
    assert.equal(host.counts.split, 0);
    assert.equal(host.counts.start, 0);
  } finally {
    value.cleanup();
  }
});

test('abort during the final caller lookup prevents pane split', async () => {
  const value = fixture('bootstrap-abort-caller');
  try {
    const controller = new AbortController();
    const host = fakeOps(value, {
      onVerifyCaller: (call) => {
        if (call === 2) controller.abort();
      },
    });
    const report = await applyVisibleBootstrap(
      value.request,
      dependencies(value, host, { signal: controller.signal }),
    );
    assert.equal(report.status, 'needs_input', JSON.stringify(report));
    assert.equal(host.counts.split, 0);
    assert.equal(host.counts.start, 0);
  } finally {
    value.cleanup();
  }
});

test('CANCEL admitted during the final pane lookup prevents native start', async () => {
  const value = fixture('bootstrap-late-cancel-pane');
  try {
    const host = fakeOps(value, {
      onPaneGet: (call) => {
        if (call !== 3) return;
        const admitted = admitCancellation(
          value,
          'msg-late-cancel-pane',
          NOW + 5,
        );
        assert.equal(admitted.ok, true, JSON.stringify(admitted));
      },
    });
    const report = await applyVisibleBootstrap(
      value.request,
      dependencies(value, host),
    );
    assert.notEqual(report.status, 'applied', JSON.stringify(report));
    assert.equal(host.counts.start, 0);
  } finally {
    value.cleanup();
  }
});

test('task message-directory replacement during the final pane lookup prevents native start', async () => {
  const value = fixture('bootstrap-namespace-drift');
  try {
    const host = fakeOps(value, {
      onPaneGet: (call) => {
        if (call !== 3) return;
        const messagesDirectory = join(value.taskRoot, 'messages');
        renameSync(messagesDirectory, join(value.root, 'messages-detached'));
        mkdirSync(messagesDirectory);
      },
    });
    const report = await applyVisibleBootstrap(
      value.request,
      dependencies(value, host),
    );
    assert.notEqual(report.status, 'applied', JSON.stringify(report));
    assert.equal(host.counts.start, 0);
  } finally {
    value.cleanup();
  }
});

test('claim release or coordinator epoch drift during final pane lookup prevents native start', async () => {
  for (const change of ['claim', 'epoch'] as const) {
    const value = fixture(`bootstrap-late-${change}-drift`);
    try {
      const host = fakeOps(value, {
        onPaneGet: (call) => {
          if (call !== 3) return;
          if (change === 'claim') {
            const record = readRecord(value.taskRoot);
            assert.ok(record);
            const released = releaseClaim(value.taskRoot, {
              claimId: record.claims[0]!.claim_id,
              holder: SOURCE,
              reason: 'late fixture claim revocation',
              clock: NOW + 7,
            });
            assert.equal(released.ok, true, JSON.stringify(released));
          } else {
            const changed = transact(value.taskRoot, {
              actor: 'fixture',
              purpose: 'late-fixture-epoch-drift',
              clock: NOW + 7,
              apply: (record) => {
                record.coordinator!.owner_epoch = 2;
                return {
                  record,
                  op: 'late-fixture-epoch-drift',
                  summary: {},
                  result: {},
                };
              },
            });
            assert.equal(changed.ok, true, JSON.stringify(changed));
          }
        },
      });
      const report = await applyVisibleBootstrap(
        value.request,
        dependencies(value, host),
      );
      assert.notEqual(report.status, 'applied', JSON.stringify(report));
      assert.equal(host.counts.start, 0);
    } finally {
      value.cleanup();
    }
  }
});

test('abort at the registered-message prompt boundary blocks both sibling and reuse prompts', async () => {
  for (const reuse of [false, true]) {
    const value = fixture(
      `bootstrap-abort-prompt-${reuse ? 'reuse' : 'sibling'}`,
    );
    try {
      const controller = new AbortController();
      const host = fakeOps(value, {
        includeSuccessor: reuse,
        onTransportVerify: () => controller.abort(),
      });
      const request = reuse ? value.reuseRequest : value.request;
      const report = await applyVisibleBootstrap(
        request,
        dependencies(
          value,
          host,
          { useDefaultNotify: true, signal: controller.signal },
          request,
        ),
      );
      assert.equal(report.status, 'unknown', JSON.stringify(report));
      assert.equal(host.counts.prompt, 0);
      assert.equal(host.counts.split, reuse ? 0 : 1);
      assert.equal(host.counts.start, reuse ? 0 : 1);
    } finally {
      value.cleanup();
    }
  }
});

test('approval and cancellation gates stop before Herdr observations or native effects', async () => {
  const approval = fixture('bootstrap-awaiting-approval');
  try {
    const block = buildMessage(
      {
        message_id: 'msg-approval-block',
        type: 'BLOCK',
        task_id: 'sample',
        from: COORDINATOR,
        to: SOURCE,
        subtask_id: 'work',
        attempt: 1,
        owner_epoch: 1,
        body: { kind: 'approval' },
      },
      { clock: NOW + 2 },
    );
    const blocked = submitMessage(approval.taskRoot, block, { clock: NOW + 2 });
    assert.equal(blocked.ok, true, JSON.stringify(blocked));
    const host = fakeOps(approval);
    const report = await planVisibleBootstrap(
      approval.request,
      dependencies(approval, host),
    );
    assert.equal(report.status, 'needs_input');
    assert.equal(report.code, 'awaiting_approval');
    assert.equal(host.counts.verify, 0);
    assert.equal(host.counts.split, 0);
  } finally {
    approval.cleanup();
  }

  const cancellation = fixture('bootstrap-cancel-pending');
  try {
    const cancel = buildMessage(
      {
        message_id: 'msg-cancel-request',
        type: 'CANCEL',
        task_id: 'sample',
        from: COORDINATOR,
        to: SOURCE,
        subtask_id: 'work',
        attempt: 1,
        owner_epoch: 1,
        body: {},
      },
      { clock: NOW + 3 },
    );
    const recorded = submitMessage(cancellation.taskRoot, cancel, {
      clock: NOW + 3,
    });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    const host = fakeOps(cancellation);
    const report = await planVisibleBootstrap(
      cancellation.request,
      dependencies(cancellation, host),
    );
    assert.equal(report.status, 'needs_input');
    assert.equal(report.code, 'cancel_unconfirmed');
    assert.equal(host.counts.verify, 0);
    assert.equal(host.counts.split, 0);
  } finally {
    cancellation.cleanup();
  }
});

test('revoked claims and coordinator epoch drift stop before native effects', async () => {
  const revoked = fixture('bootstrap-revoked-claim');
  try {
    const record = readRecord(revoked.taskRoot);
    assert.ok(record);
    const claim = record.claims[0]!;
    const released = releaseClaim(revoked.taskRoot, {
      claimId: claim.claim_id,
      holder: SOURCE,
      reason: 'fixture revocation',
    });
    assert.equal(released.ok, true, JSON.stringify(released));
    const host = fakeOps(revoked);
    const report = await planVisibleBootstrap(
      revoked.request,
      dependencies(revoked, host),
    );
    assert.equal(report.status, 'needs_input');
    assert.equal(report.code, 'claim_released');
    assert.equal(host.counts.split, 0);
    assert.equal(host.counts.start, 0);
  } finally {
    revoked.cleanup();
  }

  const epoch = fixture('bootstrap-epoch-drift');
  try {
    const changed = transact(epoch.taskRoot, {
      actor: 'fixture',
      purpose: 'fixture-epoch-drift',
      clock: NOW + 4,
      apply: (record) => {
        record.coordinator!.owner_epoch = 2;
        return { record, op: 'fixture-epoch-drift', summary: {}, result: {} };
      },
    });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    const host = fakeOps(epoch);
    const report = await planVisibleBootstrap(
      epoch.request,
      dependencies(epoch, host),
    );
    assert.equal(report.status, 'needs_input');
    assert.equal(report.code, 'coordinator_or_dispatch_state_invalid');
    assert.equal(host.counts.verify, 0);
    assert.equal(host.counts.split, 0);
  } finally {
    epoch.cleanup();
  }
});

test('stale capability evidence is rejected before resolving a caller', async () => {
  const value = fixture('bootstrap-stale-card');
  try {
    writeJson(value.cardFile, {
      ...cardFor(SOURCE, value.cwd),
      observed_at: new Date(NOW - 31 * 60_000).toISOString(),
    });
    const request: VisibleBootstrapRequest = {
      ...value.request,
      admission: {
        ...value.request.admission,
        capability_card_digest: sha256File(value.cardFile),
      },
    };
    const host = fakeOps(value);
    const report = await planVisibleBootstrap(
      request,
      dependencies(value, host),
    );
    assert.equal(report.status, 'needs_input');
    assert.equal(report.code, 'admission_not_ready');
    assert.equal(host.counts.verify, 0);
    assert.equal(host.counts.split, 0);
  } finally {
    value.cleanup();
  }
});

test('bundle manifest rejects symlink entries before any native mutation', async () => {
  const value = fixture('bootstrap-bundle-symlink');
  try {
    symlinkSync(
      value.acceptedArtifactFile,
      join(value.bundleRoot, 'unsafe-runtime-link.mjs'),
    );
    const host = fakeOps(value);
    const report = await planVisibleBootstrap(
      value.request,
      dependencies(value, host),
    );
    assert.equal(report.status, 'needs_input');
    assert.equal(report.code, 'bundle_symlink_refused');
    assert.equal(host.counts.split, 0);
    assert.equal(host.counts.start, 0);
  } finally {
    value.cleanup();
  }
});

test('public CLI rejects duplicate and unrelated flags before reading or applying a request', async () => {
  const out: string[] = [];
  const err: string[] = [];
  const output = {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
  };
  const duplicate = await runCli(
    [
      'collab',
      'bootstrap',
      'plan',
      '--task-root',
      '/tmp/task',
      '--request',
      '/tmp/request.json',
      '--task-root',
      '/tmp/other',
      '--json',
    ],
    output,
  );
  assert.equal(duplicate, 2);
  assert.match(out.join(''), /invalid_arguments/);
  const unrelated = await runCli(
    [
      'collab',
      'bootstrap',
      'apply',
      '--task-root',
      '/tmp/task',
      '--request',
      '/tmp/request.json',
      '--apply',
      '--json',
    ],
    output,
  );
  assert.equal(unrelated, 2);
  assert.match(out.join(''), /invalid_arguments/);
  const help = await runCli(['collab', 'bootstrap', 'plan', '--help'], output);
  assert.equal(help, 0);
  assert.match(out.join(''), /pappra collab bootstrap <plan\|apply>/);
  assert.deepEqual(err, []);
});

test('concurrent applies with one request id create at most one pane, agent and notification', async () => {
  const value = fixture('bootstrap-concurrent');
  try {
    const host = fakeOps(value);
    let notificationCalls = 0;
    const deps = dependencies(value, host, {
      beforeNotify: () => {
        notificationCalls += 1;
      },
    });
    const results = await Promise.all([
      applyVisibleBootstrap(value.request, deps),
      applyVisibleBootstrap(value.request, deps),
    ]);
    assert.ok(
      results.some(
        (result) =>
          result.status === 'applied' || result.status === 'already_recorded',
      ),
    );
    assert.ok(
      results.every((result) =>
        ['applied', 'already_recorded', 'reconcile_required'].includes(
          result.status,
        ),
      ),
    );
    assert.equal(host.counts.split, 1);
    assert.equal(host.counts.start, 1);
    assert.equal(notificationCalls, 1);
  } finally {
    value.cleanup();
  }
});

test('same request id with changed content is refused without repeating effects', async () => {
  const value = fixture('bootstrap-content-conflict');
  try {
    const host = fakeOps(value);
    const deps = dependencies(value, host);
    const first = await applyVisibleBootstrap(value.request, deps);
    assert.equal(first.status, 'applied');
    const changed: VisibleBootstrapRequest = {
      ...value.request,
      target: { ...value.request.target, direction: 'down' },
    };
    const conflict = await applyVisibleBootstrap(changed, deps);
    assert.equal(conflict.status, 'invalid');
    assert.equal(conflict.code, 'request_id_content_conflict');
    assert.equal(host.counts.split, 1);
    assert.equal(host.counts.start, 1);
  } finally {
    value.cleanup();
  }
});

test('model overrides and stale admission input are refused before native effects', async () => {
  const value = fixture('bootstrap-refusals');
  try {
    const badModel = validateVisibleBootstrapRequest({
      ...value.request,
      selected_model: { preserve_daily: true, model: 'unapproved-model' },
    });
    assert.equal(badModel.ok, false);
    assert.equal(badModel.ok ? null : badModel.code, 'model_override_refused');
    const host = fakeOps(value);
    const stale: VisibleBootstrapRequest = {
      ...value.request,
      admission: {
        ...value.request.admission,
        input_revision: hash('stale input'),
      },
    };
    const report = await planVisibleBootstrap(stale, dependencies(value, host));
    assert.equal(report.status, 'needs_input');
    assert.equal(report.code, 'input_revision_mismatch');
    assert.equal(host.counts.verify, 0);
    assert.equal(host.counts.split, 0);
    assert.equal(host.counts.start, 0);
    assert.equal(host.events.includes('notify'), false);
  } finally {
    value.cleanup();
  }
});

test('fresh successor pins an explicit OpenRouter model while preserving daily resources', async () => {
  const value = fixture('bootstrap-openrouter-selection');
  try {
    const request: VisibleBootstrapRequest = {
      ...value.request,
      selected_model: {
        preserve_daily: true,
        openrouter_model: 'openai/gpt-6-luna',
      },
    };
    const valid = validateVisibleBootstrapRequest(request);
    assert.equal(valid.ok, true);
    assert.equal(
      valid.request.selected_model.openrouter_model,
      'openai/gpt-6-luna',
    );
    const host = fakeOps(value);
    const deps = dependencies(value, host, {}, request);
    const planned = await planVisibleBootstrap(request, deps);
    assert.equal(planned.status, 'planned');
    const argv = planned.target?.['launch_argv'] as string[];
    assert.deepEqual(argv.slice(-4), [
      '--provider',
      'openrouter',
      '--model',
      'openai/gpt-6-luna',
    ]);
    assert.equal(host.counts.start, 0);
    const applied = await applyVisibleBootstrap(request, deps);
    assert.equal(applied.status, 'applied', JSON.stringify(applied));
    assert.equal(host.counts.start, 1);
    const changed = await applyVisibleBootstrap(
      {
        ...request,
        selected_model: {
          preserve_daily: true,
          openrouter_model: 'another/model',
        },
      },
      deps,
    );
    assert.equal(changed.code, 'request_id_content_conflict');
    assert.equal(host.counts.start, 1);
    assert.equal(
      validateVisibleBootstrapRequest({
        ...request,
        target: { ...request.target, choice: 'reuse' },
      }).ok,
      false,
    );
    assert.equal(
      validateVisibleBootstrapRequest({
        ...request,
        selected_model: {
          preserve_daily: true,
          openrouter_model: '--no-tools',
        },
      }).ok,
      false,
    );
  } finally {
    value.cleanup();
  }
});

test('a successor reporting another model is never routed even after a successful start receipt', async () => {
  const value = fixture('bootstrap-openrouter-drift');
  try {
    const request: VisibleBootstrapRequest = {
      ...value.request,
      selected_model: {
        preserve_daily: true,
        openrouter_model: 'openai/gpt-6-luna',
      },
    };
    const host = fakeOps(value);
    const start = host.ops.startAgent;
    host.ops.startAgent = async (input) => {
      const result = await start(input);
      return result.ok
        ? {
            ...result,
            value: {
              ...result.value,
              argv: result.value.argv.map((item) =>
                item === 'openai/gpt-6-luna' ? 'another/model' : item,
              ),
            },
          }
        : result;
    };
    const report = await applyVisibleBootstrap(
      request,
      dependencies(value, host, {}, request),
    );
    assert.equal(report.status, 'unknown', JSON.stringify(report));
    assert.equal(host.events.includes('notify'), false);
    assert.equal(host.counts.start, 1);
  } finally {
    value.cleanup();
  }
});

test('managed SDK request pins exact config and binds only authenticated native identity', async () => {
  const value = fixture('bootstrap-managed-sdk-success');
  const managed = managedRequest(value);
  try {
    const host = fakeOps(value);
    const starter = attachManagedStart(host);
    const deps = dependencies(value, host, {}, managed.request);
    const plan = await planVisibleBootstrap(managed.request, deps);
    assert.equal(plan.status, 'planned', JSON.stringify(plan));
    const planArgv = plan.target?.['launch_argv'] as string[];
    assert.deepEqual(planArgv.slice(1, 3), ['pane', 'run']);
    assert.equal(planArgv.includes('agent'), false);
    assert.equal(starter.calls(), 0);

    const report = await applyVisibleBootstrap(managed.request, deps);
    assert.equal(report.status, 'applied', JSON.stringify(report));
    assert.equal(starter.calls(), 1);
    assert.equal(host.counts.start, 0);
    const bootstrap = report.bootstrap as Record<string, unknown>;
    assert.equal(bootstrap['runtime'], 'managed_sdk_control_observed');
    const control = bootstrap['managed_sdk_control'] as Record<string, unknown>;
    assert.equal(control['session_id'], SUCCESSOR.session_id);
    assert.equal(control['sdk_module_path'], managed.sdkModulePath);
    assert.equal(control['bootstrap_extension_path'], value.extensionEntry);
    assert.equal(control['herdr_pane_id'], 'w1:p2');
    assert.equal(control['identity_provenance'], 'owned-pi-sdk-control');
    const model = bootstrap['model'] as Record<string, unknown>;
    assert.equal(model['provider'], 'openrouter');
    assert.equal(model['id'], 'openai/gpt-6-luna');
    assert.equal(model['observation'], 'owned-pi-sdk-control');
    const bindingPath = join(
      value.taskRoot,
      'notifications',
      'visible-bootstrap-bindings',
      `${managed.request.request_id}.json`,
    );
    const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as {
      participants: { native_session_id: string; pane_id: string }[];
    };
    assert.equal(
      binding.participants.find((item) => item.pane_id === 'w1:p2')
        ?.native_session_id,
      SUCCESSOR.session_id,
    );
    const changed: VisibleBootstrapRequest = {
      ...managed.request,
      managed_runtime: {
        ...managed.request.managed_runtime!,
        journal_path: join(value.root, 'different journal.jsonl'),
      },
    };
    const conflict = await applyVisibleBootstrap(changed, deps);
    assert.equal(conflict.code, 'request_id_content_conflict');
    assert.equal(starter.calls(), 1);
  } finally {
    value.cleanup();
  }
});

test('unknown managed SDK startup is durable and duplicate apply never queues again', async () => {
  const value = fixture('bootstrap-managed-sdk-unknown');
  const managed = managedRequest(value);
  try {
    const host = fakeOps(value);
    const starter = attachManagedStart(host, 'unknown');
    const deps = dependencies(value, host, {}, managed.request);
    const first = await applyVisibleBootstrap(managed.request, deps);
    assert.equal(first.status, 'unknown', JSON.stringify(first));
    assert.equal(starter.calls(), 1);
    const second = await applyVisibleBootstrap(managed.request, deps);
    assert.equal(second.status, 'reconcile_required');
    assert.equal(starter.calls(), 1);
    assert.equal(host.events.includes('notify'), false);
  } finally {
    value.cleanup();
  }
});

test('late approval before managed SDK launch blocks the start port', async () => {
  const value = fixture('bootstrap-managed-sdk-late-approval');
  const managed = managedRequest(value);
  try {
    const host = fakeOps(value, {
      onPaneGet: (call) => {
        if (call !== 3) return;
        const block = buildMessage(
          {
            message_id: 'msg-managed-late-approval',
            type: 'BLOCK',
            task_id: 'sample',
            from: COORDINATOR,
            to: SOURCE,
            subtask_id: 'work',
            attempt: 1,
            owner_epoch: 1,
            body: { kind: 'approval' },
          },
          { clock: NOW + 4 },
        );
        const submitted = submitMessage(value.taskRoot, block, {
          clock: NOW + 4,
        });
        assert.equal(submitted.ok, true, JSON.stringify(submitted));
      },
    });
    const starter = attachManagedStart(host);
    const report = await applyVisibleBootstrap(
      managed.request,
      dependencies(value, host, {}, managed.request),
    );
    assert.equal(report.status, 'needs_input', JSON.stringify(report));
    assert.equal(starter.calls(), 0);
    assert.equal(host.counts.start, 0);
  } finally {
    value.cleanup();
  }
});

test('managed SDK refuses a foreign session or pane process before launch', async () => {
  const collision = fixture('bootstrap-managed-sdk-session-collision');
  const managed = managedRequest(collision);
  try {
    const host = fakeOps(collision, { includeSuccessor: true });
    const starter = attachManagedStart(host);
    const report = await applyVisibleBootstrap(
      managed.request,
      dependencies(collision, host, {}, managed.request),
    );
    assert.equal(report.status, 'needs_input');
    assert.equal(report.code, 'managed_session_selector_in_use');
    assert.equal(host.counts.split, 0);
    assert.equal(starter.calls(), 0);
  } finally {
    collision.cleanup();
  }

  const foreign = fixture('bootstrap-managed-sdk-foreign-process');
  const foreignManaged = managedRequest(foreign);
  try {
    const host = fakeOps(foreign, { foreignProcess: true });
    const starter = attachManagedStart(host);
    const report = await applyVisibleBootstrap(
      foreignManaged.request,
      dependencies(foreign, host, {}, foreignManaged.request),
    );
    assert.notEqual(report.status, 'applied');
    assert.equal(starter.calls(), 0);
    assert.equal(host.counts.start, 0);
    assert.equal(host.counts.close, 0);
  } finally {
    foreign.cleanup();
  }
});

test('managed SDK rejects reuse, missing explicit model and invalid paths before native effects', async () => {
  const value = fixture('bootstrap-managed-sdk-invalid');
  const managed = managedRequest(value);
  try {
    assert.equal(
      validateVisibleBootstrapRequest({
        ...managed.request,
        target: { ...managed.request.target, choice: 'reuse' },
      }).ok,
      false,
    );
    assert.equal(
      validateVisibleBootstrapRequest({
        ...managed.request,
        selected_model: { preserve_daily: true },
      }).ok,
      false,
    );
    const invalid: VisibleBootstrapRequest = {
      ...managed.request,
      managed_runtime: {
        ...managed.request.managed_runtime!,
        sdk_module_path: join(value.root, 'missing-sdk-entry.mjs'),
      },
    };
    const host = fakeOps(value);
    const starter = attachManagedStart(host);
    const report = await applyVisibleBootstrap(
      invalid,
      dependencies(value, host, {}, invalid),
    );
    assert.equal(report.status, 'invalid');
    assert.equal(report.code, 'managed_sdk_module_invalid');
    assert.equal(host.counts.verify, 0);
    assert.equal(host.counts.split, 0);
    assert.equal(starter.calls(), 0);
  } finally {
    value.cleanup();
  }
});

test('bootstrap guard forwards registered prompt context unchanged to SDK-aware Herdr transport', async () => {
  const value = fixture('bootstrap-registered-prompt-context');
  try {
    const host = fakeOps(value);
    let registeredContext:
      | {
          readonly taskRoot: string;
          readonly messageId: string;
          readonly digest: string;
          readonly sessionId: string;
        }
      | undefined;
    host.transport.verifyCaller = async () => ({
      ok: true,
      caller: host.caller,
    });
    host.transport.prompt = async (_agent, _text, registered) => {
      registeredContext = registered;
      return { status: 'submitted', detail: null };
    };
    const report = await applyVisibleBootstrap(
      value.request,
      dependencies(value, host, { useDefaultNotify: true }),
    );
    assert.equal(report.status, 'applied', JSON.stringify(report));
    assert.deepEqual(registeredContext, {
      taskRoot: value.taskRoot,
      messageId: value.request.message_pointer.message_id,
      digest: sha256File(value.request.message_pointer.content_ref),
      sessionId: value.message.to.session_id,
    });
  } finally {
    value.cleanup();
  }
});
