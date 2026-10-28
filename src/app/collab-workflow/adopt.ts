import fs from 'node:fs';
import path from 'node:path';
import { readSuccessorOutcome } from '../collab-successor/journal.js';
import { findAttempt } from '../../collab/lifecycle.js';
import {
  coordinatorLineage,
  hasSuccession,
  judgeEvidence,
  lineageContains,
  type CoordinatorLineage,
} from '../../collab/lineage.js';
import {
  WORK_PLAN_EVALUATION_SCHEMA,
  WORK_PLAN_SCHEMA,
} from '../../collab/work-plan.js';
import { object as isRecord } from '../../infra/validation.js';
import type { TaskRecord } from '../../collab/types.js';
import {
  workflowManifestPath,
  workflowWorkPlanPath,
} from '../../schemas/collab-workflow.js';
import type { WorkflowAdoptRequest } from '../../schemas/collab-workflow.js';
import type {
  CollabBinding,
  CollabBindingParticipant,
} from '../../schemas/collaboration.js';
import { createHerdrBootstrapOps } from '../collab-bootstrap-transport.js';
import { COLLAB_ROLE_PLAN_SCHEMA } from '../collab-role-plan.js';
import {
  reportedSessionIdentity,
  type HerdrListResult,
} from '../collab-notify.js';
import {
  bindingGenerationPath,
  currentBindingFile,
  readBindingGeneration,
} from './binding-generation.js';
import {
  openWorkflowTask,
  readBoundedJson,
  revalidateWorkflowTask,
  sameCoordinator,
  writeJsonExclusive,
} from './context.js';
import { unsupportedSurfaces } from './succession-surfaces.js';
import {
  emptyResult,
  type WorkflowBlocker,
  type WorkflowResult,
} from './types.js';

export interface AdoptDetail {
  readonly binding_file: string;
  readonly generation_epoch: number | null;
  readonly attempts_by_epoch: Readonly<Record<string, number>>;
  readonly reports_awaiting_decision: number;
  readonly deferred_reviewers: readonly string[];
  readonly open_uncertainty: number;
}

function hasValidDecision(
  record: TaskRecord,
  lineage: ReturnType<typeof coordinatorLineage>,
  subtaskId: string,
  attempt: number,
): boolean {
  // A decision is an applied ANSWER replying to a REPORT of this attempt, judged by the lineage.
  const reports = new Set(
    record.messages
      .filter(
        (entry) =>
          entry.type === 'REPORT' &&
          entry.subtask_id === subtaskId &&
          entry.attempt === attempt,
      )
      .map((entry) => entry.message_id),
  );
  return record.messages.some(
    (entry) =>
      entry.type === 'ANSWER' &&
      entry.state === 'applied' &&
      entry.reply_to !== null &&
      reports.has(entry.reply_to) &&
      typeof entry.owner_epoch === 'number' &&
      judgeEvidence(lineage, {
        epoch: entry.owner_epoch,
        signer: entry.from,
        appliedAt: entry.applied_at,
      }).valid,
  );
}

/** The pane and Herdr agent name the launcher recorded for a successor thread, if any. */
function launchedPaneOf(
  taskRoot: string,
  sessionId: string,
): { readonly pane_id: string; readonly agent_name: string } | null {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(taskRoot, 'successor'));
  } catch {
    return null;
  }
  const matches: { pane_id: string; agent_name: string }[] = [];
  for (const name of names) {
    if (!name.endsWith('.outcome.json')) continue;
    const outcome = readSuccessorOutcome(
      taskRoot,
      name.slice(0, -'.outcome.json'.length),
    );
    if (
      outcome.ok &&
      outcome.value.status === 'launched' &&
      outcome.value.identity?.session_id === sessionId
    )
      matches.push({
        pane_id: outcome.value.pane_id,
        agent_name: outcome.value.agent_name,
      });
  }
  // Several launches for one thread that disagree on the pane are ambiguous: never pick one.
  const first = matches[0];
  return first !== undefined &&
    matches.every(
      (item) =>
        item.pane_id === first.pane_id && item.agent_name === first.agent_name,
    )
    ? first
    : null;
}

/**
 * The adopt request document plus its optional explicit list of role artifacts. Role plans and
 * role event journals sit at caller-chosen paths, so adopt cannot find them by itself; naming
 * them lets it check each one (docs/mid-cohort-succession-spec.md, section 8). The field is
 * replaced rather than intersected so the type holds whether or not the request schema already
 * carries it.
 */
export type AdoptRequest = Omit<WorkflowAdoptRequest, 'extra_paths'> & {
  readonly extra_paths?: readonly string[] | undefined;
};

const MAX_EXTRA_PATHS = 16;

/** Role subsystem documents that pin one owner epoch at the top level. */
const EPOCH_PINNING_DOCUMENTS = new Map<string, string>([
  [COLLAB_ROLE_PLAN_SCHEMA, 'role plan'],
  [WORK_PLAN_SCHEMA, 'work plan'],
  [WORK_PLAN_EVALUATION_SCHEMA, 'work plan evaluation'],
]);
/** Private to collab-role-orchestration.ts; if it is renamed there the file reads as unrecognized. */
const ROLE_JOURNAL_SCHEMA = 'pappra/collab-role-orchestration-journal/1';

const UNLISTED_ARTIFACTS =
  'Role plans, role event journals and the goal-based worker path (collab prepare/start, work-run) keep current-epoch equality; they live at caller-chosen paths and cannot be detected here. Do not use them after a succession.';
const UNLISTED_ARTIFACTS_AFTER_EXTRA_PATHS =
  'Role artifacts that extra_paths does not list and the goal-based worker path (collab prepare/start, work-run) keep current-epoch equality; they live at caller-chosen paths and cannot be detected here. Do not use them after a succession.';

/** What a role subsystem file is and the owner epoch it pins, if it pins one. */
function recognizeRoleArtifact(document: unknown): {
  readonly kind: string;
  readonly pins: boolean;
  readonly epoch: unknown;
} | null {
  if (!isRecord(document)) return null;
  const schema = document['schema'];
  const pinning =
    typeof schema === 'string'
      ? EPOCH_PINNING_DOCUMENTS.get(schema)
      : undefined;
  if (pinning !== undefined)
    return { kind: pinning, pins: true, epoch: document['owner_epoch'] };
  if (schema === ROLE_JOURNAL_SCHEMA)
    return { kind: 'role orchestration journal', pins: false, epoch: null };
  // A role-run request nests its role plan and carries no schema of its own.
  const plan = document['role_plan'];
  if (isRecord(plan) && plan['schema'] === COLLAB_ROLE_PLAN_SCHEMA)
    return {
      kind: 'role orchestration request',
      pins: true,
      epoch: plan['owner_epoch'],
    };
  return null;
}

/** True when `file` is the workflow's own sealed plan, which follows the coordinator lineage. */
function isSealedWorkflowPlan(taskRoot: string, file: string): boolean {
  const sealed = workflowWorkPlanPath(taskRoot);
  try {
    return fs.realpathSync(file) === fs.realpathSync(sealed);
  } catch {
    return path.resolve(file) === path.resolve(sealed);
  }
}

/**
 * One warning for one explicitly listed role artifact: whether it depends on an owner epoch and
 * whether that epoch is still the current one. Reads one bounded regular file and writes nothing.
 * The warning carries a fixed kind label and the epoch number, never file content. A file that
 * cannot be read or recognized is reported as not checked and is never silently skipped.
 */
function describeExtraPath(
  taskRoot: string,
  file: string,
  lineage: CoordinatorLineage,
): string {
  const label = `extra_paths ${JSON.stringify(file)}`;
  const unchecked = (why: string) =>
    `${label}: not checked (${why}); treat it as depending on the current epoch.`;
  // The sealed plan is no role artifact: reading it as one would claim a refusal that never happens.
  if (isSealedWorkflowPlan(taskRoot, file))
    return `${label}: the sealed workflow plan follows the coordinator lineage; there is nothing to check.`;
  const read = readBoundedJson(file, 'extra_paths entry');
  if (!read.ok) return unchecked(read.code);
  const artifact = recognizeRoleArtifact(read.value);
  if (artifact === null)
    return unchecked('neither a role plan nor a role journal');
  if (!artifact.pins)
    return `${label}: ${artifact.kind} records no owner epoch; its events are tied to a role plan by plan id, so check that plan as well.`;
  const epoch = artifact.epoch;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1)
    return `${label}: ${artifact.kind} carries no usable owner_epoch; treat it as depending on the current epoch.`;
  const current = lineage.current;
  if (current === null)
    return `${label}: ${artifact.kind} pins owner epoch ${String(epoch)}; the task records no current epoch to compare it with.`;
  if (epoch === current)
    return `${label}: ${artifact.kind} pins owner epoch ${String(epoch)}, the current epoch. It works only while this coordinator holds that epoch and fails closed after the next succession.`;
  const relation = !lineage.valid
    ? ''
    : lineageContains(lineage, epoch)
      ? ', an earlier epoch of this task'
      : ', which is not an epoch of this task';
  return `${label}: ${artifact.kind} pins owner epoch ${String(epoch)}${relation}; the current epoch is ${String(current)}. Executing through it (work-run, role-run) keeps current-epoch equality and is refused; only plan inspection follows the lineage. Rebuild it under epoch ${String(current)} or stop using it.`;
}

/**
 * Without `extra_paths` adopt can only say that role artifacts cannot be detected. With it, each
 * listed file is checked and the generic text narrows to what is still undetectable.
 */
function roleArtifactWarnings(
  taskRoot: string,
  extraPaths: readonly string[],
  lineage: CoordinatorLineage,
): string[] {
  const listed = [...new Set(extraPaths)];
  if (listed.length === 0) return [UNLISTED_ARTIFACTS];
  const warnings = listed
    .slice(0, MAX_EXTRA_PATHS)
    .map((file) => describeExtraPath(taskRoot, file, lineage));
  if (listed.length > MAX_EXTRA_PATHS)
    warnings.push(
      `extra_paths lists ${String(listed.length)} entries; only the first ${String(MAX_EXTRA_PATHS)} were checked.`,
    );
  warnings.push(UNLISTED_ARTIFACTS_AFTER_EXTRA_PATHS);
  return warnings;
}

export interface AdoptOptions {
  readonly apply?: boolean;
  /** Herdr agent listing; injected by tests, observed through Herdr otherwise. */
  readonly listAgents?: () => Promise<HerdrListResult>;
  /**
   * Codex thread the CLI runs in, from CODEX_THREAD_ID. Herdr reports no session for a Codex
   * pane and Codex tools run in a shared daemon, so for a Codex coordinator the thread id is the
   * identity evidence and the pane is only checked to host a Codex agent.
   */
  readonly callerCodexThread?: string | null;
}

/**
 * The successor coordinator adopts a task after a mid-cohort coordinator succession.
 *
 * Plan is read-only. Apply writes exactly one document, the next binding generation, and changes
 * no attempt, plan, assignment or message. The caller must be the current coordinator and its
 * pane must be observed through Herdr as that very session.
 */
export async function applyAdopt(
  request: AdoptRequest,
  options: AdoptOptions = {},
): Promise<WorkflowResult<AdoptDetail>> {
  const writing = options.apply !== false;
  const base = emptyResult<AdoptDetail>('adopt', writing);
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
  const warnings: string[] = [];
  const coordinator = record.coordinator;
  const lineage = coordinatorLineage(record);

  if (!sameCoordinator(coordinator, request.caller))
    blockers.push({
      code: 'adopt_not_coordinator',
      detail: 'Only the current coordinator identity may adopt a task.',
      next_action: 'Run adopt as the successor coordinator session.',
    });
  if (!lineage.valid)
    blockers.push({
      code: 'adopt_lineage_invalid',
      detail: `The coordinator lineage cannot be established: ${lineage.detail}`,
      next_action:
        'Inspect the coordinator handoff history; an invalid lineage keeps every check strict.',
    });
  else if (!hasSuccession(lineage))
    blockers.push({
      code: 'adopt_no_succession',
      detail: 'No coordinator handoff has completed for this task.',
      next_action:
        'Adopt applies only after a completed coordinator handoff; nothing to do.',
    });

  // Surfaces that keep current-epoch equality and gain no lineage awareness (section 8).
  for (const finding of unsupportedSurfaces(record, task.taskRoot))
    blockers.push({
      code: finding.code,
      detail: finding.detail,
      next_action: finding.next_action,
    });
  warnings.push(
    ...roleArtifactWarnings(task.taskRoot, request.extra_paths ?? [], lineage),
  );

  const manifest = readBoundedJson(
    workflowManifestPath(task.taskRoot),
    'workflow manifest',
  );
  const deferred: string[] = [];
  if (manifest.ok) {
    const value = manifest.value as {
      assignments?: {
        subtask_id?: string;
        attempt?: number;
        deferred?: boolean;
      }[];
    };
    for (const item of value.assignments ?? [])
      if (
        item.deferred === true &&
        findAttempt(
          record,
          String(item.subtask_id ?? ''),
          Number(item.attempt ?? 1),
        ) === null
      )
        deferred.push(String(item.subtask_id ?? ''));
  }
  const attemptsByEpoch: Record<string, number> = {};
  for (const attempt of record.attempts) {
    const key = String(attempt.owner_epoch ?? 'unknown');
    attemptsByEpoch[key] = (attemptsByEpoch[key] ?? 0) + 1;
  }
  const detail: AdoptDetail = {
    binding_file: currentBindingFile(task.taskRoot),
    generation_epoch: lineage.current,
    attempts_by_epoch: attemptsByEpoch,
    reports_awaiting_decision: record.attempts.filter(
      (item) =>
        item.state === 'completed' &&
        !hasValidDecision(record, lineage, item.subtask_id, item.attempt),
    ).length,
    deferred_reviewers: deferred,
    open_uncertainty: (record.uncertainty ?? []).filter(
      (item) => !item.resolved_at,
    ).length,
  };

  const common = {
    ...base,
    task_id: record.task_id,
    task_root: task.taskRoot,
    domain_root: record.domain_root,
    state_revision: record.state_revision,
    principal: { ...request.caller, role: 'coordinator' as const },
    warnings,
    detail,
  };
  if (blockers.length > 0 || coordinator === null || lineage.current === null)
    return {
      ...common,
      status: 'refused',
      blockers,
      next_action: blockers[0]?.next_action ?? null,
    };

  // The pane must be observed as this very coordinator session. A Claude or Pi coordinator is
  // observed through the Herdr agent listing. A Codex coordinator cannot be: Codex runs its tools
  // in a sandboxed shared daemon that may not reach the Herdr socket, and Herdr reports no session
  // for a Codex pane. Its identity is the thread id in CODEX_THREAD_ID, and its pane and Herdr
  // agent name are the ones the launcher recorded for that very thread.
  let herdrAgent: string | null = null;
  let observeFailure = '';
  if (coordinator.harness === 'codex') {
    const launched = launchedPaneOf(task.taskRoot, coordinator.session_id);
    if ((options.callerCodexThread ?? null) !== coordinator.session_id)
      observeFailure =
        'CODEX_THREAD_ID does not identify this coordinator session; run adopt from the successor Codex session.';
    else if (launched === null || launched.pane_id !== request.caller_pane)
      observeFailure = `Pane ${request.caller_pane} is not the pane the launcher recorded for this Codex thread.`;
    else herdrAgent = launched.agent_name;
  } else {
    const listing = await (
      options.listAgents ??
      (() => createHerdrBootstrapOps({ taskRoot: task.taskRoot }).listAgents())
    )();
    const agent = listing.ok
      ? listing.agents.find((item) => item.paneId === request.caller_pane)
      : undefined;
    if (!listing.ok)
      observeFailure = `Herdr could not list agents: ${listing.detail}`;
    else if (
      agent === undefined ||
      agent.name === null ||
      agent.harness !== coordinator.harness ||
      reportedSessionIdentity(agent.sessionKind, agent.sessionValue)
        .identity !== coordinator.session_id
    )
      observeFailure = `Pane ${request.caller_pane} is not observed as this coordinator session.`;
    else herdrAgent = agent.name;
  }
  if (herdrAgent === null)
    return {
      ...common,
      status: 'refused',
      blockers: [
        {
          code: 'adopt_pane_unobserved',
          detail: observeFailure,
          next_action:
            'Run adopt from the successor session in its own pane, with Herdr reachable.',
        },
      ],
      next_action: 'Run adopt from the successor session in its own pane.',
    };

  // Next generation: the previous generation's participants, the previous coordinator's entry
  // dropped unless it is also a worker of this task, and the successor's own entry added.
  const previous = lineage.entries[lineage.entries.length - 2]!;
  const source = readBindingGeneration(detail.binding_file);
  if (source === null)
    return {
      ...common,
      status: 'refused',
      blockers: [
        {
          code: 'adopt_binding_unreadable',
          detail: 'The sealed task binding is missing or unreadable.',
          next_action:
            'Restore the sealed binding; adoption never invents routing.',
        },
      ],
      next_action: 'Restore the sealed binding.',
    };
  const stillWorker = (agentId: string, sessionId: string | null): boolean =>
    record.attempts.some(
      (item) =>
        item.assignee.agent_id === agentId &&
        (sessionId === null || item.assignee.session_id === sessionId),
    );
  const entry: CollabBindingParticipant = {
    agent_id: coordinator.agent_id,
    harness: coordinator.harness ?? request.caller.harness,
    cwd: request.caller.cwd,
    herdr_agent: herdrAgent,
    pane_id: request.caller_pane,
    native_session_id: coordinator.session_id,
  };
  const participants = [
    ...source.participants.filter(
      (item) =>
        item.agent_id !== coordinator.agent_id &&
        (item.agent_id !== previous.identity.agent_id ||
          stillWorker(item.agent_id, previous.identity.session_id)),
    ),
    entry,
  ];
  // The binding schema caps participants; truncating would drop the successor's own entry and
  // burn this epoch's generation, so a full binding is refused instead.
  if (participants.length > 16)
    return {
      ...common,
      status: 'refused',
      blockers: [
        {
          code: 'adopt_binding_full',
          detail: `The next binding generation would hold ${String(participants.length)} participants; a binding holds at most 16.`,
          next_action:
            'Release a finished participant from the binding before adopting; adoption never drops the successor entry.',
        },
      ],
      next_action: 'Reduce the participants of the binding.',
    };
  const generation: CollabBinding = { ...source, participants };
  const file = bindingGenerationPath(task.taskRoot, lineage.current);
  if (!writing)
    return {
      ...common,
      status: 'planned',
      ok: true,
      detail: { ...detail, binding_file: file },
      next_action: null,
    };
  const changed = await revalidateWorkflowTask(task);
  if (!changed.ok)
    return {
      ...common,
      status: 'invalid',
      blockers: [
        {
          code: changed.code,
          detail: changed.message,
          next_action: changed.nextAction,
        },
      ],
      next_action: changed.nextAction,
    };
  const written = writeJsonExclusive(task.taskRoot, file, generation);
  if (written.status === 'created' || written.status === 'identical')
    return {
      ...common,
      status: 'applied',
      ok: true,
      detail: { ...detail, binding_file: file },
      next_action: null,
    };
  return {
    ...common,
    status: 'needs-reconciliation',
    blockers: [
      {
        code:
          written.status === 'conflict'
            ? 'adopt_binding_conflict'
            : 'adopt_binding_unsafe',
        detail:
          written.status === 'conflict'
            ? 'A different binding generation already exists for this epoch.'
            : `The binding generation could not be written safely: ${written.detail}`,
        next_action:
          'Inspect the existing generation; adoption never rewrites a file.',
      },
    ],
    next_action: 'Inspect the existing binding generation.',
  };
}
