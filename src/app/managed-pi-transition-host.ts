import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../collab/envelope.js';
import { findAttempt } from '../collab/lifecycle.js';
import { openTaskStore } from './collab-task-store.js';
import type {
  ManagedPiExecutionScope,
  SessionTransitionHost,
  SessionTransitionHostObservation,
  SessionTransitionQuiescenceProof,
} from './collab-session-transition.js';
import type {
  ManagedPiSdkRolloverInventory,
  ManagedPiSdkSessionSnapshot,
} from '../hosts/pi/managed-sdk-session.js';
import type {
  FreezeOutcome,
  FreezeStatus,
  FreezeToken,
  RolloverFreezeController,
} from '../hosts/integration/pi-rollover-extension.js';

export const MANAGED_PI_TRANSITION_HOST_ID =
  'pappra/managed-pi-session-transition-host/2' as const;
const OWNED_SCOPE = 'pinned_pi_1_4_owned_runtime' as const;
const EXCLUDED_SCOPE = Object.freeze([
  'arbitrary_external_writers',
  'unowned_processes_and_descendants',
] as const);

export interface ManagedPiTransitionControllerPort {
  readonly cwd?: string;
  observe(): {
    readonly native: {
      readonly sessionId: string;
      readonly paneId?: string | null;
    };
    readonly cwd: string;
  };
  snapshot(): ManagedPiSdkSessionSnapshot;
  inventory(): Promise<ManagedPiSdkRolloverInventory>;
  quiesce(reason?: string): Promise<ManagedPiSdkSessionSnapshot>;
  fenceIngress(reason?: string): void;
}

export interface BoundManagedPiExecutionScope {
  readonly scope: ManagedPiExecutionScope;
}

export interface BindManagedPiExecutionScopeInput {
  readonly controller: ManagedPiTransitionControllerPort;
  readonly scope: ManagedPiExecutionScope;
}

export interface CreateManagedPiTransitionHostInput {
  readonly controller: ManagedPiTransitionControllerPort;
  readonly freezeController: Pick<
    RolloverFreezeController,
    'sessionId' | 'freeze' | 'status'
  >;
  readonly binding: BoundManagedPiExecutionScope;
}

const BINDINGS = new WeakSet<object>();
const LIVE_PROOFS = new WeakSet<object>();

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function samePath(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

function cloneScope(scope: ManagedPiExecutionScope): ManagedPiExecutionScope {
  return Object.freeze({
    schema: scope.schema,
    task_id: scope.task_id,
    task_root: scope.task_root,
    session_id: scope.session_id,
    cwd: scope.cwd,
    subtask_id: scope.subtask_id,
    attempt: scope.attempt,
    owner_epoch: scope.owner_epoch,
    claim_epochs: Object.freeze(
      scope.claim_epochs.map((claim) =>
        Object.freeze({
          claim_id: claim.claim_id,
          resource_epoch: claim.resource_epoch,
        }),
      ),
    ),
  });
}

function validateScopeShape(scope: ManagedPiExecutionScope): void {
  if (
    scope.schema !== 'pappra/managed-pi-execution-scope/1' ||
    !scope.task_id ||
    !path.isAbsolute(scope.task_root) ||
    !scope.session_id ||
    !path.isAbsolute(scope.cwd) ||
    !scope.subtask_id ||
    !Number.isSafeInteger(scope.attempt) ||
    scope.attempt < 1 ||
    !Number.isSafeInteger(scope.owner_epoch) ||
    scope.owner_epoch <= 0 ||
    !Array.isArray(scope.claim_epochs) ||
    scope.claim_epochs.length === 0
  )
    throw new TypeError('managed_pi_execution_scope_invalid');
  const seen = new Set<string>();
  for (const claim of scope.claim_epochs) {
    if (
      !claim.claim_id ||
      !Number.isSafeInteger(claim.resource_epoch) ||
      claim.resource_epoch <= 0 ||
      seen.has(claim.claim_id)
    )
      throw new TypeError('managed_pi_execution_scope_claims_invalid');
    seen.add(claim.claim_id);
  }
}

/** Bind the explicitly selected live SDK runtime to authoritative task pins before TUI startup. */
export async function bindManagedPiExecutionScope(
  input: BindManagedPiExecutionScopeInput,
): Promise<BoundManagedPiExecutionScope> {
  const { controller, scope } = input;
  validateScopeShape(scope);
  if (path.basename(scope.task_root) !== scope.task_id)
    throw new TypeError('managed_pi_execution_scope_task_mismatch');
  const live = controller.observe();
  const snapshot = controller.snapshot();
  if (
    live.native.sessionId !== scope.session_id ||
    !samePath(live.cwd, scope.cwd) ||
    snapshot.session.sessionId !== scope.session_id
  )
    throw new TypeError('managed_pi_execution_scope_runtime_mismatch');
  assertCleanPrelaunchRuntime(snapshot);
  const liveInventory = await controller.inventory();
  if (
    liveInventory.completeness !== 'complete' ||
    liveInventory.inflight.length !== 0 ||
    liveInventory.pending_approvals.length !== 0 ||
    (liveInventory.pending_messages?.length ?? -1) !== 0
  )
    throw new TypeError('managed_pi_execution_scope_runtime_busy_or_unknown');

  const opened = await openTaskStore(scope.task_root);
  if (!opened.ok)
    throw new TypeError(
      `managed_pi_execution_scope_task_unavailable:${opened.code}`,
    );
  const record = opened.value.record;
  if (
    record.task_id !== scope.task_id ||
    !samePath(record.task_root, scope.task_root)
  )
    throw new TypeError('managed_pi_execution_scope_task_mismatch');
  if (
    !Number.isSafeInteger(scope.owner_epoch) ||
    scope.owner_epoch <= 0 ||
    record.coordinator?.owner_epoch !== scope.owner_epoch
  )
    throw new TypeError('managed_pi_execution_scope_owner_epoch_stale');
  const attempt = findAttempt(record, scope.subtask_id, scope.attempt);
  const latestAttempt = (record.attempts ?? [])
    .filter((candidate) => candidate.subtask_id === scope.subtask_id)
    .reduce((latest, candidate) => Math.max(latest, candidate.attempt), 0);
  if (
    attempt === null ||
    latestAttempt !== scope.attempt ||
    !['assigned', 'accepted', 'running'].includes(attempt.state) ||
    attempt.owner_epoch !== scope.owner_epoch ||
    attempt.assignee.harness !== 'pi' ||
    attempt.assignee.session_id !== scope.session_id ||
    (attempt.assignee.cwd !== undefined && attempt.assignee.cwd !== scope.cwd)
  )
    throw new TypeError('managed_pi_execution_scope_attempt_mismatch');
  if (scope.claim_epochs.length === 0)
    throw new TypeError('managed_pi_execution_scope_claims_empty');
  const currentClaims = (record.claims ?? []).filter((claim) =>
    scope.claim_epochs.some((pin) => pin.claim_id === claim.claim_id),
  );
  if (currentClaims.length !== scope.claim_epochs.length)
    throw new TypeError('managed_pi_execution_scope_claim_set_mismatch');
  for (const pin of scope.claim_epochs) {
    const claim = currentClaims.find(
      (candidate) => candidate.claim_id === pin.claim_id,
    );
    if (
      pin.resource_epoch <= 0 ||
      claim === undefined ||
      claim.released_at !== null ||
      claim.subtask_id !== scope.subtask_id ||
      claim.attempt !== scope.attempt ||
      (claim.resource_epoch ?? 0) !== pin.resource_epoch ||
      claim.holder.agent_id !== attempt.assignee.agent_id ||
      claim.holder.session_id !== attempt.assignee.session_id ||
      claim.holder.harness !== 'pi'
    )
      throw new TypeError('managed_pi_execution_scope_claim_epoch_stale');
  }
  const frozen = Object.freeze({ scope: cloneScope(scope) });
  BINDINGS.add(frozen);
  return frozen;
}

function assertCleanPrelaunchRuntime(
  snapshot: ManagedPiSdkSessionSnapshot,
): void {
  const { queues, work, extensionDialogs, builtInUiApprovals } =
    snapshot.ownedRuntime;
  const internal = queues.internal;
  const queueCounts = [
    internal.pendingNextTurn?.length,
    internal.pendingCustom?.length,
    internal.pendingBash?.length,
    internal.deferredSettledActionCount,
    internal.pendingUserInputs?.length,
    internal.compactionMessages?.length,
    queues.steering.length,
    queues.followUp.length,
  ];
  if (
    !snapshot.ingress.healthy ||
    snapshot.ingress.state !== 'open' ||
    snapshot.ownedRuntime.queues.pendingMessageCount !== 0 ||
    queues.completeness !== 'complete' ||
    work.observation !== 'complete' ||
    extensionDialogs.completeness !== 'complete' ||
    builtInUiApprovals.observation !== 'complete' ||
    !work.isIdle ||
    work.isStreaming ||
    work.isCompacting ||
    work.isBashRunning !== false ||
    work.hasPendingBashMessages !== false ||
    work.pendingToolCalls !== 0 ||
    queueCounts.some(
      (count) => count === null || count === undefined || count !== 0,
    ) ||
    extensionDialogs.pending.length !== 0 ||
    internal.extensionDialogCount !== 0 ||
    internal.activeSelector !== false
  )
    throw new TypeError('managed_pi_execution_scope_runtime_busy_or_unknown');
}

function isBound(binding: BoundManagedPiExecutionScope): boolean {
  return (
    typeof binding === 'object' && binding !== null && BINDINGS.has(binding)
  );
}
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value as Record<string, unknown>))
    deepFreeze(child);
  return Object.freeze(value);
}

function asRolloverInventory(value: ManagedPiSdkRolloverInventory) {
  return deepFreeze({
    completeness: value.completeness,
    inflight: [...value.inflight],
    pending_approvals: [...value.pending_approvals],
    pending_messages:
      value.pending_messages === undefined
        ? undefined
        : [...value.pending_messages],
    partial_outputs:
      value.partial_outputs === undefined
        ? undefined
        : [...value.partial_outputs],
  });
}

function freezeStatus(
  controller: CreateManagedPiTransitionHostInput['freezeController'],
): FreezeStatus {
  return controller.status();
}

/** Build an in-process host whose v2 proof can only be minted from fresh live SDK snapshots. */
export function createManagedPiTransitionHost(
  input: CreateManagedPiTransitionHostInput,
): SessionTransitionHost {
  if (!isBound(input.binding))
    throw new TypeError('managed_pi_execution_scope_binding_untrusted');
  const scope = input.binding.scope;
  if (input.freezeController.sessionId !== scope.session_id)
    throw new TypeError('managed_pi_transition_freeze_session_mismatch');
  let observationSequence = 0;

  const identity = () => {
    const observed = input.controller.observe();
    const snapshot = input.controller.snapshot();
    return { observed, snapshot };
  };

  return Object.freeze({
    id: MANAGED_PI_TRANSITION_HOST_ID,
    async observe(): Promise<SessionTransitionHostObservation> {
      const { observed, snapshot } = identity();
      if (
        observed.native.sessionId !== scope.session_id ||
        !samePath(observed.cwd, scope.cwd) ||
        snapshot.session.sessionId !== scope.session_id
      )
        return {
          session_id: observed.native.sessionId ?? null,
          cwd: observed.cwd ?? null,
          pane_id: observed.native.paneId ?? null,
          proof_support: 'unavailable',
          proof: null,
          freeze_status: freezeStatus(input.freezeController),
          native_facts: null,
          unavailable_code: 'managed_pi_scope_runtime_mismatch',
          detail:
            'The live SDK runtime no longer matches its pre-start task-owned binding.',
        };

      const status = freezeStatus(input.freezeController);
      let proof: SessionTransitionQuiescenceProof | null = null;
      if (
        status.frozen &&
        status.token !== null &&
        status.token.sessionId === scope.session_id
      ) {
        const inventory = await input.controller.inventory();
        const fresh = input.controller.snapshot();
        const sequence = Math.max(
          ++observationSequence,
          fresh.ingress.sequence,
        );
        observationSequence = sequence;
        const proofValue: SessionTransitionQuiescenceProof = deepFreeze({
          adapter_id: MANAGED_PI_TRANSITION_HOST_ID,
          session_id: fresh.session.sessionId,
          cwd: observed.cwd,
          observed_at: new Date().toISOString(),
          sequence,
          evidence_ref: `managed-pi-sdk://${scope.session_id}/${sequence}/${fresh.ingress.headDigest}`,
          freeze_token: Object.freeze({ ...status.token }),
          inventory: asRolloverInventory(inventory),
          scope: OWNED_SCOPE,
          execution_scope: scope,
          execution_scope_digest: digest(scope),
          excluded_scope: EXCLUDED_SCOPE,
          runtime_quiescent: fresh.scopedQuiescent,
          runtime_blockers: Object.freeze([...fresh.blockers]),
          controller_sequence: fresh.ingress.sequence,
          controller_head_digest: `sha256:${fresh.ingress.headDigest}`,
          controller_journal_healthy: fresh.ingress.healthy,
        } as SessionTransitionQuiescenceProof);
        LIVE_PROOFS.add(proofValue as object);
        proof = proofValue;
      }
      return {
        session_id: observed.native.sessionId,
        cwd: observed.cwd,
        pane_id: observed.native.paneId ?? null,
        proof_support: 'available',
        proof,
        freeze_status: status,
        native_facts: null,
        unavailable_code: null,
        detail: null,
      };
    },
    async freeze(token: FreezeToken): Promise<FreezeOutcome> {
      if (
        token.sessionId !== scope.session_id ||
        token.taskId !== scope.task_id ||
        input.freezeController.sessionId !== token.sessionId
      )
        return {
          ok: false,
          reason: 'wrong_session',
          detail:
            'The freeze token does not match the bound task-owned SDK runtime.',
        };
      const { observed, snapshot } = identity();
      if (
        observed.native.sessionId !== scope.session_id ||
        !samePath(observed.cwd, scope.cwd) ||
        snapshot.session.sessionId !== scope.session_id
      )
        return {
          ok: false,
          reason: 'wrong_session',
          detail: 'Live SDK identity drifted from the bound task scope.',
        };
      const outcome = input.freezeController.freeze(token);
      if (!outcome.ok) return outcome;
      // This is the live controller operation that closes ingress and waits for the pinned SDK runtime.
      await input.controller.quiesce(
        `owned_native_takeover:${token.handoffId}:${token.generation}`,
      );
      return outcome;
    },
  });
}

/** Used by the guarded transition to reject serialized or caller-constructed v2 proof objects. */
export function isTrustedManagedPiScopedProof(
  value: unknown,
): value is SessionTransitionQuiescenceProof {
  return typeof value === 'object' && value !== null && LIVE_PROOFS.has(value);
}
