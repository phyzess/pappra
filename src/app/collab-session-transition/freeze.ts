import path from 'node:path';
import { object as isRecord } from '../../infra/validation.js';
import { canonicalJson } from '../../collab/envelope.js';
import * as rollover from '../../collab/rollover.js';
import { transact } from '../../collab/store.js';
import type {
  FreezeOutcome,
  FreezeToken,
} from '../../hosts/integration/pi-rollover-extension.js';
import { verifyManagedPiSdkInstallation } from '../../hosts/pi/managed-sdk-session.js';
import type { VisibleBootstrapReport } from '../collab-bootstrap.js';
import type { RolloverReport } from '../collab-rollover.js';
import { inspectOrPlanRollover } from '../collab-rollover.js';
import {
  assertTaskStoreCurrent,
  openTaskStore,
  type OpenedTaskStore,
} from '../collab-task-store.js';
import type { SessionTransitionRequest } from '../collab-session-transition-request.js';
import {
  digestText,
  isDigest,
  isNonNegativeInt,
  isText,
} from '../collab-session-transition-validation.js';
import { isTrustedManagedPiScopedProof } from '../managed-pi-transition-host.js';
import { failure } from './context.js';
import {
  MAX_QUIESCENCE_AGE_MS,
  buildRolloverRequest,
  getIntent,
  journalEntry,
  managedExecutionScopeDrift,
  setJournalQuiescenceReceipt,
  sourceStateFailure,
} from './journal.js';
import { failureReport, reportForContext, step } from './report.js';
import { recordEffectIntent, recordEffectOutcome } from './effects.js';
import {
  MANAGED_PI_SCOPED_PROOF_ADAPTER_ID,
  MANAGED_PI_SCOPED_RECEIPT_SCHEMA,
  type SessionTransitionDependencies,
  type SessionTransitionHostObservation,
  type SessionTransitionQuiescenceProof,
  type SessionTransitionQuiescenceReceipt,
  type SessionTransitionReport,
  type SessionTransitionStep,
  type TransitionContext,
  type TransitionFailure,
} from './types.js';

export {
  freezeAndPrepare,
  hostIdentityFailure,
  plannedSteps,
  proofSupportFailure,
  quiescenceInventoryDigest,
  quiescenceReceipt,
};
function plannedSteps(
  rolloverReport: RolloverReport,
  bootstrapReport: VisibleBootstrapReport,
  host: SessionTransitionHostObservation | null,
  intentFound: boolean,
  handoffState: string | null,
): SessionTransitionStep[] {
  const rollStep = (name: string) =>
    rolloverReport.steps.find((item) => item.step === name);
  const prepared =
    rolloverReport.prepared.recorded ||
    [
      'old-writer-stopped',
      'transferring',
      'receiver-confirmed',
      'completed',
    ].includes(rolloverReport.stage);
  const confirmed =
    handoffState === 'receiver_confirmed' || handoffState === 'completed';
  const transferred = handoffState === 'completed';
  const successionValid = rolloverReport.succession.valid;
  const proofSupported = host?.proof_support === 'available';
  return [
    step(
      'create-intent',
      intentFound
        ? 'satisfied'
        : (rollStep('create-intent')?.status ?? 'blocked'),
      rollStep('create-intent')?.blockers[0]?.code ?? null,
      rollStep('create-intent')?.blockers[0]?.detail ?? null,
    ),
    step(
      'source-quiescence',
      prepared ? 'satisfied' : proofSupported ? 'ready' : 'unavailable',
      prepared
        ? null
        : (host?.unavailable_code ?? 'host_stop_proof_unavailable'),
      prepared
        ? null
        : (host?.detail ??
            'The installed Pi producer does not provide complete, trusted quiescence proof.'),
    ),
    step(
      'successor-bootstrap',
      prepared
        ? bootstrapReport.status === 'planned' ||
          bootstrapReport.status === 'applied' ||
          bootstrapReport.status === 'already_recorded'
          ? bootstrapReport.status === 'planned'
            ? 'ready'
            : 'satisfied'
          : 'blocked'
        : 'blocked',
      prepared ? bootstrapReport.code : 'predecessor_step_unavailable',
      prepared
        ? bootstrapReport.message
        : 'Successor launch is not allowed before source quiescence.',
    ),
    step(
      'receiver-ack',
      confirmed ? 'satisfied' : prepared ? 'waiting' : 'blocked',
      confirmed ? null : prepared ? null : 'predecessor_step_unavailable',
      confirmed
        ? null
        : 'Requires a registered ACK correlated to this exact intent and the original assignment.',
    ),
    step(
      'claim-route-transfer',
      transferred ? 'ready' : confirmed ? 'ready' : 'blocked',
      transferred || confirmed ? null : 'predecessor_step_unavailable',
      transferred
        ? 'Core assignee/claim transfer is recorded; the explicit successor-only route binding still needs reconciliation.'
        : 'Claims and the current task assignee transfer only after the correlated receiver ACK.',
    ),
    step(
      'first-work',
      successionValid ? 'satisfied' : transferred ? 'waiting' : 'blocked',
      successionValid
        ? null
        : transferred
          ? null
          : 'predecessor_step_unavailable',
      successionValid
        ? null
        : 'Requires an admitted completed successor REPORT after the recorded transfer boundary.',
    ),
    step(
      'task-retirement',
      successionValid ? 'ready' : 'blocked',
      successionValid ? null : 'predecessor_step_unavailable',
      successionValid
        ? 'Writes a reversible task-local retirement marker only; native Pi archive is unavailable.'
        : 'Retirement is forbidden before validated first work.',
    ),
  ];
}

function hostIdentityFailure(
  observation: SessionTransitionHostObservation,
  request: SessionTransitionRequest,
): TransitionFailure | null {
  if (observation.session_id !== request.intent.from.session_id)
    return failure(
      'needs_input',
      'source_session_mismatch',
      'The opt-in Pi host is not running in the exact source session.',
      'Load the extension in the task-bound source session; no transition effect was attempted.',
    );
  if (observation.cwd !== request.intent.from.cwd)
    return failure(
      'needs_input',
      'source_cwd_mismatch',
      'The opt-in Pi host cwd does not match the pinned source identity.',
      'Run from the exact task-bound cwd; no transition effect was attempted.',
    );
  if (observation.pane_id !== null && !isText(observation.pane_id, 64))
    return failure(
      'needs_input',
      'source_pane_invalid',
      'The source pane observation is malformed.',
      'Re-read the exact Herdr pane identity; no transition effect was attempted.',
    );
  return null;
}

function proofSupportFailure(
  observation: SessionTransitionHostObservation,
  request: SessionTransitionRequest,
  now: number,
): TransitionFailure | null {
  if (observation.proof_support !== 'available')
    return failure(
      'needs_input',
      observation.unavailable_code ?? 'host_stop_proof_unavailable',
      observation.detail ??
        'The installed Pi host exposes only incomplete/unauthenticated quiescence observations.',
      'Do not infer stop from idle, settled, a freeze latch, or a transcript. Resume only when an accepted session-bound proof adapter is available; no successor was started.',
    );
  const rawProof: unknown = observation.proof;
  const rawFreeze: unknown = observation.freeze_status;
  if (!isRecord(rawProof) || !isRecord(rawFreeze))
    return failure(
      'needs_input',
      'host_quiescence_proof_invalid',
      'The host reported proof support without a complete structured proof and active freeze receipt.',
      'Reconcile the current source session and inventory; no ownership transfer was attempted.',
    );
  const proof = rawProof;
  const tokenValue: unknown = proof['freeze_token'];
  const inventoryValue: unknown = proof['inventory'];
  const freeze = rawFreeze;
  const tokenSnapshotValue: unknown = freeze['token'];
  if (
    !isRecord(tokenValue) ||
    !isRecord(inventoryValue) ||
    !isRecord(tokenSnapshotValue)
  )
    return failure(
      'needs_input',
      'host_quiescence_proof_invalid',
      'The host quiescence receipt is missing its freeze token, inventory or freeze status.',
      'Reconcile the current source session and inventory; no ownership transfer was attempted.',
    );
  const token = tokenValue;
  const inventory = inventoryValue;
  const age = now - Date.parse(String(proof['observed_at'] ?? ''));
  const tokenSnapshot = tokenSnapshotValue;
  const managedScope = request.managed_execution_scope;
  const scopedProofMatches =
    managedScope === undefined
      ? proof['adapter_id'] === 'pappra/pi-session-transition-host/1'
      : isTrustedManagedPiScopedProof(rawProof) &&
        proof['adapter_id'] === MANAGED_PI_SCOPED_PROOF_ADAPTER_ID &&
        proof['scope'] === 'pinned_pi_1_4_owned_runtime' &&
        isRecord(proof['execution_scope']) &&
        canonicalJson(proof['execution_scope']) ===
          canonicalJson(managedScope) &&
        proof['execution_scope_digest'] ===
          digestText(canonicalJson(managedScope)) &&
        Array.isArray(proof['excluded_scope']) &&
        proof['excluded_scope'].length === 2 &&
        proof['excluded_scope'][0] === 'arbitrary_external_writers' &&
        proof['excluded_scope'][1] === 'unowned_processes_and_descendants' &&
        proof['runtime_quiescent'] === true &&
        Array.isArray(proof['runtime_blockers']) &&
        proof['runtime_blockers'].length === 0 &&
        proof['controller_journal_healthy'] === true &&
        isNonNegativeInt(proof['controller_sequence']) &&
        isDigest(proof['controller_head_digest']) &&
        isNonNegativeInt(proof['sequence']) &&
        (proof['sequence'] as number) >=
          (proof['controller_sequence'] as number);
  if (
    !isRecord(tokenSnapshot) ||
    !scopedProofMatches ||
    proof['session_id'] !== request.intent.from.session_id ||
    proof['cwd'] !== request.intent.from.cwd ||
    !isText(proof['observed_at'], 64) ||
    !Number.isFinite(Date.parse(proof['observed_at'])) ||
    age < 0 ||
    age > MAX_QUIESCENCE_AGE_MS ||
    !isText(proof['evidence_ref'], 4096) ||
    !Number.isSafeInteger(proof['sequence']) ||
    (proof['sequence'] as number) < 0 ||
    token['sessionId'] !== request.intent.from.session_id ||
    token['taskId'] !== path.basename(request.task_root) ||
    token['handoffId'] !== request.intent.handoff_id ||
    token['generation'] !== request.intent.generation ||
    freeze['frozen'] !== true ||
    tokenSnapshot['sessionId'] !== token['sessionId'] ||
    tokenSnapshot['taskId'] !== token['taskId'] ||
    tokenSnapshot['handoffId'] !== token['handoffId'] ||
    tokenSnapshot['generation'] !== token['generation'] ||
    inventory['completeness'] !== 'complete' ||
    !Array.isArray(inventory['inflight']) ||
    inventory['inflight'].length !== 0 ||
    !Array.isArray(inventory['pending_approvals']) ||
    inventory['pending_approvals'].length !== 0 ||
    !Array.isArray(inventory['pending_messages']) ||
    inventory['pending_messages'].length !== 0 ||
    (inventory['partial_outputs'] !== undefined &&
      !Array.isArray(inventory['partial_outputs']))
  )
    return failure(
      'needs_input',
      'host_quiescence_proof_invalid',
      'Host quiescence evidence is stale, incomplete, mismatched, or not bound to the active freeze token.',
      'Reconcile the current source session and inventory; no ownership transfer was attempted.',
    );
  return null;
}

function freezeTokenMatches(status: unknown, expected: FreezeToken): boolean {
  if (
    !isRecord(status) ||
    status['frozen'] !== true ||
    !isRecord(status['token'])
  )
    return false;
  const token = status['token'];
  return (
    token['sessionId'] === expected.sessionId &&
    token['taskId'] === expected.taskId &&
    token['handoffId'] === expected.handoffId &&
    token['generation'] === expected.generation
  );
}

function sameFreezeToken(left: FreezeToken, right: FreezeToken): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.taskId === right.taskId &&
    left.handoffId === right.handoffId &&
    left.generation === right.generation
  );
}

function quiescenceInventoryDigest(
  inventory: rollover.RolloverInventory,
): string | null {
  if (
    inventory.completeness !== 'complete' ||
    !Array.isArray(inventory.inflight) ||
    !Array.isArray(inventory.pending_approvals) ||
    !Array.isArray(inventory.pending_messages) ||
    (inventory.partial_outputs !== undefined &&
      !Array.isArray(inventory.partial_outputs))
  )
    return null;
  try {
    return digestText(
      canonicalJson({
        completeness: 'complete',
        inflight: inventory.inflight,
        pending_approvals: inventory.pending_approvals,
        pending_messages: inventory.pending_messages,
        partial_outputs: inventory.partial_outputs ?? [],
      }),
    );
  } catch {
    return null;
  }
}

function quiescenceReceipt(
  proof: SessionTransitionQuiescenceProof,
  inventoryDigest: string,
): SessionTransitionQuiescenceReceipt {
  const scoped = proof.adapter_id === MANAGED_PI_SCOPED_PROOF_ADAPTER_ID;
  return {
    schema: scoped
      ? MANAGED_PI_SCOPED_RECEIPT_SCHEMA
      : 'pappra/session-transition-quiescence-receipt/1',
    adapter_id: proof.adapter_id,
    session_id: proof.session_id,
    cwd: proof.cwd,
    observed_at: proof.observed_at,
    sequence: proof.sequence,
    evidence_ref: proof.evidence_ref,
    freeze_token: { ...proof.freeze_token },
    inventory_digest: inventoryDigest,
    ...(scoped && proof.execution_scope_digest !== undefined
      ? { execution_scope_digest: proof.execution_scope_digest }
      : {}),
  };
}

async function freezeAndPrepare(
  context: TransitionContext,
  currentTask: OpenedTaskStore,
  initialObservation: SessionTransitionHostObservation,
  dependencies: SessionTransitionDependencies,
  now: () => number,
): Promise<
  | { readonly ok: true; readonly report: SessionTransitionReport }
  | { readonly ok: false; readonly report: SessionTransitionReport }
> {
  const request = context.request;
  const host = dependencies.host;
  if (host === undefined)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        'pi_transition_host_required',
        'No opt-in Pi host is connected.',
        'Load the transition extension explicitly; no native effect was attempted.',
        currentTask,
      ),
    };
  const token: FreezeToken = {
    sessionId: request.intent.from.session_id,
    taskId: currentTask.record.task_id,
    handoffId: request.intent.handoff_id,
    generation: request.intent.generation,
  };
  let observation: SessionTransitionHostObservation;
  try {
    observation = await host.observe();
  } catch {
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'unknown',
        'host_observation_unknown',
        'The host observation failed before the source freeze could be reconciled.',
        'Re-read the exact task-bound host and durable journal; no freeze or transfer was attempted.',
        currentTask,
      ),
    };
  }
  const namespace = await assertTaskStoreCurrent(currentTask);
  if (namespace !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        namespace.code,
        namespace.message,
        namespace.nextAction,
        currentTask,
      ),
    };
  const identityIssue = hostIdentityFailure(observation, request);
  if (identityIssue !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        identityIssue.kind,
        identityIssue.code,
        identityIssue.message,
        identityIssue.nextAction,
        currentTask,
        { host: { id: host.id, ...observation } },
      ),
    };
  const scopeDrift = managedExecutionScopeDrift(request, currentTask.record);
  if (scopeDrift !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        scopeDrift.code,
        scopeDrift.message,
        'Reconcile the current task/attempt/claim pins before source freeze; no new effect was attempted.',
        currentTask,
      ),
    };
  if (observation.proof_support !== 'available')
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'waiting',
        observation.unavailable_code ?? 'host_stop_proof_unavailable',
        observation.detail ??
          'No accepted host can produce complete quiescence proof.',
        'Do not freeze or transfer; wait for the supported native proof API.',
        currentTask,
        { host: { id: host.id, ...observation } },
      ),
    };
  if (
    initialObservation.session_id !== observation.session_id ||
    initialObservation.cwd !== observation.cwd
  )
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        'host_identity_changed',
        'The source host identity changed between the initial and effect-boundary observations.',
        'Reconcile the current session/cwd and re-plan; no freeze or transfer was attempted.',
        currentTask,
        { host: { id: host.id, ...observation } },
      ),
    };
  let journal = journalEntry(
    currentTask.record,
    request,
    context.requestDigest,
  );
  if (journal === null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'unknown',
        'transition_journal_missing',
        'The transition intent lacks a matching durable effect journal.',
        'Inspect the task record before any native operation.',
        currentTask,
      ),
    };
  let freezeReceipt = journal.effects['source-freeze'];
  if (
    freezeReceipt === undefined &&
    context.bootstrap.request.managed_runtime
  ) {
    try {
      verifyManagedPiSdkInstallation(
        context.bootstrap.request.managed_runtime.sdk_module_path,
      );
    } catch {
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          'needs_input',
          'successor_sdk_incompatible',
          'The successor SDK changed or is incompatible; no source freeze was attempted.',
          'Select a supported SDK installation and re-plan.',
          currentTask,
        ),
      };
    }
  }
  if (freezeReceipt?.state === 'failed')
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        'source_freeze_failed',
        'A prior source-freeze operation returned a known failure and will not be replayed automatically.',
        'Reconcile the source-controller state; start a new transition only with explicit authorization.',
        currentTask,
        { host: { id: host.id, ...observation } },
      ),
    };
  if (
    freezeReceipt?.state === 'pending' ||
    freezeReceipt?.state === 'unknown'
  ) {
    if (!freezeTokenMatches(observation.freeze_status, token))
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          'reconcile_required',
          'source_freeze_outcome_unknown',
          'A previous freeze may have taken effect, but the exact token is not confirmed by the current host observation.',
          'Reconcile the in-process controller and journal; do not repeat freeze or continue transfer.',
          currentTask,
          { host: { id: host.id, ...observation } },
        ),
      };
    const reconciled = await recordEffectOutcome(
      context,
      currentTask,
      'source-freeze',
      'completed',
      now(),
      null,
    );
    if (!reconciled.ok)
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          'unknown',
          reconciled.code,
          'The exact source freeze is visible, but its durable journal outcome could not be recorded.',
          'Inspect host status and task journal; do not repeat the freeze.',
          currentTask,
          { host: { id: host.id, ...observation } },
        ),
      };
    currentTask = reconciled.task;
    journal = journalEntry(currentTask.record, request, context.requestDigest);
    freezeReceipt = journal?.effects['source-freeze'];
  }
  let currentObservation = observation;
  if (freezeReceipt?.state !== 'completed') {
    const intent = await recordEffectIntent(
      context,
      currentTask,
      'source-freeze',
      now,
      dependencies.signal,
    );
    if (!intent.ok)
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          intent.kind === 'invalid' ? 'invalid' : 'needs_input',
          intent.code,
          intent.message,
          intent.nextAction,
          currentTask,
          { host: { id: host.id, ...observation } },
        ),
      };
    currentTask = intent.task;
    let freezeOutcome: FreezeOutcome | null = null;
    try {
      freezeOutcome = await host.freeze(token);
    } catch {
      let afterFailure: SessionTransitionHostObservation | null = null;
      try {
        afterFailure = await host.observe();
      } catch {
        // The pending journal receipt remains the reconciliation fence.
      }
      if (
        afterFailure !== null &&
        freezeTokenMatches(afterFailure.freeze_status, token)
      ) {
        const reconciled = await recordEffectOutcome(
          context,
          currentTask,
          'source-freeze',
          'completed',
          now(),
          null,
        );
        if (!reconciled.ok)
          return {
            ok: false,
            report: failureReport(
              'apply',
              request,
              'unknown',
              reconciled.code,
              'The host may have frozen the source, but the outcome receipt could not be persisted.',
              'Reconcile the in-process controller and journal; do not retry freeze.',
              currentTask,
              { host: { id: host.id, ...afterFailure } },
            ),
          };
        currentTask = reconciled.task;
        currentObservation = afterFailure;
      } else {
        const unknown = await recordEffectOutcome(
          context,
          currentTask,
          'source-freeze',
          'unknown',
          now(),
          'freeze_result_unknown',
        );
        const outcomeTask = unknown.ok ? unknown.task : currentTask;
        return {
          ok: false,
          report: failureReport(
            'apply',
            request,
            'reconcile_required',
            'source_freeze_outcome_unknown',
            'The host freeze call threw and its effect cannot be determined.',
            'Inspect the source controller and task journal; never replay the freeze blindly.',
            outcomeTask,
            {
              host:
                afterFailure === null
                  ? { id: host.id }
                  : { id: host.id, ...afterFailure },
            },
          ),
        };
      }
    }
    if (freezeOutcome !== null) {
      const frozen = freezeOutcome;
      if (!frozen.ok) {
        const recorded = await recordEffectOutcome(
          context,
          currentTask,
          'source-freeze',
          'failed',
          now(),
          frozen.reason,
        );
        const outcomeTask = recorded.ok ? recorded.task : currentTask;
        return {
          ok: false,
          report: failureReport(
            'apply',
            request,
            'needs_input',
            frozen.reason,
            frozen.detail,
            'Reconcile the source freeze status; no transfer or successor start occurred.',
            outcomeTask,
            { host: { id: host.id, ...observation } },
          ),
        };
      }
      if (!sameFreezeToken(frozen.token, token)) {
        const unknown = await recordEffectOutcome(
          context,
          currentTask,
          'source-freeze',
          'unknown',
          now(),
          'freeze_token_mismatch',
        );
        const outcomeTask = unknown.ok ? unknown.task : currentTask;
        return {
          ok: false,
          report: failureReport(
            'apply',
            request,
            'reconcile_required',
            'source_freeze_token_mismatch',
            'The host freeze returned a different token.',
            'Inspect the in-process controller and journal; do not continue or replay.',
            outcomeTask,
            { host: { id: host.id, ...observation } },
          ),
        };
      }
      try {
        currentObservation = await host.observe();
      } catch {
        const unknown = await recordEffectOutcome(
          context,
          currentTask,
          'source-freeze',
          'unknown',
          now(),
          'post_freeze_observation_unknown',
        );
        const outcomeTask = unknown.ok ? unknown.task : currentTask;
        return {
          ok: false,
          report: failureReport(
            'apply',
            request,
            'reconcile_required',
            'post_freeze_observation_unknown',
            'Freeze returned success, but its current host status could not be observed.',
            'Reconcile the freeze and complete quiescence proof before transfer.',
            outcomeTask,
          ),
        };
      }
      if (!freezeTokenMatches(currentObservation.freeze_status, token)) {
        const unknown = await recordEffectOutcome(
          context,
          currentTask,
          'source-freeze',
          'unknown',
          now(),
          'freeze_receipt_not_observed',
        );
        const outcomeTask = unknown.ok ? unknown.task : currentTask;
        return {
          ok: false,
          report: failureReport(
            'apply',
            request,
            'reconcile_required',
            'freeze_receipt_not_observed',
            'Freeze returned success but the exact token is absent from the current host status.',
            'Reconcile the source controller; no ownership transfer was attempted.',
            outcomeTask,
            { host: { id: host.id, ...currentObservation } },
          ),
        };
      }
      const recorded = await recordEffectOutcome(
        context,
        currentTask,
        'source-freeze',
        'completed',
        now(),
        null,
      );
      if (!recorded.ok)
        return {
          ok: false,
          report: failureReport(
            'apply',
            request,
            'unknown',
            recorded.code,
            'Freeze was applied but its outcome could not be durably recorded.',
            'Inspect the source controller and task journal; never retry freeze blindly.',
            currentTask,
            { host: { id: host.id, ...currentObservation } },
          ),
        };
      currentTask = recorded.task;
    }
  } else if (!freezeTokenMatches(observation.freeze_status, token)) {
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'reconcile_required',
        'source_freeze_receipt_mismatch',
        'The journal says the source is frozen, but the current controller does not expose the exact freeze token.',
        'Reconcile the in-process controller; no transfer is permitted.',
        currentTask,
        { host: { id: host.id, ...observation } },
      ),
    };
  }
  const afterIdentityIssue = hostIdentityFailure(currentObservation, request);
  if (afterIdentityIssue !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        afterIdentityIssue.code,
        afterIdentityIssue.message,
        afterIdentityIssue.nextAction,
        currentTask,
        { host: { id: host.id, ...currentObservation } },
      ),
    };
  const changedAfterHost = await assertTaskStoreCurrent(currentTask);
  if (changedAfterHost !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        changedAfterHost.code,
        changedAfterHost.message,
        changedAfterHost.nextAction,
        currentTask,
        { host: { id: host.id, ...currentObservation } },
      ),
    };
  const proofIssue = proofSupportFailure(currentObservation, request, now());
  if (proofIssue !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'waiting',
        proofIssue.code,
        'Source tools are frozen but the post-freeze proof is not sufficient to transfer ownership.',
        'Keep the source frozen and reconcile with an accepted complete host proof; no successor was launched.',
        currentTask,
        { host: { id: host.id, ...currentObservation } },
      ),
    };
  const proof = currentObservation.proof!;
  const outcome = transact(currentTask.taskRoot, {
    actor: request.intent.from.agent_id,
    purpose: 'session-transition:prepare-transfer',
    expectRevision: currentTask.record.state_revision,
    clock: now(),
    apply: (record) => {
      if (dependencies.signal?.aborted)
        return { ok: false as const, reason: 'abort_requested' };
      const drift = sourceStateFailure(record, request);
      if (drift !== null) return { ok: false as const, reason: drift.code };
      const effect = journalEntry(record, request, context.requestDigest)
        ?.effects['source-freeze'];
      if (effect?.state !== 'completed')
        return { ok: false as const, reason: 'source_freeze_receipt_missing' };
      const prepared = rollover.prepareRolloverTransfer(record, {
        intent_id: request.intent.intent_id,
        observation: 'confirmed',
        evidence_ref: proof.evidence_ref,
        inventory: proof.inventory,
        actor: request.intent.from.agent_id,
        clock: now(),
      });
      if (!prepared.ok) return prepared;

      const preparedIntent = getIntent(record, request.intent.intent_id);
      const inventoryDigest = preparedIntent?.prepared?.inventory;
      if (!isDigest(inventoryDigest))
        return {
          ok: false as const,
          reason: 'prepared_inventory_digest_missing',
        };
      const receipt = quiescenceReceipt(proof, inventoryDigest);
      const savedReceipt = setJournalQuiescenceReceipt(
        record,
        request.transition_id,
        'source',
        receipt,
      );
      if (!savedReceipt.ok)
        return { ok: false as const, reason: savedReceipt.code };
      return {
        record,
        op: 'session-transition-prepare-transfer',
        summary: {
          transition_id: request.transition_id,
          handoff_id: request.intent.handoff_id,
        },
        result: prepared,
      };
    },
  });
  if (!outcome.ok)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        outcome.reason,
        'Core rollover refused the prepared transfer.',
        'Re-read current task/claims and host evidence before any retry.',
        currentTask,
        { host: { id: host.id, ...currentObservation } },
      ),
    };
  const refreshed = await openTaskStore(request.task_root);
  if (!refreshed.ok)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'unknown',
        refreshed.code,
        refreshed.message,
        refreshed.nextAction,
        currentTask,
      ),
    };
  const roll = await inspectOrPlanRollover(
    buildRolloverRequest(request, refreshed.value.record),
  );
  const report = reportForContext(
    'apply',
    request,
    refreshed.value.record,
    roll.ok ? roll.value : null,
    null,
    currentObservation,
    [
      step('create-intent', 'satisfied'),
      step('source-quiescence', 'satisfied'),
      step('prepare-transfer', 'satisfied'),
      step('successor-bootstrap', 'ready'),
      step('receiver-ack', 'blocked', 'predecessor_step_unavailable'),
      step('claim-route-transfer', 'blocked', 'predecessor_step_unavailable'),
      step('first-work', 'blocked', 'predecessor_step_unavailable'),
      step('task-retirement', 'blocked', 'predecessor_step_unavailable'),
    ],
    'progressed',
    {
      next_action:
        'Apply the validated successor bootstrap once; then wait for its registered correlated ACK.',
    },
  );
  return { ok: true, report };
}
