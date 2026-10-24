import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from './bounded-file.js';
import { openTaskStore, assertTaskStoreCurrent } from './collab-task-store.js';
import { requestManagedPiControl } from '../hosts/pi/managed-session.js';
import { managedPiSocketPeerPid } from './managed-pi-repair-stop.js';
import type { CommandRunner } from './collab-notify.js';

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface ManagedPiNativeObservation {
  readonly descriptorFile: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly paneId: string;
  readonly name: string;
  readonly pid: number;
  readonly provider: string;
  readonly model: string;
  readonly provenance: 'owned-pi-sdk-control';
}

/** Fresh authenticated SDK facts plus OS/pane ownership; never infer native identity from a title. */
export async function observeOwnedManagedPi(
  descriptorFile: string,
  expected: {
    readonly sessionId: string;
    readonly cwd: string;
    readonly paneId: string;
    readonly name?: string;
    readonly pid?: number;
    readonly runId?: string;
    readonly taskRoot?: string;
    readonly bootstrapDigest?: string;
    readonly initialAdmissionDigest?: string;
  },
  deps: {
    readonly run: CommandRunner;
    readonly control?: typeof requestManagedPiControl;
    readonly peerPid?: typeof managedPiSocketPeerPid;
  },
): Promise<ManagedPiNativeObservation | null> {
  try {
    const stat = fs.lstatSync(descriptorFile);
    const bytes = readBoundedFile(descriptorFile, 4096);
    if (!bytes.ok || (stat.mode & 0o077) !== 0 || stat.isSymbolicLink())
      return null;
    const descriptor: unknown = JSON.parse(bytes.text);
    if (
      !object(descriptor) ||
      descriptor.sessionId !== expected.sessionId ||
      typeof descriptor.socketPath !== 'string' ||
      typeof descriptor.runId !== 'string' ||
      (expected.runId !== undefined && descriptor.runId !== expected.runId)
    )
      return null;
    const peer = (deps.peerPid ?? managedPiSocketPeerPid)(
      descriptor.socketPath,
    );
    if (peer === null || (expected.pid !== undefined && peer !== expected.pid))
      return null;
    const response = await (deps.control ?? requestManagedPiControl)(
      descriptorFile,
      'snapshot',
    );
    if (
      response.ok !== true ||
      !object(response.snapshot) ||
      !object(response.snapshot.session) ||
      !object(response.snapshot.process) ||
      !object(response.automation) ||
      !object(response.automation.launch)
    )
      return null;
    const launch = response.automation.launch;
    const scope = response.automation.execution_scope;
    if (
      expected.taskRoot &&
      !(
        object(scope) &&
        scope.task_root === expected.taskRoot &&
        scope.session_id === expected.sessionId
      ) &&
      !(
        launch.bootstrap_task_root === expected.taskRoot &&
        expected.bootstrapDigest !== undefined &&
        launch.bootstrap_config_digest === expected.bootstrapDigest
      ) &&
      !(
        launch.initial_task_root === expected.taskRoot &&
        expected.initialAdmissionDigest !== undefined &&
        launch.initial_admission_digest === expected.initialAdmissionDigest
      )
    )
      return null;
    if (
      launch.ready !== true ||
      launch.runtime !== 'sdk' ||
      launch.session_id !== expected.sessionId ||
      response.snapshot.session.sessionId !== expected.sessionId ||
      response.snapshot.process.pid !== peer ||
      launch.controller_run_id !== descriptor.runId ||
      launch.cwd !== expected.cwd ||
      launch.herdr_pane_id !== expected.paneId ||
      typeof launch.herdr_agent_name !== 'string' ||
      (expected.name !== undefined &&
        launch.herdr_agent_name !== expected.name) ||
      !object(launch.model) ||
      launch.model.provider !== 'openrouter' ||
      typeof launch.model.id !== 'string'
    )
      return null;
    const observed = await deps.run(
      'herdr',
      ['pane', 'process-info', '--pane', expected.paneId],
      5000,
    );
    if (!observed.spawned || observed.code !== 0 || observed.timedOut)
      return null;
    const parsed: unknown = JSON.parse(observed.stdout);
    const info =
      object(parsed) && object(parsed.result)
        ? parsed.result.process_info
        : null;
    if (
      !object(info) ||
      info.pane_id !== expected.paneId ||
      !Array.isArray(info.foreground_processes) ||
      !info.foreground_processes.some(
        (row: unknown) => object(row) && row.pid === peer,
      )
    )
      return null;
    const current = readBoundedFile(descriptorFile, 4096);
    if (!current.ok || current.digest !== bytes.digest) return null;
    return {
      descriptorFile,
      sessionId: expected.sessionId,
      cwd: expected.cwd,
      paneId: expected.paneId,
      name: launch.herdr_agent_name,
      pid: peer,
      provider: 'openrouter',
      model: launch.model.id,
      provenance: 'owned-pi-sdk-control',
    };
  } catch {
    return null;
  }
}

/** Resolve only task-registered runtimes or this task's reserved managed launch. */
export async function resolveTaskManagedPi(
  taskRoot: string,
  pane: {
    readonly paneId: string | null;
    readonly cwd: string | null;
    readonly name?: string | null;
  },
  deps: Parameters<typeof observeOwnedManagedPi>[2],
): Promise<ManagedPiNativeObservation | null> {
  if (!pane.paneId || !pane.cwd) return null;
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok || (await assertTaskStoreCurrent(opened.value))) return null;
  const candidates: Array<{
    file: string;
    sessionId: string;
    pid?: number;
    runId?: string;
    bootstrapDigest?: string;
    initialAdmissionDigest?: string;
  }> = [];
  const initialLaunches = opened.value.record.managed_pi_initial_launches;
  if (Array.isArray(initialLaunches) && initialLaunches.length <= 64) {
    for (const row of initialLaunches) {
      if (
        !object(row) ||
        row.schema !== 'pappra/managed-pi-initial-launch/1' ||
        row.pane_id !== pane.paneId ||
        typeof row.descriptor_file !== 'string' ||
        typeof row.session_id !== 'string' ||
        typeof row.pid !== 'number' ||
        typeof row.controller_run_id !== 'string' ||
        typeof row.admission_digest !== 'string'
      )
        continue;
      candidates.push({
        file: row.descriptor_file,
        sessionId: row.session_id,
        pid: row.pid,
        runId: row.controller_run_id,
        initialAdmissionDigest: row.admission_digest,
      });
    }
  }
  const registry: unknown = opened.value.record.managed_pi_runtime_registry;
  if (Array.isArray(registry) && registry.length <= 64) {
    for (const row of registry) {
      if (
        !object(row) ||
        (row.pane_id != null && row.pane_id !== pane.paneId) ||
        typeof row.descriptor_file !== 'string' ||
        typeof row.session_id !== 'string' ||
        typeof row.pid !== 'number' ||
        typeof row.controller_run_id !== 'string'
      )
        continue;
      candidates.push({
        file: row.descriptor_file,
        sessionId: row.session_id,
        pid: row.pid,
        runId: row.controller_run_id,
      });
    }
  }
  for (const row of opened.value.record.launch_reservations ?? []) {
    const bootstrap: unknown = (row as unknown as Record<string, unknown>)
      .bootstrap;
    if (
      !object(bootstrap) ||
      typeof bootstrap.request_file !== 'string' ||
      typeof bootstrap.request_digest !== 'string'
    )
      continue;
    const requestBytes = readBoundedFile(bootstrap.request_file, 64 * 1024);
    if (!requestBytes.ok || requestBytes.digest !== bootstrap.request_digest)
      continue;
    let request: unknown;
    try {
      request = JSON.parse(requestBytes.text);
    } catch {
      continue;
    }
    if (
      !object(request) ||
      request.task_root !== taskRoot ||
      !object(request.managed_runtime) ||
      !object(request.participant) ||
      typeof request.participant.native_session_selector !== 'string' ||
      typeof request.managed_runtime.journal_path !== 'string' ||
      !object(request.bootstrap) ||
      typeof request.bootstrap.config_digest !== 'string' ||
      (pane.name !== undefined &&
        pane.name !== null &&
        bootstrap.herdr_agent !== pane.name)
    )
      continue;
    candidates.push({
      file: `${request.managed_runtime.journal_path}.control.json`,
      sessionId: request.participant.native_session_selector,
      bootstrapDigest: request.bootstrap.config_digest,
    });
  }
  const found = new Map<string, ManagedPiNativeObservation>();
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate.file)) continue;
    const observed = await observeOwnedManagedPi(
      candidate.file,
      {
        ...candidate,
        cwd: pane.cwd,
        paneId: pane.paneId,
        taskRoot,
        ...(pane.name ? { name: pane.name } : {}),
      },
      deps,
    );
    if (observed) found.set(observed.sessionId, observed);
  }
  if (found.size !== 1 || (await assertTaskStoreCurrent(opened.value)))
    return null;
  return [...found.values()][0] ?? null;
}
