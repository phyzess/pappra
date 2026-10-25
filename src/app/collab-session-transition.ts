import { readManagedSourceAssignment } from './managed-pi-source-admission.js';
import { findAttempt } from '../collab/lifecycle.js';
import * as rollover from '../collab/rollover.js';
import { transact } from '../collab/store.js';
import type { TaskRecord } from '../collab/types.js';
import {
  applyVisibleBootstrap,
  planVisibleBootstrap,
  type VisibleBootstrapReport,
} from './collab-bootstrap.js';
import {
  reportedSessionIdentity,
  createHerdrTransport,
  type HerdrListResult,
} from './collab-notify.js';
import {
  assertTaskStoreCurrent,
  openTaskStore,
  type OpenedTaskStore,
} from './collab-task-store.js';
import {
  openMessageTask,
  readRegisteredMessageSafe,
  type RegisteredMessage,
} from './collab-messages.js';
import { runCollaborationPreflight } from './collab-preflight.js';
import { inspectOrPlanRollover } from './collab-rollover.js';
import {
  createHerdrBootstrapOps,
  type HerdrBootstrapOps,
} from './collab-bootstrap-transport.js';
import { routeExclusionFor, validateSuccession } from './collab-route.js';

import {
  MANAGED_PI_EXECUTION_SCOPE_SCHEMA,
  type ManagedPiExecutionScope,
} from '../schemas/managed-pi-execution.js';
export { MANAGED_PI_EXECUTION_SCOPE_SCHEMA };
export type { ManagedPiExecutionScope };
export {
  COLLAB_SESSION_TRANSITION_REQUEST_SCHEMA,
  loadSessionTransitionRequest,
  validateSessionTransitionRequest,
} from './collab-session-transition-request.js';
export type {
  LoadedSessionTransitionRequest,
  SessionTransitionRequest,
  SessionTransitionRequestResult,
} from './collab-session-transition-request.js';
import {
  type LoadedSessionTransitionRequest,
  type SessionTransitionRequest,
} from './collab-session-transition-request.js';
import { safePathEqual } from './collab-session-transition-validation.js';
import {
  type SessionTransitionBootstrapExecutor,
  type SessionTransitionDependencies,
  type SessionTransitionHostObservation,
  type SessionTransitionReport,
  type SessionTransitionStep,
  type TransitionContext,
} from './collab-session-transition/types.js';
import {
  loadContext,
  readTaskLocalFile,
  requestOf,
} from './collab-session-transition/context.js';
import {
  buildRolloverRequest,
  currentStateDrift,
  getHandoff,
  getIntent,
  intentTransaction,
  journalEntry,
  managedExecutionScopeDrift,
  sameIntentRequest,
  setJournalQuiescenceReceipt,
} from './collab-session-transition/journal.js';
import {
  capabilities,
  failureReport,
  reportForContext,
  step,
} from './collab-session-transition/report.js';
export type { SessionTransitionEffectName } from './collab-session-transition/effects.js';
export { SESSION_TRANSITION_JOURNAL_KEY } from './collab-session-transition/journal.js';
import {
  freezeAndPrepare,
  hostIdentityFailure,
  plannedSteps,
  proofSupportFailure,
  quiescenceInventoryDigest,
  quiescenceReceipt,
} from './collab-session-transition/freeze.js';
import {
  ensureSuccessorRouteBinding,
  validateSuccessorBinding,
} from './collab-session-transition/routing.js';
import { ensureTaskRetirementMarker } from './collab-session-transition/retirement.js';

export {
  COLLAB_SESSION_TRANSITION_REPORT_SCHEMA,
  MANAGED_PI_SCOPED_PROOF_ADAPTER_ID,
  MANAGED_PI_SCOPED_RECEIPT_SCHEMA,
  SESSION_TRANSITION_ARCHIVE_SCHEMA,
} from './collab-session-transition/types.js';
export type {
  SessionTransitionAction,
  SessionTransitionBootstrapExecutor,
  SessionTransitionDependencies,
  SessionTransitionEffectReceipt,
  SessionTransitionHost,
  SessionTransitionHostObservation,
  SessionTransitionJournal,
  SessionTransitionJournalEntry,
  SessionTransitionQuiescenceProof,
  SessionTransitionQuiescenceReceipt,
  SessionTransitionReport,
  SessionTransitionRetirementMarker,
  SessionTransitionStage,
  SessionTransitionStatus,
  SessionTransitionStep,
} from './collab-session-transition/types.js';

function bootstrapExecutor(
  dependencies: SessionTransitionDependencies,
): SessionTransitionBootstrapExecutor {
  if (dependencies.bootstrap !== undefined) return dependencies.bootstrap;
  return {
    plan: (request) =>
      planVisibleBootstrap(request, dependencies.bootstrapDependencies),
    apply: (request) =>
      applyVisibleBootstrap(request, dependencies.bootstrapDependencies),
  };
}

function validatePreflight(context: TransitionContext, now: number) {
  const attempt = findAttempt(
    context.task.record,
    context.request.intent.subtask_id,
    context.request.intent.attempt,
  );
  if (
    attempt === null ||
    attempt.assignment_ref === null ||
    attempt.assignment_ref === undefined
  )
    return {
      ok: false as const,
      code: 'assignment_missing',
      message: 'Current attempt has no assignment reference.',
    };
  let assignmentFile: string;
  try {
    assignmentFile = readManagedSourceAssignment(
      context.task.record,
      attempt,
      context.request.intent.from,
    ).file;
  } catch {
    return {
      ok: false as const,
      code: 'source_admission_unverified',
      message:
        'The source assignment does not match its immutable admission lineage.',
    };
  }
  const result = runCollaborationPreflight({
    assignmentFile,
    capabilitiesFile: context.bootstrap.request.admission.capability_card_ref,
    maxAgeMinutes: 30,
    now,
  });
  return result.status === 'ready'
    ? { ok: true as const, report: result }
    : {
        ok: false as const,
        code:
          result.blockers[0]?.code ?? result.errors[0] ?? 'admission_not_ready',
        message: `Current collaboration preflight is ${result.status}.`,
      };
}

export async function planSessionTransition(
  input: LoadedSessionTransitionRequest | SessionTransitionRequest,
  dependencies: SessionTransitionDependencies = {},
): Promise<SessionTransitionReport> {
  const request = requestOf(input);
  const context = await loadContext(input);
  if (!context.ok)
    return failureReport(
      'plan',
      request,
      context.kind === 'invalid' ? 'invalid' : 'needs_input',
      context.code,
      context.message,
      context.nextAction,
    );
  const now = dependencies.clock ?? Date.now;
  const handoffAtRead = getHandoff(
    context.value.task.record,
    request.intent.handoff_id,
  );
  if (
    handoffAtRead?.state !== 'receiver_confirmed' &&
    handoffAtRead?.state !== 'completed'
  ) {
    const preflight = validatePreflight(context.value, now());
    if (!preflight.ok)
      return failureReport(
        'plan',
        request,
        'needs_input',
        preflight.code,
        preflight.message,
        'Refresh the exact current assignment/card evidence; no transition effect was attempted.',
        context.value.task,
      );
  }
  const rolloverResult = await inspectOrPlanRollover(
    buildRolloverRequest(request, context.value.task.record),
  );
  if (!rolloverResult.ok)
    return failureReport(
      'plan',
      request,
      'needs_input',
      rolloverResult.code,
      rolloverResult.message,
      rolloverResult.nextAction,
      context.value.task,
    );
  let bootstrap: VisibleBootstrapReport;
  try {
    bootstrap = await bootstrapExecutor(dependencies).plan(
      context.value.bootstrap,
    );
  } catch {
    return failureReport(
      'plan',
      request,
      'unknown',
      'bootstrap_plan_failed',
      'The read-only bootstrap planner did not return a report.',
      'Reconcile the exact bootstrap request and current task; no transition effect was attempted.',
      context.value.task,
    );
  }
  const changed = await assertTaskStoreCurrent(context.value.task);
  if (changed !== null)
    return failureReport(
      'plan',
      request,
      'needs_input',
      changed.code,
      changed.message,
      changed.nextAction,
      context.value.task,
    );
  let hostObservation: SessionTransitionHostObservation | null = null;
  if (dependencies.host !== undefined) {
    try {
      hostObservation = await dependencies.host.observe();
    } catch {
      return failureReport(
        'plan',
        request,
        'needs_input',
        'host_observation_unavailable',
        'The opt-in Pi host did not return an observation.',
        'Re-read the exact session/cwd and host status; planning did not attempt a transition effect.',
        context.value.task,
      );
    }
    const identityIssue = hostIdentityFailure(hostObservation, request);
    if (identityIssue !== null)
      return failureReport(
        'plan',
        request,
        'needs_input',
        identityIssue.code,
        identityIssue.message,
        identityIssue.nextAction,
        context.value.task,
        { host: { id: dependencies.host.id, ...hostObservation } },
      );
    const changedAfterHost = await assertTaskStoreCurrent(context.value.task);
    if (changedAfterHost !== null)
      return failureReport(
        'plan',
        request,
        'needs_input',
        changedAfterHost.code,
        changedAfterHost.message,
        changedAfterHost.nextAction,
        context.value.task,
        { host: { id: dependencies.host.id, ...hostObservation } },
      );
  }
  const refreshed = await openTaskStore(request.task_root);
  if (!refreshed.ok)
    return failureReport(
      'plan',
      request,
      'needs_input',
      refreshed.code,
      refreshed.message,
      refreshed.nextAction,
      context.value.task,
    );
  const existingIntent = getIntent(
    refreshed.value.record,
    request.intent.intent_id,
  );
  const handoff = getHandoff(refreshed.value.record, request.intent.handoff_id);
  const drift = currentStateDrift(
    refreshed.value.record,
    request,
    handoff?.state === 'completed' ? 'successor' : 'source',
  );
  const steps = plannedSteps(
    rolloverResult.value,
    bootstrap,
    hostObservation,
    existingIntent !== null,
    handoff?.state ?? null,
  );
  const report = reportForContext(
    'plan',
    request,
    refreshed.value.record,
    rolloverResult.value,
    bootstrap,
    hostObservation,
    steps,
    'planned',
  );
  return drift === null
    ? report
    : {
        ...report,
        ok: false,
        status: 'needs_input',
        code: drift.code,
        message: drift.message,
        next_action: 'Reconcile current attempt/claims/epoch before applying.',
      };
}

export async function applySessionTransition(
  input: LoadedSessionTransitionRequest | SessionTransitionRequest,
  dependencies: SessionTransitionDependencies = {},
): Promise<SessionTransitionReport> {
  const request = requestOf(input);
  const now = dependencies.clock ?? Date.now;
  const context = await loadContext(input);
  if (!context.ok)
    return failureReport(
      'apply',
      request,
      context.kind === 'invalid' ? 'invalid' : 'needs_input',
      context.code,
      context.message,
      context.nextAction,
    );
  const existingHandoff = getHandoff(
    context.value.task.record,
    request.intent.handoff_id,
  );
  if (existingHandoff?.state !== 'completed') {
    const scopeDrift = managedExecutionScopeDrift(
      request,
      context.value.task.record,
    );
    if (scopeDrift !== null)
      return failureReport(
        'apply',
        request,
        'needs_input',
        scopeDrift.code,
        scopeDrift.message,
        'Rebind only after the authoritative task, attempt, owner epoch and claim pins are reconciled; no transition effect was attempted.',
        context.value.task,
      );
  }
  if (existingHandoff?.state === 'completed') {
    const drift = currentStateDrift(
      context.value.task.record,
      request,
      'successor',
    );
    if (drift !== null)
      return failureReport(
        'apply',
        request,
        'needs_input',
        drift.code,
        drift.message,
        'Reconcile successor authority, attempt and claim epochs before first-work or retirement.',
        context.value.task,
      );
    return applyFirstWorkAndRetirement(
      context.value,
      context.value.task,
      null,
      dependencies,
      now,
    );
  }
  if (existingHandoff?.state !== 'receiver_confirmed') {
    const preflight = validatePreflight(context.value, now());
    if (!preflight.ok)
      return failureReport(
        'apply',
        request,
        'needs_input',
        preflight.code,
        preflight.message,
        'Refresh the matching current assignment/card and re-plan.',
        context.value.task,
      );
  }
  if (dependencies.host === undefined) {
    const currentIntent = getIntent(
      context.value.task.record,
      request.intent.intent_id,
    );
    return failureReport(
      'apply',
      request,
      'needs_input',
      'pi_transition_host_required',
      'Effectful transition requires the explicitly loaded Pi session-transition host adapter; CLI-only metadata is not quiescence proof.',
      'Load the opt-in Pi extension and invoke its transition command; no freeze, bootstrap, transfer or archive was performed.',
      context.value.task,
      {
        stage: currentIntent === null ? 'not_started' : 'intent_created',
        intent:
          currentIntent === null
            ? null
            : { intent_id: currentIntent.intent_id },
        capabilities: {
          ...capabilities(null),
          pi_host_extension: 'not_loaded',
        },
      },
    );
  }
  let hostBefore: SessionTransitionHostObservation;
  try {
    hostBefore = await dependencies.host.observe();
  } catch {
    return failureReport(
      'apply',
      request,
      'needs_input',
      'host_observation_unavailable',
      'The opt-in Pi host did not return a current observation.',
      'Reconcile exact source session/cwd and controller status; no transition effect was attempted.',
      context.value.task,
    );
  }
  const changedAfterHostRead = await assertTaskStoreCurrent(context.value.task);
  if (changedAfterHostRead !== null)
    return failureReport(
      'apply',
      request,
      'needs_input',
      changedAfterHostRead.code,
      changedAfterHostRead.message,
      changedAfterHostRead.nextAction,
      context.value.task,
      { host: { id: dependencies.host.id, ...hostBefore } },
    );
  const identityIssue = hostIdentityFailure(hostBefore, request);
  if (identityIssue !== null)
    return failureReport(
      'apply',
      request,
      'needs_input',
      identityIssue.code,
      identityIssue.message,
      identityIssue.nextAction,
      context.value.task,
      { host: { id: dependencies.host.id, ...hostBefore } },
    );
  const rolloverResult = await inspectOrPlanRollover(
    buildRolloverRequest(request, context.value.task.record),
  );
  if (!rolloverResult.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      rolloverResult.code,
      rolloverResult.message,
      rolloverResult.nextAction,
      context.value.task,
      { host: { id: dependencies.host.id, ...hostBefore } },
    );
  const existing = getIntent(
    context.value.task.record,
    request.intent.intent_id,
  );
  const blockingDrift = rolloverResult.value.drift.find(
    (item) => !(existing === null && item.code === 'unknown_handoff'),
  );
  if (blockingDrift !== undefined)
    return failureReport(
      'apply',
      request,
      'needs_input',
      blockingDrift.code,
      blockingDrift.detail,
      'Reconcile task drift before transition effects.',
      context.value.task,
      {
        rollover: rolloverResult.value,
        host: { id: dependencies.host.id, ...hostBefore },
      },
    );
  if (
    existing !== null &&
    !sameIntentRequest(existing, request.intent, request)
  )
    return failureReport(
      'apply',
      request,
      'invalid',
      'intent_input_conflict',
      'The transition id is already pinned to different immutable inputs.',
      'Choose a new transition id only after reconciling the existing handoff.',
      context.value.task,
    );
  if (existing === null) {
    const created = await intentTransaction(context.value, dependencies, now);
    if (!created.ok)
      return failureReport(
        'apply',
        request,
        'needs_input',
        created.reason,
        'The durable rollover intent could not be committed.',
        'Re-read current task revision/claims and reconcile before retrying.',
        context.value.task,
        { host: { id: dependencies.host.id, ...hostBefore } },
      );
  }
  const currentTask = await openTaskStore(request.task_root);
  if (!currentTask.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      currentTask.code,
      currentTask.message,
      currentTask.nextAction,
      context.value.task,
    );
  const currentIntent = getIntent(
    currentTask.value.record,
    request.intent.intent_id,
  );
  if (
    currentIntent === null ||
    !sameIntentRequest(currentIntent, request.intent, request)
  )
    return failureReport(
      'apply',
      request,
      'unknown',
      'intent_reconcile_required',
      'The intent commit could not be confirmed from the current record.',
      'Inspect the authoritative task record; no native effect was attempted.',
      currentTask.value,
      { host: { id: dependencies.host.id, ...hostBefore } },
    );
  const handoff = getHandoff(
    currentTask.value.record,
    request.intent.handoff_id,
  );
  if (handoff === null)
    return failureReport(
      'apply',
      request,
      'unknown',
      'handoff_missing',
      'The rollover intent is recorded but its handoff is missing.',
      'Inspect the task record; do not create a second handoff.',
      currentTask.value,
    );

  if (handoff.state === 'requested') {
    if (hostBefore.proof_support !== 'available') {
      const currentRollover = await inspectOrPlanRollover(
        buildRolloverRequest(request, currentTask.value.record),
      );
      const blocker =
        hostBefore.unavailable_code ?? 'host_stop_proof_unavailable';
      const detail =
        hostBefore.detail ??
        'No accepted host can produce complete native quiescence proof.';
      return failureReport(
        'apply',
        request,
        'waiting',
        blocker,
        detail,
        'Do not infer stop from idle, settled events, a freeze latch, or transcript data. Wait for the accepted session-bound native proof API; no source freeze, successor bootstrap, or transfer was attempted.',
        currentTask.value,
        {
          stage: 'awaiting_quiescence',
          intent: {
            intent_id: currentIntent.intent_id,
            generation: currentIntent.generation,
            handoff_id: currentIntent.handoff_id,
          },
          handoff: { handoff_id: handoff.handoff_id, state: handoff.state },
          rollover: currentRollover.ok ? currentRollover.value : null,
          host: { id: dependencies.host.id, ...hostBefore },
          steps: [
            step('create-intent', 'satisfied'),
            step('source-quiescence', 'unavailable', blocker, detail),
            step(
              'successor-bootstrap',
              'blocked',
              'predecessor_step_unavailable',
              'Bootstrap cannot start until source quiescence is supported.',
            ),
            step(
              'receiver-ack',
              'blocked',
              'predecessor_step_unavailable',
              'No successor was started.',
            ),
            step(
              'claim-route-transfer',
              'blocked',
              'predecessor_step_unavailable',
              'Claims and assignment remain with the source.',
            ),
            step(
              'first-work',
              'blocked',
              'predecessor_step_unavailable',
              'No successor work is authorized.',
            ),
            step(
              'task-retirement',
              'blocked',
              'predecessor_step_unavailable',
              'Retirement is forbidden before validated first work.',
            ),
          ],
          capabilities: capabilities(hostBefore),
        },
      );
    }
    const prepared = await freezeAndPrepare(
      context.value,
      currentTask.value,
      hostBefore,
      dependencies,
      now,
    );
    return prepared.report;
  }

  if (handoff.state === 'transferring') {
    let bootstrapReport: VisibleBootstrapReport;
    try {
      bootstrapReport = await bootstrapExecutor(dependencies).apply(
        context.value.bootstrap,
      );
    } catch {
      return failureReport(
        'apply',
        request,
        'unknown',
        'bootstrap_outcome_unknown',
        'The successor bootstrap executor did not return a durable result.',
        'Inspect the exact bootstrap reservation, pane, binding and notification receipt; never repeat an ambiguous launch or prompt.',
        currentTask.value,
      );
    }
    const afterBootstrap = await openTaskStore(request.task_root);
    if (!afterBootstrap.ok)
      return failureReport(
        'apply',
        request,
        'unknown',
        afterBootstrap.code,
        afterBootstrap.message,
        afterBootstrap.nextAction,
        currentTask.value,
        { bootstrap: bootstrapReport },
      );
    const current = getHandoff(
      afterBootstrap.value.record,
      request.intent.handoff_id,
    );
    if (current?.state === 'receiver_confirmed')
      return applyConfirmedTransfer(
        context.value,
        afterBootstrap.value,
        hostBefore,
        dependencies,
        now,
        bootstrapReport,
      );
    if (current?.state !== 'transferring')
      return failureReport(
        'apply',
        request,
        'unknown',
        'handoff_state_changed',
        'Handoff changed during successor bootstrap; inspect before continuing.',
        'Re-read the task record and bootstrap reservation; no further effect was attempted.',
        afterBootstrap.value,
        { bootstrap: bootstrapReport },
      );
    if (
      request.evidence.ack_message_id !== null &&
      (bootstrapReport.status === 'applied' ||
        bootstrapReport.status === 'already_recorded')
    )
      return applyConfirmedTransfer(
        context.value,
        afterBootstrap.value,
        hostBefore,
        dependencies,
        now,
        bootstrapReport,
      );
    const bootstrapComplete =
      bootstrapReport.status === 'applied' ||
      bootstrapReport.status === 'already_recorded';
    return reportForContext(
      'apply',
      request,
      afterBootstrap.value.record,
      null,
      bootstrapReport,
      hostBefore,
      [
        step('create-intent', 'satisfied'),
        step('source-quiescence', 'satisfied'),
        step(
          'successor-bootstrap',
          bootstrapComplete ? 'satisfied' : 'unknown',
          bootstrapReport.code,
          bootstrapReport.message,
        ),
        step(
          'receiver-ack',
          bootstrapComplete ? 'waiting' : 'blocked',
          bootstrapComplete ? null : 'predecessor_step_unavailable',
          'Wait for and register the exact successor ACK; no second prompt or successor start is automatic.',
        ),
        step(
          'claim-route-transfer',
          'blocked',
          'predecessor_step_unavailable',
          'Claims and assignment remain with the source until the correlated ACK.',
        ),
        step(
          'first-work',
          'blocked',
          'predecessor_step_unavailable',
          'Successor first work is not yet authorized.',
        ),
        step(
          'task-retirement',
          'blocked',
          'predecessor_step_unavailable',
          'Retirement follows validated first work.',
        ),
      ],
      bootstrapComplete ? 'waiting' : 'unknown',
      {
        next_action: bootstrapComplete
          ? 'Wait for the exact registered successor ACK and apply once with its message id.'
          : 'Reconcile the durable bootstrap reservation before continuing.',
      },
    );
  }

  if (handoff.state === 'receiver_confirmed') {
    return applyConfirmedTransfer(
      context.value,
      currentTask.value,
      hostBefore,
      dependencies,
      now,
    );
  }
  if (handoff.state === 'completed') {
    return applyFirstWorkAndRetirement(
      context.value,
      currentTask.value,
      hostBefore,
      dependencies,
      now,
    );
  }
  if (handoff.state === 'aborted')
    return failureReport(
      'apply',
      request,
      'needs_input',
      'handoff_aborted',
      'The recorded handoff is aborted and cannot transition.',
      'Create a new explicitly authorized transition only after reconciliation.',
      currentTask.value,
    );
  return failureReport(
    'apply',
    request,
    'unknown',
    'handoff_state_unknown',
    `Handoff is in unsupported state ${handoff.state}.`,
    'Inspect the authoritative record; no automatic recovery is attempted.',
    currentTask.value,
  );
}

function herdrOpsFor(
  dependencies: SessionTransitionDependencies,
  taskRoot: string,
): HerdrBootstrapOps {
  if (dependencies.herdr !== undefined) return dependencies.herdr;
  const bootstrap = dependencies.bootstrapDependencies;
  if (bootstrap?.ops !== undefined) return bootstrap.ops;
  return bootstrap?.transport === undefined
    ? createHerdrBootstrapOps({ transport: createHerdrTransport({ taskRoot }) })
    : createHerdrBootstrapOps({ transport: bootstrap.transport });
}

async function readRegisteredTaskMessage(
  context: TransitionContext,
  messageId: string,
): Promise<
  | { readonly ok: true; readonly value: RegisteredMessage }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const opened = await openMessageTask(context.task.taskRoot);
  if (!opened.ok)
    return { ok: false, code: opened.code, message: opened.message };
  const registered = await readRegisteredMessageSafe(opened.value, messageId);
  if (!registered.ok)
    return { ok: false, code: registered.code, message: registered.message };
  return { ok: true, value: registered.value };
}

function registeredApplied(
  record: TaskRecord,
  registered: RegisteredMessage,
  type: 'ACK' | 'REPORT',
): boolean {
  return (
    registered.message.type === type &&
    (record.messages ?? []).some(
      (entry) =>
        entry.message_id === registered.message.message_id &&
        entry.content_digest === registered.message.content_digest &&
        entry.state === 'applied' &&
        entry.type === type,
    )
  );
}

function transitionProgressReport(
  context: TransitionContext,
  task: OpenedTaskStore,
  host: SessionTransitionHostObservation | null,
  bootstrapReport: VisibleBootstrapReport | null,
  steps: readonly SessionTransitionStep[],
  nextAction: string,
): SessionTransitionReport {
  return reportForContext(
    'apply',
    context.request,
    task.record,
    null,
    bootstrapReport,
    host,
    steps,
    'progressed',
    { next_action: nextAction },
  );
}

async function applyConfirmedTransfer(
  context: TransitionContext,
  initialTask: OpenedTaskStore,
  initialHost: SessionTransitionHostObservation,
  dependencies: SessionTransitionDependencies,
  now: () => number,
  bootstrapReport: VisibleBootstrapReport | null = null,
): Promise<SessionTransitionReport> {
  const request = context.request;
  let task = initialTask;
  let handoff = getHandoff(task.record, request.intent.handoff_id);
  if (handoff === null)
    return failureReport(
      'apply',
      request,
      'unknown',
      'handoff_missing',
      'The exact receiver handoff is missing.',
      'Inspect the authoritative task record before continuing.',
      task,
      { bootstrap: bootstrapReport },
    );
  const ackId =
    request.evidence.ack_message_id ?? handoff.confirmation_message_id ?? null;
  if (handoff.state === 'transferring' && ackId === null)
    return failureReport(
      'apply',
      request,
      'waiting',
      'receiver_ack_required',
      'The successor has not supplied a correlated registered ACK.',
      'Wait for the successor ACK, register/apply it, then reapply once with its message id.',
      task,
      {
        bootstrap: bootstrapReport,
        host: { id: dependencies.host?.id ?? 'not-loaded', ...initialHost },
        steps: [
          step('create-intent', 'satisfied'),
          step('source-quiescence', 'satisfied'),
          step(
            'successor-bootstrap',
            bootstrapReport?.status === 'applied' ||
              bootstrapReport?.status === 'already_recorded'
              ? 'satisfied'
              : 'unknown',
          ),
          step('receiver-ack', 'waiting', 'receiver_ack_required'),
          step(
            'claim-route-transfer',
            'blocked',
            'predecessor_step_unavailable',
          ),
          step('first-work', 'blocked', 'predecessor_step_unavailable'),
          step('task-retirement', 'blocked', 'predecessor_step_unavailable'),
        ],
      },
    );
  if (ackId === null)
    return failureReport(
      'apply',
      request,
      'needs_input',
      'receiver_ack_missing',
      'No correlated receiver ACK id is recorded for this handoff.',
      'Inspect the handoff state and register the exact ACK; do not infer recipient acceptance.',
      task,
      { bootstrap: bootstrapReport },
    );
  const loadedAck = await readRegisteredTaskMessage(context, ackId);
  if (!loadedAck.ok)
    return failureReport(
      'apply',
      request,
      'waiting',
      'receiver_ack_not_registered',
      `ACK ${ackId} is not available as a safe registered message (${loadedAck.code}).`,
      'Register and apply the exact successor ACK; do not treat notification submission as acceptance.',
      task,
      { bootstrap: bootstrapReport },
    );
  let ack = loadedAck.value;
  const currentAfterAckRead = await openTaskStore(request.task_root);
  if (!currentAfterAckRead.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      currentAfterAckRead.code,
      currentAfterAckRead.message,
      currentAfterAckRead.nextAction,
      task,
      { bootstrap: bootstrapReport },
    );
  task = currentAfterAckRead.value;
  if (!registeredApplied(task.record, ack, 'ACK'))
    return failureReport(
      'apply',
      request,
      'waiting',
      'receiver_ack_not_applied',
      'The exact ACK file exists but the current task ledger does not show it as applied.',
      'Apply the registered ACK under the current task revision before transfer.',
      task,
      { bootstrap: bootstrapReport },
    );
  handoff = getHandoff(task.record, request.intent.handoff_id);
  if (handoff === null)
    return failureReport(
      'apply',
      request,
      'unknown',
      'handoff_missing',
      'The exact handoff disappeared while reading the ACK.',
      'Inspect the authoritative task record.',
      task,
      { bootstrap: bootstrapReport },
    );
  if (handoff.state === 'transferring') {
    if (dependencies.signal?.aborted)
      return failureReport(
        'apply',
        request,
        'needs_input',
        'abort_requested',
        'The transition was aborted before receiver confirmation.',
        'Reconcile the current ACK and task state before continuing.',
        task,
        { bootstrap: bootstrapReport },
      );
    const outcome = transact(task.taskRoot, {
      actor: request.intent.from.agent_id,
      purpose: 'session-transition:confirm-receiver',
      expectRevision: task.record.state_revision,
      clock: now(),
      apply: (record) => {
        const drift = currentStateDrift(record, request, 'source');
        if (drift !== null) return { ok: false as const, reason: drift.code };
        const entry = (record.messages ?? []).find(
          (item) => item.message_id === ackId,
        );
        if (
          entry?.state !== 'applied' ||
          entry.content_digest !== ack.message.content_digest ||
          entry.type !== 'ACK'
        )
          return { ok: false as const, reason: 'receiver_ack_not_applied' };
        const confirmed = rollover.confirmRolloverReceiver(record, {
          intent_id: request.intent.intent_id,
          message: ack.message,
          clock: now(),
        });
        if (!confirmed.ok) return confirmed;
        return {
          record,
          op: 'session-transition-confirm-receiver',
          summary: {
            transition_id: request.transition_id,
            ack_message_id: ackId,
          },
          result: confirmed,
        };
      },
    });
    if (!outcome.ok) {
      const waiting =
        outcome.reason === 'receiver_ack_not_applied' ||
        outcome.reason === 'ack_not_registered' ||
        outcome.reason === 'ack_not_applied';
      return failureReport(
        'apply',
        request,
        waiting ? 'waiting' : 'needs_input',
        outcome.reason,
        'Core rollover refused receiver confirmation.',
        'Reconcile the exact ACK, current epoch, assignment and claims before any transfer.',
        task,
        { bootstrap: bootstrapReport },
      );
    }
    const confirmedTask = await openTaskStore(request.task_root);
    if (!confirmedTask.ok)
      return failureReport(
        'apply',
        request,
        'unknown',
        confirmedTask.code,
        confirmedTask.message,
        confirmedTask.nextAction,
        task,
        { bootstrap: bootstrapReport },
      );
    task = confirmedTask.value;
    handoff = getHandoff(task.record, request.intent.handoff_id);
  }
  if (handoff?.state !== 'receiver_confirmed')
    return failureReport(
      'apply',
      request,
      'unknown',
      'receiver_confirmation_unconfirmed',
      'The durable task record does not confirm the receiver ACK.',
      'Inspect the exact ACK, handoff and task revision before any transfer.',
      task,
      { bootstrap: bootstrapReport },
    );
  if (handoff.confirmation_message_id !== ackId)
    return failureReport(
      'apply',
      request,
      'invalid',
      'receiver_ack_conflict',
      'The ACK id differs from the confirmation already recorded for this handoff.',
      'Use the exact recorded confirmation id; do not replace receiver evidence.',
      task,
      { bootstrap: bootstrapReport },
    );
  if (!registeredApplied(task.record, ack, 'ACK')) {
    const refreshedAck = await readRegisteredTaskMessage(context, ackId);
    if (
      !refreshedAck.ok ||
      !registeredApplied(task.record, refreshedAck.value, 'ACK')
    )
      return failureReport(
        'apply',
        request,
        'needs_input',
        'receiver_ack_receipt_changed',
        'The recorded ACK is no longer present as the exact applied task message.',
        'Reconcile the registered message digest and handoff confirmation before transfer.',
        task,
        { bootstrap: bootstrapReport },
      );
    ack = refreshedAck.value;
  }
  const bindingBefore = validateSuccessorBinding(context, task.record);
  if (!bindingBefore.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      bindingBefore.code,
      bindingBefore.message,
      'Reconcile the exact bootstrap reservation and successor binding before claim transfer.',
      task,
      { bootstrap: bootstrapReport },
    );
  const herdr = herdrOpsFor(dependencies, task.taskRoot);
  let listed: HerdrListResult;
  try {
    listed = await herdr.listAgents();
  } catch {
    return failureReport(
      'apply',
      request,
      'needs_input',
      'herdr_agent_list_unavailable',
      'The live successor identity could not be re-observed.',
      'Refresh Herdr metadata for the exact successor binding; no claim transfer was attempted.',
      task,
      { bootstrap: bootstrapReport },
    );
  }
  if (!listed.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      'herdr_agent_list_unavailable',
      listed.detail,
      'Refresh Herdr metadata for the exact successor binding; no claim transfer was attempted.',
      task,
      { bootstrap: bootstrapReport },
    );
  const liveMatches = listed.agents.filter(
    (agent) => agent.name === bindingBefore.value.herdr_agent,
  );
  if (liveMatches.length !== 1)
    return failureReport(
      'apply',
      request,
      'needs_input',
      'successor_live_identity_not_unique',
      'Herdr does not report exactly one live participant for the reserved successor name.',
      'Reconcile the exact task-local binding and live Herdr roster; no claims were transferred.',
      task,
      { bootstrap: bootstrapReport },
    );
  const live = liveMatches[0]!;
  const liveSession = reportedSessionIdentity(
    live.sessionKind,
    live.sessionValue,
  );
  if (
    live.paneId !== bindingBefore.value.participant.pane_id ||
    live.harness !== request.intent.to.harness ||
    live.cwd === null ||
    !safePathEqual(live.cwd, request.intent.to.cwd ?? '') ||
    liveSession.status !== 'match' ||
    liveSession.identity !== request.intent.to.session_id
  )
    return failureReport(
      'apply',
      request,
      'needs_input',
      'successor_live_identity_mismatch',
      'Live Herdr pane, harness, cwd or reported native session differs from the reserved successor binding.',
      'Reconcile the exact successor identity; Herdr metadata does not prove process affiliation.',
      task,
      { bootstrap: bootstrapReport },
    );
  const host = dependencies.host;
  if (host === undefined)
    return failureReport(
      'apply',
      request,
      'needs_input',
      'pi_transition_host_required',
      'The source host disappeared before ownership transfer.',
      'Reopen the opt-in source-session adapter and re-plan; no claims were transferred.',
      task,
      { bootstrap: bootstrapReport },
    );
  let currentHost: SessionTransitionHostObservation;
  try {
    currentHost = await host.observe();
  } catch {
    return failureReport(
      'apply',
      request,
      'waiting',
      'host_observation_unknown',
      'The source session could not be re-observed immediately before claim transfer.',
      'Reconcile the exact source freeze and complete quiescence proof; no transfer was attempted.',
      task,
      { bootstrap: bootstrapReport },
    );
  }
  const sourceIdentityIssue = hostIdentityFailure(currentHost, request);
  if (sourceIdentityIssue !== null)
    return failureReport(
      'apply',
      request,
      'needs_input',
      sourceIdentityIssue.code,
      sourceIdentityIssue.message,
      sourceIdentityIssue.nextAction,
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const proofIssue = proofSupportFailure(currentHost, request, now());
  if (proofIssue !== null)
    return failureReport(
      'apply',
      request,
      'waiting',
      proofIssue.code,
      proofIssue.message,
      'Keep the source frozen and reconcile a fresh complete native proof before moving claims.',
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const transferProof = currentHost.proof;
  const transferInventoryDigest =
    transferProof === null
      ? null
      : quiescenceInventoryDigest(transferProof.inventory);
  if (transferProof === null || transferInventoryDigest === null)
    return failureReport(
      'apply',
      request,
      'waiting',
      'host_quiescence_proof_invalid',
      'The immediate pre-transfer observation did not include a complete inventory digest.',
      'Reconcile a fresh complete native proof; no claims were transferred.',
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const transferQuiescenceReceipt = quiescenceReceipt(
    transferProof,
    transferInventoryDigest,
  );
  const unchanged = await assertTaskStoreCurrent(task);
  if (unchanged !== null)
    return failureReport(
      'apply',
      request,
      'needs_input',
      unchanged.code,
      unchanged.message,
      unchanged.nextAction,
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const latest = await openTaskStore(request.task_root);
  if (!latest.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      latest.code,
      latest.message,
      latest.nextAction,
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  task = latest.value;
  const drift = currentStateDrift(task.record, request, 'source');
  if (drift !== null)
    return failureReport(
      'apply',
      request,
      'needs_input',
      drift.code,
      drift.message,
      'Reconcile current attempt, approval/cancellation, coordinator epoch, source identity and claims before transfer.',
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  handoff = getHandoff(task.record, request.intent.handoff_id);
  if (
    handoff?.state !== 'receiver_confirmed' ||
    handoff.confirmation_message_id !== ackId
  )
    return failureReport(
      'apply',
      request,
      'needs_input',
      'handoff_confirmation_changed',
      'Receiver confirmation changed before claim transfer.',
      'Reconcile the authoritative handoff and exact ACK before continuing.',
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const bindingNow = validateSuccessorBinding(context, task.record);
  if (
    !bindingNow.ok ||
    bindingNow.value.source_file !== bindingBefore.value.source_file ||
    bindingNow.value.source_digest !== bindingBefore.value.source_digest ||
    bindingNow.value.participant.pane_id !== live.paneId
  )
    return failureReport(
      'apply',
      request,
      'needs_input',
      'successor_binding_changed',
      bindingNow.ok
        ? 'The exact successor binding changed after live identity observation.'
        : bindingNow.message,
      'Reconcile task-local binding and live Herdr evidence before transfer.',
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const nativeEvidenceRef = `${herdr.id}:${live.name}:session:${liveSession.identity}`;
  const transfer = transact(task.taskRoot, {
    actor: request.intent.from.agent_id,
    purpose: 'session-transition:complete-transfer',
    expectRevision: task.record.state_revision,
    clock: now(),
    apply: (record) => {
      if (dependencies.signal?.aborted)
        return { ok: false as const, reason: 'abort_requested' };
      const sourceDrift = currentStateDrift(record, request, 'source');
      if (sourceDrift !== null)
        return { ok: false as const, reason: sourceDrift.code };
      const currentHandoff = getHandoff(record, request.intent.handoff_id);
      if (
        currentHandoff?.state !== 'receiver_confirmed' ||
        currentHandoff.confirmation_message_id !== ackId
      )
        return { ok: false as const, reason: 'handoff_confirmation_changed' };
      const ackEntry = (record.messages ?? []).find(
        (entry) => entry.message_id === ackId,
      );
      if (
        ackEntry?.state !== 'applied' ||
        ackEntry.content_digest !== ack.message.content_digest ||
        ackEntry.type !== 'ACK'
      )
        return { ok: false as const, reason: 'receiver_ack_receipt_changed' };
      const successorBinding = validateSuccessorBinding(context, record);
      if (
        !successorBinding.ok ||
        successorBinding.value.source_digest !==
          bindingBefore.value.source_digest
      )
        return { ok: false as const, reason: 'successor_binding_changed' };
      const completed = rollover.completeRolloverTransfer(record, {
        intent_id: request.intent.intent_id,
        successor_native: {
          agent_id: request.intent.to.agent_id,
          runner: 'pi',
          session_id: request.intent.to.session_id,
          run_id: null,
          mission_id: null,
          evidence_ref: nativeEvidenceRef,
          observed_at: new Date(now()).toISOString(),
        },
        actor: request.intent.from.agent_id,
        clock: now(),
      });
      if (!completed.ok) return completed;
      const savedQuiescence = setJournalQuiescenceReceipt(
        record,
        request.transition_id,
        'transfer',
        transferQuiescenceReceipt,
      );
      if (!savedQuiescence.ok)
        return { ok: false as const, reason: savedQuiescence.code };
      return {
        record,
        op: 'session-transition-complete-transfer',
        summary: {
          transition_id: request.transition_id,
          ack_message_id: ackId,
        },
        result: completed,
      };
    },
  });
  if (!transfer.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      transfer.reason,
      'Core rollover refused the ownership/claim transfer.',
      'Reconcile the exact ACK, successor binding, live Herdr session, source proof and current claims before retrying.',
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const transferredTask = await openTaskStore(request.task_root);
  if (!transferredTask.ok)
    return failureReport(
      'apply',
      request,
      'unknown',
      transferredTask.code,
      transferredTask.message,
      transferredTask.nextAction,
      task,
      { host: { id: host.id, ...currentHost }, bootstrap: bootstrapReport },
    );
  const routeBinding = await ensureSuccessorRouteBinding(
    context,
    transferredTask.value,
    dependencies,
    now,
  );
  if (!routeBinding.ok)
    return {
      ...routeBinding.report,
      host: { id: host.id, ...currentHost },
      bootstrap: bootstrapReport,
    };
  return transitionProgressReport(
    context,
    routeBinding.task,
    currentHost,
    bootstrapReport,
    [
      step('create-intent', 'satisfied'),
      step('source-quiescence', 'satisfied'),
      step('successor-bootstrap', 'satisfied'),
      step('receiver-ack', 'satisfied'),
      step('claim-route-transfer', 'satisfied'),
      step('first-work', 'waiting'),
      step('task-retirement', 'blocked', 'predecessor_step_unavailable'),
    ],
    'The task assignee and claims moved after correlated ACK, and a successor-only task-local binding was recorded. Wait for the admitted successor REPORT; native session archival remains unavailable.',
  );
}

async function applyFirstWorkAndRetirement(
  context: TransitionContext,
  initialTask: OpenedTaskStore,
  hostObservation: SessionTransitionHostObservation | null,
  dependencies: SessionTransitionDependencies,
  now: () => number,
): Promise<SessionTransitionReport> {
  const request = context.request;
  const observedHost = hostObservation ?? {};
  let task = initialTask;
  const handoff = getHandoff(task.record, request.intent.handoff_id);
  if (handoff?.state !== 'completed')
    return failureReport(
      'apply',
      request,
      'needs_input',
      'transfer_not_completed',
      'Successor first work cannot be recorded before the core claim/assignee transfer.',
      'Reconcile the receiver ACK and transfer boundary first.',
      task,
      {
        host: { id: dependencies.host?.id ?? 'not-loaded', ...observedHost },
      },
    );
  const routeBinding = await ensureSuccessorRouteBinding(
    context,
    task,
    dependencies,
    now,
  );
  if (!routeBinding.ok)
    return {
      ...routeBinding.report,
      host: { id: dependencies.host?.id ?? 'not-loaded', ...observedHost },
    };
  task = routeBinding.task;
  let succession = (task.record.successions ?? []).find(
    (item) =>
      item.intent_id === request.intent.intent_id &&
      item.handoff_id === request.intent.handoff_id &&
      item.generation === request.intent.generation,
  );
  if (succession !== undefined) {
    const validation = validateSuccession(task.record, succession);
    if (!validation.ok)
      return failureReport(
        'apply',
        request,
        'needs_input',
        validation.code,
        validation.detail,
        'Reconcile the exact first-work REPORT and transfer boundary; retirement remains blocked.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    if (
      request.evidence.first_work_report_id !== null &&
      request.evidence.first_work_report_id !== validation.proof.message_id
    )
      return failureReport(
        'apply',
        request,
        'invalid',
        'first_work_report_conflict',
        'The request REPORT id differs from the first-work proof already recorded for this transition.',
        'Use the exact recorded first-work report; do not replace accepted evidence.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
  } else {
    const reportId = request.evidence.first_work_report_id;
    if (reportId === null)
      return failureReport(
        'apply',
        request,
        'waiting',
        'first_work_report_required',
        'Task retirement is waiting for an admitted successor first-work REPORT.',
        'Register/apply the exact completed successor REPORT, then reapply with its message id; no archive marker is written before it.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
          steps: [
            step('create-intent', 'satisfied'),
            step('source-quiescence', 'satisfied'),
            step('successor-bootstrap', 'satisfied'),
            step('receiver-ack', 'satisfied'),
            step('claim-route-transfer', 'satisfied'),
            step('first-work', 'waiting', 'first_work_report_required'),
            step('task-retirement', 'blocked', 'predecessor_step_unavailable'),
          ],
        },
      );
    const loadedReport = await readRegisteredTaskMessage(context, reportId);
    if (!loadedReport.ok)
      return failureReport(
        'apply',
        request,
        'waiting',
        'first_work_report_not_registered',
        `REPORT ${reportId} is not available as a safe registered message (${loadedReport.code}).`,
        'Register/apply the exact successor REPORT; submission alone is not first-work evidence.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    const latest = await openTaskStore(request.task_root);
    if (!latest.ok)
      return failureReport(
        'apply',
        request,
        'needs_input',
        latest.code,
        latest.message,
        latest.nextAction,
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    task = latest.value;
    const drift = currentStateDrift(task.record, request, 'successor');
    if (drift !== null)
      return failureReport(
        'apply',
        request,
        'needs_input',
        drift.code,
        drift.message,
        'Reconcile successor attempt, approval/cancellation, input, epoch, native identity and claim epochs before first-work recording.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    if (!registeredApplied(task.record, loadedReport.value, 'REPORT'))
      return failureReport(
        'apply',
        request,
        'waiting',
        'first_work_report_not_applied',
        'The REPORT file exists but the task ledger does not show it as applied.',
        'Apply the exact registered successor REPORT before first-work recording.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    const routeReceipt = journalEntry(
      task.record,
      request,
      context.requestDigest,
    );
    const routeFile = readTaskLocalFile(
      routeBinding.ref,
      task.taskRoot,
      64 * 1024,
    );
    if (
      routeReceipt?.effects['successor-route-binding']?.state !== 'completed' ||
      routeReceipt?.route_binding_ref !== routeBinding.ref ||
      routeReceipt?.route_binding_digest !== routeBinding.digest ||
      !routeFile.ok ||
      routeFile.digest !== routeBinding.digest
    )
      return failureReport(
        'apply',
        request,
        'reconcile_required',
        'successor_route_binding_receipt_missing',
        'The route binding changed before first-work recording.',
        'Reconcile the successor-only binding and journal before proceeding.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    const outcome = transact(task.taskRoot, {
      actor: request.intent.to.agent_id,
      purpose: 'session-transition:record-first-work',
      expectRevision: task.record.state_revision,
      clock: now(),
      apply: (record) => {
        if (dependencies.signal?.aborted)
          return { ok: false as const, reason: 'abort_requested' };
        const currentDrift = currentStateDrift(record, request, 'successor');
        if (currentDrift !== null)
          return { ok: false as const, reason: currentDrift.code };
        const savedRoute = journalEntry(record, request, context.requestDigest);
        if (
          savedRoute?.effects['successor-route-binding']?.state !==
            'completed' ||
          savedRoute?.route_binding_ref !== routeBinding.ref ||
          savedRoute?.route_binding_digest !== routeBinding.digest
        )
          return {
            ok: false as const,
            reason: 'successor_route_binding_receipt_missing',
          };
        const entry = (record.messages ?? []).find(
          (item) => item.message_id === reportId,
        );
        if (
          entry?.state !== 'applied' ||
          entry.content_digest !== loadedReport.value.message.content_digest ||
          entry.type !== 'REPORT'
        )
          return {
            ok: false as const,
            reason: 'first_work_report_not_applied',
          };
        const recorded = rollover.recordRolloverFirstWork(record, {
          intent_id: request.intent.intent_id,
          message: loadedReport.value.message,
          clock: now(),
        });
        if (!recorded.ok) return recorded;
        return {
          record,
          op: 'session-transition-record-first-work',
          summary: {
            transition_id: request.transition_id,
            report_message_id: reportId,
          },
          result: recorded,
        };
      },
    });
    if (!outcome.ok) {
      const waiting =
        outcome.reason === 'first_work_report_not_registered' ||
        outcome.reason === 'first_work_report_not_applied';
      return failureReport(
        'apply',
        request,
        waiting ? 'waiting' : 'needs_input',
        outcome.reason,
        'Core rollover refused the first-work proof.',
        'Reconcile the registered REPORT, post-transfer boundary and current successor claims before retirement.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    }
    const recordedTask = await openTaskStore(request.task_root);
    if (!recordedTask.ok)
      return failureReport(
        'apply',
        request,
        'unknown',
        recordedTask.code,
        recordedTask.message,
        recordedTask.nextAction,
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
    task = recordedTask.value;
    succession = (task.record.successions ?? []).find(
      (item) =>
        item.intent_id === request.intent.intent_id &&
        item.handoff_id === request.intent.handoff_id &&
        item.generation === request.intent.generation,
    );
    if (succession === undefined)
      return failureReport(
        'apply',
        request,
        'unknown',
        'first_work_outcome_unconfirmed',
        'The core first-work reducer returned without a matching succession record.',
        'Inspect the authoritative task record; do not submit a second report.',
        task,
        {
          host: {
            id: dependencies.host?.id ?? 'not-loaded',
            ...observedHost,
          },
        },
      );
  }
  const validation = validateSuccession(task.record, succession);
  if (!validation.ok)
    return failureReport(
      'apply',
      request,
      'needs_input',
      validation.code,
      validation.detail,
      'Reconcile the exact first-work REPORT and transfer boundary before retirement.',
      task,
      {
        host: { id: dependencies.host?.id ?? 'not-loaded', ...observedHost },
      },
    );
  const exclusion = routeExclusionFor(task.record, request.intent.from);
  if (exclusion.state !== 'excluded')
    return failureReport(
      'apply',
      request,
      'needs_input',
      exclusion.conflict ?? 'route_exclusion_unconfirmed',
      'The validated succession does not yet exclude the old identity from notify routing.',
      'Reconcile the succession record before retirement; native routing removal is still not claimed.',
      task,
      {
        host: { id: dependencies.host?.id ?? 'not-loaded', ...observedHost },
      },
    );
  const retirement = await ensureTaskRetirementMarker(
    context,
    task,
    routeBinding,
    dependencies,
    now,
  );
  if (!retirement.ok)
    return {
      ...retirement.report,
      host: { id: dependencies.host?.id ?? 'not-loaded', ...observedHost },
    };
  return transitionProgressReport(
    context,
    retirement.task,
    hostObservation,
    null,
    [
      step('create-intent', 'satisfied'),
      step('source-quiescence', 'satisfied'),
      step('successor-bootstrap', 'satisfied'),
      step('receiver-ack', 'satisfied'),
      step('claim-route-transfer', 'satisfied'),
      step('first-work', 'satisfied'),
      step('task-retirement', 'satisfied'),
    ],
    'A reversible task-retirement marker is recorded; the original transcript remains in place and native Pi session archive is unavailable.',
  );
}
