import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from './bounded-file.js';
import { findAttempt } from '../collab/lifecycle.js';
import { describeResource } from '../collab/canonical.js';
import { isAssignment, type Assignment } from '../collab/contracts.js';
import type { TaskRecord } from '../collab/types.js';
import { readRegisteredMessage, canonicalJson } from '../collab/envelope.js';
import { createLocalTaskRecordReader } from '../hosts/integration/pi-bootstrap-runtime.js';
import type { ManagedPiSdkSessionController } from '../hosts/pi/managed-sdk-session.js';
import {
  bindManagedPiExecutionScope,
  type BoundManagedPiExecutionScope,
} from './managed-pi-transition-host.js';
import type { ManagedPiExecutionScope } from './collab-session-transition.js';

const MAX_ASSIGNMENT_BYTES = 1024 * 1024;
const ACTIVE_ATTEMPT_STATES = new Set(['assigned', 'accepted', 'running']);

type AdmissionState = 'waiting' | 'awaiting_idle' | 'bound' | 'unavailable';

export interface ManagedPiInitialAdmissionConfig {
  readonly taskRoot: string;
  readonly assignmentFile: string;
  readonly subtaskId: string;
  readonly attempt: number;
  readonly ownerEpoch: number;
  readonly inputRevision: string;
}

interface DirectoryPin {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

function samePath(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

function pinAssignmentDirectory(file: string): DirectoryPin | null {
  const directory = path.dirname(file);
  try {
    const stat = fs.lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(directory) !== directory
    )
      return null;
    return { path: directory, dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function assignmentDirectoryCurrent(pin: DirectoryPin | null): boolean {
  if (!pin) return false;
  try {
    const stat = fs.lstatSync(pin.path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === pin.dev &&
      stat.ino === pin.ino &&
      fs.realpathSync(pin.path) === pin.path
    );
  } catch {
    return false;
  }
}

function idle(controller: ManagedPiSdkSessionController): boolean {
  const snapshot = controller.snapshot();
  const runtime = snapshot.ownedRuntime;
  const queues = runtime.queues;
  const internal = queues.internal;
  const work = runtime.work;
  return (
    snapshot.ingress.healthy &&
    snapshot.ingress.state === 'open' &&
    queues.completeness === 'complete' &&
    queues.pendingMessageCount === 0 &&
    queues.steering.length === 0 &&
    queues.followUp.length === 0 &&
    internal.pendingNextTurn?.length === 0 &&
    internal.pendingCustom?.length === 0 &&
    internal.pendingBash?.length === 0 &&
    internal.deferredSettledActionCount === 0 &&
    internal.pendingUserInputs?.length === 0 &&
    internal.compactionMessages?.length === 0 &&
    internal.extensionDialogCount === 0 &&
    internal.activeSelector === false &&
    runtime.extensionDialogs.completeness === 'complete' &&
    runtime.extensionDialogs.pending.length === 0 &&
    runtime.builtInUiApprovals.observation === 'complete' &&
    runtime.builtInUiApprovals.uncoveredPaths.length === 0 &&
    work.observation === 'complete' &&
    work.isIdle &&
    !work.isStreaming &&
    !work.isCompacting &&
    work.isBashRunning === false &&
    work.hasPendingBashMessages === false &&
    work.pendingToolCalls === 0
  );
}

function nativeIdentityMatches(
  record: TaskRecord,
  assignment: Assignment,
  config: ManagedPiInitialAdmissionConfig,
  controller: ManagedPiSdkSessionController,
): boolean {
  const observed = controller.observe();
  const native = observed.native;
  const assignee = assignment.assignee;
  return (
    native.harness === 'pi' &&
    native.sessionId === assignee.session_id &&
    native.agentId === assignee.agent_id &&
    native.configurationId === assignee.configuration_id &&
    observed.cwd === assignee.cwd &&
    path.isAbsolute(observed.cwd) &&
    samePath(observed.cwd, assignee.cwd) &&
    controller.snapshot().session.sessionId === native.sessionId &&
    (assignment.runner.profile === undefined ||
      native.modelObservation.model === assignment.runner.profile) &&
    assignee.harness === 'pi' &&
    assignee.cwd === observed.cwd &&
    config.ownerEpoch === assignment.coordinator.owner_epoch &&
    record.coordinator?.agent_id === assignment.coordinator.agent_id &&
    record.coordinator?.session_id === assignment.coordinator.session_id &&
    record.coordinator?.owner_epoch === config.ownerEpoch
  );
}

function hasAdmittedAssign(
  record: TaskRecord,
  attempt: NonNullable<ReturnType<typeof findAttempt>>,
  config: ManagedPiInitialAdmissionConfig,
  assignment: Assignment,
  digest: string,
): boolean {
  const applied = (record.messages ?? []).find(
    (message) =>
      message.message_id === attempt.assignment_message_id &&
      message.type === 'ASSIGN' &&
      message.subtask_id === config.subtaskId &&
      message.attempt === config.attempt &&
      message.owner_epoch === config.ownerEpoch &&
      message.state === 'applied' &&
      message.content_digest,
  );
  if (
    !applied ||
    applied.from.agent_id !== assignment.coordinator.agent_id ||
    applied.from.session_id !== assignment.coordinator.session_id ||
    applied.to?.agent_id !== assignment.assignee.agent_id ||
    applied.to?.session_id !== assignment.assignee.session_id ||
    applied.to?.harness !== 'pi'
  )
    return false;
  const registered = readRegisteredMessage(
    record.task_root,
    applied.message_id,
  );
  return (
    registered !== null &&
    registered.content_digest === applied.content_digest &&
    registered.type === 'ASSIGN' &&
    registered.task_id === assignment.task_id &&
    registered.subtask_id === config.subtaskId &&
    registered.attempt === config.attempt &&
    registered.owner_epoch === config.ownerEpoch &&
    registered.from.agent_id === assignment.coordinator.agent_id &&
    registered.from.session_id === assignment.coordinator.session_id &&
    registered.to.agent_id === assignment.assignee.agent_id &&
    registered.to.session_id === assignment.assignee.session_id &&
    registered.to.harness === 'pi' &&
    registered.body.assignment_ref === config.assignmentFile &&
    registered.body.assignment_digest === digest &&
    canonicalJson(registered.body.approval ?? null) ===
      canonicalJson(attempt.approval) &&
    registered.body.input_revision === config.inputRevision
  );
}

function claimAuthority(
  record: TaskRecord,
  config: ManagedPiInitialAdmissionConfig,
  assignment: Assignment,
): boolean {
  const attempt = findAttempt(record, config.subtaskId, config.attempt);
  if (
    !attempt ||
    !ACTIVE_ATTEMPT_STATES.has(attempt.state) ||
    attempt.awaiting !== undefined ||
    attempt.cancel_requested_at !== undefined ||
    attempt.owner_epoch !== config.ownerEpoch ||
    attempt.input_revision !== config.inputRevision ||
    attempt.assignment_ref !== config.assignmentFile ||
    attempt.assignment_digest === null ||
    attempt.assignment_digest === undefined ||
    attempt.assignee.agent_id !== assignment.assignee.agent_id ||
    attempt.assignee.session_id !== assignment.assignee.session_id ||
    attempt.assignee.harness !== 'pi' ||
    (attempt.assignee.cwd !== undefined &&
      attempt.assignee.cwd !== assignment.assignee.cwd) ||
    record.dispatch_frozen === true
  )
    return false;

  const latestAttempt = (record.attempts ?? [])
    .filter((item) => item.subtask_id === config.subtaskId)
    .reduce((latest, item) => Math.max(latest, item.attempt), 0);
  if (latestAttempt !== config.attempt) return false;

  const selected = (record.claims ?? []).filter(
    (claim) =>
      claim.subtask_id === config.subtaskId && claim.attempt === config.attempt,
  );
  if (
    selected.length === 0 ||
    selected.some(
      (claim) =>
        claim.released_at !== null ||
        claim.cancel_pending === true ||
        claim.holder.agent_id !== assignment.assignee.agent_id ||
        claim.holder.session_id !== assignment.assignee.session_id ||
        claim.holder.harness !== 'pi',
    )
  )
    return false;

  const used = new Set<string>();
  for (const resource of assignment.resources) {
    let descriptor;
    try {
      descriptor = describeResource({
        ...(resource.kind === undefined ? {} : { kind: resource.kind }),
        path: resource.path,
        ...(resource.scope === undefined ? {} : { scope: resource.scope }),
      });
    } catch {
      return false;
    }
    const match = selected.find(
      (claim) =>
        !used.has(claim.claim_id) &&
        claim.path === (descriptor.path ?? null) &&
        claim.access === resource.access &&
        (resource.resource_epoch === undefined ||
          claim.resource_epoch === resource.resource_epoch),
    );
    if (!match) return false;
    used.add(match.claim_id);
  }
  return assignment.resources.length > 0 && used.size === selected.length;
}

interface AdmittedArtifact {
  readonly record: TaskRecord;
  readonly assignment: Assignment;
  readonly bytes: Buffer;
  readonly digest: string;
}

function readAdmittedArtifact(
  reader: ReturnType<typeof createLocalTaskRecordReader>,
  config: ManagedPiInitialAdmissionConfig,
  directoryPin: DirectoryPin | null,
  controller: ManagedPiSdkSessionController,
  pinnedAfterBinding: { bytes: Buffer; digest: string } | null,
): AdmittedArtifact | null {
  if (!assignmentDirectoryCurrent(directoryPin)) return null;
  const record = reader.read();
  const attempt = findAttempt(record, config.subtaskId, config.attempt);
  if (
    !attempt ||
    attempt.assignment_ref !== config.assignmentFile ||
    typeof attempt.assignment_digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(attempt.assignment_digest)
  )
    return null;
  const artifact = readBoundedFile(
    attempt.assignment_ref,
    MAX_ASSIGNMENT_BYTES,
  );
  if (!artifact.ok || artifact.digest !== attempt.assignment_digest)
    return null;
  if (
    pinnedAfterBinding &&
    (artifact.digest !== pinnedAfterBinding.digest ||
      !artifact.bytes.equals(pinnedAfterBinding.bytes))
  )
    return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact.text) as unknown;
  } catch {
    return null;
  }
  if (
    !isAssignment(parsed) ||
    parsed.task_id !== record.task_id ||
    parsed.attempt !== config.attempt ||
    parsed.coordinator.owner_epoch !== config.ownerEpoch ||
    !nativeIdentityMatches(record, parsed, config, controller) ||
    !hasAdmittedAssign(record, attempt, config, parsed, artifact.digest)
  )
    return null;
  return {
    record,
    assignment: parsed,
    bytes: Buffer.from(artifact.bytes),
    digest: artifact.digest,
  };
}

/**
 * Wait for a real task-store ASSIGN and its claims before binding a controller-owned Pi runtime.
 * The startup artifact is only a preview: its contents never grant authority. The admitted Task
 * assignment_ref/digest becomes authoritative, and its bytes remain pinned after binding.
 */
export async function watchManagedPiInitialAdmission(
  controller: ManagedPiSdkSessionController,
  config: ManagedPiInitialAdmissionConfig,
  onBound: (binding: BoundManagedPiExecutionScope) => Promise<void>,
) {
  if (
    !path.isAbsolute(config.taskRoot) ||
    !path.isAbsolute(config.assignmentFile) ||
    !config.subtaskId ||
    !Number.isSafeInteger(config.attempt) ||
    config.attempt < 1 ||
    !Number.isSafeInteger(config.ownerEpoch) ||
    config.ownerEpoch < 1 ||
    !config.inputRevision
  )
    throw new TypeError('managed_pi_initial_admission_config_invalid');

  const taskRoot = path.resolve(config.taskRoot);
  const taskId = path.basename(taskRoot);
  const domainRoot = path.dirname(path.dirname(taskRoot));
  if (
    taskRoot !== path.join(domainRoot, 'tasks', taskId) ||
    !samePath(taskRoot, config.taskRoot)
  )
    throw new TypeError('managed_pi_initial_admission_task_namespace_invalid');
  const directoryPin = pinAssignmentDirectory(config.assignmentFile);
  const reader = createLocalTaskRecordReader(domainRoot, taskId);

  let closed = false;
  let pending = false;
  let active: Promise<void> | null = null;
  let binding: BoundManagedPiExecutionScope | null = null;
  let authoritative: { bytes: Buffer; digest: string } | null = null;
  let state: AdmissionState = 'waiting';
  let error: string | null = directoryPin
    ? null
    : 'assignment_preview_directory_unavailable';

  const evaluate = (): AdmittedArtifact | null =>
    readAdmittedArtifact(
      reader,
      config,
      directoryPin,
      controller,
      authoritative,
    );

  const refresh = (): Promise<void> => {
    if (closed || binding) return active ?? Promise.resolve();
    pending = true;
    if (active) return active;
    active = (async () => {
      try {
        while (pending && !closed && !binding) {
          pending = false;
          const candidate = evaluate();
          if (
            !candidate ||
            !claimAuthority(candidate.record, config, candidate.assignment)
          ) {
            state = 'waiting';
            continue;
          }
          const inventory = await controller.inventory();
          if (
            inventory.completeness !== 'complete' ||
            inventory.inflight.length !== 0 ||
            inventory.pending_approvals.length !== 0 ||
            (inventory.pending_messages?.length ?? -1) !== 0 ||
            !idle(controller)
          ) {
            state = 'awaiting_idle';
            continue;
          }
          const current = evaluate();
          if (
            !current ||
            !claimAuthority(current.record, config, current.assignment)
          ) {
            state = 'waiting';
            continue;
          }
          const native = controller.observe();
          const scope: ManagedPiExecutionScope = {
            schema: 'pappra/managed-pi-execution-scope/1',
            task_id: current.record.task_id,
            task_root: current.record.task_root,
            session_id: native.native.sessionId,
            cwd: native.cwd,
            subtask_id: config.subtaskId,
            attempt: config.attempt,
            owner_epoch: config.ownerEpoch,
            claim_epochs: (current.record.claims ?? [])
              .filter(
                (claim) =>
                  claim.subtask_id === config.subtaskId &&
                  claim.attempt === config.attempt,
              )
              .map((claim) => ({
                claim_id: claim.claim_id,
                resource_epoch: claim.resource_epoch,
              })),
          };
          if (scope.claim_epochs.length === 0) {
            state = 'waiting';
            continue;
          }
          const trusted = await bindManagedPiExecutionScope({
            controller,
            scope,
          });
          await onBound(trusted);
          authoritative = { bytes: current.bytes, digest: current.digest };
          binding = trusted;
          state = 'bound';
          error = null;
        }
      } catch (cause) {
        state = 'unavailable';
        error =
          cause instanceof Error
            ? cause.message
            : 'managed_pi_initial_admission_failed';
      }
    })().finally(() => {
      active = null;
    });
    return active;
  };

  const canExecute = (): boolean => {
    if (closed || !binding || state !== 'bound') return false;
    try {
      const candidate = evaluate();
      const snapshot = controller.snapshot();
      const runtime = snapshot.ownedRuntime;
      if (
        !candidate ||
        !claimAuthority(candidate.record, config, candidate.assignment) ||
        snapshot.ingress.state !== 'open' ||
        !snapshot.ingress.healthy ||
        runtime.queues.internal.activeSelector !== false ||
        runtime.extensionDialogs.completeness !== 'complete' ||
        runtime.extensionDialogs.pending.length !== 0 ||
        runtime.builtInUiApprovals.observation !== 'complete' ||
        runtime.builtInUiApprovals.uncoveredPaths.length !== 0
      )
        return false;
      const native = controller.observe();
      return (
        native.native.sessionId === binding.scope.session_id &&
        native.cwd === binding.scope.cwd &&
        binding.scope.task_root === candidate.record.task_root &&
        binding.scope.task_id === candidate.record.task_id &&
        binding.scope.subtask_id === config.subtaskId &&
        binding.scope.attempt === config.attempt &&
        binding.scope.owner_epoch === config.ownerEpoch &&
        binding.scope.claim_epochs.length ===
          (candidate.record.claims ?? []).filter(
            (claim) =>
              claim.subtask_id === config.subtaskId &&
              claim.attempt === config.attempt,
          ).length &&
        binding.scope.claim_epochs.every((pin) =>
          (candidate.record.claims ?? []).some(
            (claim) =>
              claim.claim_id === pin.claim_id &&
              claim.resource_epoch === pin.resource_epoch &&
              claim.subtask_id === config.subtaskId &&
              claim.attempt === config.attempt &&
              claim.released_at === null &&
              claim.cancel_pending !== true,
          ),
        )
      );
    } catch (cause) {
      state = 'unavailable';
      error =
        cause instanceof Error
          ? cause.message
          : 'managed_pi_initial_admission_revalidation_failed';
      return false;
    }
  };

  const watcher = fs.watch(taskRoot, (_event, name) => {
    if (name === null || name.toString() === 'task.json') void refresh();
  });
  watcher.on('error', (cause) => {
    state = 'unavailable';
    error =
      cause instanceof Error
        ? cause.message
        : 'managed_pi_initial_admission_watch_failed';
  });
  const unsubscribe = controller.subscribe((event) => {
    if (
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      (event.type === 'agent_settled' || event.type === 'resources_ready')
    )
      setImmediate(() => {
        void refresh();
      }).unref();
  });
  await refresh();

  return {
    refresh,
    canExecute,
    status: () => ({ state, error, scope: binding?.scope ?? null }),
    async close() {
      if (closed) return;
      closed = true;
      watcher.close();
      unsubscribe();
      await active;
    },
  };
}
