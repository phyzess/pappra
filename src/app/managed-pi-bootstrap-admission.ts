import fs from 'node:fs';
import { createLocalTaskRecordReader } from '../hosts/integration/pi-bootstrap-runtime.js';
import { decideBootstrapWrite } from '../hosts/integration/pi-bootstrap-guard.js';
import type { PiBootstrapConfig } from '../hosts/integration/bootstrap-config.js';
import type { ManagedPiSdkSessionController } from '../hosts/pi/managed-sdk-session.js';
import {
  bindManagedPiExecutionScope,
  type BoundManagedPiExecutionScope,
} from './managed-pi-transition-host.js';
import type { ManagedPiExecutionScope } from './collab-session-transition.js';

/** A receiver is controller-owned at launch, but task ownership binds only after the real transfer. */
export async function watchManagedPiBootstrapAdmission(
  controller: ManagedPiSdkSessionController,
  config: PiBootstrapConfig,
  onBound: (binding: BoundManagedPiExecutionScope) => Promise<void>,
) {
  const reader = createLocalTaskRecordReader(config.domainRoot, config.taskId);
  const taskRoot = reader.read().task_root;
  let closed = false;
  let pending = false;
  let active: Promise<void> | null = null;
  let binding: BoundManagedPiExecutionScope | null = null;
  let state: 'awaiting_transfer' | 'awaiting_idle' | 'bound' | 'unavailable' =
    'awaiting_transfer';
  let error: string | null = null;
  const refresh = (): Promise<void> => {
    if (closed || binding) return active ?? Promise.resolve();
    pending = true;
    if (active) return active;
    active = (async () => {
      try {
        while (pending && !closed && !binding) {
          pending = false;
          const native = controller.observe();
          const record = reader.read();
          if (
            !decideBootstrapWrite(record, config.guard, native.native.sessionId)
              .allow
          ) {
            state = 'awaiting_transfer';
            continue;
          }
          const inventory = await controller.inventory();
          if (
            inventory.completeness !== 'complete' ||
            inventory.inflight.length ||
            inventory.pending_approvals.length ||
            inventory.pending_messages?.length !== 0
          ) {
            state = 'awaiting_idle';
            continue;
          }
          const scope: ManagedPiExecutionScope = {
            schema: 'pappra/managed-pi-execution-scope/1',
            task_id: config.taskId,
            task_root: taskRoot,
            session_id: native.native.sessionId,
            cwd: native.cwd,
            subtask_id: config.guard.subtaskId,
            attempt: config.guard.attempt,
            owner_epoch: config.guard.coordinatorEpoch,
            claim_epochs: config.guard.claims.map((claim) => ({
              claim_id: claim.claimId,
              resource_epoch: claim.originalResourceEpoch + 1,
            })),
          };
          const candidate = await bindManagedPiExecutionScope({
            controller,
            scope,
          });
          await onBound(candidate);
          binding = candidate;
          state = 'bound';
          error = null;
        }
      } catch (cause) {
        state = 'unavailable';
        error =
          cause instanceof Error
            ? cause.message
            : 'managed_bootstrap_admission_unavailable';
      }
    })().finally(() => {
      active = null;
    });
    return active;
  };
  const watcher = fs.watch(taskRoot, (_event, name) => {
    if (name === null || name.toString() === 'task.json') void refresh();
  });
  watcher.on('error', () => {
    state = 'unavailable';
    error = 'managed_bootstrap_watch_failed';
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
    status: () => ({ state, error, scope: binding?.scope ?? null }),
    async close() {
      closed = true;
      watcher.close();
      unsubscribe();
      await active;
    },
  };
}
