import { createHash } from 'node:crypto';
import { canonicalJson } from '../collab/envelope.js';
import { transact } from '../collab/store.js';
import { ManagedPiSdkSessionController } from '../hosts/pi/managed-sdk-session.js';
import type { ManagedPiInitialAdmissionConfig } from './managed-pi-initial-admission.js';
import { openTaskStore, assertTaskStoreCurrent } from './collab-task-store.js';
import { readBoundedFile } from './bounded-file.js';

export const initialAdmissionDigest = (
  config: ManagedPiInitialAdmissionConfig,
) =>
  `sha256:${createHash('sha256').update(canonicalJson(config)).digest('hex')}`;

/** Discovery of an owned pending launch grants no attempt, resource, or execution authority. */
export async function registerManagedPiInitialLaunch(
  controller: ManagedPiSdkSessionController,
  config: ManagedPiInitialAdmissionConfig,
  descriptorFile: string,
) {
  const observed = controller.observe();
  const snapshot = controller.snapshot();
  if (
    !(controller instanceof ManagedPiSdkSessionController) ||
    controller.isDisposed ||
    snapshot.process.pid !== process.pid ||
    !observed.native.agentId ||
    !observed.native.paneId ||
    descriptorFile !== `${snapshot.ingress.journalPath}.control.json`
  )
    throw new Error('initial_launch_not_owned');
  const bytes = readBoundedFile(descriptorFile, 4096);
  if (!bytes.ok) throw new Error('initial_launch_control_unavailable');
  const descriptor = JSON.parse(bytes.text) as Record<string, unknown>;
  if (
    descriptor.sessionId !== observed.native.sessionId ||
    typeof descriptor.runId !== 'string'
  )
    throw new Error('initial_launch_control_mismatch');
  const opened = await openTaskStore(config.taskRoot);
  if (!opened.ok || (await assertTaskStoreCurrent(opened.value)))
    throw new Error('initial_launch_task_unavailable');
  const entry = {
    schema: 'pappra/managed-pi-initial-launch/1',
    session_id: observed.native.sessionId,
    agent_id: observed.native.agentId,
    pane_id: observed.native.paneId,
    pid: process.pid,
    descriptor_file: descriptorFile,
    controller_run_id: descriptor.runId,
    admission_digest: initialAdmissionDigest(config),
  };
  const saved = transact(config.taskRoot, {
    actor: observed.native.agentId,
    purpose: 'record-owned-initial-launch',
    apply(record) {
      if (
        record.task_id !== opened.value.record.task_id ||
        record.coordinator?.owner_epoch !== config.ownerEpoch
      )
        return { ok: false, reason: 'initial_launch_task_changed' };
      const rows = record.managed_pi_initial_launches ?? [];
      if (!Array.isArray(rows) || rows.length >= 64)
        return { ok: false, reason: 'initial_launch_registry_invalid' };
      const old = rows.find(
        (row: unknown) =>
          typeof row === 'object' &&
          row !== null &&
          'session_id' in row &&
          row.session_id === entry.session_id,
      );
      if (old && canonicalJson(old) !== canonicalJson(entry))
        return { ok: false, reason: 'initial_launch_conflict' };
      record.managed_pi_initial_launches = old ? rows : [...rows, entry];
      return { record, result: null };
    },
  });
  if (!saved.ok) throw new Error(saved.reason);
}
