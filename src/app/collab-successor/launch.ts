import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from '../../infra/bounded-file.js';
import { getPackageRoot } from '../../package-info.js';
import { findHandoff } from '../../collab/handoff.js';
import { readRecord } from '../../collab/store.js';
import { safePathEqual } from '../collab-session-transition-validation.js';
import {
  applyHandoffRequest,
  readCoordinatorHandoffCheck,
} from '../collab-handoff.js';
import { openTaskStore } from '../collab-task-store.js';
import {
  assertRealChain,
  writeJsonExclusive,
} from '../collab-workflow/context.js';
import { COLLAB_HANDOFF_REQUEST_SCHEMA } from '../../schemas/collaboration.js';
import {
  createHerdrOps,
  type HerdrResult,
  type SuccessorHerdrOps,
} from './herdr.js';
import { readSuccessorIntent, readSuccessorOutcome } from './journal.js';
import {
  SUCCESSOR_INTENT_SCHEMA,
  SUCCESSOR_OUTCOME_SCHEMA,
  ackCommand,
  buildSeed,
  claudeSessionIdFor,
  sha256,
  successorFile,
  successorRequestSchema,
  type SuccessorIdentity,
  type SuccessorOutcome,
  type SuccessorRequest,
} from './types.js';

export const SUCCESSOR_RESULT_SCHEMA = 'pappra/collab-successor-result/1';
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 24 * 1024;

export type CodexDiscovery =
  | { state: 'found'; threadId: string; createdAt: number }
  | { state: 'not_found'; examined?: number }
  | { state: 'ambiguous'; threadIds: string[] }
  | { state: 'unavailable'; reason: string; detail: string | null };

export interface SuccessorLaunchDependencies {
  readonly herdr?: SuccessorHerdrOps;
  /** Finds the thread a seeded Codex session created; see `hosts/codex/thread-discovery`. */
  readonly discoverCodex?: (criteria: {
    cwd: string;
    preview: string;
    createdAfter: number;
  }) => Promise<CodexDiscovery>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly cliPath?: string;
  readonly readyTimeoutMs?: number;
  readonly deliveryTimeoutMs?: number;
  /** How often to retry `agent start` while the new pane's shell is not yet available. */
  readonly startRetries?: number;
  readonly identityTimeoutMs?: number;
  readonly identityPollMs?: number;
}

export interface SuccessorFinding {
  readonly code: string;
  readonly detail: string;
}

export interface SuccessorLaunchResult {
  readonly schema: typeof SUCCESSOR_RESULT_SCHEMA;
  readonly action: 'plan' | 'apply';
  readonly ok: boolean;
  readonly status:
    | 'planned'
    | 'launched'
    | 'identity_unavailable'
    | 'blocked'
    | 'invalid'
    | 'reconcile_required'
    | 'already_recorded'
    | 'failed';
  readonly request_id: string | null;
  readonly task_id: string | null;
  readonly blockers: readonly SuccessorFinding[];
  readonly warnings: readonly string[];
  readonly seed_digest: string | null;
  readonly seed: string | null;
  readonly pane_id: string | null;
  readonly identity: SuccessorIdentity | null;
  readonly evidence: SuccessorOutcome['evidence'];
  readonly handoff: { rebound: boolean; transferred: boolean } | null;
  readonly steps: readonly { step: string; state: string }[];
  readonly next_steps: readonly string[];
  readonly limits: readonly string[];
}

const LIMITS = [
  'visible_sibling_pane_only',
  'no_existing_pane_typed_into',
  'no_approval_answered',
  'identity_from_observed_evidence_not_authentication',
  'old_session_not_stopped_or_observed',
];

function result(
  partial: Partial<SuccessorLaunchResult> &
    Pick<SuccessorLaunchResult, 'action' | 'status'>,
): SuccessorLaunchResult {
  return {
    schema: SUCCESSOR_RESULT_SCHEMA,
    ok:
      partial.status === 'planned' ||
      partial.status === 'launched' ||
      partial.status === 'already_recorded',
    request_id: null,
    task_id: null,
    blockers: [],
    warnings: [],
    seed_digest: null,
    seed: null,
    pane_id: null,
    identity: null,
    evidence: null,
    handoff: null,
    steps: [],
    next_steps: [],
    limits: LIMITS,
    ...partial,
  };
}

function loadRequest(
  file: string,
):
  | { ok: true; request: SuccessorRequest; digest: string }
  | { ok: false; detail: string } {
  if (!path.isAbsolute(file))
    return { ok: false, detail: '--request must be an absolute path.' };
  const read = readBoundedFile(file, MAX_REQUEST_BYTES);
  if (!read.ok)
    return {
      ok: false,
      detail: `request file is not readable (${read.code}).`,
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { ok: false, detail: 'request file is not valid JSON.' };
  }
  const checked = successorRequestSchema.safeParse(parsed);
  if (!checked.success)
    return {
      ok: false,
      detail: `${checked.error.issues[0]?.path.join('.') ?? 'request'}: ${checked.error.issues[0]?.message ?? 'invalid'}`,
    };
  return {
    ok: true,
    request: checked.data,
    digest: sha256(JSON.stringify(checked.data)),
  };
}

/** Replaces a step file in place, atomically, after the real-chain check. */
function writeStepDone(taskRoot: string, file: string, value: unknown): void {
  if (assertRealChain(taskRoot, file) !== null)
    throw new Error('step path is not a real chain');
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temp, file);
}

const unixSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * Bind the observed identity into the handoff with the existing primitives. It is idempotent:
 * a step that is already recorded is not repeated, so it can also finish a bind that a crash
 * interrupted after the session and its outcome were recorded.
 */
async function bindHandoff(
  taskRoot: string,
  request: SuccessorRequest,
  identity: SuccessorIdentity,
): Promise<{
  readonly rebound: boolean;
  readonly transferred: boolean;
  readonly blockers: SuccessorFinding[];
}> {
  const blockers: SuccessorFinding[] = [];
  const record = readRecord(taskRoot);
  const entry =
    record === null ? null : findHandoff(record, request.handoff_id);
  const coordinator = record?.coordinator ?? null;
  if (entry === null || coordinator === null)
    return {
      rebound: false,
      transferred: false,
      blockers: [
        {
          code: 'handoff_not_found',
          detail: 'The handoff or its coordinator is no longer recorded.',
        },
      ],
    };
  let rebound =
    entry.to?.agent_id === identity.agent_id &&
    entry.to?.session_id === identity.session_id;
  let transferred = [
    'transferring',
    'receiver_confirmed',
    'completed',
  ].includes(entry.state);
  const common = {
    actor: coordinator.agent_id,
    owner_epoch: coordinator.owner_epoch,
  };
  if (!rebound) {
    const rebind = await applyHandoffRequest(taskRoot, {
      schema: COLLAB_HANDOFF_REQUEST_SCHEMA,
      action: 'rebind',
      handoff_id: request.handoff_id,
      to: {
        agent_id: identity.agent_id,
        session_id: identity.session_id,
        harness: identity.harness,
      },
      evidence_ref: `successor-outcome:${successorFile.outcome(taskRoot, request.request_id)}`,
      ...common,
    });
    rebound = rebind.ok && rebind.value['ok'] === true;
    if (!rebound)
      blockers.push({
        code: 'rebind_failed',
        detail: rebind.ok
          ? JSON.stringify(rebind.value['reason'] ?? 'refused')
          : rebind.message,
      });
  }
  if (rebound && !transferred) {
    const transfer = await applyHandoffRequest(taskRoot, {
      schema: COLLAB_HANDOFF_REQUEST_SCHEMA,
      action: 'transfer',
      handoff_id: request.handoff_id,
      partial_outputs: [],
      inflight: [],
      pending_approvals: [],
      ...common,
    });
    transferred = transfer.ok && transfer.value['ok'] === true;
    if (!transferred)
      blockers.push({
        code: 'transfer_failed',
        detail: transfer.ok
          ? JSON.stringify(transfer.value['reason'] ?? 'refused')
          : transfer.message,
      });
  }
  return { rebound, transferred, blockers };
}

const nextStepsFor = (request: SuccessorRequest): string[] => [
  `The successor runs its one command; wait for it to reply HANDOFF-ACKED ${request.handoff_id}.`,
  `Then run: collab handoff confirm (confirmation_message_id handoff-ack-${request.request_id}).`,
  'Then collab handoff complete; the successor then runs collab handoff release-dispatch.',
];

/**
 * Plan or apply one successor launch.
 *
 * Plan is read-only. Apply journals each native effect before it happens, never repeats a step
 * whose outcome is unknown, never types into an existing pane and never answers an approval.
 */
export async function runSuccessorLaunch(
  requestFile: string,
  options: { readonly apply: boolean },
  dependencies: SuccessorLaunchDependencies = {},
): Promise<SuccessorLaunchResult> {
  const action = options.apply ? 'apply' : 'plan';
  const loaded = loadRequest(requestFile);
  if (!loaded.ok)
    return result({
      action,
      status: 'invalid',
      blockers: [{ code: 'request_invalid', detail: loaded.detail }],
    });
  const request = loaded.request;
  const herdr = dependencies.herdr ?? createHerdrOps();
  const now = dependencies.now ?? (() => new Date());
  const sleep =
    dependencies.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = { action, request_id: request.request_id } as const;

  const opened = await openTaskStore(request.task_root);
  if (!opened.ok)
    return result({
      ...base,
      status: 'invalid',
      blockers: [{ code: opened.code, detail: opened.message }],
    });
  const taskRoot = opened.value.taskRoot;
  const record = opened.value.record;
  const taskId = record.task_id;

  // A recorded outcome is the answer; nothing is repeated.
  const recorded = readSuccessorOutcome(taskRoot, request.request_id);
  if (recorded.ok) {
    if (recorded.value.request_digest !== loaded.digest)
      return result({
        ...base,
        task_id: taskId,
        status: 'blocked',
        blockers: [
          {
            code: 'request_conflict',
            detail: 'This request_id was used with different request content.',
          },
        ],
      });
    if (recorded.value.status === 'identity_unavailable')
      // A failed launch is not a success just because it is recorded: the live agent is still
      // there and must be closed by the user before a new request id can reuse its name.
      return result({
        ...base,
        task_id: taskId,
        status: 'identity_unavailable',
        pane_id: recorded.value.pane_id,
        warnings: [
          recorded.value.detail ?? 'identity was not established',
          `The agent ${recorded.value.agent_name} may still be running in ${recorded.value.pane_id}. Pappra does not stop it: close that pane, then use a new request_id.`,
        ],
      });
    const recordedIdentity = recorded.value.identity;
    const bind =
      recordedIdentity === null
        ? null
        : await bindHandoff(taskRoot, request, recordedIdentity);
    return result({
      ...base,
      task_id: taskId,
      status: 'already_recorded',
      pane_id: recorded.value.pane_id,
      identity: recordedIdentity,
      evidence: recorded.value.evidence,
      handoff:
        bind === null
          ? null
          : { rebound: bind.rebound, transferred: bind.transferred },
      blockers: bind?.blockers ?? [],
      ok: bind !== null && bind.blockers.length === 0,
      next_steps:
        bind !== null && bind.blockers.length === 0
          ? nextStepsFor(request)
          : [],
    });
  }
  const stepStates = (['split', 'start', 'prompt'] as const)
    .map((step) => {
      const file = successorFile.step(taskRoot, request.request_id, step);
      if (!fs.existsSync(file)) return null;
      const read = readBoundedFile(file, 16 * 1024);
      let state = 'unreadable';
      if (read.ok) {
        try {
          state = String(
            (JSON.parse(read.text) as { state?: unknown }).state ?? 'unknown',
          );
        } catch {
          state = 'invalid';
        }
      }
      return { step, state };
    })
    .filter(
      (item): item is { step: 'split' | 'start' | 'prompt'; state: string } =>
        item !== null,
    );
  if (stepStates.length > 0)
    return result({
      ...base,
      task_id: taskId,
      status: 'reconcile_required',
      steps: stepStates,
      blockers: [
        {
          code: 'launch_in_progress_or_unknown',
          detail:
            'An earlier run recorded a step but no outcome. Inspect the pane and the successor journal; nothing is repeated. Use a new request_id for a fresh launch.',
        },
      ],
    });

  const blockers: SuccessorFinding[] = [];
  const warnings: string[] = [];
  const coordinator = record.coordinator ?? null;
  if (coordinator === null)
    blockers.push({
      code: 'no_coordinator',
      detail: 'The task has no coordinator.',
    });
  else if (coordinator.harness !== request.harness)
    blockers.push({
      code: 'harness_mismatch',
      detail: `The coordinator runs ${String(coordinator.harness)}; a successor must use the same harness (${request.harness}).`,
    });

  const handoff = findHandoff(record, request.handoff_id);
  if (handoff === null)
    blockers.push({
      code: 'handoff_not_found',
      detail: `Handoff ${request.handoff_id} does not exist; run collab handoff begin first.`,
    });
  else {
    if (handoff.kind !== 'coordinator')
      blockers.push({
        code: 'handoff_not_coordinator',
        detail: 'Only a coordinator handoff can be launched.',
      });
    if (handoff.state !== 'requested')
      blockers.push({
        code: 'handoff_not_requested',
        detail: `The handoff is ${handoff.state}; a launch starts from requested.`,
      });
    if (
      coordinator !== null &&
      (handoff.from?.agent_id !== coordinator.agent_id ||
        handoff.from?.session_id !== coordinator.session_id)
    )
      blockers.push({
        code: 'handoff_not_from_coordinator',
        detail: 'The handoff is not from the current coordinator.',
      });
    if (handoff.to?.agent_id !== request.agent_name)
      blockers.push({
        code: 'receiver_name_mismatch',
        detail: `The handoff receiver is ${String(handoff.to?.agent_id)}, not ${request.agent_name}.`,
      });
  }

  const check = await readCoordinatorHandoffCheck(taskRoot, {
    ignoreHandoffId: request.handoff_id,
    mode: request.mode ?? 'boundary',
  });
  if (!check.ok) blockers.push({ code: check.code, detail: check.message });
  else if (check.value['ok'] !== true)
    for (const item of check.value['blockers'] as {
      code: string;
      detail: string;
    }[])
      blockers.push({ code: `check_${item.code}`, detail: item.detail });

  const checkpoint = readBoundedFile(
    request.checkpoint.file,
    MAX_CHECKPOINT_BYTES,
  );
  if (!checkpoint.ok)
    blockers.push({
      code: 'checkpoint_unavailable',
      detail: `The checkpoint file cannot be read (${checkpoint.code}).`,
    });
  else if (checkpoint.digest !== request.checkpoint.digest)
    blockers.push({
      code: 'checkpoint_digest_mismatch',
      detail: 'The checkpoint does not match its pinned digest.',
    });

  const pane = await herdr.paneGet(request.caller_pane);
  if (!pane.ok)
    blockers.push({ code: 'caller_pane_unverified', detail: pane.detail });
  else {
    if (pane.value.cwd === null || !safePathEqual(pane.value.cwd, request.cwd))
      blockers.push({
        code: 'cwd_mismatch',
        detail: `The coordinator pane is in ${String(pane.value.cwd)}, not ${request.cwd}.`,
      });
    if (
      coordinator !== null &&
      pane.value.sessionValue !== null &&
      pane.value.sessionValue !== coordinator.session_id
    )
      blockers.push({
        code: 'caller_pane_not_coordinator',
        detail:
          'Herdr reports a different session in that pane than the recorded coordinator.',
      });
    if (pane.value.sessionValue === null)
      warnings.push(
        'Herdr reports no session for the coordinator pane; it could not be matched to the recorded coordinator.',
      );
  }
  const taken = await herdr.agentExists(request.agent_name);
  if (!taken.ok)
    blockers.push({ code: 'agent_lookup_failed', detail: taken.detail });
  else if (taken.value)
    blockers.push({
      code: 'agent_name_in_use',
      detail: `A live Herdr agent is already named ${request.agent_name}.`,
    });

  const cliPath =
    dependencies.cliPath ??
    path.join(getPackageRoot(), 'dist', 'cli', 'main.js');
  if (!fs.existsSync(cliPath))
    blockers.push({
      code: 'cli_not_built',
      detail: `${cliPath} does not exist; build the project so the successor's command can run.`,
    });
  const claudeSession =
    request.harness === 'claude'
      ? claudeSessionIdFor({
          taskId,
          handoffId: request.handoff_id,
          requestId: request.request_id,
        })
      : null;
  const seed = buildSeed({
    taskId,
    handoffId: request.handoff_id,
    command: ackCommand({ cliPath, taskRoot, requestId: request.request_id }),
  });
  const seedDigest = sha256(seed);
  const plannedSteps = [
    { step: 'split', state: 'planned' },
    { step: 'start', state: 'planned' },
    { step: 'prompt', state: 'planned' },
    { step: 'identity', state: 'planned' },
    { step: 'rebind+transfer', state: 'planned' },
  ];
  const common = {
    ...base,
    task_id: taskId,
    seed,
    seed_digest: seedDigest,
    warnings,
    steps: plannedSteps,
  };
  if (blockers.length > 0)
    return result({ ...common, status: 'blocked', blockers });
  if (!options.apply)
    return result({ ...common, status: 'planned', identity: null });

  // ---- apply: journal first, then each effect ----
  const writeDoc = (file: string, value: unknown) =>
    writeJsonExclusive(taskRoot, file, value);
  const requestWrite = writeDoc(
    successorFile.request(taskRoot, request.request_id),
    request,
  );
  if (requestWrite.status === 'unsafe' || requestWrite.status === 'conflict')
    return result({
      ...common,
      status: 'blocked',
      blockers: [
        {
          code: 'journal_unsafe',
          detail: 'The successor journal could not be written safely.',
        },
      ],
    });
  const intentDoc = {
    schema: SUCCESSOR_INTENT_SCHEMA,
    request_id: request.request_id,
    request_digest: loaded.digest,
    recorded_at: now().toISOString(),
    harness: request.harness,
    agent_name: request.agent_name,
    cwd: request.cwd,
    handoff_id: request.handoff_id,
    claude_session_id: claudeSession,
    seed,
    seed_digest: seedDigest,
    checkpoint: request.checkpoint,
  };
  const intentWrite = writeDoc(
    successorFile.intent(taskRoot, request.request_id),
    intentDoc,
  );
  if (intentWrite.status === 'unsafe')
    return result({
      ...common,
      status: 'blocked',
      blockers: [
        {
          code: 'journal_unsafe',
          detail: 'The successor intent could not be written safely.',
        },
      ],
    });
  if (intentWrite.status === 'conflict') {
    // The timestamp makes a leftover intent differ byte for byte. If everything else is the
    // same and no step exists (checked above), no native effect happened and the launch can go on.
    const existing = readSuccessorIntent(taskRoot, request.request_id);
    const strip = (value: unknown) => {
      const { recorded_at: _ignored, ...rest } = value as Record<
        string,
        unknown
      >;
      return JSON.stringify(rest);
    };
    if (!existing.ok || strip(existing.value) !== strip(intentDoc))
      return result({
        ...common,
        status: 'blocked',
        blockers: [
          {
            code: 'request_conflict',
            detail:
              'An earlier intent for this request_id differs from this request.',
          },
        ],
      });
    warnings.push(
      'An intent from an interrupted earlier run was found with no native step; it matches this request and the launch continues.',
    );
  }
  const intent = readSuccessorIntent(taskRoot, request.request_id);
  if (!intent.ok)
    return result({
      ...common,
      status: 'blocked',
      blockers: [{ code: 'journal_unsafe', detail: intent.detail }],
    });

  const launchedAt = now();
  const steps: { step: string; state: string }[] = [];
  const stepFile = (step: 'split' | 'start' | 'prompt') =>
    successorFile.step(taskRoot, request.request_id, step);
  const begin = (step: 'split' | 'start' | 'prompt') => {
    const write = writeDoc(stepFile(step), {
      step,
      state: 'intent',
      at: now().toISOString(),
    });
    return write.status === 'created';
  };
  const finish = (
    step: 'split' | 'start' | 'prompt',
    state: 'done' | 'failed',
    detail: Record<string, unknown>,
  ) => {
    writeStepDone(taskRoot, stepFile(step), {
      step,
      state,
      at: now().toISOString(),
      ...detail,
    });
    steps.push({ step, state });
  };
  const failed = <T>(
    step: 'split' | 'start' | 'prompt',
    outcome: Extract<HerdrResult<T>, { ok: false }>,
  ) => {
    finish(step, 'failed', {
      code: outcome.code,
      detail: outcome.detail,
      unknown: outcome.unknown,
    });
    return result({
      ...common,
      steps,
      status: outcome.unknown ? 'reconcile_required' : 'failed',
      blockers: [
        {
          code: `${step}_${outcome.unknown ? 'unknown' : 'failed'}`,
          detail: outcome.detail,
        },
      ],
    });
  };

  if (!begin('split'))
    return result({
      ...common,
      status: 'reconcile_required',
      blockers: [
        { code: 'journal_unsafe', detail: 'A step file already exists.' },
      ],
    });
  const split = await herdr.splitPane({
    paneId: request.caller_pane,
    cwd: request.cwd,
    direction: request.direction,
  });
  if (!split.ok) return failed('split', split);
  finish('split', 'done', { pane_id: split.value.paneId });
  const paneId = split.value.paneId;

  if (!begin('start'))
    return result({
      ...common,
      steps,
      status: 'reconcile_required',
      pane_id: paneId,
      blockers: [
        {
          code: 'journal_unsafe',
          detail:
            'The start step could not be journalled; nothing was started.',
        },
      ],
    });
  const startInput = {
    name: request.agent_name,
    kind: request.harness,
    paneId,
    args: claudeSession === null ? [] : ['--session-id', claudeSession],
  } as const;
  let started = await herdr.startAgent(startInput);
  // A pane that was just split has no available shell for a moment. Herdr refuses that
  // definitively (nothing was started), so retrying the same start is safe and bounded; any
  // other failure, and any unknown outcome, is never retried.
  for (
    let attempt = 0;
    !started.ok &&
    !started.unknown &&
    started.code === 'agent_pane_busy' &&
    attempt < (dependencies.startRetries ?? 40);
    attempt += 1
  ) {
    await sleep(dependencies.identityPollMs ?? 500);
    started = await herdr.startAgent(startInput);
  }
  if (!started.ok) return failed('start', started);
  finish('start', 'done', { agent: started.value.name });

  const identityUnavailable = (detail: string): SuccessorLaunchResult => {
    const outcome: SuccessorOutcome = {
      schema: SUCCESSOR_OUTCOME_SCHEMA,
      request_id: request.request_id,
      request_digest: loaded.digest,
      recorded_at: now().toISOString(),
      status: 'identity_unavailable',
      pane_id: paneId,
      agent_name: request.agent_name,
      identity: null,
      evidence: null,
      detail: detail.slice(0, 400),
    };
    writeDoc(successorFile.outcome(taskRoot, request.request_id), outcome);
    return result({
      ...common,
      steps,
      status: 'identity_unavailable',
      pane_id: paneId,
      warnings: [...warnings, detail],
    });
  };

  // Wait until the session accepts input. A trust or approval dialog is reported, never
  // answered. For Claude the pre-assigned session id must also have appeared and match, so a
  // wrong session is detected BEFORE any seed is typed into it.
  const readyDeadline = Date.now() + (dependencies.readyTimeoutMs ?? 60_000);
  const poll = dependencies.identityPollMs ?? 500;
  let ready: Awaited<ReturnType<typeof herdr.getAgent>> | null = null;
  for (;;) {
    // The pane is the one we split; an agent name is free again once its agent exits.
    const agent = await herdr.getAgent(paneId);
    if (agent.ok) {
      ready = agent;
      if (agent.value.name !== request.agent_name)
        return identityUnavailable(
          `The agent in ${paneId} is named ${agent.value.name}, not ${request.agent_name}; no seed was typed.`,
        );
      if (agent.value.status === 'blocked')
        return identityUnavailable(
          'The successor is waiting at an approval or trust dialog in its pane; Pappra does not answer it. Resolve it in the pane, then use a new request_id.',
        );
      const settled = ['idle', 'done'].includes(agent.value.status);
      const sessionKnown =
        claudeSession === null || agent.value.sessionValue !== null;
      if (agent.value.interactiveReady === true && settled && sessionKnown)
        break;
    }
    if (Date.now() >= readyDeadline)
      return identityUnavailable(
        ready === null || !ready.ok
          ? 'The successor could not be observed.'
          : `The successor did not become ready for input (status ${ready.value.status}, interactive_ready ${String(ready.value.interactiveReady)}).`,
      );
    await sleep(poll);
  }
  if (
    claudeSession !== null &&
    ready.ok &&
    ready.value.sessionValue !== claudeSession
  )
    return identityUnavailable(
      `Herdr reports session ${String(ready.value.sessionValue)}, not the pre-assigned ${claudeSession}; no seed was typed.`,
    );

  if (!begin('prompt'))
    return identityUnavailable(
      'The prompt step could not be journalled; no seed was typed.',
    );
  const before = ready.ok ? ready.value.stateChangeSeq : null;
  const prompted = await herdr.promptAgent(paneId, seed);
  if (!prompted.ok) return failed('prompt', prompted);
  finish('prompt', 'done', {});
  // Confirm the turn actually started. An unconfirmed delivery is reported and never repeated.
  const deliveryDeadline =
    Date.now() + (dependencies.deliveryTimeoutMs ?? 20_000);
  let delivered = false;
  for (;;) {
    const agent = await herdr.getAgent(paneId);
    if (
      agent.ok &&
      (agent.value.status === 'working' ||
        (before !== null &&
          agent.value.stateChangeSeq !== null &&
          agent.value.stateChangeSeq !== before))
    ) {
      delivered = true;
      break;
    }
    if (Date.now() >= deliveryDeadline) break;
    await sleep(poll);
  }
  if (!delivered)
    warnings.push(
      'The seed was typed but the session did not start a turn within the wait; it may be sitting unsubmitted in its input box. It was not sent again.',
    );

  // ---- identity from observed evidence ----
  let identity: SuccessorIdentity | null = null;
  let evidence: SuccessorOutcome['evidence'] = null;
  let detail: string | null = null;
  if (request.harness === 'claude') {
    const agent = await herdr.getAgent(paneId);
    if (agent.ok && agent.value.sessionValue === claudeSession) {
      identity = {
        agent_id: request.agent_name,
        session_id: claudeSession!,
        harness: 'claude',
        cwd: request.cwd,
      };
      evidence = {
        kind: 'herdr-agent-session',
        detail: `Herdr reports session ${claudeSession} for ${request.agent_name} in ${paneId}`,
      };
    } else
      detail = agent.ok
        ? `Herdr reports session ${String(agent.value.sessionValue)}, not the pre-assigned ${String(claudeSession)}.`
        : agent.detail;
  } else if (dependencies.discoverCodex === undefined)
    detail = 'No Codex thread discovery is available in this build.';
  else {
    const deadline = Date.now() + (dependencies.identityTimeoutMs ?? 20_000);
    const poll = dependencies.identityPollMs ?? 1000;
    for (;;) {
      const found = await dependencies.discoverCodex({
        cwd: request.cwd,
        preview: seed,
        // Codex stamps whole seconds, so the launch second itself is the earliest a thread of
        // ours can carry; no tolerance is needed.
        createdAfter: unixSeconds(launchedAt),
      });
      if (found.state === 'found') {
        identity = {
          agent_id: request.agent_name,
          session_id: found.threadId,
          harness: 'codex',
          cwd: request.cwd,
        };
        evidence = {
          kind: 'codex-daemon-thread',
          detail: `Codex daemon thread ${found.threadId} (created ${String(found.createdAt)}) has this cwd and exactly the seed as its preview`,
        };
        break;
      }
      if (found.state === 'ambiguous') {
        detail = `More than one Codex thread matches the seed (${found.threadIds.join(', ')}); not guessing.`;
        break;
      }
      if (found.state === 'unavailable')
        detail = `Codex daemon lookup failed: ${found.reason}.`;
      else detail = 'No Codex thread with this seed was found.';
      if (Date.now() >= deadline) break;
      await sleep(poll);
    }
  }
  if (identity === null)
    return identityUnavailable(detail ?? 'Identity could not be established.');

  const outcome: SuccessorOutcome = {
    schema: SUCCESSOR_OUTCOME_SCHEMA,
    request_id: request.request_id,
    request_digest: loaded.digest,
    recorded_at: now().toISOString(),
    status: 'launched',
    pane_id: paneId,
    agent_name: request.agent_name,
    identity,
    evidence,
    detail: null,
  };
  const outcomeWrite = writeDoc(
    successorFile.outcome(taskRoot, request.request_id),
    outcome,
  );
  if (outcomeWrite.status === 'unsafe' || outcomeWrite.status === 'conflict')
    return result({
      ...common,
      steps,
      status: 'reconcile_required',
      pane_id: paneId,
      identity,
      evidence,
      blockers: [
        {
          code: 'outcome_not_recorded',
          detail:
            'The session is up but its outcome could not be written; record it before continuing.',
        },
      ],
    });

  // ---- bind the observed identity into the handoff using the existing primitives ----
  const bound = await bindHandoff(taskRoot, request, identity);
  const { rebound, transferred } = bound;
  const bindBlockers = bound.blockers;
  return result({
    ...common,
    steps: [
      ...steps,
      { step: 'identity', state: 'done' },
      {
        step: 'rebind+transfer',
        state: rebound && transferred ? 'done' : 'failed',
      },
    ],
    status: 'launched',
    pane_id: paneId,
    identity,
    evidence,
    handoff: { rebound, transferred },
    blockers: bindBlockers,
    ok: bindBlockers.length === 0,
    next_steps: nextStepsFor(request),
  });
}
