import type {
  SiblingExecution,
  VisibleBootstrapReport,
} from '../collab-bootstrap.js';
import type {
  CollabBinding,
  CollabBindingParticipant,
} from '../../schemas/collaboration.js';
import { notifyRegisteredMessage } from '../collab-notify.js';
import type { ReadySibling } from './allocate.js';
import type { StartedSibling } from './launch.js';

export async function deliverSibling(
  execution: SiblingExecution,
  { pane, readiness, placement }: ReadySibling,
  {
    nativeSessionId,
    managedLaunch,
    managedConfigPath,
    managedConfigDigest,
  }: StartedSibling,
): Promise<VisibleBootstrapReport> {
  const {
    context,
    reservationId,
    dependencies,
    now,
    steps,
    phase,
    successReport,
    liveParticipant,
    callerSummary,
    participantSummary,
    splitReportArgv,
    commitEffectIntent,
    guardedBootstrapTransport,
    revalidateCurrent,
    notificationSummary,
    liveCallerAgain,
    terminalReport,
    writeBindingExclusive,
  } = execution;
  const request = context.request;
  const bindingPhase = phase({ phase: 'binding_pending' });
  if (!bindingPhase.ok)
    return terminalReport(
      context,
      'unknown',
      bindingPhase.code,
      bindingPhase.message,
      null,
      { readiness: readiness.evidence, state_revision: execution.revision },
    );
  const participant: CollabBindingParticipant = {
    agent_id: request.participant.agent_id,
    harness: request.participant.harness,
    cwd: request.target.cwd,
    herdr_agent: context.herdrAgent,
    pane_id: pane.paneId,
    native_session_id: nativeSessionId,
  };
  let binding: CollabBinding;
  try {
    if (
      context.binding.participants.some(
        (item) =>
          item.agent_id === participant.agent_id ||
          item.herdr_agent === participant.herdr_agent,
      )
    )
      throw new Error('binding_participant_conflict');
    binding = {
      ...context.binding,
      participants: [...context.binding.participants, participant],
    };
  } catch {
    const saved = phase({
      phase: 'binding_conflict',
      outcome: 'unknown',
      detail: 'task-local participant conflict',
    });
    return terminalReport(
      context,
      'needs_input',
      'binding_participant_conflict',
      'Agent started but binding conflicts; it is left running and no notification was sent.',
      null,
      {
        state_revision: saved.ok ? saved.revision : execution.revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          { step: 'task-binding', status: 'conflict', detail: null },
        ],
      },
    );
  }
  const savedBinding = writeBindingExclusive(
    context.task.taskRoot,
    context.derivedBindingFile,
    binding,
  );
  if (!savedBinding.ok) {
    const saved = phase({
      phase: 'binding_write_failed',
      outcome: 'unknown',
      detail: savedBinding.code,
    });
    return terminalReport(
      context,
      'unknown',
      savedBinding.code,
      'Agent started but its task-local routing binding could not be persisted; no notification was sent.',
      'Reconcile the running agent and binding before any new request.',
      {
        state_revision: saved.ok ? saved.revision : execution.revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          { step: 'task-binding', status: 'failed', detail: savedBinding.code },
        ],
      },
    );
  }
  const bindingStored = phase({
    phase: 'binding_written',
    extra: { derived_binding_digest: savedBinding.digest },
  });
  if (!bindingStored.ok)
    return terminalReport(
      context,
      'unknown',
      bindingStored.code,
      bindingStored.message,
      null,
      {
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          {
            step: 'task-binding',
            status: 'written_unrecorded',
            detail: context.derivedBindingFile,
          },
        ],
      },
    );
  steps.push({
    step: 'task-binding',
    status: 'persisted',
    detail:
      'Task-local routing metadata written after exact live identity; it grants no authority.',
  });

  const callerBeforeNotify = await liveCallerAgain(context);
  const recipientAgents = await context.ops.listAgents();
  const recipientLive = recipientAgents.ok
    ? liveParticipant(
        participant,
        {
          agent_id: request.participant.agent_id,
          session_id: request.participant.native_session_selector,
          harness: request.participant.harness,
        },
        recipientAgents.agents,
      )
    : {
        ok: false as const,
        code: 'herdr_agent_list_unavailable',
        message: recipientAgents.detail,
      };
  const revalidated = await revalidateCurrent(context, now());
  if (
    !callerBeforeNotify.ok ||
    !recipientAgents.ok ||
    !recipientLive.ok ||
    !revalidated.ok
  ) {
    const reason = !callerBeforeNotify.ok
      ? callerBeforeNotify.code
      : !recipientAgents.ok
        ? 'herdr_agent_list_unavailable'
        : !recipientLive.ok
          ? recipientLive.code
          : revalidated.ok
            ? 'revalidation_unexpected'
            : revalidated.code;
    const detail = !callerBeforeNotify.ok
      ? callerBeforeNotify.message
      : !recipientAgents.ok
        ? recipientAgents.detail
        : !recipientLive.ok
          ? recipientLive.message
          : revalidated.ok
            ? 'Task revalidation unexpectedly passed.'
            : revalidated.message;
    const saved = phase({
      phase: 'notify_revalidation_failed',
      outcome: 'unknown',
      detail: reason,
    });
    return terminalReport(
      context,
      'needs_input',
      reason,
      detail,
      'Reconcile the caller, successor and current task before issuing a new request.',
      {
        state_revision: saved.ok ? saved.revision : execution.revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          { step: 'notify', status: 'not_started', detail: reason },
        ],
      },
    );
  }
  const notificationPending = commitEffectIntent(
    context,
    reservationId,
    revalidated.task.record.state_revision,
    revalidated.task.identity.recordFile,
    'notify_pending',
    now(),
    dependencies.signal,
  );
  if (!notificationPending.ok) {
    const saved = phase({
      phase: 'notify_intent_refused',
      outcome: 'unknown',
      detail: notificationPending.code,
    });
    return terminalReport(
      context,
      'needs_input',
      notificationPending.code,
      notificationPending.message,
      'Reconcile current task authority before sending the registered message.',
      {
        state_revision: saved.ok ? saved.revision : execution.revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          {
            step: 'notify',
            status: 'not_started',
            detail: notificationPending.code,
          },
        ],
      },
    );
  }
  execution.revision = notificationPending.revision;
  const notify = dependencies.notify ?? notifyRegisteredMessage;
  const notification = await notify({
    taskRoot: context.task.taskRoot,
    messageId: request.message_pointer.message_id,
    bindingFile: context.derivedBindingFile,
    apply: true,
    retry: false,
    callerPane: context.caller.paneId,
    transport: guardedBootstrapTransport(
      context,
      reservationId,
      now,
      dependencies.signal,
    ),
    clock: now(),
  });
  const summary = notificationSummary(notification);
  const submitted =
    notification.ok && notification.value.status === 'submitted';
  const recorded =
    notification.ok && notification.value.status === 'already_recorded';
  const final = phase({
    phase: submitted || recorded ? 'completed' : 'notification_unknown',
    outcome: submitted
      ? 'submitted'
      : recorded
        ? 'already_recorded'
        : 'unknown',
    release: submitted || recorded,
    detail: notification.ok ? notification.value.detail : notification.message,
    extra: {
      notification: summary,
      message_consumed: false,
      task_accepted: false,
    },
  });
  steps.push({
    step: 'notify-registered-message',
    status: submitted ? 'submitted' : recorded ? 'already_recorded' : 'unknown',
    detail: typeof summary['detail'] === 'string' ? summary['detail'] : null,
  });
  if (!submitted && !recorded)
    return terminalReport(
      context,
      'unknown',
      'notification_not_confirmed',
      'Registered-message submission was not confirmed; no second prompt or automatic retry was attempted.',
      'Inspect the persisted delivery/reservation state before any new request.',
      {
        state_revision: final.ok ? final.revision : execution.revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        reservation: {
          reservation_id: reservationId,
          phase: 'notification_unknown',
        },
        notification: summary,
        effects: steps,
      },
    );
  const status = submitted ? 'applied' : 'already_recorded';
  return successReport('apply', request, context.requestDigest, status, {
    task_id: context.task.record.task_id,
    state_revision: final.ok ? final.revision : execution.revision,
    caller: callerSummary(context),
    participant: participantSummary(context),
    target: {
      ...request.target,
      pane_id: pane.paneId,
      anchor_pane_id: placement.anchorPaneId,
      direction: placement.direction,
      split_ratio: placement.ratio ?? null,
      placement:
        request.target.direction === undefined ? 'adaptive' : 'explicit',
      split_argv: splitReportArgv({
        anchorPaneId: placement.anchorPaneId,
        cwd: request.target.cwd,
        direction: placement.direction,
        ratio: placement.ratio,
      }),
    },
    bootstrap: {
      config_digest: context.configDigest,
      bundle_manifest_digest: context.bundle.digest,
      extension_entry: request.bootstrap.extension_entry,
      runtime:
        managedLaunch === null
          ? 'accepted_artifact_digest_match'
          : 'managed_sdk_control_observed',
      authority: 'default-deny-until-recorded-transfer-completes',
      gate_registration: 'not_independently_observed',
      bootstrap_extension_load:
        managedLaunch === null
          ? 'not_independently_observed'
          : 'control_metadata_observed',
      model:
        managedLaunch === null
          ? 'daily_default_launch; selected_runtime_inheritance_unverified'
          : {
              ...managedLaunch.launch.model,
              observation: 'owned-pi-sdk-control',
            },
      ...(managedLaunch === null
        ? {}
        : {
            managed_sdk_control: {
              identity_provenance: managedLaunch.identityProvenance,
              control_schema: managedLaunch.controlSchema,
              session_id: managedLaunch.sessionId,
              process_pid: managedLaunch.processPid,
              socket_peer_pid: managedLaunch.socketPeerPid,
              foreground_process_pid: managedLaunch.foregroundProcessPid,
              herdr_agent_name: managedLaunch.launch.herdrAgentName,
              herdr_pane_id: managedLaunch.paneId,
              sdk_module_path: managedLaunch.launch.sdkModulePath,
              bootstrap_extension_path:
                managedLaunch.launch.bootstrapExtensionPath,
              journal_path: managedLaunch.launch.journalPath,
              managed_config_path: managedConfigPath,
              managed_config_digest: managedConfigDigest,
              handoff_context_file:
                request.managed_runtime?.handoff_context_file ?? null,
              ready: managedLaunch.launch.ready,
            },
          }),
    },
    reservation: {
      reservation_id: reservationId,
      phase: 'completed',
      outcome: submitted ? 'submitted' : 'already_recorded',
    },
    readiness: readiness.evidence,
    effects: steps,
    notification: summary,
    limits: [
      managedLaunch === null
        ? 'agent_start_and_extension_argument_do_not_prove_gate_registration'
        : 'managed_sdk_extension_path_observed_but_gate_registration_not_independently_proven',
      'new_successor_capabilities_are_not_synthesized',
      'message_submitted_not_consumed_or_accepted',
      'no_old_writer_quiescence_or_native_archive_proof',
      ...(managedLaunch === null
        ? ['selected_runtime_model_inheritance_unverified']
        : []),
    ],
  });
}
