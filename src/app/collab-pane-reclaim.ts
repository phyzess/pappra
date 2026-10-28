import { findAttempt } from '../collab/lifecycle.js';
import {
  coordinatorLineage,
  hasSuccession,
  judgeEvidence,
} from '../collab/lineage.js';
import { contentDigest, readRegisteredMessage } from '../collab/envelope.js';
import { readRecord, transact } from '../collab/store.js';
import type { LaunchReservation, TaskRecord } from '../collab/types.js';
import {
  createHerdrBootstrapOps,
  type BootstrapPaneSnapshot,
  type HerdrBootstrapOps,
} from './collab-bootstrap-transport.js';
import { reportedSessionIdentity } from './collab-notify.js';
import path from 'node:path';

/**
 * Reclaim of panes that Pappra itself created for a finished worker.
 *
 * A pane is reclaimed only when every one of these is true, so an unrelated or reused pane
 * is never closed:
 * - the pane was returned by a bootstrap split recorded in this task's launch reservation;
 * - the bootstrap reservation completed and nothing has reclaimed it yet;
 * - the attempt completed and the coordinator registered an acceptance for it;
 * - the assignee holds no unreleased claim and has no other active attempt;
 * - the live pane still has the recorded ids and cwd, and hosts nothing but the exact
 *   assignee session (or nothing but an available shell), and is not busy or the caller's.
 *
 * Anything else leaves the pane open and reports why, so the next coordinator action can
 * retry. A close whose outcome is ambiguous is recorded and never retried automatically.
 */

export type PaneReclaimState =
  | 'closed'
  | 'skipped'
  | 'already_recorded'
  | 'planned'
  | 'unknown_not_closed'
  | 'close_failed';

export interface PaneReclaimEntry {
  readonly reservation_id: string;
  readonly subtask_id: string;
  readonly attempt: number;
  readonly pane_id: string | null;
  readonly state: PaneReclaimState;
  readonly code: string | null;
}

export interface PaneReclaimOptions {
  readonly taskRoot: string;
  readonly apply?: boolean;
  readonly clock?: number;
  /** Restrict to one attempt; omitted means every eligible reservation in the task. */
  readonly subtaskId?: string;
  readonly attempt?: number;
  /** The invoking coordinator pane. It is never closed. */
  readonly callerPane?: string | null;
  readonly ops?: Pick<
    HerdrBootstrapOps,
    'paneGet' | 'paneProcessInfo' | 'listAgents' | 'closePane' | 'verifyCaller'
  >;
}

const READ_TIMEOUT_MS = 10_000;
const BUSY_STATUSES = new Set(['working', 'blocked']);
const SHELL_NAMES = new Set(['bash', 'zsh', 'fish', 'nu', 'sh', 'dash']);

interface OwnedPane {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly terminalId: string;
  readonly cwd: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function bootstrapOf(entry: LaunchReservation): Record<string, unknown> | null {
  const value = (entry as { bootstrap?: unknown }).bootstrap;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ownedPane(bootstrap: Record<string, unknown>): OwnedPane | null {
  const paneId = text(bootstrap['created_pane_id']);
  const workspaceId = text(bootstrap['created_workspace_id']);
  const terminalId = text(bootstrap['created_terminal_id']);
  return paneId === null || workspaceId === null || terminalId === null
    ? null
    : { paneId, workspaceId, terminalId, cwd: text(bootstrap['created_cwd']) };
}

/**
 * Acceptance mirrors what the work-plan evaluator requires of the coordinator's ANSWER: the
 * deterministic id alone is not enough. The envelope must come from the current coordinator
 * and epoch, reply to the registered completed REPORT of this attempt, and carry an
 * `accepted` decision pinned to that report's digest.
 */
function accepted(
  taskRoot: string,
  record: TaskRecord,
  subtaskId: string,
  attempt: number,
): boolean {
  const coordinator = record.coordinator;
  if (coordinator === null) return false;
  const baseId = `accept-${subtaskId}-${attempt}`;
  // After a succession the decision may carry an epoch-qualified id (`...-e<epoch>`) and may have
  // been made by an earlier coordinator of the same authority line, so every applied decision of
  // this attempt is a candidate and each is judged by the lineage. Without one, the only
  // candidate is the base id judged against the current coordinator, exactly as before.
  const lineage = coordinatorLineage(record);
  const succession = hasSuccession(lineage);
  // Decisions are found by `reply_to`, never by constructed id: any applied ANSWER that replies to
  // a REPORT of this attempt. Without a succession the only candidate is the base id.
  const reportIds = new Set(
    record.messages
      .filter(
        (message) =>
          message.type === 'REPORT' &&
          message.subtask_id === subtaskId &&
          message.attempt === attempt,
      )
      .map((message) => message.message_id),
  );
  const candidates = record.messages.filter(
    (message) =>
      message.type === 'ANSWER' &&
      message.state !== 'rejected' &&
      (succession
        ? message.reply_to !== null && reportIds.has(message.reply_to)
        : message.message_id === baseId),
  );
  return candidates.some((entry) =>
    decisionHolds(taskRoot, record, lineage, succession, entry, {
      subtaskId,
      attempt,
    }),
  );
}

function decisionHolds(
  taskRoot: string,
  record: TaskRecord,
  lineage: ReturnType<typeof coordinatorLineage>,
  succession: boolean,
  entry: TaskRecord['messages'][number],
  target: { readonly subtaskId: string; readonly attempt: number },
): boolean {
  const coordinator = record.coordinator;
  if (coordinator === null) return false;
  const { subtaskId, attempt } = target;
  const answer = readRegisteredMessage(taskRoot, entry.message_id);
  if (
    answer === null ||
    answer.type !== 'ANSWER' ||
    answer.subtask_id !== subtaskId ||
    answer.attempt !== attempt ||
    answer.reply_to === null ||
    answer.reply_to === undefined
  )
    return false;
  if (succession) {
    if (
      typeof answer.owner_epoch !== 'number' ||
      !judgeEvidence(lineage, {
        epoch: answer.owner_epoch,
        signer: answer.from,
        appliedAt: entry.applied_at,
      }).valid
    )
      return false;
  } else if (
    answer.from.agent_id !== coordinator.agent_id ||
    answer.owner_epoch !== coordinator.owner_epoch
  )
    return false;
  const decision = (answer.body as Record<string, unknown> | undefined)?.[
    'acceptance'
  ] as Record<string, unknown> | null | undefined;
  if (
    decision === null ||
    decision === undefined ||
    decision['decision'] !== 'accepted' ||
    decision['assignment_id'] !== subtaskId ||
    decision['attempt'] !== attempt
  )
    return false;
  const report = readRegisteredMessage(taskRoot, answer.reply_to);
  return (
    report !== null &&
    report.type === 'REPORT' &&
    report.subtask_id === subtaskId &&
    report.attempt === attempt &&
    report.body?.status === 'completed' &&
    decision['report_digest'] === contentDigest(report)
  );
}

/** Pure eligibility over the persisted record; live checks happen separately. */
function recordBlocker(
  taskRoot: string,
  record: TaskRecord,
  entry: LaunchReservation,
  checkShared = true,
): string | null {
  const bootstrap = bootstrapOf(entry);
  if (bootstrap === null || bootstrap['phase'] !== 'completed')
    return 'bootstrap_not_completed';
  const owned = ownedPane(bootstrap);
  if (owned === null) return 'pane_not_owned';
  // The cwd observed at split is the only fact that tells two panes in one directory apart.
  if (owned.cwd === null) return 'owned_pane_cwd_not_recorded';
  const attempt = findAttempt(record, entry.subtask_id, entry.attempt);
  if (attempt === null || attempt.state !== 'completed')
    return 'attempt_not_completed';
  if (!accepted(taskRoot, record, entry.subtask_id, entry.attempt))
    return 'attempt_not_accepted';
  const assignee = attempt.assignee.agent_id;
  if (
    record.claims.some(
      (claim) =>
        claim.released_at === null && claim.holder.agent_id === assignee,
    )
  )
    return 'claims_not_released';
  if (
    record.attempts.some(
      (other) =>
        other !== attempt &&
        other.assignee.agent_id === assignee &&
        other.state !== 'completed' &&
        other.state !== 'failed' &&
        other.state !== 'cancelled',
    )
  )
    return 'assignee_has_other_work';
  if (!checkShared) return null;
  // One pane, several reservations: reclaim only when every sharer is itself eligible and
  // none has an unresolved close. An ambiguous sibling close is never replayed from here.
  for (const other of record.launch_reservations ?? []) {
    if (other === entry) continue;
    const owned = bootstrapOf(other);
    const pane = owned === null ? null : ownedPane(owned);
    if (pane === null || pane.paneId !== bootstrapPane(bootstrap)) continue;
    const prior = reclaimState(owned!);
    if (prior === 'closed') return 'pane_already_closed_by_sibling';
    if (prior !== null && prior !== 'close_failed')
      return 'pane_close_pending_for_sibling';
    const blocked = recordBlocker(taskRoot, record, other, false);
    if (blocked !== null) return 'pane_shared_by_ineligible_reservation';
  }
  return null;
}

function bootstrapPane(bootstrap: Record<string, unknown>): string | null {
  return text(bootstrap['created_pane_id']);
}

function reclaimState(bootstrap: Record<string, unknown>): string | null {
  const prior = bootstrap['reclaim'];
  if (prior === undefined) return null;
  const state =
    typeof prior === 'object' && prior !== null
      ? (prior as Record<string, unknown>)['state']
      : null;
  return typeof state === 'string' ? state : 'unknown';
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

type OpsPane = NonNullable<PaneReclaimOptions['ops']>;

async function liveBlocker(
  ops: OpsPane,
  record: TaskRecord,
  entry: LaunchReservation,
  pane: OwnedPane,
  callerPane: string | null,
): Promise<{ code: string; unknown: boolean } | null> {
  if (callerPane !== null && callerPane === pane.paneId)
    return { code: 'pane_is_caller', unknown: false };
  const current = await ops.paneGet(pane.paneId, READ_TIMEOUT_MS);
  if (!current.ok) return { code: current.code, unknown: true };
  const live: BootstrapPaneSnapshot = current.value;
  const attempt = findAttempt(record, entry.subtask_id, entry.attempt)!;
  const recordedCwd = pane.cwd;
  if (
    live.workspaceId !== pane.workspaceId ||
    live.terminalId !== pane.terminalId ||
    live.cwd === null ||
    recordedCwd === null ||
    !samePath(live.cwd, recordedCwd)
  )
    return { code: 'owned_pane_identity_drift', unknown: false };
  if (BUSY_STATUSES.has(live.agentStatus))
    return { code: 'agent_busy', unknown: false };
  const listed = await ops.listAgents();
  if (!listed.ok)
    return { code: 'herdr_agent_list_unavailable', unknown: true };
  const inPane = listed.agents.filter((agent) => agent.paneId === pane.paneId);
  if (inPane.length > 1)
    return { code: 'multiple_agents_in_pane', unknown: false };
  if (inPane.length === 1) {
    const agent = inPane[0]!;
    const observed = reportedSessionIdentity(
      agent.sessionKind,
      agent.sessionValue,
    );
    if (
      agent.harness !== attempt.assignee.harness ||
      observed.status !== 'match' ||
      observed.identity !== attempt.assignee.session_id
    )
      return { code: 'pane_agent_not_assignee', unknown: false };
    if (BUSY_STATUSES.has(agent.status))
      return { code: 'agent_busy', unknown: false };
    return null;
  }
  // The agent is gone: only an untouched available shell may be reclaimed.
  const process = await ops.paneProcessInfo(pane.paneId, READ_TIMEOUT_MS);
  if (!process.ok) return { code: process.code, unknown: true };
  const facts = process.value;
  const name =
    facts.foregroundProcesses.length === 1
      ? facts.foregroundProcesses[0]!.name.split(/[\\/]/)
          .at(-1)!
          .replace(/^[-]+/, '')
          .replace(/\.exe$/i, '')
          .toLowerCase()
      : null;
  return facts.shellPid !== null &&
    facts.shellPid > 0 &&
    facts.foregroundProcessGroupId === facts.shellPid &&
    facts.foregroundProcesses[0]?.pid === facts.shellPid &&
    name !== null &&
    SHELL_NAMES.has(name)
    ? null
    : { code: 'owned_pane_not_available_shell', unknown: false };
}

function recordReclaim(
  options: PaneReclaimOptions,
  record: TaskRecord,
  reservationId: string,
  value: Record<string, unknown>,
  expectFresh = false,
): boolean {
  const actor = record.coordinator?.agent_id ?? 'coordinator';
  const outcome = transact<null>(options.taskRoot, {
    actor,
    purpose: 'pane-reclaim',
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    apply: (current) => {
      const entry = (current.launch_reservations ?? []).find(
        (item) => item.reservation_id === reservationId,
      ) as
        | (LaunchReservation & { bootstrap?: Record<string, unknown> })
        | undefined;
      if (entry?.bootstrap === undefined)
        return { ok: false as const, reason: 'reservation_missing' };
      // The transaction, not the earlier snapshot, is the guard against a concurrent sweep.
      const existing = reclaimState(entry.bootstrap);
      if (expectFresh && existing !== null && existing !== 'close_failed')
        return { ok: false as const, reason: 'reclaim_already_recorded' };
      entry.bootstrap = {
        ...entry.bootstrap,
        reclaim: {
          ...value,
          at: new Date(options.clock ?? Date.now()).toISOString(),
        },
      };
      return {
        record: current,
        op: 'pane-reclaim',
        summary: { reservation_id: reservationId, ...value },
        result: null,
      };
    },
  });
  return outcome.ok;
}

/** Reclaim every eligible Pappra-created pane of a finished, accepted worker. */
export async function reclaimOwnedPanes(
  options: PaneReclaimOptions,
): Promise<readonly PaneReclaimEntry[]> {
  const record = readRecord(options.taskRoot);
  if (record === null) return [];
  const apply = options.apply !== false;
  // The invoking pane is verified live once, never trusted from the request: a self-declared
  // or omitted pane must not be able to switch the caller guard off.
  let callerPane: string | null | undefined;
  let callerCode: string | null = null;
  const results: PaneReclaimEntry[] = [];
  let ops = options.ops;
  for (const entry of record.launch_reservations ?? []) {
    if (
      (options.subtaskId !== undefined &&
        entry.subtask_id !== options.subtaskId) ||
      (options.attempt !== undefined && entry.attempt !== options.attempt)
    )
      continue;
    const bootstrap = bootstrapOf(entry);
    if (bootstrap === null || ownedPane(bootstrap) === null) continue;
    const pane = ownedPane(bootstrap)!;
    const base = {
      reservation_id: entry.reservation_id,
      subtask_id: entry.subtask_id,
      attempt: entry.attempt,
      pane_id: pane.paneId,
    };
    const priorState = reclaimState(bootstrap);
    // A definite close failure stays retryable; a pending or ambiguous close is reconciled.
    if (priorState !== null && priorState !== 'close_failed') {
      results.push({ ...base, state: 'already_recorded', code: null });
      continue;
    }
    const blocked = recordBlocker(options.taskRoot, record, entry);
    if (blocked !== null) {
      results.push({ ...base, state: 'skipped', code: blocked });
      continue;
    }
    if (!apply) {
      results.push({ ...base, state: 'planned', code: null });
      continue;
    }
    ops ??= createHerdrBootstrapOps({ taskRoot: options.taskRoot });
    if (callerPane === undefined) {
      const caller = await ops.verifyCaller(options.callerPane ?? null);
      if (caller.ok) callerPane = caller.caller.paneId;
      else {
        callerPane = null;
        callerCode = caller.code;
      }
    }
    if (
      callerCode !== null ||
      callerPane === null ||
      callerPane === undefined
    ) {
      results.push({
        ...base,
        state: 'skipped',
        code: callerCode ?? 'caller_unverified',
      });
      continue;
    }
    const live = await liveBlocker(ops, record, entry, pane, callerPane);
    if (live !== null) {
      results.push({
        ...base,
        state: live.unknown ? 'unknown_not_closed' : 'skipped',
        code: live.code,
      });
      continue;
    }
    // Intent first: an ambiguous close is reconciled, never replayed.
    if (
      !recordReclaim(
        options,
        record,
        entry.reservation_id,
        {
          state: 'close_pending',
          pane_id: pane.paneId,
        },
        true,
      )
    ) {
      results.push({
        ...base,
        state: 'unknown_not_closed',
        code: 'reclaim_intent_not_recorded',
      });
      continue;
    }
    const closed = await ops.closePane({ paneId: pane.paneId });
    const state: PaneReclaimState = closed.ok
      ? 'closed'
      : closed.status === 'unknown'
        ? 'unknown_not_closed'
        : 'close_failed';
    recordReclaim(options, record, entry.reservation_id, {
      state,
      pane_id: pane.paneId,
      code: closed.ok ? null : closed.code,
    });
    results.push({ ...base, state, code: closed.ok ? null : closed.code });
  }
  return results;
}
