import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { errorCode } from './validation.js';
interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  start_identity: string;
}
interface OwnedState {
  pgid: number;
  leader_pid: number;
  incarnation: string | null;
  child: ChildProcess;
}
interface SnapshotState {
  handle: unknown;
  original_pgid: number;
  root_pid: number;
  root_identity: string;
  groups: { pgid: number; members: ProcessRow[] }[];
  members: Omit<ProcessRow, 'state'>[];
}
interface StopOptions {
  termMs?: number;
  killMs?: number;
  pollMs?: number;
}
import { execFileSync, spawn } from 'node:child_process';

// Scoped Unix process-group helper. It exists to extend a stop beyond the single owned parent
// into the exact process group that parent created, and nothing else.
//
// Ownership is unforgeable: every authoritative field (pgid, leader pid, incarnation, child)
// lives in a private WeakMap keyed by an immutable, frozen opaque token. A caller-supplied
// object, a spread copy, or an attempted field write can therefore never redirect a stop to
// another group.
//
// Boundaries this module states rather than hides:
//   * Only tokens returned by `spawnOwnedGroup` are accepted; there is deliberately no API
//     that takes an arbitrary pid or pgid.
//   * Signals go to `-pgid` of that one group. Other sessions, other groups and arbitrary
//     process trees are never signalled.
//   * A descendant that calls `setsid` (or otherwise escapes the group) is explicitly outside
//     the guarantee; the helper can only report what the group still contains.
//   * "Stopped" means no live (non-zombie) member remained in the group. It is not proof of
//     task-level side effects; that proof stays task-specific.
//   * No supervisor or daemon is kept: state lives in the private map for the handle's life.
//   * A child `error` event (for example a nonexistent executable) is always handled, so a
//     failed spawn refuses without leaking an unhandled ChildProcess error.

const STATE = new WeakMap<object, OwnedState>();
const DEFAULT_TERM_MS = 2000;
const DEFAULT_KILL_MS = 2000;
const DEFAULT_POLL_MS = 25;
const MAX_WAIT_MS = 30000;

export class OwnedGroupRefusal extends Error {
  constructor(
    public readonly code: string,
    public readonly detail: string | null = null,
  ) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

function refuse(code: string, detail: string | null = null): never {
  throw new OwnedGroupRefusal(code, detail);
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `ps` is the portable-enough observation on macOS and Linux; null means "not observable". */
function psTable(): ProcessRow[] | null {
  let out;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,state=,lstart='], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    });
  } catch {
    return null;
  }
  const rows = [];
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      state: match[4]!,
      start_identity: `${match[1]}@${match[5]}`,
    });
  }
  return rows;
}

function psRows() {
  const rows = psTable();
  if (rows === null) return null;
  return rows.map(({ pid, pgid, state, start_identity }) => ({
    pid,
    pgid,
    state,
    start_identity,
  }));
}

/** Members of this exact owned group, or null when the host cannot observe process tables. */
export function observeGroup(handle: unknown) {
  const state = assertOwned(handle);
  const rows = psRows();
  if (rows === null) return null;
  return rows.filter((row) => row.pgid === state.pgid);
}

function live<T extends { state: string }>(rows: T[]): T[] {
  return rows.filter((row) => row.state !== 'Z');
}

function assertOwned(handle: unknown): OwnedState {
  const state =
    handle !== null && typeof handle === 'object'
      ? STATE.get(handle)
      : undefined;
  if (!state) refuse('unforgeable_handle_required');
  return state;
}

/**
 * Spawn one child in its own detached process group and keep the exact incarnation of the
 * group leader in private state. Only the returned frozen token can later stop that group.
 */
export function spawnOwnedGroup(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): object {
  if (typeof command !== 'string' || !command || command.includes('\0'))
    refuse('command_required');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    refuse('arguments_invalid');
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd: options.cwd ?? undefined,
      env: options.env ?? undefined,
      detached: true,
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    refuse(
      'spawn_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
  // Attach before any refusal: a failed spawn emits 'error' asynchronously and must never
  // surface as an unhandled event that would crash the caller.
  let spawnError: Error | null = null;
  child.on('error', (error) => {
    spawnError ??= error;
  });
  for (const stream of [child.stdout, child.stderr, child.stdin])
    stream?.on('error', () => {
      /* drained */
    });
  if (!child.pid)
    refuse('spawn_failed', spawnError === null ? null : String(spawnError));
  const created = psRows();
  const leader =
    created === null
      ? null
      : (created.find((row) => row.pid === child.pid) ?? null);
  const handle = Object.freeze({});
  STATE.set(handle, {
    pgid: child.pid,
    leader_pid: child.pid,
    incarnation: leader?.start_identity ?? null,
    child,
  });
  return handle;
}

/**
 * Genuine-handle-only accessor: returns the ChildProcess created by this exact handle. The
 * handle remains a frozen opaque token, so a caller can never pass an arbitrary pid/pgid as
 * authority for signalling.
 */
export function ownedChild(handle: unknown) {
  return assertOwned(handle).child;
}

/** Observes only this handle's own group: parent exit is not group exit. */
export function groupState(handle: unknown) {
  const state = assertOwned(handle);
  const members = observeGroup(handle);
  const rows = members ?? [];
  return {
    observable: members !== null,
    pgid: state.pgid,
    parent_exited:
      state.child.exitCode !== null || state.child.signalCode !== null,
    members: rows.map(({ pid, pgid, state: rowState, start_identity }) => ({
      pid,
      pgid,
      state: rowState,
      start_identity,
    })),
    live_members: live(rows).map((row) => row.pid),
    group_live: live(rows).length > 0,
  };
}

async function waitForNoLiveMembers(
  state: OwnedState,
  budgetMs: number,
  pollMs: number,
) {
  const until = Date.now() + budgetMs;
  for (;;) {
    const rows = psRows();
    if (rows === null) refuse('process_observation_unsupported');
    const remaining = live(rows.filter((row) => row.pgid === state.pgid));
    if (!remaining.length) return remaining;
    if (Date.now() >= until) return remaining;
    await delay(Math.min(pollMs, Math.max(1, until - Date.now())));
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error;
  }
}

function signalOwnGroup(state: OwnedState, signal: NodeJS.Signals) {
  signalGroup(state.pgid, signal);
}

/**
 * Bounded TERM then KILL against this handle's own group. Refuses when the group leader was
 * replaced by a different incarnation, and reports `stopped: false` while any member lives.
 */
export async function stopOwnedGroup(
  handle: unknown,
  options: StopOptions = {},
) {
  const state = assertOwned(handle);
  const termMs = bounded(
    options.termMs ?? DEFAULT_TERM_MS,
    'term_ms_out_of_range',
  );
  const killMs = bounded(
    options.killMs ?? DEFAULT_KILL_MS,
    'kill_ms_out_of_range',
  );
  const pollMs = Math.min(
    bounded(options.pollMs ?? DEFAULT_POLL_MS, 'poll_ms_out_of_range'),
    termMs || 1,
  );
  const observed = observeGroup(handle);
  if (observed === null) refuse('process_observation_unsupported');
  if (!live(observed).length) {
    return {
      stopped: true,
      already_stopped: true,
      term_sent: false,
      kill_sent: false,
      remaining: [],
    };
  }
  const leader =
    observed.find((row) => row.pid === state.leader_pid && row.state !== 'Z') ??
    null;
  if (
    leader &&
    state.incarnation &&
    leader.start_identity !== state.incarnation
  )
    refuse('incarnation_mismatch', leader.start_identity);
  if (!leader && !state.incarnation)
    refuse(
      'incarnation_unavailable',
      'the group leader is gone and no incarnation was ever recorded',
    );
  signalOwnGroup(state, 'SIGTERM');
  let remaining = await waitForNoLiveMembers(state, termMs, pollMs);
  let killSent = false;
  if (remaining.length) {
    signalOwnGroup(state, 'SIGKILL');
    killSent = true;
    remaining = await waitForNoLiveMembers(state, killMs, pollMs);
  }
  return {
    stopped: remaining.length === 0,
    already_stopped: false,
    term_sent: true,
    kill_sent: killSent,
    remaining: remaining.map((row) => ({
      pid: row.pid,
      state: row.state,
      start_identity: row.start_identity,
    })),
  };
}

// ---------------------------------------------------------------------------
// Read-only owned-descendant-tree snapshot (opt-in controlled runtime)
// ---------------------------------------------------------------------------

const SNAPSHOTS = new WeakMap<object, SnapshotState>();

function liveMembersOf(pgid: number, rows: ProcessRow[]) {
  return rows.filter((row) => row.pgid === pgid && row.state !== 'Z');
}

/**
 * Read-only snapshot of the genuine owned root and the processes that are actually its
 * descendants (tree traversal from the private root pid), keeping exact PID + start identities
 * and the members of every group those processes belong to. The snapshot is a frozen opaque
 * token backed by private state; no caller-supplied PID/PGID ever becomes authority, and the
 * caller's groups are captured before any native interrupt so orphaned groups remain targeted.
 *
 * A group is only captured when its leader is the owned root or a captured descendant AND every
 * current member of that group is itself a proven descendant of the owned root. A group leader
 * alone can never grant authority over an unrelated process that merely joined the group, so a
 * contaminated tree is refused wholesale instead of being stopped.
 */
export function snapshotOwnedTree(handle: unknown) {
  const state = assertOwned(handle);
  const rows = psTable();
  if (rows === null) refuse('process_observation_unsupported');
  const root =
    rows.find((row) => row.pid === state.leader_pid && row.state !== 'Z') ??
    null;
  if (!root)
    refuse(
      'owned_root_not_observed',
      'the owned group root is no longer observable',
    );
  if (state.incarnation !== null && root.start_identity !== state.incarnation)
    refuse('incarnation_mismatch', root.start_identity);
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid)!.push(row);
  }
  const descendants: ProcessRow[] = [];
  const seen = new Set([root.pid]);
  const queue = [root.pid];
  while (queue.length) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      descendants.push(child);
      queue.push(child.pid);
    }
  }
  const captured = [root, ...descendants];
  const capturedPids = new Set(captured.map((row) => row.pid));
  const groupIds = [...new Set(captured.map((row) => row.pgid))];
  for (const pgid of groupIds) {
    // A captured group may only be targeted when its leader is the owned root or a captured
    // descendant; this prevents a snapshot from ever authorizing a shared/unrelated group.
    if (pgid !== state.pgid && !capturedPids.has(pgid))
      refuse('group_leader_unverified', String(pgid));
    for (const member of rows.filter((row) => row.pgid === pgid)) {
      // Every current member of a captured group must itself be a proven descendant of the owned
      // root. A leader alone does not confer authority over a foreign joiner, so its presence
      // refuses the whole snapshot rather than widening the stop to an unrelated process.
      if (!capturedPids.has(member.pid))
        refuse(
          'foreign_group_member',
          `pid ${member.pid} in pgid ${pgid} is not a proven descendant of the owned root`,
        );
    }
  }
  const groups = groupIds.map((pgid) => ({
    pgid,
    members: rows
      .filter((row) => row.pgid === pgid)
      .map((row) => ({
        pid: row.pid,
        ppid: row.ppid,
        pgid: row.pgid,
        state: row.state,
        start_identity: row.start_identity,
      })),
  }));
  const snapshot = Object.freeze({
    scope: 'owned-descendant-tree-snapshot',
    captured_at: new Date().toISOString(),
    original_pgid: state.pgid,
    root: {
      pid: root.pid,
      pgid: root.pgid,
      start_identity: root.start_identity,
    },
    descendants: descendants.map((row) => ({
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      start_identity: row.start_identity,
    })),
    groups: groups.map((group) => ({
      pgid: group.pgid,
      member_count: group.members.length,
    })),
  });
  // Ownership is private: only the genuine group handle that captured this snapshot may stop it.
  SNAPSHOTS.set(snapshot, {
    handle,
    original_pgid: state.pgid,
    root_pid: root.pid,
    root_identity: root.start_identity,
    groups,
    members: captured.map((row) => ({
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      start_identity: row.start_identity,
    })),
  });
  return snapshot;
}

/**
 * Re-derives a fail-closed verdict from one fresh process table. Returns `{ ok: true as const, targets }`
 * only when every live member of every captured group is a captured member with its exact
 * incarnation, and every still-live captured PID is still in its captured group. Anything else —
 * an uncaptured joiner, a reused id, a captured member that moved PGID — is `{ ok: false as const }` with a
 * refusal code, so a caller can refuse before signalling or report an unproven stop.
 */
function proofFromRows(meta: SnapshotState, rows: ProcessRow[]) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const group of meta.groups) {
    for (const member of liveMembersOf(group.pgid, rows)) {
      const expected = group.members.find((entry) => entry.pid === member.pid);
      if (!expected)
        return {
          ok: false as const,
          code: 'group_membership_unproven',
          detail: `pid ${member.pid} in pgid ${group.pgid} was not captured`,
        };
      if (expected.start_identity !== member.start_identity)
        return {
          ok: false as const,
          code: 'group_identity_unproven',
          detail: `pid ${member.pid} incarnation changed`,
        };
      if (member.pgid !== expected.pgid)
        return {
          ok: false as const,
          code: 'group_membership_unproven',
          detail: `pid ${member.pid} is not in its captured group`,
        };
    }
  }
  for (const member of meta.members) {
    const now = byPid.get(member.pid);
    // Gone or a zombie: this captured member is no longer live.
    if (!now || now.state === 'Z') continue;
    // A reused PID belongs to a different incarnation, so the captured member is already gone;
    // an unchanged identity that sits in another group is a moved member and stays unproven.
    if (now.start_identity !== member.start_identity) continue;
    if (now.pgid !== member.pgid)
      return {
        ok: false as const,
        code: 'group_member_moved',
        detail: `pid ${member.pid} moved from pgid ${member.pgid} to pgid ${now.pgid}`,
      };
  }
  const targets = [
    ...new Set(
      meta.groups
        .filter((group) => liveMembersOf(group.pgid, rows).length)
        .map((group) => group.pgid),
    ),
  ];
  return { ok: true as const, targets };
}

function liveCapturedGroupRows(meta: SnapshotState, rows: ProcessRow[]) {
  return meta.groups
    .flatMap((group) => liveMembersOf(group.pgid, rows))
    .map((row) => ({
      pid: row.pid,
      pgid: row.pgid,
      state: row.state,
      start_identity: row.start_identity,
    }));
}

async function waitForGroupsEmpty(
  targets: number[],
  budgetMs: number,
  pollMs: number,
) {
  const until = Date.now() + budgetMs;
  for (;;) {
    const rows = psTable();
    if (rows === null) refuse('process_observation_unsupported');
    const remaining = targets.flatMap((pgid) => liveMembersOf(pgid, rows));
    if (!remaining.length) return { empty: true, remaining: [] };
    if (Date.now() >= until) return { empty: false, remaining };
    await delay(Math.min(pollMs, Math.max(1, until - Date.now())));
  }
}

/**
 * Bounded global TERM then KILL across the snapshotted groups (one shared budget, never
 * multiplied by group count). Only the runtime whose owned group captured the snapshot may stop
 * it. Signalling happens after every current live member of every captured group matches a
 * snapshotted PID + start identity and the same captured PGID, and every still-live captured PID
 * is still in its captured group; an uncaptured joiner, a reused id, a moved captured member or an
 * observation failure refuses unproven and signals nothing. Immediately before escalation the
 * same verdict is recomputed, so a group whose membership or incarnation changed during TERM is
 * never SIGKILLed; a `stopped: true` result requires that same positive verdict on the final
 * observation.
 */
export async function stopSnapshottedTree(
  snapshot: unknown,
  options: StopOptions & { handle?: object } = {},
) {
  const meta =
    snapshot !== null && typeof snapshot === 'object'
      ? SNAPSHOTS.get(snapshot)
      : undefined;
  if (!meta) refuse('unforgeable_snapshot_required');
  if (options.handle === undefined || options.handle !== meta.handle)
    refuse(
      'snapshot_owner_mismatch',
      'the snapshot was captured by a different owned group',
    );
  const termMs = bounded(
    options.termMs ?? DEFAULT_TERM_MS,
    'term_ms_out_of_range',
  );
  const killMs = bounded(
    options.killMs ?? DEFAULT_KILL_MS,
    'kill_ms_out_of_range',
  );
  const pollMs = Math.min(
    bounded(options.pollMs ?? DEFAULT_POLL_MS, 'poll_ms_out_of_range'),
    termMs || 1,
  );
  const rows = psTable();
  if (rows === null) refuse('process_observation_unsupported');
  const initial = proofFromRows(meta, rows);
  if (!initial.ok) refuse(initial.code, initial.detail);
  const base = {
    scope: 'owned-descendant-tree-snapshot',
    original_pgid: meta.original_pgid,
    root_pid: meta.root_pid,
    groups: meta.groups.map((group) => group.pgid),
    targeted_groups: initial.targets,
  };
  if (!initial.targets.length) {
    return {
      ...base,
      stopped: true,
      already_stopped: true,
      term_sent: false,
      kill_sent: false,
      remaining: [],
      group_observed: true,
    };
  }
  for (const pgid of initial.targets) signalGroup(pgid, 'SIGTERM');
  let state = await waitForGroupsEmpty(initial.targets, termMs, pollMs);
  let killSent = false;
  if (!state.empty) {
    // Re-observe and revalidate immediately before escalation. A group whose membership or whose
    // member incarnation changed during TERM is never escalated: the call stays fail-closed and
    // signals nothing further.
    const recheckRows = psTable();
    if (recheckRows === null) {
      return {
        ...base,
        stopped: false,
        already_stopped: false,
        term_sent: true,
        kill_sent: false,
        group_observed: false,
        escalation_refused: 'process_observation_unsupported',
        remaining: [],
      };
    }
    const escalation = proofFromRows(meta, recheckRows);
    if (!escalation.ok) {
      return {
        ...base,
        stopped: false,
        already_stopped: false,
        term_sent: true,
        kill_sent: false,
        group_observed: true,
        escalation_refused: escalation.code,
        escalation_detail: escalation.detail,
        remaining: liveCapturedGroupRows(meta, recheckRows),
      };
    }
    if (escalation.targets.length) {
      for (const pgid of escalation.targets) signalGroup(pgid, 'SIGKILL');
      killSent = true;
      state = await waitForGroupsEmpty(escalation.targets, killMs, pollMs);
    }
  }
  const finalRows = psTable();
  if (finalRows === null) {
    return {
      ...base,
      stopped: false,
      already_stopped: false,
      term_sent: true,
      kill_sent: killSent,
      remaining: [],
      group_observed: false,
    };
  }
  const proof = proofFromRows(meta, finalRows);
  if (!proof.ok) {
    // A moved or otherwise unproven captured member makes the positive proof unavailable: this is
    // explicitly not `stopped`, even when the captured groups themselves look empty.
    return {
      ...base,
      stopped: false,
      already_stopped: false,
      term_sent: true,
      kill_sent: killSent,
      group_observed: true,
      final_proof_refused: proof.code,
      final_proof_detail: proof.detail,
      remaining: liveCapturedGroupRows(meta, finalRows),
    };
  }
  const remaining = liveCapturedGroupRows(meta, finalRows);
  return {
    ...base,
    stopped: remaining.length === 0,
    already_stopped: false,
    term_sent: true,
    kill_sent: killSent,
    remaining,
    group_observed: true,
  };
}
function bounded(value: number, code: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WAIT_MS)
    refuse(code);
  return value;
}
