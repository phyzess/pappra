import type {
  TaskRecord,
  Resource,
  ResourceInput,
  ReservationInput,
} from './types.js';
import { isAssignment, isCard, type Assignment } from './contracts.js';
import { parseJson } from './validation.js';
export interface AdmissionOptions {
  assignmentFile: string;
  capabilitiesFile: string;
  taskRoot: string;
  cwd: string;
  sessionId?: string | null;
  harness?: string | null;
  profile?: string | null;
  launchKind?: string;
  discovery?: boolean;
  resumeSelector?: string | null;
  now?: number;
  maxAgeMinutes?: number;
}
export interface SettleOptions {
  reservationId: string;
  outcome: string;
  exitCode?: number | null;
  sessionId?: string | null;
  runId?: string | null;
  evidenceRef?: string | null;
  runner?: string | null;
  detail?: string | null;
  expectedIdentity?: string | null;
  capabilityEvidence?: string | null;
  identityStatus?: string | null;
  cleanExit?: boolean;
  clock?: number;
}
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso, readRecord, transact } from './store.js';
import { preflight } from './preflight.js';
import { findAttempt, openUncertainty } from './lifecycle.js';
import { claimsOverlap, describeResource, pathRelation } from './canonical.js';

// Explicit launcher for one native pilot execution.
//
// It exists so the receiving harness's argv, cwd, tool allowance, timeout and identity
// are recorded next to the native events, and so no harness is invoked by accident: the
// command refuses to run without `--confirm-run true`.
//
// Version-pinned profiles (observed 2026-10-15):
//   pi 1.2.0        : `--print --session-id <uuid> --tools <allowlist> --no-mcp`
//   codex 0.162.1   : `exec --json -C <cwd> -s <sandbox>`; resume via `exec resume <thread>`
//   claude 2.1.287  : `--print --output-format stream-json --setting-sources user
//                      --tools <allowlist> --strict-mcp-config --mcp-config {"mcpServers":{}}
//                      --settings {"disableAllHooks":true} --max-budget-usd <n>`
//
// No model or reasoning-effort override is supplied for any harness; the only limits are
// the per-run timeout, the tool allowlist and (for Claude) the requested API budget cap.

export const TOOL_PROFILES = {
  pi: {
    writer: 'read,bash,write,replace,replace_match',
    // The Pi reviewer profile has no write/edit tool, but bash stays available so an
    // independent verifier can run the frozen suite. That is a tool limit, not a sandbox.
    reviewer: 'read,bash,anchor_grep',
  },
  claude: {
    writer: 'Read,Edit,Write,Skill',
    reviewer: 'Read,Skill',
  },
};

/** The runner an assignment must name for a given harness; the launcher will not substitute one. */
const RUNNER_FOR_HARNESS: Readonly<Record<string, string>> = Object.freeze({
  pi: 'pi-cli',
  codex: 'codex-exec',
  claude: 'claude-cli',
});

/** Returns a runner only for an own supported harness key with a string value. */
export function runnerForHarness(harness: unknown): string | null {
  if (
    typeof harness !== 'string' ||
    !Object.hasOwn(RUNNER_FOR_HARNESS, harness)
  )
    return null;
  const runner = RUNNER_FOR_HARNESS[harness];
  return typeof runner === 'string' && runner.length > 0 ? runner : null;
}

/** Whether the assignment can name the native session before the process starts. Pi and Claude
 *  accept an explicit session id; `codex exec` chooses the thread id itself. */
const PRE_BOUND_IDENTITY: Record<string, boolean> = {
  pi: true,
  codex: false,
  claude: true,
};

/**
 * Pre-dispatch admission. A launcher that started a native process without checking the
 * assignment, the capability snapshot, the collaboration record and the actual resource
 * ownership would be an automatic entry that bypasses the whole contract, so it refuses.
 *
 * Two modes exist:
 *   work       the default; requires a runtime-ready capability card
 *   discovery  the restricted path that produces the first runtime observation; it may use a
 *              declared card but must require no capability at all, so it cannot claim
 *              anything it has not observed
 */
export function admitLaunch({
  assignmentFile,
  capabilitiesFile,
  taskRoot,
  cwd,
  sessionId,
  harness = null,
  profile = null,
  launchKind = 'first',
  discovery = false,
  resumeSelector = null,
  now = Date.now(),
  maxAgeMinutes = 30,
}: AdmissionOptions) {
  const read = (file: string): unknown => {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error(`Unsupported JSON file: ${file}`);
    return parseJson(fs.readFileSync(file, 'utf8'));
  };
  const assignment = read(assignmentFile);
  if (!isAssignment(assignment))
    throw new Error('Invalid assignment structure');
  const card = read(capabilitiesFile);
  if (!isCard(card)) throw new Error('Invalid capability card structure');
  const checks: Record<string, unknown>[] = [];
  const selector = resumeSelector ?? null;

  // 1. the contract must describe the execution that is about to start
  if (harness && assignment.assignee.harness !== harness) {
    return {
      ok: false as const,
      reason: 'harness_contract_mismatch',
      checks,
      expected: assignment.assignee.harness,
      actual: harness,
    };
  }
  const requestedHarness = harness ?? assignment.assignee.harness;
  const expectedRunner = runnerForHarness(requestedHarness);
  if (expectedRunner === null) {
    return {
      ok: false as const,
      reason: 'unsupported_harness',
      checks,
      actual: requestedHarness,
    };
  }
  if (assignment.runner.name !== expectedRunner) {
    return {
      ok: false as const,
      reason: 'runner_contract_mismatch',
      checks,
      expected: assignment.runner.name,
      actual: expectedRunner,
    };
  }
  if (
    profile &&
    assignment.runner?.profile &&
    assignment.runner.profile !== profile
  ) {
    return {
      ok: false as const,
      reason: 'profile_contract_mismatch',
      checks,
      expected: assignment.runner.profile,
      actual: profile,
    };
  }
  if (
    profile &&
    !assignment.runner?.profile &&
    assignment.runner?.mode === 'review-only' &&
    profile !== 'reviewer'
  ) {
    return {
      ok: false as const,
      reason: 'profile_contract_mismatch',
      checks,
      expected: 'reviewer',
      actual: profile,
    };
  }

  // 1c. A `first` launch that lets the CLI choose the native identity (Codex) cannot be
  // justified by a card observed for another session: that path must be a discovery run.
  const preBoundIdentity =
    PRE_BOUND_IDENTITY[harness ?? assignment.assignee.harness] === false
      ? null
      : assignment.assignee.session_id;
  if (launchKind === 'first' && !preBoundIdentity && !discovery) {
    return {
      ok: false as const,
      reason: 'new_session_requires_discovery',
      checks,
      detail:
        'this harness chooses the native session id itself, so its first launch must be a discovery run and the work dispatch must continue the discovered identity',
    };
  }

  // 2. the request must be internally consistent about starting versus continuing
  if (launchKind === 'resume' && !selector) {
    return {
      ok: false as const,
      reason: 'resume_selector_required',
      checks,
      detail: 'a resume launch must name the recorded native session',
    };
  }
  if (launchKind === 'first' && selector) {
    return {
      ok: false as const,
      reason: 'unexpected_resume_selector',
      checks,
      detail: 'a first launch must not carry a resume selector',
    };
  }

  // 3. identity of the execution context
  if (!path.isAbsolute(taskRoot ?? ''))
    return {
      ok: false as const,
      reason: 'task_root_required',
      checks,
      detail:
        'the launcher must verify the collaboration record before dispatch',
    };
  if (fs.realpathSync(assignment.assignee.cwd) !== fs.realpathSync(cwd)) {
    return {
      ok: false as const,
      reason: 'cwd_mismatch',
      checks,
      detail: `launcher cwd ${cwd} is not the assigned cwd ${assignment.assignee.cwd}`,
    };
  }
  if (sessionId && assignment.assignee.session_id !== sessionId) {
    return {
      ok: false as const,
      reason: 'session_mismatch',
      checks,
      detail: `launcher session ${sessionId} is not the assigned session ${assignment.assignee.session_id}`,
    };
  }
  const record = readRecord(taskRoot);
  if (!record)
    return {
      ok: false as const,
      reason: 'task_record_missing',
      checks,
      detail: taskRoot,
    };
  if (record.task_id !== assignment.task_id)
    return {
      ok: false as const,
      reason: 'task_mismatch',
      checks,
      detail: `${record.task_id} != ${assignment.task_id}`,
    };
  if (record.dispatch_frozen)
    return { ok: false as const, reason: 'dispatch_frozen', checks };
  const currentEpoch = record.coordinator?.owner_epoch ?? null;
  const assignmentEpoch = assignment.coordinator?.owner_epoch ?? null;
  if (
    currentEpoch !== null &&
    assignmentEpoch !== null &&
    currentEpoch !== assignmentEpoch
  ) {
    return {
      ok: false as const,
      reason: 'stale_epoch',
      checks,
      expected: currentEpoch,
      actual: assignmentEpoch,
    };
  }

  // 4. the attempt must exist and be the one this contract was registered for
  const attempt = findAttempt(
    record,
    assignment.assignment_id,
    assignment.attempt,
  );
  if (!attempt)
    return {
      ok: false as const,
      reason: 'attempt_not_registered',
      checks,
      detail: `${assignment.assignment_id}#${assignment.attempt}`,
    };
  if (
    attempt.assignee &&
    (attempt.assignee.agent_id !== assignment.assignee.agent_id ||
      attempt.assignee.session_id !== assignment.assignee.session_id)
  ) {
    return {
      ok: false as const,
      reason: 'assignee_mismatch',
      checks,
      expected: attempt.assignee,
      actual: assignment.assignee,
    };
  }
  const liveAssignmentDigest = digestFile(assignmentFile);
  if (
    attempt.assignment_digest &&
    attempt.assignment_digest !== liveAssignmentDigest
  ) {
    return {
      ok: false as const,
      reason: 'assignment_digest_mismatch',
      checks,
      expected: attempt.assignment_digest,
      actual: liveAssignmentDigest,
      detail: 'the assignment differs from the one registered for this attempt',
    };
  }
  if (
    attempt.assignment_ref &&
    path.resolve(attempt.assignment_ref) !== path.resolve(assignmentFile)
  ) {
    return {
      ok: false as const,
      reason: 'assignment_ref_mismatch',
      checks,
      expected: attempt.assignment_ref,
      actual: assignmentFile,
    };
  }
  const liveInputDigest = assignment.inputs?.[0]
    ? digestFile(assignment.inputs[0].ref)
    : null;
  if (
    attempt.input_revision &&
    liveInputDigest &&
    attempt.input_revision !== liveInputDigest
  ) {
    return {
      ok: false as const,
      reason: 'input_revision_mismatch',
      checks,
      expected: attempt.input_revision,
      actual: liveInputDigest,
    };
  }

  // 5. capability readiness, or the restricted discovery path
  if (discovery) {
    const requiredSkills = (assignment.required?.skills ?? []).length;
    const requiredTools = (assignment.required?.tools ?? []).length;
    if (requiredSkills || requiredTools) {
      return {
        ok: false as const,
        reason: 'discovery_requires_no_capabilities',
        checks,
        required_skills: requiredSkills,
        required_tools: requiredTools,
      };
    }
    checks.push({
      check: 'preflight',
      status: 'skipped',
      detail: 'discovery mode requires no capability',
    });
  } else {
    const result = preflight(assignment, card, { now, maxAgeMinutes });
    checks.push({
      check: 'preflight',
      status: result.status,
      blockers: result.blockers,
      warnings: result.warnings,
    });
    if (result.status !== 'ready')
      return {
        ok: false as const,
        reason: 'capability_preflight_not_ready',
        checks,
        preflight: result,
      };
  }
  if (
    card.session_id !== assignment.assignee.session_id ||
    (card.cwd !== undefined && !samePath(card.cwd, cwd))
  ) {
    return {
      ok: false as const,
      reason: 'capabilities_identity_mismatch',
      checks,
    };
  }

  // 6. may this attempt start at all
  if (['completed', 'failed', 'cancelled'].includes(attempt.state)) {
    return {
      ok: false as const,
      reason: 'attempt_already_closed',
      checks,
      state: attempt.state,
    };
  }
  if (attempt.state === 'needs_input' && attempt.awaiting === 'approval') {
    return {
      ok: false as const,
      reason: 'awaiting_approval',
      checks,
      detail:
        'an approval block is answered by the user, not by a new dispatch',
    };
  }
  if (
    hasPendingCancellation(record, assignment.assignment_id, assignment.attempt)
  ) {
    return {
      ok: false as const,
      reason: 'cancel_unconfirmed',
      checks,
      detail:
        'native stop must be reconciled before any new launch or continuation',
    };
  }
  const observation = attempt.native?.observation ?? 'unknown';
  if (
    attempt.state === 'unknown' ||
    (attempt.state === 'running' && observation !== 'confirmed')
  ) {
    return {
      ok: false as const,
      reason: 'attempt_state_unknown',
      checks,
      detail:
        'the native state of this attempt is unconfirmed; reconcile it before dispatching anything',
    };
  }
  if (attempt.state === 'running' && launchKind !== 'resume') {
    return {
      ok: false as const,
      reason: 'attempt_already_running',
      checks,
      detail:
        'a running attempt may only be continued with --launch-kind resume',
    };
  }
  if (launchKind === 'first' && attempt.native?.run_id) {
    return {
      ok: false as const,
      reason: 'already_launched',
      checks,
      detail: `attempt already has native run ${attempt.native.run_id}`,
    };
  }
  // A native session is the instance, not the attempt: the run discovered by an earlier,
  // closed attempt of the same subtask is a legitimate continuation target. That is what makes
  // "discovery → work" a supported sequence instead of a manual state edit.
  const resumable = [
    {
      attempt: attempt.attempt,
      session_id: attempt.native?.session_id ?? null,
      run_id: attempt.native?.run_id ?? null,
    },
    ...(record.attempts ?? [])
      .filter(
        (item) =>
          item.subtask_id === assignment.assignment_id &&
          item.attempt !== assignment.attempt &&
          ['completed', 'failed', 'cancelled'].includes(item.state),
      )
      .map((item) => ({
        attempt: item.attempt,
        session_id: item.native?.session_id ?? null,
        run_id: item.native?.run_id ?? null,
      })),
  ].filter((item) => item.session_id || item.run_id);
  if (launchKind === 'resume' && !resumable.length) {
    return {
      ok: false as const,
      reason: 'nothing_to_resume',
      checks,
      detail:
        'neither this attempt nor a closed earlier attempt of the subtask has a recorded native run',
    };
  }
  if (
    launchKind !== 'resume' &&
    !['assigned', 'accepted'].includes(attempt.state)
  ) {
    return {
      ok: false as const,
      reason: 'attempt_not_startable',
      checks,
      state: attempt.state,
    };
  }
  if (selector) {
    const recorded = [
      ...new Set(
        resumable
          .flatMap((item) => [item.session_id, item.run_id])
          .filter(Boolean),
      ),
    ];
    if (!recorded.includes(selector)) {
      return {
        ok: false as const,
        reason: 'resume_selector_mismatch',
        checks,
        expected: recorded,
        actual: selector,
      };
    }
  }

  // 7. the resources the contract asks for must actually be held by this assignee
  const claims = (record.claims ?? []).filter((item) => !item.released_at);
  const resourceChecks: Record<string, unknown>[] = [];
  for (const resource of assignment.resources ?? []) {
    const descriptor = describeResource(describeRequest(resource));
    // Containment, not symmetric overlap: holding a child file does not grant the parent
    // directory, while holding the directory does grant everything inside it.
    const covering = claims.filter((item) => claimCovers(item, descriptor));
    if (resource.access === 'write') {
      const held = covering.find(
        (item) =>
          item.access === 'write' &&
          item.holder?.agent_id === assignment.assignee.agent_id &&
          item.holder?.session_id === assignment.assignee.session_id &&
          (item.subtask_id ?? null) === assignment.assignment_id &&
          (item.attempt ?? null) === assignment.attempt,
      );
      if (!held) {
        resourceChecks.push({
          resource: descriptor.key,
          access: 'write',
          status: 'not_held',
        });
        return {
          ok: false as const,
          reason: 'resource_not_held',
          checks,
          resources: resourceChecks,
          detail: `no active write claim covering ${descriptor.key} held by ${assignment.assignee.agent_id}/${assignment.assignee.session_id} for ${assignment.assignment_id}#${assignment.attempt}`,
        };
      }
      if (held.resource_epoch !== resource.resource_epoch) {
        resourceChecks.push({
          resource: descriptor.key,
          access: 'write',
          status: 'epoch_mismatch',
          expected: resource.resource_epoch,
          actual: held.resource_epoch,
        });
        return {
          ok: false as const,
          reason: 'resource_epoch_mismatch',
          checks,
          resources: resourceChecks,
          expected: resource.resource_epoch,
          actual: held.resource_epoch,
        };
      }
      resourceChecks.push({
        resource: descriptor.key,
        access: 'write',
        status: 'held',
        resource_epoch: held.resource_epoch,
        claim_id: held.claim_id,
      });
    } else {
      // Reading overlaps symmetrically: a writer holding a child file conflicts with a reader of
      // the whole directory, so the containment rule is only for issuing write authority.
      const blocker = claims
        .filter((item) => claimsOverlap(item, descriptor))
        .find(
          (item) =>
            item.access === 'write' &&
            !(
              item.holder?.agent_id === assignment.assignee.agent_id &&
              item.holder?.session_id === assignment.assignee.session_id
            ),
        );
      if (blocker) {
        resourceChecks.push({
          resource: descriptor.key,
          access: 'read',
          status: 'write_held_by_other',
          held_by: blocker.holder,
        });
        return {
          ok: false as const,
          reason: 'resource_write_held_by_other',
          checks,
          resources: resourceChecks,
        };
      }
      resourceChecks.push({
        resource: descriptor.key,
        access: 'read',
        status: 'clear',
      });
    }
  }
  checks.push({ check: 'resources', status: 'ok', resources: resourceChecks });
  checks.push({
    check: 'record',
    status: 'ok',
    state_revision: record.state_revision,
    owner_epoch: currentEpoch,
    attempt_state: attempt.state,
    launch_kind: launchKind,
    mode: discovery ? 'discovery' : 'work',
  });
  return {
    ok: true as const,
    checks,
    state_revision: record.state_revision,
    owner_epoch: currentEpoch,
    attempt_state: attempt.state,
    resources: resourceChecks,
    mode: discovery ? 'discovery' : 'work',
    launch_kind: launchKind,
    resume_selector: selector,
    pre_bound_identity: preBoundIdentity,
    expected_identity: launchKind === 'resume' ? selector : preBoundIdentity,
    capability_evidence: discovery ? 'declared' : 'runtime-bound',
    assignment_digest: liveAssignmentDigest,
    input_revision: liveInputDigest,
  };
}

function samePath(left: string, right: string) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

/** True when an existing claim covers the requested range (claim is equal to or above it). */
export function hasPendingCancellation(
  record: TaskRecord,
  subtaskId: string,
  attempt: number,
) {
  if (
    (record.uncertainty ?? []).some(
      (item) =>
        item.kind === 'cancel_unconfirmed' &&
        !item.resolved_at &&
        item.subtask_id === subtaskId &&
        item.attempt === attempt,
    )
  )
    return true;
  const holder = findAttempt(record, subtaskId, attempt)?.assignee;
  return (record.claims ?? []).some(
    (claim) =>
      !claim.released_at &&
      claim.cancel_pending &&
      holder &&
      claim.holder?.agent_id === holder.agent_id &&
      claim.holder?.session_id === holder.session_id &&
      (claim.subtask_id == null || claim.subtask_id === subtaskId) &&
      (claim.attempt == null || claim.attempt === attempt),
  );
}

export function claimCovers(claim: Resource, requested: Resource) {
  if (claim.key === requested.key) return true;
  if (!claim.path || !requested.path) return false;
  const relation = pathRelation(claim.path, requested.path);
  return relation === 'same' || relation === 'ancestor';
}

function describeRequest(
  resource: Assignment['resources'][number],
): ResourceInput {
  return {
    kind: resource.path ? 'path' : (resource.kind ?? 'path'),
    path: resource.path,
    ...(resource.port === undefined ? {} : { port: resource.port }),
  };
}

function digestFile(file: string) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

/**
 * Atomically reserve the launch. A second launcher cannot reserve the same attempt, and the
 * reservation distinguishes a first launch from a continuation, so "already started" is a
 * recorded fact rather than an assumption.
 */
export function reserveLaunch(
  taskRoot: string,
  {
    reservation,
    expectRevision = undefined,
    clock = Date.now(),
  }: { reservation: ReservationInput; expectRevision?: number; clock?: number },
) {
  const outcome = transact(taskRoot, {
    actor: reservation.holder?.agent_id ?? 'launcher',
    purpose: 'launch-reserve',
    expectRevision,
    clock,
    apply: (record) => {
      const attempt = findAttempt(
        record,
        reservation.subtask_id,
        reservation.attempt,
      );
      if (!attempt)
        return { ok: false as const, reason: 'attempt_not_registered' };
      const active = (record.launch_reservations ?? []).filter(
        (item) =>
          !item.released_at &&
          item.subtask_id === reservation.subtask_id &&
          item.attempt === reservation.attempt,
      );
      if (active.length) {
        return {
          ok: false as const,
          reason: 'launch_already_reserved',
          reservation: active[0],
        };
      }
      record.launch_reservations = record.launch_reservations ?? [];
      const entry = {
        ...reservation,
        reserved_at: nowIso(clock),
        released_at: null,
        outcome: null,
      };
      record.launch_reservations.push(entry);
      return {
        record,
        op: 'launch-reserve',
        summary: {
          subtask_id: reservation.subtask_id,
          attempt: reservation.attempt,
          kind: reservation.kind,
        },
        result: { reservation_id: entry.reservation_id },
      };
    },
  });
  return outcome.ok
    ? {
        ok: true as const,
        reservation_id: outcome.result!.reservation_id,
        state_revision: outcome.state_revision,
      }
    : outcome;
}

/**
 * Settle a launch reservation and persist what actually happened.
 *
 * Outcomes are deliberately distinguished:
 *   exited / exited_nonzero  the process ran; the attempt keeps a recorded native run, so a
 *                            later `first` launch is refused with `already_launched`
 *   timed_out / spawn_failed the process may be alive or may have started; the attempt moves to
 *                            `unknown` with an uncertainty, so nothing may be dispatched over it
 *                            until it is reconciled
 *   not_started              nothing was spawned (a validation failure); the reservation is
 *                            released and the attempt is left exactly as it was
 */
export function classifyIdentity({
  ran,
  observed = null,
  expected = null,
  capabilityEvidence = null,
}: {
  ran: boolean;
  observed?: string | null;
  expected?: string | null;
  capabilityEvidence?: string | null;
}) {
  const status = !ran
    ? 'not_observed'
    : !observed
      ? 'unobserved'
      : !expected
        ? 'discovered'
        : observed === expected
          ? 'match'
          : 'drift';
  const confirmed =
    ran === true &&
    status === 'match' &&
    capabilityEvidence === 'runtime-bound';
  return { status, confirmed };
}

export function settleLaunch(
  taskRoot: string,
  {
    reservationId,
    outcome,
    exitCode = null,
    sessionId = null,
    runId = null,
    evidenceRef = null,
    runner = null,
    detail = null,
    expectedIdentity = null,
    capabilityEvidence = null,
    identityStatus = null,
    // A run is only "confirmed" when the process ended cleanly. `exited_nonzero` still records the
    // attempted/started run and its honest exit, but the observation stays unconfirmed.
    cleanExit = outcome === 'exited',
    clock = Date.now(),
  }: SettleOptions,
) {
  const notStarted = outcome === 'not_started';
  const ran = outcome === 'exited' || outcome === 'exited_nonzero';
  // Identity is decided before "did it run": a resumed session that comes back with a different
  // id is a drift, and an identity that was never bound to the capability evidence cannot be
  // promoted to `confirmed` no matter how cleanly the process exited.
  const classified = classifyIdentity({
    ran,
    observed: sessionId,
    expected: expectedIdentity,
    capabilityEvidence,
  });
  const identityStatusResolved = identityStatus ?? classified.status;
  const confirmed =
    ran &&
    cleanExit === true &&
    identityStatusResolved === 'match' &&
    capabilityEvidence === 'runtime-bound';
  const uncertain =
    outcome === 'timed_out' ||
    outcome === 'spawn_failed' ||
    outcome === 'evidence_write_failed' ||
    identityStatusResolved === 'drift' ||
    identityStatusResolved === 'unobserved' ||
    (ran && !confirmed);
  const settled = transact<Record<string, unknown>>(taskRoot, {
    actor: 'launcher',
    purpose: 'launch-settle',
    clock,
    apply: (record) => {
      const entry = (record.launch_reservations ?? []).find(
        (item) => item.reservation_id === reservationId,
      );
      if (!entry) return { ok: false as const, reason: 'unknown_reservation' };
      if (entry.released_at)
        return { ok: false as const, reason: 'reservation_already_settled' };
      entry.released_at = nowIso(clock);
      entry.outcome = outcome;
      entry.exit_code = exitCode;
      entry.session_id = sessionId;
      entry.run_id = runId;
      entry.detail = detail ?? null;
      entry.identity_status = identityStatusResolved;
      entry.expected_identity = expectedIdentity;
      entry.observed_identity = sessionId;

      if (notStarted)
        return {
          record,
          op: 'launch-settle',
          summary: { reservation_id: reservationId, outcome },
          result: { outcome, attempt_unchanged: true },
        };

      const attempt = findAttempt(record, entry.subtask_id, entry.attempt);
      if (!attempt)
        return {
          record,
          op: 'launch-settle',
          summary: { reservation_id: reservationId, outcome },
          result: { outcome, attempt_missing: true },
        };
      const at = nowIso(clock);
      // The native runner owns execution; the shared layer keeps the pointer and the fact
      // that this attempt has been started at all.
      attempt.native = {
        runner: runner ?? attempt.native?.runner ?? null,
        session_id: sessionId ?? attempt.native?.session_id ?? null,
        run_id: runId ?? attempt.native?.run_id ?? null,
        mission_id: attempt.native?.mission_id ?? null,
        observation: confirmed ? 'confirmed' : 'unknown',
        observed_at: at,
        evidence_ref: evidenceRef ?? attempt.native?.evidence_ref ?? null,
        manager: 'native',
        launch_kind: entry.kind,
        mode: entry.mode,
        identity_status: identityStatusResolved,
      };
      attempt.updated_at = at;
      attempt.transitions = attempt.transitions ?? [];
      attempt.transitions.push({
        from: attempt.state,
        to: attempt.state,
        at,
        actor: 'launcher',
        reason: `native launch settled: ${outcome}`,
        evidence: evidenceRef,
      });
      if (ran && ['assigned', 'accepted'].includes(attempt.state))
        attempt.state = 'running';
      if (ran) {
        // The process demonstrably started, so that question is answered even when the identity
        // or the capability evidence is still unresolved.
        const started = (record.uncertainty ?? []).find(
          (item) =>
            !item.resolved_at &&
            item.kind === 'registered_not_started' &&
            item.subtask_id === entry.subtask_id &&
            item.attempt === entry.attempt,
        );
        if (started) {
          started.resolved_at = at;
          started.resolution = 'native launch observed';
          started.resolution_evidence = evidenceRef;
          started.resolved_by = 'launcher';
        }
      }
      if (uncertain) {
        // "May have started", "the identity drifted" and "it ran but nothing was recorded" are
        // all reconcile-first states, never a free attempt.
        if (!['completed', 'failed', 'cancelled'].includes(attempt.state))
          attempt.state = 'unknown';
        const kind =
          identityStatusResolved === 'drift'
            ? 'session_identity_drift'
            : identityStatusResolved === 'unobserved'
              ? 'session_unobserved'
              : ran && !confirmed
                ? 'session_unverified'
                : outcome === 'timed_out'
                  ? 'executed_unwritten'
                  : outcome === 'evidence_write_failed'
                    ? 'executed_unwritten'
                    : 'started_unregistered';
        const detailText =
          identityStatusResolved === 'unobserved'
            ? `launch ${entry.reservation_id} produced no readable native session identity; the requested identity ${entry.requested_session_id} is not evidence`
            : identityStatusResolved === 'drift'
              ? `launch ${entry.reservation_id} came back as ${sessionId}, but ${expectedIdentity} was expected: the contract does not describe this instance`
              : ran && !confirmed
                ? `launch ${entry.reservation_id} ran as native session ${sessionId}, but no runtime capability evidence covers that identity yet`
                : outcome === 'evidence_write_failed'
                  ? `launch ${entry.reservation_id} ran but its evidence could not be written (${detail}); the execution is not on record`
                  : `launch ${entry.reservation_id} ended as ${outcome}; the native process state is unconfirmed`;
        openUncertainty(record, {
          kind,
          subtaskId: entry.subtask_id,
          attempt: entry.attempt,
          detail: detailText,
          evidenceRef,
          resolutionHint:
            identityStatusResolved === 'unobserved'
              ? 'inspect the native evidence: the session file or stream must expose the identity before it can be trusted'
              : identityStatusResolved === 'drift'
                ? 'query the native runner, then register a contract that names the instance that actually ran'
                : ran && !confirmed
                  ? 'derive a capability card for this native session, then continue it with --launch-kind resume'
                  : 'query the native runner for this session/run and reconcile before any new dispatch',
          clock,
        });
      }
      return {
        record,
        op: 'launch-settle',
        summary: { reservation_id: reservationId, outcome },
        result: {
          outcome,
          state: attempt.state,
          observation: attempt.native.observation,
          identity_status: identityStatusResolved,
        },
      };
    },
  });
  return settled.ok
    ? { ok: true as const, outcome, result: settled.result }
    : settled;
}
