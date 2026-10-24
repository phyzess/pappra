import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTaskStore } from '../../src/app/collab-task-store.js';
import { readRegisteredMessageSafe } from '../../src/app/collab-messages.js';
import { runCollaborationPreflight } from '../../src/app/collab-preflight.js';
import {
  watchRoleOrchestration,
  type RoleEventWatcher,
} from '../../src/app/collab-role-events.js';
import {
  COLLAB_ROLE_PLAN_SCHEMA,
  expandRolePlan,
  type RolePlanRequest,
} from '../../src/app/collab-role-plan.js';
import { readBoundedFile } from '../../src/app/bounded-file.js';
import type { ManagedPiSdkSessionSnapshot } from '../../src/hosts/pi/managed-sdk-session.js';
import { contentDigest } from '../../src/collab/envelope.js';
import {
  isAssignment,
  isCard,
  type Assignment,
  type CapabilityCard,
} from '../../src/collab/contracts.js';
import type { Identity, Message } from '../../src/collab/types.js';
import type { RoleOrchestrationResult } from '../../src/app/collab-role-orchestration.js';

const READINESS_SCHEMA = 'harness-collab/pi-managed-session/1';
const RESOURCES_READY_PHASE = 'interactive_mode_init_complete';

export interface ManagedRoleLifecyclePlanInput {
  readonly planId: string;
  readonly taskId: string;
  readonly ownerEpoch: number;
  readonly cwd: string;
  readonly inputRevision: string;
  readonly planner: Identity;
  readonly writerA: Identity;
  readonly writerB: Identity;
  readonly reviewer: Identity;
  readonly resources: {
    readonly planner: string;
    readonly writerA: string;
    readonly writerB: string;
    readonly reviewer: string;
  };
}

/** Planner first, disjoint writers next, reviewer gated by both accepted writers. */
export function buildManagedRoleLifecyclePlan(
  input: ManagedRoleLifecyclePlanInput,
) {
  const root = path.resolve(input.cwd);
  for (const resource of Object.values(input.resources)) {
    const relative = path.relative(root, path.resolve(resource));
    if (
      !path.isAbsolute(resource) ||
      relative === '' ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    )
      throw new Error('managed_role_resource_outside_project');
  }
  const request: RolePlanRequest = {
    schema: COLLAB_ROLE_PLAN_SCHEMA,
    plan_id: input.planId,
    task_id: input.taskId,
    owner_epoch: input.ownerEpoch,
    participants: [
      { participant_id: 'planner', role: 'planner', assignee: input.planner },
      { participant_id: 'writer-a', role: 'writer', assignee: input.writerA },
      { participant_id: 'writer-b', role: 'writer', assignee: input.writerB },
      {
        participant_id: 'reviewer',
        role: 'reviewer',
        assignee: input.reviewer,
      },
    ],
    assignments: [
      {
        node_id: 'plan',
        role: 'planner',
        assignment_id: 'assignment-plan',
        attempt: 1,
        input_revision: input.inputRevision,
        participant_id: 'planner',
        resources: [{ path: input.resources.planner, access: 'write' }],
      },
      {
        node_id: 'write-a',
        role: 'writer',
        assignment_id: 'assignment-a',
        attempt: 1,
        input_revision: input.inputRevision,
        participant_id: 'writer-a',
        resources: [{ path: input.resources.writerA, access: 'write' }],
      },
      {
        node_id: 'write-b',
        role: 'writer',
        assignment_id: 'assignment-b',
        attempt: 1,
        input_revision: input.inputRevision,
        participant_id: 'writer-b',
        resources: [{ path: input.resources.writerB, access: 'write' }],
      },
      {
        node_id: 'review',
        role: 'reviewer',
        assignment_id: 'assignment-review',
        attempt: 1,
        input_revision: input.inputRevision,
        participant_id: 'reviewer',
        resources: [{ path: input.resources.reviewer, access: 'read' }],
      },
    ],
  };
  const expanded = expandRolePlan(request);
  if (!expanded.ok) throw new Error('managed_role_lifecycle_plan_invalid');
  assert.deepEqual(
    expanded.plan.nodes.find((node) => node.node_id === 'plan')?.depends_on,
    [],
  );
  assert.deepEqual(
    expanded.plan.nodes
      .filter((node) => node.role === 'writer')
      .map((node) => node.depends_on),
    [['plan'], ['plan']],
  );
  assert.deepEqual(
    expanded.plan.nodes.find((node) => node.node_id === 'review')?.depends_on,
    ['write-a', 'write-b'],
  );
  return { request, expanded };
}

/** Load REPORT/ANSWER only after the task-store registration API authenticates them. */
export interface TrustedRoleMessagePins {
  readonly taskRoot: string;
  readonly messageId: string;
  readonly type: 'REPORT' | 'ANSWER';
  readonly taskId: string;
  readonly assignmentId: string;
  readonly attempt: number;
  readonly ownerEpoch: number;
  readonly from: Identity;
  readonly to: Identity;
  readonly replyTo?: string;
}

export async function captureTrustedProtocolMessage(
  pins: TrustedRoleMessagePins,
): Promise<{ readonly message: Message; readonly digest: string }> {
  const opened = await openTaskStore(pins.taskRoot);
  if (!opened.ok) throw new Error('managed_role_task_store_unavailable');
  const registered = await readRegisteredMessageSafe(
    opened.value,
    pins.messageId,
  );
  if (!registered.ok)
    throw new Error('managed_role_protocol_message_untrusted');
  const message = registered.value.message;
  const sameIdentity = (actual: Identity, expected: Identity) =>
    actual.agent_id === expected.agent_id &&
    actual.session_id === expected.session_id &&
    actual.harness === expected.harness;
  if (
    message.type !== pins.type ||
    message.task_id !== pins.taskId ||
    message.subtask_id !== pins.assignmentId ||
    message.attempt !== pins.attempt ||
    message.owner_epoch !== pins.ownerEpoch ||
    !sameIdentity(message.from, pins.from) ||
    !sameIdentity(message.to, pins.to) ||
    (pins.replyTo !== undefined && message.reply_to !== pins.replyTo)
  )
    throw new Error('managed_role_protocol_message_pins_mismatch');
  return { message, digest: contentDigest(message) };
}

/** Read only publisher output; never synthesize or patch capability evidence in this fixture. */
export function captureReadyCapabilityPin(input: {
  readonly assignmentFile: string;
  readonly capabilitiesFile: string;
  readonly metadataFile: string;
}): {
  readonly assignment: Assignment;
  readonly card: CapabilityCard;
  readonly cardDigest: string;
  readonly metadataDigest: string;
} {
  const assignmentRead = readBoundedFile(input.assignmentFile, 1024 * 1024);
  const cardRead = readBoundedFile(input.capabilitiesFile, 1024 * 1024);
  const metadataRead = readBoundedFile(input.metadataFile, 16 * 1024 * 1024);
  if (!assignmentRead.ok || !cardRead.ok || !metadataRead.ok)
    throw new Error('managed_role_capability_evidence_unavailable');
  let assignmentValue: unknown;
  let cardValue: unknown;
  try {
    assignmentValue = JSON.parse(assignmentRead.text) as unknown;
    cardValue = JSON.parse(cardRead.text) as unknown;
  } catch {
    throw new Error('managed_role_capability_card_invalid');
  }
  if (!isAssignment(assignmentValue) || !isCard(cardValue))
    throw new Error('managed_role_capability_card_invalid');
  if (
    cardValue.agent_id !== assignmentValue.assignee.agent_id ||
    cardValue.session_id !== assignmentValue.assignee.session_id ||
    cardValue.configuration_id !== assignmentValue.assignee.configuration_id ||
    !cardValue.evidence_records?.some(
      (entry) =>
        entry.ref === input.metadataFile &&
        entry.digest === metadataRead.digest,
    )
  )
    throw new Error('managed_role_capability_pin_mismatch');
  const preflight = runCollaborationPreflight({
    assignmentFile: input.assignmentFile,
    capabilitiesFile: input.capabilitiesFile,
  });
  if (preflight.status !== 'ready')
    throw new Error('managed_role_capability_preflight_not_ready');
  return {
    assignment: assignmentValue,
    card: cardValue,
    cardDigest: cardRead.digest,
    metadataDigest: metadataRead.digest,
  };
}

export interface ManagedRoleNativeObservation {
  readonly runtime: 'sdk';
  readonly sdkVersion: '1.4.0';
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly thinkingLevel: string | null;
  };
  readonly metadataFile: string;
  readonly herdr: {
    readonly workspaceId: string;
    readonly tabId: string;
    readonly paneId: string;
    readonly terminalId: string;
    readonly agentName: string;
    readonly sessionId: string;
    readonly cwd: string;
  };
  readonly controlSnapshot: ManagedPiSdkSessionSnapshot;
}

export interface ManagedRoleLifecycleLaunchRequest {
  readonly assignmentFile: string;
  readonly templateFile: string;
  readonly capabilitiesFile: string;
  readonly expectedSessionId: string;
  readonly expectedHerdrAgentName: string;
  readonly model: {
    readonly provider: 'openrouter';
    readonly id: 'openai/gpt-6-luna';
  };
  readonly previousSessionId?: string;
}

/** Root supplies these only after its actual Herdr/SDK launch and control observations. */
export interface ManagedRoleLifecycleLaunchPort {
  startInitialManagedSdk(
    input: ManagedRoleLifecycleLaunchRequest,
  ): Promise<ManagedRoleNativeObservation>;
  waitForManagedSuccessor(
    input: ManagedRoleLifecycleLaunchRequest,
  ): Promise<ManagedRoleNativeObservation>;
}

/** Assert a real fresh native start receipt; the transcript may still be absent. */
export function assertFreshManagedRoleSession(
  observation: ManagedRoleNativeObservation,
  assignment: Assignment,
  pins: {
    readonly expectedHerdrAgentName: string;
    readonly previousSessionId?: string;
  },
): void {
  assert.equal(observation.runtime, 'sdk');
  assert.equal(observation.sdkVersion, '1.4.0');
  assert.equal(observation.sessionId, assignment.assignee.session_id);
  if (pins.previousSessionId !== undefined) {
    assert.equal(
      assignment.attempt,
      2,
      'approved repair must use the sequential attempt',
    );
    assert.notEqual(observation.sessionId, pins.previousSessionId);
  }
  assert.equal(
    fs.realpathSync(observation.cwd),
    fs.realpathSync(assignment.assignee.cwd),
  );
  assert.equal(observation.model.provider, 'openrouter');
  assert.equal(observation.model.id, 'openai/gpt-6-luna');
  assert.equal(observation.model.thinkingLevel, 'max');
  assert.ok(observation.herdr.workspaceId.length > 0);
  assert.ok(observation.herdr.tabId.length > 0);
  assert.ok(observation.herdr.paneId.length > 0);
  assert.ok(observation.herdr.terminalId.length > 0);
  assert.equal(observation.herdr.agentName, pins.expectedHerdrAgentName);
  assert.equal(observation.herdr.sessionId, observation.sessionId);
  assert.equal(
    fs.realpathSync(observation.herdr.cwd),
    fs.realpathSync(observation.cwd),
  );
  assert.equal(
    observation.controlSnapshot.schema,
    'harness-collab/pi-managed-sdk-session/1',
  );
  assert.equal(
    observation.controlSnapshot.session.sessionId,
    observation.sessionId,
  );
  assert.equal(observation.controlSnapshot.process.exit, 'not_owned');
  assert.equal(observation.controlSnapshot.ingress.healthy, true);

  const metadata = readBoundedFile(observation.metadataFile, 16 * 1024 * 1024);
  if (!metadata.ok) throw new Error('managed_role_native_metadata_unavailable');
  let rows: Record<string, unknown>[];
  try {
    rows = metadata.text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown)
      .filter(
        (row): row is Record<string, unknown> =>
          typeof row === 'object' && row !== null && !Array.isArray(row),
      );
  } catch {
    throw new Error('managed_role_native_metadata_invalid');
  }
  const starts = rows.filter((row) => row['type'] === 'session_start');
  const ready = rows.filter((row) => row['type'] === 'resources_ready').at(-1);
  if (
    starts.length !== 1 ||
    !ready ||
    starts[0]!['schema'] !== READINESS_SCHEMA ||
    ready['schema'] !== READINESS_SCHEMA ||
    starts[0]!['session_id'] !== observation.sessionId ||
    starts[0]!['cwd'] !== observation.cwd ||
    ready['session_id'] !== observation.sessionId ||
    ready['cwd'] !== observation.cwd ||
    ready['phase'] !== RESOURCES_READY_PHASE ||
    typeof ready['native_header'] !== 'object' ||
    ready['native_header'] === null ||
    (ready['native_header'] as Record<string, unknown>)['id'] !==
      observation.sessionId ||
    (ready['native_header'] as Record<string, unknown>)['cwd'] !==
      observation.cwd
  )
    throw new Error('managed_role_native_startup_observation_mismatch');
  const model = ready['model'];
  const configuration = ready['configuration'];
  const nativeIdentity = ready['native_identity'];
  const inventory = ready['resource_inventory'];
  if (
    typeof model !== 'object' ||
    model === null ||
    (model as Record<string, unknown>)['provider'] !==
      observation.model.provider ||
    (model as Record<string, unknown>)['id'] !== observation.model.id ||
    (model as Record<string, unknown>)['thinking_level'] !==
      observation.model.thinkingLevel ||
    typeof configuration !== 'object' ||
    configuration === null ||
    (configuration as Record<string, unknown>)['project_trusted'] !== true ||
    (configuration as Record<string, unknown>)['configuration_id'] !==
      assignment.assignee.configuration_id ||
    typeof inventory !== 'object' ||
    inventory === null ||
    (inventory as Record<string, unknown>)['completeness'] !== 'complete' ||
    typeof nativeIdentity !== 'object' ||
    nativeIdentity === null ||
    (nativeIdentity as Record<string, unknown>)['harness'] !== 'pi' ||
    (nativeIdentity as Record<string, unknown>)['agent_id'] !==
      assignment.assignee.agent_id ||
    (nativeIdentity as Record<string, unknown>)['surface'] !==
      assignment.assignee.surface ||
    (nativeIdentity as Record<string, unknown>)['configuration_id'] !==
      assignment.assignee.configuration_id
  )
    throw new Error('managed_role_native_assignment_identity_mismatch');
}

export async function launchAndVerifyManagedRole(
  host: ManagedRoleLifecycleLaunchPort,
  request: ManagedRoleLifecycleLaunchRequest,
  assignment: Assignment,
): Promise<ManagedRoleNativeObservation> {
  const observation =
    request.previousSessionId === undefined
      ? await host.startInitialManagedSdk(request)
      : await host.waitForManagedSuccessor(request);
  assertFreshManagedRoleSession(observation, assignment, {
    expectedHerdrAgentName: request.expectedHerdrAgentName,
    ...(request.previousSessionId === undefined
      ? {}
      : { previousSessionId: request.previousSessionId }),
  });
  return observation;
}

export function assertApprovedRepairOutcome(
  result: RoleOrchestrationResult,
  sourceAssignmentId: string,
  sourceAttempt: number,
  expectedSuccessorSessionId: string,
): void {
  assert.equal(result.status, 'repaired');
  const assignment = result.updatedRequest?.role_plan.assignments.find(
    (entry) => entry.assignment_id === sourceAssignmentId,
  );
  assert.ok(assignment, 'repair must publish the approved next Assignment');
  assert.equal(assignment.attempt, sourceAttempt + 1);
  const participant = result.updatedRequest?.role_plan.participants.find(
    (entry) => entry.participant_id === assignment.participant_id,
  );
  assert.ok(participant, 'repair must pin a successor participant');
  assert.equal(participant.assignee.session_id, expectedSuccessorSessionId);
}

/** Dispatch/delivery is not acceptance; only the existing evaluator aggregate passes this gate. */
export function assertAcceptedRoleOutcome(
  result: RoleOrchestrationResult,
  expectedNodeIds: readonly string[],
): void {
  assert.equal(result.status, 'accepted');
  assert.equal(result.aggregate?.outcome, 'accepted');
  assert.deepEqual(
    [...(result.aggregate?.accepted_nodes ?? [])].sort(),
    [...expectedNodeIds].sort(),
  );
}

export interface BoundedRoleEventDriver {
  next(): Promise<RoleOrchestrationResult>;
  status(): ReturnType<RoleEventWatcher['status']>;
  close(): Promise<void>;
}

/** Event-driven only: the request's role limits and this observation budget bound progress. */
export async function createBoundedRoleEventDriver(
  requestFile: string,
  maximumEvents: number,
  timeoutMs = 120_000,
): Promise<BoundedRoleEventDriver> {
  if (
    !Number.isSafeInteger(maximumEvents) ||
    maximumEvents < 1 ||
    maximumEvents > 64 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  )
    throw new Error('managed_role_event_bounds_invalid');
  const queued: RoleOrchestrationResult[] = [];
  const waiters: {
    readonly resolve: (value: RoleOrchestrationResult) => void;
    readonly reject: (reason: Error) => void;
    readonly timer: NodeJS.Timeout;
  }[] = [];
  let observed = 0;
  let overflow = false;
  let closed = false;
  let watcher: RoleEventWatcher | null = null;
  const rejectWaiters = (error: Error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  watcher = await watchRoleOrchestration(requestFile, (result) => {
    if (closed) return;
    if (++observed > maximumEvents) {
      overflow = true;
      if (watcher !== null) void watcher.close();
      rejectWaiters(new Error('managed_role_event_budget_exhausted'));
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    } else {
      queued.push(result);
    }
  });
  return {
    next: () => {
      if (queued.length > 0) return Promise.resolve(queued.shift()!);
      if (overflow)
        return Promise.reject(new Error('managed_role_event_budget_exhausted'));
      if (closed)
        return Promise.reject(new Error('managed_role_event_driver_closed'));
      return new Promise<RoleOrchestrationResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new Error(
              watcher?.status().error ?? 'managed_role_event_wait_timed_out',
            ),
          );
        }, timeoutMs);
        waiters.push({ resolve, reject, timer });
      });
    },
    status: () => watcher!.status(),
    close: async () => {
      if (closed) return;
      closed = true;
      rejectWaiters(new Error('managed_role_event_driver_closed'));
      await watcher!.close();
    },
  };
}
