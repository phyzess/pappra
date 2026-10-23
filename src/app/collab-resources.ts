import path from 'node:path';
import {
  collaborationResourceRequestSchema,
  type CollaborationResourceRequest,
} from '../schemas/collaboration.js';
import type { Identity, ResourceInput } from '../collab/types.js';
import {
  activeClaims,
  claimResources,
  DomainLockHeldError,
  listDomainRecords,
  releaseClaim,
} from '../collab/resources.js';
import { readBoundedFile } from './bounded-file.js';
import {
  assertTaskStoreCurrent,
  openTaskStore,
  validateDomainMutationPaths,
  validateDomainTaskState,
  type OpenedTaskStore,
  type TaskStoreFailure,
  type TaskStoreResult,
} from './collab-task-store.js';

export const COLLAB_RESOURCES_SCHEMA = 'pappra/collaboration-resources/1';
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESOURCE_TASKS = 100;
const MAX_RESOURCE_CLAIMS = 500;

export type ResourceAction = 'list' | 'claim' | 'release';

export interface LoadedResourceRequest {
  readonly request: CollaborationResourceRequest;
  readonly path: string;
}

function invalidRequest(message: string, nextAction: string): TaskStoreFailure {
  return {
    ok: false,
    code: 'invalid_request',
    message,
    nextAction,
  };
}

/**
 * Read and strictly validate one bounded resource request. Diagnostic text only
 * names field paths/codes and never echoes request body values.
 */
export function loadResourceRequest(
  file: string,
  expectedAction: 'claim' | 'release',
): TaskStoreResult<LoadedResourceRequest> {
  if (!path.isAbsolute(file)) {
    return invalidRequest(
      'Resource request path must be absolute.',
      'Pass an absolute request JSON path.',
    );
  }
  const read = readBoundedFile(file, MAX_REQUEST_BYTES);
  if (!read.ok) {
    return invalidRequest(
      'Resource request must be a readable regular JSON file no larger than 1 MiB.',
      'Inspect the request path and file kind; nothing was written.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return invalidRequest(
      'Resource request is not valid JSON.',
      'Rewrite the request as strict JSON; nothing was written.',
    );
  }
  const validated = collaborationResourceRequestSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .slice(0, 8)
      .map((issue) => {
        const field = issue.path.length ? issue.path.join('.') : '(root)';
        return `${field}:${issue.code}`;
      })
      .join(', ');
    return invalidRequest(
      `Resource request does not match the strict schema (${issues || 'invalid shape'}).`,
      'Fix the request schema; nothing was written.',
    );
  }
  if (validated.data.action !== expectedAction) {
    return invalidRequest(
      'Resource request action does not match the invoked resource command.',
      `Use a ${expectedAction} request; nothing was written.`,
    );
  }
  return { ok: true, value: { request: validated.data, path: file } };
}

function identityOf(holder: CollaborationResourceRequest['holder']): Identity {
  return {
    agent_id: holder.agent_id,
    session_id: holder.session_id,
    harness: holder.harness ?? null,
  };
}

function requestSummary(request: CollaborationResourceRequest) {
  if (request.action === 'claim') {
    return {
      action: request.action,
      holder: identityOf(request.holder),
      access: request.access,
      resource_count: request.resources.length,
      include_shared_git: request.include_shared_git === true,
      subtask_id: request.subtask_id ?? null,
      attempt: request.attempt ?? null,
    };
  }
  return {
    action: request.action,
    holder: identityOf(request.holder),
    claim_id: request.claim_id,
  };
}

async function openForResource(
  taskRoot: string,
  action: 'claim' | 'release',
): Promise<TaskStoreResult<OpenedTaskStore>> {
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok) return opened;
  if (action === 'claim') {
    const domainState = validateDomainTaskState(opened.value.domainRoot);
    if (domainState) return domainState;
    const mutationPaths = validateDomainMutationPaths(opened.value.domainRoot);
    if (mutationPaths) return mutationPaths;
  }
  return opened;
}

async function revalidateForApply(
  opened: OpenedTaskStore,
  action: 'claim' | 'release',
): Promise<TaskStoreFailure | null> {
  const changed = await assertTaskStoreCurrent(opened);
  if (changed !== null) return changed;
  if (action === 'claim') {
    const domainState = validateDomainTaskState(opened.domainRoot);
    if (domainState) return domainState;
    return validateDomainMutationPaths(opened.domainRoot);
  }
  return null;
}

export async function planResourceRequest(
  taskRoot: string,
  request: CollaborationResourceRequest,
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const opened = await openForResource(taskRoot, request.action);
  if (!opened.ok) return opened;
  return {
    ok: true,
    value: {
      schema: COLLAB_RESOURCES_SCHEMA,
      ok: true,
      action: request.action,
      applied: false,
      status: 'planned',
      task_root: opened.value.taskRoot,
      task_id: opened.value.record.task_id,
      domain_root: opened.value.domainRoot,
      request: requestSummary(request),
      limits: ['plan_validates_request_and_namespace_only', 'no_reservation'],
    },
  };
}

export async function applyResourceRequest(
  taskRoot: string,
  request: CollaborationResourceRequest,
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const opened = await openForResource(taskRoot, request.action);
  if (!opened.ok) return opened;
  const changed = await revalidateForApply(opened.value, request.action);
  if (changed) return changed;

  if (request.action === 'claim') {
    const resources = request.resources as ResourceInput[];
    let outcome: Awaited<ReturnType<typeof claimResources>>;
    try {
      outcome = claimResources(opened.value.taskRoot, {
        resources,
        access: request.access,
        holder: identityOf(request.holder),
        note: request.note ?? null,
        includeSharedGit: request.include_shared_git === true,
        subtaskId: request.subtask_id ?? null,
        attempt: request.attempt ?? null,
      });
    } catch (error) {
      if (error instanceof DomainLockHeldError)
        return {
          ok: false,
          code: 'domain_lock_held',
          message: 'The resource-domain lock is held; no claim was made.',
          nextAction:
            'Retry explicitly after the current domain operation finishes; nothing was mutated.',
        };
      return {
        ok: false,
        code: 'resource_operation_failed',
        message: 'The resource claim could not be completed.',
        nextAction: 'Inspect the task/domain state; no claim is promised.',
      };
    }
    return {
      ok: true,
      value: {
        schema: COLLAB_RESOURCES_SCHEMA,
        action: 'claim',
        applied: outcome.ok,
        task_root: opened.value.taskRoot,
        task_id: opened.value.record.task_id,
        ...outcome,
      },
    };
  }

  let outcome: Awaited<ReturnType<typeof releaseClaim>>;
  try {
    outcome = releaseClaim(opened.value.taskRoot, {
      claimId: request.claim_id,
      holder: identityOf(request.holder),
      ...(request.reason === undefined || request.reason === null
        ? {}
        : { reason: request.reason }),
    });
  } catch {
    return {
      ok: false,
      code: 'resource_operation_failed',
      message: 'The resource release could not be completed.',
      nextAction:
        'Inspect the task state; nothing is promised to have been released.',
    };
  }
  return {
    ok: true,
    value: {
      schema: COLLAB_RESOURCES_SCHEMA,
      action: 'release',
      applied: outcome.ok,
      task_root: opened.value.taskRoot,
      task_id: opened.value.record.task_id,
      ...outcome,
    },
  };
}

export async function listTaskResources(
  taskRoot: string,
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok) return opened;
  const domainState = validateDomainTaskState(opened.value.domainRoot);
  if (domainState) return domainState;
  const records = listDomainRecords(opened.value.domainRoot);
  const unreadable = records
    .filter((record) => record.__unreadable)
    .map((record) => record.task_id);
  const tasks = records
    .map((record) => ({
      task_id: record.task_id,
      claims: activeClaims(record).map((claim) => ({
        ...claim,
        task_id: record.task_id,
      })),
    }))
    .filter((task) => task.claims.length > 0);
  const claimCount = tasks.reduce(
    (total, task) => total + task.claims.length,
    0,
  );
  let remainingClaims = MAX_RESOURCE_CLAIMS;
  let emittedClaims = 0;
  const taskRows: {
    task_id: string;
    claims: unknown[];
  }[] = [];
  for (const task of tasks) {
    if (taskRows.length >= MAX_RESOURCE_TASKS || remainingClaims <= 0) break;
    const take = Math.min(task.claims.length, remainingClaims);
    if (take === 0) continue;
    taskRows.push({
      ...task,
      claims: task.claims.slice(0, take),
    });
    remainingClaims -= take;
    emittedClaims += take;
  }
  const omittedClaims = claimCount - emittedClaims;
  const omittedTasks = tasks.length - taskRows.length;
  const omittedUnreadable = Math.max(0, unreadable.length - MAX_RESOURCE_TASKS);
  return {
    ok: true,
    value: {
      schema: COLLAB_RESOURCES_SCHEMA,
      ok: unreadable.length === 0,
      action: 'list',
      state: unreadable.length ? 'unknown' : 'known',
      domain_id: opened.value.record.domain_id,
      domain_root: opened.value.domainRoot,
      tasks: taskRows,
      unreadable_tasks: unreadable.slice(0, MAX_RESOURCE_TASKS),
      counts: {
        tasks: tasks.length,
        claims: claimCount,
        unreadable_tasks: unreadable.length,
      },
      omitted: {
        tasks: omittedTasks,
        claims: omittedClaims,
        unreadable_tasks: omittedUnreadable,
      },
      truncated: omittedClaims > 0 || omittedTasks > 0 || omittedUnreadable > 0,
      limits: ['reported_domain_claims_only', 'unreadable_state_is_not_empty'],
    },
  };
}
