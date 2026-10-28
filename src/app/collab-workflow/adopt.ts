import { findAttempt } from '../../collab/lifecycle.js';
import {
  coordinatorLineage,
  hasSuccession,
  judgeEvidence,
} from '../../collab/lineage.js';
import type { TaskRecord } from '../../collab/types.js';
import { workflowManifestPath } from '../../schemas/collab-workflow.js';
import type { WorkflowAdoptRequest } from '../../schemas/collab-workflow.js';
import type {
  CollabBinding,
  CollabBindingParticipant,
} from '../../schemas/collaboration.js';
import { createHerdrBootstrapOps } from '../collab-bootstrap-transport.js';
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

export interface AdoptOptions {
  readonly apply?: boolean;
  /** Herdr agent listing; injected by tests, observed through Herdr otherwise. */
  readonly listAgents?: () => Promise<HerdrListResult>;
}

/**
 * The successor coordinator adopts a task after a mid-cohort coordinator succession.
 *
 * Plan is read-only. Apply writes exactly one document, the next binding generation, and changes
 * no attempt, plan, assignment or message. The caller must be the current coordinator and its
 * pane must be observed through Herdr as that very session.
 */
export async function applyAdopt(
  request: WorkflowAdoptRequest,
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
    'Role plans, role event journals and the goal-based worker path (collab prepare/start, work-run) keep current-epoch equality; they live at caller-chosen paths and cannot be detected here. Do not use them after a succession.',
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

  // The pane must be observed through Herdr as this very coordinator session.
  const listing = await (
    options.listAgents ??
    (() => createHerdrBootstrapOps({ taskRoot: task.taskRoot }).listAgents())
  )();
  const agent = listing.ok
    ? listing.agents.find((item) => item.paneId === request.caller_pane)
    : undefined;
  if (
    agent === undefined ||
    agent.name === null ||
    agent.harness !== coordinator.harness ||
    reportedSessionIdentity(agent.sessionKind, agent.sessionValue).identity !==
      coordinator.session_id
  )
    return {
      ...common,
      status: 'refused',
      blockers: [
        {
          code: 'adopt_pane_unobserved',
          detail: listing.ok
            ? `Pane ${request.caller_pane} is not observed as this coordinator session.`
            : `Herdr could not list agents: ${listing.detail}`,
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
    harness: coordinator.harness,
    cwd: request.caller.cwd,
    herdr_agent: agent.name,
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
