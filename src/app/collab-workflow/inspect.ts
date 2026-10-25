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
export async function inspectWorkflow(
  taskRoot: string,
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
    warnings: manifestRead.ok
      ? []
      : ['No sealed workflow manifest is present for this task.'],
    detail: {
      manifest: manifestRead.ok
        ? { ref: manifestFile, digest: digestFile(manifestFile) }
        : null,
      binding: bindingRead.ok
        ? { ref: bindingFile, digest: digestFile(bindingFile) }
        : null,
      input_revision: record.input_revision,
      coordinator: record.coordinator,
      attempts: (record.attempts ?? []).map((attempt) => ({
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
      deferred,
      open_uncertainty: (record.uncertainty ?? [])
        .filter((item) => item.resolved_at === null)
        .map((item) => ({
          uncertainty_id: item.uncertainty_id,
          kind: item.kind,
          subtask_id: item.subtask_id,
          attempt: item.attempt,
        })),
      messages: (record.messages ?? []).map((message) => ({
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
