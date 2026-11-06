import type {
  SiblingExecution,
  VisibleBootstrapReport,
} from '../collab-bootstrap.js';
import {
  acceptedManagedSdkStartReceipt,
  type BootstrapManagedSdkStartInput,
  type BootstrapStartedManagedSdk,
} from '../collab-bootstrap-transport.js';
import { reportedSessionIdentity } from '../collab-notify.js';
import type { ReadySibling } from './allocate.js';

export interface StartedSibling {
  readonly nativeSessionId: string;
  readonly managedLaunch: BootstrapStartedManagedSdk | null;
  readonly managedConfigPath: string | null;
  readonly managedConfigDigest: string | null;
}

export async function launchSibling(
  execution: SiblingExecution,
  { pane, readiness }: ReadySibling,
  onStarted: (started: StartedSibling) => Promise<VisibleBootstrapReport>,
): Promise<VisibleBootstrapReport> {
  const {
    context,
    reservationId,
    dependencies,
    now,
    steps,
    phase,
    readTimeoutMs,
    startTimeoutMs,
    safePathEqual,
    managedRuntimePathsFor,
    writeManagedSdkConfig,
    acceptedPiArgv,
    managedSdkLaunchMatches,
    commitEffectIntent,
    persistReceipt,
    revalidateCurrent,
    liveCallerAgain,
    paneSnapshotMatches,
    closeOwnedEmptyPane,
    terminalReport,
  } = execution;
  const request = context.request;
  const callerBeforeStart = await liveCallerAgain(context);
  const paneBeforeStart = await context.ops.paneGet(pane.paneId, readTimeoutMs);
  const beforeStart = await revalidateCurrent(context, now());
  if (
    !callerBeforeStart.ok ||
    !paneBeforeStart.ok ||
    !paneSnapshotMatches(paneBeforeStart.value, pane) ||
    !beforeStart.ok
  ) {
    const reason = !callerBeforeStart.ok
      ? callerBeforeStart.code
      : !paneBeforeStart.ok
        ? paneBeforeStart.code
        : !paneSnapshotMatches(paneBeforeStart.value, pane)
          ? 'owned_pane_identity_drift'
          : !beforeStart.ok
            ? beforeStart.code
            : 'revalidation_not_required';
    const cleanup = await closeOwnedEmptyPane(
      context,
      reservationId,
      pane,
      now,
    );
    const saved = phase({
      phase: 'pre_start_revalidation_failed',
      outcome:
        cleanup.state === 'closed_owned_pane' ? 'not_started' : 'unknown',
      release: cleanup.state === 'closed_owned_pane',
      detail: reason,
      extra: { cleanup: { state: cleanup.state, code: cleanup.code } },
    });
    return terminalReport(
      context,
      cleanup.state === 'closed_owned_pane' ? 'needs_input' : 'unknown',
      reason,
      'Caller/task/pane identity changed after readiness; agent start was not attempted.',
      'Reconcile the task and owned pane before creating a new request.',
      {
        state_revision: saved.ok ? saved.revision : execution.revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          { step: 'cleanup', status: cleanup.state, detail: cleanup.code },
        ],
      },
    );
  }
  const refuseManagedStart = async (
    code: string,
    detail: string,
  ): Promise<VisibleBootstrapReport> => {
    const cleanup = await closeOwnedEmptyPane(
      context,
      reservationId,
      pane,
      now,
    );
    const cleanupConfirmed = cleanup.state === 'closed_owned_pane';
    const saved = phase({
      phase: 'managed_sdk_setup_failed',
      outcome: cleanupConfirmed ? 'not_started' : 'unknown',
      release: cleanupConfirmed,
      detail: code,
      extra: { cleanup: { state: cleanup.state, code: cleanup.code } },
    });
    return terminalReport(
      context,
      cleanupConfirmed ? 'needs_input' : 'unknown',
      code,
      detail,
      cleanupConfirmed
        ? 'Correct the managed SDK paths/config and submit a fresh request id.'
        : 'Reconcile the owned pane; no automatic cleanup or retry is permitted.',
      {
        state_revision: saved.ok ? saved.revision : execution.revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        reservation: {
          reservation_id: reservationId,
          phase: 'managed_sdk_setup_failed',
          cleanup: cleanup.state,
        },
        effects: [
          ...steps,
          { step: 'managed-sdk-config', status: 'failed', detail: code },
          { step: 'cleanup', status: cleanup.state, detail: cleanup.code },
        ],
      },
    );
  };
  const unknownManagedStart = (
    code: string,
    detail: string,
  ): VisibleBootstrapReport => {
    const saved = phase({
      phase: 'managed_sdk_start_unknown',
      outcome: 'unknown',
      detail: code,
    });
    return terminalReport(
      context,
      'unknown',
      code,
      detail,
      'Inspect the managed SDK control response and owned pane; never re-submit this request id.',
      {
        state_revision: saved.ok ? saved.revision : execution.revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        reservation: {
          reservation_id: reservationId,
          phase: 'managed_sdk_start_unknown',
        },
        effects: [
          ...steps,
          { step: 'managed-sdk-start', status: 'unknown', detail: code },
        ],
      },
    );
  };
  const startPending = commitEffectIntent(
    context,
    reservationId,
    beforeStart.task.record.state_revision,
    beforeStart.task.identity.recordFile,
    request.managed_runtime === undefined
      ? 'agent_start_pending'
      : 'managed_sdk_start_pending',
    now(),
    dependencies.signal,
  );
  if (!startPending.ok) {
    const cleanup = await closeOwnedEmptyPane(
      context,
      reservationId,
      pane,
      now,
    );
    const saved = phase({
      phase: 'start_intent_refused',
      outcome:
        cleanup.state === 'closed_owned_pane' ? 'not_started' : 'unknown',
      release: cleanup.state === 'closed_owned_pane',
      detail: startPending.code,
      extra: { cleanup: { state: cleanup.state, code: cleanup.code } },
    });
    return terminalReport(
      context,
      cleanup.state === 'closed_owned_pane' ? 'needs_input' : 'unknown',
      startPending.code,
      startPending.message,
      'Reconcile current task authority and the owned pane before any new request.',
      {
        state_revision: saved.ok ? saved.revision : execution.revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          { step: 'cleanup', status: cleanup.state, detail: cleanup.code },
        ],
      },
    );
  }
  execution.revision = startPending.revision;
  let nativeSessionId: string;
  let managedLaunch: BootstrapStartedManagedSdk | null = null;
  let managedConfigPath: string | null = null;
  let managedConfigDigest: string | null = null;
  if (request.managed_runtime !== undefined) {
    const runtimePaths = managedRuntimePathsFor(request);
    if (!runtimePaths.ok)
      return refuseManagedStart(runtimePaths.code, runtimePaths.message);
    const config = writeManagedSdkConfig(
      request,
      context,
      pane.paneId,
      runtimePaths.paths,
    );
    if (!config.ok)
      return refuseManagedStart(
        config.code,
        'The private immutable SDK configuration could not be created and verified.',
      );
    managedConfigPath = runtimePaths.paths.configPath;
    managedConfigDigest = config.digest;
    const configRecorded = phase({
      phase: 'managed_sdk_start_pending',
      extra: {
        managed_sdk_config: {
          path: runtimePaths.paths.configPath,
          digest: config.digest,
          journal_path: runtimePaths.paths.journalPath,
          control_socket_path: runtimePaths.paths.controlSocketPath,
          session_id: request.participant.native_session_selector,
          model: {
            provider: 'openrouter',
            id: request.selected_model.openrouter_model!,
          },
          bootstrap_extension_path: request.bootstrap.extension_entry,
          herdr_agent_name: context.herdrAgent,
          herdr_pane_id: pane.paneId,
          ...(runtimePaths.paths.handoffContextFile === undefined
            ? {}
            : { handoff_context_file: runtimePaths.paths.handoffContextFile }),
        },
      },
    });
    if (!configRecorded.ok)
      return refuseManagedStart(
        configRecorded.code,
        'Managed SDK config was created but could not be bound to the durable reservation.',
      );
    const startManagedSdk = context.ops.startManagedSdk;
    const model = request.selected_model.openrouter_model;
    if (startManagedSdk === undefined || model === undefined)
      return refuseManagedStart(
        'managed_start_unavailable',
        'No managed SDK start port or explicit OpenRouter model is available; legacy Pi fallback is forbidden.',
      );
    const managedInput: BootstrapManagedSdkStartInput = {
      name: context.herdrAgent,
      paneId: pane.paneId,
      workspaceId: pane.workspaceId,
      terminalId: pane.terminalId,
      cwd: request.target.cwd,
      sessionId: request.participant.native_session_selector,
      openrouterModel: model,
      sdkModulePath: runtimePaths.paths.sdkModulePath,
      journalPath: runtimePaths.paths.journalPath,
      controlSocketPath: runtimePaths.paths.controlSocketPath,
      bootstrapExtensionPath: request.bootstrap.extension_entry,
      configPath: runtimePaths.paths.configPath,
      configDigest: config.digest,
      timeoutMs: context.request.target.start_timeout_ms ?? startTimeoutMs,
      ...(runtimePaths.paths.automaticHandoffFile === undefined
        ? {}
        : { automaticHandoffFile: runtimePaths.paths.automaticHandoffFile }),
      ...(runtimePaths.paths.handoffContextFile === undefined
        ? {}
        : { handoffContextFile: runtimePaths.paths.handoffContextFile }),
      onReceipt: persistReceipt(context, reservationId, now),
    };
    let startedManaged: Awaited<ReturnType<typeof startManagedSdk>>;
    try {
      startedManaged = await startManagedSdk(managedInput);
    } catch {
      return unknownManagedStart(
        'managed_sdk_start_exception',
        'Managed SDK start threw after submission may have begun; no retry or cleanup was attempted.',
      );
    }
    if (!startedManaged.ok) {
      return startedManaged.status === 'unknown'
        ? unknownManagedStart(startedManaged.code, startedManaged.detail)
        : refuseManagedStart(startedManaged.code, startedManaged.detail);
    }
    if (
      !acceptedManagedSdkStartReceipt(startedManaged.receipt, {
        paneId: pane.paneId,
        configPath: runtimePaths.paths.configPath,
      })
    )
      return unknownManagedStart(
        'managed_sdk_start_receipt_unverified',
        'The fixed managed CLI submission receipt did not match the exact pane/config command.',
      );
    if (
      !managedSdkLaunchMatches(
        startedManaged.value,
        context,
        pane,
        runtimePaths.paths,
      )
    )
      return unknownManagedStart(
        'managed_sdk_control_unverified',
        'Herdr name/state, SDK control metadata, socket peer owner and pane foreground PID did not agree.',
      );
    managedLaunch = startedManaged.value;
    nativeSessionId = startedManaged.value.sessionId;
  } else {
    const started = await context.ops.startAgent({
      name: context.herdrAgent,
      paneId: pane.paneId,
      sessionId: request.participant.native_session_selector,
      extensionEntry: request.bootstrap.extension_entry,
      timeoutMs: request.target.start_timeout_ms ?? startTimeoutMs,
      ...(request.selected_model.openrouter_model
        ? { openrouterModel: request.selected_model.openrouter_model }
        : {}),
      onReceipt: persistReceipt(context, reservationId, now),
    });
    if (!started.ok) {
      const cleanup =
        started.status === 'unknown'
          ? null
          : await closeOwnedEmptyPane(context, reservationId, pane, now);
      const noEffect = cleanup?.state === 'closed_owned_pane';
      const saved = phase({
        phase:
          started.status === 'unknown'
            ? 'agent_start_unknown'
            : 'agent_start_failed',
        outcome: noEffect ? 'not_started' : 'unknown',
        release: noEffect,
        detail: started.code,
        ...(cleanup
          ? { extra: { cleanup: { state: cleanup.state, code: cleanup.code } } }
          : {}),
      });
      return terminalReport(
        context,
        started.status === 'unknown' ? 'unknown' : 'failed',
        started.code,
        started.detail,
        'Inspect the exact Herdr start result; do not retry or close a pane that may now contain an agent.',
        {
          state_revision: saved.ok ? saved.revision : execution.revision,
          target: { ...request.target, pane_id: pane.paneId },
          readiness: readiness.evidence,
          effects: [
            ...steps,
            {
              step: 'agent-start',
              status: started.status,
              detail: started.code,
            },
          ],
        },
      );
    }
    const native = reportedSessionIdentity(
      started.value.sessionKind,
      started.value.sessionValue,
    );
    if (
      started.value.name !== context.herdrAgent ||
      started.value.paneId !== pane.paneId ||
      started.value.workspaceId !== pane.workspaceId ||
      started.value.terminalId !== pane.terminalId ||
      native.status !== 'match' ||
      native.identity !== request.participant.native_session_selector ||
      started.value.harness !== 'pi' ||
      started.value.cwd === null ||
      !safePathEqual(started.value.cwd, request.target.cwd) ||
      started.value.launchPending ||
      !acceptedPiArgv(
        started.value.argv,
        request.participant.native_session_selector,
        context.herdrAgent,
        request.bootstrap.extension_entry,
        request.selected_model.openrouter_model,
      ) ||
      !started.value.interactiveReady
    ) {
      const saved = phase({
        phase: 'agent_identity_unknown',
        outcome: 'unknown',
        detail: 'exact successor identity not proven',
        extra: {
          created_pane_id: pane.paneId,
          observed_agent_name: started.value.name,
          observed_session_kind: started.value.sessionKind,
          observed_session_id:
            native.status === 'match' ? native.identity : null,
        },
      });
      return terminalReport(
        context,
        'unknown',
        'agent_identity_unverified',
        'Agent start returned but the exact live successor identity/interactive state is unconfirmed; no binding or prompt was written.',
        null,
        {
          state_revision: saved.ok ? saved.revision : execution.revision,
          target: { ...request.target, pane_id: pane.paneId },
          readiness: readiness.evidence,
          effects: [
            ...steps,
            {
              step: 'agent-start',
              status: 'unknown',
              detail: 'identity mismatch',
            },
          ],
        },
      );
    }
    nativeSessionId = native.identity;
  }
  const callerAfterStart = await liveCallerAgain(context);
  const authorityAfterStart = await revalidateCurrent(context, now());
  if (!callerAfterStart.ok || !authorityAfterStart.ok) {
    const reason = !callerAfterStart.ok
      ? callerAfterStart.code
      : authorityAfterStart.ok
        ? 'post_start_revalidation_unexpected'
        : authorityAfterStart.code;
    const detail = !callerAfterStart.ok
      ? callerAfterStart.message
      : authorityAfterStart.ok
        ? 'Post-start authority unexpectedly passed the failure branch.'
        : authorityAfterStart.message;
    const saved = phase({
      phase: 'post_start_revalidation_failed',
      outcome: 'unknown',
      detail: reason,
    });
    return terminalReport(
      context,
      'needs_input',
      reason,
      `${detail} The successor may be running but remains unbound and unprompted.`,
      'Reconcile current task authority and the owned pane before creating a new request.',
      {
        state_revision: saved.ok ? saved.revision : execution.revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          {
            step: managedLaunch === null ? 'agent-start' : 'managed-sdk-start',
            status: 'blocked',
            detail: reason,
          },
        ],
      },
    );
  }
  const startedPhase = phase({
    phase: managedLaunch === null ? 'agent_started' : 'managed_sdk_started',
    extra: {
      created_pane_id: pane.paneId,
      created_workspace_id: pane.workspaceId,
      created_terminal_id: pane.terminalId,
      created_cwd: pane.cwd,
      observed_session_id: nativeSessionId,
      ...(managedLaunch === null
        ? {}
        : {
            managed_sdk_control: {
              runtime: 'sdk',
              identity_provenance: managedLaunch.identityProvenance,
              control_schema: managedLaunch.controlSchema,
              process_pid: managedLaunch.processPid,
              socket_peer_pid: managedLaunch.socketPeerPid,
              foreground_process_pid: managedLaunch.foregroundProcessPid,
              model: managedLaunch.launch.model,
              journal_path: managedLaunch.launch.journalPath,
              config_path: managedConfigPath,
              config_digest: managedConfigDigest,
            },
          }),
    },
  });
  if (!startedPhase.ok)
    return terminalReport(
      context,
      'unknown',
      startedPhase.code,
      startedPhase.message,
      null,
      { readiness: readiness.evidence, state_revision: execution.revision },
    );
  steps.push({
    step: managedLaunch === null ? 'agent-start' : 'managed-sdk-start',
    status: 'completed',
    detail:
      managedLaunch === null
        ? 'Pi agent start matched exact native session id, extension argv, model selection and interactive readiness.'
        : 'Managed SDK launch matched authenticated control, actual model/session/config metadata, socket peer owner and pane foreground PID; Herdr session-report ID was not used.',
  });
  return onStarted({
    nativeSessionId,
    managedLaunch,
    managedConfigPath,
    managedConfigDigest,
  });
}
