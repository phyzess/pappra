import { readBoundedJson, digestFile, openWorkflowTask } from './context.js';
import {
  workflowManifestPath,
  workflowBindingPath,
} from '../../schemas/collab-workflow.js';
import { emptyResult, type WorkflowResult } from './types.js';
import { findAttempt } from '../../collab/lifecycle.js';

/**
 * Read-only workflow inspection.
 *
 * Everything reported here is read from the task record and the sealed workflow documents.
 * Missing observations stay missing: an absent manifest or binding is reported as absent
 * rather than reconstructed from the request that once produced it.
 */
export interface InspectOptions {
  /** Caps each projected list, keeping its last entries in record order. Omitted means unbounded. */
  readonly limit?: number;
}

/** Keeps the last `limit` entries and reports what was dropped, never silently. */
function bound<T>(
  items: readonly T[],
  limit: number | undefined,
): { items: T[]; total: number; truncated: boolean } {
  const total = items.length;
  if (limit === undefined || total <= limit)
    return { items: [...items], total, truncated: false };
  return { items: items.slice(total - limit), total, truncated: true };
}

export async function inspectWorkflow(
  taskRoot: string,
  options: InspectOptions = {},
): Promise<WorkflowResult<Record<string, unknown>>> {
  const opened = await openWorkflowTask(taskRoot);
  if (!opened.ok) {
    const base = emptyResult<Record<string, unknown>>('inspect', false);
    return {
      ...base,
      status: 'invalid',
      blockers: [
        {
          code: opened.code,
          detail: opened.message,
          next_action: opened.nextAction,
        },
      ],
      next_action: opened.nextAction,
    };
  }
  const task = opened.value;
  const record = task.record;
  const manifestFile = workflowManifestPath(task.taskRoot);
  const manifestRead = readBoundedJson(manifestFile, 'workflow manifest');
  const bindingFile = workflowBindingPath(task.taskRoot);
  const bindingRead = readBoundedJson(bindingFile, 'task binding');
  const deferred: { subtask_id: string; role: string }[] = [];
  if (manifestRead.ok) {
    const value = manifestRead.value as {
      assignments?: {
        subtask_id?: string;
        role?: string;
        attempt?: number;
        deferred?: boolean;
      }[];
    };
    for (const item of value.assignments ?? []) {
      if (item.deferred !== true) continue;
      const subtask = String(item.subtask_id ?? '');
      const attempt = Number(item.attempt ?? 1);
      // The manifest is immutable, so reconcile it with reality: a reviewer that already
      // has a registered attempt is activated or finished, not still deferred.
      if (findAttempt(record, subtask, attempt) !== null) continue;
      deferred.push({
        subtask_id: subtask,
        role: String(item.role ?? 'reviewer'),
      });
    }
  }
  const limit = options.limit;
  const attempts = bound(record.attempts ?? [], limit);
  const messages = bound(record.messages ?? [], limit);
  const uncertainty = bound(
    (record.uncertainty ?? []).filter((item) => item.resolved_at === null),
    limit,
  );
  const deferredBounded = bound(deferred, limit);
  const attemptStates: Record<string, number> = {};
  for (const attempt of record.attempts ?? [])
    attemptStates[attempt.state] = (attemptStates[attempt.state] ?? 0) + 1;
  // The human output never prints `detail`, so a cut list is also said in a warning.
  const truncationNotes = (
    [
      ['attempts', attempts],
      ['messages', messages],
      ['open_uncertainty', uncertainty],
      ['deferred', deferredBounded],
    ] as const
  )
    .filter(([, list]) => list.truncated)
    .map(
      ([name, list]) =>
        `${name}: showing ${String(list.items.length)} of ${String(list.total)} (--limit ${String(limit)}); not the full list.`,
    );
  const base = emptyResult<Record<string, unknown>>('inspect', false);
  // Inspect is a read-only projection: with no sealed manifest there is no cohort to
  // report, so the honest result is blocked (with the reason in warnings), not "applied".
  const sealed = manifestRead.ok;
  return {
    ...base,
    status: sealed ? 'applied' : 'blocked',
    ok: sealed,
    task_id: record.task_id,
    task_root: task.taskRoot,
    domain_root: record.domain_root,
    state_revision: record.state_revision,
    next_action: sealed
      ? null
      : 'Seal the cohort with pappra collab workflow prepare --request <file> --apply, then inspect again.',
    warnings: [
      ...(manifestRead.ok
        ? []
        : ['No sealed workflow manifest is present for this task.']),
      ...truncationNotes,
    ],
    detail: {
      manifest: manifestRead.ok
        ? { ref: manifestFile, digest: digestFile(manifestFile) }
        : null,
      binding: bindingRead.ok
        ? { ref: bindingFile, digest: digestFile(bindingFile) }
        : null,
      input_revision: record.input_revision,
      coordinator: record.coordinator,
      limit: limit ?? null,
      totals: {
        attempts: attempts.total,
        messages: messages.total,
        open_uncertainty: uncertainty.total,
        deferred: deferredBounded.total,
        attempt_states: attemptStates,
      },
      truncated: {
        attempts: attempts.truncated,
        messages: messages.truncated,
        open_uncertainty: uncertainty.truncated,
        deferred: deferredBounded.truncated,
      },
      attempts: attempts.items.map((attempt) => ({
        subtask_id: attempt.subtask_id,
        attempt: attempt.attempt,
        state: attempt.state,
        assignee: attempt.assignee,
        assignment_message_id: attempt.assignment_message_id,
        assignment_digest: attempt.assignment_digest,
        native_observation: attempt.native?.observation ?? 'unknown',
        active_claims: (record.claims ?? []).filter(
          (claim) =>
            claim.released_at === null &&
            claim.subtask_id === attempt.subtask_id &&
            claim.attempt === attempt.attempt,
        ).length,
        result:
          (record.results ?? []).find(
            (item) =>
              item.subtask_id === attempt.subtask_id &&
              item.attempt === attempt.attempt &&
              item.classification === 'applied',
          )?.status ?? null,
      })),
      deferred: deferredBounded.items,
      open_uncertainty: uncertainty.items.map((item) => ({
        uncertainty_id: item.uncertainty_id,
        kind: item.kind,
        subtask_id: item.subtask_id,
        attempt: item.attempt,
      })),
      messages: messages.items.map((message) => ({
        message_id: message.message_id,
        type: message.type,
        state: message.state,
        subtask_id: message.subtask_id,
        attempt: message.attempt,
        content_digest: message.content_digest,
      })),
    },
  };
}
