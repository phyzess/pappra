import {
  coordinatorLineage,
  hasSuccession,
  lineageContains,
} from '../collab/lineage.js';
import { readBoundedFile } from './bounded-file.js';
import { assertTaskStoreCurrent, openTaskStore } from './collab-task-store.js';
import type {
  MessageServiceFailure,
  OpenedMessageTask,
} from './collab-messages.js';
import {
  contentDigest,
  isSafeMessageId,
  messageFile,
  validateEnvelope,
} from '../collab/envelope.js';
import type { Message, TaskRecord } from '../collab/types.js';
import {
  evaluateWorkPlan,
  validateWorkPlan,
  type WorkPlan,
  type WorkPlanDiagnostic,
  type WorkPlanEvaluation,
  type WorkPlanRefusal,
} from '../collab/work-plan.js';
import { observePath, resolveRealpath } from '../infra/fs.js';
import { isPathInside } from '../schemas/paths.js';

/**
 * Public, read-only work-plan inspection.
 *
 * The entry validates one bounded plan document first, then loads only the decision
 * evidence that plan actually needs: the registered `ANSWER` envelopes addressed to the
 * current applied reports of the planned attempts. Unrelated task decisions are neither
 * read nor counted. Raw envelope bytes are budgeted before a full read through the
 * descriptor-safe bounded reader, and every loaded envelope keeps the safe message-id,
 * namespace, identity and content-digest checks. Nothing is claimed, launched, refreshed,
 * reconciled or written, and role labels carry no authority.
 */

export const COLLAB_WORK_PLAN_REPORT_SCHEMA =
  'pappra/collaboration-work-plan-report/1';

const MAX_PLAN_BYTES = 512 * 1024;
const MAX_DECISION_MESSAGES = 128;
const MAX_DECISION_FILE_BYTES = 1024 * 1024;
const MAX_DECISION_BYTES = 4 * 1024 * 1024;

/** Refusals that mean the caller's request/plan is wrong, not that evidence is missing. */
const PLAN_REQUEST_CODES = new Set([
  'plan_invalid',
  'node_invalid',
  'plan_too_large',
  'duplicate_node_id',
  'duplicate_dependency',
  'self_dependency',
  'unknown_dependency',
  'dependency_cycle',
  'resource_invalid',
  'task_identity_mismatch',
]);

const TASK_REQUEST_CODES = new Set([
  'task_root_required',
  'task_root_layout_invalid',
]);

export type WorkPlanReportStatus = 'evaluated' | 'incomplete' | 'invalid';

export interface WorkPlanReportBlocker {
  readonly code: string;
  readonly detail: string;
}

export interface WorkPlanReportNode {
  readonly node_id: string;
  readonly role: string;
  readonly assignment_id: string;
  readonly attempt: number;
  readonly status: string;
  /** Persisted assigned work with no native execution or durable dispatch intent yet. */
  readonly dispatch_pending?: boolean;
  readonly blockers: readonly WorkPlanReportBlocker[];
  readonly next_action: string | null;
}

export interface WorkPlanReportDiagnostic {
  readonly code: string;
  readonly detail: string;
  readonly next_action: string | null;
}

export interface WorkPlanEvidenceSummary {
  /** Applied reports of the planned attempts that decisions must reference. */
  readonly relevant_reports: number;
  /** Registered decision envelopes addressed to those reports. */
  readonly registered_decisions: number;
  readonly supplied: number;
  /**
   * Raw bytes consumed by successful bounded reads, including files later rejected by
   * realpath, JSON, envelope, identity or digest validation. Independent of `supplied`.
   */
  readonly raw_bytes: number;
  readonly per_file_limit: number;
  readonly aggregate_limit: number;
  readonly message_limit: number;
  readonly unreadable: readonly { message_id: string; code: string }[];
  readonly over_budget: boolean;
}

export interface WorkPlanReport {
  readonly schema: typeof COLLAB_WORK_PLAN_REPORT_SCHEMA;
  readonly ok: boolean;
  readonly status: WorkPlanReportStatus;
  readonly task_root: string | null;
  readonly task_id: string | null;
  readonly plan: {
    readonly ref: string;
    readonly digest: string | null;
    readonly plan_id: string | null;
    readonly owner_epoch: number | null;
    readonly node_count: number | null;
  };
  readonly stale: boolean;
  readonly summary: {
    readonly ready: number;
    readonly running: number;
    readonly awaiting_acceptance: number;
    readonly accepted: number;
    readonly blocked: number;
  } | null;
  readonly nodes: readonly WorkPlanReportNode[];
  readonly core: WorkPlanEvaluation | null;
  readonly evidence: WorkPlanEvidenceSummary;
  readonly diagnostics: readonly WorkPlanReportDiagnostic[];
  readonly identity_mapping: string;
  readonly limits: readonly string[];
}

export interface WorkPlanInspectionOptions {
  readonly taskRoot: string;
  readonly planFile: string;
}

const LIMITS = Object.freeze([
  'persisted_snapshot_only',
  'advisory_read_only_plan',
  'no_dispatch_or_launch',
  'no_native_query',
  'no_resource_fencing',
  'not_an_authorization',
]);

const IDENTITY_MAPPING =
  'plan.nodes[].assignment_id corresponds to the existing task subtask identity (record.attempts[].subtask_id); no separate assignment registry exists.';

function emptyEvidence(): WorkPlanEvidenceSummary {
  return {
    relevant_reports: 0,
    registered_decisions: 0,
    supplied: 0,
    raw_bytes: 0,
    per_file_limit: MAX_DECISION_FILE_BYTES,
    aggregate_limit: MAX_DECISION_BYTES,
    message_limit: MAX_DECISION_MESSAGES,
    unreadable: [],
    over_budget: false,
  };
}

function reportBase(planFile: string, digest: string | null): WorkPlanReport {
  return {
    schema: COLLAB_WORK_PLAN_REPORT_SCHEMA,
    ok: false,
    status: 'invalid',
    task_root: null,
    task_id: null,
    plan: {
      ref: planFile,
      digest,
      plan_id: null,
      owner_epoch: null,
      node_count: null,
    },
    stale: false,
    summary: null,
    nodes: [],
    core: null,
    evidence: emptyEvidence(),
    diagnostics: [],
    identity_mapping: IDENTITY_MAPPING,
    limits: [...LIMITS],
  };
}

const PLAN_READ_ACTIONS: Readonly<Record<string, string>> = {
  path_not_absolute:
    'Pass an absolute path to the plan document; nothing was read.',
  symlink:
    'Pass the real plan file; Pappra does not follow a redirected plan path.',
  not_regular:
    'Pass a regular JSON plan file; links and special files are not read.',
  too_large:
    'Reduce the plan document to the supported size; nothing was evaluated.',
  unreadable: 'Check permissions on the plan file; nothing was evaluated.',
};

function appendDiagnostic(
  report: WorkPlanReport,
  code: string,
  detail: string,
  nextAction: string | null,
): WorkPlanReport {
  return {
    ...report,
    diagnostics: [
      ...report.diagnostics,
      { code, detail, next_action: nextAction },
    ],
  };
}

function fromTaskFailure(
  report: WorkPlanReport,
  failure: MessageServiceFailure,
): WorkPlanReport {
  const withDiagnostic = appendDiagnostic(
    report,
    failure.code,
    failure.message,
    failure.nextAction,
  );
  return {
    ...withDiagnostic,
    status: TASK_REQUEST_CODES.has(failure.code) ? 'invalid' : 'incomplete',
  };
}

function classifyRefusal(
  diagnostics: readonly WorkPlanDiagnostic[],
): 'invalid' | 'incomplete' {
  return diagnostics.some((entry) => PLAN_REQUEST_CODES.has(entry.code))
    ? 'invalid'
    : 'incomplete';
}

function coreDiagnosticAction(code: string): string | null {
  switch (code) {
    case 'plan_invalid':
    case 'node_invalid':
    case 'duplicate_node_id':
    case 'duplicate_dependency':
    case 'self_dependency':
    case 'unknown_dependency':
    case 'dependency_cycle':
    case 'resource_invalid':
      return 'Fix the plan document and re-run the read-only inspection.';
    case 'plan_too_large':
      return 'Split the plan into a smaller bounded document; nothing was truncated.';
    case 'task_identity_mismatch':
      return 'Point the plan at this task root or inspect the intended task.';
    case 'record_invalid':
    case 'record_too_large':
      return 'Inspect the task record; planning refuses facts it cannot read.';
    default:
      return 'Inspect the supplied decision evidence; nothing was accepted from an unreadable envelope.';
  }
}

function fromCoreRefusal(
  report: WorkPlanReport,
  refusal: WorkPlanRefusal,
): WorkPlanReport {
  let next = report;
  for (const entry of refusal.diagnostics) {
    next = appendDiagnostic(
      next,
      entry.code,
      entry.detail,
      coreDiagnosticAction(entry.code),
    );
  }
  return { ...next, status: classifyRefusal(refusal.diagnostics) };
}

function summarise(evaluation: WorkPlanEvaluation) {
  return {
    ready: evaluation.ready_nodes.length,
    running: evaluation.running_nodes.length,
    awaiting_acceptance: evaluation.awaiting_acceptance_nodes.length,
    accepted: evaluation.accepted_nodes.length,
    blocked: evaluation.blocked_nodes.length,
  };
}

function projectNodes(
  evaluation: WorkPlanEvaluation,
  plan: WorkPlan,
  record: TaskRecord,
): WorkPlanReportNode[] {
  const planned = new Map(plan.nodes.map((node) => [node.node_id, node]));
  return evaluation.nodes.map((node) => ({
    node_id: node.node_id,
    role: node.role,
    assignment_id: planned.get(node.node_id)?.assignment_id ?? node.node_id,
    attempt: planned.get(node.node_id)?.attempt ?? 1,
    status: node.status,
    dispatch_pending:
      node.status === 'running' &&
      (() => {
        const plannedNode = planned.get(node.node_id);
        const attempt = record.attempts.find(
          (row) =>
            row.subtask_id === plannedNode?.assignment_id &&
            row.attempt === plannedNode.attempt,
        );
        return (
          attempt !== undefined &&
          attempt.state === 'assigned' &&
          !attempt.awaiting &&
          !attempt.cancel_requested_at &&
          !attempt.closed_at &&
          !record.dispatch_frozen &&
          attempt.native.observation === 'unknown' &&
          attempt.native.session_id === null &&
          attempt.native.run_id === null &&
          attempt.native.mission_id === null &&
          attempt.native.evidence_ref === null &&
          !record.messages.some(
            (message) =>
              message.type === 'STATUS_QUERY' &&
              message.subtask_id === attempt.subtask_id &&
              message.attempt === attempt.attempt &&
              message.message_id.startsWith('msg-work-intent-'),
          )
        );
      })(),
    blockers: node.blockers.map((blocker) => ({
      code: blocker.code,
      detail: blocker.detail,
    })),
    next_action: node.recovery,
  }));
}

/**
 * Applied reports belong to the planned attempts only. A report that no plan node
 * references cannot make this plan incomplete.
 */
function relevantReportIds(record: TaskRecord, plan: WorkPlan): Set<string> {
  const planned = new Set(
    plan.nodes.map((node) => `${node.assignment_id}#${node.attempt}`),
  );
  const ids = new Set<string>();
  for (const result of record.results ?? []) {
    if (result.classification !== 'applied') continue;
    if (!planned.has(`${result.subtask_id}#${result.attempt}`)) continue;
    ids.add(result.message_id);
  }
  return ids;
}

/** Registered decisions addressed to the relevant reports, in application order. */
function relevantDecisionIds(
  record: TaskRecord,
  reportIds: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  for (const entry of record.messages ?? []) {
    if (entry.type !== 'ANSWER') continue;
    if (entry.state !== 'applied') continue;
    if (typeof entry.reply_to !== 'string') continue;
    if (!reportIds.has(entry.reply_to)) continue;
    if (!ids.includes(entry.message_id)) ids.push(entry.message_id);
  }
  return ids;
}

interface LoadedEvidence {
  readonly messages: Message[];
  readonly rawBytes: number;
  readonly unreadable: { message_id: string; code: string }[];
  readonly overBudget: boolean;
}

function unreadableCode(
  code: 'path_not_absolute' | 'symlink' | 'not_regular' | 'unreadable',
): string {
  switch (code) {
    case 'symlink':
      return 'message_redirected';
    case 'not_regular':
      return 'message_not_regular';
    case 'unreadable':
      return 'message_unreadable';
    default:
      return 'message_path_invalid';
  }
}

/**
 * Loads the relevant decision envelopes under real raw-byte budgets.
 *
 * The per-file and remaining aggregate limits are applied before a full read, so a padded
 * envelope cannot consume the budget while reporting a smaller serialized size. Every
 * loaded envelope keeps the safe id, directory containment, realpath, identity and
 * registered content-digest checks.
 */
async function loadDecisionEvidence(
  task: OpenedMessageTask,
  decisionIds: readonly string[],
): Promise<LoadedEvidence> {
  const messages: Message[] = [];
  const unreadable: { message_id: string; code: string }[] = [];
  const registeredDigest = new Map(
    (task.record.messages ?? []).map((entry) => [
      entry.message_id,
      entry.content_digest,
    ]),
  );
  let rawBytes = 0;
  let overBudget = false;
  for (const [index, messageId] of decisionIds.entries()) {
    if (index >= MAX_DECISION_MESSAGES) {
      overBudget = true;
      break;
    }
    if (!isSafeMessageId(messageId)) {
      unreadable.push({ message_id: messageId, code: 'message_id_invalid' });
      continue;
    }
    const file = messageFile(task.taskRoot, messageId);
    if (!isPathInside(task.messagesDirectory, file)) {
      unreadable.push({ message_id: messageId, code: 'message_id_invalid' });
      continue;
    }
    const observation = await observePath(file);
    if (observation.kind === 'missing') {
      unreadable.push({
        message_id: messageId,
        code: 'message_not_registered',
      });
      continue;
    }
    if (observation.kind !== 'file' || observation.stats === null) {
      unreadable.push({ message_id: messageId, code: 'message_not_regular' });
      continue;
    }
    const remaining = Math.min(
      MAX_DECISION_FILE_BYTES,
      MAX_DECISION_BYTES - rawBytes,
    );
    if (remaining <= 0) {
      overBudget = true;
      break;
    }
    const read = readBoundedFile(file, remaining);
    if (!read.ok) {
      if (read.code === 'too_large') {
        // Either this file alone or the remaining aggregate budget is exhausted; the
        // report says so instead of publishing a partial readiness projection.
        overBudget = true;
        break;
      }
      unreadable.push({
        message_id: messageId,
        code: unreadableCode(read.code),
      });
      continue;
    }
    // The bytes were consumed by this read, so they count against the aggregate budget
    // even when a later check rejects the envelope.
    rawBytes += read.bytes.length;
    const real = await resolveRealpath(file);
    if (
      real === null ||
      real !== file ||
      !isPathInside(task.messagesDirectory, real)
    ) {
      unreadable.push({ message_id: messageId, code: 'message_redirected' });
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(read.text) as unknown;
    } catch {
      unreadable.push({ message_id: messageId, code: 'message_corrupt' });
      continue;
    }
    let message: Message;
    try {
      message = validateEnvelope(payload);
    } catch {
      unreadable.push({ message_id: messageId, code: 'message_invalid' });
      continue;
    }
    if (
      message.message_id !== messageId ||
      message.task_id !== task.record.task_id
    ) {
      unreadable.push({
        message_id: messageId,
        code: 'message_identity_mismatch',
      });
      continue;
    }
    if (contentDigest(message) !== registeredDigest.get(messageId)) {
      unreadable.push({ message_id: messageId, code: 'content_mismatch' });
      continue;
    }
    messages.push(message);
  }
  return { messages, rawBytes, unreadable, overBudget };
}

export async function inspectWorkPlan(
  options: WorkPlanInspectionOptions,
): Promise<WorkPlanReport> {
  const read = readBoundedFile(options.planFile, MAX_PLAN_BYTES);
  if (!read.ok) {
    const code = `plan_file_${read.code}`;
    return appendDiagnostic(
      reportBase(options.planFile, null),
      code,
      `The plan document could not be read as a bounded regular file (${read.code}).`,
      PLAN_READ_ACTIONS[read.code] ?? 'Pass a readable regular plan file.',
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(read.text) as unknown;
  } catch {
    return appendDiagnostic(
      reportBase(options.planFile, read.digest),
      'plan_json_invalid',
      'The plan document is not valid JSON.',
      'Fix the plan document syntax; nothing was evaluated.',
    );
  }
  const validated = validateWorkPlan(document);
  if (!validated.ok) {
    const base = reportBase(options.planFile, read.digest);
    return {
      ...fromCoreRefusal(base, validated),
      status: 'invalid',
    };
  }
  const plan = validated.plan;

  const opened = await openTaskStore(options.taskRoot);
  if (!opened.ok) {
    return fromTaskFailure(reportBase(options.planFile, read.digest), opened);
  }
  const task = opened.value;
  let report: WorkPlanReport = {
    ...reportBase(options.planFile, read.digest),
    task_root: task.taskRoot,
    task_id: task.record.task_id,
    plan: {
      ref: options.planFile,
      digest: read.digest,
      plan_id: plan.plan_id,
      owner_epoch: plan.owner_epoch,
      node_count: plan.nodes.length,
    },
  };
  if (task.record.task_id !== plan.task_id) {
    return appendDiagnostic(
      report,
      'task_identity_mismatch',
      `record is ${task.record.task_id}, plan is ${plan.task_id}`,
      coreDiagnosticAction('task_identity_mismatch'),
    );
  }

  const reports = relevantReportIds(task.record, plan);
  const decisions = relevantDecisionIds(task.record, reports);
  const loaded = await loadDecisionEvidence(task, decisions);

  // The namespace is re-proved after the evidence reads: a swapped root or record never
  // turns previously read files into authoritative decisions.
  const changed = await assertTaskStoreCurrent(task);
  if (changed !== null) {
    return fromTaskFailure(
      {
        ...report,
        evidence: {
          ...emptyEvidence(),
          relevant_reports: reports.size,
          registered_decisions: decisions.length,
          supplied: loaded.messages.length,
          raw_bytes: loaded.rawBytes,
          unreadable: loaded.unreadable,
          over_budget: loaded.overBudget,
        },
      },
      changed,
    );
  }

  report = {
    ...report,
    evidence: {
      ...emptyEvidence(),
      relevant_reports: reports.size,
      registered_decisions: decisions.length,
      supplied: loaded.messages.length,
      raw_bytes: loaded.rawBytes,
      unreadable: loaded.unreadable,
      over_budget: loaded.overBudget,
    },
  };
  for (const entry of loaded.unreadable) {
    report = appendDiagnostic(
      report,
      'decision_evidence_unavailable',
      `Registered decision ${entry.message_id} could not be read (${entry.code}).`,
      'Restore the registered decision file; an unreadable decision never becomes acceptance.',
    );
  }
  if (loaded.overBudget) {
    report = appendDiagnostic(
      report,
      'decision_evidence_over_budget',
      `The plan's relevant decision evidence exceeds the raw budget (${MAX_DECISION_MESSAGES} envelopes, ${MAX_DECISION_FILE_BYTES} bytes per file, ${MAX_DECISION_BYTES} aggregate).`,
      'Inspect the oversized registered decision or narrow the plan; the partial read is reported as incomplete, never as ready work.',
    );
  }

  const evaluated = evaluateWorkPlan({
    plan,
    record: task.record,
    messages: loaded.messages,
  });
  if (evaluated.ok === false) {
    return fromCoreRefusal(report, evaluated);
  }

  const coordinatorEpoch = task.record.coordinator?.owner_epoch ?? null;
  const lineage = coordinatorLineage(task.record);
  const stale = hasSuccession(lineage)
    ? !lineageContains(lineage, plan.owner_epoch)
    : plan.owner_epoch !== coordinatorEpoch;
  const incomplete = loaded.unreadable.length > 0 || loaded.overBudget;
  return {
    ...report,
    ok: !incomplete,
    status: incomplete ? 'incomplete' : 'evaluated',
    stale,
    summary: summarise(evaluated),
    nodes: projectNodes(evaluated, plan, task.record),
    core: evaluated,
  };
}
