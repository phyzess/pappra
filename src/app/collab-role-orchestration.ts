import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  aggregateRolePlan,
  expandRolePlan,
  type RolePlanAggregation,
  type RolePlanRequest,
  type RolePlanSuccess,
} from './collab-role-plan.js';
import {
  inspectWorkPlan,
  type WorkPlanInspectionOptions,
  type WorkPlanReport,
} from './collab-work-plan.js';
import {
  runWorkExecution,
  type WorkExecutionOptions,
  type WorkExecutionReport,
  type WorkExecutionAdapter,
} from './collab-work-execution.js';
import { validateWorkPlan, type WorkPlan } from '../collab/work-plan.js';
import { readBoundedFile } from './bounded-file.js';
import {
  recoverRoleRepairPlan,
  repairRejectedRoleNode,
  type RoleRepairDependencies,
  type RoleRepairPolicy,
} from './collab-role-repair.js';

export const COLLAB_ROLE_ORCHESTRATION_SCHEMA =
  'pappra/collab-role-orchestration/1';
const JOURNAL_SCHEMA = 'pappra/collab-role-orchestration-journal/1';
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_EVENTS_PER_PLAN = 256;
const MAX_ACTION_LIMIT = 64;
const MAX_ROUNDS_LIMIT = 64;
const MAX_EVENT_ID = 256;

export interface RoleOrchestrationLimits {
  /** Maximum distinct evidence events (ticks) for this plan. */
  readonly max_rounds: number;
  /** Conservative maximum dispatch reservations across all ticks for this plan. */
  readonly max_actions: number;
  /** Maximum approved assignment attempt for rejected-node repair. */
  readonly max_attempts: number;
}

export interface RoleOrchestrationRequest {
  readonly role_plan: RolePlanRequest;
  readonly execution: WorkExecutionOptions['request'];
  /** Stable ID supplied by the triggering session event; repeated IDs never run twice. */
  readonly event_id: string;
  /** Task-local durable receipt file, e.g. `<task_root>/role-orchestration.json`. */
  readonly journal_file: string;
  readonly limits: RoleOrchestrationLimits;
  /** Explicitly pre-authorized repair transitions; omitted requests retain legacy behavior. */
  readonly repair_policy?: RoleRepairPolicy;
}

export type RoleOrchestrationStatus =
  | 'dispatched'
  | 'waiting'
  | 'accepted'
  | 'repaired'
  | 'repair-required'
  | 'repair-exhausted'
  | 'blocked'
  | 'reconciliation-required'
  | 'budget-exhausted'
  | 'duplicate';

export interface RoleOrchestrationResult {
  readonly schema: typeof COLLAB_ROLE_ORCHESTRATION_SCHEMA;
  readonly status: RoleOrchestrationStatus;
  readonly event_id: string;
  readonly plan_id: string;
  readonly round: number | null;
  readonly reserved_actions: number;
  readonly prior_outcome: string | null;
  readonly aggregate: RolePlanAggregation | null;
  readonly execution: WorkExecutionReport | null;
  /** Returned for the root event driver to persist with its guarded-CAS request writer. */
  readonly updatedRequest: RoleOrchestrationRequest | null;
  readonly diagnostics: readonly string[];
}

interface JournalPlan {
  readonly plan_id: string;
  readonly max_rounds: number;
  readonly max_actions: number;
  rounds: number;
  reserved_actions: number;
}

interface JournalEvent {
  readonly plan_id: string;
  readonly event_id: string;
  readonly request_digest: string;
  readonly reserved_actions: number;
  state: 'reserved' | 'complete';
  outcome: string | null;
}

interface Journal {
  readonly schema: typeof JOURNAL_SCHEMA;
  readonly plans: JournalPlan[];
  readonly events: JournalEvent[];
}

export interface RoleOrchestrationDependencies {
  readonly inspect?: (
    options: WorkPlanInspectionOptions,
  ) => Promise<WorkPlanReport>;
  readonly execute?: (
    options: WorkExecutionOptions,
    deps?: { readonly adapter?: WorkExecutionAdapter },
  ) => Promise<WorkExecutionReport>;
  readonly execution_adapter?: WorkExecutionAdapter;
  readonly repair?: RoleRepairDependencies;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function failure(
  request: RoleOrchestrationRequest | null | undefined,
  status: RoleOrchestrationStatus,
  diagnostic: string,
  round: number | null = null,
): RoleOrchestrationResult {
  return {
    schema: COLLAB_ROLE_ORCHESTRATION_SCHEMA,
    status,
    event_id: request?.event_id ?? '',
    plan_id: request?.role_plan?.plan_id ?? '',
    round,
    reserved_actions: 0,
    prior_outcome: null,
    aggregate: null,
    execution: null,
    updatedRequest: null,
    diagnostics: [diagnostic],
  };
}

function validateJournal(value: unknown): Journal | null {
  if (
    !isRecord(value) ||
    value['schema'] !== JOURNAL_SCHEMA ||
    !Array.isArray(value['plans']) ||
    !Array.isArray(value['events']) ||
    value['plans'].length > MAX_EVENTS_PER_PLAN ||
    value['events'].length > MAX_EVENTS_PER_PLAN * MAX_ROUNDS_LIMIT
  )
    return null;
  for (const plan of value['plans']) {
    if (
      !isRecord(plan) ||
      typeof plan['plan_id'] !== 'string' ||
      !Number.isSafeInteger(plan['max_rounds']) ||
      !Number.isSafeInteger(plan['max_actions']) ||
      !Number.isSafeInteger(plan['rounds']) ||
      !Number.isSafeInteger(plan['reserved_actions'])
    )
      return null;
  }
  for (const event of value['events']) {
    if (
      !isRecord(event) ||
      typeof event['plan_id'] !== 'string' ||
      typeof event['event_id'] !== 'string' ||
      typeof event['request_digest'] !== 'string' ||
      !Number.isSafeInteger(event['reserved_actions']) ||
      (event['state'] !== 'reserved' && event['state'] !== 'complete') ||
      !(event['outcome'] === null || typeof event['outcome'] === 'string')
    )
      return null;
  }
  return value as unknown as Journal;
}

function readJournal(file: string): Journal | null | undefined {
  if (!fs.existsSync(file)) return null;
  const read = readBoundedFile(file, MAX_JOURNAL_BYTES);
  if (!read.ok) return undefined;
  try {
    const parsed = validateJournal(JSON.parse(read.text) as unknown);
    return parsed ?? undefined;
  } catch {
    return undefined;
  }
}

function withJournalLock<T>(file: string, action: () => T): T | null {
  const lockFile = `${file}.lock`;
  let lock: number;
  try {
    lock = fs.openSync(lockFile, 'wx', 0o600);
  } catch {
    return null;
  }
  try {
    fs.writeFileSync(lock, `${process.pid}\n`, 'utf8');
    fs.fsyncSync(lock);
    return action();
  } finally {
    fs.closeSync(lock);
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // A failed lock cleanup fails closed on the next tick.
    }
  }
}

function writeJournal(file: string, journal: Journal): void {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(journal)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    const parent = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The rename already consumed it or cleanup is best effort.
    }
  }
}

type Reservation =
  | {
      readonly kind: 'reserved';
      readonly round: number;
      readonly actions: number;
    }
  | {
      readonly kind: 'duplicate';
      readonly state: 'reserved' | 'complete';
      readonly outcome: string | null;
    }
  | { readonly kind: 'budget'; readonly round: number | null }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'locked' };

function reserveTick(
  request: RoleOrchestrationRequest,
  requestDigest: string,
  actions: number,
): Reservation {
  const file = request.journal_file;
  const taskRoot = path.resolve(request.execution.task_root);
  const absolute = path.resolve(file);
  const relative = path.relative(taskRoot, absolute);
  if (
    !path.isAbsolute(file) ||
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  )
    return {
      kind: 'invalid',
      reason: 'journal_file_must_be_a_task_local_absolute_path',
    };
  try {
    const parent = fs.lstatSync(path.dirname(absolute));
    if (!parent.isDirectory() || parent.isSymbolicLink())
      return {
        kind: 'invalid',
        reason: 'journal_parent_must_be_a_real_directory',
      };
    const existing = fs.existsSync(absolute) ? fs.lstatSync(absolute) : null;
    if (existing && (!existing.isFile() || existing.isSymbolicLink()))
      return { kind: 'invalid', reason: 'journal_must_be_a_regular_file' };
  } catch {
    return { kind: 'invalid', reason: 'journal_parent_unavailable' };
  }

  let result: Reservation | null;
  try {
    result = withJournalLock(absolute, () => {
      const loaded = readJournal(absolute);
      if (loaded === undefined)
        return {
          kind: 'invalid',
          reason: 'journal_unreadable_or_invalid',
        } as const;
      const journal: Journal = loaded ?? {
        schema: JOURNAL_SCHEMA,
        plans: [],
        events: [],
      };
      const matching = journal.events.find(
        (event) =>
          event.plan_id === request.role_plan.plan_id &&
          event.event_id === request.event_id,
      );
      if (matching) {
        if (matching.request_digest !== requestDigest)
          return {
            kind: 'invalid',
            reason: 'event_id_reused_for_different_request',
          } as const;
        return {
          kind: 'duplicate',
          state: matching.state,
          outcome: matching.outcome,
        } as const;
      }
      if (journal.events.length >= MAX_EVENTS_PER_PLAN * MAX_ROUNDS_LIMIT)
        return { kind: 'budget', round: null } as const;

      const existingPlan = journal.plans.find(
        (plan) => plan.plan_id === request.role_plan.plan_id,
      );
      const plan = existingPlan ?? {
        plan_id: request.role_plan.plan_id,
        max_rounds: request.limits.max_rounds,
        max_actions: request.limits.max_actions,
        rounds: 0,
        reserved_actions: 0,
      };
      if (
        plan.max_rounds !== request.limits.max_rounds ||
        plan.max_actions !== request.limits.max_actions
      )
        return {
          kind: 'invalid',
          reason: 'plan_limits_cannot_change_after_first_tick',
        } as const;
      if (plan.rounds >= plan.max_rounds)
        return { kind: 'budget', round: plan.rounds } as const;
      const reservedActions = Math.min(
        actions,
        plan.max_actions - plan.reserved_actions,
      );

      const nextPlan: JournalPlan = {
        ...plan,
        rounds: plan.rounds + 1,
        reserved_actions: plan.reserved_actions + reservedActions,
      };
      const event: JournalEvent = {
        plan_id: request.role_plan.plan_id,
        event_id: request.event_id,
        request_digest: requestDigest,
        reserved_actions: reservedActions,
        state: 'reserved',
        outcome: null,
      };
      const next: Journal = {
        schema: JOURNAL_SCHEMA,
        plans: existingPlan
          ? journal.plans.map((entry) =>
              entry.plan_id === nextPlan.plan_id ? nextPlan : entry,
            )
          : [...journal.plans, nextPlan],
        events: [...journal.events, event],
      };
      writeJournal(absolute, next);
      return {
        kind: 'reserved',
        round: nextPlan.rounds,
        actions: reservedActions,
      } as const;
    });
  } catch {
    return { kind: 'invalid', reason: 'journal_reservation_write_failed' };
  }
  return result ?? { kind: 'locked' };
}

function completeTick(
  request: RoleOrchestrationRequest,
  requestDigest: string,
  outcome: RoleOrchestrationStatus,
): boolean {
  const file = path.resolve(request.journal_file);
  try {
    const updated = withJournalLock(file, () => {
      const journal = readJournal(file);
      if (!journal) return false;
      const event = journal.events.find(
        (entry) =>
          entry.plan_id === request.role_plan.plan_id &&
          entry.event_id === request.event_id,
      );
      if (!event || event.request_digest !== requestDigest) return false;
      event.state = 'complete';
      event.outcome = outcome;
      writeJournal(file, journal);
      return true;
    });
    return updated === true;
  } catch {
    return false;
  }
}

function samePlan(left: WorkPlan, right: WorkPlan): boolean {
  return (
    left.schema === right.schema &&
    left.plan_id === right.plan_id &&
    left.task_id === right.task_id &&
    left.owner_epoch === right.owner_epoch &&
    left.nodes.length === right.nodes.length &&
    left.nodes.every((node, index) => {
      const other = right.nodes[index];
      return (
        other !== undefined &&
        node.node_id === other.node_id &&
        node.role === other.role &&
        node.assignment_id === other.assignment_id &&
        node.attempt === other.attempt &&
        node.input_revision === other.input_revision &&
        node.assignee.agent_id === other.assignee.agent_id &&
        node.assignee.session_id === other.assignee.session_id &&
        JSON.stringify(node.depends_on) === JSON.stringify(other.depends_on) &&
        JSON.stringify(node.resources) === JSON.stringify(other.resources)
      );
    })
  );
}

function matchingExpansion(
  report: WorkPlanReport,
  expansion: RolePlanSuccess,
  taskRoot: string,
  planFile: string,
): boolean {
  if (
    !report.ok ||
    report.status !== 'evaluated' ||
    report.stale ||
    path.resolve(report.task_root ?? '') !== path.resolve(taskRoot) ||
    report.plan.ref !== planFile ||
    report.plan.plan_id !== expansion.plan.plan_id ||
    report.plan.owner_epoch !== expansion.plan.owner_epoch ||
    report.task_id !== expansion.plan.task_id ||
    report.core === null ||
    report.core.ok !== true ||
    report.core.plan_id !== expansion.plan.plan_id ||
    report.core.task_id !== expansion.plan.task_id ||
    report.core.owner_epoch !== expansion.plan.owner_epoch
  )
    return false;
  const read = readBoundedFile(planFile, 512 * 1024);
  if (!read.ok) return false;
  try {
    const parsed = validateWorkPlan(JSON.parse(read.text) as unknown);
    return parsed.ok && samePlan(parsed.plan, expansion.plan);
  } catch {
    return false;
  }
}

function result(
  request: RoleOrchestrationRequest,
  status: RoleOrchestrationStatus,
  round: number | null,
  reservedActions: number,
  values: Partial<
    Pick<
      RoleOrchestrationResult,
      | 'aggregate'
      | 'execution'
      | 'diagnostics'
      | 'prior_outcome'
      | 'updatedRequest'
    >
  > = {},
): RoleOrchestrationResult {
  return {
    schema: COLLAB_ROLE_ORCHESTRATION_SCHEMA,
    status,
    event_id: request.event_id,
    plan_id: request.role_plan.plan_id,
    round,
    reserved_actions: reservedActions,
    prior_outcome: values.prior_outcome ?? null,
    aggregate: values.aggregate ?? null,
    execution: values.execution ?? null,
    updatedRequest: values.updatedRequest ?? null,
    diagnostics: values.diagnostics ?? [],
  };
}

/**
 * Advances one explicit session-event tick over the existing role-plan and WorkPlan state.
 * The durable journal reserves the event and conservative action budget before execution;
 * the task record, registered envelopes, and WorkPlan evaluator remain the only authority.
 */
export async function tickRoleOrchestration(
  request: RoleOrchestrationRequest,
  deps: RoleOrchestrationDependencies = {},
): Promise<RoleOrchestrationResult> {
  if (
    !request ||
    !request.role_plan ||
    !request.execution ||
    typeof request.journal_file !== 'string' ||
    !Array.isArray(request.execution.capability_cards) ||
    typeof request.event_id !== 'string' ||
    request.event_id.length === 0 ||
    request.event_id.length > MAX_EVENT_ID ||
    !request.limits ||
    !Number.isSafeInteger(request.limits.max_rounds) ||
    request.limits.max_rounds < 1 ||
    request.limits.max_rounds > MAX_ROUNDS_LIMIT ||
    !Number.isSafeInteger(request.limits.max_actions) ||
    request.limits.max_actions < 0 ||
    request.limits.max_actions > MAX_ACTION_LIMIT ||
    !Number.isSafeInteger(request.limits.max_attempts) ||
    request.limits.max_attempts < 1 ||
    request.limits.max_attempts > 1000
  )
    return failure(request, 'blocked', 'request_or_limits_invalid');

  const immutableRequest = request;

  if (
    request.repair_policy &&
    Array.isArray(request.repair_policy.authorizations)
  ) {
    const recovered = await recoverRoleRepairPlan(
      immutableRequest.role_plan,
      immutableRequest.execution,
      immutableRequest.repair_policy,
      immutableRequest.journal_file,
      immutableRequest.execution.task_root,
      immutableRequest.execution.plan_file,
      immutableRequest.limits.max_attempts,
    );
    request = {
      ...request,
      role_plan: recovered.role_plan,
      execution: recovered.execution,
    };
  }

  const expansion = expandRolePlan(request.role_plan);
  if (!expansion.ok)
    return failure(request, 'blocked', 'role_plan_expansion_refused');
  if (
    expansion.plan.task_id === '' ||
    request.execution.plan_file === '' ||
    request.execution.task_root === '' ||
    !path.isAbsolute(request.execution.task_root) ||
    !path.isAbsolute(request.execution.plan_file)
  )
    return failure(request, 'blocked', 'execution_paths_invalid');

  const requestDigest = digest({
    role_plan: immutableRequest.role_plan,
    execution: {
      task_root: immutableRequest.execution.task_root,
      plan_file: immutableRequest.execution.plan_file,
      binding_file: immutableRequest.execution.binding_file,
      caller: immutableRequest.execution.caller,
      caller_pane: immutableRequest.execution.caller_pane,
      capability_cards: immutableRequest.execution.capability_cards,
      max_concurrency: immutableRequest.execution.max_concurrency ?? 2,
    },
    limits: immutableRequest.limits,
    repair_policy: immutableRequest.repair_policy ?? null,
  });
  const inspect = deps.inspect ?? inspectWorkPlan;
  const execute = deps.execute ?? runWorkExecution;

  // Determine the maximum possible ready work from the explicit plan before reserving.
  // The authoritative inspection is repeated after reservation, immediately before effects.
  let initial: WorkPlanReport;
  try {
    initial = await inspect({
      taskRoot: request.execution.task_root,
      planFile: request.execution.plan_file,
    });
  } catch {
    return failure(request, 'blocked', 'authoritative_plan_inspection_failed');
  }
  if (
    !matchingExpansion(
      initial,
      expansion,
      request.execution.task_root,
      request.execution.plan_file,
    )
  )
    return failure(
      request,
      initial.status === 'incomplete' ? 'reconciliation-required' : 'blocked',
      'authoritative_plan_inspection_unavailable_or_mismatched',
    );
  const initialReady = [
    ...(initial.core?.ready_nodes ?? []),
    ...initial.nodes
      .filter((node) => node.dispatch_pending === true)
      .map((node) => node.node_id),
  ];
  const providedAssignments = new Set(
    request.execution.capability_cards.map((card) => card.assignment_id),
  );
  const candidateAssignments = new Set(
    expansion.plan.nodes
      .filter(
        (node) =>
          initialReady.includes(node.node_id) &&
          providedAssignments.has(node.assignment_id),
      )
      .map((node) => node.assignment_id),
  );
  const candidateCards = request.execution.capability_cards.filter((card) =>
    candidateAssignments.has(card.assignment_id),
  );
  const initialAggregate =
    initial.core === null ? null : aggregateRolePlan(expansion, initial.core);
  const actionsToReserve = Math.min(
    initialAggregate?.rejected_nodes.length && request.repair_policy
      ? 1
      : candidateCards.length,
    request.limits.max_actions,
  );

  const reservation = reserveTick(request, requestDigest, actionsToReserve);
  if (reservation.kind === 'invalid')
    return failure(request, 'blocked', reservation.reason);
  if (reservation.kind === 'locked')
    return failure(
      request,
      'reconciliation-required',
      'journal_lock_present_or_busy',
    );
  if (reservation.kind === 'budget')
    return failure(
      request,
      'budget-exhausted',
      'round_or_action_budget_exhausted',
      reservation.round,
    );
  if (reservation.kind === 'duplicate')
    return result(request, 'duplicate', null, 0, {
      prior_outcome:
        reservation.state === 'reserved'
          ? 'reserved_unknown_reconcile_before_new_event'
          : (reservation.outcome ?? 'completed'),
    });

  const round = reservation.round;
  const finish = (
    status: RoleOrchestrationStatus,
    values: Partial<
      Pick<
        RoleOrchestrationResult,
        'aggregate' | 'execution' | 'diagnostics' | 'updatedRequest'
      >
    > = {},
  ): RoleOrchestrationResult => {
    const saved = completeTick(request, requestDigest, status);
    return result(
      request,
      saved ? status : 'reconciliation-required',
      round,
      reservation.actions,
      {
        ...values,
        diagnostics: saved
          ? (values.diagnostics ?? [])
          : [...(values.diagnostics ?? []), 'journal_completion_unavailable'],
      },
    );
  };

  const repairRejected = async (
    aggregate: RolePlanAggregation,
    execution: WorkExecutionReport | null = null,
  ): Promise<RoleOrchestrationResult> => {
    if (!request.repair_policy) {
      const attempts = expansion.plan.nodes
        .filter((node) => aggregate.rejected_nodes.includes(node.node_id))
        .map((node) => node.attempt);
      const exhausted = attempts.some(
        (attempt) => attempt >= request.limits.max_attempts,
      );
      return finish(exhausted ? 'repair-exhausted' : 'repair-required', {
        aggregate,
        execution,
        diagnostics: [
          exhausted
            ? 'rejected_attempt_limit_reached'
            : 'rejected_work_requires_a_new_authoritatively_assigned_attempt_and_plan',
        ],
      });
    }
    if (reservation.actions < 1)
      return finish('budget-exhausted', {
        aggregate,
        ...(execution ? { execution } : {}),
        diagnostics: ['repair_action_budget_exhausted'],
      });
    const repair = await repairRejectedRoleNode(
      {
        task_root: request.execution.task_root,
        plan_file: request.execution.plan_file,
        journal_file: request.journal_file,
        event_id: request.event_id,
        role_plan: request.role_plan,
        execution: request.execution,
        policy: request.repair_policy,
        rejected_node_ids: aggregate.rejected_nodes,
        max_attempts: request.limits.max_attempts,
        max_actions: request.limits.max_actions,
        reserved_actions: reservation.actions,
      },
      deps.repair,
    );
    if (repair.status === 'repaired' && repair.role_plan) {
      return finish('repaired', {
        aggregate,
        execution,
        updatedRequest: {
          ...request,
          role_plan: repair.role_plan,
          execution: repair.execution ?? request.execution,
        },
        diagnostics: [repair.diagnostic],
      });
    }
    return finish(repair.status, {
      aggregate,
      execution,
      diagnostics: [repair.diagnostic],
    });
  };

  let current: WorkPlanReport;
  try {
    current = await inspect({
      taskRoot: request.execution.task_root,
      planFile: request.execution.plan_file,
    });
  } catch {
    return finish('reconciliation-required', {
      diagnostics: ['authoritative_inspection_failed_after_tick_reservation'],
    });
  }
  if (
    !matchingExpansion(
      current,
      expansion,
      request.execution.task_root,
      request.execution.plan_file,
    )
  )
    return finish(
      current.status === 'incomplete' ? 'reconciliation-required' : 'blocked',
      {
        diagnostics: ['plan_or_authoritative_evidence_changed'],
      },
    );
  const aggregate = aggregateRolePlan(expansion, current.core!);
  if (aggregate.outcome === 'accepted')
    return finish('accepted', { aggregate });
  if (aggregate.rejected_nodes.length > 0) return repairRejected(aggregate);
  if (aggregate.outcome === 'unknown' || aggregate.outcome === 'missing')
    return finish('reconciliation-required', {
      aggregate,
      diagnostics: ['authoritative_evidence_incomplete_or_uncertain'],
    });

  const ready = [
    ...(current.core?.ready_nodes ?? []),
    ...current.nodes
      .filter((node) => node.dispatch_pending === true)
      .map((node) => node.node_id),
  ];
  const selectedNodes = expansion.plan.nodes
    .filter(
      (node) =>
        ready.includes(node.node_id) &&
        candidateAssignments.has(node.assignment_id),
    )
    .slice(0, reservation.actions);
  if (selectedNodes.length === 0)
    return finish(
      reservation.actions === 0
        ? 'waiting'
        : aggregate.outcome === 'blocked'
          ? 'blocked'
          : 'waiting',
      {
        aggregate,
        diagnostics: [
          reservation.actions === 0
            ? candidateCards.length === 0
              ? 'no_pending_role_dispatch'
              : 'action_budget_exhausted_for_this_plan'
            : 'no_authoritatively_ready_assigned_role',
        ],
      },
    );
  const selectedAssignments = new Set(
    selectedNodes.map((node) => node.assignment_id),
  );
  const selectedCards = request.execution.capability_cards.filter((card) =>
    selectedAssignments.has(card.assignment_id),
  );
  if (selectedCards.length !== selectedNodes.length)
    return finish('blocked', {
      aggregate,
      diagnostics: ['ready_assignment_missing_explicit_capability_card'],
    });

  let execution: WorkExecutionReport;
  try {
    execution = await execute(
      {
        request: {
          ...request.execution,
          capability_cards: selectedCards,
          max_concurrency: Math.min(
            request.execution.max_concurrency ?? 2,
            selectedNodes.length,
          ),
        },
        apply: true,
      },
      deps.execution_adapter ? { adapter: deps.execution_adapter } : undefined,
    );
  } catch {
    // The tick reservation deliberately stays unresolved. A fresh event must inspect evidence;
    // this event is never replayed because a native outcome may be unknown.
    return result(
      request,
      'reconciliation-required',
      round,
      reservation.actions,
      {
        aggregate,
        diagnostics: ['execution_threw_after_durable_tick_reservation'],
      },
    );
  }

  let after: WorkPlanReport;
  try {
    after = await inspect({
      taskRoot: request.execution.task_root,
      planFile: request.execution.plan_file,
    });
  } catch {
    return finish('reconciliation-required', {
      aggregate,
      execution,
      diagnostics: ['post_execution_inspection_failed'],
    });
  }
  if (
    !matchingExpansion(
      after,
      expansion,
      request.execution.task_root,
      request.execution.plan_file,
    )
  )
    return finish('reconciliation-required', {
      aggregate,
      execution,
      diagnostics: ['post_execution_evidence_unavailable_or_mismatched'],
    });
  const finalAggregate = aggregateRolePlan(expansion, after.core!);
  if (finalAggregate.outcome === 'accepted')
    return finish('accepted', { aggregate: finalAggregate, execution });
  if (finalAggregate.rejected_nodes.length > 0)
    return repairRejected(finalAggregate, execution);
  if (execution.status === 'needs-reconciliation')
    return finish('reconciliation-required', {
      aggregate: finalAggregate,
      execution,
      diagnostics: ['work_execution_requires_reconciliation'],
    });
  if (execution.status === 'blocked')
    return finish('blocked', { aggregate: finalAggregate, execution });
  if (execution.nodes.some((node) => node.execution_status === 'dispatched'))
    return finish('dispatched', { aggregate: finalAggregate, execution });
  return finish('waiting', { aggregate: finalAggregate, execution });
}
