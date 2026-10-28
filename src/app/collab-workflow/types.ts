import type { Outcome } from '../../schemas/outcome.js';
import type { WorkflowFailure } from '../../schemas/collab-workflow.js';
import {
  WORKFLOW_PLAN_SCHEMA,
  WORKFLOW_RESULT_SCHEMA,
} from '../../schemas/collab-workflow.js';

/**
 * Reported outcomes for the workflow facade.
 *
 * A report is evidence of what this invocation observed and did. It never implies that a
 * native session started, that a notification was consumed, or that work was accepted.
 */

export type { WorkflowFailure };

/** One shared result union: the protocol keeps only its own typed failure detail. */
export type WorkflowOutcome<T> = Outcome<T, WorkflowFailure>;

export function workflowFailure(
  code: string,
  message: string,
  nextAction: string | null = null,
): WorkflowFailure {
  return { ok: false, code, message, retryable: false, nextAction };
}

export type WorkflowAction =
  | 'prepare'
  | 'dispatch'
  | 'ack'
  | 'report'
  | 'accept'
  | 'release'
  | 'reclaim'
  | 'adopt'
  | 'inspect';

export type WorkflowStatus =
  | 'planned'
  | 'applied'
  | 'blocked'
  | 'refused'
  | 'needs-reconciliation'
  | 'invalid';

export interface WorkflowBlocker {
  readonly code: string;
  readonly detail: string;
  readonly next_action: string | null;
}

export interface WorkflowAssignmentPlan {
  readonly subtask_id: string;
  readonly role: string;
  readonly attempt: number;
  readonly assignment_id: string;
  readonly assignee: {
    readonly agent_id: string;
    readonly session_id: string;
    readonly harness: string;
  };
  readonly deferred: boolean;
  readonly assignment_ref: string;
  /**
   * Declaration identity: the normalized digest of the document this request derives.
   * `resource_epoch` is real claim state stamped at seal time, so a read-only plan cannot
   * know it; normalizing it away is what makes plan, sealed document and rerun agree.
   */
  readonly declaration_digest: string;
  /**
   * Wire pin: the SHA-256 of the exact sealed assignment bytes, including the real
   * `resource_epoch` values. Null until the document is sealed on disk, because a plan
   * cannot promise bytes it has not written.
   */
  readonly assignment_digest: string | null;
  /** Exact sealed bytes currently on disk; same value as `assignment_digest`. */
  readonly sealed_digest: string | null;
  readonly message_id: string;
  /** Digest of the registered ASSIGN message; null until the wire pin exists. */
  readonly message_digest: string | null;
  readonly resources: readonly {
    readonly path: string;
    readonly access: string;
    readonly key: string;
  }[];
  readonly derived_resources: readonly string[];
  readonly depends_on: readonly string[];
}

export interface WorkflowPlan {
  readonly schema: typeof WORKFLOW_PLAN_SCHEMA;
  readonly action: WorkflowAction;
  readonly apply: boolean;
  readonly status: WorkflowStatus;
  readonly task_id: string | null;
  readonly task_root: string | null;
  readonly domain_root: string | null;
  readonly input_revision: string | null;
  readonly assignments: readonly WorkflowAssignmentPlan[];
  readonly bindings: readonly {
    readonly agent_id: string;
    readonly pane_id: string;
    readonly native_session_id: string | null;
  }[];
  readonly blockers: readonly WorkflowBlocker[];
  readonly warnings: readonly string[];
  readonly limits: readonly string[];
}

export interface WorkflowResult<T = unknown> {
  readonly schema: typeof WORKFLOW_RESULT_SCHEMA;
  readonly action: WorkflowAction;
  readonly ok: boolean;
  readonly status: WorkflowStatus;
  readonly apply: boolean;
  readonly task_id: string | null;
  readonly task_root: string | null;
  readonly domain_root: string | null;
  readonly state_revision: number | null;
  readonly principal: {
    readonly agent_id: string;
    readonly session_id: string;
    readonly harness: string;
    readonly role: 'coordinator' | 'participant';
  } | null;
  readonly messages: readonly {
    readonly message_id: string;
    readonly type: string;
    readonly registration: string | null;
    readonly duplicate: boolean;
    readonly delivery: string;
    readonly digest: string | null;
  }[];
  readonly claims: readonly {
    readonly claim_id: string;
    readonly key: string;
    readonly access: string;
    readonly action: 'claimed' | 'released' | 'held';
  }[];
  readonly native: readonly {
    readonly subtask_id: string;
    readonly attempt: number;
    readonly observation: string;
    readonly card: string;
  }[];
  readonly blockers: readonly WorkflowBlocker[];
  readonly warnings: readonly string[];
  readonly limits: readonly string[];
  readonly next_action: string | null;
  readonly detail: T | null;
}

export function emptyResult<T = unknown>(
  action: WorkflowAction,
  apply: boolean,
): WorkflowResult<T> {
  return {
    schema: WORKFLOW_RESULT_SCHEMA,
    action,
    ok: false,
    status: 'invalid',
    apply,
    task_id: null,
    task_root: null,
    domain_root: null,
    state_revision: null,
    principal: null,
    messages: [],
    claims: [],
    native: [],
    blockers: [],
    warnings: [],
    limits: [],
    next_action: null,
    detail: null,
  };
}
