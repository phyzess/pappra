import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildMessage,
  contentDigest,
  messageFile,
} from '../collab/envelope.js';
import { pathRelation } from '../collab/canonical.js';
import { submitMessage } from '../collab/messages.js';
import {
  readDeliveryRecord,
  readRegisteredMessageSafe,
} from './collab-messages.js';
import {
  assertTaskStoreCurrent,
  openTaskStore,
  type OpenedTaskStore,
} from './collab-task-store.js';
import { readBoundedFile } from './bounded-file.js';
import { runCollaborationPreflight } from './collab-preflight.js';
import { inspectWorkPlan, type WorkPlanReport } from './collab-work-plan.js';
import {
  createHerdrTransport,
  notifyRegisteredMessage,
  type HerdrPromptResult,
  type HerdrTransport,
  type NotifyResult,
  type NotificationEffect,
} from './collab-notify.js';
import { collabBindingSchema } from '../schemas/collaboration.js';
import {
  isAssignment,
  isCard,
  type Assignment,
  type CapabilityCard,
} from '../collab/contracts.js';
import type {
  Attempt,
  Claim,
  Identity,
  Message,
  TaskRecord,
} from '../collab/types.js';
import {
  validateWorkPlan,
  type WorkPlan,
  type WorkPlanNode,
} from '../collab/work-plan.js';

export const COLLAB_WORK_EXECUTION_SCHEMA = 'pappra/collab-work-execution/1';
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CONCURRENCY = 8;
const MAX_NODES = 64;

export interface WorkExecutionCardInput {
  readonly assignment_id: string;
  readonly capabilities_file: string;
}

export interface WorkExecutionRequest {
  readonly task_root: string;
  readonly plan_file: string;
  readonly binding_file: string;
  readonly caller: Identity & { readonly cwd: string };
  readonly caller_pane: string;
  readonly capability_cards: readonly WorkExecutionCardInput[];
  readonly max_concurrency?: number;
}

export interface WorkExecutionOptions {
  readonly request: WorkExecutionRequest;
  readonly apply: boolean;
}

export interface WorkExecutionDispatchRequest {
  readonly taskRoot: string;
  readonly messageId: string;
  readonly bindingFile: string;
  readonly callerPane: string;
  /** Set only after a validated durable no-effect outcome permits one retry. */
  readonly retryNoEffect?: boolean;
  readonly finalAuthorityCheck?: () => Promise<{
    readonly ok: boolean;
    readonly reason: string;
  }>;
}

export interface WorkExecutionAdapter {
  /** Read-only routing validation. It must never submit a notification. */
  preflight(
    request: WorkExecutionDispatchRequest,
  ): Promise<WorkExecutionObservation>;
  /** One notification attempt; unknown outcomes are never replayed by this layer. */
  dispatch(
    request: WorkExecutionDispatchRequest,
  ): Promise<WorkExecutionObservation>;
}

export interface WorkExecutionObservation {
  readonly ok: boolean;
  readonly status: string;
  readonly detail: string | null;
  /** Missing means the producer could not prove a no-effect refusal. */
  readonly effect?: NotificationEffect;
  readonly delivery_path?: string | null;
  readonly message_digest?: string | null;
  readonly target_pane?: string | null;
}

export interface WorkExecutionNodeResult {
  readonly node_id: string;
  readonly role: string;
  readonly assignment_id: string;
  readonly attempt: number;
  readonly input_revision: string;
  readonly work_plan_status: string;
  readonly execution_status:
    | 'accepted'
    | 'awaiting_acceptance'
    | 'planned'
    | 'dispatched'
    | 'blocked'
    | 'reconciliation-required'
    | 'not-dispatchable';
  readonly blockers: readonly string[];
  readonly next_action: string | null;
  readonly assignment: {
    readonly ref: string | null;
    readonly digest: string | null;
  };
  readonly capabilities: {
    readonly ref: string | null;
    readonly digest: string | null;
  };
  readonly intent_message_id: string | null;
  readonly delivery: {
    readonly status: string | null;
    readonly message_digest: string | null;
    readonly delivery_path: string | null;
    readonly target_pane: string | null;
  } | null;
  readonly acceptance:
    'accepted' | 'awaiting_acceptance' | 'rejected' | 'not-applicable';
}

export interface WorkExecutionReportPointer {
  readonly node_id: string;
  readonly assignment_id: string;
  readonly attempt: number;
  readonly status: string;
  readonly message_id: string;
  readonly digest: string;
  readonly input_revision: string | null;
  readonly evidence_ref: string | null;
  readonly outputs: readonly {
    readonly ref: string;
    readonly digest: string;
  }[];
}

export interface WorkExecutionReport {
  readonly schema: typeof COLLAB_WORK_EXECUTION_SCHEMA;
  readonly ok: boolean;
  readonly status:
    'planned' | 'applied' | 'blocked' | 'needs-reconciliation' | 'invalid';
  readonly diagnostics: readonly string[];
  readonly apply: boolean;
  readonly task_root: string;
  readonly task_id: string | null;
  readonly plan: {
    readonly ref: string;
    readonly digest: string | null;
    readonly plan_id: string | null;
    readonly owner_epoch: number | null;
  };
  readonly concurrency: {
    readonly limit: number;
    readonly selected: number;
    readonly actual_overlap: boolean;
  };
  readonly nodes: readonly WorkExecutionNodeResult[];
  readonly reports: readonly WorkExecutionReportPointer[];
  readonly acceptance: {
    readonly accepted_nodes: readonly string[];
    readonly awaiting_acceptance_nodes: readonly string[];
    readonly rejected_nodes: readonly string[];
  };
  readonly limits: readonly string[];
}

interface Candidate {
  readonly node: WorkPlanNode;
  readonly planDigest: string;
  readonly attempt: Attempt;
  readonly assignment: Assignment;
  readonly assignmentFile: string;
  readonly assignmentDigest: string;
  readonly assignmentMessage: Message;
  readonly capabilitiesFile: string;
  readonly capabilitiesDigest: string;
  readonly card: CapabilityCard;
  readonly bindingDigest: string;
  readonly intentMessageId: string;
  readonly intent: Message;
  readonly resources: readonly {
    readonly path: string;
    readonly access: 'read' | 'write';
  }[];
}

interface EvaluationContext {
  readonly plan: WorkPlan;
  readonly planDigest: string;
  readonly report: WorkPlanReport;
  readonly record: TaskRecord;
  readonly opened: OpenedTaskStore;
  readonly assignmentMessages: ReadonlyMap<string, Message>;
}

const LIMITS = Object.freeze([
  'visible-bound-participants-only',
  'role-labels-do-not-grant-authority',
  'coordinator-acceptance-required-for-dependencies',
  'durable-intent-before-notification',
  'unknown-delivery-requires-reconciliation',
  'no-automatic-merge-or-approval',
  'no-native-fencing-or-session-launch',
]);

const DISPATCH_RECONCILIATION_NEXT_ACTION =
  'Inspect current delivery and native evidence, reconcile through the existing supported flow, and create an explicit repair/new attempt if needed. Do not delete the intent or treat notification as consumption, execution, or acceptance.';
function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function readJsonFile(
  file: string,
):
  | { readonly ok: true; readonly value: unknown; readonly digest: string }
  | { readonly ok: false; readonly reason: string } {
  const read = readBoundedFile(file, MAX_FILE_BYTES);
  if (!read.ok) return { ok: false, reason: `file_${read.code}` };
  try {
    return { ok: true, value: parseJson(read.text), digest: read.digest };
  } catch {
    return { ok: false, reason: 'file_invalid_json' };
  }
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return (
    left.agent_id === right.agent_id &&
    left.session_id === right.session_id &&
    left.harness === right.harness
  );
}

function samePerson(
  left: { readonly agent_id: string; readonly session_id: string },
  right: { readonly agent_id: string; readonly session_id: string },
): boolean {
  return (
    left.agent_id === right.agent_id && left.session_id === right.session_id
  );
}

function sameResources(
  left: readonly { readonly path: string; readonly access: string }[],
  right: readonly { readonly path: string; readonly access: string }[],
): boolean {
  const key = (resource: { readonly path: string; readonly access: string }) =>
    `${resource.access}\0${resource.path}`;
  const a = left.map(key).sort();
  const b = right.map(key).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function nodeResult(
  node: WorkPlanNode,
  status: WorkExecutionNodeResult['execution_status'],
  blockers: readonly string[],
  extras: Partial<WorkExecutionNodeResult> = {},
): WorkExecutionNodeResult {
  return {
    node_id: node.node_id,
    role: node.role,
    assignment_id: node.assignment_id,
    attempt: node.attempt,
    input_revision: node.input_revision,
    work_plan_status: 'unknown',
    execution_status: status,
    blockers: [...new Set(blockers)].sort(),
    assignment: { ref: null, digest: null },
    capabilities: { ref: null, digest: null },
    intent_message_id: null,
    delivery: null,
    acceptance: 'not-applicable',
    ...extras,
    next_action:
      status === 'reconciliation-required'
        ? (extras.next_action ?? DISPATCH_RECONCILIATION_NEXT_ACTION)
        : (extras.next_action ?? null),
  };
}

function staticBindingCheck(
  file: string,
  taskRoot: string,
  taskId: string,
  caller: WorkExecutionRequest['caller'],
  callerPane: string,
  assignment: Assignment,
):
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly reason: string } {
  const loaded = readJsonFile(file);
  if (!loaded.ok) return { ok: false, reason: `binding_${loaded.reason}` };
  const binding = collabBindingSchema.safeParse(loaded.value);
  if (!binding.success) return { ok: false, reason: 'binding_invalid' };
  const ids = binding.data.participants.map((item) => item.agent_id);
  const herdrNames = binding.data.participants.map((item) => item.herdr_agent);
  if (
    new Set(ids).size !== ids.length ||
    new Set(herdrNames).size !== herdrNames.length
  )
    return { ok: false, reason: 'binding_ambiguous' };
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(taskRoot);
  } catch {
    return { ok: false, reason: 'task_root_unavailable' };
  }
  if (
    binding.data.task_id !== taskId ||
    path.resolve(binding.data.task_root) !== canonicalRoot
  )
    return { ok: false, reason: 'binding_task_mismatch' };
  const sender = binding.data.participants.find(
    (item) => item.agent_id === caller.agent_id,
  );
  const recipient = binding.data.participants.find(
    (item) => item.agent_id === assignment.assignee.agent_id,
  );
  if (!sender || !recipient)
    return { ok: false, reason: 'binding_participant_missing' };
  if (
    sender.harness !== caller.harness ||
    sender.cwd !== caller.cwd ||
    sender.pane_id !== callerPane ||
    (sender.native_session_id !== null &&
      sender.native_session_id !== caller.session_id)
  )
    return { ok: false, reason: 'binding_sender_mismatch' };
  if (
    recipient.harness !== assignment.assignee.harness ||
    recipient.cwd !== assignment.assignee.cwd ||
    (recipient.native_session_id !== null &&
      recipient.native_session_id !== assignment.assignee.session_id)
  )
    return { ok: false, reason: 'binding_recipient_mismatch' };
  return { ok: true, digest: loaded.digest };
}

function currentAttempt(
  record: TaskRecord,
  node: WorkPlanNode,
): Attempt | null {
  return (
    record.attempts.find(
      (item) =>
        item.subtask_id === node.assignment_id && item.attempt === node.attempt,
    ) ?? null
  );
}

function activeClaimFor(
  record: TaskRecord,
  node: WorkPlanNode,
  resourcePath: string,
): Claim | null {
  return (
    record.claims.find(
      (claim) =>
        claim.released_at === null &&
        claim.path === resourcePath &&
        claim.access === 'write' &&
        claim.subtask_id === node.assignment_id &&
        claim.attempt === node.attempt &&
        claim.holder.agent_id === node.assignee.agent_id &&
        claim.holder.session_id === node.assignee.session_id &&
        Number.isSafeInteger(claim.resource_epoch) &&
        claim.resource_epoch > 0,
    ) ?? null
  );
}

function expectedCause(
  record: TaskRecord,
  node: WorkPlanNode,
  attempt: Attempt,
  assignmentDigest: string,
  caller: Identity,
): Record<string, unknown> {
  return {
    task_id: record.task_id,
    assignment_id: node.assignment_id,
    attempt: node.attempt,
    input_revision: node.input_revision,
    owner_epoch: record.coordinator?.owner_epoch ?? null,
    assignment_digest: assignmentDigest,
    assignee: {
      agent_id: node.assignee.agent_id,
      session_id: node.assignee.session_id,
    },
    coordinator: {
      agent_id: caller.agent_id,
      session_id: caller.session_id,
      harness: caller.harness,
    },
    assignment_message_id: attempt.assignment_message_id,
  };
}

function createIntent(
  cause: Record<string, unknown>,
  record: TaskRecord,
  attempt: Attempt,
  assignment: Assignment,
): Message {
  const causeDigest = sha256(JSON.stringify(cause));
  const messageId = `msg-work-intent-${causeDigest.slice('sha256:'.length, 48)}`;
  return buildMessage({
    message_id: messageId,
    type: 'STATUS_QUERY',
    task_id: record.task_id,
    from: {
      agent_id: assignment.coordinator.agent_id,
      session_id: assignment.coordinator.session_id,
      harness: assignment.coordinator.harness ?? null,
    },
    to: {
      agent_id: assignment.assignee.agent_id,
      session_id: assignment.assignee.session_id,
      harness: assignment.assignee.harness,
    },
    reply_to: attempt.assignment_message_id,
    subtask_id: attempt.subtask_id,
    attempt: attempt.attempt,
    owner_epoch: assignment.coordinator.owner_epoch,
    body: { work_execution_intent: { cause_id: causeDigest, ...cause } },
  });
}

function reportPointers(
  record: TaskRecord,
  plan: WorkPlan,
  messages: ReadonlyMap<string, Message>,
): WorkExecutionReportPointer[] {
  const pointers: WorkExecutionReportPointer[] = [];
  for (const node of plan.nodes) {
    const results = record.results.filter(
      (result) =>
        result.classification === 'applied' &&
        result.subtask_id === node.assignment_id &&
        result.attempt === node.attempt,
    );
    const result = results[results.length - 1];
    if (!result) continue;
    const report = messages.get(result.message_id);
    if (!report) continue;
    const outputs = (Array.isArray(result.outputs) ? result.outputs : [])
      .flatMap((output) => {
        if (
          !isObject(output) ||
          typeof output.ref !== 'string' ||
          typeof output.digest !== 'string'
        )
          return [];
        return [{ ref: output.ref, digest: output.digest }];
      })
      .sort(
        (left, right) =>
          left.ref.localeCompare(right.ref) ||
          left.digest.localeCompare(right.digest),
      );
    pointers.push({
      node_id: node.node_id,
      assignment_id: node.assignment_id,
      attempt: node.attempt,
      status: result.status,
      message_id: result.message_id,
      digest: report.content_digest ?? '',
      input_revision: result.input_revision,
      evidence_ref: result.evidence_ref,
      outputs,
    });
  }
  return pointers.sort(
    (left, right) =>
      left.node_id.localeCompare(right.node_id) ||
      left.message_id.localeCompare(right.message_id),
  );
}

function makeReport(input: {
  apply: boolean;
  taskRoot: string;
  taskId: string | null;
  planFile: string;
  planDigest: string | null;
  planId: string | null;
  ownerEpoch: number | null;
  concurrency: number;
  nodes: readonly WorkExecutionNodeResult[];
  reports: readonly WorkExecutionReportPointer[];
  accepted: readonly string[];
  awaiting: readonly string[];
  rejected: readonly string[];
  status?: WorkExecutionReport['status'];
  diagnostics?: readonly string[];
  actualOverlap?: boolean;
}): WorkExecutionReport {
  const nodes = [...input.nodes].sort((left, right) =>
    left.node_id.localeCompare(right.node_id),
  );
  const accepted = [...input.accepted].sort();
  const awaiting = [...input.awaiting].sort();
  const rejected = [...input.rejected].sort();
  const uncertain = nodes.some(
    (node) => node.execution_status === 'reconciliation-required',
  );
  const changed = nodes.some((node) => node.execution_status === 'dispatched');
  const blocked = nodes.some((node) => node.execution_status === 'blocked');
  const status =
    input.status ??
    (uncertain
      ? 'needs-reconciliation'
      : changed
        ? 'applied'
        : input.apply && blocked
          ? 'blocked'
          : 'planned');
  const diagnostics = [...(input.diagnostics ?? [])].sort();
  return {
    schema: COLLAB_WORK_EXECUTION_SCHEMA,
    ok: status === 'planned' || status === 'applied',
    status,
    diagnostics,
    apply: input.apply,
    task_root: input.taskRoot,
    task_id: input.taskId,
    plan: {
      ref: input.planFile,
      digest: input.planDigest,
      plan_id: input.planId,
      owner_epoch: input.ownerEpoch,
    },
    concurrency: {
      limit: input.concurrency,
      selected: nodes.filter(
        (node) =>
          node.execution_status === 'planned' ||
          node.execution_status === 'dispatched' ||
          node.execution_status === 'reconciliation-required',
      ).length,
      actual_overlap: input.actualOverlap ?? false,
    },
    nodes,
    reports: [...input.reports].sort(
      (left, right) =>
        left.node_id.localeCompare(right.node_id) ||
        left.message_id.localeCompare(right.message_id),
    ),
    acceptance: {
      accepted_nodes: accepted,
      awaiting_acceptance_nodes: awaiting,
      rejected_nodes: rejected,
    },
    limits: [...LIMITS],
  };
}

function failureReport(
  options: WorkExecutionOptions,
  reason: string,
  taskId: string | null = null,
): WorkExecutionReport {
  return makeReport({
    apply: options.apply,
    taskRoot: options.request.task_root,
    taskId,
    planFile: options.request.plan_file,
    planDigest: null,
    planId: null,
    ownerEpoch: null,
    concurrency: options.request.max_concurrency ?? 2,
    nodes: [],
    reports: [],
    accepted: [],
    awaiting: [],
    rejected: [],
    status: 'invalid',
    diagnostics: [reason],
  });
}

async function loadContext(
  request: WorkExecutionRequest,
): Promise<
  | { readonly ok: true; readonly value: EvaluationContext }
  | { readonly ok: false; readonly reason: string }
> {
  const planRead = readJsonFile(request.plan_file);
  if (!planRead.ok) return { ok: false, reason: `plan_${planRead.reason}` };
  const validated = validateWorkPlan(planRead.value);
  if (!validated.ok) return { ok: false, reason: 'plan_invalid' };
  const opened = await openTaskStore(request.task_root);
  if (!opened.ok) return { ok: false, reason: opened.code };
  if (opened.value.record.task_id !== validated.plan.task_id)
    return { ok: false, reason: 'task_identity_mismatch' };
  const report = await inspectWorkPlan({
    taskRoot: request.task_root,
    planFile: request.plan_file,
  });
  if (report.status !== 'evaluated' || report.core === null || report.stale)
    return { ok: false, reason: 'work_plan_not_current' };
  const assignmentMessages = new Map<string, Message>();
  for (const attempt of opened.value.record.attempts) {
    if (
      !validated.plan.nodes.some(
        (node) =>
          node.assignment_id === attempt.subtask_id &&
          node.attempt === attempt.attempt,
      )
    )
      continue;
    if (!attempt.assignment_message_id) continue;
    const message = await readRegisteredMessageSafe(
      opened.value,
      attempt.assignment_message_id,
    );
    if (message.ok)
      assignmentMessages.set(
        attempt.assignment_message_id,
        message.value.message,
      );
  }
  for (const result of opened.value.record.results) {
    if (
      !validated.plan.nodes.some(
        (node) =>
          node.assignment_id === result.subtask_id &&
          node.attempt === result.attempt,
      )
    )
      continue;
    const message = await readRegisteredMessageSafe(
      opened.value,
      result.message_id,
    );
    if (message.ok)
      assignmentMessages.set(result.message_id, message.value.message);
  }
  return {
    ok: true,
    value: {
      plan: validated.plan,
      planDigest: planRead.digest,
      report,
      record: opened.value.record,
      opened: opened.value,
      assignmentMessages,
    },
  };
}

interface EligibilityOptions {
  readonly allowIntentMessageId?: string;
  readonly allowSubmittingDeliveryMessageId?: string;
}

function eligibility(
  context: EvaluationContext,
  node: WorkPlanNode,
  request: WorkExecutionRequest,
  options: EligibilityOptions = {},
):
  | { readonly ok: true; readonly value: Candidate }
  | {
      readonly ok: false;
      readonly blockers: readonly string[];
      readonly result: WorkExecutionNodeResult;
    } {
  const workNode = context.report.nodes.find(
    (entry) => entry.node_id === node.node_id,
  );
  const workPlanStatus = workNode?.status ?? 'blocked';
  const coreNode = context.report.core?.nodes.find(
    (entry) => entry.node_id === node.node_id,
  );
  const attempt = currentAttempt(context.record, node);
  const acceptance: WorkExecutionNodeResult['acceptance'] =
    workPlanStatus === 'accepted'
      ? 'accepted'
      : workPlanStatus === 'awaiting_acceptance'
        ? 'awaiting_acceptance'
        : workNode?.blockers.some((item) => item.code === 'acceptance_rejected')
          ? 'rejected'
          : 'not-applicable';
  const common = {
    work_plan_status: workPlanStatus,
    acceptance,
    next_action: workNode?.next_action ?? null,
  };
  if (
    workPlanStatus === 'accepted' ||
    workPlanStatus === 'awaiting_acceptance'
  ) {
    return {
      ok: false,
      blockers: [],
      result: nodeResult(
        node,
        workPlanStatus === 'accepted' ? 'accepted' : 'awaiting_acceptance',
        [],
        common,
      ),
    };
  }
  if (!coreNode || coreNode.status === 'blocked' || !workNode || !attempt) {
    const blockers = workNode?.blockers.map((item) => item.code) ?? [
      'current_assignment_missing',
    ];
    return {
      ok: false,
      blockers,
      result: nodeResult(node, 'blocked', blockers, common),
    };
  }
  const blockers: string[] = [];
  const coordinator = context.record.coordinator;
  if (
    !coordinator ||
    !sameIdentity(coordinator, request.caller) ||
    coordinator.owner_epoch !== context.plan.owner_epoch
  )
    blockers.push('coordinator_identity_or_epoch_mismatch');
  if (attempt.state !== 'assigned' || coreNode.status !== 'running')
    blockers.push('attempt_not_assigned_and_pending');
  if (
    attempt.assignee.agent_id !== node.assignee.agent_id ||
    attempt.assignee.session_id !== node.assignee.session_id
  )
    blockers.push('assigned_participant_mismatch');
  if (attempt.input_revision !== node.input_revision)
    blockers.push('input_revision_mismatch');
  if (attempt.owner_epoch !== context.plan.owner_epoch)
    blockers.push('attempt_epoch_mismatch');
  if (
    attempt.native.session_id !== null ||
    attempt.native.run_id !== null ||
    attempt.native.mission_id !== null ||
    attempt.native.evidence_ref !== null
  )
    blockers.push('native_execution_already_observed');
  if (
    context.record.results.some(
      (result) =>
        result.classification === 'applied' &&
        result.subtask_id === node.assignment_id &&
        result.attempt === node.attempt,
    )
  )
    blockers.push('result_already_recorded');
  const assignmentMessage = context.assignmentMessages.get(
    attempt.assignment_message_id,
  );
  if (!assignmentMessage || assignmentMessage.type !== 'ASSIGN')
    blockers.push('registered_assignment_missing');
  if (
    assignmentMessage &&
    (!context.record.coordinator ||
      !sameIdentity(assignmentMessage.from, context.record.coordinator) ||
      assignmentMessage.body.assignment_ref !== attempt.assignment_ref ||
      assignmentMessage.body.input_revision !== node.input_revision)
  )
    blockers.push('assignment_message_pins_mismatch');
  const assignmentDelivery = assignmentMessage
    ? readDeliveryRecord(request.task_root, assignmentMessage.message_id)
    : null;
  if (
    assignmentDelivery !== null &&
    !(
      assignmentMessage?.message_id ===
        options.allowSubmittingDeliveryMessageId &&
      assignmentDelivery.status === 'submitting'
    )
  )
    blockers.push('assignment_delivery_already_recorded');
  if (
    !attempt.assignment_ref ||
    !path.isAbsolute(attempt.assignment_ref) ||
    !attempt.assignment_digest
  )
    blockers.push('assignment_pin_missing');
  const assignmentRead = attempt.assignment_ref
    ? readJsonFile(attempt.assignment_ref)
    : { ok: false as const, reason: 'assignment_missing' };
  const assignmentDigest = assignmentRead.ok ? assignmentRead.digest : null;
  if (!assignmentRead.ok) blockers.push(assignmentRead.reason);
  const assignment =
    assignmentRead.ok && isAssignment(assignmentRead.value)
      ? assignmentRead.value
      : null;
  if (!assignment) blockers.push('assignment_contract_invalid');
  if (
    assignment &&
    assignmentRead.ok &&
    assignmentRead.digest !== attempt.assignment_digest
  )
    blockers.push('assignment_digest_mismatch');
  if (
    assignment &&
    assignmentMessage &&
    assignmentMessage.body.assignment_digest !== attempt.assignment_digest
  )
    blockers.push('assignment_message_digest_mismatch');
  if (
    assignment &&
    (assignment.task_id !== context.record.task_id ||
      assignment.assignment_id !== node.assignment_id ||
      assignment.attempt !== node.attempt ||
      assignment.coordinator.owner_epoch !== context.plan.owner_epoch ||
      !samePerson(assignment.assignee, node.assignee))
  )
    blockers.push('assignment_identity_mismatch');
  if (
    assignment &&
    (assignment.coordinator.agent_id !== request.caller.agent_id ||
      assignment.coordinator.session_id !== request.caller.session_id)
  )
    blockers.push('assignment_coordinator_mismatch');
  if (assignment && !sameResources(assignment.resources, node.resources))
    blockers.push('assignment_resource_mismatch');
  if (assignment)
    for (const resource of assignment.resources) {
      if (resource.access !== 'write') continue;
      const claim = activeClaimFor(context.record, node, resource.path);
      if (!claim) blockers.push(`resource_claim_missing:${resource.path}`);
      else if (resource.resource_epoch !== claim.resource_epoch)
        blockers.push(`resource_claim_epoch_mismatch:${resource.path}`);
    }
  const cardInput = request.capability_cards.find(
    (item) => item.assignment_id === node.assignment_id,
  );
  if (!cardInput || !path.isAbsolute(cardInput.capabilities_file))
    blockers.push('capability_card_missing');
  const cardRead = cardInput
    ? readJsonFile(cardInput.capabilities_file)
    : { ok: false as const, reason: 'capability_card_missing' };
  if (!cardRead.ok) blockers.push(cardRead.reason);
  const card = cardRead.ok && isCard(cardRead.value) ? cardRead.value : null;
  if (!card) blockers.push('capability_card_invalid');
  const capabilitiesDigest = cardRead.ok ? cardRead.digest : null;
  if (assignment && cardInput && cardRead.ok) {
    const preflight = runCollaborationPreflight({
      assignmentFile: attempt.assignment_ref!,
      capabilitiesFile: cardInput.capabilities_file,
    });
    if (preflight.status !== 'ready')
      blockers.push(
        ...preflight.blockers.map((item) => `preflight:${item.code}`),
      );
  }
  let bindingDigest: string | null = null;
  if (assignment) {
    const binding = staticBindingCheck(
      request.binding_file,
      request.task_root,
      context.record.task_id,
      request.caller,
      request.caller_pane,
      assignment,
    );
    if (!binding.ok) blockers.push(binding.reason);
    else bindingDigest = binding.digest;
  }
  const cause =
    assignment && assignmentDigest
      ? expectedCause(
          context.record,
          node,
          attempt,
          assignmentDigest,
          request.caller,
        )
      : null;
  const intent =
    cause && assignment
      ? createIntent(cause, context.record, attempt, assignment)
      : null;
  if (
    intent &&
    options.allowIntentMessageId !== intent.message_id &&
    (context.record.messages.some(
      (item) => item.message_id === intent.message_id,
    ) ||
      fs.existsSync(messageFile(request.task_root, intent.message_id)))
  )
    blockers.push('dispatch_intent_exists_reconcile');
  const result = nodeResult(
    node,
    blockers.length
      ? blockers.includes('dispatch_intent_exists_reconcile')
        ? 'reconciliation-required'
        : 'blocked'
      : 'planned',
    blockers,
    {
      ...common,
      assignment: {
        ref: attempt.assignment_ref,
        digest: attempt.assignment_digest,
      },
      capabilities: {
        ref: cardInput?.capabilities_file ?? null,
        digest: capabilitiesDigest,
      },
      intent_message_id: intent?.message_id ?? null,
    },
  );
  if (
    blockers.length ||
    !assignment ||
    !assignmentRead.ok ||
    !card ||
    !cardInput ||
    !intent ||
    !assignmentMessage
  )
    return { ok: false, blockers: result.blockers, result };
  return {
    ok: true,
    value: {
      node,
      planDigest: context.planDigest,
      attempt,
      assignment,
      assignmentFile: attempt.assignment_ref!,
      assignmentDigest: assignmentRead.digest,
      assignmentMessage,
      capabilitiesFile: cardInput.capabilities_file,
      capabilitiesDigest: capabilitiesDigest!,
      card,
      bindingDigest: bindingDigest!,
      intentMessageId: intent.message_id,
      intent,
      resources: node.resources,
    },
  };
}

async function finalDispatchAuthority(
  request: WorkExecutionRequest,
  candidate: Candidate,
): Promise<{ readonly ok: boolean; readonly reason: string }> {
  const latest = await loadContext(request);
  if (!latest.ok) return { ok: false, reason: latest.reason };
  if (latest.value.planDigest !== candidate.planDigest)
    return { ok: false, reason: 'plan_digest_changed' };
  const node = latest.value.plan.nodes.find(
    (item) => item.node_id === candidate.node.node_id,
  );
  if (!node) return { ok: false, reason: 'plan_node_missing' };
  const checked = eligibility(latest.value, node, request, {
    allowIntentMessageId: candidate.intentMessageId,
    allowSubmittingDeliveryMessageId: candidate.assignmentMessage.message_id,
  });
  if (!checked.ok)
    return {
      ok: false,
      reason: checked.blockers.join(',') || 'assignment_not_current',
    };
  if (
    checked.value.assignmentDigest !== candidate.assignmentDigest ||
    checked.value.capabilitiesDigest !== candidate.capabilitiesDigest ||
    checked.value.bindingDigest !== candidate.bindingDigest ||
    checked.value.intentMessageId !== candidate.intentMessageId ||
    checked.value.assignmentMessage.message_id !==
      candidate.assignmentMessage.message_id
  )
    return { ok: false, reason: 'pinned_dispatch_inputs_changed' };

  const intent = await readRegisteredMessageSafe(
    latest.value.opened,
    candidate.intentMessageId,
  );
  if (
    !intent.ok ||
    contentDigest(intent.value.message) !== contentDigest(candidate.intent)
  )
    return { ok: false, reason: 'dispatch_intent_untrusted' };
  const intentEntry = latest.value.record.messages.find(
    (item) => item.message_id === candidate.intentMessageId,
  );
  if (
    !intentEntry ||
    intentEntry.type !== 'STATUS_QUERY' ||
    intentEntry.content_digest !== candidate.intent.content_digest ||
    !sameIdentity(intentEntry.from, request.caller)
  )
    return { ok: false, reason: 'dispatch_intent_not_current' };
  const delivery = readDeliveryRecord(
    request.task_root,
    candidate.assignmentMessage.message_id,
  );
  if (delivery?.status !== 'submitting')
    return { ok: false, reason: 'notification_reservation_not_current' };
  const changed = await assertTaskStoreCurrent(latest.value.opened);
  if (changed) return { ok: false, reason: changed.code };
  const current = await openTaskStore(request.task_root);
  if (!current.ok) return { ok: false, reason: current.code };
  if (
    current.value.record.state_revision !== latest.value.record.state_revision
  )
    return { ok: false, reason: 'task_revision_changed_before_prompt' };
  return { ok: true, reason: '' };
}

function acceptanceSets(context: EvaluationContext): {
  accepted: string[];
  awaiting: string[];
  rejected: string[];
} {
  const accepted = context.report.core?.accepted_nodes ?? [];
  const awaiting = context.report.core?.awaiting_acceptance_nodes ?? [];
  const rejected = context.report.nodes
    .filter((node) =>
      node.blockers.some((item) => item.code === 'acceptance_rejected'),
    )
    .map((node) => node.node_id);
  return {
    accepted: [...accepted].sort(),
    awaiting: [...awaiting].sort(),
    rejected: [...rejected].sort(),
  };
}

function overlap(left: Candidate, right: Candidate): boolean {
  return left.resources.some((a) =>
    right.resources.some(
      (b) =>
        (a.access === 'write' || b.access === 'write') &&
        pathRelation(a.path, b.path) !== 'disjoint',
    ),
  );
}

function asObservation(value: {
  readonly ok: boolean;
  readonly value?: NotifyResult;
  readonly code?: string;
  readonly message?: string;
  readonly effect?: NotificationEffect;
}): WorkExecutionObservation {
  if (!value.ok || !value.value)
    return {
      ok: false,
      status: value.code ?? 'notify_refused',
      effect: value.effect ?? 'possible',
      detail: value.message ?? 'Notification preflight refused.',
    };
  const result = value.value;
  return {
    ok: result.status === 'planned' || result.status === 'submitted',
    status: result.status,
    effect: result.effect ?? 'possible',
    detail: result.detail,
    delivery_path: result.deliveryPath,
    message_digest: result.messageDigest,
    target_pane: result.target?.pane_id ?? null,
  };
}

export interface WorkExecutionHerdrAdapterOptions {
  readonly transport?: HerdrTransport;
}

export function createHerdrWorkExecutionAdapter(
  options: WorkExecutionHerdrAdapterOptions = {},
): WorkExecutionAdapter {
  return {
    preflight: async (request) =>
      asObservation(
        await notifyRegisteredMessage({
          taskRoot: request.taskRoot,
          messageId: request.messageId,
          bindingFile: request.bindingFile,
          apply: false,
          retry: false,
          callerPane: request.callerPane,
          transport:
            options.transport ??
            createHerdrTransport({ taskRoot: request.taskRoot }),
        }),
      ),
    dispatch: async (request) => {
      const transport =
        options.transport ??
        createHerdrTransport({ taskRoot: request.taskRoot });
      const guardedTransport: HerdrTransport = {
        id: `${transport.id}:work-execution-guard`,
        verifyCaller: (callerOptions) => transport.verifyCaller(callerOptions),
        list: () => transport.list(),
        prompt: async (
          agent,
          promptText,
          registered,
        ): Promise<HerdrPromptResult> => {
          if (!request.finalAuthorityCheck)
            return {
              status: 'blocked',
              effect: 'none',
              detail:
                'Final work authority callback is missing; no prompt was sent.',
            };
          let authority: { readonly ok: boolean; readonly reason: string };
          try {
            authority = await request.finalAuthorityCheck();
          } catch (error) {
            return {
              status: 'blocked',
              effect: 'none',
              detail: `Final work authority check failed: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          if (!authority.ok)
            return {
              status: 'blocked',
              effect: 'none',
              detail: `Final work authority check refused the prompt: ${authority.reason}`,
            };
          return transport.prompt(agent, promptText, registered);
        },
      };
      return asObservation(
        await notifyRegisteredMessage({
          taskRoot: request.taskRoot,
          messageId: request.messageId,
          bindingFile: request.bindingFile,
          apply: true,
          retry: request.retryNoEffect === true,
          callerPane: request.callerPane,
          transport: guardedTransport,
        }),
      );
    },
  };
}

function observationResult(
  node: WorkPlanNode,
  observation: WorkExecutionObservation,
  intentMessageId: string,
  assignment: Candidate,
): WorkExecutionNodeResult {
  const status =
    observation.status === 'submitted'
      ? 'dispatched'
      : observation.status === 'planned'
        ? 'planned'
        : observation.status === 'in_flight_unknown' ||
            observation.status === 'unknown' ||
            observation.status === 'already_recorded'
          ? 'reconciliation-required'
          : 'blocked';
  return nodeResult(
    node,
    status,
    status === 'dispatched' || status === 'planned' ? [] : [observation.status],
    {
      work_plan_status: 'running',
      assignment: {
        ref: assignment.assignmentFile,
        digest: assignment.assignmentDigest,
      },
      capabilities: {
        ref: assignment.capabilitiesFile,
        digest: assignment.capabilitiesDigest,
      },
      intent_message_id: intentMessageId,
      delivery: {
        status: observation.status,
        message_digest: observation.message_digest ?? null,
        delivery_path: observation.delivery_path ?? null,
        target_pane: observation.target_pane ?? null,
      },
    },
  );
}

/**
 * Applies one bounded batch of already assigned work. Plan mode is read-only. Apply
 * persists a deterministic STATUS_QUERY intent with the existing message transaction before
 * one visible notification attempt; duplicate intents are reconciliation-only.
 */
export async function runWorkExecution(
  options: WorkExecutionOptions,
  deps: { readonly adapter?: WorkExecutionAdapter } = {},
): Promise<WorkExecutionReport> {
  const { request } = options;
  const concurrency = request.max_concurrency ?? 2;
  if (
    !path.isAbsolute(request.task_root) ||
    !path.isAbsolute(request.plan_file) ||
    !path.isAbsolute(request.binding_file) ||
    !request.caller_pane ||
    !/^[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(request.caller_pane) ||
    !request.caller.agent_id ||
    !request.caller.session_id ||
    !request.caller.harness ||
    !path.isAbsolute(request.caller.cwd) ||
    !Array.isArray(request.capability_cards) ||
    request.capability_cards.length > MAX_NODES ||
    request.capability_cards.some(
      (item) => !item.assignment_id || !path.isAbsolute(item.capabilities_file),
    ) ||
    new Set(request.capability_cards.map((item) => item.assignment_id)).size !==
      request.capability_cards.length ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_CONCURRENCY
  )
    return failureReport(options, 'invalid_request');
  const initial = await loadContext(request);
  if (!initial.ok) return failureReport(options, initial.reason);
  const context = initial.value;
  const initialAcceptance = acceptanceSets(context);
  const initialNodes = context.plan.nodes.map((node) => {
    const check = eligibility(context, node, request);
    return check.ok
      ? nodeResult(node, 'planned', [], {
          work_plan_status:
            context.report.nodes.find((item) => item.node_id === node.node_id)
              ?.status ?? 'unknown',
          assignment: {
            ref: check.value.assignmentFile,
            digest: check.value.assignmentDigest,
          },
          capabilities: {
            ref: check.value.capabilitiesFile,
            digest: check.value.capabilitiesDigest,
          },
          intent_message_id: check.value.intentMessageId,
        })
      : check.result;
  });
  const candidates = context.plan.nodes
    .flatMap((node) => {
      const check = eligibility(context, node, request);
      return check.ok ? [check.value] : [];
    })
    .sort((left, right) => left.node.node_id.localeCompare(right.node.node_id));
  const planReport = (
    nodes: WorkExecutionNodeResult[],
    status?: WorkExecutionReport['status'],
    actualOverlap = false,
  ) =>
    makeReport({
      apply: options.apply,
      taskRoot: request.task_root,
      taskId: context.record.task_id,
      planFile: request.plan_file,
      planDigest: context.planDigest,
      planId: context.plan.plan_id,
      ownerEpoch: context.plan.owner_epoch,
      concurrency,
      nodes,
      reports: reportPointers(
        context.record,
        context.plan,
        context.assignmentMessages,
      ),
      accepted: initialAcceptance.accepted,
      awaiting: initialAcceptance.awaiting,
      rejected: initialAcceptance.rejected,
      ...(status ? { status } : {}),
      actualOverlap,
    });
  if (!options.apply) return planReport(initialNodes);
  if (candidates.length === 0)
    return planReport(
      initialNodes,
      initialNodes.some(
        (node) => node.execution_status === 'reconciliation-required',
      )
        ? 'needs-reconciliation'
        : initialNodes.some((node) => node.execution_status === 'blocked')
          ? 'blocked'
          : 'planned',
    );

  const adapter = deps.adapter ?? createHerdrWorkExecutionAdapter();
  const prepared = await Promise.all(
    candidates.map(async (candidate) => {
      const observation = await adapter.preflight({
        taskRoot: request.task_root,
        messageId: candidate.assignmentMessage.message_id,
        bindingFile: request.binding_file,
        callerPane: request.caller_pane,
      });
      return { candidate, observation };
    }),
  );
  const results = new Map(
    initialNodes.map((result) => [result.node_id, result]),
  );
  const readyToPersist: Candidate[] = [];
  for (const { candidate, observation } of prepared) {
    if (observation.ok && observation.status === 'planned')
      readyToPersist.push(candidate);
    else
      results.set(
        candidate.node.node_id,
        nodeResult(
          candidate.node,
          'blocked',
          [`participant_preflight:${observation.status}`],
          {
            work_plan_status:
              context.report.nodes.find(
                (item) => item.node_id === candidate.node.node_id,
              )?.status ?? 'unknown',
            assignment: {
              ref: candidate.assignmentFile,
              digest: candidate.assignmentDigest,
            },
            capabilities: {
              ref: candidate.capabilitiesFile,
              digest: candidate.capabilitiesDigest,
            },
          },
        ),
      );
  }

  const dispatchable: Candidate[] = [];
  for (const preparedCandidate of readyToPersist) {
    const latest = await loadContext(request);
    if (!latest.ok) {
      results.set(
        preparedCandidate.node.node_id,
        nodeResult(preparedCandidate.node, 'blocked', [
          `revalidation:${latest.reason}`,
        ]),
      );
      continue;
    }
    const freshNode = latest.value.plan.nodes.find(
      (node) => node.node_id === preparedCandidate.node.node_id,
    );
    if (!freshNode) {
      results.set(
        preparedCandidate.node.node_id,
        nodeResult(preparedCandidate.node, 'blocked', ['plan_node_changed']),
      );
      continue;
    }
    const checked = eligibility(latest.value, freshNode, request);
    if (!checked.ok) {
      results.set(freshNode.node_id, checked.result);
      continue;
    }
    const participant = await adapter.preflight({
      taskRoot: request.task_root,
      messageId: checked.value.assignmentMessage.message_id,
      bindingFile: request.binding_file,
      callerPane: request.caller_pane,
    });
    if (!participant.ok || participant.status !== 'planned') {
      results.set(
        freshNode.node_id,
        nodeResult(freshNode, 'blocked', [
          `participant_revalidation:${participant.status}`,
        ]),
      );
      continue;
    }
    const afterObservation = await loadContext(request);
    if (!afterObservation.ok) {
      results.set(
        freshNode.node_id,
        nodeResult(freshNode, 'blocked', [
          `post_preflight_revalidation:${afterObservation.reason}`,
        ]),
      );
      continue;
    }
    const afterNode = afterObservation.value.plan.nodes.find(
      (node) => node.node_id === freshNode.node_id,
    );
    if (!afterNode) {
      results.set(
        freshNode.node_id,
        nodeResult(freshNode, 'blocked', ['plan_node_changed_after_preflight']),
      );
      continue;
    }
    const afterChecked = eligibility(
      afterObservation.value,
      afterNode,
      request,
    );
    if (!afterChecked.ok) {
      results.set(afterNode.node_id, afterChecked.result);
      continue;
    }
    const current = await openTaskStore(request.task_root);
    if (!current.ok) {
      results.set(
        freshNode.node_id,
        nodeResult(freshNode, 'blocked', [`task_revalidation:${current.code}`]),
      );
      continue;
    }
    const changed = await assertTaskStoreCurrent(current.value);
    if (changed) {
      results.set(
        freshNode.node_id,
        nodeResult(freshNode, 'blocked', [`task_revalidation:${changed.code}`]),
      );
      continue;
    }
    if (
      current.value.record.state_revision !==
      afterObservation.value.record.state_revision
    ) {
      results.set(
        freshNode.node_id,
        nodeResult(freshNode, 'blocked', ['task_revision_changed']),
      );
      continue;
    }
    const prior =
      current.value.record.messages.some(
        (item) => item.message_id === afterChecked.value.intentMessageId,
      ) ||
      fs.existsSync(
        messageFile(request.task_root, afterChecked.value.intentMessageId),
      );
    if (prior) {
      results.set(
        freshNode.node_id,
        nodeResult(
          freshNode,
          'reconciliation-required',
          ['dispatch_intent_exists_reconcile'],
          {
            work_plan_status:
              afterObservation.value.report.nodes.find(
                (item) => item.node_id === freshNode.node_id,
              )?.status ?? 'unknown',
            assignment: {
              ref: afterChecked.value.assignmentFile,
              digest: afterChecked.value.assignmentDigest,
            },
            capabilities: {
              ref: afterChecked.value.capabilitiesFile,
              digest: afterChecked.value.capabilitiesDigest,
            },
            intent_message_id: afterChecked.value.intentMessageId,
          },
        ),
      );
      continue;
    }
    const persisted = submitMessage(
      request.task_root,
      afterChecked.value.intent,
      {
        expectRevision: current.value.record.state_revision,
      },
    );
    if (
      !persisted.ok ||
      persisted.registration.status !== 'registered' ||
      persisted.duplicate === true
    ) {
      results.set(
        freshNode.node_id,
        nodeResult(
          freshNode,
          'reconciliation-required',
          [
            persisted.ok
              ? 'dispatch_intent_duplicate'
              : `intent_persist:${persisted.reason}`,
          ],
          {
            work_plan_status:
              afterObservation.value.report.nodes.find(
                (item) => item.node_id === freshNode.node_id,
              )?.status ?? 'unknown',
            assignment: {
              ref: afterChecked.value.assignmentFile,
              digest: afterChecked.value.assignmentDigest,
            },
            capabilities: {
              ref: afterChecked.value.capabilitiesFile,
              digest: afterChecked.value.capabilitiesDigest,
            },
            intent_message_id: afterChecked.value.intentMessageId,
          },
        ),
      );
      continue;
    }
    dispatchable.push(afterChecked.value);
  }

  let actualOverlap = false;
  for (let offset = 0; offset < dispatchable.length; offset += concurrency) {
    const batch = dispatchable.slice(offset, offset + concurrency);
    if (
      batch.length > 1 &&
      batch.some((item, index) =>
        batch.slice(index + 1).some((other) => overlap(item, other)),
      )
    ) {
      for (const candidate of batch)
        results.set(
          candidate.node.node_id,
          nodeResult(candidate.node, 'blocked', ['batch_resource_overlap']),
        );
      continue;
    }
    let active = 0;
    let peak = 0;
    const outcomes = await Promise.all(
      batch.map(async (candidate) => {
        let dispatchStarted = false;
        try {
          const latest = await loadContext(request);
          if (!latest.ok)
            return {
              candidate,
              observation: {
                ok: false,
                status: `revalidation:${latest.reason}`,
                detail: null,
              } as WorkExecutionObservation,
            };
          const liveNode = latest.value.plan.nodes.find(
            (node) => node.node_id === candidate.node.node_id,
          );
          if (!liveNode)
            return {
              candidate,
              observation: {
                ok: false,
                status: 'late_block:plan_node_missing',
                detail: null,
              } as WorkExecutionObservation,
            };
          const live = eligibility(latest.value, liveNode, request, {
            allowIntentMessageId: candidate.intentMessageId,
          });
          if (!live.ok)
            return {
              candidate,
              observation: {
                ok: false,
                status: `late_block:${live.blockers[0] ?? 'unknown'}`,
                detail: null,
              } as WorkExecutionObservation,
            };
          active += 1;
          peak = Math.max(peak, active);
          dispatchStarted = true;
          const observation = await adapter.dispatch({
            taskRoot: request.task_root,
            messageId: candidate.assignmentMessage.message_id,
            bindingFile: request.binding_file,
            callerPane: request.caller_pane,
            finalAuthorityCheck: () =>
              finalDispatchAuthority(request, candidate),
          });
          return { candidate, observation };
        } catch (error) {
          return {
            candidate,
            observation: {
              ok: false,
              status: 'unknown',
              detail: error instanceof Error ? error.message : String(error),
            } as WorkExecutionObservation,
          };
        } finally {
          if (dispatchStarted) active -= 1;
        }
      }),
    );
    actualOverlap ||= peak > 1;
    for (const { candidate, observation } of outcomes)
      results.set(
        candidate.node.node_id,
        observationResult(
          candidate.node,
          observation,
          candidate.intentMessageId,
          candidate,
        ),
      );
  }

  const finalContext = await loadContext(request);
  const final = finalContext.ok ? finalContext.value : context;
  const finalAcceptance = acceptanceSets(final);
  const finalMessages = new Map(final.assignmentMessages);
  if (finalContext.ok) {
    for (const node of final.plan.nodes) {
      const attempt = currentAttempt(final.record, node);
      if (!attempt) continue;
      for (const result of final.record.results.filter(
        (entry) =>
          entry.subtask_id === node.assignment_id &&
          entry.attempt === node.attempt,
      )) {
        const message = await readRegisteredMessageSafe(
          final.opened,
          result.message_id,
        );
        if (message.ok)
          finalMessages.set(result.message_id, message.value.message);
      }
    }
  }
  return makeReport({
    apply: true,
    taskRoot: request.task_root,
    taskId: final.record.task_id,
    planFile: request.plan_file,
    planDigest: final.planDigest,
    planId: final.plan.plan_id,
    ownerEpoch: final.plan.owner_epoch,
    concurrency,
    nodes: [...results.values()],
    reports: reportPointers(final.record, final.plan, finalMessages),
    accepted: finalAcceptance.accepted,
    awaiting: finalAcceptance.awaiting,
    rejected: finalAcceptance.rejected,
    actualOverlap,
  });
}
