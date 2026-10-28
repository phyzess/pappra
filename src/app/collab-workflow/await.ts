import path from 'node:path';
import { z } from 'zod';
import {
  contentDigest,
  isSafeMessageId,
  validateEnvelope,
} from '../../collab/envelope.js';
import {
  coordinatorLineage,
  hasSuccession,
  judgeEvidence,
  lineageContains,
  type CoordinatorLineage,
} from '../../collab/lineage.js';
import { readRecord } from '../../collab/store.js';
import type {
  AppliedMessage,
  Message,
  TaskRecord,
} from '../../collab/types.js';
import { workflowParticipantRequestSchema } from '../../schemas/collab-workflow.js';
import {
  openWorkflowTask,
  readBoundedDocument,
  readBoundedJson,
  resolveAttempt,
  revalidateWorkflowTask,
  sameIdentity,
  type OpenedWorkflowTask,
} from './context.js';
import {
  emptyResult,
  workflowFailure,
  type WorkflowBlocker,
  type WorkflowOutcome,
  type WorkflowResult,
} from './types.js';

/**
 * Worker-side bounded wait for the coordinator's accept decision.
 *
 * A coordinator that cannot reach the Herdr socket still records its decision, but it cannot wake
 * the worker. This is the file-based channel for that case: the worker polls the persisted task
 * record and registered message files until a valid accept decision for its own attempt exists,
 * then learns its next action (`release`). It reads only those files: no Herdr, no pane, no log,
 * no native query. It writes nothing, notifies nobody and grants nothing; observing a decision
 * is not acceptance, and the work-plan evaluator stays the authority that unlocks dependent work.
 *
 * Like `ack`, `report` and `release` it is self-call only. The evidence a decision must carry is
 * the release path's decision correlation (`participant.ts`), including the coordinator lineage
 * after a succession, so a decision found here is one `release.correlates_to` accepts. That is the
 * same evidence as the release correlation, not the work-plan evaluator's verdict: the evaluator
 * also checks the sealed plan, node, input revision and plan epoch.
 */

export const WORKFLOW_AWAIT_REQUEST_SCHEMA =
  'pappra/collab-workflow-await-request/1';
/** Never widened by a caller: a longer wait is another invocation, not a bigger number. */
export const WORKFLOW_AWAIT_MAX_TIMEOUT_SECONDS = 600;
export const WORKFLOW_AWAIT_MIN_POLL_SECONDS = 1;
export const WORKFLOW_AWAIT_MAX_POLL_SECONDS = 60;
export const WORKFLOW_AWAIT_DEFAULT_POLL_SECONDS = 5;
/** Bounds the ignored-decision list a result carries; the full count is always reported. */
const MAX_IGNORED_LISTED = 16;
const MAX_IGNORED_WARNED = 8;

// The identity fields are the participant request's own validators, so `await` can never accept a
// caller, task root, subtask id or attempt that `ack`, `report` or `release` would refuse.
const participantShape = workflowParticipantRequestSchema.shape;

export const workflowAwaitRequestSchema = z.strictObject({
  schema: z.literal(WORKFLOW_AWAIT_REQUEST_SCHEMA),
  task_root: participantShape.task_root,
  caller: participantShape.caller,
  subtask_id: participantShape.subtask_id,
  attempt: participantShape.attempt,
  /** Required: how long to block is the caller's explicit choice. Zero observes exactly once. */
  timeout_seconds: z
    .number()
    .int()
    .min(0)
    .max(WORKFLOW_AWAIT_MAX_TIMEOUT_SECONDS),
  poll_interval_seconds: z
    .number()
    .int()
    .min(WORKFLOW_AWAIT_MIN_POLL_SECONDS)
    .max(WORKFLOW_AWAIT_MAX_POLL_SECONDS)
    .default(WORKFLOW_AWAIT_DEFAULT_POLL_SECONDS),
});

export type WorkflowAwaitRequest = z.infer<typeof workflowAwaitRequestSchema>;

export function parseWorkflowAwaitRequest(
  input: unknown,
): WorkflowOutcome<WorkflowAwaitRequest> {
  const parsed = workflowAwaitRequestSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 6)
    .map(
      (issue) => `${issue.path.join('.') || 'await request'}: ${issue.message}`,
    )
    .join('; ');
  return workflowFailure(
    'request_invalid',
    `await request is invalid: ${issues}`,
  );
}

export function loadAwaitRequest(
  file: string,
): WorkflowOutcome<WorkflowAwaitRequest> {
  const read = readBoundedJson(file, 'workflow request');
  if (!read.ok) return read;
  const candidate = read.value;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    (candidate as { schema?: unknown }).schema !== WORKFLOW_AWAIT_REQUEST_SCHEMA
  )
    return workflowFailure(
      'request_schema_invalid',
      `Expected a ${WORKFLOW_AWAIT_REQUEST_SCHEMA} document at ${file}.`,
      'Pass the request file for this action; a mismatched schema is refused.',
    );
  return parseWorkflowAwaitRequest(candidate);
}

/** The decision a worker observed. Evidence only: it carries no authority. */
export interface AwaitDecision {
  readonly message_id: string;
  readonly digest: string;
  /** The completed report this decision answers. */
  readonly reply_to: string;
  readonly report_digest: string;
  readonly owner_epoch: number;
  readonly applied_at: string;
  readonly from: {
    readonly agent_id: string;
    readonly session_id: string;
  };
}

/** A decision-shaped message that did not count, with the first rule it failed. */
export interface AwaitIgnoredDecision {
  readonly message_id: string;
  readonly reason: string;
}

export interface AwaitDetail {
  readonly subtask_id: string;
  readonly attempt: number;
  readonly attempt_state: string | null;
  /** The worker's current admitted completed report; null until one exists. */
  readonly report_message_id: string | null;
  readonly decision: AwaitDecision | null;
  readonly ignored: readonly AwaitIgnoredDecision[];
  readonly ignored_total: number;
  /** Observations made, the first one included. */
  readonly polls: number;
  readonly waited_ms: number;
  readonly timeout_seconds: number;
  readonly poll_interval_seconds: number;
}

export interface AwaitOptions {
  /** Monotonic millisecond clock. Tests inject a virtual one. */
  readonly now?: () => number;
  /** Sleep between observations. Tests inject one that advances the virtual clock. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDecisionEnvelope(taskRoot: string, id: string): Message | null {
  if (!isSafeMessageId(id)) return null;
  const read = readBoundedDocument(
    path.join(taskRoot, 'messages', `${id}.json`),
    'accept decision',
  );
  if (!read.ok) return null;
  try {
    return validateEnvelope(read.value.value);
  } catch {
    return null;
  }
}

interface DecisionContext {
  readonly taskRoot: string;
  readonly record: TaskRecord;
  readonly lineage: CoordinatorLineage;
  readonly succession: boolean;
  readonly request: WorkflowAwaitRequest;
  readonly report: {
    readonly message_id: string;
    readonly content_digest: string;
  };
}

type Judged =
  | {
      readonly ok: true;
      readonly decision: AwaitDecision;
      /** What the decision states; only `accepted` ends the wait. */
      readonly verdict: unknown;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * One applied ANSWER that replies to the worker's current report, judged by the release path's
 * decision correlation: a registered, unchanged envelope from the coordinator (of its own epoch
 * after a succession, applied before that epoch ended), addressed to this caller, task and
 * attempt. On top of that it must be an acceptance payload for this attempt and this report.
 * `participant.ts` is the source of truth for the correlation; `workflow-await.test.ts` pins the
 * two together.
 */
function judgeDecision(
  context: DecisionContext,
  entry: AppliedMessage,
): Judged {
  const { record, lineage, succession, request, report } = context;
  const registered = readDecisionEnvelope(context.taskRoot, entry.message_id);
  if (registered === null) return { ok: false, reason: 'decision_unreadable' };
  if (
    registered.message_id !== entry.message_id ||
    registered.type !== 'ANSWER' ||
    registered.reply_to !== report.message_id
  )
    return { ok: false, reason: 'decision_envelope_mismatch' };
  // The registered file must still be exactly what the record applied.
  if (contentDigest(registered) !== entry.content_digest)
    return { ok: false, reason: 'decision_digest_mismatch' };

  const coordinator = record.coordinator;
  if (coordinator === null)
    return { ok: false, reason: 'decision_no_current_coordinator' };
  const epoch = registered.owner_epoch;
  if (typeof epoch !== 'number')
    return { ok: false, reason: 'decision_epoch_not_current' };
  if (succession) {
    // Evidence of its own epoch: signed by that epoch's coordinator and, for an ended epoch,
    // applied at or before the instant it ended.
    const verdict = judgeEvidence(lineage, {
      epoch,
      signer: registered.from,
      appliedAt: entry.applied_at,
    });
    if (!verdict.valid)
      return { ok: false, reason: `decision_evidence_${verdict.reason}` };
  } else if (
    registered.from.agent_id !== coordinator.agent_id ||
    registered.from.session_id !== coordinator.session_id ||
    registered.from.harness !== coordinator.harness
  )
    return { ok: false, reason: 'decision_not_from_current_coordinator' };

  if (registered.task_id !== record.task_id)
    return { ok: false, reason: 'decision_wrong_task' };
  if (
    registered.to === null ||
    registered.to === undefined ||
    !sameIdentity(registered.to, request.caller)
  )
    return { ok: false, reason: 'decision_not_addressed_to_caller' };
  if (
    succession
      ? !lineageContains(lineage, epoch)
      : epoch !== coordinator.owner_epoch
  )
    return {
      ok: false,
      reason: succession
        ? 'decision_epoch_not_in_lineage'
        : 'decision_epoch_not_current',
    };
  if (
    registered.subtask_id !== request.subtask_id ||
    registered.attempt !== request.attempt
  )
    return { ok: false, reason: 'decision_wrong_attempt' };

  const acceptance = registered.body?.['acceptance'];
  if (!isRecord(acceptance))
    return { ok: false, reason: 'decision_has_no_acceptance' };
  if (
    acceptance['assignment_id'] !== request.subtask_id ||
    acceptance['attempt'] !== request.attempt
  )
    return { ok: false, reason: 'decision_wrong_attempt' };
  if (acceptance['report_digest'] !== report.content_digest)
    return { ok: false, reason: 'decision_wrong_report' };
  return {
    ok: true,
    verdict: acceptance['decision'],
    decision: {
      message_id: registered.message_id,
      digest: entry.content_digest,
      reply_to: report.message_id,
      report_digest: report.content_digest,
      owner_epoch: epoch,
      applied_at: entry.applied_at,
      from: {
        agent_id: registered.from.agent_id,
        session_id: registered.from.session_id,
      },
    },
  };
}

/**
 * The report a decision can address: the last admitted `applied` result of this attempt, which
 * must be `completed` and registered in the record (the evaluator anchors its decision lookup on
 * the same last applied result).
 */
function currentReport(
  record: TaskRecord,
  request: WorkflowAwaitRequest,
): { message_id: string; content_digest: string } | null {
  const admitted = (record.results ?? []).filter(
    (item) =>
      item.subtask_id === request.subtask_id &&
      item.attempt === request.attempt &&
      item.classification === 'applied',
  );
  const last = admitted[admitted.length - 1];
  if (last === undefined || last.status !== 'completed') return null;
  const entry = (record.messages ?? []).find(
    (item) =>
      item.message_id === last.message_id &&
      item.type === 'REPORT' &&
      item.state === 'applied',
  );
  return entry === undefined
    ? null
    : { message_id: entry.message_id, content_digest: entry.content_digest };
}

interface Evaluation {
  readonly attempt_state: string | null;
  readonly report_message_id: string | null;
  readonly decision: AwaitDecision | null;
  readonly ignored: readonly AwaitIgnoredDecision[];
}

function evaluate(
  taskRoot: string,
  record: TaskRecord,
  request: WorkflowAwaitRequest,
  attemptState: string,
): Evaluation {
  const report = currentReport(record, request);
  if (report === null)
    return {
      attempt_state: attemptState,
      report_message_id: null,
      decision: null,
      ignored: [],
    };
  const lineage = coordinatorLineage(record);
  const context: DecisionContext = {
    taskRoot,
    record,
    lineage,
    succession: hasSuccession(lineage),
    request,
    report,
  };
  const reportIds = new Set(
    (record.messages ?? [])
      .filter(
        (item) =>
          item.type === 'REPORT' &&
          item.subtask_id === request.subtask_id &&
          item.attempt === request.attempt,
      )
      .map((item) => item.message_id),
  );
  const ignored: AwaitIgnoredDecision[] = [];
  let witness: Extract<Judged, { ok: true }> | null = null;
  // Registration order is the authoritative order. Among the decisions that pass the release
  // correlation evidence the last one counts, and one that fails never blocks it. That is await's own
  // rule, not the work-plan evaluator's verdict: the evaluator also checks the sealed plan, node and
  // input revision and, with no succession, judges the last applied decision whether or not it passes.
  for (const entry of record.messages ?? []) {
    if (
      entry.type !== 'ANSWER' ||
      entry.state !== 'applied' ||
      entry.reply_to === null ||
      !reportIds.has(entry.reply_to)
    )
      continue;
    if (entry.reply_to !== report.message_id) {
      ignored.push({
        message_id: entry.message_id,
        reason: 'decision_for_other_report',
      });
      continue;
    }
    const judged = judgeDecision(context, entry);
    if (!judged.ok) {
      ignored.push({ message_id: entry.message_id, reason: judged.reason });
      continue;
    }
    witness = judged;
  }
  if (witness !== null && witness.verdict !== 'accepted') {
    const stated =
      typeof witness.verdict === 'string'
        ? witness.verdict.slice(0, 32)
        : 'unknown';
    ignored.push({
      message_id: witness.decision.message_id,
      reason: `decision_not_accepted:${stated}`,
    });
    witness = null;
  }
  return {
    attempt_state: attemptState,
    report_message_id: report.message_id,
    decision: witness === null ? null : witness.decision,
    ignored,
  };
}

type Poll =
  | {
      readonly kind: 'failed';
      readonly status: 'invalid' | 'refused';
      readonly task: OpenedWorkflowTask | null;
      readonly record: TaskRecord | null;
      readonly blocker: WorkflowBlocker;
    }
  | {
      readonly kind: 'seen';
      readonly task: OpenedWorkflowTask;
      readonly record: TaskRecord;
      readonly evaluation: Evaluation;
    };

function failedPoll(
  status: 'invalid' | 'refused',
  task: OpenedWorkflowTask | null,
  record: TaskRecord | null,
  blocker: WorkflowBlocker,
): Poll {
  return { kind: 'failed', status, task, record, blocker };
}

/** A typed failure from the shared task opener, as the blocker a result carries. */
function blockerOf(failure: {
  readonly code: string;
  readonly message: string;
  readonly nextAction: string | null;
}): WorkflowBlocker {
  return {
    code: failure.code,
    detail: failure.message,
    next_action: failure.nextAction,
  };
}

/**
 * One read-only observation. The first one opens the task; every later one revalidates that the
 * same namespace is still there before reading the record again, so a root swapped during a long
 * wait is refused instead of being followed.
 */
async function poll(
  request: WorkflowAwaitRequest,
  held: OpenedWorkflowTask | null,
): Promise<Poll> {
  try {
    let task: OpenedWorkflowTask;
    let record: TaskRecord;
    if (held === null) {
      const opened = await openWorkflowTask(request.task_root);
      if (!opened.ok)
        return failedPoll('invalid', null, null, blockerOf(opened));
      task = opened.value;
      record = task.record;
    } else {
      const changed = await revalidateWorkflowTask(held);
      if (!changed.ok)
        return failedPoll('invalid', held, null, blockerOf(changed));
      const current = readRecord(held.taskRoot);
      if (current === null)
        return failedPoll('invalid', held, null, {
          code: 'task_record_missing',
          detail: 'The task record disappeared during the wait.',
          next_action:
            'Inspect the task root; nothing was written and nothing was decided.',
        });
      task = held;
      record = current;
    }
    const attempt = resolveAttempt(record, request.subtask_id, request.attempt);
    if (attempt === null)
      return failedPoll('refused', task, record, {
        code: 'attempt_not_registered',
        detail: `${request.subtask_id}#${request.attempt} was never registered for this task.`,
        next_action:
          'Read the registered attempts with workflow inspect; an attempt is never assumed from a request.',
      });
    if (!sameIdentity(attempt.assignee, request.caller))
      return failedPoll('refused', task, record, {
        code: 'sender_denied',
        detail: `${request.subtask_id}#${request.attempt} is assigned to ${attempt.assignee.agent_id}/${attempt.assignee.session_id}; the caller is ${request.caller.agent_id}/${request.caller.session_id}.`,
        next_action:
          'The bound participant must make this call itself; another agent cannot author it on its behalf.',
      });
    return {
      kind: 'seen',
      task,
      record,
      evaluation: evaluate(task.taskRoot, record, request, attempt.state),
    };
  } catch (error) {
    return failedPoll('invalid', held, null, {
      code: 'await_observation_failed',
      detail: `The task files could not be read: ${error instanceof Error ? error.message : String(error)}`,
      next_action:
        'Inspect the task root; nothing was written and nothing was decided.',
    });
  }
}

function ignoredWarnings(ignored: readonly AwaitIgnoredDecision[]): string[] {
  const warnings = ignored
    .slice(0, MAX_IGNORED_WARNED)
    .map((item) => `ignored decision ${item.message_id}: ${item.reason}`);
  if (ignored.length > MAX_IGNORED_WARNED)
    warnings.push(
      `${ignored.length - MAX_IGNORED_WARNED} more ignored decisions are not listed.`,
    );
  return warnings;
}

/** What the worker does after a wait that ended without a decision. */
function timeoutAction(evaluation: Evaluation): string {
  return evaluation.report_message_id === null
    ? 'Report first (pappra collab workflow report), then await the decision.'
    : 'Run await again or ask the coordinator; do not treat this as accepted.';
}

/**
 * Wait, at most `timeout_seconds`, for a valid accept decision for this attempt.
 *
 * Read-only by construction: `apply` is always false and nothing is written, claimed, notified or
 * accepted. Only `decided` is `ok`. A `timeout` is `ok: false` (one `await_timeout` blocker, the
 * status kept), so `await && release` cannot release without a decision; a caller that must tell a
 * timeout from a refusal reads `status`.
 */
export async function applyAwait(
  request: WorkflowAwaitRequest,
  options: AwaitOptions = {},
): Promise<WorkflowResult<AwaitDetail>> {
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const base = emptyResult<AwaitDetail>('await', false);
  const principal = { ...request.caller, role: 'participant' } as const;
  const started = now();
  const deadline = started + request.timeout_seconds * 1000;
  let held: OpenedWorkflowTask | null = null;
  let polls = 0;

  const detailOf = (evaluation: Evaluation | null): AwaitDetail => ({
    subtask_id: request.subtask_id,
    attempt: request.attempt,
    attempt_state: evaluation?.attempt_state ?? null,
    report_message_id: evaluation?.report_message_id ?? null,
    decision: evaluation?.decision ?? null,
    ignored: (evaluation?.ignored ?? []).slice(0, MAX_IGNORED_LISTED),
    ignored_total: evaluation?.ignored.length ?? 0,
    polls,
    waited_ms: Math.max(0, Math.round(now() - started)),
    timeout_seconds: request.timeout_seconds,
    poll_interval_seconds: request.poll_interval_seconds,
  });

  for (;;) {
    polls += 1;
    const seen = await poll(request, held);
    if (seen.kind === 'failed')
      return {
        ...base,
        status: seen.status,
        ok: false,
        task_id: seen.record?.task_id ?? null,
        task_root: seen.task?.taskRoot ?? null,
        domain_root: seen.record?.domain_root ?? null,
        state_revision: seen.record?.state_revision ?? null,
        principal,
        blockers: [seen.blocker],
        next_action: seen.blocker.next_action,
        detail: detailOf(null),
      };
    held = seen.task;
    const { record, evaluation } = seen;
    const common = {
      ...base,
      task_id: record.task_id,
      task_root: seen.task.taskRoot,
      domain_root: record.domain_root,
      state_revision: record.state_revision,
      principal,
      warnings: ignoredWarnings(evaluation.ignored),
    } as const;
    if (evaluation.decision !== null) {
      const decision = evaluation.decision;
      return {
        ...common,
        ok: true,
        status: 'decided',
        messages: [
          {
            message_id: decision.message_id,
            type: 'ANSWER',
            registration: 'applied',
            duplicate: false,
            // Nothing is delivered: the decision was observed in the persisted record.
            delivery: 'not-attempted',
            digest: decision.digest,
          },
        ],
        next_action: `Run release (pappra collab workflow release --request <participant.json> --apply; release.correlates_to may cite ${decision.message_id}) to free this attempt's claims. Await observed this decision; it decided and accepted nothing.`,
        detail: detailOf(evaluation),
      };
    }
    const remaining = deadline - now();
    if (remaining <= 0)
      return {
        ...common,
        ok: false,
        status: 'timeout',
        blockers: [
          {
            code: 'await_timeout',
            detail: `No valid accept decision for ${request.subtask_id}#${request.attempt} appeared within ${request.timeout_seconds}s (${polls} observation${polls === 1 ? '' : 's'}).${evaluation.report_message_id === null ? ' No completed report is admitted yet, so there is nothing for the coordinator to accept.' : ''}`,
            next_action: timeoutAction(evaluation),
          },
        ],
        next_action: timeoutAction(evaluation),
        detail: detailOf(evaluation),
      };
    await sleep(
      Math.max(1, Math.min(request.poll_interval_seconds * 1000, remaining)),
    );
  }
}
