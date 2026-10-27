import type { WorkflowReclaimRequest } from '../../schemas/collab-workflow.js';
import {
  reclaimOwnedPanes,
  type PaneReclaimEntry,
  type PaneReclaimOptions,
} from '../collab-pane-reclaim.js';
import { openWorkflowTask, sameCoordinator } from './context.js';
import {
  emptyResult,
  type WorkflowBlocker,
  type WorkflowResult,
} from './types.js';

/**
 * Coordinator sweep of Pappra-created panes whose work is accepted and released.
 *
 * The request names no pane. Eligibility is derived from the task record and re-checked
 * against the live pane by `reclaimOwnedPanes`; a plan is read-only.
 */
export async function applyReclaim(
  request: WorkflowReclaimRequest,
  options: {
    readonly clock?: number;
    readonly apply?: boolean;
    readonly ops?: PaneReclaimOptions['ops'];
  } = {},
): Promise<WorkflowResult<{ pane_reclaim: readonly PaneReclaimEntry[] }>> {
  type Detail = { pane_reclaim: readonly PaneReclaimEntry[] };
  const writing = options.apply !== false;
  const base = emptyResult<Detail>('reclaim', writing);
  const opened = await openWorkflowTask(request.task_root);
  if (!opened.ok)
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
  const task = opened.value;
  const record = task.record;
  const blockers: WorkflowBlocker[] = [];
  if (!sameCoordinator(record.coordinator, request.caller))
    blockers.push({
      code: 'reclaim_not_coordinator',
      detail: 'Only the current coordinator identity may reclaim panes.',
      next_action: 'Reclaim comes from the coordinator, never from a worker.',
    });
  const common = {
    ...base,
    task_id: record.task_id,
    task_root: task.taskRoot,
    domain_root: record.domain_root,
    state_revision: record.state_revision,
    principal: { ...request.caller, role: 'coordinator' as const },
  };
  if (blockers.length > 0)
    return {
      ...common,
      status: 'refused',
      blockers,
      next_action: blockers[0]!.next_action,
    };
  const entries = await reclaimOwnedPanes({
    taskRoot: task.taskRoot,
    apply: writing,
    callerPane: request.caller_pane,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.ops === undefined ? {} : { ops: options.ops }),
  });
  const failed = entries.some(
    (entry) =>
      entry.state === 'unknown_not_closed' || entry.state === 'close_failed',
  );
  return {
    ...common,
    status: failed ? 'needs-reconciliation' : writing ? 'applied' : 'planned',
    ok: !failed,
    warnings: entries
      .filter((entry) => entry.state === 'skipped')
      .map(
        (entry) =>
          `${entry.subtask_id}#${entry.attempt} ${entry.pane_id ?? ''} kept: ${entry.code}`,
      ),
    next_action: failed
      ? 'Reconcile the listed pane against Herdr; an ambiguous close is never retried automatically.'
      : null,
    detail: { pane_reclaim: entries },
  };
}
