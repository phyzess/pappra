import path from 'node:path';
import { createHash } from 'node:crypto';
import { readRecord } from '../collab/store.js';
import { isAssignment } from '../collab/contracts.js';
import { canonicalJson } from '../collab/envelope.js';
import { readPiBootstrapConfig } from '../hosts/integration/bootstrap-config.js';
import { RolloverFreezeController } from '../hosts/integration/pi-rollover-extension.js';
import {
  startManagedPiSdkSession,
  type ManagedPiSdkSessionController,
} from '../hosts/pi/managed-sdk-session.js';
import { readBoundedFile } from './bounded-file.js';
import type { ManagedPiRequest } from './managed-pi.js';
import {
  bindManagedPiExecutionScope,
  createManagedPiTransitionHost,
  type BoundManagedPiExecutionScope,
} from './managed-pi-transition-host.js';
import type {
  ManagedPiExecutionScope,
  SessionTransitionHost,
} from './collab-session-transition.js';
import {
  loadAutomaticHandoffConfig,
  watchAutomaticHandoff,
} from './automatic-handoff-events.js';
import { watchManagedPiReadiness } from './managed-pi-readiness.js';
import { serveManagedPiSdkControl } from './managed-pi-sdk-control.js';
import { registerManagedPiRuntime } from './managed-pi-repair-stop.js';
import { retireManagedPiSource } from './managed-pi-retirement.js';
import { publishManagedPiHerdrIdentity } from './managed-pi-herdr.js';
import { watchManagedPiBootstrapAdmission } from './managed-pi-bootstrap-admission.js';
import { deliverManagedPiMessage } from './managed-pi-delivery.js';
import { prepareManagedPiHandoffReceiver } from './managed-pi-handoff-receiver.js';
import { refreshManagedBootstrapAdmission } from './managed-pi-bootstrap-refresh.js';
import { admitManagedSourceAssignment } from './managed-pi-source-admission.js';
import { watchManagedPiInitialAdmission } from './managed-pi-initial-admission.js';
import {
  initialAdmissionDigest,
  registerManagedPiInitialLaunch,
} from './managed-pi-initial-launch.js';

import {
  canExecuteManagedPiResume,
  prepareManagedPiResume,
  releaseManagedPiResume,
} from './managed-pi-resume-admission.js';
/** Native SDK CLI lifecycle, including a receiver's deferred authoritative task binding. */
export async function runManagedPiSdkRuntime(
  request: ManagedPiRequest,
): Promise<number> {
  let automatic = request.automaticHandoffFile
    ? loadAutomaticHandoffConfig(request.automaticHandoffFile)
    : null;
  const sourceReadiness = request.readiness ?? automatic?.sourceReadiness;
  if (
    request.readiness &&
    automatic?.sourceReadiness &&
    canonicalJson(request.readiness) !==
      canonicalJson(automatic.sourceReadiness)
  )
    throw new Error('managed_source_readiness_conflict');
  const bootstrap = request.bootstrapExtensionPath
    ? readPiBootstrapConfig(
        path.join(
          path.dirname(request.bootstrapExtensionPath),
          'bootstrap.json',
        ),
      )
    : null;
  if (bootstrap && !bootstrap.ok)
    throw new Error('managed_bootstrap_config_invalid');
  if (
    bootstrap?.ok &&
    (bootstrap.config.guard.successor.sessionId !== request.sessionId ||
      request.executionScope)
  )
    throw new Error('managed_bootstrap_receiver_identity_invalid');
  if (
    automatic &&
    (request.sessionId !== automatic.transition.intent.from.session_id ||
      request.cwd !== automatic.transition.intent.from.cwd)
  )
    throw new Error('automatic_handoff_source_mismatch');
  const immediateScope =
    request.executionScope ??
    (!bootstrap ? automatic?.transition.managed_execution_scope : undefined);
  if (
    request.executionScope &&
    automatic?.transition.managed_execution_scope &&
    canonicalJson(request.executionScope) !==
      canonicalJson(automatic.transition.managed_execution_scope)
  )
    throw new Error('managed_execution_scope_conflict');
  if (
    request.resume &&
    (!request.executionScope ||
      bootstrap ||
      automatic ||
      request.initialAssignment ||
      request.handoffContextFile)
  )
    throw new Error('managed_pi_resume_scope_or_mode_invalid');
  const resumeAuthorization = request.resume
    ? await prepareManagedPiResume(request)
    : undefined;
  let scope: ManagedPiExecutionScope | null = null;
  let host: SessionTransitionHost | undefined;
  let control: Awaited<ReturnType<typeof serveManagedPiSdkControl>> | null =
    null;
  let readiness: ReturnType<typeof watchManagedPiReadiness> | null = null;
  let admission: Awaited<
    ReturnType<typeof watchManagedPiBootstrapAdmission>
  > | null = null;
  let initialAdmission: Awaited<
    ReturnType<typeof watchManagedPiInitialAdmission>
  > | null = null;
  let publication: Awaited<
    ReturnType<typeof publishManagedPiHerdrIdentity>
  > | null = null;
  let handoff: ReturnType<typeof watchAutomaticHandoff> | null = null;
  let retirement: Awaited<ReturnType<typeof retireManagedPiSource>> | null =
    null;
  let receiver: Awaited<
    ReturnType<typeof prepareManagedPiHandoffReceiver>
  > | null = null;
  let retirementWatch: NodeJS.Timeout | null = null;
  let ready = false;
  let unbindInitialLifecycle: (() => void) | undefined;
  let sourceAdmissionReady = false;
  let sourceAdmissionPending = false;
  let sourceAdmissionError: string | null = null;
  let controller: ManagedPiSdkSessionController | undefined;
  let admissionController: ManagedPiSdkSessionController | undefined;
  const paneId = request.herdrPaneId ?? process.env.HERDR_PANE_ID ?? null;
  const name = request.herdrAgentName;
  let resolveHandoff!: () => void;
  let rejectHandoff!: (error: Error) => void;
  const handoffCompleted = new Promise<void>((resolve, reject) => {
    resolveHandoff = resolve;
    rejectHandoff = reject;
  });
  void handoffCompleted.catch(() => {});
  const bindIdentity = (live: ManagedPiSdkSessionController) => {
    const assignmentFile =
      sourceReadiness?.assignmentFile ??
      request.initialAssignment?.assignmentFile;
    if (!assignmentFile) return;
    const file = readBoundedFile(assignmentFile, 1024 * 1024);
    if (!file.ok) return;
    let value: unknown;
    try {
      value = JSON.parse(file.text);
    } catch {
      return;
    }
    if (
      !isAssignment(value) ||
      value.assignee.harness !== 'pi' ||
      value.assignee.session_id !== live.observe().native.sessionId ||
      path.resolve(value.assignee.cwd) !== path.resolve(request.cwd)
    )
      return;
    const expectedAgent = bootstrap?.ok
      ? bootstrap.config.guard.successor.agentId
      : automatic?.transition.intent.from.agent_id;
    if (expectedAgent && value.assignee.agent_id !== expectedAgent) return;
    live.bindNativeIdentity({
      agentId: value.assignee.agent_id,
      paneId,
      surface: value.assignee.surface,
      configurationId: value.assignee.configuration_id,
    });
  };
  const startHandoff = (live: ManagedPiSdkSessionController) => {
    if (
      !automatic ||
      handoff ||
      (bootstrap && !scope) ||
      (receiver && !receiver.priorSourceRetired())
    )
      return;
    if (receiver && sourceReadiness && !sourceAdmissionReady) {
      if (
        !scope ||
        !receiver.status().first_work_observed ||
        sourceAdmissionPending
      )
        return;
      sourceAdmissionPending = true;
      void admitManagedSourceAssignment(live, scope, sourceReadiness)
        .then(async () => {
          sourceAdmissionReady = true;
          sourceAdmissionError = null;
          bindIdentity(live);
          live.publishResourcesReady(true);
          await readiness?.refresh();
          startHandoff(live);
        })
        .catch((error: unknown) => {
          sourceAdmissionError =
            error instanceof Error
              ? error.message
              : 'managed_source_admission_failed';
        })
        .finally(() => {
          sourceAdmissionPending = false;
        });
      return;
    }
    handoff = watchAutomaticHandoff(
      automatic,
      {
        observe: () => live.observe(),
        canCaptureSummary: () => live.canCaptureSummary(),
        captureSummary: (cause) => live.captureSummary(cause),
        inventory: () => live.inventory(),
        subscribe: (listener) => live.subscribe(listener),
        ...(sourceReadiness
          ? {
              prepareBootstrapAdmission: (original: {
                readonly ref: string;
                readonly digest: string;
              }) =>
                refreshManagedBootstrapAdmission(
                  live,
                  sourceReadiness,
                  original,
                ),
            }
          : {}),
      },
      host ? { host } : {},
      async (result) => {
        if (!result.request)
          throw new Error('handoff_retirement_request_missing');
        retirement = await retireManagedPiSource(
          result.request,
          live,
          host ? { host } : {},
        );
      },
    );
    void handoff.completed.then((result) => {
      if (result.ok) resolveHandoff();
      else rejectHandoff(new Error(result.code));
    });
  };
  const activate = async (
    live: ManagedPiSdkSessionController,
    binding: BoundManagedPiExecutionScope,
  ) => {
    if (
      automatic &&
      (binding.scope.task_root !== automatic.transition.task_root ||
        binding.scope.subtask_id !== automatic.transition.intent.subtask_id ||
        binding.scope.attempt !== automatic.transition.intent.attempt ||
        binding.scope.owner_epoch !==
          automatic.transition.intent.coordinator_epoch ||
        (automatic.transition.managed_execution_scope &&
          canonicalJson(automatic.transition.managed_execution_scope) !==
            canonicalJson(binding.scope)))
    )
      throw new Error('automatic_handoff_scope_mismatch');
    scope = binding.scope;
    host = createManagedPiTransitionHost({
      controller: live,
      binding,
      freezeController: new RolloverFreezeController({
        sessionId: live.observe().native.sessionId,
        readAllowlist: [],
      }),
    });
    if (automatic)
      automatic = {
        ...automatic,
        transition: {
          ...automatic.transition,
          managed_execution_scope: binding.scope,
        },
      };
    if (!live.observe().native.agentId) {
      const record = readRecord(binding.scope.task_root);
      const assignee = record?.attempts.find(
        (row) =>
          row.subtask_id === binding.scope.subtask_id &&
          row.attempt === binding.scope.attempt,
      )?.assignee;
      if (
        !assignee ||
        assignee.session_id !== live.observe().native.sessionId ||
        assignee.harness !== 'pi'
      )
        throw new Error('managed_execution_identity_changed');
      live.bindNativeIdentity({
        agentId: assignee.agent_id,
        paneId,
        surface: 'pi-sdk-tui',
        configurationId: `sha256:${createHash('sha256').update(canonicalJson(binding.scope)).digest('hex')}`,
      });
    }
    bindIdentity(live);
    await registerManagedPiRuntime(
      live,
      binding.scope,
      `${request.journalPath}.control.json`,
      {
        confirmNative: !request.initialAssignment,
        ...(resumeAuthorization ? { resumeAuthorization } : {}),
      },
    );
    live.bindResumeCheckpointScope(binding.scope);
    live.recordInitialResumeCheckpoint();
    receiver?.startWork();
    if (ready) startHandoff(live);
  };
  const openControl = (live: ManagedPiSdkSessionController) =>
    serveManagedPiSdkControl(
      live,
      request.journalPath,
      request.controlSocketPath,
      () => ({
        launch: {
          runtime: 'sdk',
          sdk_module_path: request.sdkModulePath,
          bootstrap_extension_path: request.bootstrapExtensionPath ?? null,
          bootstrap_task_root: bootstrap?.ok ? bootstrap.taskRoot : null,
          bootstrap_config_digest: bootstrap?.ok ? bootstrap.digest : null,
          initial_task_root: request.initialAssignment?.taskRoot ?? null,
          initial_admission_digest: request.initialAssignment
            ? initialAdmissionDigest(request.initialAssignment)
            : null,
          herdr_agent_name: name ?? null,
          herdr_pane_id: paneId,
          journal_path: request.journalPath,
          controller_run_id: control?.runId ?? null,
          ready,
          session_id: live.observe().native.sessionId,
          cwd: live.observe().cwd,
          model: {
            provider: live.observe().native.modelObservation.provider,
            id: live.observe().native.modelObservation.model,
          },
        },
        readiness: readiness?.status() ?? null,
        handoff: handoff
          ? (() => {
              const status = handoff!.status();
              const result = status.result;
              return {
                error: status.error,
                completion: status.completion,
                result: result
                  ? {
                      schema: result.schema,
                      status: result.status,
                      code: result.code,
                      transition: result.transition
                        ? {
                            transition_id: result.transition.transition_id,
                            status: result.transition.status,
                            code: result.transition.code,
                            stage: result.transition.stage,
                          }
                        : null,
                    }
                  : null,
              };
            })()
          : null,
        retirement: retirement?.receipt ?? null,
        execution_scope: scope,
        resume: resumeAuthorization
          ? {
              source_run_id: resumeAuthorization.sourceRunId,
              source_pid: resumeAuthorization.sourcePid,
              restored_session_id: resumeAuthorization.sessionId,
              checkpoint_sequence: resumeAuthorization.checkpointSequence,
              checkpoint_digest: resumeAuthorization.checkpointDigest,
              task_authority_current: canExecuteManagedPiResume(
                resumeAuthorization,
                {
                  sessionId: live.observe().native.sessionId,
                  cwd: live.observe().cwd,
                },
              ),
            }
          : null,
        bootstrap_admission: admission?.status() ?? null,
        initial_admission: initialAdmission?.status() ?? null,
        herdr_publication: publication?.status() ?? null,
        receiver: receiver?.status() ?? null,
        source_admission: {
          ready: sourceAdmissionReady,
          error: sourceAdmissionError,
        },
      }),
      async (incoming) => {
        await initialAdmission?.refresh();
        const taskRoot =
          scope?.task_root ?? (bootstrap?.ok ? bootstrap.taskRoot : null);
        const agentId = bootstrap?.ok
          ? bootstrap.config.guard.successor.agentId
          : (automatic?.transition.intent.from.agent_id ??
            live.observe().native.agentId);
        if (!ready || !taskRoot || !agentId)
          return { ok: false, reason: 'delivery_not_bound' };
        return deliverManagedPiMessage(live, incoming, { taskRoot, agentId });
      },
    );
  let signalFailed = false;
  let resolveSignal!: () => void;
  const signalled = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const onSignal = () => {
    void controller?.stopOwnedRuntime().then(resolveSignal, () => {
      signalFailed = true;
      resolveSignal();
    });
  };
  try {
    const identity = bootstrap?.ok
      ? {
          agentId: bootstrap.config.guard.successor.agentId,
          paneId,
          surface: 'pi-sdk-tui',
          configurationId: bootstrap.digest,
        }
      : automatic
        ? {
            agentId: automatic.transition.intent.from.agent_id,
            paneId,
            surface: 'pi-sdk-tui',
            configurationId: automatic.id,
          }
        : undefined;
    controller = await startManagedPiSdkSession({
      cwd: request.cwd,
      model: request.model,
      journalPath: request.journalPath,
      sdkModulePath: request.sdkModulePath!,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.executionScope
        ? { executionScope: request.executionScope }
        : {}),
      ...(resumeAuthorization ? { resumeAuthorization } : {}),
      ...(request.thinkingLevel
        ? { thinkingLevel: request.thinkingLevel }
        : {}),
      ...(request.bootstrapExtensionPath
        ? { bootstrapExtensionPath: request.bootstrapExtensionPath }
        : {}),
      ...(identity ? { nativeIdentity: identity } : {}),
      ...(resumeAuthorization || request.initialAssignment
        ? {
            canExecute: () =>
              (!resumeAuthorization ||
                (admissionController !== undefined &&
                  canExecuteManagedPiResume(resumeAuthorization, {
                    sessionId: admissionController.observe().native.sessionId,
                    cwd: admissionController.observe().cwd,
                  }))) &&
              (!request.initialAssignment ||
                initialAdmission?.canExecute() === true),
          }
        : {}),
      beforeInteractiveStart: async (live) => {
        admissionController = live;
        bindIdentity(live);
        if (bootstrap?.ok) {
          const current = readPiBootstrapConfig(
            path.join(
              path.dirname(request.bootstrapExtensionPath!),
              'bootstrap.json',
            ),
          );
          if (!current.ok || current.digest !== bootstrap.digest)
            throw new Error('bootstrap_config_changed_during_start');
        }
        control = await openControl(live);
        if (request.initialAssignment) {
          await registerManagedPiInitialLaunch(
            live,
            request.initialAssignment,
            `${request.journalPath}.control.json`,
          );
          initialAdmission = await watchManagedPiInitialAdmission(
            live,
            request.initialAssignment,
            (binding) => activate(live, binding),
          );
        }
        if (immediateScope)
          await activate(
            live,
            await bindManagedPiExecutionScope({
              controller: live,
              scope: immediateScope,
            }),
          );
      },
    });
    if (request.initialAssignment) {
      const live = controller;
      unbindInitialLifecycle = live.subscribe((event) => {
        if (
          scope &&
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'agent_start'
        ) {
          void registerManagedPiRuntime(
            live,
            scope,
            `${request.journalPath}.control.json`,
          ).catch(() => {
            live.fenceIngress('initial_native_execution_binding_failed');
          });
        }
      });
    }
    if (paneId && process.env.HERDR_ENV === '1') {
      try {
        publication = await publishManagedPiHerdrIdentity(controller, {
          paneId,
          ...(name ? { name } : {}),
        });
      } catch (error) {
        if (name) throw error;
      }
    } else if (name) throw new Error('managed_herdr_context_required');
    ready = true;
    controller.recordInitialResumeCheckpoint();
    if (sourceReadiness)
      readiness = watchManagedPiReadiness(
        sourceReadiness,
        {
          sessionId: controller.observe().native.sessionId,
          cwd: request.cwd,
          metadataFile: `${request.journalPath}.pi-events.jsonl`,
        },
        undefined,
        {
          beforeRefresh: async () => {
            bindIdentity(controller!);
            controller!.publishResourcesReady();
          },
        },
      );
    if (bootstrap?.ok && request.handoffContextFile)
      receiver = await prepareManagedPiHandoffReceiver(
        controller,
        bootstrap.config,
        request.handoffContextFile,
        request.journalPath,
      );
    if (bootstrap?.ok)
      admission = await watchManagedPiBootstrapAdmission(
        controller,
        bootstrap.config,
        (binding) => activate(controller!, binding),
      );
    startHandoff(controller);
    if (automatic && receiver) {
      retirementWatch = setInterval(() => {
        startHandoff(controller!);
        if (handoff && retirementWatch) {
          clearInterval(retirementWatch);
          retirementWatch = null;
        }
      }, 1000);
      retirementWatch.unref();
    }
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('SIGHUP', onSignal);
    await Promise.race([
      controller.runPromise,
      control!.stopped,
      signalled,
      ...(automatic ? [handoffCompleted] : []),
    ]);
    return signalFailed ? 1 : 0;
  } finally {
    try {
      ready = false;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('SIGHUP', onSignal);
      if (retirementWatch) clearInterval(retirementWatch);
      await readiness?.close();
      unbindInitialLifecycle?.();
      (handoff as ReturnType<typeof watchAutomaticHandoff> | null)?.close();
      await admission?.close();
      await (
        initialAdmission as Awaited<
          ReturnType<typeof watchManagedPiInitialAdmission>
        > | null
      )?.close();
      receiver?.close();
      await (
        publication as Awaited<
          ReturnType<typeof publishManagedPiHerdrIdentity>
        > | null
      )?.close();
      (
        control as Awaited<ReturnType<typeof serveManagedPiSdkControl>> | null
      )?.close();
      await controller?.stopOwnedRuntime().catch(() => {});
    } finally {
      if (resumeAuthorization) releaseManagedPiResume(resumeAuthorization);
    }
  }
}
