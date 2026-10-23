import { checkOwnerEpoch } from '../collab/lifecycle.js';
import { activeClaims } from '../collab/resources.js';
import { doctor, readLock } from '../collab/store.js';
import {
  openTaskStore,
  type TaskStoreFailure,
  type TaskStoreResult,
} from './collab-task-store.js';

export const COLLAB_STATE_SCHEMA = 'pappra/collaboration-state/1';
const MAX_COLLECTION_ROWS = 50;

export type StateAction = 'show' | 'doctor' | 'epoch-check';

function limitRows<T>(items: readonly T[]): {
  readonly rows: T[];
  readonly total: number;
  readonly truncated: boolean;
} {
  return {
    rows: items.slice(0, MAX_COLLECTION_ROWS),
    total: items.length,
    truncated: items.length > MAX_COLLECTION_ROWS,
  };
}

function lockSummary(taskRoot: string) {
  const lock = readLock(taskRoot);
  return {
    held: lock.held,
    holder: lock.held ? lock.holder : null,
    holder_process_alive: lock.held ? lock.holder_process_alive : false,
    transaction_count: lock.transaction_files?.length ?? 0,
  };
}

export async function showTaskState(
  taskRoot: string,
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok) return opened;
  const { record, taskRoot: canonical } = opened.value;
  const attempts = limitRows(
    (record.attempts ?? []).map((item) => ({
      subtask_id: item.subtask_id,
      attempt: item.attempt,
      state: item.state,
      ownership: item.ownership ?? null,
      native: item.native,
    })),
  );
  const claims = limitRows(activeClaims(record));
  const handoffs = limitRows(
    (record.handoffs ?? []).map((item) => ({
      handoff_id: item.handoff_id,
      kind: item.kind,
      state: item.state,
    })),
  );
  const uncertainty = limitRows(
    (record.uncertainty ?? [])
      .filter((item) => !item.resolved_at)
      .map((item) => ({
        uncertainty_id: item.uncertainty_id,
        kind: item.kind,
        subtask_id: item.subtask_id,
        attempt: item.attempt,
        detail: item.detail,
      })),
  );
  const results = limitRows(
    (record.results ?? []).map((item) => ({
      subtask_id: item.subtask_id,
      attempt: item.attempt,
      status: item.status,
      classification: item.classification,
      message_id: item.message_id,
    })),
  );
  const lock = lockSummary(canonical);
  return {
    ok: true,
    value: {
      schema: COLLAB_STATE_SCHEMA,
      ok: true,
      action: 'show',
      task_root: canonical,
      task_id: record.task_id,
      state_revision: record.state_revision,
      coordinator: record.coordinator ?? null,
      dispatch_frozen: record.dispatch_frozen === true,
      attempts: attempts.rows,
      messages: (record.messages ?? []).length,
      claims: claims.rows,
      handoffs: handoffs.rows,
      open_uncertainty: uncertainty.rows,
      results: results.rows,
      lock,
      counts: {
        attempts: attempts.total,
        messages: (record.messages ?? []).length,
        claims: claims.total,
        handoffs: handoffs.total,
        open_uncertainty: uncertainty.total,
        results: results.total,
      },
      truncated: {
        attempts: attempts.truncated,
        claims: claims.truncated,
        handoffs: handoffs.truncated,
        open_uncertainty: uncertainty.truncated,
        results: results.truncated,
      },
      limits: ['reported_state_only', 'native_execution_not_queried'],
    },
  };
}

export async function doctorTaskState(
  taskRoot: string,
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok) return opened;
  const { taskRoot: canonical } = opened.value;
  let report: ReturnType<typeof doctor>;
  try {
    report = doctor(canonical);
  } catch {
    return {
      ok: false,
      code: 'task_state_unreadable',
      message: 'The task state could not be diagnosed.',
      nextAction:
        'Inspect the task record, lock and transaction paths; nothing was repaired.',
    };
  }
  const findings = limitRows(report.findings);
  const blocking = report.findings.filter(
    (finding) => finding.severity === 'invalid',
  ).length;
  const uncertain = report.findings.filter(
    (finding) => finding.severity === 'uncertain',
  ).length;
  const active = report.findings.filter(
    (finding) => finding.severity === 'active',
  ).length;
  return {
    ok: true,
    value: {
      schema: COLLAB_STATE_SCHEMA,
      // A live lock observation is diagnostic but not a readiness failure.
      // Unresolved uncertain evidence and invalid layout/records need input.
      ok: blocking === 0 && uncertain === 0,
      action: 'doctor',
      task_root: report.task_root,
      state_revision: report.state_revision,
      findings: findings.rows,
      counts: { findings: findings.total, blocking, uncertain, active },
      truncated: findings.truncated,
      lock: lockSummary(canonical),
      limits: ['diagnostic_only', 'no_repair_or_lock_break'],
    },
  };
}

export async function checkTaskEpoch(
  taskRoot: string,
  ownerEpoch: number,
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok) return opened;
  const { record, taskRoot: canonical } = opened.value;
  const result = checkOwnerEpoch(record, ownerEpoch);
  const subtasks = limitRows(
    (record.attempts ?? []).map((item) => ({
      subtask_id: item.subtask_id,
      attempt: item.attempt,
      state: item.state,
    })),
  );
  return {
    ok: true,
    value: {
      schema: COLLAB_STATE_SCHEMA,
      ok: result.ok,
      action: 'epoch-check',
      task_root: canonical,
      owner_epoch: result.ok ? result.owner_epoch : null,
      expected: record.coordinator?.owner_epoch ?? null,
      actual: ownerEpoch,
      reason: result.ok ? null : result.reason,
      subtasks: subtasks.rows,
      counts: { subtasks: subtasks.total },
      truncated: subtasks.truncated,
      limits: ['reported_epoch_only', 'no_authority_transition'],
    },
  };
}

export type { TaskStoreFailure };
