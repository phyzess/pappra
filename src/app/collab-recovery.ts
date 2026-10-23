import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  collaborationRecoveryRequestSchema,
  type CollaborationRecoveryRequest,
} from '../schemas/collaboration.js';
import {
  checkOwnerEpoch,
  resolveUncertainty,
  transitionAttempt,
} from '../collab/lifecycle.js';
import { breakLock, lockPath, readLock, transact } from '../collab/store.js';
import type { Uncertainty } from '../collab/types.js';
import {
  assertTaskStoreCurrent,
  openTaskStore,
  type TaskStoreFailure,
  type TaskStoreResult,
} from './collab-task-store.js';
import { readBoundedFile } from './bounded-file.js';

export const COLLAB_RECOVERY_SCHEMA = 'pappra/collaboration-recovery/1';
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_ROWS = 50;
const MAX_LOCK_ENTRIES = 256;
const MAX_LOCK_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LOCK_TOTAL_BYTES = 16 * 1024 * 1024;

export type RecoveryAction = 'inspect' | 'reconcile' | 'lock-break';

export interface LoadedRecoveryRequest {
  readonly request: CollaborationRecoveryRequest;
  readonly path: string;
}

export interface LockSnapshot {
  readonly status: 'available' | 'unavailable';
  readonly fingerprint: string | null;
  readonly entries: number;
  readonly bytes: number;
  readonly reason: string | null;
}

function invalidRequest(message: string, nextAction: string): TaskStoreFailure {
  return {
    ok: false,
    code: 'invalid_request',
    message,
    nextAction,
  };
}

export function loadRecoveryRequest(
  file: string,
  expectedAction: 'reconcile' | 'lock-break',
): TaskStoreResult<LoadedRecoveryRequest> {
  if (!path.isAbsolute(file)) {
    return invalidRequest(
      'Recovery request path must be absolute.',
      'Pass an absolute request JSON path.',
    );
  }
  const read = readBoundedFile(file, MAX_REQUEST_BYTES);
  if (!read.ok) {
    return invalidRequest(
      'Recovery request must be a readable regular JSON file no larger than 1 MiB.',
      'Inspect the request path and file kind; nothing was written.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return invalidRequest(
      'Recovery request is not valid JSON.',
      'Rewrite the request as strict JSON; nothing was written.',
    );
  }
  const validated = collaborationRecoveryRequestSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .slice(0, 8)
      .map((issue) => {
        const field = issue.path.length ? issue.path.join('.') : '(root)';
        return `${field}:${issue.code}`;
      })
      .join(', ');
    return invalidRequest(
      `Recovery request does not match the strict schema (${issues || 'invalid shape'}).`,
      'Fix the request schema; nothing was written.',
    );
  }
  if (validated.data.action !== expectedAction) {
    return invalidRequest(
      'Recovery request action does not match the invoked recovery command.',
      `Use a ${expectedAction} request; nothing was written.`,
    );
  }
  return { ok: true, value: { request: validated.data, path: file } };
}

function fingerprintOf(entries: readonly { name: string; digest: string }[]) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        schema: 'pappra/task-lock-fingerprint/1',
        entries: [...entries].sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        ),
      }),
    )
    .digest('hex')}`;
}

/**
 * Stable content fingerprint of the task write-lock directory. It hashes only
 * names and bounded regular-file bytes; PID liveness is an inspection
 * observation and is not part of the content identity.
 */
export function taskLockFingerprint(taskRoot: string): LockSnapshot {
  const directory = lockPath(taskRoot);
  let names: string[];
  try {
    names = fs.readdirSync(directory).sort();
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : null;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return {
        status: 'available',
        fingerprint: fingerprintOf([]),
        entries: 0,
        bytes: 0,
        reason: null,
      };
    return {
      status: 'unavailable',
      fingerprint: null,
      entries: 0,
      bytes: 0,
      reason: 'lock_snapshot_unreadable',
    };
  }
  if (names.length > MAX_LOCK_ENTRIES)
    return {
      status: 'unavailable',
      fingerprint: null,
      entries: names.length,
      bytes: 0,
      reason: 'lock_snapshot_entry_limit',
    };
  const entries: { name: string; digest: string }[] = [];
  let bytes = 0;
  for (const name of names) {
    const read = readBoundedFile(
      path.join(directory, name),
      MAX_LOCK_FILE_BYTES,
    );
    if (!read.ok)
      return {
        status: 'unavailable',
        fingerprint: null,
        entries: names.length,
        bytes,
        reason: 'lock_snapshot_file_unsafe',
      };
    bytes += read.bytes.length;
    if (bytes > MAX_LOCK_TOTAL_BYTES)
      return {
        status: 'unavailable',
        fingerprint: null,
        entries: names.length,
        bytes,
        reason: 'lock_snapshot_size_limit',
      };
    entries.push({ name, digest: read.digest });
  }
  return {
    status: 'available',
    fingerprint: fingerprintOf(entries),
    entries: entries.length,
    bytes,
    reason: null,
  };
}

function bounded<T>(items: readonly T[]) {
  return {
    rows: items.slice(0, MAX_ROWS),
    total: items.length,
    omitted: Math.max(0, items.length - MAX_ROWS),
    truncated: items.length > MAX_ROWS,
  };
}

function uncertaintySummary(entry: Uncertainty) {
  return {
    uncertainty_id: entry.uncertainty_id,
    kind: entry.kind,
    subtask_id: entry.subtask_id,
    attempt: entry.attempt,
    opened_at: entry.opened_at,
    resolved_at: entry.resolved_at,
    resolved_by: entry.resolved_by ?? null,
    resolution_recorded: entry.resolved_at !== null,
  };
}

export async function inspectRecovery(
  taskRoot: string,
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok) return opened;
  const record = opened.value.record;
  const lock = readLock(opened.value.taskRoot);
  const snapshot = taskLockFingerprint(opened.value.taskRoot);
  const allUncertainty = record.uncertainty ?? [];
  const open = bounded(allUncertainty.filter((entry) => !entry.resolved_at));
  const resolved = bounded(
    allUncertainty.filter((entry) => entry.resolved_at !== null),
  );
  const transactionCount = lock.transaction_files?.length ?? 0;
  const needsInput =
    open.total > 0 ||
    transactionCount > 0 ||
    snapshot.status === 'unavailable' ||
    (lock.held && lock.holder_process_alive === false);
  return {
    ok: true,
    value: {
      schema: COLLAB_RECOVERY_SCHEMA,
      ok: !needsInput,
      status: needsInput ? 'needs_input' : 'ready',
      action: 'inspect',
      task_root: opened.value.taskRoot,
      task_id: record.task_id,
      state_revision: record.state_revision,
      coordinator_epoch: record.coordinator?.owner_epoch ?? null,
      uncertainty: {
        open: open.rows.map(uncertaintySummary),
        resolved: resolved.rows.map(uncertaintySummary),
        counts: { open: open.total, resolved: resolved.total },
        omitted: {
          open: open.omitted,
          resolved: resolved.omitted,
        },
        truncated: open.truncated || resolved.truncated,
      },
      lock: {
        held: lock.held,
        holder: lock.held ? lock.holder : null,
        // Liveness is an observation only; it is not native ownership proof.
        holder_process_alive: lock.held ? lock.holder_process_alive : false,
        transaction_count: transactionCount,
        transaction_files:
          transactionCount > 0
            ? (lock.transaction_files ?? [])
                .slice(0, MAX_ROWS)
                .map((file) => path.basename(file))
            : [],
        transaction_truncated: transactionCount > MAX_ROWS,
        fingerprint: snapshot.fingerprint,
        fingerprint_status: snapshot.status,
        fingerprint_reason: snapshot.reason,
        entries: snapshot.entries,
        bytes: snapshot.bytes,
      },
      limits: [
        'stored_state_only',
        'pid_liveness_is_not_stop_proof',
        'no_native_query',
        `lock_snapshot_max_entries=${MAX_LOCK_ENTRIES}`,
        `lock_snapshot_max_bytes=${MAX_LOCK_TOTAL_BYTES}`,
      ],
    },
  };
}

function requestSummary(request: CollaborationRecoveryRequest) {
  if (request.action === 'reconcile')
    return {
      action: request.action,
      actor: request.actor,
      owner_epoch: request.owner_epoch,
      uncertainty_id: request.uncertainty_id,
      set_state: request.set_state ?? null,
      ...(request.expect_revision === undefined
        ? {}
        : { expect_revision: request.expect_revision }),
    };
  return {
    action: request.action,
    actor: request.actor,
    owner_epoch: request.owner_epoch,
    expected_lock_fingerprint: request.expected_lock_fingerprint,
  };
}

export async function planRecovery(
  taskRoot: string,
  request: CollaborationRecoveryRequest,
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok) return opened;
  return {
    ok: true,
    value: {
      schema: COLLAB_RECOVERY_SCHEMA,
      ok: true,
      status: 'planned',
      action: request.action,
      applied: false,
      task_root: opened.value.taskRoot,
      task_id: opened.value.record.task_id,
      request: requestSummary(request),
      limits: ['plan_validates_request_and_namespace_only', 'no_reservation'],
    },
  };
}

export async function applyRecovery(
  taskRoot: string,
  request: CollaborationRecoveryRequest,
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok) return opened;
  const changed = await assertTaskStoreCurrent(opened.value);
  if (changed) return changed;

  if (request.action === 'lock-break') {
    const epoch = checkOwnerEpoch(opened.value.record, request.owner_epoch);
    if (!epoch.ok)
      return {
        ok: false,
        code: 'stale_epoch',
        message: 'The task owner epoch does not match the recovery request.',
        nextAction: 'Inspect the task and use the current owner epoch.',
      };
    const snapshot = taskLockFingerprint(opened.value.taskRoot);
    if (snapshot.status !== 'available')
      return {
        ok: false,
        code: 'lock_fingerprint_unavailable',
        message:
          'The task lock content cannot be fingerprinted within the recovery limits.',
        nextAction:
          'Inspect the lock snapshot diagnostics; do not break it from this inspection.',
      };
    if (snapshot.fingerprint !== request.expected_lock_fingerprint)
      return {
        ok: false,
        code: 'lock_changed',
        message: 'The task lock no longer matches the inspected fingerprint.',
        nextAction:
          'Inspect the current lock again before making any recovery decision.',
      };
    const lock = readLock(opened.value.taskRoot);
    if (!lock.held)
      return {
        ok: false,
        code: 'no_lock',
        message: 'The task write lock is no longer held.',
        nextAction: 'Inspect the task; nothing was archived.',
      };
    try {
      const result = breakLock(opened.value.taskRoot, {
        actor: request.actor,
        reason: request.reason,
        confirmHolderStopped: true,
      });
      if (!result.broken)
        return {
          ok: false,
          code: 'no_lock',
          message: 'The task write lock was not held.',
          nextAction: 'Inspect the task; nothing was archived.',
        };
      const archive = result.record as {
        previous_holder: unknown;
        previous_holder_process_alive: boolean;
        uncommitted_transactions: string[];
      };
      return {
        ok: true,
        value: {
          schema: COLLAB_RECOVERY_SCHEMA,
          ok: true,
          status: 'broken',
          action: 'lock-break',
          applied: true,
          task_root: opened.value.taskRoot,
          task_id: opened.value.record.task_id,
          archived_lock: result.evidence,
          previous_holder: archive.previous_holder,
          previous_holder_process_alive: archive.previous_holder_process_alive,
          uncommitted_transactions: archive.uncommitted_transactions,
          limits: [
            'operator_stop_assertion_not_native_proof',
            'task_lock_only',
          ],
        },
      };
    } catch {
      return {
        ok: false,
        code: 'lock_break_uncertain',
        message:
          'The lock break may have archived the lock but could not be confirmed.',
        nextAction:
          'Inspect broken-locks and the task lock before retrying; do not assume success or failure.',
      };
    }
  }

  let outcome: Awaited<ReturnType<typeof transact>>;
  try {
    outcome = transact(opened.value.taskRoot, {
      actor: request.actor,
      purpose: 'reconcile',
      expectRevision: request.expect_revision,
      apply: (record) => {
        const epoch = checkOwnerEpoch(record, request.owner_epoch);
        if (!epoch.ok)
          return {
            ok: false as const,
            reason: 'stale_epoch',
            expected: epoch.expected,
            actual: epoch.actual,
          };
        const target = (record.uncertainty ?? []).find(
          (entry) => entry.uncertainty_id === request.uncertainty_id,
        );
        if (request.set_state && !target)
          return {
            ok: false as const,
            reason: 'unknown_uncertainty',
            uncertainty_id: request.uncertainty_id,
          };
        if (request.set_state && (!target?.subtask_id || !target?.attempt))
          return {
            ok: false as const,
            reason: 'transition_context_missing',
            detail:
              'set_state requires an uncertainty entry with subtask and attempt context',
          };
        const resolved = resolveUncertainty(record, {
          uncertaintyId: request.uncertainty_id,
          resolution: request.resolution,
          resolutionEvidence: request.resolution_evidence,
          actor: request.actor,
        });
        if (!resolved.ok) return resolved;
        let transition = null;
        if (request.set_state) {
          const changedState = transitionAttempt(record, {
            subtaskId: target!.subtask_id,
            attempt: target!.attempt,
            to: request.set_state,
            actor: request.actor,
            reason: `reconciled: ${request.resolution}`,
            evidence: request.resolution_evidence,
          });
          if (!changedState.ok) return changedState;
          transition = changedState;
        }
        return {
          record,
          op: 'reconcile',
          summary: {
            uncertainty_id: request.uncertainty_id,
            set_state: request.set_state ?? null,
          },
          result: {
            uncertainty_id: request.uncertainty_id,
            resolution_recorded: true,
            state_transition: transition?.state ?? null,
          },
        };
      },
    });
  } catch {
    return {
      ok: false,
      code: 'reconcile_uncertain',
      message:
        'The reconciliation may already be committed, but its transaction evidence could not be confirmed.',
      nextAction:
        'Inspect the task record and ledger before any explicit retry; do not assume the resolution or transition was unapplied.',
    };
  }
  const { state_revision, result, ...rest } = outcome;
  return {
    ok: true,
    value: {
      schema: COLLAB_RECOVERY_SCHEMA,
      ok: outcome.ok === true,
      status: outcome.ok === true ? 'applied' : 'refused',
      action: 'reconcile',
      applied: outcome.ok === true,
      task_root: opened.value.taskRoot,
      task_id: opened.value.record.task_id,
      ...(outcome.ok === true
        ? { state_revision, result: result ?? null }
        : rest),
      limits: ['recorded_resolution_not_native_proof'],
    },
  };
}
